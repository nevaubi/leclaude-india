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

/*
 * Contact-data patterns. They cover at least everything the pipeline's page scrub (../chunk.ts scrubPersonalData, run
 * on page text before parsing) removes, with the same markers, because positional PDF items reach the parsers raw and
 * every stored field (raw, parties, advocates, bench) is scrubbed here. Kept dependency-free (this module is pure);
 * tests/official-courts-causelist.test.ts checks that nothing the page scrub removes survives here.
 *
 * Case numbers are never touched: their numbers have at most 7 digits ("N/YYYY", "N of YYYY", "N-YYYY" diary numbers,
 * "N-M/YYYY" ranges), a phone number has 10 digits after its prefix. Amounts after "Rs." / "INR" / "₹" are left alone.
 */
export const PHONE_REMOVED = "[phone removed]";
export const EMAIL_REMOVED = "[e-mail removed]";
export const LINK_REMOVED = "[link removed]";
const MARKER_RE = /\[(?:e-?mail|phone|link) removed\]/gi;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.?/g;
// "registrar[at]nic[dot]in", "x (at) y (dot) gov (dot) in".
const EMAIL_OBF = /[A-Za-z0-9._%+-]+\s*[[({]\s*at\s*[\])}]\s*[A-Za-z0-9-]+(?:\s*(?:[[({]\s*dot\s*[\])}]|\.)\s*[A-Za-z0-9-]+)+/gi;
const URL = /\b(?:https?:\/\/|www\.)[^\s|)>\]"']+/gi;

// A phone number never touches a letter, digit, "@" or "_", is never the continuation of a decimal / digit range and
// never follows "Rs." / "INR" / "₹" (amounts).
const BEFORE = String.raw`(?<![\p{L}\p{N}@_])(?<!\d[.,-])(?<!(?:Rs|RS|rs|INR|₹|Rupees|rupees)\.?\s{0,2})`;
const AFTER = String.raw`(?![\p{L}\p{N}@_]|[.,-]\d)`;
// Grouped forms are additionally never next to "/" ("61234-61235/2026" is a case-number range).
const NO_SLASH_BEFORE = String.raw`(?<!\/\s*)`;
const NO_SLASH_AFTER = String.raw`(?!\s*\/)`;
// 10–12 unbroken digits, optionally +91 / 91 prefixed: no case number has that many digits, so "/" may touch it
// ("9810012345/9810054321", "Adv/9810012345").
const PLAIN = String.raw`(?:\+91[\s.-]?|91[\s-])?\d{10,12}`;
// Grouped mobiles: "98100 12345", "+91-98100-12345", "098100-12345", "987-654-3210", "98100.12345".
const GROUPED_MOBILE = String.raw`(?:\+91[\s.-]?|91[\s-]|0)?[6-9](?:\d{4}[\s.-]\d{5}|\d{2}[\s.-]\d{3}[\s.-]\d{4})`;
// Landlines with a trunk 0 or +91 and an STD code: "011-23388922", "(0731) 234 5678", "+91-11-23388922",
// "0731.2345678" (exactly 10 digits after the prefix; checked in code).
// A bracket is part of the number only around the STD code: "(011)", "+91 (11)"; "(011-23456789)" keeps its brackets.
const LANDLINE = String.raw`(?:(?:\+91[\s.-]?)?\(0?\d{2,4}\)|\+91[\s.-]?\d{2,4}|0\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}`;
const ANY_PHONE = `(?:${GROUPED_MOBILE}|${LANDLINE}|${PLAIN})`;
// Two or more numbers joined by "/" ("9810012345/9810054321", "0731-2345678 / 98100 12345").
const PHONE_LIST_RE = new RegExp(`${BEFORE}${ANY_PHONE}(?:\\s*\\/\\s*${ANY_PHONE})+${AFTER}`, "gu");
const PLAIN_RE = new RegExp(`${BEFORE}${PLAIN}${AFTER}`, "gu");
const GROUPED_MOBILE_RE = new RegExp(`${BEFORE}${NO_SLASH_BEFORE}${GROUPED_MOBILE}${NO_SLASH_AFTER}${AFTER}`, "gu");
const LANDLINE_RE = new RegExp(`${BEFORE}${NO_SLASH_BEFORE}${LANDLINE}${NO_SLASH_AFTER}${AFTER}`, "gu");
// A number introduced as one: "Ph: 23388922", "Mob. No. 98100 12345, 98765 43210", "Tel 0731.2345678".
const LABELLED_PHONE_RE = /\b(ph|phone|phones|mob|mobile|tel|telephone|cell|contact|whatsapp|fax)\b\.?\s*(?:no|nos|number|numbers)?\.?\s*[:\-–]?\s*(\+?\d[\d \t.-]{5,16}\d(?:\s*[,/]\s*\+?\d[\d \t.-]{5,16}\d)*)/giu;

/** Digits of a phone-shaped match after its +91 / 91 / trunk-0 prefix. */
function subscriberDigits(m: string): number {
  const t = m.trim();
  let d = t.replace(/\D/g, "");
  if (/^\+91/.test(t) || (/^91[\s-]/.test(t) && d.length > 10)) d = d.slice(2);
  else if (/^\(?0/.test(t)) d = d.slice(1);
  return d.length;
}

/** One phone-shaped piece is a phone number: 10 subscriber digits (12 at most for unbroken runs). */
function isPhone(piece: string): boolean {
  const unbroken = /^\s*(?:\+91[\s.-]?|91[\s-])?\d{10,12}\s*$/.test(piece);
  return unbroken || subscriberDigits(piece) === 10;
}

/** Contact data replaced by markers; nothing else changes (no whitespace clean-up). Idempotent. */
function scrubCore(s: string): string {
  if (!s) return s;
  let t = s.replace(EMAIL, EMAIL_REMOVED).replace(EMAIL_OBF, EMAIL_REMOVED).replace(URL, LINK_REMOVED);
  t = t.replace(LABELLED_PHONE_RE, (m: string, _label: string, num: string) => (num.replace(/\D/g, "").length < 6 ? m : m.slice(0, m.length - num.length) + PHONE_REMOVED));
  t = t.replace(PHONE_LIST_RE, (m: string) => (m.split("/").every(isPhone) ? PHONE_REMOVED : m));
  t = t.replace(GROUPED_MOBILE_RE, PHONE_REMOVED);
  t = t.replace(LANDLINE_RE, (m: string) => (subscriberDigits(m) === 10 ? PHONE_REMOVED : m));
  t = t.replace(PLAIN_RE, PHONE_REMOVED);
  return t;
}

/** Remove e-mail addresses, URLs and phone numbers (contact data never stored, logged or indexed). */
export function scrubContact(s: string): string {
  return scrubCore(s)
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** True when the text still holds contact data (used by tests and as a persist guard). */
export function hasContact(s: string): boolean {
  return !!s && scrubCore(s) !== s;
}

const CONTACT_LABEL = String.raw`\b(?:ph|phone|phones|mob|mobile|tel|telephone|cell|contact|whatsapp|fax|e-?mail(?:\s*id)?|vc\s*link|link)\b\.?\s*(?:no|nos|number|numbers|id)?\.?\s*[:\-–]?\s*`;
const LABELLED_MARKER_RE = new RegExp(`(?:${CONTACT_LABEL})?\\[(?:e-?mail|phone|link) removed\\]`, "gi");

/**
 * Text for name fields (advocates): contact data removed together with its label ("Mob: [phone removed]"), so neither
 * a removal marker nor a bare label is ever stored as a name. Line breaks (name separators) are kept.
 */
export function contactFree(s: string): string {
  return scrubContact(s)
    .replace(LABELLED_MARKER_RE, " ")
    .replace(/\(\s*[,;/&-]?\s*\)/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** True when a name part is only contact residue (markers, labels, punctuation): never a name. */
function contactResidue(s: string): boolean {
  return !/[A-Za-z]{2}/.test(s.replace(MARKER_RE, " ").replace(new RegExp(CONTACT_LABEL, "gi"), " "));
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
  const s = squash(contactFree(text.replace(/\*/g, "")));
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
    if (name && /[A-Za-z]{2}/.test(name) && !contactResidue(name)) out.push(name);
  }
  return dedupe(out);
}

/** Delhi HC advocates cell "L.K. RAWAL, SHANTANU SAGAR, SIDDHARTH PANDA" → names. */
export function commaAdvocates(text: string): string[] {
  return dedupe(contactFree(text).split(/\s*[,;]\s*/).map((x) => squash(x)).filter((x) => /[A-Za-z]{2}/.test(x) && !contactResidue(x)));
}

/**
 * Tribunal counsel cells: "Faguni Jain, Adv Rishabh Gupta, Adv" → ["Faguni Jain", "Rishabh Gupta"]; role notes
 * "(R-3 & 4)", "-R1" and "- In- Person" are dropped; names glued by the PDF text layer ("AgarwalShashwat") are split
 * at a lower→upper case boundary.
 */
export function tribunalAdvocates(text: string): string[] {
  let s = contactFree(text)
    .replace(/\(\s*R\s*-[^)]*\)/gi, " ")
    .replace(/\s*-\s*In\s*-\s*Person\b/gi, " ")
    .replace(/-\s*R\s*-?\s*\d+(?:\s*(?:&|,)\s*\d+)*/g, " | ");
  s = s.replace(/([a-z])([A-Z][a-z])/g, "$1 | $2");
  const parts = s.split(/,?\s*\bAdv(?:ocate)?\b\.?|\||\n|;/);
  const out: string[] = [];
  for (const p of parts) {
    for (const q of p.split(/\s*,\s*/)) {
      const name = squash(q).replace(/^[-–&,\s]+|[-–&,\s]+$/g, "");
      if (name && /[A-Za-z]{2}/.test(name) && !/^(?:and|for|with)$/i.test(name) && !contactResidue(name)) out.push(name);
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
