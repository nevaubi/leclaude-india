import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { runExtraction } from "@/modules/documents/server/extract";
import { aiAvailable, aiUnavailableResponse, DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/** POST { max? } → ExtractProgress. Works for at most ~200 s; call again until `remaining` is 0. */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = (await readJsonBody<{ max?: unknown }>(req)) ?? {};
  if (!aiAvailable()) return aiUnavailableResponse();
  try {
    return Response.json(await runExtraction(principal(), id, { max: body.max, signal: req.signal }));
  } catch (e) { return docsErrorResponse(e); }
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => DOCS_SURFACE }));
