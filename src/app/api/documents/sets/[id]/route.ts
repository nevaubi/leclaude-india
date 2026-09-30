import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { deleteSet, getSet, updateSet } from "@/modules/documents/server/sets";
import { DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET → { set } */
async function handleGET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    return Response.json({ set: await getSet(principal(), id) });
  } catch (e) { return docsErrorResponse(e); }
}

/** PATCH { name?, description? } → { set } */
async function handlePATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await readJsonBody<{ name?: unknown; description?: unknown }>(req);
  if (!body) return Response.json({ error: "Send a JSON body" }, { status: 400 });
  try {
    return Response.json({ set: await updateSet(principal(), id, body) });
  } catch (e) { return docsErrorResponse(e); }
}

/** DELETE → { ok } (the set, its files, text and extractions) */
async function handleDELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    await deleteSet(principal(), id);
    return Response.json({ ok: true });
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const PATCH = withDb(withAuth(handlePATCH, { action: "write", resource: () => DOCS_SURFACE }));
export const DELETE = withDb(withAuth(handleDELETE, { action: "write", resource: () => DOCS_SURFACE }));
