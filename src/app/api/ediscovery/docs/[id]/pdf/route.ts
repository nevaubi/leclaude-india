import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { db } from "@/lib/db";
import { errorResponse } from "@/modules/ediscovery/api-utils";
import { renderProductionPdfWithMap } from "@/modules/ediscovery/production-export";
import { listRedactions } from "@/modules/ediscovery/review-service";

export const runtime = "nodejs";

/**
 * GET → the document rendered as its image surrogate (one PDF sheet per logical page, more when a
 * page overflows; Bates footer on every sheet). The viewer's Image tab opens this with pdf.js and
 * draws page redactions over it; the `X-Page-Map` header lists the logical page of every sheet.
 * `?applied=1` burns the current redactions in (what a production would carry); by default the
 * sheets are clean so the overlay can show and remove the stored redactions.
 */
async function GET__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = db().edocs.get(id);
  if (!doc) return jsonError(`No document ${id}`, 404);
  const applied = req.nextUrl.searchParams.get("applied") === "1";
  try {
    const { bytes, pageMap } = await renderProductionPdfWithMap(doc, { begin: doc.bates, pages: doc.pages ?? 1 }, applied ? listRedactions({ docId: id }) : [], applied && doc.coding.confidentiality ? `${doc.coding.confidentiality.toUpperCase()} — SUBJECT TO PROTECTIVE ORDER` : "");
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${doc.bates}${applied ? "-redacted" : ""}.pdf"`, "Cache-Control": "no-store", "X-Page-Map": pageMap.join(",") } });
  } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler, { lookup: "edoc" }));
