import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { deleteFile, getFilePages } from "@/modules/documents/server/sets";
import { appendPages } from "@/modules/documents/server/ingest";
import { DOCS_SURFACE, docsErrorResponse, principal, query, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string; fileId: string }> };

/** GET ?page → { file, pages: { page, text }[] } (page null for formats without pages) */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id, fileId } = await params;
  const page = query(req).get("page");
  try {
    return Response.json(await getFilePages(principal(), id, fileId, page ? Number(page) : undefined));
  } catch (e) { return docsErrorResponse(e); }
}

/** PATCH { appendPages: string[], fromPage } → { file } (next batch of a large browser-read PDF) */
async function handlePATCH(req: NextRequest, { params }: Params) {
  const { id, fileId } = await params;
  const body = await readJsonBody<{ appendPages?: unknown; fromPage?: unknown }>(req);
  if (!body) return Response.json({ error: "Send a JSON body" }, { status: 400 });
  try {
    return Response.json(await appendPages(principal(), id, fileId, body));
  } catch (e) { return docsErrorResponse(e); }
}

/** DELETE → { ok } */
async function handleDELETE(_req: NextRequest, { params }: Params) {
  const { id, fileId } = await params;
  try {
    await deleteFile(principal(), id, fileId);
    return Response.json({ ok: true });
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const PATCH = withDb(withAuth(handlePATCH, { action: "write", resource: () => DOCS_SURFACE }));
export const DELETE = withDb(withAuth(handleDELETE, { action: "write", resource: () => DOCS_SURFACE }));
