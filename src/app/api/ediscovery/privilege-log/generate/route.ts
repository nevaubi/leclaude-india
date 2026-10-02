import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError, sseResponse } from "@/lib/ai/sse";
import { aiConfig } from "@/lib/ai/config";
import { isAIConfigError, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { generatePrivilegeLog } from "@/modules/ediscovery/ai";

export const runtime = "nodejs";

/**
 * SSE: {type:"start", total, ai} → {type:"progress", done, total} → {type:"done", created, removed, ai}.
 * Uses generateText for privilege-safe descriptions when a key is configured; otherwise a template.
 */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; regenerate?: boolean; useAI?: boolean }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  if (!body) return jsonError("Invalid JSON body");
  return sseResponse(async (send, signal) => {
    const ai = body.useAI !== false && aiConfig().hasKey;
    send({ type: "start", ai });
    try {
      const res = await generatePrivilegeLog(m.matterId, { regenerate: body.regenerate, useAI: body.useAI, signal, onProgress: (done, total) => send({ type: "progress", done, total }) });
      send({ type: "done", ...res });
    } catch (e) {
      if (isAIConfigError(e)) send({ type: "error", code: "no_api_key", message: (e as Error).message });
      else throw e;
    }
  });
}

export const POST = withDb(edAuth(POST__handler));
