import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { matterFrom } from "@/modules/ediscovery/api-utils";
import { personDetail } from "@/modules/ediscovery/analysis/service";

export const runtime = "nodejs";

/** GET ?matter= → PersonDetail */
async function GET__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  const detail = personDetail(m.matterId, id);
  if (!detail) return jsonError(`No person ${id}`, 404);
  return Response.json(detail);
}

export const GET = withDb(edAuth(GET__handler));
