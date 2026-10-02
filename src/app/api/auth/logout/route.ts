import { clearSessionCookieHeader } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * POST /api/auth/logout → 200 and the session cookie cleared. Public and idempotent: it only removes this
 * browser's cookie. Sessions are stateless tokens (12 h); to revoke every session of an account, set a new password.
 */
async function handlePOST() {
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookieHeader(), "cache-control": "no-store" } });
}

export const POST = handlePOST;
