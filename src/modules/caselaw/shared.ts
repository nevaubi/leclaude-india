/**
 * Case law directory: shared (client-safe) contracts and pure helpers. The server side lives in
 * `src/modules/india/corpus/directory.ts`; the routes are `/api/cases`, `/api/cases/facets` and `/api/cases/<id>`.
 *
 * Counts are counts of corpus records. A record is one dataset record keyed by the dataset's own identity; the Supreme
 * Court dataset lists some judgments under two adjacent yearly archives, and those are stored once (same key), so a
 * record count is not inflated by them. Records from other datasets that describe the same case (same CNR or neutral
 * citation) are shown as separate, labelled records, never merged.
 */

export type CaseSort = "newest" | "oldest" | "relevance";

/** exact: identifier (CNR, neutral citation, case number) match; text: all words matched; partial: some words; browse: no query. */
export type CaseMatch = "exact" | "text" | "partial" | "browse";

export interface CaseHit {
  id: string;
  source: string;
  title: string;
  court_id: string | null;
  /** Registry name for court_id; null when the court is unmapped (court_code carries the raw dataset code). */
  court: string | null;
  court_code: string | null;
  bench_id: string | null;
  bench_code: string | null;
  bench_strength: number | null;
  year: number | null;
  decision_date: string | null;
  case_number: string | null;
  cnr: string | null;
  neutral_citation: string | null;
  reporter_citation: string | null;
  judges: string[];
  disposal: string | null;
  pdf_url: string | null;
  snippet: string | null;
  text_status: string;
  issues: string[] | null;
  match: CaseMatch;
}

export interface CaseListResponse {
  mode: "search" | "browse";
  sort: CaseSort;
  hits: CaseHit[];
  hasMore: boolean;
  /** Opaque; pass back as `cursor` for the next page. */
  nextCursor: string | null;
  tookMs: number;
}

export interface CourtFacet {
  /** Filter value: a registry court id, or `code:<dataset code>` for an unmapped court. */
  key: string;
  courtId: string | null;
  courtCode: string | null;
  name: string;
  level: "supreme" | "high" | "unmapped";
  records: number;
  minDate: string | null;
  maxDate: string | null;
  minYear: number | null;
  maxYear: number | null;
  years: { year: number | null; records: number }[];
  /** Source archives queued for this court and how many are fully stored (null when none are recorded). */
  archives: { done: number; total: number } | null;
}

/**
 * A court as the filter and the coverage cards offer it. Mapped courts are one facet each; every unmapped court code is
 * merged into one "Other courts" option (codes are internal and several codes would otherwise look like duplicate
 * rows). `keys` are the filter values the option selects: all of them together.
 */
export interface CourtOption extends CourtFacet {
  keys: string[];
}

/** Display name of the merged option for courts the source does not identify. */
export const OTHER_COURTS_LABEL = "Other courts";

function extreme<T extends number | string>(vals: (T | null)[], which: "min" | "max"): T | null {
  let out: T | null = null;
  for (const v of vals) if (v != null && (out == null || (which === "min" ? v < out : v > out))) out = v;
  return out;
}

export function courtFacetShortName(c: CourtFacet | undefined): string | null {
  if (!c) return null;
  if (c.level === "supreme") return "Supreme Court";
  if (c.level === "unmapped") return OTHER_COURTS_LABEL;
  return courtShortName(c.name);
}

/** "High Court of Karnataka" → "Karnataka HC"; names in another form ("Gauhati High Court") are kept. */
export function courtShortName(name: string): string {
  const m = /^High Court (?:of Judicature at|for the State of|of|at) (.+)$/.exec(name);
  return m ? `${m[1]} HC` : name;
}

/**
 * Trigger label: "All courts", one court's short name, or "N courts", counting the merged "Other courts" option once.
 * A selected value with no matching option (a stale link) counts as one court; an unmapped code is never shown raw.
 */
export function filterLabel(options: CourtOption[], value: string[]): string {
  if (!value.length) return "All courts";
  const picked = options.filter((o) => o.keys.some((k) => value.includes(k)));
  const known = new Set(options.flatMap((o) => o.keys));
  const unknown = value.filter((v) => !known.has(v));
  const strayOther = unknown.some((v) => v.startsWith("code:")) && !picked.some((o) => o.level === "unmapped");
  const strayIds = unknown.filter((v) => !v.startsWith("code:"));
  const n = picked.length + strayIds.length + (strayOther ? 1 : 0);
  if (n === 1) return picked.length ? courtFacetShortName(picked[0]) ?? picked[0].name : strayOther ? OTHER_COURTS_LABEL : strayIds[0];
  return `${n} courts`;
}

/** Facets → options, in facet order, with all unmapped codes merged into one option placed last. Pure. */
export function courtOptions(courts: CourtFacet[] | null | undefined): CourtOption[] {
  const list = courts ?? [];
  const out: CourtOption[] = list.filter((c) => c.level !== "unmapped").map((c) => ({ ...c, keys: [c.key] }));
  const other = list.filter((c) => c.level === "unmapped");
  if (!other.length) return out;
  const years = new Map<number | null, number>();
  for (const c of other) for (const y of c.years) years.set(y.year, (years.get(y.year) ?? 0) + y.records);
  const archives = other.some((c) => c.archives)
    ? other.reduce((a, c) => ({ done: a.done + (c.archives?.done ?? 0), total: a.total + (c.archives?.total ?? 0) }), { done: 0, total: 0 })
    : null;
  out.push({
    key: other.length === 1 ? other[0].key : "other",
    keys: other.map((c) => c.key),
    courtId: null,
    courtCode: null,
    name: OTHER_COURTS_LABEL,
    level: "unmapped",
    records: other.reduce((n, c) => n + c.records, 0),
    minDate: extreme(other.map((c) => c.minDate), "min"),
    maxDate: extreme(other.map((c) => c.maxDate), "max"),
    minYear: extreme(other.map((c) => c.minYear), "min"),
    maxYear: extreme(other.map((c) => c.maxYear), "max"),
    years: [...years.entries()].map(([year, records]) => ({ year, records })).sort((a, b) => (b.year ?? -1) - (a.year ?? -1)),
    archives,
  });
  return out;
}

export interface CaseFacets {
  total: number;
  courts: CourtFacet[];
  disposals: { value: string; records: number }[];
  lastIngestedAt: string | null;
  computedAt: string;
  /** True when the facets are an older cached copy because recomputing failed. */
  stale?: boolean;
}

export interface SourceRegistryEntry {
  source: string;
  registered: boolean;
  name: string;
  /** Dataset identifier in its registry. */
  dataset: string | null;
  /** Who publishes the underlying judgments. */
  publisher: string;
  /** Where the dataset is hosted and described. */
  host: string | null;
  registryUrl: string | null;
  bucketUrl: string | null;
  licence: string;
  licenceUrl: string | null;
  coverage: string | null;
}

export interface CaseTranslation { language: string; origin: string | null; url: string | null }

export interface CaseUnit {
  id: string;
  source: string | null;
  year: number | null;
  courtCode: string | null;
  benchCode: string | null;
  folder: string | null;
  objectKey: string | null;
  /** Public URL of the source archive object, when the bucket is known. */
  archiveUrl: string | null;
  status: string | null;
  expected: number | null;
  stored: number | null;
  rejected: number | null;
  note: string | null;
  finishedAt: string | null;
}

export interface CaseRecord extends Omit<CaseHit, "match"> {
  unit_id: string;
  dataset_key: string;
  petitioner: string | null;
  respondent: string | null;
  case_type: string | null;
  author: string | null;
  registration_date: string | null;
  language: string | null;
  translations: CaseTranslation[];
  pdf_key: string | null;
  record_sha256: string;
  ingested_at: string | null;
  updated_at: string | null;
  bench: string | null;
  unit: CaseUnit | null;
  sourceInfo: SourceRegistryEntry;
}

export interface SameCaseRecord extends CaseHit {
  reasons: ("cnr" | "neutral_citation")[];
}

export interface CaseRecordResponse {
  record: CaseRecord;
  sameCase: SameCaseRecord[];
}

// ---------------------------------------------------------------------------
// Parameters (shared by the page URL and the API URL)
// ---------------------------------------------------------------------------

export interface CaseFilters {
  q: string;
  courts: string[];
  yearFrom?: number;
  yearTo?: number;
  judge: string;
  disposal: string;
  sort: CaseSort;
}

export const PAGE_SIZE = 50;
export const MIN_YEAR = 1947;
export const MAX_YEAR = 2100;
const COURT_KEY_RE = /^(code:)?[a-z0-9][a-z0-9_~-]{0,39}$/i;

function intIn(v: string | null, lo: number, hi: number): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n);
  return i < lo || i > hi ? undefined : i;
}

const clip = (v: string | null, max: number) => (v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

/** Parse and clamp directory filters from a query string (page or API). Unknown values are dropped, never guessed. */
export function parseCaseFilters(sp: URLSearchParams): CaseFilters {
  const courts = Array.from(new Set(sp.getAll("court").flatMap((c) => c.split(",")).map((c) => c.trim()).filter((c) => COURT_KEY_RE.test(c)))).slice(0, 80);
  let yearFrom = intIn(sp.get("from"), MIN_YEAR, MAX_YEAR);
  let yearTo = intIn(sp.get("to"), MIN_YEAR, MAX_YEAR);
  if (yearFrom && yearTo && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];
  const q = clip(sp.get("q"), 200);
  const s = sp.get("sort");
  const sort: CaseSort = s === "newest" || s === "oldest" || s === "relevance" ? s : q ? "relevance" : "newest";
  return { q, courts, yearFrom, yearTo, judge: clip(sp.get("judge"), 80), disposal: clip(sp.get("disposal"), 60), sort };
}

/** Serialise filters (only non-default values) for the page URL and the API. */
export function caseFiltersToParams(f: CaseFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.q) sp.set("q", f.q);
  for (const c of f.courts) sp.append("court", c);
  if (f.yearFrom) sp.set("from", String(f.yearFrom));
  if (f.yearTo) sp.set("to", String(f.yearTo));
  if (f.judge) sp.set("judge", f.judge);
  if (f.disposal) sp.set("disposal", f.disposal);
  const defaultSort: CaseSort = f.q ? "relevance" : "newest";
  if (f.sort !== defaultSort) sp.set("sort", f.sort);
  return sp;
}

export function hasActiveFilters(f: CaseFilters): boolean {
  return Boolean(f.q || f.courts.length || f.yearFrom || f.yearTo || f.judge || f.disposal);
}

/** Record ids contain ":" and "/" (dataset keys); each path segment is encoded so the id round-trips through a catch-all route. */
export function caseHref(id: string): string {
  return `/cases/${id.split("/").map(encodeURIComponent).join("/")}`;
}

export function caseApiHref(id: string): string {
  return `/api/cases/${id.split("/").map(encodeURIComponent).join("/")}`;
}

/** Join catch-all route segments back into a record id (segments may arrive encoded or decoded). */
export function caseIdFromSegments(segments: string[] | string | undefined): string | null {
  const parts = Array.isArray(segments) ? segments : segments ? [segments] : [];
  if (!parts.length) return null;
  const decoded = parts.map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const id = decoded.join("/");
  return id.length > 0 && id.length <= 400 && /^(sc|hc):/.test(id) && !/[\u0000-\u001f]/.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2024-08-07" → "7 Aug 2024" (no time zone conversion: decision dates are calendar dates). */
export function formatCaseDate(d: string | null | undefined): string | null {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})/.exec(d) : null;
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

/** Timestamps → "7 Aug 2024, 14:05 UTC". */
export function formatTimestamp(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function urlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.host : null;
  } catch {
    return null;
  }
}

/** A year span "1950–2026" or a single year. */
export function yearSpan(a: number | null | undefined, b: number | null | undefined): string | null {
  if (!a && !b) return null;
  if (!a || !b || a === b) return String(a || b);
  const sa = String(a), sb = String(b);
  return sa.slice(0, 2) === sb.slice(0, 2) && sa.slice(0, 3) === sb.slice(0, 3) && a >= 2000 ? `${sa}–${sb.slice(2)}` : `${sa}–${sb}`;
}

export const MATCH_LABEL: Record<CaseMatch, string> = {
  exact: "Exact identifier",
  text: "All words",
  partial: "Some words",
  browse: "",
};
