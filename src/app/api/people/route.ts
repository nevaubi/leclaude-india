import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth, requirePrincipal } from "@/lib/auth/route";
import { AuthError } from "@/lib/auth/errors";
import { canManageWorkspace, createMember, getMember, isPlatformAdmin, listTeam, principalFirmId } from "@/modules/workspace/service";
import { hasPassword } from "@/lib/auth/accounts";
import { readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";

/** GET /api/people?inactive=1&q=… — firm team members (attorneys, paralegals, staff); `hasPassword` per member for managers. */
async function handleGET(req: NextRequest) {
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("inactive") === "1" || url.searchParams.get("inactive") === "true";
  const principal = requirePrincipal();
  const canManage = canManageWorkspace(principal);
  const platformAdmin = isPlatformAdmin(principal);
  const people = listTeam({
    includeInactive,
    q: url.searchParams.get("q") ?? undefined,
    firmId: platformAdmin ? undefined : principalFirmId(principal) ?? undefined,
  });
  // Managers see whether each member can sign in (a boolean only; hashes never leave the server).
  return Response.json({ people: canManage ? people.map((p) => ({ ...p, hasPassword: hasPassword(p.id) })) : people, canManage, me: principal.id });
}

/** POST /api/people — add a team member (201); the owner, a partner or an admin only. 409 on a duplicate email. */
async function handlePOST(req: NextRequest) {
  const principal = requirePrincipal();
  if (!canManageWorkspace(principal)) throw AuthError.forbidden("only the workspace owner, a partner or an admin may manage the team");
  try {
    const body = await readJsonObject(req);
    if (isPlatformAdmin(principal)) return Response.json({ person: createMember(body) }, { status: 201 });
    const actor = getMember(principal.id);
    return Response.json({
      person: createMember(body, {
        firmId: actor?.firmId,
        firmName: actor?.firmName,
        matterScope: actor?.matterScope,
      }),
    }, { status: 201 });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "settings" }) }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: () => ({ kind: "settings" }) }));
