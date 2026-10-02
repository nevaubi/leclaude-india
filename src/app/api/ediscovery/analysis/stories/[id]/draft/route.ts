import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { draftStoryNarrative } from "@/modules/ediscovery/analysis/ai";

export const runtime = "nodejs";

/** POST { audience?: "memo"|"brief"|"opening", verify? } → { text, provenance, unresolvedCites } (503 no_api_key without a key). */
async function POST__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<{ audience?: "memo" | "brief" | "opening"; verify?: boolean }>(req);
  try {
    return Response.json(await draftStoryNarrative(id, { audience: body?.audience, verify: body?.verify, signal: req.signal }));
  } catch (e) { return errorResponse(e); }
}

export const POST = withDb(edAuth(POST__handler, { lookup: "story" }));
