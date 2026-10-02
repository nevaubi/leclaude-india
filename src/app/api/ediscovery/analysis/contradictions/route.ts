import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { findContradictions } from "@/modules/ediscovery/analysis/ai";

export const runtime = "nodejs";

/** POST { matterId, depositionId, topic, indexes?, verify? } → 201 { created: Conflict[] (each with provenance), considered, skipped: [{title, duplicateOf}], dropped: string[] } (503 no_api_key without a key) */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; depositionId?: string; topic?: string; indexes?: number[]; verify?: boolean }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  if (!body?.depositionId) return jsonError("`depositionId` is required");
  try {
    const res = await findContradictions(m.matterId, { depositionId: body.depositionId, topic: body.topic?.trim() || "all topics", indexes: body.indexes, verify: body.verify, signal: req.signal });
    return Response.json(res, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

export const POST = withDb(edAuth(POST__handler));
