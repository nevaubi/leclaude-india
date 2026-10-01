import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { judgmentTextAvailable, readJudgmentText, searchJudgmentText } from "@/modules/india/corpus/text";
import { remoteStore } from "@/lib/db/remote";

export const runtime = "nodejs";

/**
 * GET /api/cases/text?id=<sc:… or neutral citation>&chunk=<n>&page=<n> → one judgment's text (chunks with pages).
 * GET /api/cases/text?q=<words>&yearFrom&yearTo&limit → full-text search hits (best passage per judgment).
 */
async function handleGET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (!remoteStore()) return jsonError("The case law index is not configured on this deployment (no DATABASE_URL).", 503, { code: "corpus_not_configured" });
  const int = (k: string) => { const v = sp.get(k); const n = v == null || v === "" ? NaN : Number(v); return Number.isFinite(n) ? Math.floor(n) : undefined; };
  try {
    if (!(await judgmentTextAvailable())) return jsonError("Judgment text is not loaded on this deployment.", 503, { code: "text_not_loaded" });
    const q = sp.get("q");
    if (q != null) {
      const res = await searchJudgmentText(q, { yearFrom: int("yearFrom"), yearTo: int("yearTo"), limit: int("limit") });
      return Response.json(res);
    }
    const id = (sp.get("id") ?? "").trim();
    if (!id) return jsonError("id or q is required", 400, { code: "bad_request" });
    const text = await readJudgmentText(id, { fromChunk: int("chunk"), page: int("page"), maxChars: int("maxChars") ?? 80_000 });
    return text ? Response.json(text) : jsonError("No full text for this judgment.", 404, { code: "no_text" });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "cases.text_failed", error: (e as Error).message }));
    return jsonError("The judgment text could not be loaded. Try again in a moment.", 502, { code: "corpus_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
