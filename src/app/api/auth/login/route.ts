import { withDb } from "@/lib/db/request";
import { jsonError } from "@/lib/ai/sse";
import { clientIp } from "@/lib/auth/route";
import { sessionCookieHeader } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/session-token";
import { signIn } from "@/modules/workspace/signin";

export const runtime = "nodejs";

/**
 * POST /api/auth/login { email, password, next? } → 200 { ok, user, next } with the HttpOnly session cookie.
 * Public (it is how a session starts): 401 with one generic message for any wrong email/password, 429 with
 * Retry-After when rate-limited, 503 when AUTH_JWT_SECRET is not configured.
 */
async function handlePOST(req: Request) {
  let body: Record<string, unknown>;
  try {
    const v = (await req.json()) as unknown;
    body = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return jsonError("Request body must be JSON", 400, { code: "bad_json" });
  }
  const r = await signIn({ email: body.email, password: body.password, ip: clientIp(req) });
  if (!r.ok) {
    const res = jsonError(r.message, r.status, { code: r.code, ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) });
    if (r.retryAfter) res.headers.set("retry-after", String(r.retryAfter));
    res.headers.set("cache-control", "no-store");
    return res;
  }
  const next = safeNextPath(typeof body.next === "string" ? body.next : undefined);
  return Response.json(
    { ok: true, user: { id: r.member.id, name: r.member.name, email: r.member.email }, expiresAt: r.expiresAt, next },
    { headers: { "set-cookie": sessionCookieHeader(r.token), "cache-control": "no-store" } },
  );
}

export const POST = withDb(handlePOST);
