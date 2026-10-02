/**
 * Case-number normalization for exact matching of listings and orders to matters (client-safe, deterministic).
 *
 * Normalized form: "<TYPE>/<NUMBER>/<YEAR>" with TYPE upper-case letters and digits only, e.g.
 *   "SLP(C) No. 1234/2026"            → "SLPC/1234/2026"
 *   "W.P.(C)-5812/2016"               → "WPC/5812/2016"
 *   "Comp. App. (AT) (Ins) No. 351 of 2026" → "COMPAPPATINS/351/2026"
 *   "CP(IB)/29(MP)2022"               → "CPIB/29/2022"  (bench code "(MP)" kept in `bench`, not in the key)
 * Diary numbers normalize to "<number>/<year>" ("Diary No. 54583-2026" → "54583/2026").
 *
 * Contract: returns null when the text is not a single recognisable case number. Never guesses a type, number or
 * year; never strips a leading zero that changes identity (leading zeros are removed from the number only).
 *
 * Implementation owner: the courts stream (this file is the stable interface; the body may be extended with more
 * forum-specific forms and must stay backwards compatible with the examples above).
 *
 * Forms handled (all verified against published lists on 2026-10-02):
 * - Supreme Court: "SLP(C) No. 1234/2026", "SLP(Crl) No. 13176/2026", "C.A. No. 166/2019", "Crl.A. No. 166/2019",
 *   "W.P.(C) No. 12/2026", "W.P.(Crl.) No. 5/2026", "T.P.(C) No. 1935/2018", "T.P.(Crl.) No. 8/2026",
 *   "R.P.(C) No. 1/2026 in SLP(C) No. 2/2025" (compound: split with `splitCaseNumbers`), "MA 2911/2026",
 *   ranges "C.A. No. 6792-6796/2023" (not a single number: `normalizeCaseNumber` → null, `caseNumberKeys` expands),
 *   and the long forms used on judgments ("Criminal Appeal No. 166 of 2019" → "CRLA/166/2019").
 * - Delhi High Court: "W.P.(C)-5812/2016", "CS(COMM) 123/2026", "CRL.M.C. 4567/2026", "CM APPL. 20687/2020", and
 *   concatenated cells ("W.P.(C)-5726/2020CM APPL. 20687/2020WITH W.P.(C) 2240/2024") via `splitCaseNumbers`.
 * - NCLT: "CP(IB)/29(MP)2022", "IA/259(MP)2026", "CA(CAA)/8(MP)2026", "Co. Appeal/11(MP)2026",
 *   "Cont.App.(CP)/24(MP)2026". The same number exists at every bench, so `caseNumberKeys` also emits the
 *   bench-qualified key "CPIB/29/2022@MP".
 * - NCLAT: "Comp. App. (AT) (Ins) No. 2133 of 2024", "Competition App. (AT) No. 01 of 2026",
 *   "I.A. No. 2884, 5790 of 2026" (list: keys for each number).
 * - High Court eCourts style: "WP(C)/1234/2020", "CRL.A/12/2021".
 */

export interface NormalizedCaseNumber {
  /** "TYPE/NUMBER/YEAR" */
  key: string;
  type: string;
  number: string;
  year: string;
  /** Bench / registry code printed inside the number (NCLT "(MP)", "(MB)"), when present. */
  bench: string | null;
}

/** One printed case number with its normalized key (null when it is not a single number) and every exact key. */
export interface ParsedCaseNumber {
  printed: string;
  normalized: string | null;
  /** Exact match keys: the normalized key, a bench-qualified key (NCLT), or each number of a range / list. */
  keys: string[];
}

const YEAR = /^(19|20)\d{2}$/;
/** Ranges are expanded only when short and increasing ("3309-3310"); anything else yields no keys. */
const MAX_RANGE_SPAN = 200;
const MAX_LIST = 50;

/**
 * Official long / alternative forms that print the same registry type differently. Exact cleaned-type matches only;
 * anything not listed is kept as printed (cleaned), so an unknown type never collapses into another one.
 */
const TYPE_ALIASES: Record<string, string> = {
  CIVILAPPEAL: "CA",
  CRIMINALAPPEAL: "CRLA",
  CRLAPPEAL: "CRLA",
  SPECIALLEAVEPETITIONCIVIL: "SLPC",
  SPECIALLEAVEPETITIONC: "SLPC",
  SLPCIVIL: "SLPC",
  SPECIALLEAVEPETITIONCRIMINAL: "SLPCRL",
  SPECIALLEAVEPETITIONCRL: "SLPCRL",
  SLPCRIMINAL: "SLPCRL",
  WRITPETITIONCIVIL: "WPC",
  WRITPETITIONC: "WPC",
  WPCIVIL: "WPC",
  WRITPETITIONCRIMINAL: "WPCRL",
  WRITPETITIONCRL: "WPCRL",
  WPCRIMINAL: "WPCRL",
  TRANSFERPETITIONCIVIL: "TPC",
  TPCIVIL: "TPC",
  TRANSFERPETITIONCRIMINAL: "TPCRL",
  TPCRIMINAL: "TPCRL",
  REVIEWPETITIONCIVIL: "RPC",
  RPCIVIL: "RPC",
  REVIEWPETITIONCRIMINAL: "RPCRL",
  RPCRIMINAL: "RPCRL",
  CONTEMPTPETITIONCIVIL: "CONMTPETC",
  INTERLOCUTORYAPPLICATION: "IA",
  MISCELLANEOUSAPPLICATION: "MA",
  COMPANYAPPEALAT: "COMPAPPAT",
  COMPANYAPPEALATINS: "COMPAPPATINS",
  COMPANYAPPEALATINSOLVENCY: "COMPAPPATINS",
  COMPAPPATINSOLVENCY: "COMPAPPATINS",
  COMPETITIONAPPEALAT: "COMPETITIONAPPAT",
};

function cleanType(t: string): string {
  return t.toUpperCase().replace(/\bNOS?\b\.?/g, "").replace(/[^A-Z0-9]/g, "");
}

/** Canonical registry type for a printed type, or null when it is not one (empty, digits, too long). */
export function canonicalCaseType(printedType: string): string | null {
  const t = cleanType(printedType.replace(/^\s*(?:connected|with|in|and|along\s+with)\s+/i, ""));
  if (t.length < 1 || t.length > 40 || /\d/.test(t) || !/[A-Z]/.test(t)) return null;
  if (t === "DIARY" || t === "D") return null;
  return TYPE_ALIASES[t] ?? t;
}

const NCLT_RE = /^([A-Za-z][A-Za-z.]*(?:\s+[A-Za-z][A-Za-z.]*)*(?:\s*\([A-Za-z.&\s]+\))*)\s*\/\s*(\d{1,7})\s*\(([A-Za-z]{1,6})\)\s*\/?\s*((?:19|20)\d{2})$/;
const GENERAL_RE = /^(.+?)\s*(?:\bNos?\.?\s*)?[-/ ]?\s*(\d{1,7})\s*(?:\/|\bof\b|-)\s*((?:19|20)\d{2})$/i;

function tidy(printed: string): string {
  return printed.replace(/[ \s]+/g, " ").trim().replace(/[.,;:]+$/, "").trim();
}

/** Normalize one printed case number; null when it is not one. */
export function normalizeCaseNumber(printed: string): NormalizedCaseNumber | null {
  const s = tidy(printed);
  if (!s || s.length > 160) return null;
  if (/^diary\b/i.test(s)) return null;
  // NCLT style: CP(IB)/29(MP)2022, IA/259(MP)2026, CA(CAA)/8(MP)2026
  let m = NCLT_RE.exec(s);
  if (m) {
    const type = canonicalCaseType(m[1]);
    if (!type) return null;
    const number = String(Number(m[2]));
    return { key: `${type}/${number}/${m[4]}`, type, number, year: m[4], bench: m[3].toUpperCase() };
  }
  // Ranges ("No. 3309-3310/1997") and lists ("No. 2884, 5790 of 2026") are not a single case number.
  if (/\d\s*-\s*\d+\s*(?:\/|\bof\b)\s*(?:19|20)\d{2}$/i.test(s) || /\d\s*,\s*\d/.test(s)) return null;
  // "<TYPE> No. 123 of 2026" / "<TYPE> No. 123/2026" / "<TYPE>-123/2026" / "<TYPE> 123/2026" / "<TYPE>/123/2026"
  m = GENERAL_RE.exec(s);
  if (m) {
    const type = canonicalCaseType(m[1]);
    if (!type || !YEAR.test(m[3])) return null;
    const number = String(Number(m[2]));
    return { key: `${type}/${number}/${m[3]}`, type, number, year: m[3], bench: null };
  }
  return null;
}

/** The bench-qualified key used for NCLT numbers ("CPIB/29/2022@MP"); null when the number has no bench code. */
export function qualifiedCaseKey(n: NormalizedCaseNumber): string | null {
  return n.bench ? `${n.key}@${n.bench}` : null;
}

const RANGE_RE = /^(.+?)\s*(?:\bNos?\.?\s*)?[- ]?\s*(\d{1,7})\s*-\s*(\d{1,7})\s*(?:\/|\bof\b)\s*((?:19|20)\d{2})$/i;
const LIST_RE = /^(.+?)\s*(?:\bNos?\.?\s*)?[- ]?\s*(\d{1,7}(?:\s*,\s*\d{1,7})+)\s*(?:&\s*\d{1,7}\s*)?(?:\/|\bof\b)\s*((?:19|20)\d{2})$/i;

/**
 * Every exact key for one printed number: the normalized key (+ the NCLT bench-qualified key), or, for a short
 * increasing range / an explicit list sharing one type and year, one key per number. Unrecognised text → [].
 */
export function caseNumberKeys(printed: string): string[] {
  const single = normalizeCaseNumber(printed);
  if (single) {
    const q = qualifiedCaseKey(single);
    return q ? [single.key, q] : [single.key];
  }
  const s = tidy(printed);
  if (!s || s.length > 200 || /^diary\b/i.test(s)) return [];
  let m = RANGE_RE.exec(s);
  if (m) {
    const type = canonicalCaseType(m[1]);
    const a = Number(m[2]), b = Number(m[3]);
    if (!type || !(b > a) || b - a > MAX_RANGE_SPAN) return [];
    const out: string[] = [];
    for (let n = a; n <= b; n++) out.push(`${type}/${n}/${m[4]}`);
    return out;
  }
  m = LIST_RE.exec(s);
  if (m) {
    const type = canonicalCaseType(m[1]);
    if (!type) return [];
    const nums = m[2].split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (!nums.length || nums.length > MAX_LIST) return [];
    return [...new Set(nums.map((n) => `${type}/${n}/${m![3]}`))];
  }
  return [];
}

/** Printed number → { printed, normalized key (single numbers only), every exact key }. */
export function parseCaseNumber(printed: string): ParsedCaseNumber {
  const p = tidy(printed);
  const n = normalizeCaseNumber(p);
  return { printed: p, normalized: n?.key ?? null, keys: caseNumberKeys(p) };
}

// One case number inside free text: NCLT style first, then "<TYPE> [No.] N[-M | , N]* (/|of) YYYY".
const TYPE_TOKEN = String.raw`[A-Za-z][A-Za-z.()]*(?:\s+[A-Za-z(][A-Za-z.()]*)*`;
const SCAN_RE = new RegExp(
  String.raw`(${TYPE_TOKEN})\s*\/\s*(\d{1,7})\s*\(([A-Za-z]{1,6})\)\s*\/?\s*((?:19|20)\d{2})(?!\d)` +
    "|" +
    String.raw`(${TYPE_TOKEN})\s*(?:\bNos?\.?\s*)?[-/ ]?\s*(\d{1,7}(?:\s*-\s*\d{1,7})?(?:\s*,\s*\d{1,7})*)\s*(?:\/|\s+of\s+)\s*((?:19|20)\d{2})(?!\d)`,
  "gi",
);
const CONNECTOR = /^(?:(?:connected|along\s+with|alongwith|with|in|and)\s+)+/i;

/**
 * Split a cell that may hold several case numbers ("W.P.(C)-5726/2020CM APPL. 20687/2020WITH W.P.(C) 2240/2024",
 * "IA/259(MP)2026 in C.P.(IB)/18(MP)2021", "Comp. App. (AT) (Ins) No. 2133 of 2024 & I.A. No. 3940 of 2026") into the
 * printed numbers, in order. Diary numbers and text without a type are not case numbers and are not returned.
 */
export function splitCaseNumbers(text: string): string[] {
  if (!text) return [];
  // A year glued to the next type ("2020CM APPL.", "2020WITH") gets a space; nothing else is changed.
  const s = text.replace(/[ \s]+/g, " ").replace(/((?:19|20)\d{2})(?=[A-Za-z])/g, "$1 ");
  const out: string[] = [];
  SCAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCAN_RE.exec(s))) {
    let printed = m[0].trim();
    const lead = CONNECTOR.exec(printed);
    if (lead) printed = printed.slice(lead[0].length).trim();
    const typePart = (m[1] ?? m[5] ?? "").replace(CONNECTOR, "");
    if (/^diary\b/i.test(typePart) || /^diary\b/i.test(printed)) continue;
    if (!canonicalCaseType(typePart)) continue;
    out.push(printed);
  }
  return out;
}

/** All case numbers printed in a cell, parsed (order kept, duplicates by printed text removed). */
export function parseCaseNumbers(text: string): ParsedCaseNumber[] {
  const seen = new Set<string>();
  const out: ParsedCaseNumber[] = [];
  for (const p of splitCaseNumbers(text)) {
    const parsed = parseCaseNumber(p);
    if (seen.has(parsed.printed)) continue;
    seen.add(parsed.printed);
    out.push(parsed);
  }
  return out;
}

/** Normalize a Supreme Court diary number ("Diary No. 54583-2026", "54583/2026", "545832026" with year) → "54583/2026". */
export function normalizeDiaryNo(printed: string): string | null {
  const s = printed.replace(/\s+/g, " ").trim();
  const m = /(?:Diary\s*No\.?\s*)?(\d{1,7})\s*[-/]\s*((?:19|20)\d{2})\b/i.exec(s);
  if (!m) return null;
  return `${Number(m[1])}/${m[2]}`;
}

/** Diary numbers explicitly printed as such in free text ("Diary No. 54583-2026", "Diary Number 4240 / 2015"). */
export function findDiaryNos(text: string): string[] {
  const out: string[] = [];
  const re = /\bDiary\s*(?:No\.?|Number)\s*[-:]?\s*(\d{1,7})\s*[-/]\s*((?:19|20)\d{2})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = `${Number(m[1])}/${m[2]}`;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** A value that already is a normalized key ("SLPC/1234/2026", optionally bench-qualified "CPIB/29/2022@MP"). */
export function isCaseKey(v: string): boolean {
  return /^[A-Z][A-Z0-9]{0,39}\/[1-9]\d{0,6}\/(19|20)\d{2}(@[A-Z]{1,6})?$/.test(v);
}

/** A value that already is a normalized diary number ("54583/2026"). */
export function isDiaryKey(v: string): boolean {
  return /^[1-9]\d{0,6}\/(19|20)\d{2}$/.test(v);
}
