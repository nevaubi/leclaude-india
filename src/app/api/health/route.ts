import { withDb } from "@/lib/db/request";
import { db } from "@/lib/db";
import { aiConfig } from "@/lib/ai/config";
import { authMode, resolvePrincipal } from "@/lib/auth/principal";

export const runtime = "nodejs";

/**
 * GET /api/health — liveness. Public (uptime monitors call it without credentials), so an anonymous caller on a
 * deployment that enforces sign-in gets only { ok, time }; record counts and model configuration are returned in
 * dev mode or to an authenticated principal.
 */
async function canSeeDetails(req: Request): Promise<boolean> {
  try {
    if (authMode() === "dev") return true;
    await resolvePrincipal(req);
    return true;
  } catch {
    return false;
  }
}

async function GET__handler(req: Request) {
  const time = new Date().toISOString();
  if (!(await canSeeDetails(req))) return Response.json({ ok: true, time }, { headers: { "cache-control": "no-store" } });
  const d = db();
  const cfg = aiConfig();
  return Response.json({
    ok: true,
    time,
    ai: { configured: cfg.hasKey, model: cfg.model, fastModel: cfg.fastModel, embeddingModel: cfg.embeddingModel },
    counts: { matters: d.matters.count(), people: d.people.count(), edocs: d.edocs.count(), depositions: d.depositions.count(), workflows: d.workflows.count(), officeDocs: d.officeDocs.count(), library: d.library.count(), tasks: d.tasks.count(), events: d.events.count(), news: d.news.count() },
  });
}

export const GET = withDb(GET__handler);
