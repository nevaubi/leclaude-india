import { withDb } from "@/lib/db/request";
import { jsonError } from "@/lib/ai/sse";
import { clientIp } from "@/lib/auth/route";
import { sessionCookieHeader } from "@/lib/auth/session";
import { readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";
import { bootstrapOwner, bootstrapStatus } from "@/modules/workspace/signin";

export const runtime = "nodejs";

/** GET /api/auth/bootstrap → booleans only: { configured, needsOwnerPassword, setupTokenConfigured, signInConfigured, enforced }. */
async function handleGET() {
  return Response.json(bootstrapStatus(), { headers: { "cache-control": "no-store" } });
}

/**
 * POST /api/auth/bootstrap { token, password, firmName?, name?, email?, role? } → 201 and a session cookie.
 * The one-time owner password: needs AUTH_SETUP_TOKEN and works only while no account has a password. On a fresh
 * workspace the firm and owner fields create it in the same call.
 */
async function handlePOST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const r = await bootstrapOwner(body, { ip: clientIp(req) });
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (r.session) headers["set-cookie"] = sessionCookieHeader(r.session.token);
    return Response.json({ ok: true, workspaceCreated: r.workspaceCreated, signedIn: Boolean(r.session) }, { status: 201, headers });
  } catch (e) {
    const retry = (e as { retryAfter?: number }).retryAfter;
    if (retry) return jsonError((e as Error).message, 429, { code: "rate_limited", retryAfter: retry });
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(handleGET);
export const POST = withDb(handlePOST);
