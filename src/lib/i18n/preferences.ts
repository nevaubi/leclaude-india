import "server-only";
import { kv } from "@/lib/db/kv";
import { currentPrincipal } from "@/lib/auth/context";
import { tenantId } from "@/lib/auth/principal";
import { currentUser } from "@/lib/current-user";
import { DEFAULT_LOCALE, type LocaleCode } from "@/lib/india/languages";
import { isAnswerLanguage, type AnswerLanguage } from "./answer-language";
import { DEFAULT_TIME_ZONE, isUiLocale } from "./locale";

export { resolveAnswerLanguage, answerLanguageLabel, isAnswerLanguage, type AnswerLanguage } from "./answer-language";

/**
 * Language preferences (server-only). Stored in kv, namespaced by tenant:
 *   i18n:workspace:<tenant>        workspace defaults (UI locale, answer language, time zone)
 *   i18n:user:<tenant>:<userId>    a member's own choices (UI locale, answer language)
 * The UI locale is mirrored in the `lc_locale` cookie so the root layout resolves it without a lookup; the stored
 * value is authoritative for server-side consumers (the research engine reads `preferredAnswerLanguage()`).
 * Preferences are UI continuity, never evidence, and carry no matter data.
 */

export interface WorkspaceLanguageSettings {
  defaultLocale: LocaleCode;
  answerLanguage: AnswerLanguage;
  timeZone: string;
  updatedAt?: string;
}

export interface UserLanguagePreferences {
  locale?: LocaleCode;
  answerLanguage?: AnswerLanguage;
  updatedAt?: string;
}

export interface EffectiveLanguagePreferences {
  /** The member's UI locale choice, or null when they follow the workspace default. */
  userLocale: LocaleCode | null;
  /** The member's answer-language choice, or null when they follow the workspace default. */
  userAnswerLanguage: AnswerLanguage | null;
  workspace: WorkspaceLanguageSettings;
  /** What applies: user choice, else workspace default. */
  locale: LocaleCode;
  answerLanguage: AnswerLanguage;
}

const WORKSPACE_DEFAULTS: WorkspaceLanguageSettings = { defaultLocale: DEFAULT_LOCALE, answerLanguage: "auto", timeZone: DEFAULT_TIME_ZONE };

function safeTenant(): string {
  try { return tenantId(); } catch { return "default"; }
}

const workspaceKey = () => `i18n:workspace:${safeTenant()}`;
const userKey = (userId: string) => `i18n:user:${safeTenant()}:${userId}`;

/** The acting user: the request principal when there is one, otherwise the workspace identity. */
export function currentUserId(): string {
  try { return currentPrincipal()?.id ?? currentUser().id; } catch { return currentUser().id; }
}

export function getWorkspaceLanguage(): WorkspaceLanguageSettings {
  let stored: Partial<WorkspaceLanguageSettings> | null = null;
  try { stored = kv.get<Partial<WorkspaceLanguageSettings>>(workspaceKey()); } catch { stored = null; }
  return {
    defaultLocale: isUiLocale(stored?.defaultLocale) ? stored!.defaultLocale : WORKSPACE_DEFAULTS.defaultLocale,
    answerLanguage: isAnswerLanguage(stored?.answerLanguage) ? stored!.answerLanguage : WORKSPACE_DEFAULTS.answerLanguage,
    timeZone: typeof stored?.timeZone === "string" && stored.timeZone ? stored.timeZone : WORKSPACE_DEFAULTS.timeZone,
    updatedAt: stored?.updatedAt,
  };
}

export function setWorkspaceLanguage(patch: { defaultLocale?: unknown; answerLanguage?: unknown }): WorkspaceLanguageSettings {
  const cur = getWorkspaceLanguage();
  const next: WorkspaceLanguageSettings = {
    ...cur,
    defaultLocale: patch.defaultLocale === undefined ? cur.defaultLocale : isUiLocale(patch.defaultLocale) ? patch.defaultLocale : invalid("defaultLocale"),
    answerLanguage: patch.answerLanguage === undefined ? cur.answerLanguage : isAnswerLanguage(patch.answerLanguage) ? patch.answerLanguage : invalid("answerLanguage"),
    updatedAt: new Date().toISOString(),
  };
  kv.set(workspaceKey(), next);
  return next;
}

export function getUserLanguage(userId = currentUserId()): UserLanguagePreferences {
  let stored: UserLanguagePreferences | null = null;
  try { stored = kv.get<UserLanguagePreferences>(userKey(userId)); } catch { stored = null; }
  return {
    locale: isUiLocale(stored?.locale) ? stored!.locale : undefined,
    answerLanguage: isAnswerLanguage(stored?.answerLanguage) ? stored!.answerLanguage : undefined,
    updatedAt: stored?.updatedAt,
  };
}

/** Update a member's choices; `null` clears a choice (follow the workspace default). */
export function setUserLanguage(userId: string, patch: { locale?: unknown; answerLanguage?: unknown }): UserLanguagePreferences {
  const cur = getUserLanguage(userId);
  const next: UserLanguagePreferences = { ...cur, updatedAt: new Date().toISOString() };
  if (patch.locale === null) delete next.locale;
  else if (patch.locale !== undefined) next.locale = isUiLocale(patch.locale) ? patch.locale : invalid("locale");
  if (patch.answerLanguage === null) delete next.answerLanguage;
  else if (patch.answerLanguage !== undefined) next.answerLanguage = isAnswerLanguage(patch.answerLanguage) ? patch.answerLanguage : invalid("answerLanguage");
  kv.set(userKey(userId), next);
  return next;
}

export function effectiveLanguagePreferences(userId = currentUserId()): EffectiveLanguagePreferences {
  const workspace = getWorkspaceLanguage();
  const user = getUserLanguage(userId);
  return {
    userLocale: user.locale ?? null,
    userAnswerLanguage: user.answerLanguage ?? null,
    workspace,
    locale: user.locale ?? workspace.defaultLocale,
    answerLanguage: user.answerLanguage ?? workspace.answerLanguage,
  };
}

/**
 * The answer language the research assistant should write in for this user: their choice, else the workspace
 * default, else "auto" (the question's language). Pass the question to `resolveAnswerLanguage()` to turn "auto"
 * into a concrete language. Safe outside a request (falls back to the workspace identity and defaults).
 */
export function preferredAnswerLanguage(userId?: string): AnswerLanguage {
  try {
    return effectiveLanguagePreferences(userId ?? currentUserId()).answerLanguage;
  } catch {
    return "auto";
  }
}

export class LanguagePreferenceError extends Error {
  constructor(public field: string) { super(`Unsupported value for ${field}`); this.name = "LanguagePreferenceError"; }
}

function invalid(field: string): never {
  throw new LanguagePreferenceError(field);
}
