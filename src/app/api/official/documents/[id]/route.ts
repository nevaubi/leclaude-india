import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { readOfficialDocument } from "@/modules/official/read";
import { intParam, officialErrorResponse } from "../../errors";

export const runtime = "nodejs";

/**
 * GET /api/official/documents/[id]?fromChunk&page&maxChars → OfficialReadResult (document, a bounded run of chunks,
 * hasMore / nextChunk, attribution). `id` is an "od_…" id or an encoded src:// reference. 404 when unknown.
 */
async function handleGET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sp = new URL(req.url).searchParams;
    let ref = id;
    try { ref = decodeURIComponent(id); } catch { /* already decoded */ }
    const r = await readOfficialDocument(ref, { fromChunk: intParam(sp, "fromChunk"), page: intParam(sp, "page"), maxChars: intParam(sp, "maxChars", 120_000) });
    if (!r) return jsonError("No such official document.", 404, { code: "not_found" });
    return Response.json(r);
  } catch (e) {
    return officialErrorResponse(e, "official.read_failed");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
