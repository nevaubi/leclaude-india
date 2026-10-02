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
import { normalizeCaseNumber, normalizeDiaryNo } from "@/modules/official/case-numbers";
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

/** A calendar source as returned by /api/official/calendars. */
export interface CalendarSourceRef { documentId: string; url: string; fetchedAt: string | null; years: number[] }

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

/** "fetched 3 Sep 2026" style date from an ISO timestamp (date part only); null when absent. */
export function fetchedDate(ts: string | null | undefined): string | null {
  const d = ts && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : null;
  return d ? formatIsoDate(d).replace(/^\w{3}, /, "") : null;
}

/** Plain-text label of a choice for copied results: what calendar, from where, fetched when, and the caveat. */
export function describeCalendarChoice(c: CalendarChoice, official: Record<string, OfficialCalendarResponse | undefined>): string {
  if (c === "none") return "None selected";
  if (c === "sample") return `Sample calendar "${SAMPLE_CALENDAR.id}" (illustrative; not a court's notified calendar)`;
  const forum = choiceForum(c);
  const f = COURT_CALENDAR_FORUMS.find((x) => x.forum === forum);
  const r = forum ? official[forum] : undefined;
  if (!forum || !r?.calendar) return `${f?.label ?? forum ?? "Court"}: official calendar not loaded (court holidays not checked)`;
  const src = r.sources.map((s) => `${s.url}${fetchedDate(s.fetchedAt) ? ` (fetched ${fetchedDate(s.fetchedAt)})` : ""}`).join("; ");
  return `${f?.label ?? forum} official calendar for ${r.calendar.years.join(", ")}${src ? ` from ${src}` : ""}. ${CALENDAR_CAVEAT}`;
}

/* ───────────────────────────── court working days ───────────────────────────── */

export interface CourtDaysResult {
  status: "computed" | "requires_verification" | "invalid_input";
  /** Working days counted (null when the calendar could not answer for a day in the range). */
  open: number | null;
  /** Calendar days in the range. */
  days: number;
  closed: { date: IsoDate; reason: string }[];
  /** First day the calendar cannot answer for (outside its years); counting stops there. */
  unknown: { date: IsoDate; reason: string } | null;
  notes: string[];
}

const MAX_COUNT_DAYS = 3 * 366;

/**
 * Court working days from `from` to `to`, both days included, under `cal`. A day the calendar cannot answer for
 * (outside its years) stops the count: the result is "requires verification" with no number, never a guess.
 */
export function countCourtDays(from: IsoDate, to: IsoDate, cal: CourtCalendar): CourtDaysResult {
  const notes: string[] = [];
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) return { status: "invalid_input", open: null, days: 0, closed: [], unknown: null, notes: ["Enter both dates in full."] };
  if (compareIso(from, to) > 0) return { status: "invalid_input", open: null, days: 0, closed: [], unknown: null, notes: ["The start date is after the end date."] };
  const days = daysBetween(from, to) + 1;
  if (days > MAX_COUNT_DAYS) return { status: "invalid_input", open: null, days, closed: [], unknown: null, notes: [`Ranges are limited to ${MAX_COUNT_DAYS} days.`] };
  const closed: { date: IsoDate; reason: string }[] = [];
  let open = 0;
  for (let i = 0, d = from; i < days; i++, d = addDays(d, 1)) {
    const st = isCourtOpen(d, cal);
    if (st.open === "unknown") return { status: "requires_verification", open: null, days, closed, unknown: { date: d, reason: st.reason }, notes: [`The calendar cannot answer for ${d} (${st.reason}); the count stops there.`] };
    if (st.open) open++;
    else closed.push({ date: d, reason: st.reason });
  }
  if (cal.sample) notes.push("Sample calendar: Sundays and three national holidays only. It is not the court's notified calendar.");
  notes.push("Both the start and the end date are counted.");
  return { status: cal.sample ? "requires_verification" : "computed", open, days, closed, unknown: null, notes };
}

export interface NextCourtDayResult { status: "computed" | "requires_verification" | "invalid_input"; date: IsoDate | null; skipped: { date: IsoDate; reason: string }[]; notes: string[] }

/** The first day on or after `date` on which the court sits, under `cal` (null with the reason when it cannot say). */
export function nextCourtDay(date: IsoDate, cal: CourtCalendar): NextCourtDayResult {
  if (!isValidIsoDate(date)) return { status: "invalid_input", date: null, skipped: [], notes: ["Enter the date in full."] };
  const r = nextOpenDay(date, cal);
  if (!r.date) return { status: "requires_verification", date: null, skipped: r.skipped, notes: [r.unknown ? `The calendar cannot say: ${r.unknown}.` : "No working day found."] };
  return { status: cal.sample ? "requires_verification" : "computed", date: r.date, skipped: r.skipped, notes: cal.sample ? ["Sample calendar: not the court's notified calendar."] : [] };
}

/** `date` plus `n` court working days (the start day is not counted); null with the reason when the calendar cannot say. */
export function addWorkingDays(date: IsoDate, n: number, cal: CourtCalendar): { status: "computed" | "requires_verification" | "invalid_input"; date: IsoDate | null; notes: string[] } {
  if (!isValidIsoDate(date)) return { status: "invalid_input", date: null, notes: ["Enter the date in full."] };
  if (!Number.isInteger(n) || n < 1 || n > 500) return { status: "invalid_input", date: null, notes: ["Give a whole number of working days from 1 to 500."] };
  const r = addCourtDays(date, n, cal);
  if (!r) return { status: "requires_verification", date: null, notes: ["The calendar does not cover every day needed (check its years)."] };
  return { status: cal.sample ? "requires_verification" : "computed", date: r, notes: ["The start day is not counted.", ...(cal.sample ? ["Sample calendar: not the court's notified calendar."] : [])] };
}

export function courtDaysToText(input: { from: IsoDate; to: IsoDate }, r: CourtDaysResult, calendarLabel: string): string {
  const lines = [`Court working days: ${formatIsoDate(input.from)} to ${formatIsoDate(input.to)} (both included)`, `Status: ${statusText(r.status)}`, `Calendar: ${calendarLabel}`];
  if (r.open != null) lines.push(`Working days: ${r.open} of ${r.days} calendar days`);
  if (r.unknown) lines.push(`Not counted: the calendar cannot answer for ${r.unknown.date} (${r.unknown.reason})`);
  if (r.closed.length) lines.push("", "Days the court does not sit:", ...r.closed.map((c) => `- ${c.date} ${formatIsoDate(c.date)}: ${c.reason}`));
  return tail(lines, [], r.notes);
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

export interface CauseListSearch { forum: string; date: string; caseNumber: string; diary: string; advocate: string }

/**
 * Query string for /api/official/causelists, or the reason the search cannot be run. Case and diary numbers must read
 * as one exact number (they are matched exactly, never fuzzily); a date or an identifier is required.
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
    if (!normalizeCaseNumber(cn)) return { qs: null, error: `"${cn}" is not one recognisable case number (e.g. SLP(C) No. 1234/2026, W.P.(C) 5812/2016).` };
    sp.set("case", cn);
  }
  const diary = s.diary.trim();
  if (diary) {
    if (!forum.diary) return { qs: null, error: "Diary numbers are used by the Supreme Court only." };
    if (!normalizeDiaryNo(diary)) return { qs: null, error: `"${diary}" is not a diary number (e.g. 54583/2026).` };
    sp.set("diary", diary);
  }
  const adv = s.advocate.replace(/\s+/g, " ").trim();
  if (adv) {
    if (adv.length < 3) return { qs: null, error: "Give the advocate's name as printed (at least 3 letters)." };
    sp.set("advocate", adv.slice(0, 120));
  }
  if (!date && !cn && !diary) return { qs: null, error: "Give a list date, or a case or diary number." };
  sp.set("limit", "200");
  return { qs: sp.toString(), error: null };
}
