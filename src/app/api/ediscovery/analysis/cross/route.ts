import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { errorResponse, matterFrom } from "@/modules/ediscovery/api-utils";
import { crossAnalysis } from "@/modules/ediscovery/analysis/service";

export const runtime = "nodejs";

/** GET ?matter=&topic=&witness=&deposition=&k= → CrossAnalysisResponse (deterministic; BM25 without a key) */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  const sp = req.nextUrl.searchParams;
  try {
    const res = await crossAnalysis(m.matterId, { topic: sp.get("topic") ?? "", witnessId: sp.get("witness") ?? undefined, depositionId: sp.get("deposition") ?? undefined, k: Number(sp.get("k") ?? 12) });
    return Response.json(res);
  } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler));
