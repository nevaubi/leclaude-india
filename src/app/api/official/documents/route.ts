import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { listOfficialDocuments } from "@/modules/official/list";
import type { SourceId, SourceKind } from "@/modules/official/types";
import { intParam, listParam, officialErrorResponse } from "../errors";

export const runtime = "nodejs";

/** GET /api/official/documents?source&kind&forum&q&from&to&cursor&limit → { documents, nextCursor } (newest first). */
async function handleGET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    return Response.json(await listOfficialDocuments({
      sources: listParam(sp, "source") as SourceId[] | undefined,
      kinds: listParam(sp, "kind") as SourceKind[] | undefined,
      forum: sp.get("forum") ?? undefined,
      q: sp.get("q") ?? undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      cursor: sp.get("cursor"),
      limit: intParam(sp, "limit", 100),
    }));
  } catch (e) {
    return officialErrorResponse(e, "official.list_failed");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
