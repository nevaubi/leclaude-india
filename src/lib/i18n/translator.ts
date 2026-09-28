/**
 * `t(key, vars)` for a locale (client-safe, pure). The same translator backs the React hook and the server helper.
 */
import { formatMessage, type MessageVars } from "./icu";
import { englishMessages, type MessageKey, type Messages } from "./catalog";
import { intlTag } from "./locale";
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatTime, type DateOptions, type DateStyle } from "./format";

export type TFunction = (key: MessageKey, vars?: MessageVars) => string;

export interface Translator {
  locale: string;
  dir: "ltr" | "rtl";
  t: TFunction;
  /** True when `key` is a known message key (for dynamic keys such as `noun.${noun}`). */
  has: (key: string) => key is MessageKey;
  /** Translate a dynamic key when it exists, otherwise return `fallback`. */
  tx: (key: string, fallback: string, vars?: MessageVars) => string;
  date: (value: string | number | Date | null | undefined, style?: DateStyle, opts?: DateOptions) => string;
  time: (value: string | number | Date | null | undefined, opts?: DateOptions) => string;
  dateTime: (value: string | number | Date | null | undefined, opts?: DateOptions) => string;
  number: (n: number | null | undefined, maximumFractionDigits?: number) => string;
  currency: (amount: number | null | undefined) => string;
}

export function createTranslator(locale: string, messages: Messages = englishMessages, dir: "ltr" | "rtl" = "ltr"): Translator {
  const tag = intlTag(locale);
  const t: TFunction = (key, vars) => {
    const template = messages[key] ?? englishMessages[key] ?? key;
    return formatMessage(template, vars, tag);
  };
  const has = (key: string): key is MessageKey => Object.prototype.hasOwnProperty.call(englishMessages, key);
  return {
    locale,
    dir,
    t,
    has,
    tx: (key, fallback, vars) => (has(key) ? t(key, vars) : fallback),
    date: (v, style, opts) => formatDate(v, locale, style, opts),
    time: (v, opts) => formatTime(v, locale, opts),
    dateTime: (v, opts) => formatDateTime(v, locale, opts),
    number: formatNumber,
    currency: formatCurrency,
  };
}
