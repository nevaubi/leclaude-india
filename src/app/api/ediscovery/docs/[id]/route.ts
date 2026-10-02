import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { cachedAnalysis } from "@/modules/ediscovery/ai";
import { getDocument, updateCoding } from "@/modules/ediscovery/service";
import { recordQcDecision } from "@/modules/ediscovery/review-service";
import type { CodingPatch } from "@/modules/ediscovery/types";

export const runtime = "nodejs";

/** GET → { doc, row, family, reviewerName, analysis: AIAnalysis & { provenance? } | null, provenance: doc.aiProvenance } */
async function GET__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = getDocument(id, { recordView: req.nextUrl.searchParams.get("view") !== "0" });
  if (!detail) return jsonError(`No document ${id}`, 404);
  return Response.json({ ...detail, analysis: cachedAnalysis(detail.doc.id), provenance: detail.doc.aiProvenance ?? null });
}

/**
 * PATCH { coding, reviewerId?, batchId?, qc? } → { doc: { id, coding, aiProvenance }, qc? } (audited as coding.change).
 * With `batchId` + `qc: true` the call is a QC decision: the first-pass coding is snapshotted against the new call before it is saved.
 */
async function PATCH__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<{ coding?: CodingPatch; reviewerId?: string; batchId?: string; qc?: boolean }>(req);
  if (!body?.coding) return jsonError("`coding` is required");
  try {
    let qc: { agree: boolean } | undefined;
    if (body.batchId && body.qc) {
      const b = recordQcDecision(body.batchId, id, { responsive: body.coding.responsive, privileged: body.coding.privileged, hot: body.coding.hot, issues: body.coding.issues }, body.reviewerId);
      qc = { agree: b.qcDecisions[id]?.agree ?? true };
    }
    const doc = updateCoding(id, body.coding, body.reviewerId);
    if (!doc) return jsonError(`No document ${id}`, 404);
    return Response.json({ doc: { id: doc.id, coding: doc.coding, aiProvenance: doc.aiProvenance ?? null }, ...(qc ? { qc } : {}) });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withDb(edAuth(GET__handler, { lookup: "edoc" }));

export const PATCH = withDb(edAuth(PATCH__handler, { lookup: "edoc" }));
