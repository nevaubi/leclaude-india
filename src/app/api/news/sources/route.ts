import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { legalNewsSources } from "@/modules/news/service";

export const runtime = "nodejs";

/** GET /api/news/sources — the feed registry with per-feed status (last success, last error, items). */
async function handleGET() {
  return Response.json(legalNewsSources());
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "news" }) }));
