import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import type { ReviewBatch } from "@/lib/types/domain";
import { ensureReview, errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { deleteBatch, getBatch, updateBatch } from "@/modules/ediscovery/review-service";

export const runtime = "nodejs";

/** GET → { batch: ReviewBatchSummary & { disagreements } } */
async function GET__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  ensureReview();
  const batch = getBatch(id);
  if (!batch) return jsonError(`No batch ${id}`, 404);
  return Response.json({ batch });
}

/** PATCH { name?, description?, assigneeId?, priority?, dueAt?, status?, qcSamplePercent?, secondPass? } → { batch } */
async function PATCH__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<Partial<Pick<ReviewBatch, "name" | "description" | "assigneeId" | "priority" | "dueAt" | "status" | "qcSamplePercent" | "secondPass">>>(req);
  if (!body) return jsonError("Invalid JSON body");
  try {
    const batch = updateBatch(id, body);
    if (!batch) return jsonError(`No batch ${id}`, 404);
    return Response.json({ batch: getBatch(id) });
  } catch (e) { return errorResponse(e); }
}

async function DELETE__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return deleteBatch(id) ? Response.json({ ok: true }) : jsonError(`No batch ${id}`, 404);
}

export const GET = withDb(edAuth(GET__handler, { lookup: "batch" }));

export const PATCH = withDb(edAuth(PATCH__handler, { lookup: "batch" }));

export const DELETE = withDb(edAuth(DELETE__handler, { lookup: "batch" }));
