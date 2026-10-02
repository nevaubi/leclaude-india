/**
 * Statutes directory (Indian law corpus): shared, client-safe contracts and pure helpers. The server side lives in
 * `src/modules/india/law/**`; the routes are `/api/law`, `/api/law/facets`, `/api/law/search` and `/api/law/<id>`.
 *
 * The corpus is Open India Law (Vaquill), a third-party section-level parse of India Code and regulator publications,
 * licensed CC BY 4.0. It is never presented as the official text: every instrument and section carries the publisher's
 * own page (`source_url`), the dataset attribution and version, and the status recorded by the dataset.
 *
 * A "section" is every provision row with the same (act_id, section_number, variant), concatenated in statutory order.
 * `variant` > 0 marks a second provision printed with the same number in the dataset (kept separate, never merged).
 * Provisions without a section number (preamble, schedules, unnumbered text) use the section key `_`.
 */

export type LawJurisdiction = "central" | "state" | "regulator";
/** "report": Law Commission reports and similar material in the dataset; context, not law. */
export type LawKind = "act" | "regulation" | "report";
export type LawStatusFilter = "in_force" | "not_in_force" | "all";
export type LawSearchMode = "acts" | "sections";
export type LawSort = "relevance" | "title" | "newest" | "oldest";

/** Section key for provisions that carry no section number (preamble, schedules, unnumbered text). */
export const NO_SECTION = "_";

export const LAW_DATASET = {
  name: "Open India Law",
  publisher: "Vaquill",
  licence: "CC BY 4.0",
  licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Open India Law (Vaquill), CC BY 4.0 — third-party parse; verify against the official text",
} as const;

/** The one quiet attribution line shown on pages that display statute text. */
export const LAW_ATTRIBUTION_LINE = "Text: Open India Law (CC BY 4.0), compiled from India Code and regulator publications. The official text is authoritative.";

export interface LawInstrument {
  id: string;
  kind: string;
  title: string;
  jurisdiction: string;
  state: string | null;
  state_code: string | null;
  regulator: string | null;
  publisher: string | null;
  year: number | null;
  status: string | null;
  amendment_count: number | null;
  source_url: string | null;
  mirror_url: string | null;
  provisions: number;
  sections: number;
  subjects: string[];
  dataset_file: string;
  dataset_version: string;
}

export interface LawInstrumentHit extends LawInstrument {
  /** Full-text rank for searches; absent when browsing. */
  rank?: number;
}

export interface LawListResponse {
  mode: "search" | "browse";
  sort: LawSort;
  hits: LawInstrumentHit[];
  hasMore: boolean;
  nextCursor: string | null;
  tookMs: number;
}

export interface LawTocEntry {
  /** Section key: the number as printed ("303", "10A") or NO_SECTION. */
  section: string;
  variant: number;
  ord: number;
  heading: string | null;
  chapter: string | null;
  chapter_title: string | null;
  parts: number;
}

export interface LawToc {
  entries: LawTocEntry[];
  total: number;
  offset: number;
  hasMore: boolean;
}

export interface LawInstrumentResponse {
  instrument: LawInstrument;
  toc: LawToc;
}

export interface LawSectionRef { section: string; variant: number }

export interface LawSection {
  actId: string;
  section: string;
  variant: number;
  heading: string | null;
  chapter: string | null;
  chapter_title: string | null;
  section_type: string | null;
  provision_type: string | null;
  status: string | null;
  in_force: boolean | null;
  has_proviso: boolean;
  has_non_obstante: boolean;
  defined_terms: string[];
  acts_referenced: string[];
  /** Readable plain text (light markdown from the dataset removed; words untouched). */
  text: string;
  /** True when the section was longer than the page bound and the text stops early. */
  truncated: boolean;
  chars: number;
  source_url: string | null;
  provisionIds: string[];
  ord: number;
}

export interface LawSectionResponse {
  instrument: LawInstrument;
  section: LawSection;
  /** Other variants printed with the same section number in this instrument (never merged into this one). */
  variants: number[];
  prev: LawSectionRef | null;
  next: LawSectionRef | null;
  citation: string;
}

export interface LawProvisionHit {
  actId: string;
  actTitle: string;
  kind: string;
  jurisdiction: string;
  state: string | null;
  state_code: string | null;
  regulator: string | null;
  year: number | null;
  instrumentStatus: string | null;
  section: string;
  variant: number;
  heading: string | null;
  chapter_title: string | null;
  in_force: boolean | null;
  /** Plain text; matched words are wrapped in « ». */
  snippet: string;
  rank: number;
  source_url: string | null;
  dataset_version: string;
}

export interface LawSearchResponse {
  hits: LawProvisionHit[];
  hasMore: boolean;
  nextOffset: number | null;
  tookMs: number;
  /** True when no provision matched every word and the results match any of the significant words instead. */
  broadened?: boolean;
}

export interface LawDatasetRow {
  file: string;
  version: string;
  kind: string;
  jurisdiction: string;
  label: string;
  rows_in_file: number;
  rows_stored: number;
  rows_skipped: number;
  instruments: number;
  status: string;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface LawFacets {
  total: number;
  sections: number;
  jurisdictions: { value: string; instruments: number; sections: number }[];
  states: { code: string; name: string; instruments: number }[];
  regulators: { value: string; label: string; instruments: number }[];
  statuses: { value: string | null; instruments: number }[];
  minYear: number | null;
  maxYear: number | null;
  datasets: LawDatasetRow[];
  /** Dataset version(s) loaded. */
  versions: string[];
  computedAt: string;
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// Parameters (shared by the page URL and the API URL)
// ---------------------------------------------------------------------------

export interface LawFilters {
  q: string;
  mode: LawSearchMode;
  jurisdiction: LawJurisdiction | "";
  state: string;
  regulator: string;
  status: LawStatusFilter;
  kind: LawKind | "";
  yearFrom?: number;
  yearTo?: number;
  sort: LawSort;
}

export const LAW_PAGE_SIZE = 50;
export const LAW_MIN_YEAR = 1800;
export const LAW_MAX_YEAR = 2100;
export const TOC_PAGE_SIZE = 300;

const STATE_RE = /^[A-Z]{2,3}$/;
const REGULATOR_RE = /^[a-z][a-z0-9-]{1,39}$/;
const ACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9 .()\-–/]{0,39}$/;

function intIn(v: string | null, lo: number, hi: number): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n);
  return i < lo || i > hi ? undefined : i;
}

const clip = (v: string | null, max: number) => (v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

export const isLawJurisdiction = (v: unknown): v is LawJurisdiction => v === "central" || v === "state" || v === "regulator";
export const normStateCode = (v: unknown): string => (typeof v === "string" && STATE_RE.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : "");
export const normRegulator = (v: unknown): string => (typeof v === "string" && REGULATOR_RE.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : "");
export const isLawActId = (v: unknown): v is string => typeof v === "string" && ACT_ID_RE.test(v);

/** A section key as accepted from a URL or a tool: the printed number, or NO_SECTION. Anything else is rejected (null). */
export function normSectionKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^(?:section|sec\.?|s\.|regulation|reg\.?|rule|r\.)\s*/i, "").trim();
  if (s === NO_SECTION) return NO_SECTION;
  return SECTION_RE.test(s) ? s : null;
}

export function normVariant(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : 0;
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : 0;
}

/** Parse and clamp directory filters from a query string (page or API). Unknown values are dropped, never guessed. */
export function parseLawFilters(sp: URLSearchParams): LawFilters {
  const q = clip(sp.get("q"), 200);
  const j = sp.get("j");
  const jurisdiction = isLawJurisdiction(j) ? j : "";
  const state = jurisdiction === "state" || !jurisdiction ? normStateCode(sp.get("state")) : "";
  const regulator = jurisdiction === "regulator" || !jurisdiction ? normRegulator(sp.get("reg")) : "";
  const st = sp.get("status");
  const status: LawStatusFilter = st === "all" || st === "not_in_force" ? st : "in_force";
  const k = sp.get("kind");
  const kind = k === "act" || k === "regulation" || k === "report" ? k : "";
  let yearFrom = intIn(sp.get("from"), LAW_MIN_YEAR, LAW_MAX_YEAR);
  let yearTo = intIn(sp.get("to"), LAW_MIN_YEAR, LAW_MAX_YEAR);
  if (yearFrom && yearTo && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];
  const mode: LawSearchMode = sp.get("mode") === "sections" ? "sections" : "acts";
  const s = sp.get("sort");
  const sort: LawSort = s === "relevance" || s === "title" || s === "newest" || s === "oldest" ? s : q ? "relevance" : "title";
  return {
    q, mode, jurisdiction: state && !jurisdiction ? "state" : regulator && !jurisdiction ? "regulator" : jurisdiction,
    state, regulator, status, kind, yearFrom, yearTo, sort: sort === "relevance" && !q ? "title" : sort,
  };
}

/** Serialise filters (only non-default values) for the page URL and the API. */
export function lawFiltersToParams(f: LawFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.q) sp.set("q", f.q);
  if (f.mode === "sections") sp.set("mode", "sections");
  if (f.jurisdiction) sp.set("j", f.jurisdiction);
  if (f.state) sp.set("state", f.state);
  if (f.regulator) sp.set("reg", f.regulator);
  if (f.status !== "in_force") sp.set("status", f.status);
  if (f.kind) sp.set("kind", f.kind);
  if (f.yearFrom) sp.set("from", String(f.yearFrom));
  if (f.yearTo) sp.set("to", String(f.yearTo));
  const defaultSort: LawSort = f.q ? "relevance" : "title";
  if (f.sort !== defaultSort) sp.set("sort", f.sort);
  return sp;
}

export function hasActiveLawFilters(f: LawFilters): boolean {
  return Boolean(f.q || f.jurisdiction || f.state || f.regulator || f.status !== "in_force" || f.kind || f.yearFrom || f.yearTo);
}

// ---------------------------------------------------------------------------
// Links and stable sources
// ---------------------------------------------------------------------------

/** /law/<actId>[?s=<section>[&v=<variant>]] */
export function lawHref(actId: string, section?: string | null, variant?: number): string {
  const base = `/law/${encodeURIComponent(actId)}`;
  if (!section) return base;
  return `${base}?s=${encodeURIComponent(section)}${variant ? `&v=${variant}` : ""}`;
}

export function lawApiHref(actId: string, opts: { section?: string | null; variant?: number; tocOffset?: number } = {}): string {
  const sp = new URLSearchParams();
  if (opts.section) sp.set("section", opts.section);
  if (opts.section && opts.variant) sp.set("variant", String(opts.variant));
  if (opts.tocOffset) sp.set("tocOffset", String(opts.tocOffset));
  const qs = sp.toString();
  return `/api/law/${encodeURIComponent(actId)}${qs ? `?${qs}` : ""}`;
}

/** Stable, server-resolvable evidence source: law://<actId>/s/<section>[~<variant>] (or law://<actId> for the instrument). */
export function lawSourceId(actId: string, section?: string | null, variant = 0): string {
  if (!section) return `law://${encodeURIComponent(actId)}`;
  return `law://${encodeURIComponent(actId)}/s/${encodeURIComponent(section)}${variant ? `~${variant}` : ""}`;
}

/** Parse a law:// source back into its parts (null when it is not one). */
export function parseLawSourceId(src: string): { actId: string; section: string | null; variant: number } | null {
  const m = /^law:\/\/([^/]+)(?:\/s\/([^~/]+)(?:~(\d+))?)?$/.exec(src);
  if (!m) return null;
  try {
    const actId = decodeURIComponent(m[1]);
    const section = m[2] ? normSectionKey(decodeURIComponent(m[2])) : null;
    if (!isLawActId(actId) || (m[2] && !section)) return null;
    return { actId, section, variant: normVariant(m[3] ?? 0) };
  } catch {
    return null;
  }
}

/** Join catch-all route segments into an instrument id (null when it is not a valid id). */
export function lawIdFromSegments(segments: string[] | string | undefined): string | null {
  const parts = Array.isArray(segments) ? segments : segments ? [segments] : [];
  if (parts.length !== 1) return null;
  let id = parts[0];
  try { id = decodeURIComponent(id); } catch { /* keep raw */ }
  return isLawActId(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const REGULATOR_LABEL: Record<string, string> = {
  sebi: "SEBI", rbi: "RBI", mca: "MCA", cbic: "CBIC", irdai: "IRDAI", trai: "TRAI", dgft: "DGFT", cpcb: "CPCB",
  dfs: "Department of Financial Services", moefcc: "MoEFCC", "law-commission": "Law Commission of India", "state-gst": "State GST",
};

export function regulatorLabel(v: string | null | undefined): string | null {
  if (!v) return null;
  return REGULATOR_LABEL[v] ?? v.toUpperCase();
}

export function jurisdictionLabel(i: Pick<LawInstrument, "jurisdiction" | "state" | "state_code" | "regulator">): string {
  if (i.jurisdiction === "central") return "Central";
  if (i.jurisdiction === "state") return i.state ?? (i.state_code ? `State (${i.state_code})` : "State");
  if (i.jurisdiction === "regulator") return regulatorLabel(i.regulator) ?? "Regulator";
  return i.jurisdiction;
}

export const STATUS_LABEL: Record<string, string> = {
  in_force: "In force", repealed: "Repealed", spent: "Spent", superseded: "Superseded", omitted: "Omitted", expired: "Expired",
  lapsed: "Lapsed", not_in_force: "Not in force", report: "Report (not law)", partially_in_force: "Partly in force", amended: "Amended", rescinded: "Rescinded",
};

export function statusLabel(s: string | null | undefined): string {
  if (!s) return "Status not recorded";
  return STATUS_LABEL[s] ?? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** in_force → ok; repealed/spent/superseded/omitted/expired/lapsed/rescinded → off; anything else → unknown. */
export function statusTone(s: string | null | undefined): "ok" | "off" | "unknown" {
  if (s === "in_force") return "ok";
  if (s && /^(repealed|spent|superseded|omitted|expired|lapsed|rescinded|not_in_force)$/.test(s)) return "off";
  return "unknown";
}

const PUBLISHER_HOSTS: [RegExp, string][] = [
  [/(^|\.)indiacode\.nic\.in$/, "India Code (Legislative Department)"],
  [/(^|\.)legislative\.gov\.in$/, "Legislative Department"],
  [/(^|\.)egazette\.(gov|nic)\.in$/, "e-Gazette of India"],
  [/(^|\.)sebi\.gov\.in$/, "SEBI"],
  [/(^|\.)rbi\.org\.in$/, "RBI"],
  [/(^|\.)mca\.gov\.in$/, "MCA"],
  [/(^|\.)cbic(-gst)?\.gov\.in$/, "CBIC"],
  [/(^|\.)irdai\.gov\.in$/, "IRDAI"],
  [/(^|\.)trai\.gov\.in$/, "TRAI"],
  [/(^|\.)dgft\.gov\.in$/, "DGFT"],
  [/(^|\.)cpcb\.nic\.in$/, "CPCB"],
  [/(^|\.)financialservices\.gov\.in$/, "Department of Financial Services"],
  [/(^|\.)(moef|moefcc|parivesh)\.(gov|nic)\.in$/, "MoEFCC"],
  [/(^|\.)lawcommissionofindia\.nic\.in$/, "Law Commission of India"],
];

export function urlHostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Only http(s) URLs are linked. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  return urlHostOf(url) ? (url as string) : null;
}

/** Who publishes the official text behind `source_url` ("India Code (Legislative Department)", "SEBI", …). */
export function publisherLabel(i: Pick<LawInstrument, "source_url" | "regulator" | "publisher">): string {
  const host = urlHostOf(i.source_url);
  if (host) for (const [re, label] of PUBLISHER_HOSTS) if (re.test(host)) return label;
  return i.publisher || regulatorLabel(i.regulator) || host || "the publisher";
}

/** "The Bharatiya Nyaya Sanhita, 2023" → "Bharatiya Nyaya Sanhita, 2023" (adds ", <year>" when the title has none). */
export function citationTitle(i: Pick<LawInstrument, "title" | "year">): string {
  const t = i.title.replace(/\s+/g, " ").trim().replace(/^the\s+/i, "");
  return i.year && !/\b(1[6-9]|20|21)\d{2}\b/.test(t) ? `${t}, ${i.year}` : t;
}

/** The unit a provision is cited by: Section for Acts; Rule / Regulation for subordinate instruments; Clause otherwise. */
export function provisionUnit(i: Pick<LawInstrument, "kind" | "title">): string {
  if (i.kind !== "regulation") return "Section";
  if (/\bRules\b/i.test(i.title)) return "Rule";
  if (/\bRegulations?\b/i.test(i.title)) return "Regulation";
  return "Clause";
}

/** "Section 303, Bharatiya Nyaya Sanhita, 2023" / "Preamble and unnumbered text, …". */
export function lawCitation(i: Pick<LawInstrument, "kind" | "title" | "year">, section: string, variant = 0): string {
  const name = citationTitle(i);
  if (section === NO_SECTION) return `Unnumbered provisions, ${name}`;
  return `${provisionUnit(i)} ${section}${variant ? ` (variant ${variant + 1} in the dataset)` : ""}, ${name}`;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** Plain-English label for a repeated provision number: variant 1 → "second provision numbered 14". */
export function repeatedProvisionLabel(i: Pick<LawInstrument, "kind" | "title">, section: string, variant: number): string {
  const nth = ORDINALS[variant] ?? `${variant + 1}th`;
  return `${nth} ${provisionUnit(i).toLowerCase()} numbered ${section}`;
}

/**
 * User-facing citation: like lawCitation, but a repeated provision number reads "(second provision so numbered)"
 * rather than exposing the internal variant index.
 */
export function displayLawCitation(i: Pick<LawInstrument, "kind" | "title" | "year">, section: string, variant = 0): string {
  const name = citationTitle(i);
  if (section === NO_SECTION) return `Unnumbered provisions, ${name}`;
  const nth = variant ? ` (${ORDINALS[variant] ?? `${variant + 1}th`} so numbered)` : "";
  return `${provisionUnit(i)} ${section}${nth}, ${name}`;
}

/** Display-only: rewrite a stored citation's "(variant N in the dataset)" as "(Nth so numbered)". */
export function humanizeCitation(cite: string): string {
  return cite.replace(/ \(variant (\d+) in the dataset\)/g, (_m, n: string) => {
    const k = Number(n) - 1;
    return ` (${ORDINALS[k] ?? `${n}th`} so numbered)`;
  });
}

/** TOC label: "303. Organised crime" / "Preamble". */
export function tocLabel(e: Pick<LawTocEntry, "section" | "heading">): string {
  if (e.section === NO_SECTION) return e.heading || "Preamble and unnumbered text";
  return e.heading ? `${e.section}. ${e.heading}` : e.section;
}

/**
 * Light markdown in the dataset's text → readable plain text. Only markers are removed (emphasis asterisks and
 * underscores, "> " quote prefixes, "#" heading marks, backslash escapes); words and punctuation are never changed.
 */
export function cleanLawText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\(\s*_([^_\n]{1,20})_\s*\)/g, "($1)")
    .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
    .replace(/__([^_\n]+?)__/g, "$1")
    .replace(/(^|[\s(“"'])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?”"']|$)/gm, "$1$2")
    .replace(/(^|[\s(“"'])_([^_\s][^_\n]*?)_(?=[\s).,;:!?”"']|$)/gm, "$1$2")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!>|])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split a headline snippet with « » marks into plain/marked parts for rendering. */
export function snippetParts(s: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), mark: false });
    out.push({ text: m[1], mark: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), mark: false });
  return out;
}
