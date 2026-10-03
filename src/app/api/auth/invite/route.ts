import { withDb } from "@/lib/db/request";
import { sessionCookieHeader } from "@/lib/auth/session";
import { acceptInvitation, publicInvitation } from "@/modules/workspace/admin-access";
import { readJsonObject, serviceErrorResponse, ServiceError } from "@/modules/workspace/errors";

export const runtime = "nodejs";

async function handleGET(req: Request) {
  try {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    return Response.json({ invitation: publicInvitation(token) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

async function handlePOST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) throw new ServiceError(422, "Invitation token is required.", { token: "Invitation token is required." }, "invalid");
    const result = await acceptInvitation(token, body);
    return Response.json(
      {
        ok: true,
        user: result.session.member,
        firmName: result.firmName,
        expiresAt: result.session.expiresAt,
        next: "/",
      },
      { headers: { "set-cookie": sessionCookieHeader(result.session.token), "cache-control": "no-store" } },
    );
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(handleGET);
export const POST = withDb(handlePOST);
