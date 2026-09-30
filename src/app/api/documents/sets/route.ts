import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { createSet, listSets } from "@/modules/documents/server/sets";
import { DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";

/** GET → { sets: DocSet[] } (sets the caller may read, newest first) */
async function handleGET() {
  try {
    return Response.json({ sets: await listSets(principal()) });
  } catch (e) { return docsErrorResponse(e); }
}

/** POST { name, description?, matterId? } → { set }. A matter set requires write on the matter. */
async function handlePOST(req: NextRequest) {
  const body = await readJsonBody<{ name?: unknown; description?: unknown; matterId?: unknown }>(req);
  if (!body) return Response.json({ error: "Send a JSON body" }, { status: 400 });
  try {
    return Response.json({ set: await createSet(principal(), body) }, { status: 201 });
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: () => DOCS_SURFACE }));
