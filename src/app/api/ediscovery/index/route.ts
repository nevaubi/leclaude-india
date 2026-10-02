import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { aiConfig } from "@/lib/ai/config";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { rebuildIndex } from "@/modules/ediscovery/service";

export const runtime = "nodejs";

/** Rebuild the keyword/vector index for a matter. Embeds only when a key is configured (and `embed` is not false). */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; embed?: boolean }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  try {
    const res = await rebuildIndex(m.matterId, { embed: body?.embed ?? true });
    return Response.json({ ...res, embeddingsAvailable: aiConfig().hasKey });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withDb(edAuth(POST__handler));
