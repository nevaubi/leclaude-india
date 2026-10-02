import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { verifyStory } from "@/modules/ediscovery/analysis/service-stories";

export const runtime = "nodejs";

/** POST → { story, report: StoryCiteReport } — every Bates / page:line / record id checked against the matter record. */
async function POST__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = verifyStory(id);
  if (!r) return jsonError(`No story ${id}`, 404);
  return Response.json(r);
}

export const POST = withDb(edAuth(POST__handler, { lookup: "story" }));
