import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { getTracking, putTracking, requireMatter } from "@/modules/matters/desk/server";
import { suggestIdentifiers, trackingForumOptions } from "@/modules/matters/desk/tracking";
import { readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET — the matter's tracked identifiers, identifiers its case particulars suggest (not yet tracked) and the forum list. */
async function handleGET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const matter = requireMatter(id);
    const tracking = getTracking(id);
    const have = new Set((tracking?.identifiers ?? []).map((i) => `${i.forum}|${i.kind}|${i.value}`));
    const suggestions = suggestIdentifiers(matter.india).filter((s) => !have.has(`${s.forum}|${s.kind}|${s.value}`));
    return Response.json({ tracking, suggestions, forums: trackingForumOptions() });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

/** PUT { identifiers: [{ forum, kind, printed }], advocateNames?: string[] } — replaces the set; 400 with the reason when an identifier does not normalize. */
async function handlePUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const body = await readJsonObject(req);
    return Response.json({ tracking: putTracking(id, body) });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: (_req, { id }) => refs.matter(id) }));
export const PUT = withDb(withAuth(handlePUT, { action: "write", resource: (_req, { id }) => refs.matter(id) }));
