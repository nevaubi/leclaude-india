import { withDb } from "@/lib/db/request";
import { withAuth, requirePrincipal } from "@/lib/auth/route";
import { AuthError } from "@/lib/auth/errors";
import { jsonError } from "@/lib/ai/sse";
import { canManageWorkspace } from "@/modules/workspace/service";
import { demoStatus, DemoPackError, loadDemoPack, removeDemoPack } from "@/modules/demo";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Demo data (Settings → Demo data).
 *   GET    status: { loaded, loadedAt, loadedBy, counts, matterId, relatedMatterId, matterIds }
 *   POST   load (or reload in place) the India demo pack (Bengaluru and Hyderabad) — owner, partner or admin only
 *   DELETE remove exactly the records the pack wrote — owner, partner or admin only
 */
function requireAdmin() {
  if (!canManageWorkspace(requirePrincipal())) throw AuthError.forbidden("only the workspace owner, a partner or an admin may load or remove demo data");
}

function errorResponse(e: unknown): Response {
  if (e instanceof DemoPackError) return jsonError(e.message, e.status, { code: e.code });
  throw e;
}

async function handleGET() {
  return Response.json(demoStatus());
}

async function handlePOST() {
  requireAdmin();
  try {
    const r = await loadDemoPack({ principal: requirePrincipal() });
    return Response.json({ ...r.status, durationMs: r.durationMs });
  } catch (e) {
    return errorResponse(e);
  }
}

async function handleDELETE() {
  requireAdmin();
  try {
    const r = removeDemoPack({ principal: requirePrincipal() });
    return Response.json({ ...demoStatus(), removed: r.removed, durationMs: r.durationMs });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "settings" }) }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: () => ({ kind: "settings" }) }));
export const DELETE = withDb(withAuth(handleDELETE, { action: "write", resource: () => ({ kind: "settings" }) }));
