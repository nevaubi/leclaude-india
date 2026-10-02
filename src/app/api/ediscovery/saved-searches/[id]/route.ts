import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import type { SavedSearchRecord } from "@/lib/types/domain";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { deleteSavedSearch, runSavedSearch, updateSavedSearch } from "@/modules/ediscovery/review-service";

export const runtime = "nodejs";

/** PATCH { name?, q?, shared?, … } → { search } */
async function PATCH__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<Partial<SavedSearchRecord>>(req);
  if (!body) return jsonError("Invalid JSON body");
  try {
    const search = updateSavedSearch(id, body);
    if (!search) return jsonError(`No saved search ${id}`, 404);
    return Response.json({ search });
  } catch (e) { return errorResponse(e); }
}

/** POST → runs the search and records its count: { search, total } */
async function POST__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { return Response.json(await runSavedSearch(id)); } catch (e) { return errorResponse(e); }
}

async function DELETE__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return deleteSavedSearch(id) ? Response.json({ ok: true }) : jsonError(`No saved search ${id}`, 404);
}

export const PATCH = withDb(edAuth(PATCH__handler, { lookup: "savedSearch" }));

export const POST = withDb(edAuth(POST__handler, { lookup: "savedSearch" }));

export const DELETE = withDb(edAuth(DELETE__handler, { lookup: "savedSearch" }));
