import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { listTimeline } from "@/modules/documents/server/extract";
import { DOCS_SURFACE, docsErrorResponse, principal, query } from "@/modules/documents/server/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET ?file&q → { events: DocEvent[], extracted, total } sorted by date (extracted/total are file counts) */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const q = query(req);
  try {
    return Response.json(await listTimeline(principal(), id, { file: q.get("file"), q: q.get("q") }));
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
