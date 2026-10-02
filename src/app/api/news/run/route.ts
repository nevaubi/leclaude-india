import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { withCronGate } from "@/lib/auth/cron";
import { refs } from "@/lib/auth/resources";
import { refreshLegalNews } from "@/modules/news/service";
import { runNewsImageJobs } from "@/modules/news/image-jobs";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * GET /api/news/run — scheduled every 30 minutes (vercel.json). Fetches the registered Indian legal news feeds and
 * then the pending headline images. Pages only read stored headlines; nothing is fetched when someone opens the app.
 * Gated like the other cron routes: with CRON_SECRET set only the cron service principal starts work.
 */
async function run() {
  const news = await refreshLegalNews({ deadlineMs: 60_000 })
    .then((r) => ({ status: r.status, reason: r.reason, added: r.run?.added ?? 0, failed: r.run?.feeds.filter((f) => !f.ok).map((f) => f.sourceId) ?? [] }))
    .catch((e: unknown) => ({ status: "failed" as const, error: e instanceof Error ? e.message.slice(0, 300) : String(e) }));
  const images = await runNewsImageJobs({ deadlineMs: 40_000, maxReviews: 8 }).catch((e: unknown) => ({ error: e instanceof Error ? e.message.slice(0, 300) : String(e) }));
  return Response.json({ news, images });
}

export const GET = withCronGate(withDb(withAuth(run, { action: "run", resource: () => refs.intel() })));
