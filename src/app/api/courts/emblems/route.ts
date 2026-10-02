import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { JudgesNotConfiguredError } from "@/modules/judges/schema";
import { visibleCourtEmblems } from "@/modules/media/emblem-audit";

export const runtime = "nodejs";

/**
 * GET /api/courts/emblems → CourtEmblemsResponse: vision-checked emblem/logo per court, served from /api/media. Emblems
 * hidden by the State Emblem re-audit (POST /api/india/enrichment/run { target: "emblems_audit" }) are never returned.
 */
async function handleGET() {
  try {
    return Response.json(await visibleCourtEmblems(), { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (e) {
    if (e instanceof JudgesNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "courts.emblems_failed", error: (e as Error).message }));
    return jsonError("Court emblems could not be loaded.", 502, { code: "emblems_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
