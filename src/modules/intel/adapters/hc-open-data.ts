import "server-only";
import { z } from "zod";
import { courtById, courtByDatasetCode, FOCUS_COURT_IDS } from "@/lib/india/courts";
import { hcBenchPrefix, hcCourtPrefix, parseHcKey, parseHcMetadata, type HcMetadataJson } from "@/modules/india/sources/hc";
import { isNotFound } from "@/modules/india/sources/http";
import { ingestJudgment, type JudgmentFile } from "@/modules/india/sources/ingest";
import { decodeCursor, encodeCursor, walkPrefixes, yearsFor, type ItemOutcome } from "@/modules/india/sources/open-data";
import { indiaProvidersFor } from "@/modules/india/sources/providers";
import { findJudgment } from "@/modules/india/sources/store";
import { isProviderError, ProviderError } from "../providers/base";
import { defineAdapter } from "./types";

const DATASET_CODE = /^\d{1,2}_\d{1,2}$/;

/** Focus courts' dataset codes (Karnataka 29_3, Telangana 36_29, Andhra Pradesh 28_2), from the registry. */
export const FOCUS_DATASET_CODES = FOCUS_COURT_IDS.map((id) => courtById(id)?.datasetCode).filter((c): c is string => Boolean(c));

const schema = z.object({
  /** Registry court ids ("hc-karnataka") or dataset codes ("29_3"). Unknown registry ids are rejected. */
  courts: z.array(z.string().min(1)).default(FOCUS_DATASET_CODES).refine((list) => list.every((c) => DATASET_CODE.test(c) || Boolean(courtById(c)?.datasetCode)), { message: "each court must be a registry High Court id or a dataset code like 29_3" }),
  /** Restrict to these dataset bench folders (e.g. ["karhcdharwad"]); empty = every bench found in the dataset. */
  benches: z.array(z.string().min(1)).default([]),
  years: z.array(z.number().int().min(1950).max(2100)).default([]),
  lastYears: z.number().int().min(1).max(80).default(2),
  fromYear: z.number().int().min(1950).max(2100).optional(),
  fetchPdf: z.boolean().default(true),
  maxPdfMb: z.number().min(1).max(100).default(25),
  concurrency: z.number().int().min(1).max(8).default(4),
  maxPerPrefix: z.number().int().min(1).max(5000).default(60),
  maxListPages: z.number().int().min(1).max(500).default(80),
  restart: z.boolean().default(false),
});

export type HcOpenDataConfig = z.infer<typeof schema>;

export function datasetCodeFor(courtOrCode: string): string {
  return DATASET_CODE.test(courtOrCode) ? courtOrCode : courtById(courtOrCode)!.datasetCode!;
}

/**
 * High Court judgments from the AWS Open Data bucket `indian-high-court-judgments`, per court and bench folder.
 * Defaults: the focus courts (Karnataka, Telangana, Andhra Pradesh), the last two years, every bench in the dataset.
 * Court identity is resolved only through the registry; unknown codes and bench folders are stored unresolved.
 */
export const hcOpenDataAdapter = defineAdapter<HcOpenDataConfig>({
  id: "hc-open-data",
  name: "High Courts (open judgments)",
  description: "High Court judgments from the AWS Open Data set, per court and bench: metadata, PDF text, CNR, neutral citations and coram. Defaults to Karnataka, Telangana and Andhra Pradesh.",
  kinds: ["opinion"],
  family: "hc-open-data",
  requires: ["hc-open-data"],
  configSchema: schema,
  defaults: schema.parse({}),
  async run(ctx) {
    const cfg = ctx.config;
    const { hc } = indiaProvidersFor(ctx);
    if (hc.http.offline) { ctx.fail(new ProviderError("hc-open-data", "not_configured", "hc-open-data: offline (INTEL_OFFLINE is set); nothing was fetched", false), { provider: "hc-open-data", label: "hc-open-data" }); return; }
    const years = yearsFor(cfg, ctx.now);
    const codes = Array.from(new Set(cfg.courts.map(datasetCodeFor)));
    const cursor = decodeCursor(ctx.cursor);

    // Discover the bench folders that actually exist (per court and year) instead of assuming them.
    const prefixes: string[] = [];
    for (const year of years) {
      for (const code of codes) {
        const folders = await ctx.attempt(`list benches ${code} ${year}`, () => hc.folders(hcCourtPrefix(year, code), ctx.signal), { provider: "hc-open-data" });
        const benches = (folders ?? []).map((f) => /bench=([^/]+)\/$/.exec(f)?.[1]).filter((b): b is string => Boolean(b));
        const court = courtByDatasetCode(code);
        for (const b of benches) {
          if (cfg.benches.length && !cfg.benches.includes(b)) continue;
          if (court && !court.benches.some((x) => x.datasetBench === b)) ctx.note(`${court.shortName}: dataset bench folder "${b}" is not in the court registry; its judgments are stored without a bench.`);
          prefixes.push(hcBenchPrefix(year, code, b));
        }
        if (folders && !benches.length) ctx.note(`No bench folders for court=${code} in ${year}.`);
      }
    }

    const handle = async (obj: { key: string; etag: string; lastModified: string }): Promise<ItemOutcome> => {
      const parts = parseHcKey(obj.key);
      const prior = findJudgment("hc-open-data", `${parts.courtCode ?? "unknown"}/${parts.bench ?? "unknown"}/${parts.basename}`);
      if (prior && obj.etag && prior.sourceEtag === obj.etag && prior.intelDocId && (!cfg.fetchPdf || prior.pdfBlobId || prior.issues?.length)) { ctx.result.skipped++; return "skipped"; }
      let json: HcMetadataJson;
      try { json = await hc.getJSON<HcMetadataJson>(obj.key, ctx.signal); } catch (e) {
        ctx.fail(e, { provider: "hc-open-data", label: `metadata ${obj.key}` });
        return isProviderError(e) && e.retryable ? "failed_transient" : "failed";
      }
      let parsed;
      try { parsed = parseHcMetadata(json, { key: obj.key, bucketUrl: hc.baseUrl }); } catch (e) { ctx.fail(e, { label: `parse ${obj.key}` }); return "failed"; }
      let file: JudgmentFile | null = null;
      const issues: string[] = [];
      if (cfg.fetchPdf && parsed.pdfKey) {
        try {
          const pdf = await hc.getBytes(parsed.pdfKey, { maxBytes: cfg.maxPdfMb * 1024 * 1024, signal: ctx.signal });
          file = { bytes: pdf.bytes, name: parsed.pdfKey.split("/").pop()!, mime: "application/pdf" };
        } catch (e) {
          if (isNotFound(e)) issues.push("Judgment PDF not present in the dataset");
          else if (isProviderError(e) && e.retryable) { ctx.fail(e, { provider: "hc-open-data", label: `pdf ${parsed.pdfKey}` }); return "failed_transient"; }
          else issues.push(`Judgment PDF not read: ${(e as Error).message}`);
        }
      }
      const r = await ingestJudgment(ctx, parsed.draft, { file, sourceEtag: obj.etag || undefined, sourceModified: obj.lastModified || undefined, issues });
      return r.status === "unchanged" ? "skipped" : "ingested";
    };

    try {
      const stats = await walkPrefixes(ctx, hc, prefixes, cursor, handle, { concurrency: cfg.concurrency, maxPerPrefix: cfg.maxPerPrefix, maxListPages: cfg.maxListPages, restart: cfg.restart });
      ctx.note(`High Courts ${codes.join(", ")} · ${years.join(", ")}: ${prefixes.length} bench folders, ${stats.listed} listed, ${stats.ingested} ingested, ${stats.skipped} unchanged, ${stats.failed} failed; ${stats.completedPrefixes} folders fully scanned.`);
    } finally {
      ctx.result.nextCursor = encodeCursor(cursor);
    }
  },
});
