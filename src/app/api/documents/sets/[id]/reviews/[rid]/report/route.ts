import type { NextRequest } from "next/server";
import { sseResponse } from "@/lib/ai/sse";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { getReport, prepareReport, runReport } from "@/modules/documents/server/review-report";
import { aiAvailable, aiUnavailableResponse, DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string; rid: string }> };

/** GET → { report: ReviewReport | null } (the latest stored report) */
async function handleGET(_req: NextRequest, { params }: Params) {
  const { id, rid } = await params;
  try {
    return Response.json({ report: await getReport(principal(), id, rid) });
  } catch (e) { return docsErrorResponse(e); }
}

/**
 * POST { questions? } → SSE of ReportEvent (report.started, question.started, question.completed | question.failed,
 * report.completed | report.failed; an unexpected server error arrives as { type: "error", message }). The set, review
 * and questions are checked before the stream opens (404 / 403 / 422 / 503 come back as JSON).
 */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id, rid } = await params;
  const body = (await readJsonBody<{ questions?: unknown }>(req)) ?? {};
  const p = principal();
  let questions: string[];
  try {
    questions = await prepareReport(p, id, rid, body);
  } catch (e) { return docsErrorResponse(e); }
  if (!aiAvailable()) return aiUnavailableResponse();
  return sseResponse(async (send, signal) => {
    await runReport(p, id, rid, questions, (e) => send(e), signal);
  });
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => DOCS_SURFACE }));
