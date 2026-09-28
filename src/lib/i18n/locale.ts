/**
 * Locale resolution (pure, client-safe). The interface locale is chosen in this order:
 *   1. the `lc_locale` cookie (set by the locale switcher),
 *   2. the user's stored preference,
 *   3. the workspace default (Settings → Language & region),
 *   4. the browser's Accept-Language header (best supported match),
 *   5. English.
 * Only locales with a shipped catalogue (UI_LOCALES) are eligible.
 */
import { DEFAULT_LOCALE, UI_LOCALES, languageInfo, type LocaleCode } from "@/lib/india/languages";

export const LOCALE_COOKIE = "lc_locale";
export const ANSWER_LANGUAGE_COOKIE = "lc_answer_lang";
/** One year; the preference is also stored server-side, the cookie only avoids a lookup. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";
export const DEFAULT_REGION = "IN";

export function isUiLocale(v: unknown): v is LocaleCode {
  return typeof v === "string" && (UI_LOCALES as string[]).includes(v);
}

/** Parse an Accept-Language header into tags ordered by q (stable for equal weights). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag);
}

/** Best UI locale for an Accept-Language header ("kn-IN,kn;q=0.9,en;q=0.8" → "kn"); null when none match. */
export function matchAcceptLanguage(header: string | null | undefined): LocaleCode | null {
  for (const tag of parseAcceptLanguage(header)) {
    const base = tag.split("-")[0];
    if (isUiLocale(base)) return base;
  }
  return null;
}

export interface LocaleInputs {
  cookie?: string | null;
  userPreference?: string | null;
  workspaceDefault?: string | null;
  acceptLanguage?: string | null;
}

export function resolveLocale(input: LocaleInputs): LocaleCode {
  if (isUiLocale(input.cookie)) return input.cookie;
  if (isUiLocale(input.userPreference)) return input.userPreference;
  if (isUiLocale(input.workspaceDefault)) return input.workspaceDefault;
  return matchAcceptLanguage(input.acceptLanguage) ?? DEFAULT_LOCALE;
}

export function localeDir(locale: string): "ltr" | "rtl" {
  return languageInfo(locale)?.dir ?? "ltr";
}

/** BCP-47 tag for Intl (dates, plural rules); Latin digits are applied by the formatters. */
export function intlTag(locale: string): string {
  return languageInfo(locale)?.intl ?? "en-IN";
}
