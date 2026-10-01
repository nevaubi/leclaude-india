import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { getJudgeProfile } from "@/modules/judges/directory";
import { isJudgeId } from "@/modules/judges/names";
import { JudgesNotConfiguredError } from "@/modules/judges/schema";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/judges/<id> → JudgeProfileResponse (official roster fields, photo attribution, judgments matched by name as printed). */
async function handleGET(_req: NextRequest, ctx: Ctx) {
  const id = decodeURIComponent((await ctx.params).id);
  if (!isJudgeId(id)) return jsonError("Not a judge id", 400, { code: "bad_id" });
  try {
    const res = await getJudgeProfile(id);
    return res ? Response.json(res) : jsonError("No judge with this id", 404, { code: "not_found" });
  } catch (e) {
    if (e instanceof JudgesNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "judges.profile_failed", error: (e as Error).message }));
    return jsonError("The judge's profile could not be loaded. Try again in a moment.", 502, { code: "judges_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
