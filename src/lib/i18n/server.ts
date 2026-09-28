import "server-only";
import { cookies, headers } from "next/headers";
import type { LocaleCode } from "@/lib/india/languages";
import { messagesFor, type Messages } from "./catalog";
import { LOCALE_COOKIE, localeDir, resolveLocale } from "./locale";
import { effectiveLanguagePreferences } from "./preferences";
import { createTranslator, type TFunction, type Translator } from "./translator";

/**
 * Server helpers for pages, layouts and route handlers. Resolution order: `lc_locale` cookie → the user's stored
 * preference → workspace default → Accept-Language → English (see ./locale.ts).
 */
export async function getLocale(): Promise<LocaleCode> {
  let cookie: string | undefined;
  let accept: string | null = null;
  try { cookie = (await cookies()).get(LOCALE_COOKIE)?.value; } catch { /* outside a request */ }
  try { accept = (await headers()).get("accept-language"); } catch { /* outside a request */ }
  let userPreference: string | null = null;
  let workspaceDefault: string | null = null;
  try {
    const prefs = effectiveLanguagePreferences();
    userPreference = prefs.userLocale;
    workspaceDefault = prefs.workspace.defaultLocale;
  } catch { /* database unavailable: cookie and header still decide */ }
  return resolveLocale({ cookie, userPreference, workspaceDefault, acceptLanguage: accept });
}

export interface ServerI18n extends Translator {
  locale: LocaleCode;
  messages: Messages;
}

/** Locale, direction, merged messages and a bound translator for the current request. */
export async function getI18n(): Promise<ServerI18n> {
  const locale = await getLocale();
  const messages = messagesFor(locale);
  return { ...createTranslator(locale, messages, localeDir(locale)), locale, messages };
}

/** Just `t` for the current request: `const t = await getT(); t("settings.title")`. */
export async function getT(): Promise<TFunction> {
  return (await getI18n()).t;
}
