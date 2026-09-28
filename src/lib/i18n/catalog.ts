/**
 * Message catalogues for the UI locales (client-safe). Server code merges a locale's catalogue over English and
 * passes the result to the client provider, so the browser bundle carries only English plus the active locale.
 */
import type { LocaleCode } from "@/lib/india/languages";
import { en, type MessageKey, type Messages } from "./messages/en";
import { hi } from "./messages/hi";
import { kn } from "./messages/kn";
import { te } from "./messages/te";
import { ta } from "./messages/ta";
import { mr } from "./messages/mr";
import { bn } from "./messages/bn";
import { ur } from "./messages/ur";

export type { MessageKey, Messages } from "./messages/en";

/** Catalogue per UI locale. Locales without a catalogue (gu, ml, pa, or, as) fall back to English. */
export const CATALOGUES: Partial<Record<LocaleCode, Messages>> = { en, hi, kn, te, ta, mr, bn, ur };

export const MESSAGE_KEYS = Object.keys(en) as MessageKey[];

/** A locale's messages with English filling any gap (a missing or empty entry is never shown blank). */
export function messagesFor(locale: string): Messages {
  const cat = CATALOGUES[locale as LocaleCode];
  if (!cat || cat === en) return en;
  const out = { ...en } as Record<MessageKey, string>;
  for (const k of MESSAGE_KEYS) {
    const v = cat[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/** Keys a catalogue lacks or leaves empty (for tests and a dev warning). */
export function missingKeys(locale: string): MessageKey[] {
  const cat = CATALOGUES[locale as LocaleCode] as Partial<Record<string, string>> | undefined;
  if (!cat) return [...MESSAGE_KEYS];
  return MESSAGE_KEYS.filter((k) => typeof cat[k] !== "string" || !cat[k]!.trim());
}

export { en as englishMessages };
