import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { jsonError } from "@/lib/ai/sse";
import { refreshLegalNews } from "@/modules/news/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/news/refresh { force?: boolean } — fetch the registered feeds now. Throttled server-side: within 15 minutes
 * of the last run the call returns `{ status: "skipped", reason: "throttled", nextAllowedAt }`; `force` lowers the
 * floor to 60 seconds.
 */
async function handlePOST(req: Request) {
  let force = false;
  try { const body = (await req.json()) as { force?: unknown }; force = body?.force === true; } catch { /* empty body */ }
  try {
    return Response.json(await refreshLegalNews({ force, signal: req.signal }));
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "News refresh failed", 500);
  }
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => ({ kind: "news" }) }));
