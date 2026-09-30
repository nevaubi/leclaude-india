/**
 * Pure text helpers for document sets: page normalisation, chunking, quote checks and date normalisation.
 * No I/O; safe to unit test directly.
 */

// ---- page text --------------------------------------------------------------------------------------------------

/** Normalise one page (or one non-paged document) of extracted text. The stored text is this normalised form. */
export function normalizePageText(text: string): string {
  return (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- chunking ---------------------------------------------------------------------------------------------------

export const CHUNK_TARGET = 1500;
export const CHUNK_OVERLAP = 150;

export interface PageChunk {
  /** Full chunk text: `lead` characters of overlap from the previous chunk on the same page, then the body. */
  text: string;
  /** Number of leading characters that repeat the end of the previous chunk (0 for the first chunk of a page). */
  lead: number;
}

/** Where to cut `text` at or before `max`, preferring a paragraph break, then a sentence end, then whitespace. */
function cutPoint(text: string, max: number): number {
  if (text.length <= max) return text.length;
  const min = Math.floor(max / 2);
  const window = text.slice(0, max);
  const para = window.lastIndexOf("\n\n");
  if (para >= min) return para + 2;
  let best = -1;
  const sentence = /[.!?।;:]["')\]]?\s+/g;
  let m: RegExpExecArray | null;
  while ((m = sentence.exec(window))) { if (m.index + m[0].length >= min) best = m.index + m[0].length; }
  if (best >= min) return best;
  const nl = window.lastIndexOf("\n");
  if (nl >= min) return nl + 1;
  const sp = window.lastIndexOf(" ");
  if (sp >= min) return sp + 1;
  return max;
}

/** The last ~`n` characters of `body`, starting at a word boundary when one is near. */
function overlapTail(body: string, n: number): string {
  if (body.length <= n) return body;
  let start = body.length - n;
  const sp = body.indexOf(" ", start);
  if (sp >= 0 && sp < body.length - n / 3) start = sp + 1;
  return body.slice(start);
}

/**
 * Split one page into chunks of ~`target` characters on paragraph/sentence boundaries with ~`overlap` characters of
 * overlap. The bodies (text after `lead`) concatenate back to exactly `text`, so a page is always reconstructable.
 */
export function chunkPage(text: string, target = CHUNK_TARGET, overlap = CHUNK_OVERLAP): PageChunk[] {
  if (!text) return [];
  const out: PageChunk[] = [];
  let rest = text;
  let prev = "";
  while (rest.length) {
    const cut = rest.length <= target ? rest.length : cutPoint(rest, target);
    const body = rest.slice(0, cut);
    rest = rest.slice(cut);
    const lead = prev ? overlapTail(prev, overlap) : "";
    out.push({ text: lead + body, lead: lead.length });
    prev = body;
  }
  return out;
}

/** Rebuild a page from its chunks (in order). */
export function joinChunks(chunks: { text: string; lead: number }[]): string {
  return chunks.map((c) => c.text.slice(c.lead)).join("");
}

// ---- quote check ------------------------------------------------------------------------------------------------

/** Lower-case, unify quotes/dashes, collapse whitespace; used on both sides of a quote check. */
export function normalizeForMatch(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/­/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when `quote` occurs in `text` (whitespace, quote style and case insensitive). A quote with an ellipsis is
 * checked part by part, in order. An empty quote is never "found".
 */
export function quoteFound(quote: string, text: string): boolean {
  const q = (quote ?? "").trim().replace(/^["'“‘]+|["'”’]+$/g, "");
  if (!q) return false;
  const hay = normalizeForMatch(text);
  const parts = q.split(/\s*(?:\.{3}|…)\s*/).map(normalizeForMatch).filter(Boolean);
  if (!parts.length) return false;
  let from = 0;
  for (const p of parts) {
    const i = hay.indexOf(p, from);
    if (i < 0) return false;
    from = i + p.length;
  }
  return true;
}

// ---- dates ------------------------------------------------------------------------------------------------------

export type DatePrecisionT = "day" | "month" | "year";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const pad = (n: number) => String(n).padStart(2, "0");

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function year4(y: string): number {
  const n = Number(y);
  if (y.length === 2) return n < 50 ? 2000 + n : 1900 + n;
  return n;
}

function okYear(y: number) { return y >= 1800 && y <= 2200; }

function day(y: number, m: number, d: number): { date: string; precision: DatePrecisionT } | null {
  if (!okYear(y) || !validDay(y, m, d)) return null;
  return { date: `${y}-${pad(m)}-${pad(d)}`, precision: "day" };
}

/**
 * Normalise a date as written in an (Indian) legal document to ISO with a precision. Numeric day-month-year forms
 * are read as DD.MM.YYYY (the Indian convention), never MM/DD. Returns null when the text is not a resolvable date.
 *
 *   "3rd March, 2021" → 2021-03-03 (day) · "03.03.2021" → 2021-03-03 · "March 2021" → 2021-03 (month) · "2021" → 2021 (year)
 */
export function normalizeDate(input: string | null | undefined): { date: string; precision: DatePrecisionT } | null {
  if (!input) return null;
  const s = String(input).trim().toLowerCase().replace(/\s+/g, " ").replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  let m: RegExpExecArray | null;
  // ISO: 2021-03-03, 2021-03-03T10:00:00Z, 2021-03, 2021/03/03
  if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[t ][\d:.]+z?(?:[+-]\d{2}:?\d{2})?)?$/.exec(s))) return day(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})-(\d{2})$/.exec(s))) { const y = +m[1], mo = +m[2]; return okYear(y) && mo >= 1 && mo <= 12 ? { date: `${y}-${pad(mo)}`, precision: "month" } : null; }
  // DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY (Indian order), two-digit years allowed.
  if ((m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/.exec(s))) return day(year4(m[3]), +m[2], +m[1]);
  // 3rd March 2021 / 3 Mar 2021 / 3-Mar-2021 / 3rd day of March 2021
  const ord = "(\\d{1,2})(?:st|nd|rd|th)?";
  if ((m = new RegExp(`^(?:the )?${ord}(?: day)?(?: of)?[ .-]*${MONTH_RE}\\.?[ .-]*(\\d{4}|\\d{2})$`).exec(s))) return day(year4(m[3]), MONTHS[m[2]], +m[1]);
  // March 3rd 2021 / Mar. 3 2021
  if ((m = new RegExp(`^${MONTH_RE}\\.? ${ord} (\\d{4})$`).exec(s))) return day(+m[3], MONTHS[m[1]], +m[2]);
  // March 2021 / Mar-2021 / Mar'21
  if ((m = new RegExp(`^${MONTH_RE}\\.?[ .'-]*(\\d{4}|\\d{2})$`).exec(s))) { const y = year4(m[2]); return okYear(y) ? { date: `${y}-${pad(MONTHS[m[1]])}`, precision: "month" } : null; }
  // 2021 / the year 2021
  if ((m = /^(?:(?:in )?(?:the )?year )?(\d{4})$/.exec(s))) { const y = +m[1]; return okYear(y) ? { date: String(y), precision: "year" } : null; }
  return null;
}

/** Parse an RFC 2822 / ISO timestamp (email Date header, file metadata) to an ISO string, or null. */
export function isoFromTimestamp(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v.trim());
  if (!Number.isFinite(t)) return null;
  const y = new Date(t).getUTCFullYear();
  return y >= 1800 && y <= 2200 ? new Date(t).toISOString() : null;
}
