import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { courtById } from "@/lib/india/courts";
import { coramMatches } from "@/modules/judges/directory";
import { JudgesNotConfiguredError } from "@/modules/judges/schema";

export const runtime = "nodejs";

/** GET /api/judges/coram?court=<id>&name=<as printed>&name=… → CoramResponse: exact same-court matches only. */
async function handleGET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const court = sp.get("court") ?? "";
  if (!courtById(court)) return jsonError("Unknown court", 400, { code: "bad_court" });
  const names = sp.getAll("name").map((n) => n.slice(0, 160)).slice(0, 20);
  try {
    return Response.json(await coramMatches(court, names));
  } catch (e) {
    if (e instanceof JudgesNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "judges.coram_failed", error: (e as Error).message }));
    return jsonError("Judge links could not be loaded.", 502, { code: "judges_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
