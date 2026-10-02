import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError, sseResponse } from "@/lib/ai/sse";
import { isAIConfigError, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { predictResponsiveness } from "@/modules/ediscovery/ai";

export const runtime = "nodejs";

/** SSE: {type:"start"|"progress"|"doc"|"done"|"error"} — see PredictProgressEvent. */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; ids?: string[]; force?: boolean; batchSize?: number }>(req);
  if (!body) return jsonError("Invalid JSON body");
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  return sseResponse(async (send, signal) => {
    const onAbort = () => { /* propagated via signal */ };
    req.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await predictResponsiveness({ matterId: m.matterId, ids: body.ids, force: body.force, batchSize: body.batchSize, signal, onEvent: send });
    } catch (e) {
      if (isAIConfigError(e)) send({ type: "error", code: "no_api_key", message: (e as Error).message });
      else throw e;
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
  });
}

export const POST = withDb(edAuth(POST__handler, { records: "ediscovery_documents" }));
