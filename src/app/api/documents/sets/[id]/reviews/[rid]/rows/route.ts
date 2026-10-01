import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { listRows, parseRowQuery } from "@/modules/documents/server/review";
import { DOCS_SURFACE, docsErrorResponse, principal, query } from "@/modules/documents/server/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; rid: string }> };

/** GET ?q&issue&minRelevance&docType&privilege&coding&status&sort&offset&limit → { rows, total, facets } */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id, rid } = await params;
  try {
    return Response.json(await listRows(principal(), id, rid, parseRowQuery(Object.fromEntries(query(req).entries()))));
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
