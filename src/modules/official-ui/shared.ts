/**
 * Official sources library (/sources): client-safe display helpers and URL state over the official-sources corpus
 * routes (/api/official, /api/official/search, /api/official/documents, /api/official/documents/[id]). Pure; no I/O.
 *
 * Presentation rules
 * - The publisher's document is the text of record: every hit and document shows its official link, and OCR text is
 *   always labelled "Text from OCR — check the PDF".
 * - Coverage is what has been collected so far; it never claims to be everything a publisher has published.
 * - A missing value stays missing ("not recorded"); nothing is filled in from another document.
 */
import { isSourceId, SOURCE_IDS, type DocumentStatus, type ExtractionMethod, type SourceDocument, type SourceId, type SourceKind, type SourceSearchHit } from "@/modules/official/types";
import type { OfficialStatus } from "@/modules/official/service";

export type SourcesTab = "search" | "browse" | "coverage";

export interface SourcesFilters {
  tab: SourcesTab;
  q: string;
  sources: SourceId[];
  kinds: SourceKind[];
  forum: string;
  /** ISO dates (inclusive). */
  from: string;
  to: string;
}

export const EMPTY_SOURCES_FILTERS: SourcesFilters = { tab: "search", q: "", sources: [], kinds: [], forum: "", from: "", to: "" };

export const KIND_LABEL: Record<SourceKind, string> = {
  cause_list: "Cause list",
  order: "Order",
  judgment: "Judgment",
  defect_list: "Defect list",
  calendar: "Calendar",
  regulation: "Regulation",
  circular: "Circular",
  notification: "Notification",
  gazette: "Gazette",
  minutes: "Minutes",
  parliament_question: "Parliament question",
  parliament_debate: "Parliament debate",
  committee_report: "Committee report",
  company_record: "Company record",
  dataset: "Dataset",
  reference_report: "Reference publication",
};

export const SOURCE_KINDS = Object.keys(KIND_LABEL) as SourceKind[];

export function isSourceKind(v: unknown): v is SourceKind {
  return typeof v === "string" && (SOURCE_KINDS as string[]).includes(v);
}

export function kindLabel(k: string | null | undefined): string {
  return k && isSourceKind(k) ? KIND_LABEL[k] : k ? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Document";
}

export const EXTRACTION_LABEL: Record<ExtractionMethod, string> = {
  text_layer: "PDF text layer",
  html: "Web page text",
  firecrawl_pdf: "PDF parsed (Firecrawl)",
  ocr_model: "OCR",
  dataset: "Dataset text",
};

export function extractionLabel(m: ExtractionMethod | null | undefined): string {
  return m ? EXTRACTION_LABEL[m] ?? m : "Not extracted yet";
}

export const OCR_BADGE = "Text from OCR — check the PDF";

/** True when some or all of the text came from OCR (the whole document, or listed pages). */
export function isOcrText(extraction: ExtractionMethod | null | undefined, ocrPages?: number[] | null): boolean {
  return extraction === "ocr_model" || Boolean(ocrPages && ocrPages.length);
}

/** True when a chunk's pages overlap the document's OCR pages (or the whole document is OCR). */
export function chunkFromOcr(doc: Pick<SourceDocument, "extraction" | "ocrPages">, chunk: { pageStart: number | null; pageEnd: number | null }): boolean {
  if (doc.extraction === "ocr_model") return true;
  if (!doc.ocrPages?.length || chunk.pageStart == null) return false;
  const end = chunk.pageEnd ?? chunk.pageStart;
  return doc.ocrPages.some((p) => p >= chunk.pageStart! && p <= end);
}

export const MATCH_LABEL: Record<"keyword" | "semantic" | "both", string> = {
  keyword: "Keyword match",
  semantic: "Meaning match",
  both: "Keyword and meaning",
};

export const MODE_LABEL: Record<"hybrid" | "keyword" | "semantic", string> = {
  hybrid: "Keyword and meaning (hybrid)",
  keyword: "Keyword only (no embeddings)",
  semantic: "Meaning only",
};

export const DOC_STATUS_LABEL: Record<DocumentStatus, string> = {
  discovered: "Listed, not fetched",
  fetched: "Fetched, text not extracted",
  extracted: "Text extracted, not indexed",
  ocr_needed: "Waiting for OCR",
  indexed: "Indexed",
  failed: "Failed",
  excluded: "Excluded",
};

export function docStatusLabel(s: string | null | undefined): string {
  return s && s in DOC_STATUS_LABEL ? DOC_STATUS_LABEL[s as DocumentStatus] : s ?? "Unknown";
}

/**
 * A list key for a search hit. `ref` is page-level (src://<doc>#p<page>) and up to three chunks of one document can share
 * a page, so the key is the document and chunk index, which is unique per passage.
 */
export function searchHitKey(h: Pick<SourceSearchHit, "documentId" | "chunkIndex">): string {
  return `${h.documentId}#${h.chunkIndex}`;
}

/** "p. 3", "pp. 3–5", or null when the page is not recorded. */
export function pageLabel(start: number | null | undefined, end?: number | null): string | null {
  if (start == null) return null;
  return end != null && end !== start ? `pp. ${start}–${end}` : `p. ${start}`;
}

/** Only http(s) URLs are linked. */
export function safeHttp(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function hostOf(url: string | null | undefined): string | null {
  const u = safeHttp(url);
  if (!u) return null;
  try { return new URL(u).host; } catch { return null; }
}

export function formatBytes(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-14" → "14 Sep 2026"; null when not a date. */
export function formatDocDate(d: string | null | undefined): string | null {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})/.exec(d) : null;
  if (!m) return null;
  const mo = MONTHS[Number(m[2]) - 1];
  return mo ? `${Number(m[3])} ${mo} ${m[1]}` : null;
}

/** Timestamp → "14 Sep 2026, 09:05 IST" (India time). */
export function formatFetchedAt(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const ist = new Date(d.getTime() + 330 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())} IST`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FORUM_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** Parse the /sources page URL. Unknown values are dropped, never guessed. */
export function parseSourcesFilters(sp: URLSearchParams): SourcesFilters {
  const tab = sp.get("tab");
  const list = (k: string) => sp.getAll(k).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const sources = [...new Set(list("source").filter(isSourceId))];
  const kinds = [...new Set(list("kind").filter(isSourceKind))];
  const forum = (sp.get("forum") ?? "").trim().toLowerCase();
  let from = (sp.get("from") ?? "").trim();
  let to = (sp.get("to") ?? "").trim();
  if (!ISO_DATE.test(from)) from = "";
  if (!ISO_DATE.test(to)) to = "";
  if (from && to && from > to) [from, to] = [to, from];
  const q = (sp.get("q") ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300);
  return {
    tab: tab === "browse" || tab === "coverage" ? tab : "search",
    q,
    sources: SOURCE_IDS.filter((s) => sources.includes(s)),
    kinds,
    forum: FORUM_RE.test(forum) ? forum : "",
    from,
    to,
  };
}

/** Page URL params (only non-default values). */
export function sourcesFiltersToParams(f: SourcesFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.tab !== "search") sp.set("tab", f.tab);
  if (f.q) sp.set("q", f.q);
  for (const s of f.sources) sp.append("source", s);
  for (const k of f.kinds) sp.append("kind", k);
  if (f.forum) sp.set("forum", f.forum);
  if (f.from) sp.set("from", f.from);
  if (f.to) sp.set("to", f.to);
  return sp;
}

export function hasSourceFilters(f: SourcesFilters): boolean {
  return Boolean(f.sources.length || f.kinds.length || f.forum || f.from || f.to);
}

/** /api/official/search query string (null when there is nothing to search for). */
export function searchApiQuery(f: SourcesFilters, limit = 30): string | null {
  if (f.q.trim().length < 2) return null;
  const sp = new URLSearchParams({ q: f.q.trim() });
  for (const s of f.sources) sp.append("source", s);
  for (const k of f.kinds) sp.append("kind", k);
  if (f.forum) sp.set("forum", f.forum);
  if (f.from) sp.set("from", f.from);
  if (f.to) sp.set("to", f.to);
  sp.set("limit", String(Math.max(1, Math.min(50, limit))));
  return sp.toString();
}

/** /api/official/documents query string (browse, newest first; `q` narrows by title). */
export function listApiQuery(f: SourcesFilters, cursor: string | null, limit = 50): string {
  const sp = new URLSearchParams();
  for (const s of f.sources) sp.append("source", s);
  for (const k of f.kinds) sp.append("kind", k);
  if (f.forum) sp.set("forum", f.forum);
  if (f.q.trim()) sp.set("q", f.q.trim());
  if (f.from) sp.set("from", f.from);
  if (f.to) sp.set("to", f.to);
  if (cursor) sp.set("cursor", cursor);
  sp.set("limit", String(Math.max(1, Math.min(100, limit))));
  return sp.toString();
}

/**
 * A return path for the document reader's back link (?from=), or null. Only a path on this site is accepted
 * ("/sources?tab=browse&q=x", "/cases/sc:1"): never another origin, a protocol-relative URL or control characters.
 */
export function safeReturnPath(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s || s.length > 800 || !/^\/[A-Za-z]/.test(s) || /[\\\u0000-\u001f]/.test(s)) return null;
  try {
    const u = new URL(s, "https://return.invalid");
    return u.origin === "https://return.invalid" ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

/** What the reader's back link says for a return path. */
export function returnLabel(path: string | null | undefined): string {
  const p = path ?? "/sources";
  if (p === "/sources" || p.startsWith("/sources?") || p.startsWith("/sources/")) return "Official sources";
  if (p.startsWith("/cases/")) return "Case record";
  if (p.startsWith("/tools")) return "Practice tools";
  return "Back";
}

/**
 * /sources/<id>[?page=n | ?chunk=n][&from=<return path>] — the document reader. `from` is the page to return to (the
 * library with its query and filters, a case record, the tools); it is dropped unless it is a path on this site.
 */
export function sourceDocHref(id: string, at?: { page?: number | null; chunk?: number | null }, from?: string | null): string {
  const base = `/sources/${encodeURIComponent(id)}`;
  const sp = new URLSearchParams();
  if (at?.page != null) sp.set("page", String(at.page));
  else if (at?.chunk != null) sp.set("chunk", String(at.chunk));
  const back = safeReturnPath(from);
  if (back) sp.set("from", back);
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

/** /api/official/documents/<id> with the reading position. */
export function documentApiHref(id: string, at: { page?: number | null; fromChunk?: number | null; maxChars?: number } = {}): string {
  const sp = new URLSearchParams();
  if (at.page != null) sp.set("page", String(at.page));
  else if (at.fromChunk != null) sp.set("fromChunk", String(at.fromChunk));
  sp.set("maxChars", String(at.maxChars ?? 60_000));
  return `/api/official/documents/${encodeURIComponent(id)}?${sp}`;
}

/** Document id from the catch-all route param (decoded; null when it does not look like one). */
export function sourceDocIdFromParam(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw.join("/") : raw;
  if (!v) return null;
  let id = v;
  try { id = decodeURIComponent(v); } catch { /* keep raw */ }
  id = id.trim();
  return /^[A-Za-z0-9_.:-]{6,160}$/.test(id) ? id : null;
}

/** Positive integer from a query value, or null. */
export function positiveInt(v: string | null | undefined, max = 100_000): number | null {
  if (!v || !/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface CoverageRow {
  id: SourceId;
  name: string;
  publisher: string;
  forum: string | null;
  enabled: boolean;
  kinds: SourceKind[];
  documents: number;
  indexed: number;
  embedded: number;
  chunks: number;
  failed: number;
  waiting: number;
  ocrNeeded: number;
  lastDiscoveredAt: string | null;
  lastIndexedAt: string | null;
  lastError: string | null;
  notes: string[];
  homepage: string | null;
}

export const COVERAGE_NOTE = "Counts are what has been collected from each publisher so far. They do not show how much a publisher has published, and a source with few documents may simply not have been collected yet.";

/** One row per registered source, in registry order; counts read as given (missing counts are 0, never estimated). */
export function coverageRows(status: Pick<OfficialStatus, "sources">): CoverageRow[] {
  const order = new Map(SOURCE_IDS.map((s, i) => [s, i]));
  return status.sources
    .map((s) => {
      const by = s.stats?.byStatus ?? {};
      const n = (k: DocumentStatus) => (typeof by[k] === "number" ? (by[k] as number) : 0);
      return {
        id: s.id,
        name: s.name,
        publisher: s.publisher,
        forum: s.forum ?? null,
        enabled: s.enabled,
        kinds: s.kinds ?? [],
        documents: s.stats?.documents ?? 0,
        indexed: n("indexed"),
        embedded: s.stats?.embedded ?? 0,
        chunks: s.stats?.chunks ?? 0,
        failed: n("failed"),
        waiting: n("discovered") + n("fetched") + n("extracted"),
        ocrNeeded: n("ocr_needed"),
        lastDiscoveredAt: s.stats?.lastDiscoveredAt ?? null,
        lastIndexedAt: s.stats?.lastIndexedAt ?? null,
        lastError: s.stats?.lastError ?? null,
        notes: s.notes ?? [],
        homepage: safeHttp(s.homepage),
      };
    })
    .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}

/** The latest of the two run timestamps (ISO strings compare lexically). */
export function lastRunOf(r: Pick<CoverageRow, "lastDiscoveredAt" | "lastIndexedAt">): string | null {
  const xs = [r.lastDiscoveredAt, r.lastIndexedAt].filter((x): x is string => Boolean(x)).sort();
  return xs.length ? xs[xs.length - 1] : null;
}

/** Forum keys present in the registry (for the filter rail), with a label from the sources that carry them. */
export function forumOptions(status: Pick<OfficialStatus, "sources"> | null): { forum: string; label: string }[] {
  if (!status) return [];
  const seen = new Map<string, string>();
  for (const s of status.sources) if (s.forum && !seen.has(s.forum)) seen.set(s.forum, s.publisher);
  return [...seen.entries()].map(([forum, label]) => ({ forum, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Total corpus size line ("1.2 GB of 9 GB budget"); null when not reported. */
export function storageLine(s: Pick<OfficialStatus, "dbBytes" | "limitBytes">): string | null {
  const used = formatBytes(s.dbBytes);
  if (!used) return null;
  const limit = formatBytes(s.limitBytes);
  return limit ? `${used} of ${limit} storage budget` : `${used} stored`;
}
