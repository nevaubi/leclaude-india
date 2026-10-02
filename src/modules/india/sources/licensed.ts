import "server-only";
import fs from "node:fs";
import path from "node:path";
import { COURTS, courtById } from "@/lib/india/courts";
import type { IndianCitation, LegalSourceId } from "@/lib/india/types";
import { sha256 } from "@/lib/integrity/hash";
import { ProviderError } from "@/modules/intel/providers/base";
import { SourceHttp } from "./http";
import { clean, htmlParagraphs, isoDate, normalizeNeutral, splitParties } from "./parse-util";
import type { JudgmentDraft } from "./sci";
import type { IndiaConnectorStatus } from "./types";
import { BRAND } from "@/lib/brand";

/**
 * Licensed connectors: SCC Online and Manupatra.
 *
 * Both are subscription services with no public API whose terms prohibit scraping. LeClaude India therefore never
 * logs in to, crawls or scrapes them. The connectors are disabled by default and fail closed:
 *   - `license_required` until the firm records that it holds a licence covering this use (`licenseAcknowledged`);
 *   - `not_configured` until the firm supplies either an export folder (files the firm exported from its own
 *     subscription) or an API endpoint the firm is licensed to use plus the name of the environment variable that
 *     holds its credential.
 * Export folders accept JSON export records (schema below), PDF, HTML and plain-text files. API mode expects the
 * endpoint to return JSON (an array of export records, or `{ items: [...] }`); an HTML response is refused, so the
 * connector cannot be pointed at a login page or a website.
 *
 * Export record (JSON):
 *   { id?, title, court? (registry court name), courtId? (registry id), date? (YYYY-MM-DD or DD-MM-YYYY),
 *     neutralCitation?, citations?: string[], judges?: string[], caseNumber?, text? | html?, url? }
 */
export type LicensedProvider = Extract<LegalSourceId, "scc-online" | "manupatra">;

export const LICENSED_NAMES: Record<LicensedProvider, string> = { "scc-online": "SCC Online", manupatra: "Manupatra" };
export const LICENSED_DEFAULT_TOKEN_ENV: Record<LicensedProvider, string> = { "scc-online": "SCC_ONLINE_API_TOKEN", manupatra: "MANUPATRA_API_TOKEN" };
export const LICENSED_EXPORT_ENV: Record<LicensedProvider, string> = { "scc-online": "SCC_ONLINE_EXPORT_DIR", manupatra: "MANUPATRA_EXPORT_DIR" };

/** Vendor web hosts an API endpoint may never point at (their websites are not APIs; scraping is prohibited). */
const VENDOR_WEB_HOSTS = ["scconline.com", "www.scconline.com", "manupatrafast.com", "www.manupatrafast.com", "manupatra.com", "www.manupatra.com"];

export interface LicensedConfig {
  licenseAcknowledged: boolean;
  mode: "export" | "api";
  exportDir?: string;
  apiEndpoint?: string;
  apiTokenEnv?: string;
  maxFiles: number;
  maxFileMb: number;
}

export const EXPORT_EXTENSIONS = ["json", "pdf", "html", "htm", "txt"] as const;

export function licensedStatus(provider: LicensedProvider, cfg: LicensedConfig, env: Readonly<Record<string, string | undefined>> = process.env): IndiaConnectorStatus {
  const name = LICENSED_NAMES[provider];
  if (!cfg.licenseAcknowledged) return { source: provider, state: "license_required", reason: `${name} is a subscription service. Confirm the firm's licence covers this use before connecting it; nothing is fetched until then.` };
  if (cfg.mode === "export") {
    const dir = cfg.exportDir?.trim() || env[LICENSED_EXPORT_ENV[provider]]?.trim();
    if (!dir) return { source: provider, state: "not_configured", reason: `Set an export folder (or ${LICENSED_EXPORT_ENV[provider]}) holding files exported from the firm's ${name} subscription.`, envVar: LICENSED_EXPORT_ENV[provider], local: true };
    try { if (!fs.statSync(dir).isDirectory()) throw new Error("not a folder"); } catch { return { source: provider, state: "not_configured", reason: `Export folder ${dir} is not readable.`, local: true }; }
    return { source: provider, state: "ready", local: true };
  }
  const tokenEnv = cfg.apiTokenEnv?.trim() || LICENSED_DEFAULT_TOKEN_ENV[provider];
  if (!cfg.apiEndpoint) return { source: provider, state: "not_configured", reason: `Set the API endpoint the firm is licensed to use for ${name}.`, envVar: tokenEnv };
  let url: URL;
  try { url = new URL(cfg.apiEndpoint); } catch { return { source: provider, state: "not_configured", reason: "The API endpoint is not a valid URL.", envVar: tokenEnv }; }
  if (url.protocol !== "https:") return { source: provider, state: "not_configured", reason: "The API endpoint must use HTTPS.", envVar: tokenEnv };
  if (VENDOR_WEB_HOSTS.includes(url.hostname.toLowerCase())) return { source: provider, state: "not_configured", reason: `${url.hostname} is the vendor's website, not an API; ${BRAND.name} does not scrape subscription services.`, envVar: tokenEnv };
  if (!env[tokenEnv]?.trim()) return { source: provider, state: "not_configured", reason: `Set ${tokenEnv} to the firm's API credential.`, envVar: tokenEnv };
  return { source: provider, state: "ready", envVar: tokenEnv };
}

export interface ExportRecord {
  id?: string;
  title?: string;
  court?: string;
  courtId?: string;
  date?: string;
  neutralCitation?: string;
  citations?: string[];
  judges?: string[];
  caseNumber?: string;
  text?: string;
  html?: string;
  url?: string;
}

/** Resolve a court named in an export: registry id, or an exact registry name/short name. Anything else stays unresolved. */
export function resolveExportCourt(r: Pick<ExportRecord, "court" | "courtId">): { courtId: string | null; unresolved?: string } {
  if (r.courtId) { const c = courtById(r.courtId); return c ? { courtId: c.id } : { courtId: null, unresolved: `export:${r.courtId}` }; }
  const name = clean(r.court)?.toLowerCase();
  if (!name) return { courtId: null, unresolved: "export:(no court)" };
  const hit = COURTS.find((c) => c.name.toLowerCase() === name || c.shortName.toLowerCase() === name);
  return hit ? { courtId: hit.id } : { courtId: null, unresolved: `export:${clean(r.court)}` };
}

export function exportRecordToJudgment(provider: LicensedProvider, r: ExportRecord, externalId: string): { draft: JudgmentDraft; text: string } {
  const { courtId, unresolved } = resolveExportCourt(r);
  const title = clean(r.title) ?? externalId;
  const neutral = normalizeNeutral(r.neutralCitation);
  const citations: IndianCitation[] = [];
  if (neutral) citations.push({ raw: neutral, kind: "neutral", neutral, courtId: courtId ?? undefined });
  for (const c of r.citations ?? []) if (clean(c)) citations.push({ raw: clean(c)!, kind: "unknown" });
  const parties = splitParties(title);
  const text = clean(r.text) ? r.text!.trim() : r.html ? htmlParagraphs(r.html) : "";
  return {
    text,
    draft: {
      source: provider,
      externalId,
      courtId,
      unresolvedCourt: courtId ? undefined : unresolved,
      title,
      petitioner: parties.petitioner,
      respondent: parties.respondent,
      caseNumber: clean(r.caseNumber),
      neutralCitation: neutral,
      citations,
      judges: (r.judges ?? []).map((j) => clean(j)).filter((j): j is string => Boolean(j)),
      decisionDate: isoDate(r.date),
      language: "en",
      translations: [],
      pdfUrl: undefined,
      statutes: [],
      issues: courtId ? undefined : [`Court not resolved from the ${LICENSED_NAMES[provider]} export`],
      license: `${LICENSED_NAMES[provider]} (firm licence; firm-supplied export)`,
    },
  };
}

export interface ExportFile { rel: string; abs: string; ext: string; size: number; mtime: string }

/** Files in the export folder (two levels deep), confined to the folder (symlinks leaving it are ignored). */
export function listExportFiles(dir: string, o: { maxFiles: number; maxFileMb: number }): { files: ExportFile[]; skipped: string[] } {
  const root = fs.realpathSync(dir);
  const files: ExportFile[] = [];
  const skipped: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const abs = path.join(d, ent.name);
      let real: string;
      try { real = fs.realpathSync(abs); } catch { continue; }
      if (real !== root && !real.startsWith(root + path.sep)) { skipped.push(`${ent.name}: outside the export folder`); continue; }
      const st = fs.statSync(real);
      if (st.isDirectory()) { if (depth < 2) walk(real, depth + 1); continue; }
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (!(EXPORT_EXTENSIONS as readonly string[]).includes(ext)) continue;
      if (st.size > o.maxFileMb * 1024 * 1024) { skipped.push(`${ent.name}: larger than ${o.maxFileMb} MB`); continue; }
      files.push({ rel: path.relative(root, real).split(path.sep).join("/"), abs: real, ext, size: st.size, mtime: st.mtime.toISOString() });
      if (files.length >= o.maxFiles) return;
    }
  };
  walk(root, 0);
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), skipped };
}

export function fileSha(abs: string): string {
  return sha256(fs.readFileSync(abs));
}

/** Fetch export records from a firm-configured, licensed API endpoint (JSON only). */
export async function fetchLicensedApi(provider: LicensedProvider, cfg: LicensedConfig, o: { since?: string; signal?: AbortSignal; fetchImpl?: typeof fetch; env?: Readonly<Record<string, string | undefined>>; offline?: boolean } = {}): Promise<ExportRecord[]> {
  const env = o.env ?? process.env;
  const st = licensedStatus(provider, cfg, env);
  if (st.state !== "ready" || cfg.mode !== "api") throw new ProviderError(provider, "not_configured", `${provider}: ${st.reason ?? "not configured for API mode"}`, false);
  const url = new URL(cfg.apiEndpoint!);
  if (o.since) url.searchParams.set("since", o.since);
  const http = new SourceHttp({ name: provider, egress: { name: provider, allowHosts: [`=${url.hostname}`], allowedSchemes: ["https:"] }, rps: 1, burst: 2, retries: 2, fetchImpl: o.fetchImpl, offline: o.offline });
  const token = env[cfg.apiTokenEnv?.trim() || LICENSED_DEFAULT_TOKEN_ENV[provider]]!.trim();
  const res = await http.request(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: o.signal, maxBytes: 32 * 1024 * 1024 });
  if (!/json/i.test(res.contentType)) throw new ProviderError(provider, "parse", `${provider}: the endpoint returned ${res.contentType || "an unknown type"}, not JSON; only licensed JSON APIs are supported`, false);
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(res.body)); } catch { throw new ProviderError(provider, "parse", `${provider}: invalid JSON from the licensed endpoint`, false); }
  const items = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown[] })?.items) ? (data as { items: unknown[] }).items : null;
  if (!items) throw new ProviderError(provider, "parse", `${provider}: expected an array of export records`, false);
  return items.filter((x): x is ExportRecord => Boolean(x) && typeof x === "object");
}
