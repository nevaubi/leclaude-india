import { withDb } from "@/lib/db/request";
import { jsonError, sseResponse } from "@/lib/ai/sse";
import { askAboutSource, type AskSourceBody } from "@/modules/search/service";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";

export const runtime = "nodejs";
/** A streamed multi-step source Q&A agent (up to 6 tool steps): the platform maximum, as for /api/search/run. */
export const maxDuration = 300;

/** POST /api/search/ask — "Ask about this source" mini chat (useAgent-compatible body + {source, text}). */
async function handlePOST(req: Request) {
  let body: AskSourceBody;
  try { body = (await req.json()) as AskSourceBody; } catch { return jsonError("Invalid JSON body"); }
  if (!body?.message?.trim()) return jsonError("`message` is required");
  if (!body.source?.title || typeof body.text !== "string") return jsonError("`source` and `text` are required");
  return sseResponse(async (send, signal) => {
    await askAboutSource(body, send, signal);
  });
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => refs.research() }));
