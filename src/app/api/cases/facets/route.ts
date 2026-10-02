import { after } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { corpusFacets, CorpusNotConfiguredError } from "@/modules/india/corpus/directory";

export const runtime = "nodejs";

/** GET /api/cases/facets → CaseFacets (records per court and year, coverage dates, archive progress, disposals). Cached ~10 minutes. */
async function handleGET() {
  try {
    return Response.json(await corpusFacets(undefined, Date.now, { durable: true, defer: (task) => after(task) }), { headers: { "cache-control": "private, max-age=120" } });
  } catch (e) {
    if (e instanceof CorpusNotConfiguredError) return jsonError("Case law is not available on this workspace.", 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "cases.facets_failed", error: (e as Error).message }));
    return jsonError("Court coverage could not be loaded just now. Try again in a moment.", 502, { code: "corpus_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
