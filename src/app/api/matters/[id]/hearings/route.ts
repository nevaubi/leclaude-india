import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { addManualHearing, listManualHearings, requireMatter } from "@/modules/matters/desk/server";
import { readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET ?from&to — hearings entered by hand for this matter (courts whose cause lists are not parsed). */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const url = new URL(req.url);
  try {
    requireMatter(id);
    return Response.json({ hearings: listManualHearings(id, { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined }) });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

/** POST { date, time?, court?, courtNo?, itemNo?, bench?, purpose?, note? } — 201 with the stored hearing; 422 on a bad date or time. */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const body = await readJsonObject(req);
    return Response.json({ hearing: addManualHearing(id, body) }, { status: 201 });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: (_req, { id }) => refs.matter(id) }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: (_req, { id }) => refs.matter(id) }));
