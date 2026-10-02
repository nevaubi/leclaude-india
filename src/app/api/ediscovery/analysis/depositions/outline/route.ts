import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { prepareOutline } from "@/modules/ediscovery/analysis/ai";

export const runtime = "nodejs";

/** POST { matterId, witnessName, witnessId?, topics?, depositionId?, verify? } → { markdown, title, sources, provenance, unresolvedCites } (503 no_api_key without a key) */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; witnessName?: string; witnessId?: string; topics?: string[]; depositionId?: string; verify?: boolean }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  if (!body?.witnessName?.trim()) return jsonError("`witnessName` is required");
  try {
    const res = await prepareOutline(m.matterId, { witnessName: body.witnessName, witnessId: body.witnessId, topics: body.topics, depositionId: body.depositionId, verify: body.verify, signal: req.signal });
    return Response.json(res);
  } catch (e) { return errorResponse(e); }
}

export const POST = withDb(edAuth(POST__handler, { kind: "deposition" }));
