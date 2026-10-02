import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { loadSet } from "@/modules/documents/server/access";
import { draftSynopsis, getDates, saveDates } from "@/modules/documents/server/drafting";
import { aiAvailable, aiUnavailableResponse, DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** GET → { state: DatesState, rows: DateRow[], extracted, total } (timeline events merged with the user's edits) */
async function handleGET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try { return Response.json(await getDates(principal(), id)); } catch (e) { return docsErrorResponse(e); }
}

/** PATCH { version, format?, overrides?: {eventId: DateOverride}, manual?: ManualDateRow[], synopsisText?, clearSynopsis? } → DatesView (409 on a stale version) */
async function handlePATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (!body) return Response.json({ error: "Send a JSON body" }, { status: 400 });
  try { return Response.json(await saveDates(principal(), id, body)); } catch (e) { return docsErrorResponse(e); }
}

/** POST { rowIds?, version? } → DatesView with a synopsis drafted only from the selected rows (checked in code) */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = (await readJsonBody<{ rowIds?: unknown; version?: unknown }>(req)) ?? {};
  const p = principal();
  try { await loadSet(p, id, "write"); } catch (e) { return docsErrorResponse(e); }
  if (!aiAvailable()) return aiUnavailableResponse();
  try { return Response.json(await draftSynopsis(p, id, body, req.signal)); } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const PATCH = withDb(withAuth(handlePATCH, { action: "write", resource: () => DOCS_SURFACE }));
export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => DOCS_SURFACE }));
