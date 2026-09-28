import "server-only";
import { courtById, SUPREME_COURT, type Court } from "@/lib/india/courts";
import type { IndianCitation } from "@/lib/india/types";
import { ProviderError } from "@/modules/intel/providers/base";
import { SourceHttp, type SourceHttpOptions } from "./http";
import { clean, htmlParagraphs, htmlText, isoDate, splitParties } from "./parse-util";
import type { JudgmentDraft } from "./sci";
import type { IndiaConnectorStatus } from "./types";

/**
 * Indian Kanoon API client (https://api.indiankanoon.org, documented at /documentation/ and in the vendor's IKAPI
 * reference client). Paid, per-request billing; the firm supplies `INDIAN_KANOON_API_TOKEN`. Without a token the
 * client reports `not_configured` and never opens a connection.
 *
 * Endpoints (all POST, `Authorization: Token <token>`, `Accept: application/json`):
 *   /search/?formInput=<q>&pagenum=<n>[&maxpages=<m>]  → { found, docs:[{ tid, title, headline, docsource, publishdate, numcites, numcitedby, docsize, citation?, author?, bench? }], categories, encodedformInput }
 *   /doc/<docid>/[?maxcites=&maxcitedby=]             → { tid, title, doc (HTML), publishdate, docsource, citeList, citedbyList, courtcopy, numcites, numcitedby, … }
 *   /docfragment/<docid>/?formInput=<q>                → { tid, title, headline, formInput }
 *   /docmeta/<docid>/                                   → { tid, title, publishdate, docsource, numcites, numcitedby, … }
 * Errors come back as `{ errmsg }` (or 403 for a bad token). Search operators ANDD / ORR / NOTT and the filters
 * `doctypes:`, `fromdate:`, `todate:` (DD-MM-YYYY), `title:`, `cite:`, `author:`, `bench:` go inside formInput.
 */
export const INDIAN_KANOON_BASE = "https://api.indiankanoon.org";
export const INDIAN_KANOON_ENV = "INDIAN_KANOON_API_TOKEN";

export interface IkSearchDoc {
  tid: number;
  title: string;
  headline?: string;
  docsource?: string;
  publishdate?: string;
  numcites?: number;
  numcitedby?: number;
  docsize?: number;
  citation?: string;
  author?: string;
  bench?: string;
}

export interface IkSearchResult { found?: string | number; docs: IkSearchDoc[]; categories?: unknown[] }

export interface IkCiteRef { tid: number; title: string }

export interface IkDoc {
  tid: number;
  title: string;
  doc: string;
  publishdate?: string;
  docsource?: string;
  citeList?: IkCiteRef[];
  citedbyList?: IkCiteRef[];
  courtcopy?: boolean;
  numcites?: number;
  numcitedby?: number;
}

export interface IkDocMeta { tid: number; title?: string; publishdate?: string; docsource?: string; numcites?: number; numcitedby?: number; [k: string]: unknown }

/**
 * Indian Kanoon `docsource` → registry court. Exact names only; anything else stays unresolved. The pre-2019
 * "Andhra HC" is the combined High Court at Hyderabad, which is not the present High Court of Andhra Pradesh at
 * Amaravati: it resolves only for decisions on or after 2019-01-01.
 */
const DOCSOURCE_COURTS: { names: string[]; courtId: string; from?: string }[] = [
  { names: ["Supreme Court of India", "Supreme Court - Daily Orders"], courtId: SUPREME_COURT.id },
  { names: ["Karnataka High Court"], courtId: "hc-karnataka" },
  { names: ["Telangana High Court"], courtId: "hc-telangana", from: "2019-01-01" },
  { names: ["Andhra Pradesh High Court - Amravati", "Andhra Pradesh High Court"], courtId: "hc-andhra", from: "2019-01-01" },
  { names: ["Delhi High Court"], courtId: "hc-delhi" },
  { names: ["Bombay High Court"], courtId: "hc-bombay" },
  { names: ["Madras High Court"], courtId: "hc-madras" },
  { names: ["Kerala High Court"], courtId: "hc-kerala" },
  { names: ["Calcutta High Court"], courtId: "hc-calcutta" },
  { names: ["Allahabad High Court"], courtId: "hc-allahabad" },
  { names: ["Gujarat High Court"], courtId: "hc-gujarat" },
];

export function courtForDocsource(docsource: string | undefined, date: string | undefined): { court: Court | null; unresolved?: string } {
  const src = clean(docsource);
  if (!src) return { court: null, unresolved: "indian-kanoon:(no docsource)" };
  const hit = DOCSOURCE_COURTS.find((d) => d.names.some((n) => n.toLowerCase() === src.toLowerCase()));
  if (!hit) return { court: null, unresolved: `indian-kanoon:${src}` };
  if (hit.from && (!date || date < hit.from)) return { court: null, unresolved: `indian-kanoon:${src}${date ? ` (${date})` : ""}` };
  return { court: courtById(hit.courtId) };
}

/** Map an Indian Kanoon document to the judgment contract. Text of record is the provider's HTML rendered to text. */
export function ikDocToJudgment(doc: IkDoc | (IkSearchDoc & { doc?: string })): { draft: JudgmentDraft; text: string } {
  const date = isoDate(doc.publishdate);
  const { court, unresolved } = courtForDocsource(doc.docsource, date);
  const title = clean(htmlText(doc.title)) ?? `Indian Kanoon document ${doc.tid}`;
  const parties = splitParties(title.replace(/\s+on\s+\d{1,2}\s+\w+,?\s+\d{4}$/i, ""));
  const text = "doc" in doc && doc.doc ? htmlParagraphs(doc.doc) : clean(htmlText((doc as IkSearchDoc).headline)) ?? "";
  const citations: IndianCitation[] = [];
  const cite = clean((doc as IkSearchDoc).citation);
  if (cite) citations.push({ raw: cite, kind: "unknown" }); // parsed by the citation engine, never guessed here
  const issues: string[] = [];
  if (!court) issues.push(`Court not resolved from Indian Kanoon docsource "${doc.docsource ?? ""}"`);
  return {
    text,
    draft: {
      source: "indian-kanoon",
      externalId: String(doc.tid),
      courtId: court?.id ?? null,
      unresolvedCourt: court ? undefined : unresolved,
      title,
      petitioner: parties.petitioner,
      respondent: parties.respondent,
      citations,
      judges: [],
      decisionDate: date,
      language: "en",
      translations: [],
      pdfUrl: undefined,
      statutes: [],
      headnote: clean(htmlText((doc as IkSearchDoc).headline))?.slice(0, 800),
      issues: issues.length ? issues : undefined,
      license: "Indian Kanoon API (firm subscription)",
    },
  };
}

export interface IndianKanoonClient {
  status(): IndiaConnectorStatus;
  search(q: { formInput: string; pagenum?: number; maxpages?: number; signal?: AbortSignal }): Promise<IkSearchResult>;
  doc(tid: number, o?: { maxcites?: number; maxcitedby?: number; signal?: AbortSignal }): Promise<IkDoc>;
  docmeta(tid: number, o?: { signal?: AbortSignal }): Promise<IkDocMeta>;
  docfragment(tid: number, formInput: string, o?: { signal?: AbortSignal }): Promise<{ tid: number; title?: string; headline?: string }>;
  /** Public web URL of a document (for citation links). */
  webUrl(tid: number): string;
  http: SourceHttp;
}

export function createIndianKanoon(o: Omit<SourceHttpOptions, "name" | "egress"> & { token?: string; baseUrl?: string } = {}): IndianKanoonClient {
  const token = o.token?.trim() || undefined;
  const base = o.baseUrl ?? INDIAN_KANOON_BASE;
  const http = new SourceHttp({ name: "indian-kanoon", egress: { name: "indian-kanoon", allowHosts: ["=api.indiankanoon.org"], allowedSchemes: ["https:"] }, rps: o.rps ?? 2, burst: o.burst ?? 4, retries: o.retries ?? 2, ...o });

  const status = (): IndiaConnectorStatus => {
    if (!token) return { source: "indian-kanoon", state: "not_configured", reason: `Set ${INDIAN_KANOON_ENV} to the firm's Indian Kanoon API token.`, envVar: INDIAN_KANOON_ENV };
    if (http.offline) return { source: "indian-kanoon", state: "offline", reason: "Outbound network is disabled (INTEL_OFFLINE).", envVar: INDIAN_KANOON_ENV };
    return { source: "indian-kanoon", state: "ready", envVar: INDIAN_KANOON_ENV };
  };

  async function call<T>(path: string, signal?: AbortSignal): Promise<T> {
    if (!token) throw new ProviderError("indian-kanoon", "not_configured", `indian-kanoon: ${INDIAN_KANOON_ENV} is not set`, false);
    const data = await http.json<T & { errmsg?: string }>(`${base}${path}`, { method: "POST", headers: { Authorization: `Token ${token}`, Accept: "application/json" }, signal, maxBytes: 12 * 1024 * 1024 });
    if (data && typeof data === "object" && typeof data.errmsg === "string") {
      const auth = /token|auth|credential|permission|balance|recharge/i.test(data.errmsg);
      throw new ProviderError("indian-kanoon", auth ? "not_configured" : "parse", `indian-kanoon: ${data.errmsg.slice(0, 200)}`, false);
    }
    return data;
  }

  return {
    http,
    status,
    webUrl: (tid) => `https://indiankanoon.org/doc/${tid}/`,
    async search(q) {
      const p = new URLSearchParams({ formInput: q.formInput, pagenum: String(Math.max(0, q.pagenum ?? 0)) });
      if (q.maxpages) p.set("maxpages", String(Math.min(10, Math.max(1, q.maxpages))));
      const r = await call<IkSearchResult>(`/search/?${p.toString()}`, q.signal);
      if (!r || !Array.isArray(r.docs)) throw new ProviderError("indian-kanoon", "parse", "indian-kanoon: search response has no docs array (schema drift?)", false);
      return r;
    },
    async doc(tid, opts = {}) {
      const p = new URLSearchParams();
      if (opts.maxcites) p.set("maxcites", String(Math.min(50, opts.maxcites)));
      if (opts.maxcitedby) p.set("maxcitedby", String(Math.min(50, opts.maxcitedby)));
      const r = await call<IkDoc>(`/doc/${Math.trunc(tid)}/${p.size ? `?${p.toString()}` : ""}`, opts.signal);
      if (!r || typeof r.doc !== "string") throw new ProviderError("indian-kanoon", "parse", "indian-kanoon: document response has no doc field (schema drift?)", false);
      return r;
    },
    docmeta: (tid, opts = {}) => call<IkDocMeta>(`/docmeta/${Math.trunc(tid)}/`, opts.signal),
    docfragment: (tid, formInput, opts = {}) => call(`/docfragment/${Math.trunc(tid)}/?${new URLSearchParams({ formInput }).toString()}`, opts.signal),
  };
}

/** Compose an Indian Kanoon query with documented filters (dates are DD-MM-YYYY). */
export function ikQuery(q: string, f: { doctypes?: string[]; fromISO?: string; toISO?: string } = {}): string {
  const dmy = (iso: string) => { const [y, m, d] = iso.split("-"); return `${Number(d)}-${Number(m)}-${y}`; };
  const parts = [q.trim()];
  if (f.doctypes?.length) parts.push(`doctypes: ${f.doctypes.join(",")}`);
  if (f.fromISO) parts.push(`fromdate: ${dmy(f.fromISO)}`);
  if (f.toISO) parts.push(`todate: ${dmy(f.toISO)}`);
  return parts.filter(Boolean).join(" ");
}

/** Indian Kanoon `doctypes` for the focus courts (documented values). */
export const IK_FOCUS_DOCTYPES = ["supremecourt", "karnataka", "andhra"] as const;
