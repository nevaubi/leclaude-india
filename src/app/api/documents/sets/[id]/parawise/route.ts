import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { loadSet } from "@/modules/documents/server/access";
import { getParawise, proposeReplies, startParawise, updateReply } from "@/modules/documents/server/drafting";
import { aiAvailable, aiUnavailableResponse, DOCS_SURFACE, docsErrorResponse, principal, query, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/** GET ?file → { state: ParawiseState | null, stale, paragraphs, textHash, file } */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try { return Response.json(await getParawise(principal(), id, query(req).get("file") ?? "")); } catch (e) { return docsErrorResponse(e); }
}

/**
 * POST { fileId, action: "start" | "restart" } → detect numbered paragraphs (no AI).
 * POST { fileId, action: "propose", ns?, version } → AI-proposed replies for pending (or named) paragraphs, bounded per
 * call: { …view, remaining, failed }. Quotes are checked in code; admissions still need approval.
 */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await readJsonBody<{ fileId?: unknown; action?: unknown; ns?: unknown; version?: unknown }>(req);
  if (!body || typeof body.fileId !== "string") return Response.json({ error: "fileId is required" }, { status: 422 });
  const p = principal();
  try {
    if (body.action === "start" || body.action === "restart") return Response.json(await startParawise(p, id, body.fileId, { restart: body.action === "restart" }));
    if (body.action !== "propose") return Response.json({ error: "action must be start, restart or propose" }, { status: 422 });
    await loadSet(p, id, "write");
  } catch (e) { return docsErrorResponse(e); }
  if (!aiAvailable()) return aiUnavailableResponse();
  try { return Response.json(await proposeReplies(p, id, body.fileId, { ns: body.ns, version: body.version, signal: req.signal })); } catch (e) { return docsErrorResponse(e); }
}

/** PATCH { fileId, version, n, stance?, reply?, approve? } → view (editing clears an approval; 409 on a stale version) */
async function handlePATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (!body || typeof body.fileId !== "string") return Response.json({ error: "fileId is required" }, { status: 422 });
  try { return Response.json(await updateReply(principal(), id, body.fileId, body)); } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => DOCS_SURFACE }));
export const PATCH = withDb(withAuth(handlePATCH, { action: "write", resource: () => DOCS_SURFACE }));
