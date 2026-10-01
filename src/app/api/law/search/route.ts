import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { isLawActId, parseLawFilters } from "@/modules/law/shared";
import { searchProvisions } from "@/modules/india/law/search";
import { lawErrorResponse } from "@/modules/india/law/http";

export const runtime = "nodejs";

/**
 * GET /api/law/search?q=<words>&j=&state=&reg=&status=&kind=&from=&to=&act=<actId>&offset=&limit=
 * → LawSearchResponse: section-level hits (one per act, section and variant) with a highlighted snippet. `q` is required.
 */
async function handleGET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const f = parseLawFilters(sp);
  if (!f.q) return jsonError("A search query (q) is required", 400, { code: "query_required" });
  const act = sp.get("act");
  if (act && !isLawActId(act)) return jsonError("Not an instrument id", 400, { code: "bad_id" });
  const limitRaw = Number(sp.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 50) : 20;
  const offsetRaw = Number(sp.get("offset"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.trunc(offsetRaw) : 0;
  try {
    return Response.json(await searchProvisions({ q: f.q, jurisdiction: f.jurisdiction || null, state: f.state, regulator: f.regulator, kind: f.kind || null, status: f.status, yearFrom: f.yearFrom, yearTo: f.yearTo, actId: act, limit, offset }));
  } catch (e) {
    return lawErrorResponse(e, "law.search_failed", "The statutes corpus could not be searched. Try again in a moment.");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
