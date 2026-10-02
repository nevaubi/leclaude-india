import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { db } from "@/lib/db";
import { getDeposition } from "@/modules/ediscovery/analysis/service";
import { findCrossReferences, groupCrossReferences } from "@/modules/ediscovery/analysis/cross-references";

export const runtime = "nodejs";

/** GET → { references: CrossReference[], groups } — documents referenced in the testimony by Bates, exhibit, subject or date. */
async function GET__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dep = getDeposition(id);
  if (!dep) return jsonError(`No deposition ${id}`, 404);
  const min = Number(req.nextUrl.searchParams.get("min") ?? 0) || 0;
  const docs = db().edocs.find((x) => x.matterId === dep.matterId).map((x) => ({ id: x.id, bates: x.bates, batesEnd: x.batesEnd, subject: x.subject, date: x.date, type: x.type, exhibit: (x as { india?: { exhibit?: string } }).india?.exhibit }));
  const references = findCrossReferences(dep, docs).filter((r) => r.confidence >= min);
  return Response.json({ references, groups: groupCrossReferences(references), total: references.length });
}

export const GET = withDb(edAuth(GET__handler, { lookup: "deposition" }));
