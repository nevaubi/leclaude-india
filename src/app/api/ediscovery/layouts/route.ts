import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { deleteLayout, listLayouts, saveLayout } from "@/modules/ediscovery/review-service";
import type { ReviewLayoutInput } from "@/modules/ediscovery/types";

export const runtime = "nodejs";

/** GET ?matter= → { layouts: ReviewLayout[] } for the current user. */
async function GET__handler(req: NextRequest) {
  return Response.json({ layouts: listLayouts(undefined, req.nextUrl.searchParams.get("matter") ?? undefined) });
}

/** POST ReviewLayoutInput → { layout } (upsert by name). */
async function POST__handler(req: NextRequest) {
  const body = await readJson<ReviewLayoutInput>(req);
  if (!body) return jsonError("Invalid JSON body");
  try { return Response.json({ layout: saveLayout(body) }, { status: 201 }); } catch (e) { return errorResponse(e); }
}

async function DELETE__handler(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return jsonError("`id` is required");
  return deleteLayout(id) ? Response.json({ ok: true }) : jsonError(`No layout ${id}`, 404);
}

export const GET = withDb(edAuth(GET__handler, { records: "ediscovery_layouts" }));

export const POST = withDb(edAuth(POST__handler, { records: "ediscovery_layouts" }));

export const DELETE = withDb(edAuth(DELETE__handler, { records: "ediscovery_layouts" }));
