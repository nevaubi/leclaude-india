import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { loadSet } from "@/modules/documents/server/access";
import { listTranslations, translatePages } from "@/modules/documents/server/drafting";
import { aiAvailable, aiUnavailableResponse, DOCS_SURFACE, docsErrorResponse, principal, query, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/** GET ?file&to → { file, to, records: (TranslationRecord & { stale })[] } (stale: the source page changed since) */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const q = query(req);
  try { return Response.json(await listTranslations(principal(), id, q.get("file") ?? "", q.get("to"))); } catch (e) { return docsErrorResponse(e); }
}

/** POST { fileId, from: "auto" | code, to: code, pageFrom?, pageTo?, force? } → view + { translated, skipped, remaining } */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (!body || typeof body.fileId !== "string") return Response.json({ error: "fileId is required" }, { status: 422 });
  const p = principal();
  try { await loadSet(p, id, "write"); } catch (e) { return docsErrorResponse(e); }
  if (!aiAvailable()) return aiUnavailableResponse();
  try { return Response.json(await translatePages(p, id, body, req.signal)); } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => DOCS_SURFACE }));
