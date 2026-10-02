import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { ensureReview, errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { createRedaction, deleteRedaction, listRedactions } from "@/modules/ediscovery/review-service";
import type { RedactionInput } from "@/modules/ediscovery/types";

export const runtime = "nodejs";

/** GET ?doc= | ?matter= → { redactions: Redaction[] } */
async function GET__handler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const docId = sp.get("doc") ?? undefined;
  const matterId = sp.get("matter") ?? undefined;
  if (!docId && !matterId) return jsonError("`doc` or `matter` is required");
  ensureReview();
  return Response.json({ redactions: listRedactions({ docId, matterId }) });
}

/** POST RedactionInput → 201 { redaction } */
async function POST__handler(req: NextRequest) {
  const body = await readJson<RedactionInput>(req);
  if (!body?.docId || !body.kind || !body.reason) return jsonError("`docId`, `kind` and `reason` are required");
  try { return Response.json({ redaction: createRedaction(body) }, { status: 201 }); } catch (e) { return errorResponse(e); }
}

async function DELETE__handler(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return jsonError("`id` is required");
  return deleteRedaction(id) ? Response.json({ ok: true }) : jsonError(`No redaction ${id}`, 404);
}

export const GET = withDb(edAuth(GET__handler, { records: "ediscovery_redactions", docRefs: true }));

export const POST = withDb(edAuth(POST__handler, { records: "ediscovery_redactions", docRefs: true }));

export const DELETE = withDb(edAuth(DELETE__handler, { records: "ediscovery_redactions", docRefs: true }));
