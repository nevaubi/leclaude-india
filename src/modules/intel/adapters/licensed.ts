import "server-only";
import fs from "node:fs";
import { z } from "zod";
import { ingestJudgment } from "@/modules/india/sources/ingest";
import { exportRecordToJudgment, fetchLicensedApi, fileSha, LICENSED_NAMES, licensedStatus, listExportFiles, LICENSED_EXPORT_ENV, type ExportRecord, type LicensedConfig, type LicensedProvider } from "@/modules/india/sources/licensed";
import { findJudgment } from "@/modules/india/sources/store";
import { intelConfig } from "../config";
import { ProviderError } from "../providers/base";
import { defineAdapter, type AdapterContext, type IntelAdapter } from "./types";

const schema = z.object({
  /** The firm confirms its subscription licence covers this use. Nothing runs until this is true. */
  licenseAcknowledged: z.boolean().default(false),
  mode: z.enum(["export", "api"]).default("export"),
  /** Folder holding files exported from the firm's own subscription (JSON export records, PDF, HTML, TXT). */
  exportDir: z.string().optional(),
  /** HTTPS endpoint of an API the firm is licensed to use (JSON only). */
  apiEndpoint: z.string().url().optional(),
  /** Environment variable holding the API credential (the credential itself is never stored in the source). */
  apiTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  maxFiles: z.number().int().min(1).max(5000).default(500),
  maxFileMb: z.number().min(1).max(100).default(25),
});

export type LicensedAdapterConfig = z.infer<typeof schema>;

async function runLicensed(provider: LicensedProvider, ctx: AdapterContext<LicensedAdapterConfig>) {
  const cfg: LicensedConfig = ctx.config;
  const st = licensedStatus(provider, cfg);
  if (st.state !== "ready") {
    // Fail closed before any file read or network call.
    ctx.fail(new ProviderError(provider, "not_configured", `${provider}: ${st.state} — ${st.reason}`, false), { provider, label: LICENSED_NAMES[provider] });
    return;
  }
  const ingestRecord = async (rec: ExportRecord, externalId: string, extra: { file?: { bytes: Uint8Array; name: string; mime: string }; sha?: string }) => {
    const { draft, text } = exportRecordToJudgment(provider, rec, externalId);
    draft.sha256 = extra.sha;
    await ingestJudgment(ctx, draft, { file: extra.file ?? null, text: extra.file ? undefined : text, textMethod: rec.html ? "html" : "text", sourceEtag: extra.sha, tags: [provider, "licensed"] });
  };

  if (cfg.mode === "api") {
    const records = await ctx.attempt(`${LICENSED_NAMES[provider]} API`, () => fetchLicensedApi(provider, cfg, { since: ctx.since, signal: ctx.signal, offline: intelConfig().offline }), { provider });
    for (const rec of records ?? []) {
      if (ctx.budgetLeft() <= 0) break;
      const id = rec.id?.trim() || rec.neutralCitation?.trim() || rec.url?.trim();
      if (!id) { ctx.fail(new Error("parse: export record without id, neutralCitation or url"), { provider, label: "record" }); continue; }
      await ctx.attempt(`record ${id}`, () => ingestRecord(rec, `api:${id}`, {}), { provider });
    }
    return;
  }

  const dir = cfg.exportDir?.trim() || process.env[LICENSED_EXPORT_ENV[provider]]!.trim();
  const { files, skipped } = listExportFiles(dir, { maxFiles: cfg.maxFiles, maxFileMb: cfg.maxFileMb });
  for (const s of skipped.slice(0, 10)) ctx.note(`Skipped ${s}`);
  for (const f of files) {
    if (ctx.budgetLeft() <= 0) break;
    await ctx.attempt(`file ${f.rel}`, async () => {
      const sha = fileSha(f.abs);
      if (f.ext === "json") {
        const data = JSON.parse(fs.readFileSync(f.abs, "utf8")) as ExportRecord | ExportRecord[] | { items?: ExportRecord[] };
        const list = Array.isArray(data) ? data : Array.isArray((data as { items?: ExportRecord[] }).items) ? (data as { items: ExportRecord[] }).items : [data as ExportRecord];
        for (const [i, rec] of list.entries()) {
          const externalId = `file:${f.rel}#${rec.id?.trim() || i}`;
          const prior = findJudgment(provider, externalId);
          if (prior?.sourceEtag === sha && prior.intelDocId) { ctx.result.skipped++; continue; }
          await ingestRecord(rec, externalId, { sha });
        }
        return;
      }
      const externalId = `file:${f.rel}`;
      const prior = findJudgment(provider, externalId);
      if (prior?.sourceEtag === sha && prior.intelDocId) { ctx.result.skipped++; return; }
      const bytes = new Uint8Array(fs.readFileSync(f.abs));
      const title = f.rel.replace(/\.[^.]+$/, "").split("/").pop()!.replace(/[_-]+/g, " ");
      if (f.ext === "pdf") await ingestRecord({ title }, externalId, { file: { bytes, name: f.rel.split("/").pop()!, mime: "application/pdf" }, sha });
      else if (f.ext === "html" || f.ext === "htm") await ingestRecord({ title, html: new TextDecoder().decode(bytes) }, externalId, { sha });
      else await ingestRecord({ title, text: new TextDecoder().decode(bytes) }, externalId, { sha });
    }, { provider });
  }
  ctx.note(`${LICENSED_NAMES[provider]} export folder: ${files.length} file(s) read.`);
}

function licensedAdapter(provider: LicensedProvider): IntelAdapter<LicensedAdapterConfig> {
  return defineAdapter<LicensedAdapterConfig>({
    id: provider,
    name: `${LICENSED_NAMES[provider]} (licensed)`,
    description: `${LICENSED_NAMES[provider]} through the firm's own licence only: files exported from the firm's subscription, or an API the firm is licensed to use. Disabled by default; never scraped.`,
    kinds: ["opinion"],
    family: provider,
    requires: [provider],
    configSchema: schema,
    defaults: schema.parse({}),
    run: (ctx) => runLicensed(provider, ctx),
  });
}

export const sccOnlineAdapter = licensedAdapter("scc-online");
export const manupatraAdapter = licensedAdapter("manupatra");
