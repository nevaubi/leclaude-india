import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError, sseResponse } from "@/lib/ai/sse";
import { aiConfig } from "@/lib/ai/config";
import { isAIConfigError, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { eventsFromDocuments, mergeEvents } from "@/modules/ediscovery/analysis/service";
import { extractTimelineEvents } from "@/modules/ediscovery/analysis/ai";

export const runtime = "nodejs";

/**
 * POST { matterId, docIds, mode?: "ai" | "metadata", verify? } → SSE
 * {type:"start", total, ai} → {type:"progress", done, total} → {type:"done", added (each with provenance), merged, extracted, dropped, duplicates: [{title, date, duplicateOf}], needsReview} | {type:"error", code:"no_api_key"}.
 * "metadata" mode builds one event per document deterministically (no key needed). AI events are self-corrected against
 * the documents, near-duplicates are merged into the existing chronology, and low-confidence events are gated for review.
 */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; docIds?: string[]; mode?: "ai" | "metadata"; verify?: boolean }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  if (!body?.docIds?.length) return jsonError("`docIds` is required");
  const docIds = body.docIds;
  const mode = body.mode ?? "ai";
  return sseResponse(async (send, signal) => {
    const ai = mode === "ai" && aiConfig().hasKey;
    send({ type: "start", total: docIds.length, ai });
    try {
      if (mode === "metadata") {
        const events = eventsFromDocuments(m.matterId, docIds);
        const res = mergeEvents(m.matterId, events);
        send({ type: "progress", done: docIds.length, total: docIds.length });
        send({ type: "done", added: res.added, merged: res.merged, extracted: events.length, ai: false });
        return;
      }
      const res = await extractTimelineEvents(m.matterId, { docIds, verify: body.verify, signal, onProgress: (done, total) => send({ type: "progress", done, total }) });
      send({ type: "done", ...res, ai: true });
    } catch (e) {
      if (isAIConfigError(e)) send({ type: "error", code: "no_api_key", message: (e as Error).message });
      else throw e;
    }
  });
}

export const POST = withDb(edAuth(POST__handler, { kind: "timeline" }));
