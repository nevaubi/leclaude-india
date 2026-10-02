import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { searchOfficial } from "@/modules/official/search";
import type { SourceId, SourceKind } from "@/modules/official/types";
import { intParam, listParam, officialErrorResponse } from "../errors";

export const runtime = "nodejs";

/**
 * GET /api/official/search?q&source&kind&forum&from&to&limit&mode → OfficialSearchResult. Hybrid (keyword + embeddings)
 * retrieval over official documents; every hit carries a stable src:// reference and the publisher's URL.
 */
async function handleGET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const mode = sp.get("mode");
    const result = await searchOfficial({
      q: sp.get("q") ?? "",
      sources: listParam(sp, "source") as SourceId[] | undefined,
      kinds: listParam(sp, "kind") as SourceKind[] | undefined,
      forum: sp.get("forum") ?? undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      limit: intParam(sp, "limit", 50),
      mode: mode === "keyword" || mode === "semantic" || mode === "hybrid" ? mode : undefined,
    });
    return Response.json(result);
  } catch (e) {
    return officialErrorResponse(e, "official.search_failed");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
