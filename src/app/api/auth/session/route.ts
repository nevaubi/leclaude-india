import { withDb } from "@/lib/db/request";
import { requirePrincipal, withAuth } from "@/lib/auth/route";

export const runtime = "nodejs";

/** GET /api/auth/session → the signed-in principal (id, name, email, roles, source, expiresAt). No secrets. */
async function handleGET() {
  const p = requirePrincipal();
  return Response.json({ id: p.id, name: p.name, email: p.email, roles: p.roles, source: p.source, expiresAt: p.expiresAt ?? null }, { headers: { "cache-control": "no-store" } });
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "settings" }) }));
