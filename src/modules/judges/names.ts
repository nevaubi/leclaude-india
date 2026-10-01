/**
 * Judge names (pure, client-safe). Official rosters print names with honorifics ("HONOURABLE SRI JUSTICE K.LAKSHMAN",
 * "Hon'ble Justice B.V. Nagarathna", "A.S. GADKARI, J."); judgment records print the bare name ("BELA M. TRIVEDI").
 * `normalizeJudgeName` removes honorifics, titles and punctuation and upper-cases, so the same printed name compares
 * equal across both. It never expands initials, reorders words or guesses: "C.M. POONACHA" and "CHEPPUDIRA MONAPPA
 * POONACHA" stay different (constitution §23: no closest-name binding).
 */

const HONORIFIC_WORDS = new Set([
  "HON", "HONBLE", "HONOURABLE", "HONORABLE", "THE", "MR", "MRS", "MS", "SMT", "SRI", "SHRI", "SHRIMATI", "KUMARI", "DR", "JUSTICE", "JUSTICES",
]);

/** Words that, when they lead the printed name, are a title (chief justice) rather than part of the name. */
const TITLE_PREFIX = /^(?:HON'?BLE|HONOURABLE|HONORABLE|THE|\s)*(?:ACTING\s+)?CHIEF\s+JUSTICE(?:\s+OF\s+INDIA)?\b/i;

function stripTrailingJ(s: string): string {
  // "A.S. GADKARI, J." / "NIVEDITA P. MEHTA J." / "X, CJ"
  return s.replace(/[,\s]+(?:C\.?\s*)?J\.?\s*$/i, "").trim();
}

/** The printed name without honorifics, titles or a trailing "J.", keeping its own spelling and punctuation. */
export function cleanJudgeName(printed: string): string {
  let s = printed.replace(/[‘’`]/g, "'").replace(/\s+/g, " ").trim();
  s = stripTrailingJ(s);
  s = s.replace(TITLE_PREFIX, " ").trim();
  // Leading honorific words, with or without dots ("Hon'ble", "Sri.", "Smt.", "Dr.").
  for (;;) {
    const m = /^([A-Za-z']+)\.?\s+/.exec(s);
    if (!m) break;
    const w = m[1].replace(/'/g, "").toUpperCase();
    if (!HONORIFIC_WORDS.has(w)) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

/** Comparison key: honorifics removed, upper-case, every run of non-letters/digits a single space. */
export function normalizeJudgeName(printed: string): string {
  return cleanJudgeName(printed)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Stable judge id: court id plus the normalized name as a slug, e.g. "sci--b-v-nagarathna". */
export function judgeId(courtId: string, nameNormalized: string): string {
  return `${courtId}--${nameNormalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

export function isJudgeId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.length <= 160 && /^[a-z0-9-]+--[a-z0-9-]+$/.test(id);
}

/** Up to two initials for an avatar fallback. */
export function judgeInitials(name: string): string {
  const words = cleanJudgeName(name).replace(/[^A-Za-z\s.]/g, " ").split(/[\s.]+/).filter(Boolean);
  if (!words.length) return "J";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/** Title case for display when a roster prints names in capitals ("K.LAKSHMAN" → "K. Lakshman"). The stored name is unchanged. */
export function displayJudgeName(name: string): string {
  const clean = cleanJudgeName(name);
  if (clean !== clean.toUpperCase()) return clean;
  return clean
    .replace(/\.(?=[A-Z])/g, ". ")
    .split(" ")
    .map((w) => (/^[A-Z]\.?$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
