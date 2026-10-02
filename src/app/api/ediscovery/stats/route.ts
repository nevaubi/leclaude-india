import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { aiConfig } from "@/lib/ai/config";
import { ensureReview, matterFrom } from "@/modules/ediscovery/api-utils";
import { matterStats } from "@/modules/ediscovery/service";

export const runtime = "nodejs";

async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  ensureReview();
  return Response.json({ ...matterStats(m.matterId), aiConfigured: aiConfig().hasKey });
}

export const GET = withDb(edAuth(GET__handler));
