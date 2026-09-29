import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { getCorpusJudgment, searchCorpus } from "@/modules/india/corpus/search";

export const runtime = "nodejs";

/** GET ?q=&court=sci&court=hc-karnataka&year_from=&year_to=&judge=&limit= → { hits }, or ?id= → one judgment's index record. */
async function handleGET(req: NextRequest) {
  const url = new URL(req.url);
  try {
    const id = url.searchParams.get("id");
    if (id) {
      const hit = await getCorpusJudgment(id);
      return hit ? Response.json({ hit }) : jsonError("No judgment with that id in the index", 404);
    }
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return jsonError("q is required", 422);
    const num = (k: string) => { const v = Number(url.searchParams.get(k)); return Number.isFinite(v) && v > 0 ? v : undefined; };
    return Response.json(await searchCorpus({ q, courts: url.searchParams.getAll("court").filter(Boolean), yearFrom: num("year_from"), yearTo: num("year_to"), judge: url.searchParams.get("judge") ?? undefined, limit: num("limit") }));
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
}

export const GET = withAuth(handleGET, { action: "read", resource: () => refs.intel() });
