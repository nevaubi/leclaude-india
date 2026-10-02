/**
 * Deterministic text helpers for cause-list parsing (pure; no server imports).
 *
 * Personal data: cause lists print advocates' e-mail addresses and phone numbers (Delhi High Court "OTHER DETAILS OF
 * ADVOCATES" rows) and video-conference links. `scrubContact` removes them from every stored field, including the
 * verbatim `raw` text, which is therefore "verbatim except contact data".
 */

import { decodeHtml } from "@/modules/india/sources/parse-util";

/** Markdown / HTML inline markup → plain text (bold, underline, headings, <sup>, entities). Nothing else changes. */
export function plain(s: string): string {
  return decodeHtml(
    s
      .replace(/<sup>\s*([^<]*?)\s*<\/sup>/gi, "$1")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/\*+|__/g, "")
      .replace(/^\s{0,3}#{1,6}\s+/, ""),
  )
    .replace(/[’‘`]/g, "'")
    .replace(/[ \t ]+/g, " ")
    .trim();
}

export function squash(s: string): string {
  return s.replace(/[ \s]+/g, " ").trim();
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.?/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s|)>\]]+/gi;
// Indian mobile / landline numbers printed as contact data: 10–12 digits, optionally +91 / 0 prefixed, not part of a
// longer number and not followed by "/" (case numbers are "N/YYYY") or preceded by "No." patterns.
const PHONE = /(?<![\d/])(?:\+?91[\s-]?)?\d{10,12}(?![\d/])/g;

/** Remove e-mail addresses, URLs and phone numbers (contact data never stored, logged or indexed). */
export function scrubContact(s: string): string {
  return s
    .replace(EMAIL, "[email removed]")
    .replace(URL, "[link removed]")
    .replace(PHONE, "[phone removed]")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** True when the text still holds contact data (used by tests and as a persist guard). */
export function hasContact(s: string): boolean {
  EMAIL.lastIndex = 0;
  PHONE.lastIndex = 0;
  const r = EMAIL.test(s) || new RegExp(PHONE.source).test(s);
  EMAIL.lastIndex = 0;
  PHONE.lastIndex = 0;
  return r;
}

/** Parties "A V/s B", "A Versus B", "A Vs. B" with glued separators repaired ("BHARANAV/s IDBI" → "BHARANA V/s IDBI"). */
export function normalizeParties(s: string): string {
  return squash(
    s
      .replace(/(\S)(V\/[sS]\b)/g, "$1 $2")
      .replace(/(V\/[sS])(?=\S)/g, "$1 ")
      .replace(/([a-z.)])(Vs\.?)(?=\s)/g, "$1 $2")
      .replace(/(\S)(\*?Versus\*?)(?=\s|$)/g, "$1 $2")
      .replace(/\*Versus\*/g, "Versus"),
  );
}

/** Lines that are notes printed in the parties column of Supreme Court lists, not party names. */
export const SC_NOTE_LINE = /^(?:\{|\[|IA\s*No\b|IN\s+D\s*No|C\/C\b|FOR\s|WITH\s|TO BE\s|ONLY\s|Office Report|Mention|\(|\*)/i;

/** Supreme Court parties cell (lines) → "PETITIONER Versus RESPONDENT"; null when no "Versus" separates two parties. */
export function scParties(lines: string[]): string | null {
  const clean = lines.map((l) => squash(l.replace(/\*/g, ""))).filter(Boolean);
  // Inline form (advance / weekly tables): "A Versus B {Mention Memo} IA No. ..."
  if (clean.length === 1 || !clean.some((l) => /^versus$/i.test(l))) {
    const joined = clean.join(" ");
    const m = /^(.*?)\s+Versus\s+(.*)$/i.exec(joined);
    if (!m) return clean.length ? cutNotes(joined) || null : null;
    const res = cutNotes(m[2]);
    return m[1].trim() && res ? `${m[1].trim()} Versus ${res}` : null;
  }
  const v = clean.findIndex((l) => /^versus$/i.test(l));
  const pet = clean.slice(0, v).filter((l) => !SC_NOTE_LINE.test(l)).join(" ").trim();
  const resLines: string[] = [];
  for (const l of clean.slice(v + 1)) {
    if (SC_NOTE_LINE.test(l)) break;
    resLines.push(l);
  }
  const res = resLines.join(" ").trim();
  return pet && res ? `${pet} Versus ${res}` : null;
}

function cutNotes(s: string): string {
  const i = s.search(/\s(?:\{|\[[A-Z ]{6,}|IA No\.|IN D No)/);
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

/** "AJAY MARWAH- 2312 BIMLESH KUMAR SINGH- 1652 [R-1]" → ["AJAY MARWAH (AOR 2312)", "BIMLESH KUMAR SINGH (AOR 1652)"]. */
export function scAdvocates(text: string): string[] {
  const s = squash(scrubContact(text.replace(/\*/g, "")));
  if (!s) return [];
  const out: string[] = [];
  const coded = /([A-Z][A-Z.'&() ]*?[A-Z.)])\s*-\s*(\d{1,6})(?:\s*\[[PR]-?\s*\d+\])?/g;
  let rest = s;
  let m: RegExpExecArray | null;
  const spans: [number, number][] = [];
  while ((m = coded.exec(s))) {
    out.push(`${squash(m[1])} (AOR ${Number(m[2])})`);
    spans.push([m.index, m.index + m[0].length]);
  }
  if (spans.length) {
    let r = "";
    let at = 0;
    for (const [a, b] of spans) { r += s.slice(at, a) + ","; at = b; }
    rest = r + s.slice(at);
  }
  for (const part of rest.split(/\[[PR]-?\s*\d+\]|,|;/)) {
    const name = squash(part).replace(/^[-–\s]+|[-–\s]+$/g, "");
    if (name && /[A-Za-z]{2}/.test(name)) out.push(name);
  }
  return dedupe(out);
}

/** Delhi HC advocates cell "L.K. RAWAL, SHANTANU SAGAR, SIDDHARTH PANDA" → names. */
export function commaAdvocates(text: string): string[] {
  return dedupe(scrubContact(text).split(/\s*[,;]\s*/).map((x) => squash(x)).filter((x) => /[A-Za-z]{2}/.test(x)));
}

/**
 * Tribunal counsel cells: "Faguni Jain, Adv Rishabh Gupta, Adv" → ["Faguni Jain", "Rishabh Gupta"]; role notes
 * "(R-3 & 4)", "-R1" and "- In- Person" are dropped; names glued by the PDF text layer ("AgarwalShashwat") are split
 * at a lower→upper case boundary.
 */
export function tribunalAdvocates(text: string): string[] {
  let s = scrubContact(text)
    .replace(/\(\s*R\s*-[^)]*\)/gi, " ")
    .replace(/\s*-\s*In\s*-\s*Person\b/gi, " ")
    .replace(/-\s*R\s*-?\s*\d+(?:\s*(?:&|,)\s*\d+)*/g, " | ");
  s = s.replace(/([a-z])([A-Z][a-z])/g, "$1 | $2");
  const parts = s.split(/,?\s*\bAdv(?:ocate)?\b\.?|\||\n|;/);
  const out: string[] = [];
  for (const p of parts) {
    for (const q of p.split(/\s*,\s*/)) {
      const name = squash(q).replace(/^[-–&,\s]+|[-–&,\s]+$/g, "");
      if (name && /[A-Za-z]{2}/.test(name) && !/^(?:and|for|with)$/i.test(name)) out.push(name);
    }
  }
  return dedupe(out);
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

/** Name part of a stored advocate value ("AJAY MARWAH (AOR 2312)" → "AJAY MARWAH"), for exact name matching. */
export function advocateName(v: string): string {
  return squash(v.replace(/\s*\(AOR \d+\)$/, ""));
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Month name or 3-letter abbreviation → 1..12; null otherwise. */
export function monthNumber(name: string): number | null {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n === "sept") return 9;
  const i = MONTHS.findIndex((m) => m === n || (n.length === 3 && m.startsWith(n)));
  return i >= 0 ? i + 1 : null;
}

function iso(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Dates as printed in Indian listings → ISO: "05-10-2026", "05.10.2026", "05/10/2026" (day first), "2026-10-05",
 * "01-Oct-2026", "05 Oct 2026", "5th October, 2026". Null when it is not one (never guessed).
 */
export function printedDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = squash(raw.replace(/<sup>|<\/sup>/gi, ""));
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/.exec(s);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{2})$/.exec(s);
  if (m) return iso(2000 + +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\s*(?:st|nd|rd|th)?[-\s]+([A-Za-z]{3,9})\.?,?[-\s]+(\d{4})$/.exec(s);
  if (m) {
    const mo = monthNumber(m[2]);
    return mo ? iso(+m[3], mo, +m[1]) : null;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = monthNumber(m[1]);
    return mo ? iso(+m[3], mo, +m[2]) : null;
  }
  return null;
}

/** Find the first printed date inside a longer text (same forms as `printedDate`). */
export function findPrintedDate(text: string): string | null {
  const s = squash(text.replace(/<sup>|<\/sup>/gi, ""));
  const res = [
    /\b(\d{1,2}[-./]\d{1,2}[-./]\d{4})\b/,
    /\b(\d{1,2}\s*(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?,?\s+\d{4})\b/i,
    /\b(\d{4}-\d{2}-\d{2})\b/,
  ];
  for (const re of res) {
    const m = re.exec(s);
    if (m) {
      const d = printedDate(m[1]);
      if (d) return d;
    }
  }
  return null;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Weekday name → 0 (Sunday) … 6 (Saturday); null otherwise. */
export function weekdayNumber(name: string): number | null {
  const n = name.trim().toLowerCase();
  const i = WEEKDAYS.findIndex((w) => w === n || (n.length >= 3 && w.startsWith(n)));
  return i >= 0 ? i : null;
}

export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

export function addDaysIso(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isoFrom(y: number, m: number, d: number): string | null {
  return iso(y, m, d);
}
