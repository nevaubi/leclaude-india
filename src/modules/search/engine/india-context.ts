/**
 * Deterministic Indian context for a research question (client-safe): the language and script it was asked in, the
 * language to answer in, and a date of offence stated in the question (for the IPC/BNS transition).
 *
 * Answer language order: the request's `answerLanguage` → the user's preferred answer language (i18n; see the hook
 * below) → the question's own language → English. Quotations are never translated in place: they stay in the source's
 * language and a labelled rendering follows them (engine/prompts.ts, engine/quotes.ts).
 */
import { defaultLanguageForScript, detectScript, isLocale, languageInfo, type LanguageInfo, type LocaleCode } from "@/lib/india/languages";

export interface QuestionLanguage {
  script: LanguageInfo["script"] | null;
  /** Best deterministic language for the script (Devanagari → hi, Bengali script → bn); "en" for Latin. */
  language: LocaleCode;
  /** True when retrieval needs English search terms (the corpus is predominantly English). */
  needsTranslation: boolean;
}

export function questionLanguage(question: string): QuestionLanguage {
  const script = detectScript(question);
  const language = defaultLanguageForScript(script);
  return { script, language, needsTranslation: Boolean(script && script !== "Latin") };
}

/**
 * The signed-in user's preferred answer language (src/lib/i18n/preferences.ts). Registered by engine/run.ts, which is
 * server-only; this module stays client-safe. Returns null for "auto" (answer in the question's language).
 */
export type PreferredAnswerLanguageHook = () => string | null | undefined;
let preferredAnswerLanguageHook: PreferredAnswerLanguageHook | null = null;

/** Register the i18n preference lookup (called once by the lead's integration; tests may set it). */
export function setPreferredAnswerLanguageHook(fn: PreferredAnswerLanguageHook | null): void {
  preferredAnswerLanguageHook = fn;
}

export function resolveAnswerLanguage(input: { requested?: string | null; question: string }): LocaleCode {
  if (isLocale(input.requested)) return input.requested;
  let preferred: string | null | undefined = null;
  try { preferred = preferredAnswerLanguageHook?.(); } catch { preferred = null; }
  if (isLocale(preferred)) return preferred;
  return questionLanguage(input.question).language;
}

/** The user-turn line that tells the model which language to write in. */
export function answerLanguageLine(code: LocaleCode): string {
  const info = languageInfo(code);
  const name = info ? `${info.name}${info.native !== info.name ? ` (${info.native})` : ""}` : code;
  return code === "en"
    ? "Answer language: English."
    : `Answer language: ${name}. Write the memo body in ${info?.name ?? code}; keep the section headings in English exactly as specified; keep quotations verbatim in the language of the source, each followed by your ${info?.name ?? code} rendering marked "(translation)".`;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1860 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A date of offence stated in the question ("offence committed on 15.03.2024", "occurred on 2 August 2024"). Returns
 * the date only when the text ties it to the offence/incident (or exactly one date appears); otherwise null — the
 * engine then reports that the governing code needs the date (never a guess).
 */
export function offenceDateFromText(text: string): string | null {
  const t = (text ?? "").replace(/\s+/g, " ");
  const found: { date: string; at: number }[] = [];
  const push = (date: string | null, at: number) => { if (date) found.push({ date, at }); };
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(iso(+m[1], +m[2], +m[3]), m.index ?? 0);
  for (const m of t.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/g)) push(iso(+m[3], +m[2], +m[1]), m.index ?? 0);
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"))) push(iso(+m[3], MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase().slice(0, 3))) + 1, +m[1]), m.index ?? 0);
  for (const m of t.matchAll(new RegExp(`\\b${MON_RE}\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi"))) push(iso(+m[3], MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))) + 1, +m[2]), m.index ?? 0);
  if (!found.length) return null;
  const anchored = found.filter((f) => /\b(offen[cs]e|incident|occurr|committed|alleged(?:ly)?|crime|FIR|assault|theft|cheat)/i.test(t.slice(Math.max(0, f.at - 80), f.at + 20)));
  if (anchored.length === 1) return anchored[0].date;
  const unique = Array.from(new Set(found.map((f) => f.date)));
  return unique.length === 1 && anchored.length !== 0 ? unique[0] : unique.length === 1 && /\b(offen[cs]e|IPC|BNS|FIR)\b/i.test(t) ? unique[0] : null;
}
