import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { listLegalNews } from "@/modules/news/service";

export const runtime = "nodejs";

/** GET /api/news?source=&court=&q=&limit=&before= — Indian legal headlines, newest first. */
async function handleGET(req: Request) {
  const url = new URL(req.url);
  const p = (k: string) => url.searchParams.get(k)?.trim() || null;
  return Response.json(listLegalNews({ source: p("source"), court: p("court"), q: p("q")?.slice(0, 200) ?? null, limit: Number(p("limit")) || null, before: p("before") }));
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "news" }) }));
