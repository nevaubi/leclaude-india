import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { deleteReview, getReview, updateReview, type ReviewPatch } from "@/modules/documents/server/review";
import { DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; rid: string }> };

/** GET → { review } */
async function handleGET(_req: NextRequest, { params }: Params) {
  const { id, rid } = await params;
  try {
    return Response.json({ review: await getReview(principal(), id, rid) });
  } catch (e) { return docsErrorResponse(e); }
}

/** PATCH { name?, columns?, issues?, questions?, docTypes? } → { review } (columns/issues/docTypes changes bump the version) */
async function handlePATCH(req: NextRequest, { params }: Params) {
  const { id, rid } = await params;
  const body = await readJsonBody<ReviewPatch>(req);
  if (!body || typeof body !== "object") return Response.json({ error: "Send a JSON body" }, { status: 400 });
  try {
    return Response.json({ review: await updateReview(principal(), id, rid, body) });
  } catch (e) { return docsErrorResponse(e); }
}

/** DELETE → { ok } (the review, its rows, decisions and report) */
async function handleDELETE(_req: NextRequest, { params }: Params) {
  const { id, rid } = await params;
  try {
    await deleteReview(principal(), id, rid);
    return Response.json({ ok: true });
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const PATCH = withDb(withAuth(handlePATCH, { action: "write", resource: () => DOCS_SURFACE }));
export const DELETE = withDb(withAuth(handleDELETE, { action: "write", resource: () => DOCS_SURFACE }));
