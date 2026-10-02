import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { db } from "@/lib/db";
import { batchesForDoc, docHistory, listRedactions } from "@/modules/ediscovery/review-service";

export const runtime = "nodejs";

/** GET → { history: DocHistoryEntry[], batches, redactions } — the document's audit trail (coding, AI, redactions, exports). */
async function GET__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!db().edocs.has(id)) return jsonError(`No document ${id}`, 404);
  const limit = Math.min(500, Number(req.nextUrl.searchParams.get("limit") ?? 100));
  return Response.json({ history: docHistory(id, limit), batches: batchesForDoc(id), redactions: listRedactions({ docId: id }) });
}

export const GET = withDb(edAuth(GET__handler, { lookup: "edoc" }));
