import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { matterIntelPanel, mergeIntelChronology } from "@/modules/ediscovery/analysis/intel-panel";

export const runtime = "nodejs";

/** GET ?matter= → MatterIntelPanel (judge profile, docket activity, regulatory chronology, MDL status; empty states when sources are off). */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  try { return Response.json(await matterIntelPanel(m.matterId), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return errorResponse(e); }
}

/** POST { matterId, minConfidence? } → ChronologyExportResult — merge the intelligence chronology into the matter timeline (deduped, gated, with provenance). */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; minConfidence?: number }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  try { return Response.json(await mergeIntelChronology(m.matterId, { minConfidence: typeof body?.minConfidence === "number" ? body.minConfidence : undefined })); }
  catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler));

export const POST = withDb(edAuth(POST__handler));
