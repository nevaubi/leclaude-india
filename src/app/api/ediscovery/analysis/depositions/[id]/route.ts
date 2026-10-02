import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { getDeposition, listDesignations, objectionRulings, objectionSummary, resolveExhibit, setObjectionRuling, toggleFlag, updateQA } from "@/modules/ediscovery/analysis/service";
import { getProvenance } from "@/lib/integrity/store";
import type { ObjectionRuling, QAFlag } from "@/modules/ediscovery/analysis/types";

export const runtime = "nodejs";

const RULINGS: ObjectionRuling[] = ["pending", "sustained", "overruled"];

/** GET → { deposition, designations, objections, rulings: {[index]: ruling}, exhibits: [{id, description, bates, docId}], digestProvenance: Provenance | null } */
async function GET__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dep = getDeposition(id);
  if (!dep) return jsonError(`No deposition ${id}`, 404);
  const exhibits = (dep.exhibits ?? []).map((e) => ({ ...e, docId: resolveExhibit(dep, e.id).docId }));
  return Response.json({ deposition: dep, designations: listDesignations(id), objections: objectionSummary(id), rulings: objectionRulings(id), exhibits, digestProvenance: dep.aiDigest ? getProvenance("deposition.digest", dep.id) : null });
}

/**
 * PATCH { index, flags? | toggle?: QAFlag, note? } → { qa, index }
 * PATCH { index, ruling: "pending" | "sustained" | "overruled", rulingNote? } → { index, ruling, objections, rulings }
 */
async function PATCH__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<{ index?: number; flags?: QAFlag[]; toggle?: QAFlag; note?: string | null; ruling?: ObjectionRuling; rulingNote?: string }>(req);
  if (!body || typeof body.index !== "number") return jsonError("`index` is required");
  try {
    if (body.ruling !== undefined) {
      if (!RULINGS.includes(body.ruling)) return jsonError("`ruling` must be pending, sustained or overruled");
      const rec = setObjectionRuling(id, body.index, body.ruling, { note: body.rulingNote });
      if (!rec) return jsonError(`No deposition ${id}`, 404);
      return Response.json({ index: body.index, ruling: rec.ruling, objections: objectionSummary(id), rulings: objectionRulings(id) });
    }
    const dep = body.toggle ? toggleFlag(id, body.index, body.toggle) : updateQA(id, body.index, { flags: body.flags, note: body.note });
    if (!dep) return jsonError(`No deposition ${id}`, 404);
    return Response.json({ qa: dep.transcript[body.index], index: body.index });
  } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler, { lookup: "deposition" }));

export const PATCH = withDb(edAuth(PATCH__handler, { lookup: "deposition" }));
