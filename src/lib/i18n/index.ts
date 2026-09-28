/**
 * LeClaude India i18n (client-safe entry). Server code imports `@/lib/i18n/server` (getI18n, getT, getLocale) and
 * `@/lib/i18n/preferences` (preferredAnswerLanguage); client components import `@/lib/i18n/client` (useT, useI18n).
 */
export { formatMessage, placeholders, type MessageVars } from "./icu";
export { CATALOGUES, MESSAGE_KEYS, messagesFor, missingKeys, englishMessages, type MessageKey, type Messages } from "./catalog";
export { createTranslator, type TFunction, type Translator } from "./translator";
export { formatDate, formatTime, formatDateTime, formatNumber, formatCurrency, inrWords, type DateStyle } from "./format";
export {
  LOCALE_COOKIE, ANSWER_LANGUAGE_COOKIE, DEFAULT_TIME_ZONE, DEFAULT_REGION,
  isUiLocale, parseAcceptLanguage, matchAcceptLanguage, resolveLocale, localeDir, intlTag, type LocaleInputs,
} from "./locale";
export { resolveAnswerLanguage, answerLanguageLabel, isAnswerLanguage, type AnswerLanguage } from "./answer-language";
export { relativeDue } from "./relative";
