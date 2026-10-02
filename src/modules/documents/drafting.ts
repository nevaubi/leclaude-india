/**
 * Litigation drafting on document sets — shared contract and pure helpers (client and server; no I/O):
 *
 *  - List of dates & synopsis (Supreme Court / High Court format) from the set's timeline events;
 *  - Paperbook index (annexure labels, continuous page ranges) computed deterministically;
 *  - Para-wise reply: numbered paragraphs of a plaint / petition detected deterministically (after the cause title,
 *    numbering gaps recorded), AI-proposed responses whose quotes are checked in code; nothing exports while a
 *    paragraph is unreviewed, and admissions and non-denials (deemed admissions) need a person's approval first;
 *  - Working translations (labelled as such, bound to the source page's text hash);
 *  - Registry defect notices split into numbered defects, classified into tasks.
 *
 * Evidence rules: every row keeps its file + page + quote and whether the quote was found in the stored text; edited and
 * hand-added rows are marked; nothing is substituted when a reference does not resolve.
 */
import type { DatePrecision, DocEvent } from "./types";

// =====================================================================================================================
// List of dates
// =====================================================================================================================

export type DatesFormat = "sc" | "hc";

/** User changes to one timeline event (stored by event id). */
export interface DateOverride {
  particulars?: string;
  date?: string;
  datePrecision?: DatePrecision;
  dateText?: string;
  selected?: boolean;
  removed?: boolean;
}

/** A row the user typed in (no source document). */
export interface ManualDateRow { id: string; date: string; datePrecision: DatePrecision; particulars: string; selected: boolean }

export interface SynopsisDraft {
  text: string;
  /** Rows (in table order, 1-based) the synopsis was generated from, by row id. */
  rowIds: string[];
  /** Hash of those rows' content when generated: a different hash means the rows changed since. */
  rowsHash: string;
  generatedAt: string;
  model?: string | null;
  /** [Rn] markers naming no supplied row. */
  unresolved: number[];
  /** Dates written in the synopsis that appear in none of the supplied rows. */
  unknownDates: string[];
  /** Rupee amounts written in the synopsis that appear in none of the supplied rows (absent on drafts saved before this check). */
  unknownAmounts?: string[];
  /** Sentences with no [Rn] citation. */
  uncited: number;
  /** True once the user edited the text (the stored checks describe the generated text; re-run them on the current text). */
  edited: boolean;
}

export interface DatesState {
  format: DatesFormat;
  overrides: Record<string, DateOverride>;
  manual: ManualDateRow[];
  synopsis: SynopsisDraft | null;
  /** Bumped on every save (compare-and-set). */
  version: number;
}

export const EMPTY_DATES_STATE: DatesState = { format: "sc", overrides: {}, manual: [], synopsis: null, version: 0 };

export interface DateRow {
  id: string;
  eventId: string | null;
  date: string;
  datePrecision: DatePrecision;
  dateText: string;
  particulars: string;
  fileId: string | null;
  fileName: string | null;
  page: number | null;
  quote: string;
  quoteFound: boolean;
  /** The user changed the date or particulars of an extracted event. */
  edited: boolean;
  /** Typed in by the user: no source document. */
  manual: boolean;
  selected: boolean;
}

/** Verification label shown in the Source column. */
export function rowVerification(r: Pick<DateRow, "manual" | "edited" | "quoteFound" | "fileId">): "manual" | "edited" | "unverified" | "quote found" {
  if (r.manual) return "manual";
  if (!r.quoteFound) return "unverified";
  if (r.edited) return "edited";
  return "quote found";
}

const sortKey = (iso: string) => (iso + "-00-00").slice(0, 10);

/** Rows for the table: extracted events with the user's overrides, plus manual rows, in date order. */
export function buildDateRows(events: DocEvent[], state: Pick<DatesState, "overrides" | "manual">): DateRow[] {
  const rows: DateRow[] = [];
  for (const e of events) {
    const o = state.overrides[e.id] ?? {};
    if (o.removed) continue;
    const particulars = (o.particulars ?? e.description).trim();
    const date = o.date ?? e.date;
    rows.push({
      id: e.id, eventId: e.id, date, datePrecision: o.datePrecision ?? e.datePrecision, dateText: o.dateText ?? e.dateText, particulars,
      fileId: e.fileId, fileName: e.fileName, page: e.page, quote: e.quote, quoteFound: e.quoteFound,
      edited: (o.particulars != null && o.particulars.trim() !== e.description.trim()) || (o.date != null && o.date !== e.date),
      manual: false, selected: o.selected ?? true,
    });
  }
  for (const m of state.manual) {
    rows.push({ id: m.id, eventId: null, date: m.date, datePrecision: m.datePrecision, dateText: "", particulars: m.particulars.trim(), fileId: null, fileName: null, page: null, quote: "", quoteFound: false, edited: false, manual: true, selected: m.selected });
  }
  return rows.sort((a, b) => sortKey(a.date).localeCompare(sortKey(b.date)) || (a.fileName ?? "").localeCompare(b.fileName ?? "") || (a.page ?? 0) - (b.page ?? 0) || a.id.localeCompare(b.id));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Indian court style: 03.03.2021 (day), March 2021 (month), 2021 (year). */
export function courtDate(iso: string, precision: DatePrecision): string {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(iso ?? "");
  if (!m) return iso ?? "";
  const [, y, mo, d] = m;
  if (precision === "year" || !mo) return y;
  if (precision === "month" || !d) return `${MONTHS[Number(mo) - 1] ?? mo} ${y}`;
  return `${d}.${mo}.${y}`;
}

export function sourceLabel(r: DateRow): string {
  if (r.manual) return "Added by hand (no source)";
  const where = `${r.fileName ?? "file"}${r.page != null ? `, p. ${r.page}` : ""}`;
  const v = rowVerification(r);
  return v === "quote found" ? where : `${where} (${v})`;
}

/** Stable content hash of rows (FNV-1a 32-bit, hex): binds a synopsis to the rows it was written from. */
export function rowsHash(rows: Pick<DateRow, "id" | "date" | "particulars">[]): string {
  let h = 0x811c9dc5;
  const s = rows.map((r) => `${r.id}|${r.date}|${r.particulars}`).join("\n");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

/** Markdown of the list of dates (and synopsis when given), in the chosen court's layout. */
export function datesMarkdown(rows: DateRow[], opts: { format: DatesFormat; title?: string; synopsis?: string | null; synopsisNote?: string | null }): string {
  const heading = opts.format === "sc" ? "SYNOPSIS AND LIST OF DATES" : "LIST OF DATES AND SYNOPSIS";
  const table = [
    "| Date | Particulars | Source |",
    "|---|---|---|",
    ...rows.map((r) => `| ${mdCell(courtDate(r.date, r.datePrecision))} | ${mdCell(r.particulars)} | ${mdCell(sourceLabel(r))} |`),
  ].join("\n");
  const synopsis = opts.synopsis?.trim() ? `## SYNOPSIS\n\n${opts.synopsis.trim()}${opts.synopsisNote ? `\n\n*${opts.synopsisNote}*` : ""}` : "";
  const dates = `## LIST OF DATES\n\n${table}`;
  const parts = [`# ${heading}`, opts.title ? `*${opts.title}*` : "", ...(opts.format === "sc" ? [synopsis, dates] : [dates, synopsis])].filter(Boolean);
  const unverified = rows.filter((r) => rowVerification(r) !== "quote found").length;
  if (unverified) parts.push(`*${unverified} row${unverified === 1 ? " is" : "s are"} not backed by a quote found in the documents (marked unverified, edited or added by hand). Check them against the record before filing.*`);
  return parts.join("\n\n") + "\n";
}

/** Plain-text numbered rows handed to the model for the synopsis ([R1] …), nothing else. */
export function synopsisInput(rows: DateRow[]): string {
  return rows.map((r, i) => `[R${i + 1}] ${courtDate(r.date, r.datePrecision)} — ${r.particulars}`).join("\n");
}

const MONTH_NAMES = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)";
const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthOf = (name: string) => MONTH_INDEX[name.slice(0, 3).toLowerCase()] ?? 0;
const pad2 = (n: number) => String(n).padStart(2, "0");
const fullYear = (y: string) => (y.length === 2 ? (Number(y) < 50 ? 2000 + Number(y) : 1900 + Number(y)) : Number(y));

/**
 * Date forms recognised in a synopsis, most specific first (each match is masked before the next form runs, so
 * "12th day of March, 2021" is not also read as "March 2021"). Each yields an ISO day or month.
 */
const DATE_FORMS: { re: RegExp; iso: (m: RegExpMatchArray) => string | null }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, iso: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { re: /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/g, iso: (m) => `${fullYear(m[3])}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}` },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+day\\s+of\\s+(${MONTH_NAMES})\\.?,?\\s+(\\d{4})\\b`, "g"), iso: (m) => `${m[3]}-${pad2(monthOf(m[2]))}-${pad2(Number(m[1]))}` },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?,?\\s+(\\d{4})\\b`, "g"), iso: (m) => `${m[3]}-${pad2(monthOf(m[2]))}-${pad2(Number(m[1]))}` },
  { re: new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "g"), iso: (m) => `${m[3]}-${pad2(monthOf(m[1]))}-${pad2(Number(m[2]))}` },
  { re: new RegExp(`\\b(${MONTH_NAMES})\\.?,?\\s+(\\d{4})\\b`, "g"), iso: (m) => `${m[2]}-${pad2(monthOf(m[1]))}` },
];

/** Dates written in text, with their ISO day ("2021-03-12") or month ("2021-03"). */
export function datesInText(text: string): { text: string; iso: string }[] {
  let rest = text;
  const found: { at: number; text: string; iso: string }[] = [];
  for (const f of DATE_FORMS) {
    for (const m of rest.matchAll(f.re)) {
      const iso = f.iso(m);
      const valid = iso && /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(iso);
      found.push({ at: m.index ?? 0, text: m[0], iso: valid ? iso : "" });
    }
    rest = rest.replace(f.re, (x) => " ".repeat(x.length));
  }
  return found.sort((a, b) => a.at - b.at).map(({ text: t, iso }) => ({ text: t, iso }));
}

const AMOUNT_UNITS: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, million: 1e6, billion: 1e9 };
const AMOUNT_RE = /(?:\bRs\.?|\bINR|₹)\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(lakhs?|lacs?|crores?|cr\b\.?|million|billion))?(?:\s*\/-)?/gi;
/** Figures a row may state without a currency sign ("5,00,000/-", "10 lakh", "2 crore"). */
const ROW_AMOUNT_RE = /(\d[\d,]*(?:\.\d+)?)\s*(?:(lakhs?|lacs?|crores?|cr\b\.?|million|billion)|\/-|rupees)/gi;

const amountValue = (num: string, unit: string | undefined) => {
  const v = Number(num.replace(/,/g, ""));
  const u = unit ? AMOUNT_UNITS[unit.toLowerCase().replace(/\.$/, "")] ?? 1 : 1;
  return Number.isFinite(v) ? Math.round(v * u * 100) / 100 : NaN;
};

/** Rupee amounts in text ("Rs. 5,00,000", "₹10 lakh", "INR 2.5 crore") with their value in rupees. */
export function amountsInText(text: string): { text: string; value: number }[] {
  return [...text.matchAll(AMOUNT_RE)].map((m) => ({ text: m[0].trim(), value: amountValue(m[1], m[2]) })).filter((a) => Number.isFinite(a.value) && a.value > 0);
}

/** Abbreviations that end in a full stop without ending the sentence ("Rs. 10 lakh", "Mr. R. Kumar", "O.S. No. 12"). */
const NO_BREAK_AFTER = /(?:\b(?:Rs|Mr|Mrs|Ms|Dr|No|Nos|Sr|Jr|St|Ltd|Pvt|Co|Smt|Shri|Sh|vs|viz|Hon|Art|Sec|cl|para|paras|i\.e|e\.g|[A-Za-z]))\.$/;

/** Sentences of a synopsis, with trailing [Rn] markers moved inside their sentence (". [R1] Next" → " [R1]. Next"). */
export function synopsisSentences(text: string): string[] {
  const moved = text.replace(/\n+/g, " ").replace(/([.!?])((?:\s*\[R\d{1,4}\])+)/g, (_, stop: string, marks: string) => `${marks}${stop}`);
  const out: string[] = [];
  let cur = "";
  for (const piece of moved.split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/)) {
    cur = cur ? `${cur} ${piece}` : piece;
    if (NO_BREAK_AFTER.test(cur.trim())) continue;
    out.push(cur.trim());
    cur = "";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface SynopsisChecks { unresolved: number[]; unknownDates: string[]; unknownAmounts: string[]; uncited: number }

/**
 * Check a synopsis against the rows it was given (in [Rn] order; a row that no longer exists is null): [Rn] markers
 * naming no row are unresolved; dates (day or month) and rupee amounts that appear in no row are listed; sentences
 * without a marker are counted. Nothing is rewritten.
 */
export function checkSynopsis(text: string, rows: (DateRow | null | undefined)[]): SynopsisChecks {
  const unresolved = new Set<number>();
  for (const m of text.matchAll(/\[R(\d{1,4})\]/g)) { const n = Number(m[1]); if (n < 1 || n > rows.length || !rows[n - 1]) unresolved.add(n); }
  const live = rows.filter((r): r is DateRow => !!r);
  const hay = live.map((r) => `${courtDate(r.date, r.datePrecision)} ${r.dateText} ${r.particulars}`).join(" \n ").toLowerCase().replace(/\s+/g, " ");
  const rowDays = new Set(live.filter((r) => r.date.length === 10).map((r) => r.date));
  const rowMonths = new Set(live.filter((r) => r.date.length >= 7).map((r) => r.date.slice(0, 7)));
  for (const r of live) for (const d of datesInText(`${r.dateText} ${r.particulars}`)) { if (d.iso.length === 10) rowDays.add(d.iso); if (d.iso) rowMonths.add(d.iso.slice(0, 7)); }
  const unknownDates = new Set<string>();
  for (const d of datesInText(text)) {
    const known = d.iso.length === 10 ? rowDays.has(d.iso) : d.iso.length === 7 ? rowMonths.has(d.iso) : false;
    if (known || hay.includes(d.text.toLowerCase())) continue;
    unknownDates.add(d.text);
  }
  const rowText = live.map((r) => `${r.particulars} ${r.dateText}`).join(" \n ");
  const rowValues = new Set<number>([...amountsInText(rowText).map((a) => a.value), ...[...rowText.matchAll(ROW_AMOUNT_RE)].map((m) => amountValue(m[1], m[2]))]);
  const unknownAmounts = [...new Set(amountsInText(text).filter((a) => !rowValues.has(a.value)).map((a) => a.text))];
  const uncited = synopsisSentences(text).filter((s) => s.length > 20 && !/\[R\d{1,4}\]/.test(s)).length;
  return { unresolved: [...unresolved].sort((a, b) => a - b), unknownDates: [...unknownDates], unknownAmounts, uncited };
}

/** One line on what the checks found ("" when nothing): used in the export note and the UI. */
export function synopsisCheckSummary(c: SynopsisChecks): string {
  const parts: string[] = [];
  if (c.unresolved.length) parts.push(`row citations that name no listed row: ${c.unresolved.map((n) => `R${n}`).join(", ")}`);
  if (c.unknownDates.length) parts.push(`dates not in the listed rows: ${c.unknownDates.join(", ")}`);
  if (c.unknownAmounts.length) parts.push(`amounts not in the listed rows: ${c.unknownAmounts.join(", ")}`);
  if (c.uncited) parts.push(`${c.uncited} sentence${c.uncited === 1 ? "" : "s"} without a row citation`);
  return parts.join("; ");
}

/** Replace [Rn] markers by the row's date for the exported synopsis ("[R3]" → "(03.03.2021)"); unknown n stay visible. */
export function synopsisForExport(text: string, rows: DateRow[]): string {
  return text.replace(/\s*\[R(\d{1,4})\]/g, (whole, n: string) => {
    const r = rows[Number(n) - 1];
    return r ? ` [${courtDate(r.date, r.datePrecision)}]` : ` [unresolved R${n}]`;
  }).replace(/\]\s*\[/g, "; ").replace(/\s+([.,;])/g, "$1");
}

// =====================================================================================================================
// Paperbook
// =====================================================================================================================

export type AnnexurePrefix = "P" | "R" | "A";

export interface PaperbookEntryIn {
  /** A file of this set (its stored text, or its original bytes when attached and verified by SHA-256). */
  fileId?: string;
  /** Key of an uploaded attachment (PDF / PNG / JPEG not in the set). */
  uploadKey?: string;
  title: string;
  annexure: boolean;
}

export interface PaperbookSpec {
  title: string;
  /** Court / cause title line printed on the index page (optional). */
  court?: string;
  prefix: AnnexurePrefix;
  /** First page number (continuous numbering across the whole paperbook). */
  startPage: number;
  indexPage: boolean;
  trueCopy: boolean;
  entries: PaperbookEntryIn[];
}

/**
 * Where an entry's pages come from: typed from the set file's stored text; an attached original of a set file whose
 * SHA-256 matched the hash recorded for it (computed on the server, or only declared by the uploading browser); or an
 * attachment that is not in the set.
 */
export type PaperbookSource = { kind: "typed" } | { kind: "original"; hash: "server" | "browser_declared" } | { kind: "attachment" };

export interface PaperbookIndexRow { sl: number; title: string; annexure: string | null; from: number; to: number; pages: number; source?: PaperbookSource }

export const PAPERBOOK_LIMITS = {
  maxEntries: 200, maxPages: 2000, maxUploadBytes: 4 * 1024 * 1024, maxTitle: 200,
  /** Rows per index page used only for an estimate when the index was not laid out (the builder measures it). */
  indexRowsPerPage: 24,
  /** A PNG is decoded in memory: width × height per image, and in total per paperbook. */
  maxImagePixels: 40_000_000, maxTotalImagePixels: 60_000_000,
  /** How many entries may use the same attachment. */
  maxUploadUses: 3,
  /** Estimated (and actual) size of the built PDF. */
  maxOutputBytes: 80 * 1024 * 1024,
} as const;

export function paperbookSourceLabel(s: PaperbookSource | undefined): string {
  if (!s) return "";
  if (s.kind === "typed") return "Typed from stored text (not a facsimile)";
  if (s.kind === "attachment") return "Attachment (not a set file)";
  return s.hash === "server" ? "Original: SHA-256 matches the hash computed on the server" : "Original: SHA-256 matches the hash the browser declared at upload (not computed on the server)";
}

/** "ANNEXURE P-1", "ANNEXURE P-2" … for annexure entries in order (null for the others). */
export function annexureLabels(entries: Pick<PaperbookEntryIn, "annexure">[], prefix: AnnexurePrefix): (string | null)[] {
  let n = 0;
  return entries.map((e) => (e.annexure ? `ANNEXURE ${prefix}-${++n}` : null));
}

/** Estimated index pages (fixed rows per page); the builder passes the count from its measured layout instead. */
export function indexPageCount(entries: number, opts: { indexPage: boolean }): number {
  return opts.indexPage ? Math.max(1, Math.ceil(entries / PAPERBOOK_LIMITS.indexRowsPerPage)) : 0;
}

/**
 * The index: continuous page ranges (index pages come first and are numbered too). Deterministic from page counts and
 * the number of index pages (`indexPages`: measured by the builder from the wrapped titles; estimated when absent).
 */
export function computePaperbookIndex(entries: Pick<PaperbookEntryIn, "title" | "annexure">[], pageCounts: number[], opts: { prefix: AnnexurePrefix; startPage: number; indexPage: boolean; indexPages?: number }): { rows: PaperbookIndexRow[]; indexPages: number; totalPages: number; firstPage: number } {
  const labels = annexureLabels(entries, opts.prefix);
  const indexPages = !opts.indexPage ? 0 : opts.indexPages != null && Number.isInteger(opts.indexPages) && opts.indexPages >= 1 ? opts.indexPages : indexPageCount(entries.length, opts);
  const firstPage = Math.max(1, Math.floor(opts.startPage || 1));
  let page = firstPage + indexPages;
  const rows = entries.map((e, i) => {
    const pages = Math.max(0, Math.floor(pageCounts[i] ?? 0));
    const row: PaperbookIndexRow = { sl: i + 1, title: e.title, annexure: labels[i], from: page, to: pages ? page + pages - 1 : page - 1, pages };
    page += pages;
    return row;
  });
  return { rows, indexPages, totalPages: page - firstPage, firstPage };
}

export function pageRangeLabel(r: Pick<PaperbookIndexRow, "from" | "to" | "pages">): string {
  if (!r.pages) return "—";
  return r.from === r.to ? String(r.from) : `${r.from}–${r.to}`;
}

// =====================================================================================================================
// Para-wise reply
// =====================================================================================================================

export interface PleadingPara {
  /** The paragraph number as printed ("1", "12"). */
  n: string;
  text: string;
  /** Page where the paragraph starts (null for formats without pages). */
  page: number | null;
  /** Numbers skipped just before this paragraph (e.g. 1 when "4." is followed by "6."); absent when none. */
  gapBefore?: number;
}

const NUMBERED_LINE = /^\s*(?:para(?:graph)?\s*)?(\d{1,3})\s*[.):]\s+(\S.*)$/i;
const PARTY_LABEL = /^[.…\-–—_\s]*(?:the\s+)?(?:petitioners?|respondents?|plaintiffs?|defendants?|appellants?|applicants?|complainants?|accused)(?:\s*\(s\))?(?:\s*nos?\.?\s*[\d,\s&-]+(?:and\s+\d+)?)?\s*[:.]?$/i;
const CAPS_HEADING = /^(?:THE\s+)?(?:HUMBLE\s+)?(?:PLAINT|PETITION|WRITTEN STATEMENT|APPLICATION|APPEAL|COMPLAINT|SUIT|(?:WRIT|CIVIL|CRIMINAL|SPECIAL LEAVE|TRANSFER|REVIEW|ORIGINAL|MISCELLANEOUS)\s+(?:PETITION|APPEAL|SUIT|APPLICATION))\b/;

/** Lines that close the cause title (the body's numbered paragraphs come after the last one of these). */
function endsCauseTitle(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 160) return false;
  if (/^(?:versus|vs\.?|v\/s\.?|v\.|and\s*:?)$/i.test(t)) return true;
  if (PARTY_LABEL.test(t)) return true;
  if (/^(?:most\s+)?respectfully\s+(?:she|sho)weth\b/i.test(t)) return true;
  // Pleading headings ("PLAINT UNDER ORDER VII RULE 1 CPC", "WRIT PETITION UNDER ARTICLE 226") are set in capitals;
  // a body line that merely starts with "Petition under …" is not a heading.
  return !/[a-z]/.test(t) && CAPS_HEADING.test(t);
}

/** Headings after which numbered lines are no longer paragraphs of the pleading (prayer, verification, schedules…). */
const TRAILER_START = /^\s*(?:prayer|relief(?:s)?\s+(?:claimed|sought)|verification|schedule(?:\s+of\s+property)?|list\s+of\s+(?:documents|dates|annexures)|documents\s+relied\s+upon|index)\s*[:.]?\s*$/i;

interface NumberedLine { line: number; n: number; text: string; page: number | null }

/**
 * Numbered paragraphs of a plaint / petition, deterministically.
 *
 * A line starting "N." / "N)" / "N:" is a candidate unless its text starts in lower case ("1. the instalment of June;"
 * is a sub-item of the paragraph above). Candidates form runs: "1." starts a new run (a run may also start at 2 or 3
 * when nothing came before, e.g. a lost first page); N joins a run that ended at N - 1 (a run started after the cause
 * title before a party list, and the outermost before a numbered sub-list); when no run continues
 * contiguously, N may close a gap of up to three numbers, but only when the next candidate is N + 1 (a stray "7." after
 * "4." stays text) — the gap is recorded on the paragraph. The pleading's paragraphs are the longest run that starts
 * after the cause title (numbered party lists before VERSUS / PLAINT / "…PETITIONERS" / "MOST RESPECTFULLY SHEWETH" are
 * not paragraphs) and before a trailer heading (PRAYER, VERIFICATION, SCHEDULE…). Every other line belongs to the
 * paragraph above it; text before the first paragraph is left out, and text from a trailer heading on is not appended.
 */
export function detectParagraphs(pages: { page: number | null; text: string }[]): PleadingPara[] {
  const lines: { text: string; page: number | null }[] = [];
  for (const p of pages) for (const raw of (p.text ?? "").split(/\n/)) lines.push({ text: raw.replace(/\s+$/g, ""), page: p.page });
  const cands: NumberedLine[] = [];
  let causeEnd = -1;
  lines.forEach((l, i) => {
    const m = NUMBERED_LINE.exec(l.text);
    if (m && !/^[a-z]/.test(m[2])) cands.push({ line: i, n: Number(m[1]), text: m[2].trim(), page: l.page });
    else if (!m && endsCauseTitle(l.text)) causeEnd = i;
  });
  // A trailer heading only counts once the body has begun (an "INDEX" above the cause title is not a trailer).
  let trailer = lines.length;
  const firstBody = cands.find((c) => c.line > causeEnd);
  for (let i = firstBody ? firstBody.line + 1 : lines.length; i < lines.length; i++) if (TRAILER_START.test(lines[i].text)) { trailer = i; break; }

  const runs: { start: number; items: (NumberedLine & { gap: number })[] }[] = [];
  const lastOf = (r: (typeof runs)[number]) => r.items[r.items.length - 1].n;
  cands.forEach((c, k) => {
    // Several runs may expect N: a body run (started after the cause title) wins over a party list, and among body runs
    // the outermost (oldest) wins over a numbered sub-list inside a paragraph.
    const contiguous = runs.filter((r) => lastOf(r) === c.n - 1);
    const body = contiguous.filter((r) => r.start > causeEnd);
    const into = body.length ? body[0] : contiguous[contiguous.length - 1];
    if (into) { into.items.push({ ...c, gap: 0 }); return; }
    if (c.n === 1 || (!runs.length && c.n <= 3)) { runs.push({ start: c.line, items: [{ ...c, gap: 0 }] }); return; }
    if (cands[k + 1]?.n !== c.n + 1) return;
    const gapped = runs.filter((r) => c.n - lastOf(r) >= 2 && c.n - lastOf(r) <= 4);
    const r = gapped.find((x) => x.start > causeEnd) ?? gapped[gapped.length - 1];
    if (r) r.items.push({ ...c, gap: c.n - lastOf(r) - 1 });
  });
  const inBody = (r: (typeof runs)[number]) => r.start > causeEnd && r.start < trailer;
  const pool = runs.some(inBody) ? runs.filter(inBody) : runs;
  const size = (r: (typeof runs)[number]) => r.items.filter((x) => x.line < trailer).length;
  let best: (typeof runs)[number] | null = null;
  for (const r of pool) if (!best || size(r) > size(best)) best = r;
  if (!best) return [];
  const chosen = best.items.filter((x) => x.line < trailer);
  const out: PleadingPara[] = [];
  chosen.forEach((c, i) => {
    const stop = i + 1 < chosen.length ? chosen[i + 1].line : trailer;
    let text = c.text;
    for (let j = c.line + 1; j < stop; j++) {
      const t = lines[j].text.trim();
      if (t) text += (text.endsWith("-") ? "" : " ") + t;
    }
    const para: PleadingPara = { n: String(c.n), text: text.replace(/\s+/g, " ").trim(), page: c.page };
    if (c.gap && i > 0) para.gapBefore = c.gap;
    out.push(para);
  });
  return out.filter((x) => x.text.length > 0);
}

/** "unreviewed": nobody (person or model) has given this paragraph a response yet; it can never be exported. */
export type ReplyStance = "unreviewed" | "admitted" | "denied" | "not_admitted" | "matter_of_record" | "legal_submission" | "no_reply";

export const STANCE_LABEL: Record<ReplyStance, string> = {
  unreviewed: "Not reviewed",
  admitted: "Admitted",
  denied: "Denied",
  not_admitted: "Not admitted",
  matter_of_record: "Matter of record",
  legal_submission: "Legal submission",
  no_reply: "No reply needed",
};

/** Responses a person (or the model) may choose; "unreviewed" is only the starting state. */
export type ReviewedStance = Exclude<ReplyStance, "unreviewed">;
export const STANCES: ReviewedStance[] = ["admitted", "denied", "not_admitted", "matter_of_record", "legal_submission", "no_reply"];
export const isStance = (v: unknown): v is ReviewedStance => typeof v === "string" && (STANCES as string[]).includes(v);

/**
 * Responses that do not traverse the allegation. Under Order VIII Rule 5 CPC an allegation not specifically denied
 * may be taken as admitted, so each of these needs a person's explicit approval before export, like an admission.
 */
export const APPROVAL_STANCES: ReplyStance[] = ["admitted", "matter_of_record", "no_reply"];
export const needsApproval = (s: ReplyStance) => APPROVAL_STANCES.includes(s);

export interface ReplyEvidence { fileId: string; fileName: string; page: number | null; quote: string; quoteFound: boolean }

export interface ParaReply {
  n: string;
  paraText: string;
  page: number | null;
  /** Numbers skipped before this paragraph in the pleading (numbering gap), when any. */
  gapBefore?: number;
  /** What the model proposed (kept as proposed; the user's version is `stance` / `reply`). */
  proposed: { stance: ReplyStance; reply: string; reasoning: string; evidence: ReplyEvidence[]; droppedRefs: number } | null;
  stance: ReplyStance;
  reply: string;
  edited: boolean;
  /** Admissions and other non-traversing responses bind the client: a person approves each before export. */
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  status: "pending" | "proposed" | "failed";
  error: string | null;
}

export interface ParawiseState {
  fileId: string;
  fileName: string;
  /** Hash of the pleading's text when its paragraphs were detected. */
  textHash: string;
  paras: ParaReply[];
  model: string | null;
  updatedAt: string;
  version: number;
}

export function newReply(p: PleadingPara): ParaReply {
  return { n: p.n, paraText: p.text, page: p.page, ...(p.gapBefore ? { gapBefore: p.gapBefore } : {}), proposed: null, stance: "unreviewed", reply: "", edited: false, approved: false, approvedBy: null, approvedAt: null, status: "pending", error: null };
}

export interface ReplyExportBlockers {
  /** The pleading's text changed since its paragraphs were detected. */
  stale: boolean;
  /** Paragraphs with no response yet: never proposed, or the proposal failed, and nobody edited them. */
  unreviewed: string[];
  /** Admissions and other non-traversing responses awaiting a person's approval. */
  unapproved: string[];
}

/** Why the reply cannot be exported yet, or null when it can. */
export function exportBlockers(paras: ParaReply[], opts: { stale?: boolean } = {}): ReplyExportBlockers | null {
  const unreviewed = paras.filter((p) => p.stance === "unreviewed" || (p.status !== "proposed" && !p.edited)).map((p) => p.n);
  const unapproved = paras.filter((p) => p.stance !== "unreviewed" && needsApproval(p.stance) && !p.approved).map((p) => p.n);
  const stale = opts.stale === true;
  return stale || unreviewed.length || unapproved.length ? { stale, unreviewed, unapproved } : null;
}

const paraList = (ns: string[]) => `paragraph${ns.length === 1 ? "" : "s"} ${ns.slice(0, 12).join(", ")}${ns.length > 12 ? ` and ${ns.length - 12} more` : ""}`;

/** The blockers as one sentence (export error, notice). */
export function blockerMessage(b: ReplyExportBlockers): string {
  const parts: string[] = [];
  if (b.stale) parts.push("the pleading's text changed since its paragraphs were detected (restart the reply)");
  if (b.unreviewed.length) parts.push(`${paraList(b.unreviewed)} ${b.unreviewed.length === 1 ? "has" : "have"} no reviewed response yet`);
  if (b.unapproved.length) parts.push(`${paraList(b.unapproved)} ${b.unapproved.length === 1 ? "needs" : "need"} approval (admissions, and responses that do not deny, can bind the client)`);
  return `Cannot export: ${parts.join("; ")}.`;
}

const STANCE_OPENING: Record<ReviewedStance, (n: string, doc: string) => string> = {
  admitted: (n, d) => `The contents of paragraph ${n} of the ${d} are admitted`,
  denied: (n, d) => `The contents of paragraph ${n} of the ${d} are denied`,
  not_admitted: (n, d) => `The contents of paragraph ${n} of the ${d} are not admitted, and the plaintiff is put to strict proof thereof`,
  matter_of_record: (n, d) => `The contents of paragraph ${n} of the ${d} are matters of record and need no reply, save as stated below`,
  legal_submission: (n, d) => `Paragraph ${n} of the ${d} contains legal submissions, which are denied as stated below`,
  no_reply: (n, d) => `Paragraph ${n} of the ${d} calls for no reply`,
};

/** The written-statement markdown (para-wise reply section). Throws while anything blocks export (see exportBlockers). */
export function writtenStatementMarkdown(state: Pick<ParawiseState, "fileName" | "paras">, opts: { pleading?: "plaint" | "petition"; title?: string; stale?: boolean } = {}): string {
  const blockers = exportBlockers(state.paras, { stale: opts.stale });
  if (blockers) throw new Error(blockerMessage(blockers));
  const d = opts.pleading ?? "plaint";
  const lines: string[] = [`# ${opts.title ?? "WRITTEN STATEMENT — PARA-WISE REPLY"}`, "", `*Reply to the ${d}: ${state.fileName}. Draft for review.*`, "", "## PARA-WISE REPLY", ""];
  state.paras.forEach((p, i) => {
    if (p.stance === "unreviewed") return; // unreachable: blocked above
    const body = p.reply.trim();
    const opening = STANCE_OPENING[p.stance](p.n, d);
    const line = `${i + 1}. ${opening}${body ? `. ${body.replace(/^\s*(that\s+)?/i, "")}` : ""}`.trim();
    lines.push(/[.!?]$/.test(line) ? line : `${line}.`);
  });
  lines.push("", "*Paragraphs not specifically admitted above are denied.*");
  const unedited = state.paras.filter((p) => p.status === "proposed" && !p.edited && p.proposed).map((p) => p.n);
  if (unedited.length) lines.push("", `*Drafting note: the responses to ${paraList(unedited)} are as proposed by AI and were not edited by a person. Review them before filing.*`);
  return lines.join("\n") + "\n";
}

// =====================================================================================================================
// Translation
// =====================================================================================================================

export const TRANSLATION_LABEL = "Working translation — not a certified translation; the original is the record.";

export const TRANSLATION_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" }, { code: "hi", label: "Hindi" }, { code: "kn", label: "Kannada" }, { code: "te", label: "Telugu" },
  { code: "ta", label: "Tamil" }, { code: "mr", label: "Marathi" }, { code: "bn", label: "Bengali" }, { code: "ur", label: "Urdu" },
  { code: "gu", label: "Gujarati" }, { code: "ml", label: "Malayalam" }, { code: "pa", label: "Punjabi" }, { code: "or", label: "Odia" }, { code: "as", label: "Assamese" },
];

export const languageLabel = (code: string) => TRANSLATION_LANGUAGES.find((l) => l.code === code)?.label ?? code;

/** Legal terms with their accepted equivalents (hints only; the model keeps the English term in brackets on first use). */
export const LEGAL_GLOSSARY: Record<string, Record<string, string>> = {
  hi: { plaintiff: "वादी", defendant: "प्रतिवादी", petitioner: "याचिकाकर्ता", respondent: "प्रत्यर्थी", affidavit: "शपथपत्र", "written statement": "लिखित कथन", injunction: "निषेधाज्ञा", appeal: "अपील", "interim order": "अंतरिम आदेश", bail: "जमानत", decree: "डिक्री", "vakalatnama": "वकालतनामा" },
  kn: { plaintiff: "ವಾದಿ", defendant: "ಪ್ರತಿವಾದಿ", petitioner: "ಅರ್ಜಿದಾರ", respondent: "ಪ್ರತಿವಾದಿ", affidavit: "ಪ್ರಮಾಣಪತ್ರ", injunction: "ನಿರ್ಬಂಧಕಾಜ್ಞೆ", bail: "ಜಾಮೀನು" },
  te: { plaintiff: "వాది", defendant: "ప్రతివాది", petitioner: "పిటిషనర్", respondent: "ప్రతివాది", affidavit: "అఫిడవిట్", bail: "బెయిల్" },
  ta: { plaintiff: "வாதி", defendant: "பிரதிவாதி", petitioner: "மனுதாரர்", respondent: "எதிர்மனுதாரர்", affidavit: "பிரமாணப் பத்திரம்", bail: "பிணை" },
  mr: { plaintiff: "वादी", defendant: "प्रतिवादी", petitioner: "याचिकाकर्ता", respondent: "प्रतिवादी", affidavit: "प्रतिज्ञापत्र", bail: "जामीन" },
};

/** Glossary lines for a language pair (English ↔ Indian language). */
export function glossaryHints(from: string, to: string): string[] {
  const lang = from === "en" ? to : to === "en" ? from : null;
  const g = lang ? LEGAL_GLOSSARY[lang] : null;
  if (!g) return [];
  return Object.entries(g).map(([en, local]) => (from === "en" ? `${en} → ${local}` : `${local} → ${en}`));
}

export interface TranslationRecord {
  fileId: string;
  page: number | null;
  from: string;
  to: string;
  text: string;
  /** SHA-256 of the source page text that was translated: a different current hash means the original changed. */
  sourceHash: string;
  model: string | null;
  createdAt: string;
  createdBy: string;
  label: string;
}

export const translationKey = (fileId: string, page: number | null, to: string) => `${fileId}:${page ?? 0}:${to}`;

// =====================================================================================================================
// Registry defects
// =====================================================================================================================

export type DefectForum = "sc" | "hc" | "nclt" | "other";
export type DefectCategory = "formatting" | "missing_documents" | "fees" | "signatures" | "translation" | "other";

export const DEFECT_CATEGORY_LABEL: Record<DefectCategory, string> = {
  formatting: "Formatting",
  missing_documents: "Missing documents",
  fees: "Court fee",
  signatures: "Signatures / attestation",
  translation: "Translation",
  other: "Other",
};

export interface Defect {
  id: string;
  /** Number as printed in the notice ("1", "2(a)", "iii"). */
  n: string;
  text: string;
  category: DefectCategory;
  /** "rule": keyword rule; "ai": model classification; "user": changed by a person. */
  classifiedBy: "rule" | "ai" | "user";
  task: string;
  fix: string;
  done: boolean;
  doneBy: string | null;
  doneAt: string | null;
}

export interface DefectNotice {
  id: string;
  title: string;
  forum: DefectForum;
  text: string;
  textHash: string;
  defects: Defect[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  version: number;
  /** Whether the AI classification ran (false: keyword rules only). */
  aiClassified: boolean;
}

const ROMAN = /^(?:i{1,3}|iv|vi{0,3}|ix|x{1,2}|xi{1,3}|xiv|xv)$/i;

/**
 * Split a registry defect notice into its numbered defects (deterministic). Recognised item markers at the start of a
 * line: "1." "1)" "(1)" "1:" "Defect No. 1", "(i)" "i)" "(a)" "a)", "•" "-" "*". Lines that do not open an item continue
 * the current one. Header text before the first item is ignored; a notice with no markers becomes one defect per line.
 */
export function splitDefects(text: string): { n: string; text: string }[] {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: { n: string; text: string }[] = [];
  let cur: { n: string; text: string } | null = null;
  const marker = /^\s*(?:(?:defect|objection|item)\s*(?:no\.?|number)?\s*(\d{1,3})\s*[.):-]?|\(?(\d{1,3})\s*[.):]|\((\d{1,3})\)|\(?([ivx]{1,5})\)|([ivx]{1,5})\.|\(([a-z])\)|([a-z])\)|([•\-*–]))\s+(\S.*)$/i;
  for (const raw of lines) {
    const m = marker.exec(raw);
    if (m) {
      const roman = m[4] ?? m[5];
      if (roman && !ROMAN.test(roman)) { if (cur) cur.text += ` ${raw.trim()}`; continue; }
      // A bullet takes its position in the list as its number.
      const n: string = m[1] ?? m[2] ?? m[3] ?? roman ?? m[6] ?? m[7] ?? String(out.length + (cur ? 1 : 0) + 1);
      if (cur) out.push(cur);
      cur = { n: n.toLowerCase(), text: m[9].trim() };
    } else if (cur && raw.trim()) {
      cur.text += ` ${raw.trim()}`;
    }
  }
  if (cur) out.push(cur);
  if (!out.length) {
    const plain = lines.map((l) => l.trim()).filter((l) => l.length > 3);
    return plain.map((t, i) => ({ n: String(i + 1), text: t }));
  }
  return out.map((d) => ({ n: d.n, text: d.text.replace(/\s+/g, " ").trim() })).filter((d) => d.text);
}

const RULES: [DefectCategory, RegExp][] = [
  // Legibility is a formatting defect even when the defect names an annexure.
  ["formatting", /\b(not legible|illegible|not clear|dim|faded|blurred)\b/i],
  ["fees", /\b(court[- ]?fee|deficit fee|fee stamps?|stamp duty|requisite fee|process fee|deficit court)\b/i],
  ["signatures", /\b(sign(?:ed|ature)?s?|unsigned|attest(?:ed|ation)?|notari[sz]ed|oath commissioner|initial(?:l)?ed|counter[- ]?signed)\b/i],
  ["translation", /\b(translat(?:ion|ed)|vernacular|regional language|english version|typed copy of the vernacular)\b/i],
  ["missing_documents", /\b(not (?:filed|annexed|enclosed|produced)|missing|certified copy|annexures?|vakalatnama|memo of appearance|affidavit (?:not|is not)|impugned order|copy of)\b/i],
  ["formatting", /\b(margins?|font|line spacing|spacing|paginat\w*|page numbers?|pages? (?:are )?not numbered|numbering|index|bookmarks?|legible|illegible|a4|one side|double[- ]sided|format\w*|blank pages?|ocr|searchable|dim|font size|book ?marks?)\b/i],
];

/** Keyword classification (used before, and when there is no, AI classification). */
export function ruleCategory(text: string): DefectCategory {
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  return "other";
}
