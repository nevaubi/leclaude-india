"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_LOCALE, type LocaleCode } from "@/lib/india/languages";
import { englishMessages, type Messages } from "./catalog";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, localeDir } from "./locale";
import { createTranslator, type TFunction, type Translator } from "./translator";

/**
 * Client i18n: `<I18nProvider>` is mounted once by the root layout with the resolved locale and its merged
 * messages; client components call `useT()` for `t` or `useI18n()` for formatting helpers and `setLocale`.
 * Outside a provider (isolated tests, storybook-like renders) the hooks fall back to English.
 */

export interface I18nContextValue extends Translator {
  locale: LocaleCode;
  /** Persist a new UI locale for this member (server preference + cookie) and re-render in it. */
  setLocale: (locale: LocaleCode) => Promise<boolean>;
}

const I18nContext = React.createContext<I18nContextValue | null>(null);

const englishFallback: I18nContextValue = {
  ...createTranslator(DEFAULT_LOCALE, englishMessages, "ltr"),
  locale: DEFAULT_LOCALE,
  setLocale: async () => false,
};

export function I18nProvider({ locale, messages, children }: { locale: LocaleCode; messages: Messages; children: React.ReactNode }) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const setLocale = React.useCallback(async (next: LocaleCode) => {
    let ok = false;
    try {
      const res = await fetch("/api/i18n", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: next }) });
      ok = res.ok;
    } catch { ok = false; }
    if (!ok) {
      // Keep the choice for this browser even when the preference could not be stored (e.g. before setup).
      try { document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(next)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`; } catch { /* no cookies */ }
    }
    try {
      document.documentElement.lang = next;
      document.documentElement.dir = localeDir(next);
    } catch { /* SSR */ }
    startTransition(() => router.refresh());
    return ok;
  }, [router]);
  const value = React.useMemo<I18nContextValue>(() => ({ ...createTranslator(locale, messages, localeDir(locale)), locale, setLocale }), [locale, messages, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Translator, formatters and `setLocale` for the active locale. */
export function useI18n(): I18nContextValue {
  return React.useContext(I18nContext) ?? englishFallback;
}

/** `t(key, vars)` for the active locale. */
export function useT(): TFunction {
  return useI18n().t;
}

/**
 * Render a message from a component that may be a server component's child: `<T k="nav.home" />`. Useful where a
 * server component passes chrome into a client subtree.
 */
export function T({ k, vars }: { k: Parameters<TFunction>[0]; vars?: Parameters<TFunction>[1] }) {
  return <>{useT()(k, vars)}</>;
}
