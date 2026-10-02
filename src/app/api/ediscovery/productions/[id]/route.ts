import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import type { ProductionSet } from "@/lib/types/domain";
import { ensureReview, errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { deleteProduction, getProduction, productionRows, removeFromProduction, updateProduction } from "@/modules/ediscovery/review-service";

export const runtime = "nodejs";

/** GET → { production: ProductionSummary2, rows } */
async function GET__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  ensureReview();
  const production = getProduction(id);
  if (!production) return jsonError(`No production ${id}`, 404);
  return Response.json({ production, rows: productionRows(id) });
}

/** PATCH { name?, status?, stampText?, notes?, volume?, remove?: docId[] } → { production, rows } (status: draft → qc → final; qc runs on the way) */
async function PATCH__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<Partial<Pick<ProductionSet, "name" | "status" | "stampText" | "notes" | "volume">> & { remove?: string[] }>(req);
  if (!body) return jsonError("Invalid JSON body");
  try {
    if (body.remove?.length) removeFromProduction(id, body.remove);
    const { remove: _r, ...patch } = body;
    void _r;
    if (Object.keys(patch).length) updateProduction(id, patch);
    return Response.json({ production: getProduction(id), rows: productionRows(id) });
  } catch (e) { return errorResponse(e); }
}

async function DELETE__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { return deleteProduction(id) ? Response.json({ ok: true }) : jsonError(`No production ${id}`, 404); } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler, { lookup: "production" }));

export const PATCH = withDb(edAuth(PATCH__handler, { lookup: "production" }));

export const DELETE = withDb(edAuth(DELETE__handler, { lookup: "production" }));
