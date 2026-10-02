import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { deleteConflict, getConflict, updateConflict } from "@/modules/ediscovery/analysis/service";
import type { Conflict } from "@/lib/types/domain";

export const runtime = "nodejs";

/** GET → { conflict: ConflictRow, notes } */
async function GET__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = getConflict(id);
  if (!res) return jsonError(`No conflict ${id}`, 404);
  return Response.json(res);
}

/** PATCH { status? | severity? | title? | analysis? | kind? | addSide? | removeSideIndex? } → { conflict } */
async function PATCH__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<Partial<Pick<Conflict, "status" | "severity" | "title" | "analysis" | "kind">> & { addSide?: Conflict["sides"][number]; removeSideIndex?: number }>(req);
  if (!body) return jsonError("Invalid JSON body");
  try {
    const c = updateConflict(id, body);
    if (!c) return jsonError(`No conflict ${id}`, 404);
    return Response.json(getConflict(id));
  } catch (e) { return errorResponse(e); }
}

/** DELETE → { ok } */
async function DELETE__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json({ ok: deleteConflict(id) });
}

export const GET = withDb(edAuth(GET__handler, { lookup: "conflict" }));

export const PATCH = withDb(edAuth(PATCH__handler, { lookup: "conflict" }));

export const DELETE = withDb(edAuth(DELETE__handler, { lookup: "conflict" }));
