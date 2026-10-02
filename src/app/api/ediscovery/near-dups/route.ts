import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/integrity/audit";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { refreshNearDuplicates } from "@/modules/ediscovery/review-service";

export const runtime = "nodejs";

/** POST { matterId, threshold? } → { pairs, updated, groups } — MinHash near-duplicate detection over the matter. */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; threshold?: number }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  try {
    const res = refreshNearDuplicates(m.matterId, { threshold: body?.threshold });
    audit("scan.run", { kind: "matter", id: m.matterId, label: "near-duplicate detection", matterId: m.matterId }, res);
    return Response.json(res);
  } catch (e) { return errorResponse(e); }
}

export const POST = withDb(edAuth(POST__handler));
