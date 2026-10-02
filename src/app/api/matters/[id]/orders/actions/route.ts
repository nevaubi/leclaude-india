import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { jsonError } from "@/lib/ai/sse";
import { AIConfigError, aiConfig } from "@/lib/ai/config";
import { extractOrderActions, listActionSets, requireMatter } from "@/modules/matters/desk/server";
import { readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** GET ?documentId= — stored action-item sets for this matter (newest first), optionally for one order. */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    requireMatter(id);
    const documentId = new URL(req.url).searchParams.get("documentId") ?? undefined;
    return Response.json({ sets: listActionSets(id, documentId) });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

/**
 * POST { documentId } — read the order (bounded) and extract directions, the next date and compliance tasks with
 * verbatim quotes checked in code. Nothing becomes a task here: the set waits for a reviewer (…/actions/[setId]/review).
 */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const body = await readJsonObject(req);
    const documentId = typeof body.documentId === "string" ? body.documentId.trim() : "";
    if (!documentId || documentId.length > 200) return jsonError("documentId is required.", 400, { code: "invalid" });
    if (!aiConfig().hasKey) return jsonError(new AIConfigError().message, 503, { code: "no_api_key" });
    return Response.json({ set: await extractOrderActions(id, documentId, { signal: req.signal }) }, { status: 201 });
  } catch (e) {
    if (e instanceof AIConfigError) return jsonError(e.message, 503, { code: "no_api_key" });
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: (_req, { id }) => refs.matter(id) }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: (_req, { id }) => refs.matter(id) }));
