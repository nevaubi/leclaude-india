import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { authMode, sessionPrincipalFromRequest } from "@/lib/auth/principal";
import { requirePrincipal, withAuth } from "@/lib/auth/route";
import { sessionCookieHeader } from "@/lib/auth/session";
import { readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";
import { adminSetPassword } from "@/modules/workspace/signin";

export const runtime = "nodejs";

/**
 * PUT /api/people/:id/password { password } → 200 { ok }. The owner, a partner or an admin, signed in with a
 * session (in AUTH_MODE=dev too: the demo persona can never set passwords); only the owner sets the owner's password.
 * Signs out the member's existing sessions; when you set your own, the response carries your new session cookie.
 */
async function handlePUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await readJsonObject(req);
    // The route principal is the session in jwt mode; in dev mode the cookie (if any) is checked explicitly.
    const p = requirePrincipal();
    const actor = p.source === "jwt" && p.sessionId ? p : authMode() === "dev" ? sessionPrincipalFromRequest(req) : null;
    const r = await adminSetPassword(actor, id, body.password);
    return Response.json({ ok: true, self: r.self }, { headers: r.session ? { "set-cookie": sessionCookieHeader(r.session.token) } : undefined });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const PUT = withDb(withAuth(handlePUT, { action: "write", resource: () => ({ kind: "settings" }) }));
