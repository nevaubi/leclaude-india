import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { runReview } from "@/modules/documents/server/review-run";
import { aiAvailable, aiUnavailableResponse, DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string; rid: string }> };

/** POST { max? } → ReviewProgress. Works for at most ~200 s; call again until `remaining` is 0. */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id, rid } = await params;
  const body = (await readJsonBody<{ max?: unknown }>(req)) ?? {};
  if (!aiAvailable()) return aiUnavailableResponse();
  try {
    return Response.json(await runReview(principal(), id, rid, { max: body.max, signal: req.signal }));
  } catch (e) { return docsErrorResponse(e); }
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => DOCS_SURFACE }));
