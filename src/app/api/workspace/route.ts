import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth, requirePrincipal } from "@/lib/auth/route";
import { AuthError } from "@/lib/auth/errors";
import { canManageWorkspace, setupWorkspace, updateWorkspace, workspaceView } from "@/modules/workspace/service";
import { readJsonObject, serviceErrorResponse, ServiceError } from "@/modules/workspace/errors";
import { setInitialOwnerPassword } from "@/modules/workspace/signin";
import { passwordProblem } from "@/lib/auth/password";

export const runtime = "nodejs";

/** GET /api/workspace — { configured, firmName, owner }. No secrets, no settings. */
async function handleGET() {
  return Response.json(workspaceView());
}

/**
 * POST /api/workspace — first-run setup (201). 409 once the workspace is configured. An optional `password` becomes
 * the owner's sign-in password (validated before anything is written). With sign-in enforced, a fresh workspace is
 * set up through POST /api/auth/bootstrap instead (it needs AUTH_SETUP_TOKEN).
 */
async function handlePOST(req: NextRequest) {
  try {
    const body = await readJsonObject(req);
    if (body.password !== undefined && body.password !== "") {
      const problem = passwordProblem(body.password);
      if (problem) throw new ServiceError(422, problem, { password: problem }, "invalid");
    }
    const view = setupWorkspace(body);
    if (view.owner) await setInitialOwnerPassword(view.owner.id, body.password);
    return Response.json(view, { status: 201 });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

/** PUT /api/workspace — firm name and owner profile; the owner (or a partner/admin) only. */
async function handlePUT(req: NextRequest) {
  if (!canManageWorkspace(requirePrincipal())) throw AuthError.forbidden("only the workspace owner, a partner or an admin may edit the workspace");
  try {
    const body = await readJsonObject(req);
    return Response.json(updateWorkspace(body));
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "settings" }) }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: () => ({ kind: "settings" }) }));
export const PUT = withDb(withAuth(handlePUT, { action: "write", resource: () => ({ kind: "settings" }) }));
