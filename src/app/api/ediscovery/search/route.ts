import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { searchDocuments } from "@/modules/ediscovery/service";
import type { SearchRequest } from "@/modules/ediscovery/types";

export const runtime = "nodejs";

async function POST__handler(req: NextRequest) {
  const body = await readJson<SearchRequest>(req);
  if (!body) return jsonError("Invalid JSON body");
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  try {
    const res = await searchDocuments({ ...body, matterId: m.matterId });
    return Response.json(res);
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET variant for quick curl checks: ?matter=&q=&view=&semantic=1&sort=&dir=&offset=&limit= */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  const sp = req.nextUrl.searchParams;
  try {
    const res = await searchDocuments({
      matterId: m.matterId,
      q: sp.get("q") ?? undefined,
      view: (sp.get("view") as SearchRequest["view"]) ?? undefined,
      semantic: sp.get("semantic") === "1",
      sort: (sp.get("sort") as SearchRequest["sort"]) ?? undefined,
      dir: (sp.get("dir") as SearchRequest["dir"]) ?? undefined,
      offset: Number(sp.get("offset") ?? 0),
      limit: Number(sp.get("limit") ?? 50),
    });
    return Response.json(res);
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withDb(edAuth(POST__handler));

export const GET = withDb(edAuth(GET__handler));
