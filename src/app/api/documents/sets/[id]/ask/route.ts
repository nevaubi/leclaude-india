import type { NextRequest } from "next/server";
import { sseResponse } from "@/lib/ai/sse";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { loadSet } from "@/modules/documents/server/access";
import { askDocSet } from "@/modules/documents/server/ask";
import { aiAvailable, aiUnavailableResponse, DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/**
 * POST { question, fileIds? } → SSE: status {message}, passages {count, mode}, delta {text}, done {answer: DocAnswer},
 * error {message}. The set is authorized before the stream opens (404 / 503 come back as JSON).
 */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await readJsonBody<{ question?: unknown; fileIds?: unknown }>(req);
  if (!body || typeof body.question !== "string" || !body.question.trim()) return Response.json({ error: "question is required" }, { status: 422 });
  const p = principal();
  try {
    await loadSet(p, id, "read");
  } catch (e) { return docsErrorResponse(e); }
  if (!aiAvailable()) return aiUnavailableResponse();
  return sseResponse(async (send, signal) => {
    const answer = await askDocSet(p, id, body, (e) => send(e), signal);
    send({ type: "done", answer });
  });
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => DOCS_SURFACE }));
