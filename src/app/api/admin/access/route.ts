import { withDb } from "@/lib/db/request";
import { withAuth, requirePrincipal } from "@/lib/auth/route";
import {
  adminAccessView,
  createFirm,
  createInvitation,
  resendInvitation,
  revokeInvitation,
  updateFirm,
} from "@/modules/workspace/admin-access";
import { readJsonObject, serviceErrorResponse, ServiceError } from "@/modules/workspace/errors";

export const runtime = "nodejs";

async function handleGET() {
  try {
    return Response.json(adminAccessView(requirePrincipal()), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

async function handlePOST(req: Request) {
  try {
    const actor = requirePrincipal();
    const body = await readJsonObject(req);
    const action = typeof body.action === "string" ? body.action : "";
    const origin = new URL(req.url).origin;

    if (action === "create_firm") {
      return Response.json({ firm: createFirm(actor, body) }, { status: 201 });
    }
    if (action === "update_firm") {
      return Response.json({ firm: updateFirm(actor, body) });
    }
    if (action === "invite_user") {
      return Response.json(await createInvitation(actor, body, origin), { status: 201 });
    }
    if (action === "resend_invite") {
      if (typeof body.id !== "string") throw new ServiceError(422, "Invitation id is required.", { id: "Invitation id is required." }, "invalid");
      return Response.json(await resendInvitation(actor, body.id, origin));
    }
    if (action === "revoke_invite") {
      if (typeof body.id !== "string") throw new ServiceError(422, "Invitation id is required.", { id: "Invitation id is required." }, "invalid");
      return Response.json({ invitation: revokeInvitation(actor, body.id) });
    }
    throw new ServiceError(400, "Unknown admin action.", undefined, "bad_action");
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "settings" }) }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: () => ({ kind: "settings" }) }));
