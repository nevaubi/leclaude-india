import "server-only";
import { z } from "zod";
import { SUPREME_COURT } from "@/lib/india/courts";
import { isNotFound } from "@/modules/india/sources/http";
import { ingestJudgment, type JudgmentFile } from "@/modules/india/sources/ingest";
import { decodeCursor, encodeCursor, walkPrefixes, yearsFor, type ItemOutcome } from "@/modules/india/sources/open-data";
import { indiaProvidersFor } from "@/modules/india/sources/providers";
import { parseSciMetadata, sciMetadataPrefix, type SciMetadataJson } from "@/modules/india/sources/sci";
import { findJudgment, putOriginalFile } from "@/modules/india/sources/store";
import { isProviderError, ProviderError } from "../providers/base";
import { defineAdapter } from "./types";

const schema = z.object({
  /** Explicit years (overrides lastYears). */
  years: z.array(z.number().int().min(1950).max(2100)).default([]),
  /** Most recent N years, newest first. */
  lastYears: z.number().int().min(1).max(80).default(2),
  fromYear: z.number().int().min(1950).max(2100).optional(),
  fetchPdf: z.boolean().default(true),
  /** Also store court-published translations (PDF + text) for these language codes (e.g. ["kn","te","hi"]). */
  translationLanguages: z.array(z.string().min(2).max(3)).default([]),
  maxPdfMb: z.number().min(1).max(100).default(25),
  concurrency: z.number().int().min(1).max(8).default(4),
  maxPerPrefix: z.number().int().min(1).max(5000).default(200),
  maxListPages: z.number().int().min(1).max(500).default(40),
  /** Ignore the checkpoint (full re-scan; unchanged records are still skipped by ETag). */
  restart: z.boolean().default(false),
});

export type SciOpenDataConfig = z.infer<typeof schema>;

/**
 * Supreme Court of India judgments from the AWS Open Data bucket `indian-supreme-court-judgments`: metadata JSON per
 * judgment, the English PDF (text of record) and court-published regional translations. Incremental by year folder
 * with a per-prefix checkpoint in the source cursor.
 */
export const sciOpenDataAdapter = defineAdapter<SciOpenDataConfig>({
  id: "sci-open-data",
  name: "Supreme Court of India (open judgments)",
  description: "Supreme Court judgments from the AWS Open Data set: metadata, English PDF text, neutral and SCR citations, coram and court-published translations.",
  kinds: ["opinion"],
  family: "sci-open-data",
  requires: ["sci-open-data"],
  configSchema: schema,
  defaults: schema.parse({}),
  async run(ctx) {
    const cfg = ctx.config;
    const { sci } = indiaProvidersFor(ctx);
    if (sci.http.offline) { ctx.fail(new ProviderError("sci-open-data", "not_configured", "sci-open-data: offline (INTEL_OFFLINE is set); nothing was fetched", false), { provider: "sci-open-data", label: "sci-open-data" }); return; }
    const years = yearsFor(cfg, ctx.now);
    const cursor = decodeCursor(ctx.cursor);
    const wanted = new Set(cfg.translationLanguages.map((l) => l.toLowerCase()));
    const handle = async (obj: { key: string; etag: string; lastModified: string }): Promise<ItemOutcome> => {
      const existingPath = obj.key.split("/").pop()!.replace(/\.json$/, "");
      const prior = findJudgment("sci-open-data", existingPath);
      if (prior && obj.etag && prior.sourceEtag === obj.etag && prior.intelDocId && (!cfg.fetchPdf || prior.pdfBlobId || prior.issues?.length)) { ctx.result.skipped++; return "skipped"; }
      let json: SciMetadataJson;
      try { json = await sci.getJSON<SciMetadataJson>(obj.key, ctx.signal); } catch (e) {
        ctx.fail(e, { provider: "sci-open-data", label: `metadata ${obj.key}` });
        return isProviderError(e) && e.retryable ? "failed_transient" : "failed";
      }
      let parsed;
      try { parsed = parseSciMetadata(json, { key: obj.key, bucketUrl: sci.baseUrl }); } catch (e) { ctx.fail(e, { label: `parse ${obj.key}` }); return "failed"; }
      let file: JudgmentFile | null = null;
      const issues: string[] = [];
      if (cfg.fetchPdf) {
        try {
          const pdf = await sci.getBytes(parsed.englishPdfKey, { maxBytes: cfg.maxPdfMb * 1024 * 1024, signal: ctx.signal });
          file = { bytes: pdf.bytes, name: parsed.englishPdfKey.split("/").pop()!, mime: "application/pdf" };
        } catch (e) {
          if (isNotFound(e)) issues.push("English PDF not present in the dataset");
          else if (isProviderError(e) && e.retryable) { ctx.fail(e, { provider: "sci-open-data", label: `pdf ${parsed.englishPdfKey}` }); return "failed_transient"; }
          else issues.push(`English PDF not read: ${(e as Error).message}`);
        }
      }
      // Court-published translations (optional): stored as original files and linked on the judgment; never the text of record.
      if (wanted.size && parsed.draft.translations.length) {
        for (const t of parsed.draft.translations) {
          if (!wanted.has(t.language) || !t.url) continue;
          const key = decodeURIComponent(t.url.slice(sci.baseUrl.length + 1));
          try {
            const tr = await sci.getBytes(key, { maxBytes: cfg.maxPdfMb * 1024 * 1024, signal: ctx.signal });
            t.blobId = putOriginalFile(tr.bytes, "application/pdf", { name: key.split("/").pop(), source: "sci-open-data", translationOf: parsed.draft.externalId, language: t.language, origin: t.origin }).blobId;
          } catch (e) { issues.push(`Translation ${t.language} not read: ${(e as Error).message}`); }
        }
      }
      const r = await ingestJudgment(ctx, parsed.draft, { file, sourceEtag: obj.etag || undefined, sourceModified: obj.lastModified || undefined, issues });
      return r.status === "unchanged" ? "skipped" : "ingested";
    };
    try {
      const stats = await walkPrefixes(ctx, sci, years.map(sciMetadataPrefix), cursor, handle, { concurrency: cfg.concurrency, maxPerPrefix: cfg.maxPerPrefix, maxListPages: cfg.maxListPages, restart: cfg.restart });
      ctx.note(`${SUPREME_COURT.shortName} ${years.join(", ")}: ${stats.listed} listed, ${stats.ingested} ingested, ${stats.skipped} unchanged, ${stats.failed} failed; ${stats.completedPrefixes}/${stats.prefixes} year folders fully scanned.`);
    } finally {
      ctx.result.nextCursor = encodeCursor(cursor);
    }
  },
});
