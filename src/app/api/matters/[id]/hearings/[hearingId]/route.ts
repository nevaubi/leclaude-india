import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { deleteManualHearing } from "@/modules/matters/desk/server";
import { serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; hearingId: string }> };

/** DELETE — remove a hand-entered hearing of this matter (a hearing of another matter is 404 here). */
async function handleDELETE(_req: NextRequest, { params }: Params) {
  const { id, hearingId } = await params;
  try {
    deleteManualHearing(id, hearingId);
    return Response.json({ ok: true });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

// Removing a hearing someone entered is an edit of the matter's diary, not a records deletion: write access suffices.
export const DELETE = withDb(withAuth(handleDELETE, { action: "write", resource: (_req, { id }) => refs.matter(id) }));
