/**
 * Language registry for LeClaude India (client-safe).
 *
 * UI locales: the languages the interface is translated into. Content languages: the languages judgments, statutes
 * and client documents may be in. Every locale carries its script, direction and the Noto font that renders it, so
 * layout never depends on a system font being present.
 *
 * Machine translation of legal text is never presented as the authoritative text: the original-language judgment
 * stays the source of record, and translated views are labelled with their origin (court-published translation,
 * provider translation, or machine translation) — see `TranslationOrigin`.
 */

export type LocaleCode = "en" | "hi" | "kn" | "te" | "ta" | "mr" | "bn" | "ur" | "gu" | "ml" | "pa" | "or" | "as";

export interface LanguageInfo {
  code: LocaleCode;
  /** English name. */
  name: string;
  /** Name in the language itself. */
  native: string;
  script: "Latin" | "Devanagari" | "Kannada" | "Telugu" | "Tamil" | "Bengali" | "Arabic" | "Gujarati" | "Malayalam" | "Gurmukhi" | "Odia";
  dir: "ltr" | "rtl";
  /** Google Fonts family that renders the script. */
  font: string;
  /** BCP-47 tag for Intl (dates, numbers with lakh/crore grouping). */
  intl: string;
  /** Interface translated (a full message catalogue ships). */
  ui: boolean;
  /** Focus-state language. */
  focus?: boolean;
  /** Code used by the Supreme Court judgment portal / dataset for translated judgments, where known. */
  sciCode?: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: "en", name: "English", native: "English", script: "Latin", dir: "ltr", font: "Inter", intl: "en-IN", ui: true },
  { code: "hi", name: "Hindi", native: "हिन्दी", script: "Devanagari", dir: "ltr", font: "Noto Sans Devanagari", intl: "hi-IN", ui: true, sciCode: "HIN" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", script: "Kannada", dir: "ltr", font: "Noto Sans Kannada", intl: "kn-IN", ui: true, focus: true, sciCode: "KAN" },
  { code: "te", name: "Telugu", native: "తెలుగు", script: "Telugu", dir: "ltr", font: "Noto Sans Telugu", intl: "te-IN", ui: true, focus: true, sciCode: "TEL" },
  { code: "ta", name: "Tamil", native: "தமிழ்", script: "Tamil", dir: "ltr", font: "Noto Sans Tamil", intl: "ta-IN", ui: true, sciCode: "TAM" },
  { code: "mr", name: "Marathi", native: "मराठी", script: "Devanagari", dir: "ltr", font: "Noto Sans Devanagari", intl: "mr-IN", ui: true, sciCode: "MAR" },
  { code: "bn", name: "Bengali", native: "বাংলা", script: "Bengali", dir: "ltr", font: "Noto Sans Bengali", intl: "bn-IN", ui: true, sciCode: "BEN" },
  { code: "ur", name: "Urdu", native: "اردو", script: "Arabic", dir: "rtl", font: "Noto Nastaliq Urdu", intl: "ur-IN", ui: true, focus: true, sciCode: "URD" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી", script: "Gujarati", dir: "ltr", font: "Noto Sans Gujarati", intl: "gu-IN", ui: false, sciCode: "GUJ" },
  { code: "ml", name: "Malayalam", native: "മലയാളം", script: "Malayalam", dir: "ltr", font: "Noto Sans Malayalam", intl: "ml-IN", ui: false, sciCode: "MAL" },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", script: "Gurmukhi", dir: "ltr", font: "Noto Sans Gurmukhi", intl: "pa-IN", ui: false, sciCode: "PUN" },
  { code: "or", name: "Odia", native: "ଓଡ଼ିଆ", script: "Odia", dir: "ltr", font: "Noto Sans Oriya", intl: "or-IN", ui: false, sciCode: "ORI" },
  { code: "as", name: "Assamese", native: "অসমীয়া", script: "Bengali", dir: "ltr", font: "Noto Sans Bengali", intl: "as-IN", ui: false, sciCode: "ASM" },
];

export const UI_LOCALES = LANGUAGES.filter((l) => l.ui).map((l) => l.code);
export const DEFAULT_LOCALE: LocaleCode = "en";

const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));
const bySci = new Map(LANGUAGES.filter((l) => l.sciCode).map((l) => [l.sciCode!, l]));

export function languageInfo(code: string | null | undefined): LanguageInfo | null {
  return code ? byCode.get(code as LocaleCode) ?? null : null;
}

export function languageBySciCode(code: string | null | undefined): LanguageInfo | null {
  return code ? bySci.get(code.toUpperCase()) ?? null : null;
}

export function isLocale(code: unknown): code is LocaleCode {
  return typeof code === "string" && byCode.has(code as LocaleCode);
}

/** Where a non-original text came from. Only `original` is the text of record. */
export type TranslationOrigin = "original" | "court_published" | "provider" | "machine";

const SCRIPT_RANGES: [LanguageInfo["script"], RegExp][] = [
  ["Devanagari", /[ऀ-ॿ]/g],
  ["Bengali", /[ঀ-৿]/g],
  ["Gurmukhi", /[਀-੿]/g],
  ["Gujarati", /[઀-૿]/g],
  ["Odia", /[଀-୿]/g],
  ["Tamil", /[஀-௿]/g],
  ["Telugu", /[ఀ-౿]/g],
  ["Kannada", /[ಀ-೿]/g],
  ["Malayalam", /[ഀ-ൿ]/g],
  ["Arabic", /[؀-ۿݐ-ݿ]/g],
  ["Latin", /[A-Za-z]/g],
];

/**
 * Dominant script of a text (deterministic). Devanagari is ambiguous between Hindi and Marathi and Bengali script
 * between Bengali and Assamese, so the script, not a guessed language, is returned; callers ask the router model
 * only when the distinction matters.
 */
export function detectScript(text: string): LanguageInfo["script"] | null {
  let best: LanguageInfo["script"] | null = null;
  let max = 0;
  for (const [script, re] of SCRIPT_RANGES) {
    const n = (text.match(re) ?? []).length;
    if (n > max) { max = n; best = script; }
  }
  return best;
}

/** Default language for a script when the language cannot be told apart deterministically. */
export function defaultLanguageForScript(script: LanguageInfo["script"] | null): LocaleCode {
  switch (script) {
    case "Devanagari": return "hi";
    case "Kannada": return "kn";
    case "Telugu": return "te";
    case "Tamil": return "ta";
    case "Bengali": return "bn";
    case "Arabic": return "ur";
    case "Gujarati": return "gu";
    case "Malayalam": return "ml";
    case "Gurmukhi": return "pa";
    case "Odia": return "or";
    default: return "en";
  }
}

/** Indian digit grouping (1,00,000 / 1,00,00,000) and rupee formatting. */
export function formatINR(amount: number, locale: LocaleCode = "en"): string {
  return new Intl.NumberFormat(languageInfo(locale)?.intl ?? "en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount);
}

/** Lakh/crore words for large amounts, as used in pleadings and court-fee computations ("₹12.5 lakh"). */
export function inrWords(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7)} crore`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5)} lakh`;
  return `${sign}₹${new Intl.NumberFormat("en-IN").format(abs)}`;
}

function trim(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}
