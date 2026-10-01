import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { LAW_PAGE_SIZE, parseLawFilters } from "@/modules/law/shared";
import { searchInstruments } from "@/modules/india/law/search";
import { lawErrorResponse } from "@/modules/india/law/http";

export const runtime = "nodejs";

/**
 * GET /api/law?q=&j=central|state|regulator&state=KA&reg=sebi&status=in_force|not_in_force|all&kind=act|regulation&from=&to=&sort=relevance|title|newest|oldest&cursor=&limit=
 * → LawListResponse (instruments). Parameters are parsed and clamped; unknown values are dropped.
 */
async function handleGET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const f = parseLawFilters(sp);
  const limitRaw = Number(sp.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), LAW_PAGE_SIZE) : LAW_PAGE_SIZE;
  const cursor = (sp.get("cursor") ?? "").slice(0, 40) || null;
  try {
    return Response.json(await searchInstruments({ q: f.q, jurisdiction: f.jurisdiction || null, state: f.state, regulator: f.regulator, kind: f.kind || null, status: f.status, yearFrom: f.yearFrom, yearTo: f.yearTo, sort: f.sort, cursor, limit }));
  } catch (e) {
    return lawErrorResponse(e, "law.list_failed", "The statutes corpus could not be queried. Try again in a moment.");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
