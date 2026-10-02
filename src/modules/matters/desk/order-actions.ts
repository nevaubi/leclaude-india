/**
 * Order → action items, the deterministic half (client-safe, pure).
 *
 * The model proposes directions, the next date and compliance tasks, each with a VERBATIM quote and page. This module
 * checks every quote against the order text, computes a deadline only when the order states a period or a date, and
 * flags whatever cannot be verified. It never invents a date: a period that runs from an event whose date is unknown
 * (receipt of a copy, service) stays without a deadline, and a period it cannot parse is reported, not approximated.
 *
 * Period arithmetic (General Clauses Act, 1897): s.9 — "from" excludes the first day, so N days from the order date is
 * order date + N; s.3(35) — a month is a British calendar month (clamped to the target month's last day).
 */
import { addDays, addMonths, addYears, isValidIsoDate } from "@/lib/india/holidays";
import type { ComputedDeadline, DeadlineGap, OrderActionItem, QuoteCheck } from "./types";

/** One stretch of order text with the pages it covers (an official-document chunk). */
export interface OrderTextChunk {
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
}

/** Raw extraction as returned by the model (shape enforced by the JSON schema in the server module). */
export interface RawOrderExtraction {
  directions: { text: string; quote: string; page: number | null }[];
  nextDate: { text: string; quote: string; page: number | null } | null;
  complianceTasks: { task: string; party: string | null; quote: string; page: number | null; period: string | null; statedDate: string | null }[];
}

/** Normalize for verbatim comparison: unify quote marks and dashes, collapse whitespace, case-fold. */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/­/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Find a quote in the order text. A quote that spans two chunks is checked against each adjacent pair as well.
 * Quotes shorter than 8 characters are too weak to verify anything and count as not found.
 */
export function checkQuote(chunks: OrderTextChunk[], quote: string, page: number | null): QuoteCheck {
  const q = normalizeForQuote(quote ?? "");
  if (q.length < 8) return { quoteFound: false, pageVerified: false, foundPages: null };
  const norm = chunks.map((c) => normalizeForQuote(c.text));
  const hits: { start: number | null; end: number | null }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (norm[i].includes(q)) hits.push({ start: chunks[i].pageStart, end: chunks[i].pageEnd ?? chunks[i].pageStart });
    // A quote spanning the boundary only: one wholly inside the next chunk is that chunk's hit (its own page range).
    else if (i + 1 < chunks.length && !norm[i + 1].includes(q) && `${norm[i]} ${norm[i + 1]}`.includes(q)) hits.push({ start: chunks[i].pageStart, end: chunks[i + 1].pageEnd ?? chunks[i + 1].pageStart });
  }
  if (!hits.length) return { quoteFound: false, pageVerified: false, foundPages: null };
  const pageVerified = page != null && hits.some((h) => h.start != null && h.end != null && page >= h.start && page <= h.end);
  // Report the hit that contains the cited page, else the first one (where the quote actually is; never a guess).
  const best = (page != null && hits.find((h) => h.start != null && h.end != null && page >= h.start && page <= h.end)) || hits[0];
  return { quoteFound: true, pageVerified, foundPages: best };
}

/** Whether a short verbatim phrase (a period, a date) occurs in the order text. */
export function phraseInText(chunks: OrderTextChunk[], phrase: string): boolean {
  const p = normalizeForQuote(phrase ?? "");
  if (p.length < 3) return false;
  const all = chunks.map((c) => normalizeForQuote(c.text)).join(" ");
  return all.includes(p);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  "twenty one": 21, "twenty-one": 21, thirty: 30, "thirty one": 31, forty: 40, "forty five": 45, "forty-five": 45, sixty: 60, ninety: 90, a: 1, an: 1,
};

export type ParsedPeriod =
  | { ok: true; n: number; unit: "days" | "weeks" | "months" | "years"; anchor: "order" }
  | { ok: false; reason: "runs_from_event" | "unparsed_period" };

/**
 * Parse a stated period. Recognised: "within 4 weeks", "within four weeks from today", "within 30 days from the date of
 * this order", "two weeks' time", "15 days". A period anchored on another event (receipt / service / filing / supply
 * of copy / communication) is `runs_from_event`; anything else ambiguous is `unparsed_period`.
 */
const EVENT_ANCHOR = /\b(?:from|after|of|on|upon)\s+(?:the\s+)?(?:date\s+of\s+)?(?:receipt|receiving|service|serving|being\s+served|supply|being\s+supplied|communication|production|filing|intimation|completion|disposal|expiry|uploading|furnishing)\b/;
const ORDER_ANCHOR = /^\s*(?:today|now|this\s+order|the\s+date\s+hereof|date\s+hereof|(?:the\s+)?date\s+of\s+(?:this|the)\s+order|the\s+date\s+of\s+pronouncement(?:\s+of\s+this\s+order)?|the\s+date\s+of\s+this\s+judgment)\b/;

export function parsePeriod(text: string): ParsedPeriod {
  const s = normalizeForQuote(text).replace(/[()]/g, " ").replace(/\s+/g, " ");
  if (EVENT_ANCHOR.test(s)) return { ok: false, reason: "runs_from_event" };
  // A "from …" anchor must be the order itself; any other anchor ("from the next date") cannot be counted here.
  const from = /\bfrom\b(.*)$/.exec(s);
  if (from && !ORDER_ANCHOR.test(from[1])) return { ok: false, reason: "unparsed_period" };
  const m = /\b(\d{1,3}|twenty[- ]one|forty[- ]five|thirty one|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|sixty|ninety|a|an)\s*(?:\(\s*\d{1,3}\s*\)\s*)?(day|days|week|weeks|month|months|year|years)\b/.exec(s);
  if (!m) return { ok: false, reason: "unparsed_period" };
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  if (!n || n < 1 || n > 1000) return { ok: false, reason: "unparsed_period" };
  // Two different numbers in one period phrase ("2 to 4 weeks", "4 weeks + 2 weeks") are ambiguous.
  const numbers = s.match(/\b\d{1,3}\b/g) ?? [];
  if (new Set(numbers).size > 1) return { ok: false, reason: "unparsed_period" };
  const unitWord = m[2].replace(/s$/, "");
  const unit = (unitWord === "day" ? "days" : unitWord === "week" ? "weeks" : unitWord === "month" ? "months" : "years") as "days" | "weeks" | "months" | "years";
  // An explicit order anchor ("from today") or none at all ("within four weeks") runs from the order date.
  return { ok: true, n, unit, anchor: "order" };
}

const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };

/** Parse a printed date ("15.10.2026", "15-10-2026", "15/10/2026", "15th October, 2026", "October 15, 2026"); day-first. */
export function parseStatedDate(text: string): string | null {
  const s = text.trim();
  let m = /\b(\d{1,2})[./-](\d{1,2})[./-]((?:19|20)\d{2})\b/.exec(s);
  if (m) return isoOrNull(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?([A-Za-z]{3,9})\.?,?\s+((?:19|20)\d{2})\b/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return isoOrNull(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return isoOrNull(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
  return null;
}

function isoOrNull(y: number, mo: number, d: number): string | null {
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isValidIsoDate(iso) ? iso : null;
}

const UNIT_WORD = { days: "day", weeks: "week", months: "month", years: "year" } as const;

/** Compute a deadline from what the order states, or say exactly why none was computed. */
export function computeDeadline(opts: { period: string | null; statedDate: string | null; orderDate: string | null; chunks: OrderTextChunk[] }): { deadline: ComputedDeadline | null; gap: DeadlineGap | null } {
  if (opts.statedDate) {
    if (!phraseInText(opts.chunks, opts.statedDate)) return { deadline: null, gap: "period_not_in_text" };
    const date = parseStatedDate(opts.statedDate);
    if (date) return { deadline: { date, basis: "stated_date", text: opts.statedDate, rule: "Date as stated in the order" }, gap: null };
    if (!opts.period) return { deadline: null, gap: "unparsed_period" };
  }
  if (!opts.period) return { deadline: null, gap: "no_period" };
  if (!phraseInText(opts.chunks, opts.period)) return { deadline: null, gap: "period_not_in_text" };
  const p = parsePeriod(opts.period);
  if (!p.ok) return { deadline: null, gap: p.reason };
  if (!opts.orderDate || !isValidIsoDate(opts.orderDate)) return { deadline: null, gap: "no_order_date" };
  const date = p.unit === "days" ? addDays(opts.orderDate, p.n) : p.unit === "weeks" ? addDays(opts.orderDate, p.n * 7) : p.unit === "months" ? addMonths(opts.orderDate, p.n) : addYears(opts.orderDate, p.n);
  const unit = `${p.n} ${UNIT_WORD[p.unit]}${p.n === 1 ? "" : "s"}`;
  const rule = p.unit === "days" || p.unit === "weeks"
    ? `Order date + ${unit} (first day excluded, General Clauses Act s.9)`
    : `Order date + ${unit} (British calendar ${p.unit === "months" ? "month" : "year"}, General Clauses Act s.3(35))`;
  return { deadline: { date, basis: "period", from: opts.orderDate, text: opts.period, rule }, gap: null };
}

let seq = 0;
function itemId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function page(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5000 ? v : null;
}

/**
 * Turn a raw extraction into checked items. Every item keeps its quote check; deadlines are computed only for
 * compliance tasks whose quote is in the text. Items whose quote is missing or whose page does not hold the quote are
 * flagged (never silently dropped, never "corrected" into something the order does not say).
 */
export function buildActionItems(raw: RawOrderExtraction, chunks: OrderTextChunk[], orderDate: string | null): OrderActionItem[] {
  const out: OrderActionItem[] = [];
  const base = (kind: OrderActionItem["kind"], text: string, quote: string, p: number | null, party: string | null = null): OrderActionItem => {
    const check = checkQuote(chunks, quote, p);
    return { id: itemId(kind === "direction" ? "dir" : kind === "next_date" ? "nd" : "ct"), kind, text, party, quote, page: p, check, period: null, statedDate: null, deadline: null, deadlineGap: null, flagged: !check.quoteFound || !check.pageVerified };
  };
  for (const d of (raw.directions ?? []).slice(0, 30)) {
    const text = clean(d?.text, 600);
    const quote = clean(d?.quote, 1200);
    if (!text && !quote) continue;
    out.push(base("direction", text || quote, quote, page(d?.page)));
  }
  if (raw.nextDate && (clean(raw.nextDate.text, 300) || clean(raw.nextDate.quote, 600))) {
    const nd = base("next_date", clean(raw.nextDate.text, 300) || clean(raw.nextDate.quote, 600), clean(raw.nextDate.quote, 600), page(raw.nextDate.page));
    // A listing date is shown as stated; a parsed date is offered only when it is printed in the quote itself.
    const stated = nd.check.quoteFound ? parseStatedDate(nd.quote) : null;
    if (stated) nd.deadline = { date: stated, basis: "stated_date", text: nd.quote, rule: "Date as stated in the order" };
    else nd.deadlineGap = nd.check.quoteFound ? "no_period" : "quote_not_found";
    out.push(nd);
  }
  for (const c of (raw.complianceTasks ?? []).slice(0, 30)) {
    const text = clean(c?.task, 600);
    const quote = clean(c?.quote, 1200);
    if (!text && !quote) continue;
    const item = base("compliance", text || quote, quote, page(c?.page), clean(c?.party, 160) || null);
    item.period = clean(c?.period, 200) || null;
    item.statedDate = clean(c?.statedDate, 80) || null;
    if (!item.check.quoteFound) {
      item.deadlineGap = "quote_not_found";
    } else {
      const r = computeDeadline({ period: item.period, statedDate: item.statedDate, orderDate, chunks });
      item.deadline = r.deadline;
      item.deadlineGap = r.gap;
    }
    out.push(item);
  }
  return out;
}

/** Plain-language reason for a missing deadline (English source text; the UI translates by key `matters.desk.gap.<gap>`). */
export const DEADLINE_GAP_TEXT: Record<DeadlineGap, string> = {
  no_period: "The order states no period or date for this.",
  period_not_in_text: "The period or date given is not in the order text.",
  runs_from_event: "The period runs from an event whose date is not known (e.g. receipt of a copy). Enter the date yourself.",
  unparsed_period: "A period is stated but could not be read reliably. Work out the date yourself.",
  no_order_date: "The publisher did not print the order date, so the period cannot be counted.",
  quote_not_found: "The quoted words are not in the order text, so nothing was computed.",
};
