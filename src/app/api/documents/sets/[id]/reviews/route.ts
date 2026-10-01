import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import type { CreateReviewInput } from "@/modules/documents/review-types";
import { createReview, listReviews } from "@/modules/documents/server/review";
import { DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET → { reviews: DocReview[] } */
async function handleGET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    return Response.json({ reviews: await listReviews(principal(), id) });
  } catch (e) { return docsErrorResponse(e); }
}

/** POST CreateReviewInput → 201 { review } */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await readJsonBody<CreateReviewInput>(req);
  if (!body || typeof body !== "object") return Response.json({ error: "Send a JSON body" }, { status: 400 });
  try {
    return Response.json({ review: await createReview(principal(), id, body) }, { status: 201 });
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: () => DOCS_SURFACE }));
