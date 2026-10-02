import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { CorpusNotConfiguredError } from "@/modules/india/corpus/directory";
import { citatorFor } from "@/modules/india/citator/read";

export const runtime = "nodejs";

const ID_RE = /^(sc|hc):\S{1,390}$/;

/**
 * GET /api/cases/citator?id=<sc:… / hc:…> → CitatorResponse: what the judgment cites (exact-match resolution), which
 * corpus judgments cite it with deterministic text cues (never verified treatments), and a negative-signal summary
 * with coverage. status "not_built" falls back to text mentions without signals.
 */
async function handleGET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!ID_RE.test(id)) return jsonError("id must be a case record id (sc:… or hc:…)", 400, { code: "bad_id" });
  try {
    const res = await citatorFor(id);
    return res ? Response.json(res, { headers: { "cache-control": "private, max-age=60" } }) : jsonError("This case could not be found.", 404, { code: "not_found" });
  } catch (e) {
    if (e instanceof CorpusNotConfiguredError) return jsonError("Case law is not available on this workspace.", 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "cases.citator_failed", error: (e as Error).message }));
    return jsonError("Citations could not be loaded just now. Try again in a moment.", 502, { code: "corpus_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
