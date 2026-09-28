/**
 * Answer-language contract (client-safe, pure). The research assistant writes its answer in the user's preferred
 * answer language; "auto" means the language of the question, detected from its script. Quotations, citations and
 * statute names stay in the source language whatever the answer language is.
 */
import { LANGUAGES, defaultLanguageForScript, detectScript, languageInfo, type LocaleCode } from "@/lib/india/languages";

export type AnswerLanguage = LocaleCode | "auto";

export function isAnswerLanguage(v: unknown): v is AnswerLanguage {
  return v === "auto" || (typeof v === "string" && LANGUAGES.some((l) => l.code === v));
}

/**
 * The concrete language to answer in. `auto` follows the question's dominant script (Devanagari → Hindi, Kannada →
 * Kannada, Arabic script → Urdu, …) and falls back to `fallback` (English) for Latin or empty text. Devanagari cannot
 * tell Hindi from Marathi deterministically; a caller that knows better passes the explicit preference instead.
 */
export function resolveAnswerLanguage(pref: AnswerLanguage | null | undefined, question = "", fallback: LocaleCode = "en"): LocaleCode {
  if (pref && pref !== "auto") return pref;
  const script = detectScript(question);
  if (!script || script === "Latin") return fallback;
  return defaultLanguageForScript(script);
}

/** English name of the answer language for a model instruction ("Answer in Kannada (ಕನ್ನಡ)."). */
export function answerLanguageLabel(code: LocaleCode): string {
  const l = languageInfo(code);
  return l ? (l.code === "en" ? l.name : `${l.name} (${l.native})`) : code;
}
