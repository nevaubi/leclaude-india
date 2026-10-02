import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { createConflict, listConflicts } from "@/modules/ediscovery/analysis/service";
import type { Conflict } from "@/lib/types/domain";

export const runtime = "nodejs";

/** GET ?matter=&status=&kind=&severity=&witness=&q= → { conflicts: ConflictRow[] } */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  const sp = req.nextUrl.searchParams;
  const conflicts = listConflicts(m.matterId, { status: (sp.get("status") as Conflict["status"]) ?? undefined, kind: (sp.get("kind") as Conflict["kind"]) ?? undefined, severity: (sp.get("severity") as Conflict["severity"]) ?? undefined, witnessId: sp.get("witness") ?? undefined, q: sp.get("q") ?? undefined });
  return Response.json({ conflicts });
}

/** POST { matterId, title, kind, severity, sides[2+], analysis } → 201 { conflict } */
async function POST__handler(req: NextRequest) {
  const body = await readJson<Partial<Conflict> & { matterId?: string }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  try {
    const c = createConflict(m.matterId, { title: body?.title ?? "", kind: body?.kind ?? "testimony_vs_document", severity: body?.severity ?? "medium", sides: body?.sides ?? [], analysis: body?.analysis ?? "", status: body?.status });
    return Response.json({ conflict: c }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler, { kind: "conflict" }));

export const POST = withDb(edAuth(POST__handler, { kind: "conflict" }));
