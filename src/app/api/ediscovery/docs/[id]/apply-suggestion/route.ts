import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { applySuggestedCoding } from "@/modules/ediscovery/ai";

export const runtime = "nodejs";

/**
 * POST { reviewerId?, force? } → { applied, needsReview, reason, doc: { id, coding, aiProvenance } }
 * Trusted AI suggestions (source-backed, verified, above the confidence gate) become the coding; untrusted ones are
 * written into coding.notes with a NEEDS REVIEW marker instead. `force: true` applies regardless (the reviewer's call).
 */
async function POST__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<{ reviewerId?: string; force?: boolean }>(req);
  try {
    const res = applySuggestedCoding(id, { reviewerId: body?.reviewerId, force: !!body?.force });
    if (!res.doc) return Response.json({ error: res.reason }, { status: 404 });
    return Response.json({ applied: res.applied, needsReview: res.needsReview, reason: res.reason, doc: { id: res.doc.id, coding: res.doc.coding, aiProvenance: res.doc.aiProvenance ?? null } });
  } catch (e) { return errorResponse(e); }
}

export const POST = withDb(edAuth(POST__handler, { lookup: "edoc" }));
