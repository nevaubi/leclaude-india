import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { exportReview } from "@/modules/documents/server/review-export";
import { DOCS_SURFACE, docsErrorResponse, principal, query } from "@/modules/documents/server/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; rid: string }> };

/** GET ?format=csv|xlsx → file download (attachment). Matter sets need the matter's export permission. */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id, rid } = await params;
  const f = query(req).get("format") ?? "csv";
  if (f !== "csv" && f !== "xlsx") return Response.json({ error: "format must be csv or xlsx", code: "invalid" }, { status: 422 });
  try {
    const out = await exportReview(principal(), id, rid, f);
    const body = typeof out.body === "string" ? out.body : new Uint8Array(out.body);
    return new Response(body, { headers: { "Content-Type": out.contentType, "Content-Disposition": `attachment; filename="${out.filename}"`, "Cache-Control": "no-store" } });
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
