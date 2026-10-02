import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { CorpusNotConfiguredError } from "@/modules/india/corpus/directory";
import { sectionStats } from "@/modules/india/citator/read";

export const runtime = "nodejs";

/**
 * GET /api/cases/sections?act=<act id>&court=<court id>&from=<year>&to=<year>&limit=<n ≤ 50> → SectionStatsResponse:
 * statute sections most cited by corpus judgments (one count per citing judgment), with a per-year breakdown.
 */
async function handleGET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const int = (k: string) => { const v = sp.get(k); if (v == null || v === "") return undefined; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
  try {
    return Response.json(await sectionStats({ act: sp.get("act"), court: sp.get("court"), from: int("from"), to: int("to"), limit: int("limit") }), { headers: { "cache-control": "private, max-age=300" } });
  } catch (e) {
    if (e instanceof RangeError) return jsonError(e.message, 400, { code: "bad_filter" });
    if (e instanceof CorpusNotConfiguredError) return jsonError("Case law is not available on this workspace.", 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "cases.sections_failed", error: (e as Error).message }));
    return jsonError("Section statistics could not be loaded just now. Try again in a moment.", 502, { code: "corpus_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
