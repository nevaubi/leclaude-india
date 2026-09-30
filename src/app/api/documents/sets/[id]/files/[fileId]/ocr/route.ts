import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { ocrPage } from "@/modules/documents/server/ingest";
import { aiAvailable, aiUnavailableResponse, DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string; fileId: string }> };

/** POST { page, image: data URL (JPEG/PNG ≤ 3 MB) } → { file, page, chars }. The page text is stored as ocr-ai. */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id, fileId } = await params;
  if (!aiAvailable()) return aiUnavailableResponse();
  const body = await readJsonBody<{ page?: unknown; image?: unknown }>(req);
  if (!body) return Response.json({ error: "Send a JSON body" }, { status: 400 });
  try {
    return Response.json(await ocrPage(principal(), id, fileId, body));
  } catch (e) { return docsErrorResponse(e); }
}

export const POST = withDb(withAuth(handlePOST, { action: "write", resource: () => DOCS_SURFACE }));
