import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth, requirePrincipal } from "@/lib/auth/route";
import { jsonError } from "@/lib/ai/sse";
import { LANGUAGES, UI_LOCALES } from "@/lib/india/languages";
import { canManageWorkspace } from "@/modules/workspace/service";
import { ANSWER_LANGUAGE_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/lib/i18n/locale";
import { effectiveLanguagePreferences, LanguagePreferenceError, setUserLanguage, setWorkspaceLanguage } from "@/lib/i18n/preferences";

export const runtime = "nodejs";

/**
 * Language preferences for the signed-in member (and, for owners/partners/admins, the workspace defaults).
 * Personal preferences are the caller's own: the principal comes from the request, never from the body. Any
 * authenticated member may change their own language; workspace defaults require `canManageWorkspace`.
 */
function payload(userId: string) {
  const p = effectiveLanguagePreferences(userId);
  return {
    ...p,
    canManageWorkspace: canManageWorkspace(requirePrincipal()),
    uiLocales: UI_LOCALES,
    contentLanguages: LANGUAGES.map((l) => ({ code: l.code, name: l.name, native: l.native, dir: l.dir, ui: l.ui })),
  };
}

/** GET /api/i18n — effective preferences for the caller. */
async function handleGET() {
  return Response.json(payload(requirePrincipal().id));
}

/**
 * PUT /api/i18n — { locale?, answerLanguage?, workspace?: { defaultLocale?, answerLanguage? } }.
 * `null` clears a personal choice. Sets the `lc_locale` cookie so the next render uses the new locale.
 */
async function handlePUT(req: NextRequest) {
  const principal = requirePrincipal();
  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return jsonError("Expected a JSON object", 400);
    body = raw as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  const ws = body.workspace as Record<string, unknown> | undefined;
  if (ws !== undefined && (typeof ws !== "object" || ws === null || Array.isArray(ws))) return jsonError("workspace must be an object", 400);
  if (ws && !canManageWorkspace(principal)) return jsonError("Only the workspace owner, a partner or an admin may change the workspace language defaults", 403, { code: "forbidden" });
  try {
    if (body.locale !== undefined || body.answerLanguage !== undefined) setUserLanguage(principal.id, { locale: body.locale, answerLanguage: body.answerLanguage });
    if (ws) setWorkspaceLanguage({ defaultLocale: ws.defaultLocale, answerLanguage: ws.answerLanguage });
  } catch (e) {
    if (e instanceof LanguagePreferenceError) return jsonError(e.message, 400, { code: "invalid", fields: { [e.field]: e.message } });
    throw e;
  }
  const res = Response.json(payload(principal.id));
  const p = effectiveLanguagePreferences(principal.id);
  const cookie = (name: string, value: string | null) =>
    value
      ? `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`
      : `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  // The cookie mirrors the member's own choice; clearing it lets the workspace default and the browser decide.
  if (body.locale !== undefined) res.headers.append("Set-Cookie", cookie(LOCALE_COOKIE, p.userLocale));
  if (body.answerLanguage !== undefined) res.headers.append("Set-Cookie", cookie(ANSWER_LANGUAGE_COOKIE, p.userAnswerLanguage));
  return res;
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "settings" }) }));
// Personal preferences need only an authenticated principal; workspace defaults are checked in the handler.
export const PUT = withDb(withAuth(handlePUT, { action: "read", resource: () => ({ kind: "settings" }) }));
