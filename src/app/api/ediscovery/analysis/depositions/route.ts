import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { matterFrom } from "@/modules/ediscovery/api-utils";
import { listDepositions } from "@/modules/ediscovery/analysis/service";

export const runtime = "nodejs";

/** GET ?matter= → { depositions: DepositionSummary[] } */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  return Response.json({ depositions: listDepositions(m.matterId) });
}

export const GET = withDb(edAuth(GET__handler, { kind: "deposition" }));
