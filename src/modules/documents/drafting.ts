/**
 * Litigation drafting on document sets — shared contract and pure helpers (client and server; no I/O):
 *
 *  - List of dates & synopsis (Supreme Court / High Court format) from the set's timeline events;
 *  - Paperbook index (annexure labels, continuous page ranges) computed deterministically;
 *  - Para-wise reply: numbered paragraphs of a plaint / petition detected deterministically, AI-proposed responses
 *    whose quotes are checked in code, admissions approved by a person before export;
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
  /** Sentences with no [Rn] citation. */
  uncited: number;
  /** True once the user edited the text (checks above describe the generated text only). */
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

const DATE_IN_TEXT = /\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/g;

/**
 * Check a generated synopsis against the rows it was given: [Rn] markers outside 1..rows.length are unresolved, dates
 * that appear in no row are listed, and sentences without a marker are counted. Nothing is rewritten.
 */
export function checkSynopsis(text: string, rows: DateRow[]): { unresolved: number[]; unknownDates: string[]; uncited: number } {
  const unresolved = new Set<number>();
  for (const m of text.matchAll(/\[R(\d{1,4})\]/g)) { const n = Number(m[1]); if (n < 1 || n > rows.length) unresolved.add(n); }
  const hay = rows.map((r) => `${courtDate(r.date, r.datePrecision)} ${r.dateText} ${r.particulars}`).join(" \n ").toLowerCase().replace(/\s+/g, " ");
  const norm = (d: string) => d.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, "").replace(/\s+/g, " ").trim();
  const isoOf = (d: string): string | null => {
    const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(d.trim());
    return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
  };
  const rowIsos = new Set(rows.map((r) => r.date));
  const unknown = new Set<string>();
  for (const m of text.matchAll(DATE_IN_TEXT)) {
    const d = m[0];
    const iso = isoOf(d);
    if (iso && rowIsos.has(iso)) continue;
    if (hay.includes(norm(d)) || hay.includes(d.toLowerCase())) continue;
    unknown.add(d);
  }
  const sentences = text.replace(/\n+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/).map((s) => s.trim()).filter((s) => s.length > 20);
  const uncited = sentences.filter((s) => !/\[R\d{1,4}\]/.test(s)).length;
  return { unresolved: [...unresolved].sort((a, b) => a - b), unknownDates: [...unknown], uncited };
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

export interface PaperbookIndexRow { sl: number; title: string; annexure: string | null; from: number; to: number; pages: number }

export const PAPERBOOK_LIMITS = { maxEntries: 200, maxPages: 2000, maxUploadBytes: 4 * 1024 * 1024, indexRowsPerPage: 24, maxTitle: 200 } as const;

/** "ANNEXURE P-1", "ANNEXURE P-2" … for annexure entries in order (null for the others). */
export function annexureLabels(entries: Pick<PaperbookEntryIn, "annexure">[], prefix: AnnexurePrefix): (string | null)[] {
  let n = 0;
  return entries.map((e) => (e.annexure ? `ANNEXURE ${prefix}-${++n}` : null));
}

export function indexPageCount(entries: number, opts: { indexPage: boolean }): number {
  return opts.indexPage ? Math.max(1, Math.ceil(entries / PAPERBOOK_LIMITS.indexRowsPerPage)) : 0;
}

/** The index: continuous page ranges (index pages come first and are numbered too). Deterministic from page counts. */
export function computePaperbookIndex(entries: Pick<PaperbookEntryIn, "title" | "annexure">[], pageCounts: number[], opts: { prefix: AnnexurePrefix; startPage: number; indexPage: boolean }): { rows: PaperbookIndexRow[]; indexPages: number; totalPages: number; firstPage: number } {
  const labels = annexureLabels(entries, opts.prefix);
  const indexPages = indexPageCount(entries.length, opts);
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
}

/**
 * Numbered paragraphs of a plaint / petition, deterministically: a line starting with "N." / "N)" / "N:" opens
 * paragraph N only when N continues the sequence (the first one may be 1–3), so numbered lists, dates and sub-items
 * inside a paragraph stay in it. Text before the first paragraph (cause title) is left out.
 */
export function detectParagraphs(pages: { page: number | null; text: string }[]): PleadingPara[] {
  const out: PleadingPara[] = [];
  let cur: PleadingPara | null = null;
  let last = 0;
  for (const p of pages) {
    for (const raw of (p.text ?? "").split(/\n/)) {
      const line = raw.replace(/\s+$/g, "");
      const m = /^\s*(?:para(?:graph)?\s*)?(\d{1,3})\s*[.):]\s+(\S.*)$/i.exec(line);
      const n = m ? Number(m[1]) : NaN;
      const opens = m && (last === 0 ? n >= 1 && n <= 3 : n === last + 1);
      if (opens && m) {
        if (cur) out.push(cur);
        cur = { n: String(n), text: m[2].trim(), page: p.page };
        last = n;
      } else if (cur && line.trim()) {
        cur.text += (cur.text.endsWith("-") ? "" : " ") + line.trim();
      }
    }
  }
  if (cur) out.push(cur);
  return out.map((x) => ({ ...x, text: x.text.replace(/\s+/g, " ").trim() })).filter((x) => x.text.length > 0);
}

export type ReplyStance = "admitted" | "denied" | "not_admitted" | "matter_of_record" | "legal_submission" | "no_reply";

export const STANCE_LABEL: Record<ReplyStance, string> = {
  admitted: "Admitted",
  denied: "Denied",
  not_admitted: "Not admitted",
  matter_of_record: "Matter of record",
  legal_submission: "Legal submission",
  no_reply: "No reply needed",
};

export const STANCES = Object.keys(STANCE_LABEL) as ReplyStance[];

export interface ReplyEvidence { fileId: string; fileName: string; page: number | null; quote: string; quoteFound: boolean }

export interface ParaReply {
  n: string;
  paraText: string;
  page: number | null;
  /** What the model proposed (kept as proposed; the user's version is `stance` / `reply`). */
  proposed: { stance: ReplyStance; reply: string; reasoning: string; evidence: ReplyEvidence[]; droppedRefs: number } | null;
  stance: ReplyStance;
  reply: string;
  edited: boolean;
  /** Admissions bind the client: each one needs an explicit approval (by a person) before export. */
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
  return { n: p.n, paraText: p.text, page: p.page, proposed: null, stance: "no_reply", reply: "", edited: false, approved: false, approvedBy: null, approvedAt: null, status: "pending", error: null };
}

/** Why the reply cannot be exported yet (admissions awaiting approval), or null when it can. */
export function exportBlockers(paras: ParaReply[]): { unapprovedAdmissions: string[] } | null {
  const unapprovedAdmissions = paras.filter((p) => p.stance === "admitted" && !p.approved).map((p) => p.n);
  return unapprovedAdmissions.length ? { unapprovedAdmissions } : null;
}

const STANCE_OPENING: Record<ReplyStance, (n: string, doc: string) => string> = {
  admitted: (n, d) => `The contents of paragraph ${n} of the ${d} are admitted`,
  denied: (n, d) => `The contents of paragraph ${n} of the ${d} are denied`,
  not_admitted: (n, d) => `The contents of paragraph ${n} of the ${d} are not admitted, and the plaintiff is put to strict proof thereof`,
  matter_of_record: (n, d) => `The contents of paragraph ${n} of the ${d} are matters of record and need no reply, save as stated below`,
  legal_submission: (n, d) => `Paragraph ${n} of the ${d} contains legal submissions, which are denied as stated below`,
  no_reply: (n, d) => `Paragraph ${n} of the ${d} calls for no reply`,
};

/** The written-statement markdown (para-wise reply section). Throws when an admission is not approved. */
export function writtenStatementMarkdown(state: Pick<ParawiseState, "fileName" | "paras">, opts: { pleading?: "plaint" | "petition"; title?: string } = {}): string {
  const blockers = exportBlockers(state.paras);
  if (blockers) throw new Error(`Admissions in paragraph${blockers.unapprovedAdmissions.length === 1 ? "" : "s"} ${blockers.unapprovedAdmissions.join(", ")} need approval before export.`);
  const d = opts.pleading ?? "plaint";
  const lines: string[] = [`# ${opts.title ?? "WRITTEN STATEMENT — PARA-WISE REPLY"}`, "", `*Reply to the ${d}: ${state.fileName}. Draft for review.*`, "", "## PARA-WISE REPLY", ""];
  state.paras.forEach((p, i) => {
    const body = p.reply.trim();
    const opening = STANCE_OPENING[p.stance](p.n, d);
    const line = `${i + 1}. ${opening}${body ? `. ${body.replace(/^\s*(that\s+)?/i, "")}` : ""}`.trim();
    lines.push(/[.!?]$/.test(line) ? line : `${line}.`);
  });
  lines.push("", "*Paragraphs not specifically admitted above are denied.*");
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
