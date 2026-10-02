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

const YEAR = /^(19|20)\d{2}$/;

function cleanType(t: string): string {
  return t.toUpperCase().replace(/\bNO\b\.?/g, "").replace(/[^A-Z0-9]/g, "");
}

/** Normalize one printed case number; null when it is not one. */
export function normalizeCaseNumber(printed: string): NormalizedCaseNumber | null {
  const s = printed.replace(/\s+/g, " ").trim();
  if (!s || s.length > 160) return null;
  // NCLT style: CP(IB)/29(MP)2022, IA/259(MP)2026, CA(CAA)/8(MP)2026
  let m = /^([A-Za-z.]+(?:\([A-Za-z.&]+\))?)\s*\/\s*(\d+)\s*\(([A-Za-z]{1,6})\)\s*\/?\s*((?:19|20)\d{2})$/.exec(s);
  if (m) {
    const type = cleanType(m[1]);
    if (!type) return null;
    const number = String(Number(m[2]));
    return { key: `${type}/${number}/${m[4]}`, type, number, year: m[4], bench: m[3].toUpperCase() };
  }
  // "<TYPE> No. 123 of 2026" / "<TYPE> No. 123/2026" / "<TYPE>-123/2026" / "<TYPE> 123/2026"
  m = /^(.+?)\s*(?:No\.?|Nos\.?)?\s*[- ]?\s*(\d{1,7})\s*(?:\/|\bof\b|-)\s*((?:19|20)\d{2})$/i.exec(s);
  if (m) {
    const type = cleanType(m[1]);
    if (!type || /^\d+$/.test(type) || !YEAR.test(m[3])) return null;
    const number = String(Number(m[2]));
    return { key: `${type}/${number}/${m[3]}`, type, number, year: m[3], bench: null };
  }
  return null;
}

/** Normalize a Supreme Court diary number ("Diary No. 54583-2026", "54583/2026", "545832026" with year) → "54583/2026". */
export function normalizeDiaryNo(printed: string): string | null {
  const s = printed.replace(/\s+/g, " ").trim();
  const m = /(?:Diary\s*No\.?\s*)?(\d{1,7})\s*[-/]\s*((?:19|20)\d{2})\b/i.exec(s);
  if (!m) return null;
  return `${Number(m[1])}/${m[2]}`;
}
