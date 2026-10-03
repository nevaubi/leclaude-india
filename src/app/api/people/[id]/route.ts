import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth, requirePrincipal } from "@/lib/auth/route";
import { AuthError } from "@/lib/auth/errors";
import { jsonError } from "@/lib/ai/sse";
import { canManageWorkspace, deactivateMember, getMember, isPlatformAdmin, principalFirmId, updateMember } from "@/modules/workspace/service";
import { readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

function assertVisible(id: string) {
  const principal = requirePrincipal();
  const person = getMember(id);
  if (!person) return null;
  if (!isPlatformAdmin(principal) && person.firmId !== principalFirmId(principal)) throw AuthError.forbidden("you can only access people in your firm");
  return person;
}

async function handleGET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const person = assertVisible(id);
  if (!person) return jsonError("Team member not found", 404, { code: "not_found" });
  return Response.json({ person });
}

/** PATCH — name, email, role, title, or `{ active: true }` to reactivate. Members may edit their own profile but not their role. */
async function handlePATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const principal = requirePrincipal();
  assertVisible(id);
  try {
    const body = await readJsonObject(req);
    const self = principal.id === id;
    const manager = canManageWorkspace(principal);
    const touchesAccess = body.role !== undefined || body.firmRole !== undefined || body.active !== undefined;
    if (!manager && (!self || touchesAccess)) throw AuthError.forbidden("only the workspace owner, a partner or an admin may change team roles or other members");
    return Response.json({ person: updateMember(id, body) });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

/** DELETE — deactivates the member (never deletes: matters, coding and the audit trail keep resolving). The owner cannot be deactivated. */
async function handleDELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const principal = requirePrincipal();
  if (!canManageWorkspace(principal)) throw AuthError.forbidden("only the workspace owner, a partner or an admin may manage the team");
  assertVisible(id);
  try {
    return Response.json({ person: deactivateMember(id) });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "settings" }) }));
export const PATCH = withDb(withAuth(handlePATCH, { action: "write", resource: () => ({ kind: "settings" }) }));
export const DELETE = withDb(withAuth(handleDELETE, { action: "write", resource: () => ({ kind: "settings" }) }));
