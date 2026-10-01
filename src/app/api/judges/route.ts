import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { listJudges } from "@/modules/judges/directory";
import { JudgesNotConfiguredError } from "@/modules/judges/schema";

export const runtime = "nodejs";

/** GET /api/judges?court=&q=&status= → JudgesListResponse (judges from official court rosters, with per-court counts). */
async function handleGET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  try {
    return Response.json(await listJudges({ court: sp.get("court"), q: sp.get("q"), status: sp.get("status") }));
  } catch (e) {
    if (e instanceof JudgesNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "judges.list_failed", error: (e as Error).message }));
    return jsonError("The judges directory could not be loaded. Try again in a moment.", 502, { code: "judges_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
