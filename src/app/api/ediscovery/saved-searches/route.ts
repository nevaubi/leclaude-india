import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { ensureReview, errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { createSavedSearch, listSavedSearches } from "@/modules/ediscovery/review-service";
import type { SavedSearchInput } from "@/modules/ediscovery/types";

export const runtime = "nodejs";

/** GET ?matter= → { searches: SavedSearchRecord[] } (own + shared) */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  ensureReview();
  return Response.json({ searches: listSavedSearches(m.matterId) });
}

/** POST SavedSearchInput → 201 { search } */
async function POST__handler(req: NextRequest) {
  const body = await readJson<SavedSearchInput>(req);
  if (!body) return jsonError("Invalid JSON body");
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  try {
    return Response.json({ search: createSavedSearch({ ...body, matterId: m.matterId }) }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler));

export const POST = withDb(edAuth(POST__handler));
