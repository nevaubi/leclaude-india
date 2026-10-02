/**
 * Practice tools: pure input parsing and plain-text formatting around the deterministic India libraries
 * (`@/lib/india/limitation`, `holidays`, `criminal-code-map`, `court-fees`). Client-safe; no I/O.
 *
 * Nothing here computes law: parsing turns what a lawyer types into the libraries' inputs, and formatting renders
 * their results (with every authority) as text for the clipboard. Anything unreadable is reported, never guessed.
 */
import type { ApplicableCode, CodeName, MapResult } from "@/lib/india/criminal-code-map";
import type { CourtFeeResult, CourtFeeTable, FeeSlab } from "@/lib/india/court-fees";
import { addCourtDays, addDays, compareIso, daysBetween, isCourtOpen, isValidIsoDate, nextOpenDay, parseIsoDate, SAMPLE_CALENDAR, type CourtCalendar, type IsoDate } from "@/lib/india/holidays";
import { normalizeCaseNumber } from "@/modules/official/case-numbers";
import type { CauseListEntry } from "@/modules/official/types";
import { strictDiaryNumber } from "@/modules/caselaw/shared";
import { formatFetchedAt, safeHttp } from "@/modules/official-ui/shared";
import type { ChequeDishonourResult, LimitationResult, LimitationRule, LimitationStep } from "@/lib/india/limitation";

export const DECISION_SUPPORT_FOOTER = "Decision support — verify against the Gazette text and the court's notified calendar.";

/* ───────────────────────────── dates ───────────────────────────── */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03-12" → "Thu, 12 Mar 2026" (calendar date, no time zone). Unparseable input is returned unchanged. */
export function formatIsoDate(iso: IsoDate | null | undefined): string {
  const d = parseIsoDate(iso ?? "");
  if (!d) return iso ?? "";
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* ───────────────────────────── section input ───────────────────────────── */

export interface SectionQuery { code: CodeName; section: string }
export interface ParsedSectionLine {
  lineNo: number;
  input: string;
  queries: SectionQuery[];
  errors: string[];
}

/**
 * Code names as lawyers write them. Dotted forms may not contain spaces between letters except after a dot
 * ("Cr. P.C."), so "BNS s. 318" is BNS and not BNSS. Order matters: BNSS before BNS.
 */
const CODE_PATTERNS: { code: CodeName; re: RegExp }[] = [
  { code: "BNSS", re: /(?<![a-z])(?:b\.?n\.?s\.?s\.?|bharatiya\s+nagarik\s+suraksha\s+sanhita(?:,?\s*2023)?)(?![a-z])/i },
  { code: "BNS", re: /(?<![a-z])(?:b\.?n\.?s\.?|bharatiya\s+nyaya\s+sanhita(?:,?\s*2023)?)(?![a-z])/i },
  { code: "BSA", re: /(?<![a-z])(?:b\.?s\.?a\.?|bharatiya\s+sakshya\s+adhiniyam(?:,?\s*2023)?)(?![a-z])/i },
  { code: "CrPC", re: /(?<![a-z])(?:cr\.?\s?p\.?\s?c\.?|code\s+of\s+criminal\s+procedure(?:,?\s*1973)?)(?![a-z])/i },
  { code: "IPC", re: /(?<![a-z])(?:i\.?p\.?c\.?|(?:indian\s+)?penal\s+code(?:,?\s*1860)?)(?![a-z])/i },
  { code: "IEA", re: /(?<![a-z])(?:i\.?e\.?a\.?|(?:indian\s+)?evidence\s+act(?:,?\s*1872)?)(?![a-z])/i },
];

/** One section designation: number, optional letter suffix (498A, 498-A), optional sub-sections "(3)", "(1)(a)". */
const SECTION_RE = /^(\d{1,3})(?:-?([A-Za-z]{1,2}))?((?:\([0-9A-Za-z]{1,4}\))*)$/;

/**
 * Parse one line such as "IPC 420", "302 IPC", "u/s 498-A IPC", "ss. 420, 406 r/w 120B IPC", "Cr.P.C. 438",
 * "BNS 318(4)", "Evidence Act 65B". Several sections of the same code on one line are expanded. A line naming no
 * code, or two codes, is an error: the converter never guesses which code a bare number belongs to.
 */
export function parseSectionLine(raw: string, lineNo = 1): ParsedSectionLine {
  const input = raw.trim();
  const out: ParsedSectionLine = { lineNo, input, queries: [], errors: [] };
  if (!input) return out;
  let rest = input.replace(/\br\s*\/\s*w\b/gi, ",").replace(/\bu\s*\/\s*s\.?/gi, " ");
  const found: CodeName[] = [];
  for (const { code, re } of CODE_PATTERNS) {
    const g = new RegExp(re.source, "gi");
    if (g.test(rest)) {
      found.push(code);
      rest = rest.replace(g, " ");
    }
  }
  if (found.length === 0) { out.errors.push("Name the code: IPC, CrPC, IEA, BNS, BNSS or BSA."); return out; }
  if (found.length > 1) { out.errors.push(`One code per line (found ${found.join(" and ")}).`); return out; }
  const code = found[0];
  rest = rest
    .replace(/\b(?:sections?|secs?|ss?)\b\.?/gi, " ")
    .replace(/\b(?:of\s+the|of|under|read\s+with|and|with)\b/gi, ",")
    .replace(/&/g, ",")
    .replace(/[§]/g, " ");
  const pieces = rest.split(/[,;/]+/).map((p) => p.replace(/\s+/g, "")).filter(Boolean);
  if (!pieces.length) { out.errors.push(`Give a section number of the ${code}.`); return out; }
  const seen = new Set<string>();
  for (const p of pieces) {
    const m = SECTION_RE.exec(p);
    if (!m) { out.errors.push(`Could not read "${p}" as a section number.`); continue; }
    const section = `${m[1]}${(m[2] ?? "").toUpperCase()}${m[3] ?? ""}`;
    if (seen.has(section)) continue;
    seen.add(section);
    out.queries.push({ code, section });
  }
  return out;
}

/** Parse pasted text, one line per entry (blank lines skipped). Capped at `max` non-empty lines. */
export function parseSectionList(text: string, max = 200): { lines: ParsedSectionLine[]; truncated: boolean } {
  const lines: ParsedSectionLine[] = [];
  const raw = text.split(/\r?\n/);
  let truncated = false;
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].trim()) continue;
    if (lines.length >= max) { truncated = true; break; }
    lines.push(parseSectionLine(raw[i], i + 1));
  }
  return { lines, truncated };
}

/* ───────────────────────────── court-fee slab tables ───────────────────────────── */

export interface SlabParseResult {
  slabs: FeeSlab[];
  minimum?: number;
  maximum?: number;
  errors: string[];
}

const OPEN_TOKENS = new Set(["", "-", "—", "*", "∞", "inf", "infinity", "open", "above", "and above", "rest", "null"]);

/** "₹1,00,000" / "1 00 000" / "100000.50" → number; null when not a plain non-negative amount. */
export function parseRupees(s: string): number | null {
  const t = s.replace(/₹|rs\.?|inr|\/-/gi, "").replace(/[,\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function validateSlabs(slabs: FeeSlab[], errors: string[]) {
  if (!slabs.length) errors.push("Enter at least one slab.");
  let prev = -Infinity;
  slabs.forEach((s, i) => {
    const label = `Slab ${i + 1}`;
    if (s.upTo === null && i !== slabs.length - 1) errors.push(`${label}: only the last slab may be open-ended.`);
    if (s.upTo !== null) {
      if (!(s.upTo > prev)) errors.push(`${label}: upper bounds must increase (${s.upTo} after ${prev === -Infinity ? "start" : prev}).`);
      prev = s.upTo;
    }
    if (s.rate === undefined && s.fixed === undefined) errors.push(`${label}: give a rate or a fixed fee.`);
    if (s.rate !== undefined && !(s.rate >= 0 && s.rate <= 1)) errors.push(`${label}: rate must be between 0% and 100%.`);
    if (s.fixed !== undefined && !(s.fixed >= 0)) errors.push(`${label}: fixed fee must be a non-negative amount.`);
  });
}

/**
 * Parse a slab table the user pastes. Two forms:
 *   rows   "upTo | rate % | fixed ₹" per line (tab, "|" or ";" separated; whitespace when none of those is present),
 *          upTo "above"/"-"/"∞" for the open last slab, rate as a percentage ("5" or "5%"), "#" comment lines and a
 *          header line are ignored. Rupee amounts may use Indian grouping ("1,00,000") inside a column.
 *   JSON   `{ "slabs": [{ "upTo": 100000, "rate": 0.05, "fixed": 0 }], "minimum": 10, "maximum": 1000 }` or a bare
 *          slab array; `rate` is a fraction as in `FeeSlab` (0.05 = 5%).
 * Nothing is defaulted: a cell that does not read cleanly is an error.
 */
export function parseSlabTable(text: string): SlabParseResult {
  const t = text.trim();
  const errors: string[] = [];
  if (!t) return { slabs: [], errors: ["Paste or enter the slab table for your court."] };
  if (t.startsWith("{") || t.startsWith("[")) {
    let data: unknown;
    try { data = JSON.parse(t); } catch { return { slabs: [], errors: ["Not valid JSON."] }; }
    const obj = (Array.isArray(data) ? { slabs: data } : data) as Record<string, unknown>;
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.slabs)) return { slabs: [], errors: ["JSON must be a slab array or an object with a \"slabs\" array."] };
    const slabs: FeeSlab[] = [];
    (obj.slabs as unknown[]).forEach((raw, i) => {
      const r = raw as Record<string, unknown>;
      if (!r || typeof r !== "object") { errors.push(`Slab ${i + 1}: not an object.`); return; }
      const num = (k: string): number | undefined | false => (r[k] === undefined || r[k] === null ? undefined : typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : false);
      const upTo = r.upTo === null || r.upTo === undefined ? null : typeof r.upTo === "number" && Number.isFinite(r.upTo) ? r.upTo : false;
      const rate = num("rate"), fixed = num("fixed");
      if (upTo === false || rate === false || fixed === false) { errors.push(`Slab ${i + 1}: upTo, rate and fixed must be numbers (upTo null for the last slab).`); return; }
      slabs.push({ upTo, ...(rate !== undefined ? { rate } : {}), ...(fixed !== undefined ? { fixed } : {}) });
    });
    const bound = (k: "minimum" | "maximum") => {
      if (obj[k] === undefined || obj[k] === null) return undefined;
      if (typeof obj[k] === "number" && Number.isFinite(obj[k]) && (obj[k] as number) >= 0) return obj[k] as number;
      errors.push(`${k} must be a non-negative number.`);
      return undefined;
    };
    const minimum = bound("minimum"), maximum = bound("maximum");
    validateSlabs(slabs, errors);
    return { slabs, minimum, maximum, errors };
  }

  const slabs: FeeSlab[] = [];
  const lines = t.split(/\r?\n/);
  let first = true;
  lines.forEach((line, idx) => {
    const l = line.trim();
    if (!l || l.startsWith("#")) return;
    const cols = (/[\t|;]/.test(l) ? l.split(/[\t|;]/) : l.split(/\s+/)).map((c) => c.trim());
    const isHeader = first && /[a-z]/i.test(cols[0]) && !OPEN_TOKENS.has(cols[0].toLowerCase());
    first = false;
    if (isHeader) return;
    const where = `Line ${idx + 1}`;
    if (cols.length > 3) { errors.push(`${where}: expected up to three columns (upTo, rate %, fixed ₹).`); return; }
    const [c0, c1 = "", c2 = ""] = cols;
    let upTo: number | null;
    if (OPEN_TOKENS.has(c0.toLowerCase())) upTo = null;
    else {
      const n = parseRupees(c0);
      if (n === null) { errors.push(`${where}: could not read the upper bound "${c0}".`); return; }
      upTo = n;
    }
    let rate: number | undefined;
    if (c1 && c1 !== "-") {
      const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(c1);
      if (!m) { errors.push(`${where}: could not read the rate "${c1}" (write 5 or 5% for five percent).`); return; }
      rate = Number(m[1]) / 100;
    }
    let fixed: number | undefined;
    if (c2 && c2 !== "-") {
      const n = parseRupees(c2);
      if (n === null) { errors.push(`${where}: could not read the fixed fee "${c2}".`); return; }
      fixed = n;
    }
    slabs.push({ upTo, ...(rate !== undefined ? { rate } : {}), ...(fixed !== undefined ? { fixed } : {}) });
  });
  validateSlabs(slabs, errors);
  return { slabs, errors };
}

export interface FeeTableMeta {
  label: string;
  act: string;
  article: string;
  source: string;
  effectiveFrom?: string;
  minimum?: number;
  maximum?: number;
  verified: boolean;
}

/**
 * Build a `CourtFeeTable` from a parsed slab table and what the user said about it. `verified` is honoured only with
 * a stated source: a tick without a source is an error, not a verified table.
 */
export function buildFeeTable(parsed: SlabParseResult, meta: FeeTableMeta): { table: CourtFeeTable | null; errors: string[] } {
  const errors = [...parsed.errors];
  const source = meta.source.trim();
  if (meta.verified && !source) errors.push("Name the source you verified the table against (Gazette notification, Act and Schedule) before marking it verified.");
  if (meta.minimum !== undefined && meta.maximum !== undefined && meta.minimum > meta.maximum) errors.push("Minimum fee exceeds the maximum.");
  if (errors.length) return { table: null, errors };
  return {
    table: {
      id: meta.label.trim() || "user-table",
      act: meta.act.trim() || "Act not stated",
      article: meta.article.trim() || "Article not stated",
      slabs: parsed.slabs,
      minimum: meta.minimum ?? parsed.minimum,
      maximum: meta.maximum ?? parsed.maximum,
      effectiveFrom: meta.effectiveFrom?.trim() || undefined,
      verified: meta.verified && !!source,
      source: source || "user-entered table, source not stated",
    },
    errors: [],
  };
}

/* ───────────────────────────── plain-text formatting (Copy) ───────────────────────────── */

const stepLine = (s: LimitationStep, i: number) => `${i + 1}. ${s.text}${s.authority ? ` [${s.authority}]` : ""}`;

const STATUS_TEXT: Record<string, string> = {
  computed: "Computed",
  requires_verification: "Requires verification",
  no_fixed_period: "No fixed period",
  invalid_input: "Invalid input",
};
export const statusText = (s: string) => STATUS_TEXT[s] ?? s;

const S4_TEXT: Record<LimitationResult["s4"], string> = {
  applied: "s.4 court-closed adjustment applied from the selected calendar",
  not_needed: "s.4 checked: court open on the last day per the selected calendar",
  not_checked: "s.4 holiday adjustment NOT checked (no court calendar selected)",
  calendar_unknown: "s.4 holiday adjustment could not be checked: the calendar does not cover the date",
};
export const s4Text = (s: LimitationResult["s4"]) => S4_TEXT[s];

export function condonableText(c: boolean | "special"): string {
  return c === true ? "Delay condonable on sufficient cause (Limitation Act, 1963, s.5)" : c === "special" ? "Extension only as the special law provides (s.5 Limitation Act not applicable as such)" : "Not condonable: s.5 does not extend time";
}

function tail(lines: string[], uncertain: string[], notes: string[]) {
  if (uncertain.length) lines.push("", "Requires verification:", ...uncertain.map((u) => `- ${u}`));
  if (notes.length) lines.push("", "Notes:", ...notes.map((n) => `- ${n}`));
  lines.push("", DECISION_SUPPORT_FOOTER);
  return lines.join("\n");
}

export function limitationToText(rule: LimitationRule, r: LimitationResult, calendarLabel: string): string {
  const last = r.adjustedLastDay ?? r.lastDay;
  const lines = [
    `Limitation: ${rule.title}`,
    `Authority: ${rule.authority}`,
    `Status: ${statusText(r.status)}`,
  ];
  if (r.startDate) lines.push(`Runs from (${rule.runsFrom}): ${formatIsoDate(r.startDate)} (${r.startDate})`);
  if (last) lines.push(`Last day for filing: ${formatIsoDate(last)} (${last})${r.adjustedLastDay && r.adjustedLastDay !== r.lastDay ? `; period itself ended ${r.lastDay}` : ""}`);
  if (r.excludedDays) lines.push(`Certified-copy time excluded: ${r.excludedDays} day(s)`);
  if (r.status !== "invalid_input" && r.status !== "no_fixed_period") lines.push(`Court calendar: ${calendarLabel}; ${s4Text(r.s4)}`);
  lines.push(`Condonation: ${condonableText(r.condonable)}`);
  if (r.steps.length) lines.push("", "Steps:", ...r.steps.map(stepLine));
  return tail(lines, r.uncertain, r.notes);
}

export function chequeToText(r: ChequeDishonourResult, calendarLabel: string): string {
  const lines = ["Cheque dishonour timeline (Negotiable Instruments Act, 1881, ss.138 and 142)", `Status: ${statusText(r.status)}`];
  if (r.noticeDeadline) lines.push(`Demand notice by: ${formatIsoDate(r.noticeDeadline)} (${r.noticeDeadline}) [s.138 proviso (b)]`);
  if (r.paymentWindowEnds) lines.push(`Drawer's 15-day payment window ends: ${formatIsoDate(r.paymentWindowEnds)} (${r.paymentWindowEnds}) [s.138 proviso (c)]`);
  if (r.earliestComplaint) lines.push(`Earliest complaint: ${formatIsoDate(r.earliestComplaint)} (${r.earliestComplaint})`);
  const last = r.adjustedComplaintLastDay ?? r.complaintLastDay;
  if (last) lines.push(`Complaint last day: ${formatIsoDate(last)} (${last}) [s.142(1)(b)]`);
  if (r.complaintLastDay) lines.push(`Court calendar: ${calendarLabel}`);
  if (r.steps.length) lines.push("", "Steps:", ...r.steps.map(stepLine));
  return tail(lines, r.uncertain, r.notes);
}

export function arbitrationToText(r: LimitationResult & { outerLimit?: IsoDate }, calendarLabel: string): string {
  const last = r.adjustedLastDay ?? r.lastDay;
  const lines = ["Application to set aside an arbitral award (Arbitration and Conciliation Act, 1996, s.34(3))", `Status: ${statusText(r.status)}`];
  if (r.startDate) lines.push(`Award received: ${formatIsoDate(r.startDate)} (${r.startDate})`);
  if (last) lines.push(`Three months end: ${formatIsoDate(last)} (${last}) [s.34(3)]`);
  if (r.outerLimit) lines.push(`Outer limit with the further 30 days on sufficient cause, "but not thereafter": ${formatIsoDate(r.outerLimit)} (${r.outerLimit}) [s.34(3) proviso]`);
  if (r.status !== "invalid_input") lines.push(`Court calendar: ${calendarLabel}; ${s4Text(r.s4)}`);
  if (r.steps.length) lines.push("", "Steps:", ...r.steps.map(stepLine));
  return tail(lines, r.uncertain, r.notes);
}

export interface MappingRow { lineNo: number; input: string; query?: SectionQuery; result?: MapResult; error?: string }

/** Flatten parsed lines into one row per query (or per unreadable line). */
export function mappingRows(lines: ParsedSectionLine[], map: (q: SectionQuery) => MapResult): MappingRow[] {
  const rows: MappingRow[] = [];
  for (const l of lines) {
    for (const q of l.queries) rows.push({ lineNo: l.lineNo, input: l.input, query: q, result: map(q) });
    for (const e of l.errors) rows.push({ lineNo: l.lineNo, input: l.input, error: e });
  }
  return rows;
}

const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();

export function candidatesText(r: MapResult): string {
  return r.candidates.map((c) => `${c.code} ${c.section}${c.note ? ` (${c.note})` : ""}`).join("; ");
}

/** Tab-separated table with a header row: pastes into a spreadsheet or a Word table. */
export function mappingRowsToTsv(rows: MappingRow[]): string {
  const head = ["Input", "Provision", "Status", "Corresponding provision(s)", "Subject", "Confidence", "Notes"];
  const body = rows.map((r) => {
    if (!r.result || !r.query) return [r.input, "", "unreadable", "", "", "", r.error ?? ""];
    const res = r.result;
    return [
      r.input,
      `${r.query.code} ${res.query.section}`,
      res.status,
      res.status === "unmapped" ? "none in the coded table" : candidatesText(res),
      res.subject ?? "",
      res.confidence ?? "",
      res.notes.join(" "),
    ];
  });
  const src = rows.find((r) => r.result)?.result?.source;
  const out = [head, ...body].map((cols) => cols.map(clean).join("\t"));
  if (src) out.push("", `Source: ${src}`);
  out.push(DECISION_SUPPORT_FOOTER);
  return out.join("\n");
}

export function applicableToText(offence: string, proceeding: string, a: ApplicableCode, evidence?: { code: string; note: string }): string {
  const lines = ["Which code applies (new criminal codes in force 1 July 2024)"];
  if (offence) lines.push(`Offence date: ${offence}`);
  if (proceeding) lines.push(`Proceeding initiated: ${proceeding}`);
  lines.push(`Substantive law: ${a.substantive === "requires_review" ? "requires review" : a.substantive}`);
  if (a.procedure) lines.push(`Procedure: ${a.procedure === "requires_review" ? "requires review" : a.procedure}`);
  if (evidence) lines.push(`Evidence: ${evidence.code === "requires_review" ? "requires review" : evidence.code} (${evidence.note})`);
  if (a.notes.length) lines.push("", "Notes:", ...a.notes.map((n) => `- ${n}`));
  lines.push("", "Authority: Constitution of India, Art. 20(1); BNSS, 2023, s.531; BSA, 2023, s.170", DECISION_SUPPORT_FOOTER);
  return lines.join("\n");
}

export function feeToText(amount: number, table: CourtFeeTable, r: CourtFeeResult): string {
  const lines = [
    `Court fee: ${table.act}, ${table.article}`,
    `Table: ${table.id}${table.effectiveFrom ? ` (effective ${table.effectiveFrom})` : ""}`,
    `Source: ${table.source}`,
    `Verified by user against the source: ${table.verified ? "yes" : "no"}`,
    `Status: ${statusText(r.status)}`,
    `Amount / valuation: ₹${amount.toLocaleString("en-IN")}`,
  ];
  if (r.fee !== undefined) lines.push(`Fee: ₹${r.fee.toLocaleString("en-IN")}`);
  if (r.steps.length) lines.push("", "Steps:", ...r.steps.map((s, i) => `${i + 1}. ${s}`));
  return tail(lines, [], r.notes);
}

/* ───────────────────────────── court calendars ───────────────────────────── */

/** Forums whose notified calendars the official-sources corpus can hold (GET /api/official/calendars?forum=). */
export const COURT_CALENDAR_FORUMS: { forum: string; label: string; short: string }[] = [
  { forum: "sci", label: "Supreme Court of India", short: "Supreme Court" },
  { forum: "hc-delhi", label: "High Court of Delhi", short: "Delhi HC" },
  { forum: "hc-karnataka", label: "High Court of Karnataka", short: "Karnataka HC" },
  { forum: "nclt", label: "National Company Law Tribunal", short: "NCLT" },
  { forum: "nclat", label: "National Company Law Appellate Tribunal", short: "NCLAT" },
];

/** Shown whenever an official court calendar is used, and in every copied result that uses one. */
export const CALENDAR_CAVEAT = "Ad-hoc holidays and shifted sittings are notified separately — check the court's notices.";

/**
 * A calendar source as returned by /api/official/calendars. `ocr` / `note` / `notes` are optional: the API marks a source
 * whose dates were read by OCR from a scanned list; older responses carry none of them.
 */
export interface CalendarSourceRef { documentId: string; url: string; fetchedAt: string | null; years: number[]; ocr?: boolean | null; note?: string | null; notes?: string[] | null }

/** GET /api/official/calendars response. `calendar` is null when no official calendar is loaded for those years. */
export interface OfficialCalendarResponse { calendar: CourtCalendar | null; sources: CalendarSourceRef[]; forum: string | null; notes: string[] }

/** Calendar choice in the tools: none, the illustrative sample, or a forum's official calendar ("official:hc-delhi"). */
export type CalendarChoice = "none" | "sample" | `official:${string}`;

export function officialChoice(forum: string): CalendarChoice {
  return `official:${forum}`;
}

/** The forum of an official choice ("official:sci" → "sci"); null for none / sample / anything else. */
export function choiceForum(c: string): string | null {
  const m = /^official:([a-z][a-z0-9-]{1,40})$/.exec(c);
  return m ? m[1] : null;
}

/** Years to ask the calendar API for around `today` (the previous, current and next year). */
export function calendarYears(today: IsoDate): number[] {
  const y = Number(today.slice(0, 4));
  return Number.isInteger(y) ? [y - 1, y, y + 1] : [];
}

/** The calendar behind a choice: the sample, a loaded official calendar, or undefined (none / not loaded). */
export function resolveCalendar(c: CalendarChoice, official: Record<string, OfficialCalendarResponse | undefined>): CourtCalendar | undefined {
  if (c === "sample") return SAMPLE_CALENDAR;
  const forum = choiceForum(c);
  return forum ? official[forum]?.calendar ?? undefined : undefined;
}

/** The calendar date in India (IST) of a timestamp ("2026-09-03T20:00:00Z" → "2026-09-04"); a bare date is kept; null when unreadable. */
export function istDate(ts: string | null | undefined): IsoDate | null {
  if (!ts) return null;
  const t = ts.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isValidIsoDate(t) ? t : null;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

/** "3 Sep 2026" from a fetch timestamp, as the date in India; null when absent. */
export function fetchedDate(ts: string | null | undefined): string | null {
  const d = istDate(ts);
  return d ? formatIsoDate(d).replace(/^\w{3}, /, "") : null;
}

/** "delhihighcourt.nic.in/files/calendar-2026.pdf" for display. */
export function hostPath(url: string): string {
  try { const u = new URL(url); return `${u.host}${u.pathname.length > 1 ? u.pathname : ""}`; } catch { return url; }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SATURDAY = 6;

/** The calendar's weekly offs, stated from its data (not from prose), with what that means for Saturdays. */
export function weeklyOffNote(cal: Pick<CourtCalendar, "weeklyOff">): string {
  const days = [...new Set(cal.weeklyOff)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b).map((d) => DAY_NAMES[d]);
  const base = `Weekly off in this calendar: ${days.length ? days.join(" and ") : "none recorded"}.`;
  return cal.weeklyOff.includes(SATURDAY)
    ? base
    : `${base} Saturdays are not marked closed, so a Saturday counts as a court working day unless it is a listed holiday; whether the court sits on a given Saturday is not established by this calendar.`;
}

/**
 * The server's explanatory notes about an official calendar (weekly-off practice, partial and notified working days),
 * i.e. `calendar.source` without its first sentence, which only repeats the sources and their fetch dates (shown
 * separately, in India time). If the text does not start with that sentence it is returned whole.
 */
export function calendarSourceNotes(cal: Pick<CourtCalendar, "source" | "sample">): string | null {
  const src = (cal.source ?? "").replace(/\s+/g, " ").trim();
  if (!src || cal.sample) return null;
  const m = /^[^:]{1,120}: official calendar data for [^]*?\.(?: |$)/.exec(src);
  const rest = (m ? src.slice(m[0].length) : src).trim();
  return rest || null;
}

/**
 * OCR warnings for an official calendar: one per source the API marks as read by OCR (`ocr: true`, or a note that
 * mentions OCR), plus any response note that mentions OCR. Empty when nothing says OCR.
 */
export function calendarOcrNotes(r: OfficialCalendarResponse | undefined | null): string[] {
  if (!r) return [];
  const out: string[] = [];
  const mentionsOcr = (x: unknown): x is string => typeof x === "string" && /\bOCR\b/i.test(x);
  for (const s of r.sources ?? []) {
    const sourceNotes = [s.note, ...(Array.isArray(s.notes) ? s.notes : [])].filter(mentionsOcr);
    if (s.ocr !== true && !sourceNotes.length) continue;
    const url = safeHttp(s.url);
    const where = url ? hostPath(url) : "a calendar source";
    out.push(`Dates from ${where} were read by OCR from a scanned list and may be misread: check them against the PDF.${sourceNotes.length ? ` (${sourceNotes.join(" ")})` : ""}`);
  }
  for (const n of r.notes ?? []) if (mentionsOcr(n) && !out.includes(n)) out.push(n);
  return out;
}

/** True when an official calendar response says some of its dates came from OCR. */
export function calendarHasOcr(r: OfficialCalendarResponse | undefined | null): boolean {
  return calendarOcrNotes(r).length > 0;
}

/** Plain-text label of a choice for copied results: what calendar, from where, fetched when, its weekly offs, notes and the caveat. */
export function describeCalendarChoice(c: CalendarChoice, official: Record<string, OfficialCalendarResponse | undefined>): string {
  if (c === "none") return "None selected";
  if (c === "sample") return `Sample calendar "${SAMPLE_CALENDAR.id}" (illustrative; not a court's notified calendar). ${weeklyOffNote(SAMPLE_CALENDAR)}`;
  const forum = choiceForum(c);
  const f = COURT_CALENDAR_FORUMS.find((x) => x.forum === forum);
  const r = forum ? official[forum] : undefined;
  if (!forum || !r?.calendar) return `${f?.label ?? forum ?? "Court"}: official calendar not loaded (court holidays not checked)`;
  const src = r.sources.map((s) => `${safeHttp(s.url) ?? "(source link not a web address)"}${fetchedDate(s.fetchedAt) ? ` (fetched ${fetchedDate(s.fetchedAt)} IST)` : ""}`).join("; ");
  const notes = calendarSourceNotes(r.calendar);
  return [
    `${f?.label ?? forum} official calendar for ${r.calendar.years.join(", ")}${src ? ` from ${src}` : ""}.`,
    weeklyOffNote(r.calendar),
    notes ? `Calendar notes: ${notes}` : "",
    ...calendarOcrNotes(r),
    CALENDAR_CAVEAT,
  ].filter(Boolean).join(" ");
}

/**
 * Marks a computed result as requiring verification when the calendar behind it carries caveats (dates read by OCR),
 * adding them to the result's uncertain points. Invalid input and "no fixed period" results are returned unchanged.
 */
export function withCalendarCaveats<T extends { status: string; uncertain: string[] }>(r: T, caveats: string[]): T {
  if (!caveats.length || r.status === "invalid_input" || r.status === "no_fixed_period") return r;
  const uncertain = [...r.uncertain, ...caveats.filter((c) => !r.uncertain.includes(c))];
  return { ...r, status: (r.status === "computed" ? "requires_verification" : r.status) as T["status"], uncertain };
}

/* ───────────────────────────── court working days ───────────────────────────── */

/** Extra caveats a court-days computation carries (e.g. OCR-read calendar dates); any caveat makes the result "requires verification". */
export interface CourtDaysOptions { caveats?: string[] }

export interface CourtDaysResult {
  status: "computed" | "requires_verification" | "invalid_input";
  /** Court working days counted (null when the calendar could not answer for a day in the range). */
  open: number | null;
  /** Calendar days in the range. */
  days: number;
  closed: { date: IsoDate; reason: string }[];
  /** First day the calendar cannot answer for (outside its years); counting stops there. */
  unknown: { date: IsoDate; reason: string } | null;
  /** What the result depends on that the calendar does not establish (Saturday sittings, OCR-read dates). */
  uncertain: string[];
  notes: string[];
}

const MAX_COUNT_DAYS = 3 * 366;

/** The same calendar with Saturdays closed, to test whether a result depends on Saturday sittings; null when they already are. */
function saturdaysOff(cal: CourtCalendar): CourtCalendar | null {
  return cal.weeklyOff.includes(SATURDAY) ? null : { ...cal, weeklyOff: [...cal.weeklyOff, SATURDAY] };
}

function finish<T extends { status: "computed" | "requires_verification" | "invalid_input"; uncertain: string[] }>(r: T, cal: CourtCalendar, opts?: CourtDaysOptions): T {
  const caveats = (opts?.caveats ?? []).filter((c) => !r.uncertain.includes(c));
  const uncertain = [...r.uncertain, ...caveats];
  const status = r.status === "invalid_input" ? r.status : cal.sample || uncertain.length ? "requires_verification" : r.status;
  return { ...r, status, uncertain };
}

/**
 * Court working days from `from` to `to`, both days included, under `cal`. A day the calendar cannot answer for
 * (outside its years) stops the count: the result is "requires verification" with no number, never a guess. When the
 * count includes Saturdays that the calendar merely does not mark closed, the result requires verification and states
 * the count with Saturdays closed.
 */
export function countCourtDays(from: IsoDate, to: IsoDate, cal: CourtCalendar, opts?: CourtDaysOptions): CourtDaysResult {
  const empty = { open: null, closed: [], unknown: null, uncertain: [] };
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) return { status: "invalid_input", days: 0, ...empty, notes: ["Enter both dates in full."] };
  if (compareIso(from, to) > 0) return { status: "invalid_input", days: 0, ...empty, notes: ["The start date is after the end date."] };
  const days = daysBetween(from, to) + 1;
  if (days > MAX_COUNT_DAYS) return { status: "invalid_input", days, ...empty, notes: [`Ranges are limited to ${MAX_COUNT_DAYS} days.`] };
  const closed: { date: IsoDate; reason: string }[] = [];
  let open = 0;
  let saturdays = 0;
  for (let i = 0, d = from; i < days; i++, d = addDays(d, 1)) {
    const st = isCourtOpen(d, cal);
    if (st.open === "unknown") return finish({ status: "requires_verification", open: null, days, closed, unknown: { date: d, reason: st.reason }, uncertain: [`The calendar cannot answer for ${d} (${st.reason}); the count stops there.`], notes: [] }, cal, opts);
    if (st.open) {
      open++;
      if (parseIsoDate(d)!.getUTCDay() === SATURDAY) saturdays++;
    } else closed.push({ date: d, reason: st.reason });
  }
  const notes: string[] = [];
  const uncertain: string[] = [];
  if (cal.sample) notes.push("Sample calendar: Sundays and three national holidays only. It is not the court's notified calendar.");
  if (saturdays && !cal.weeklyOff.includes(SATURDAY)) {
    uncertain.push(`${saturdays} Saturday${saturdays === 1 ? " is counted as a court working day" : "s are counted as court working days"} because the calendar does not mark ${saturdays === 1 ? "it" : "them"} closed. If the court does not sit on ${saturdays === 1 ? "that Saturday" : "those Saturdays"}, the count is ${open - saturdays}.`);
  }
  notes.push("Both the start and the end date are counted.");
  return finish({ status: "computed", open, days, closed, unknown: null, uncertain, notes }, cal, opts);
}

export interface NextCourtDayResult { status: "computed" | "requires_verification" | "invalid_input"; date: IsoDate | null; skipped: { date: IsoDate; reason: string }[]; uncertain: string[]; notes: string[] }

/**
 * The first court working day on or after `date` under the notified calendar `cal` (null with the reason when it cannot
 * say). A Saturday answer that rests only on the calendar not marking Saturdays closed requires verification, and the
 * next day with Saturdays closed is given.
 */
export function nextCourtDay(date: IsoDate, cal: CourtCalendar, opts?: CourtDaysOptions): NextCourtDayResult {
  if (!isValidIsoDate(date)) return { status: "invalid_input", date: null, skipped: [], uncertain: [], notes: ["Enter the date in full."] };
  const r = nextOpenDay(date, cal);
  if (!r.date) return finish({ status: "requires_verification", date: null, skipped: r.skipped, uncertain: [r.unknown ? `The calendar cannot say: ${r.unknown}.` : "No court working day found."], notes: [] }, cal, opts);
  const uncertain: string[] = [];
  const alt = saturdaysOff(cal);
  if (alt && parseIsoDate(r.date)!.getUTCDay() === SATURDAY) {
    const a = nextOpenDay(date, alt);
    uncertain.push(`${formatIsoDate(r.date)} is a Saturday that the calendar does not mark closed. If the court does not sit that day, the next court working day is ${a.date ? `${formatIsoDate(a.date)} (${a.date})` : "not determined by the calendar"}.`);
  }
  return finish({ status: "computed", date: r.date, skipped: r.skipped, uncertain, notes: cal.sample ? ["Sample calendar: not the court's notified calendar."] : [] }, cal, opts);
}

export interface AddWorkingDaysResult { status: "computed" | "requires_verification" | "invalid_input"; date: IsoDate | null; uncertain: string[]; notes: string[] }

/**
 * `date` plus `n` court working days (the start day is not counted); null with the reason when the calendar cannot
 * say. When Saturdays the calendar does not mark closed change the answer, it requires verification and the date with
 * Saturdays closed is given.
 */
export function addWorkingDays(date: IsoDate, n: number, cal: CourtCalendar, opts?: CourtDaysOptions): AddWorkingDaysResult {
  if (!isValidIsoDate(date)) return { status: "invalid_input", date: null, uncertain: [], notes: ["Enter the date in full."] };
  if (!Number.isInteger(n) || n < 1 || n > 500) return { status: "invalid_input", date: null, uncertain: [], notes: ["Give a whole number of court working days from 1 to 500."] };
  const r = addCourtDays(date, n, cal);
  if (!r) return finish({ status: "requires_verification", date: null, uncertain: ["The calendar does not cover every day needed (check its years)."], notes: [] }, cal, opts);
  const uncertain: string[] = [];
  const alt = saturdaysOff(cal);
  const a = alt ? addCourtDays(date, n, alt) : r;
  if (a !== r) uncertain.push(`The count treats Saturdays that the calendar does not mark closed as court working days. If the court does not sit on them, the result is ${a ? `${formatIsoDate(a)} (${a})` : "not determined by the calendar"}.`);
  return finish({ status: "computed", date: r, uncertain, notes: ["The start day is not counted.", ...(cal.sample ? ["Sample calendar: not the court's notified calendar."] : [])] }, cal, opts);
}

export function courtDaysToText(input: { from: IsoDate; to: IsoDate }, r: CourtDaysResult, calendarLabel: string): string {
  const lines = [`Court working days under the notified calendar: ${formatIsoDate(input.from)} to ${formatIsoDate(input.to)} (both included)`, `Status: ${statusText(r.status)}`, `Calendar: ${calendarLabel}`];
  if (r.open != null) lines.push(`Court working days: ${r.open} of ${r.days} calendar days`);
  if (r.unknown) lines.push(`Not counted: the calendar cannot answer for ${r.unknown.date} (${r.unknown.reason})`);
  if (r.closed.length) lines.push("", "Days closed under the calendar:", ...r.closed.map((c) => `- ${c.date} ${formatIsoDate(c.date)}: ${c.reason}`));
  return tail(lines, r.uncertain, r.notes);
}

export function nextCourtDayToText(from: IsoDate, r: NextCourtDayResult, calendarLabel: string): string {
  const lines = [
    `Next court working day on or after ${formatIsoDate(from)}, under the notified calendar`,
    `Status: ${statusText(r.status)}`,
    `Calendar: ${calendarLabel}`,
    r.date ? `Next court working day: ${formatIsoDate(r.date)} (${r.date})` : "Next court working day: not determined",
  ];
  if (r.skipped.length) lines.push("", "Skipped (closed under the calendar):", ...r.skipped.map((d) => `- ${d.date} ${formatIsoDate(d.date)}: ${d.reason}`));
  return tail(lines, r.uncertain, r.notes);
}

export function addWorkingDaysToText(from: IsoDate, n: number | string, r: AddWorkingDaysResult, calendarLabel: string): string {
  const lines = [
    `${n} court working day(s) after ${formatIsoDate(from)}, under the notified calendar`,
    `Status: ${statusText(r.status)}`,
    `Calendar: ${calendarLabel}`,
    r.date ? `Result: ${formatIsoDate(r.date)} (${r.date})` : "Result: not determined",
  ];
  return tail(lines, r.uncertain, r.notes);
}

/* ───────────────────────────── condonation of delay ───────────────────────────── */

export interface DelayResult {
  status: "within_time" | "delayed" | "invalid_input";
  /** Days after the last day of limitation (0 when filed on or before it). */
  days: number;
  notes: string[];
}

/**
 * Delay in days between the last day of limitation and the filing date. Filing on the last day is within time; each
 * later day adds one. Says nothing about whether the delay will be condoned.
 */
export function condonationDelay(lastDay: IsoDate, filedOn: IsoDate): DelayResult {
  if (!isValidIsoDate(lastDay) || !isValidIsoDate(filedOn)) return { status: "invalid_input", days: 0, notes: ["Enter both dates in full."] };
  const d = daysBetween(lastDay, filedOn);
  if (d <= 0) return { status: "within_time", days: 0, notes: [d === 0 ? "Filed on the last day of limitation." : `Filed ${-d} day(s) before the last day of limitation.`] };
  return { status: "delayed", days: d, notes: [] };
}

/** The plain-language note under a delay result; never a prediction. */
export function delayNote(r: DelayResult, condonable?: boolean | "special"): string {
  if (r.status === "invalid_input") return r.notes.join(" ");
  if (r.status === "within_time") return "No delay to explain: the filing date is not after the last day of limitation (assuming that last day is right — check it, including any court-closed adjustment under s.4).";
  const base = `The filing is ${r.days} day${r.days === 1 ? "" : "s"} late. An application for condonation must explain the whole period of delay, usually day by day for the period after the last day. Whether the cause shown is sufficient is for the court; this tool does not assess it or predict the outcome.`;
  if (condonable === false) return `${base} For the selected proceeding, s.5 of the Limitation Act does not extend time.`;
  if (condonable === "special") return `${base} For the selected proceeding, any extension is only as the special law provides.`;
  return base;
}

export function delayToText(input: { lastDay: IsoDate; filedOn: IsoDate; proceeding?: string; authority?: string }, r: DelayResult, condonable?: boolean | "special"): string {
  const lines = ["Delay in filing"];
  if (input.proceeding) lines.push(`Proceeding: ${input.proceeding}${input.authority ? ` (${input.authority})` : ""}`);
  lines.push(`Last day of limitation: ${formatIsoDate(input.lastDay)} (${input.lastDay})`, `Filed on: ${formatIsoDate(input.filedOn)} (${input.filedOn})`);
  lines.push(r.status === "delayed" ? `Delay: ${r.days} day(s)` : r.status === "within_time" ? "Delay: none (within time)" : "Delay: not computed");
  if (condonable !== undefined) lines.push(`Condonation: ${condonableText(condonable)}`);
  lines.push("", delayNote(r, condonable));
  return tail(lines, [], r.notes);
}

/* ───────────────────────────── cause lists ───────────────────────────── */

/** Forums the cause-list search offers (GET /api/official/causelists?forum=). */
export const CAUSE_LIST_FORUMS: { forum: string; label: string; diary: boolean }[] = [
  { forum: "sci", label: "Supreme Court of India", diary: true },
  { forum: "hc-delhi", label: "High Court of Delhi", diary: false },
  { forum: "nclt", label: "NCLT (all benches)", diary: false },
  { forum: "nclat", label: "NCLAT (both benches)", diary: false },
];

/** Entries asked for per search; when this many come back the list may be cut short and the UI says so. */
export const CAUSE_LIST_LIMIT = 200;

export interface CauseListSearch { forum: string; date: string; caseNumber: string; diary: string; advocate: string }

/**
 * Query string for /api/official/causelists, or the reason the search cannot be run. Case and diary numbers must read
 * as one exact number (they are matched exactly, never fuzzily); a date or an identifier is required.
 *
 * - NCLT numbers repeat at every bench, so an NCLT case number must carry its bench code as printed
 *   ("CP(IB)/29(MB)2022") and is sent as the bench-qualified key ("CPIB/29/2022@MB").
 * - The diary field takes one diary number only ("54583/2026", "Diary No. 54583-2026"); it is sent normalized, so a
 *   case number typed there ("W.P.(C) 12/2026") is refused rather than read as diary 12/2026.
 */
export function causeListQuery(s: CauseListSearch): { qs: string | null; error: string | null } {
  const sp = new URLSearchParams();
  const forum = CAUSE_LIST_FORUMS.find((f) => f.forum === s.forum);
  if (!forum) return { qs: null, error: "Choose a court or tribunal." };
  sp.set("forum", forum.forum);
  const date = s.date.trim();
  if (date && !isValidIsoDate(date)) return { qs: null, error: "Enter the list date in full." };
  if (date) sp.set("date", date);
  const cn = s.caseNumber.trim();
  if (cn) {
    const n = normalizeCaseNumber(cn);
    if (!n) return { qs: null, error: `"${cn}" is not one recognisable case number (e.g. SLP(C) No. 1234/2026, W.P.(C) 5812/2016).` };
    if (n.bench) {
      if (forum.forum !== "nclt") return { qs: null, error: `"${cn}" is an NCLT number (bench code ${n.bench}): choose NCLT.` };
      sp.set("case", `${n.key}@${n.bench}`);
    } else if (forum.forum === "nclt") {
      return { qs: null, error: "NCLT numbers repeat at every bench: give the number with its bench code as printed, e.g. CP(IB)/29(MB)2022." };
    } else sp.set("case", cn);
  }
  const diaryInput = s.diary.trim();
  if (diaryInput) {
    if (!forum.diary) return { qs: null, error: "Diary numbers are used by the Supreme Court only." };
    const diary = strictDiaryNumber(diaryInput);
    if (!diary) return { qs: null, error: `"${diaryInput}" is not a diary number (e.g. 54583/2026). Put a case number in the case number field.` };
    sp.set("diary", diary);
  }
  const adv = s.advocate.replace(/\s+/g, " ").trim();
  if (adv) {
    if (adv.length < 3) return { qs: null, error: "Give the advocate's name as printed (at least 3 letters)." };
    sp.set("advocate", adv.slice(0, 120));
  }
  if (!date && !cn && !diaryInput) return { qs: null, error: "Give a list date, or a case or diary number." };
  sp.set("limit", String(CAUSE_LIST_LIMIT));
  return { qs: sp.toString(), error: null };
}

const FORUM_LABEL: Record<string, string> = {
  sci: "Supreme Court of India",
  "hc-delhi": "High Court of Delhi",
  "hc-karnataka": "High Court of Karnataka",
  nclt: "NCLT (bench not printed)",
  nclat: "NCLAT (bench not printed)",
  "nclt-principal": "NCLT Principal Bench, New Delhi",
  "nclat-delhi": "NCLAT Principal Bench, New Delhi",
  "nclat-chennai": "NCLAT Chennai Bench",
};

const titleWords = (slug: string) => slug.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** The court or bench a cause-list entry belongs to, from its forum key ("nclt-mumbai" → "NCLT Mumbai Bench"). */
export function causeListForumLabel(forum: string | null | undefined): string {
  const f = (forum ?? "").trim().toLowerCase();
  if (!f) return "Forum not recorded";
  if (FORUM_LABEL[f]) return FORUM_LABEL[f];
  let m = /^(nclt|nclat)-([a-z0-9-]+)$/.exec(f);
  if (m) return `${m[1].toUpperCase()} ${titleWords(m[2])} Bench`;
  m = /^hc-([a-z-]+)$/.exec(f);
  if (m) return `High Court of ${titleWords(m[1])}`;
  return f;
}

const LIST_TYPE: Record<string, string> = { main: "Main list", supplementary: "Supplementary list", advance: "Advance list", weekly: "Weekly list", daily: "Daily list", other: "List" };

export function listTypeLabel(t: string | null | undefined): string {
  return (t && LIST_TYPE[t]) || "List";
}

/** One cause-list entry as plain text: its forum, list, item and either the parsed fields or the line as printed. */
export function causeListEntryText(e: CauseListEntry): string {
  const head = `${causeListForumLabel(e.forum)} · ${formatIsoDate(e.listDate)} · ${listTypeLabel(e.listType)}${e.courtNo ? ` · Court ${e.courtNo}` : ""}${e.itemNo ? ` · Item ${e.itemNo}` : ""}${e.page != null ? ` · p. ${e.page}` : ""}`;
  const body = e.parsed
    ? [
      e.caseNumbers.length ? e.caseNumbers.map((c) => c.printed).join("; ") : "Case number not printed",
      e.diaryNo ? `Diary No. ${e.diaryNo}` : null,
      e.parties,
      e.advocates.length ? `Advocates: ${e.advocates.join(", ")}` : null,
    ]
    : [`As printed (not split into fields): ${(e.raw ?? "").replace(/\s+/g, " ").trim() || "(no text)"}`];
  return [
    head,
    ...body,
    e.bench ? `Bench: ${e.bench}` : null,
    `As published${e.publishedAt ? ` at ${formatFetchedAt(e.publishedAt)}` : ""}; fetched ${formatFetchedAt(e.fetchedAt) ?? (e.fetchedAt || "time not recorded")}`,
  ].filter(Boolean).join("\n");
}

/** The search a result came from, in words, from its query string (the submitted search, not the form being edited). */
export function causeListSearchText(qs: string): string {
  const sp = new URLSearchParams(qs);
  const forum = CAUSE_LIST_FORUMS.find((f) => f.forum === sp.get("forum"));
  const parts = [forum?.label ?? causeListForumLabel(sp.get("forum"))];
  const date = sp.get("date");
  if (date) parts.push(`list date ${formatIsoDate(date)}`);
  const cs = sp.get("case");
  if (cs) parts.push(`case number ${cs}`);
  const diary = sp.get("diary");
  if (diary) parts.push(`Diary No. ${diary}`);
  const adv = sp.get("advocate");
  if (adv) parts.push(`advocate ${adv}`);
  return parts.join(", ");
}

/** True when a result has as many entries as were asked for, so more may exist. */
export function causeListCapped(entries: number, qs: string | null): boolean {
  const limit = Number(new URLSearchParams(qs ?? "").get("limit") ?? CAUSE_LIST_LIMIT);
  return entries >= (Number.isFinite(limit) && limit > 0 ? limit : CAUSE_LIST_LIMIT);
}

/** Plain text of a whole result for the clipboard. */
export function causeListToText(qs: string, entries: CauseListEntry[]): string {
  const capped = causeListCapped(entries.length, qs);
  return [
    `Cause list entries — ${causeListSearchText(qs)}`,
    `${entries.length} entr${entries.length === 1 ? "y" : "ies"}${capped ? ` (only the first ${entries.length} returned; narrow the search to see the rest)` : ""}`,
    "",
    ...entries.map(causeListEntryText).flatMap((t) => [t, ""]),
    "Cause lists are not authoritative: confirm against the court's published list.",
    DECISION_SUPPORT_FOOTER,
  ].join("\n");
}
