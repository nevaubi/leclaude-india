import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { buildStory, createStory, listStories, type BuildStoryInput } from "@/modules/ediscovery/analysis/service-stories";
import type { StoryFact } from "@/modules/ediscovery/analysis/types";

export const runtime = "nodejs";

/** GET ?matter= → { stories: StorySummary[] } */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  return Response.json({ stories: listStories(m.matterId) });
}

/**
 * POST { matterId, title, theme?, facts? } → 201 { story }
 * POST { matterId, build: { from: "timeline"|"testimony"|"intel", ... }, title?, storyId? } → 201 { story, built, added, merged }
 */
async function POST__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; title?: string; theme?: string; facts?: StoryFact[]; build?: BuildStoryInput; storyId?: string }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  try {
    if (body?.build) {
      if (!["timeline", "testimony", "intel"].includes(body.build.from)) return jsonError("`build.from` must be timeline, testimony or intel");
      const r = buildStory(m.matterId, { ...body.build, title: body.title, theme: body.theme, storyId: body.storyId });
      return Response.json(r, { status: 201 });
    }
    if (!body?.title?.trim()) return jsonError("`title` is required");
    return Response.json({ story: createStory(m.matterId, { title: body.title, theme: body.theme, facts: body.facts }) }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler));

export const POST = withDb(edAuth(POST__handler));
