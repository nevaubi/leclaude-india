import { withDb } from "@/lib/db/request";
import { jsonError, sseResponse } from "@/lib/ai/sse";
import { parseRunRequest } from "@/modules/search/service";
import { runResearch } from "@/modules/search/engine/run";
import { withAuth } from "@/lib/auth/route";
import { bodyMatterId, refs } from "@/lib/auth/resources";

export const runtime = "nodejs";
/** The run stops itself at its wall (researchWallMs, 280s) and persists; the function allows 300s (the platform max). */
export const maxDuration = 300;

/**
 * POST /api/search/run — one research turn streamed over SSE.
 * Body: useAgent-compatible ({message, threadId?, runId?, ...SearchSettings}).
 * Events: plan / lane.* / synthesis.start / text.delta / answer.text / verify.* /
 * correction / citecheck / round.done / followups / answer.final / run.done
 * (see src/modules/search/engine/types.ts). Aborts everything on disconnect.
 */
async function handlePOST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("Invalid JSON body"); }
  const parsed = parseRunRequest(body);
  if ("error" in parsed) return jsonError(parsed.error);
  const { query, settings, runId, threadId, savedSearchId } = parsed;
  return sseResponse(async (send, signal) => {
    await runResearch({ question: query, settings, runId, threadId, savedSearchId }, send, signal);
  });
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: async (req) => refs.research(undefined, await bodyMatterId(req)) }));
