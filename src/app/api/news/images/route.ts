import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { jsonError } from "@/lib/ai/sse";
import { newsImageStats, runNewsImageJobs } from "@/modules/news/image-jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/news/images — image coverage counts (verified / heuristic / hidden / none, review and lookup states). */
async function handleGET() {
  return Response.json(newsImageStats());
}

/**
 * POST /api/news/images { maxReviews?: number } — run one image pass now (page lookups, then at most `maxReviews`
 * (default 8, max 12) vision reviews within 25 s). The cron tick runs the same pass after each feed refresh.
 */
async function handlePOST(req: Request) {
  let maxReviews = 8;
  try { const b = (await req.json()) as { maxReviews?: unknown }; if (typeof b?.maxReviews === "number") maxReviews = Math.max(0, Math.min(12, Math.floor(b.maxReviews))); } catch { /* empty body */ }
  try {
    const run = await runNewsImageJobs({ deadlineMs: 25_000, maxReviews, signal: req.signal });
    return Response.json({ run, stats: newsImageStats() });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "News image pass failed", 500);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "news" }) }));
export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => ({ kind: "news" }) }));
