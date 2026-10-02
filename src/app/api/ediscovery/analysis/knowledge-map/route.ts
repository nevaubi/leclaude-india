import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { listKnowledgeMaps } from "@/modules/ediscovery/analysis/service";
import { knowledgeMap } from "@/modules/ediscovery/analysis/ai";

export const runtime = "nodejs";

/** GET ?matter= → { maps } */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  return Response.json({ maps: listKnowledgeMaps(m.matterId) });
}

/** POST { matterId, topic, verify? } → 201 { map: KnowledgeMap & { provenance, duplicateOf? } } (503 no_api_key without a key) */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; topic?: string; verify?: boolean }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  if (!body?.topic?.trim()) return jsonError("`topic` is required");
  try {
    return Response.json({ map: await knowledgeMap(m.matterId, { topic: body.topic.trim(), verify: body.verify, signal: req.signal }) }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler, { kind: "knowledge_graph" }));

export const POST = withDb(edAuth(POST__handler, { kind: "knowledge_graph" }));
