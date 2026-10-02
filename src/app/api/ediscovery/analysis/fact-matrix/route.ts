import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { deleteFactMatrix, listFactMatrices } from "@/modules/ediscovery/analysis/service";
import { buildFactMatrix } from "@/modules/ediscovery/analysis/ai";

export const runtime = "nodejs";

/** GET ?matter= → { matrices } */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  return Response.json({ matrices: listFactMatrices(m.matterId) });
}

/** POST { matterId, topic, witnessId?, verify? } → 201 { matrix: FactMatrix & { provenance } } (503 no_api_key without a key) */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; topic?: string; witnessId?: string; verify?: boolean }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  if (!body?.topic?.trim()) return jsonError("`topic` is required");
  try {
    return Response.json({ matrix: await buildFactMatrix(m.matterId, { topic: body.topic.trim(), witnessId: body.witnessId, verify: body.verify, signal: req.signal }) }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

/** DELETE ?id= */
async function DELETE__handler(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return jsonError("`id` is required");
  return Response.json({ ok: deleteFactMatrix(id) });
}

export const GET = withDb(edAuth(GET__handler, { records: "ediscovery_fact_matrices" }));

export const POST = withDb(edAuth(POST__handler, { records: "ediscovery_fact_matrices" }));

export const DELETE = withDb(edAuth(DELETE__handler, { records: "ediscovery_fact_matrices" }));
