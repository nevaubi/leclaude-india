import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import type { CodingInput } from "@/modules/documents/review-types";
import { codeRow } from "@/modules/documents/server/review";
import { DOCS_SURFACE, docsErrorResponse, principal, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; rid: string; fileId: string }> };

/** PATCH CodingInput → { row }. 409 { code: "row_changed" } when rowHash is not the row's current hash. */
async function handlePATCH(req: NextRequest, { params }: Params) {
  const { id, rid, fileId } = await params;
  const body = await readJsonBody<CodingInput>(req);
  if (!body || typeof body !== "object") return Response.json({ error: "Send a JSON body" }, { status: 400 });
  try {
    return Response.json({ row: await codeRow(principal(), id, rid, fileId, body) });
  } catch (e) { return docsErrorResponse(e); }
}

export const PATCH = withDb(withAuth(handlePATCH, { action: "write", resource: () => DOCS_SURFACE }));
