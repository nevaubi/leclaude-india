import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { jsonError, sseResponse } from "@/lib/ai/sse";
import { AIConfigError, aiConfig } from "@/lib/ai/config";
import { generateHearingBrief, listBriefs } from "@/modules/matters/desk/brief";
import { requireMatter } from "@/modules/matters/desk/server";
import type { BriefStreamEvent } from "@/modules/matters/desk/types";
import { isServiceError, readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/** GET — stored hearing briefs for this matter, newest version first (at most 10). */
async function handleGET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    requireMatter(id);
    return Response.json({ briefs: listBriefs(id).slice(0, 10) });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

/**
 * POST { listingId? } — prepare a hearing brief, streamed over SSE: stage / tool events, then { type: "brief" }.
 * A listingId that is not this matter's listing is an error event (never replaced by another listing).
 */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let listingId: string | null = null;
  try {
    requireMatter(id);
    const body = await readJsonObject(req);
    if (body.listingId !== undefined && body.listingId !== null) {
      if (typeof body.listingId !== "string" || !body.listingId.trim() || body.listingId.length > 200) return jsonError("listingId must be a listing id.", 400, { code: "invalid" });
      listingId = body.listingId.trim();
    }
  } catch (e) {
    return serviceErrorResponse(e);
  }
  if (!aiConfig().hasKey) return jsonError(new AIConfigError().message, 503, { code: "no_api_key" });
  return sseResponse(async (send, signal) => {
    const emit = (e: BriefStreamEvent) => send(e);
    try {
      const brief = await generateHearingBrief(id, { listingId }, emit, signal);
      emit({ type: "brief", brief });
    } catch (e) {
      if (e instanceof AIConfigError) emit({ type: "error", message: e.message, code: "no_api_key" });
      else if (isServiceError(e)) emit({ type: "error", message: e.message, code: e.code });
      else throw e;
    }
  });
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: (_req, { id }) => refs.matter(id) }));
export const POST = withDb(withAuth(handlePOST, { action: "run", resource: (_req, { id }) => refs.matter(id) }));
