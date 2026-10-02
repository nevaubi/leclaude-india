import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { bulkCode, bulkPreview } from "@/modules/ediscovery/service";
import type { BulkCodingRequest } from "@/modules/ediscovery/types";

export const runtime = "nodejs";

/**
 * POST BulkCodingRequest → { updated } (audited as one coding.change).
 * `dryRun: true` returns the BulkPreview (ids after family expansion, per-field change counts, overwrites)
 * that the confirmation dialog shows before anything is written.
 */
async function POST__handler(req: NextRequest) {
  const body = await readJson<BulkCodingRequest>(req);
  if (!body?.ids?.length) return jsonError("`ids` is required");
  if (body.ids.length > 2000) return jsonError("Too many ids (max 2000)");
  try {
    const request = { ...body, patch: body.patch ?? {} };
    if (body.dryRun) return Response.json({ preview: bulkPreview(request) });
    return Response.json(bulkCode(request));
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withDb(edAuth(POST__handler, { records: "ediscovery_documents" }));
