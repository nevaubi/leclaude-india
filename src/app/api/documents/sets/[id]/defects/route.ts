import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { createDefectNotice, deleteDefectNotice, listDefectNotices, updateDefect } from "@/modules/documents/server/drafting";
import { aiAvailable, DOCS_SURFACE, docsErrorResponse, principal, query, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** GET → { notices: DefectNotice[], ai } */
async function handleGET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try { return Response.json({ notices: await listDefectNotices(principal(), id), ai: aiAvailable() }); } catch (e) { return docsErrorResponse(e); }
}

/** POST { title?, forum: sc|hc|nclt|other, text? | fileId? } → { notice } (split in code; AI classification when configured, keyword rules otherwise; nothing is filed) */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (!body) return Response.json({ error: "Send a JSON body" }, { status: 400 });
  try { return Response.json({ notice: await createDefectNotice(principal(), id, { ...body, useAi: aiAvailable() && body.useAi !== false }, req.signal) }); } catch (e) { return docsErrorResponse(e); }
}

/** PATCH { noticeId, version, defectId, done?, category?, task?, fix? } → { notice } */
async function handlePATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (!body || typeof body.noticeId !== "string") return Response.json({ error: "noticeId is required" }, { status: 422 });
  try { return Response.json({ notice: await updateDefect(principal(), id, body.noticeId, body) }); } catch (e) { return docsErrorResponse(e); }
}

/** DELETE ?notice → { ok } */
async function handleDELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try { await deleteDefectNotice(principal(), id, query(req).get("notice") ?? ""); return Response.json({ ok: true }); } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: () => DOCS_SURFACE }));
export const PATCH = withDb(withAuth(handlePATCH, { action: "write", resource: () => DOCS_SURFACE }));
export const DELETE = withDb(withAuth(handleDELETE, { action: "write", resource: () => DOCS_SURFACE }));
