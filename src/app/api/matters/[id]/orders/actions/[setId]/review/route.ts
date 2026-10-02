import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { jsonError } from "@/lib/ai/sse";
import { DeskUnavailableError, reviewActionSet } from "@/modules/matters/desk/server";
import { readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; setId: string }> };

/**
 * POST { decisions: [{ itemId, create, dueAt }] } — the reviewer confirms which items become tasks and with which due
 * dates (deadlines are a high-risk field: a human approves each one). The order is read again first: 409 when it
 * changed since extraction, is gone or not indexed, or another review is running; 503 when it cannot be read. No task
 * is created unless the order is confirmed unchanged.
 */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id, setId } = await params;
  try {
    const body = await readJsonObject(req);
    return Response.json(await reviewActionSet(id, setId, body));
  } catch (e) {
    if (e instanceof DeskUnavailableError) return jsonError(e.message, e.status, { code: e.code });
    return serviceErrorResponse(e);
  }
}

export const POST = withDb(withAuth(handlePOST, { action: "approve", resource: (_req, { id }) => refs.matter(id) }));
