import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { parseCaseFilters, PAGE_SIZE } from "@/modules/caselaw/shared";
import { CorpusNotConfiguredError, listJudgments } from "@/modules/india/corpus/directory";

export const runtime = "nodejs";

/**
 * GET /api/cases?q=&court=sci&court=hc-karnataka&court=code:99_9&from=&to=&judge=&disposal=&sort=newest|oldest|relevance&cursor=&limit=
 * → CaseListResponse. Parameters are parsed and clamped (unknown values dropped); `cursor` is the previous page's nextCursor.
 */
async function handleGET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const f = parseCaseFilters(sp);
  const limitRaw = Number(sp.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), PAGE_SIZE) : PAGE_SIZE;
  const cursor = (sp.get("cursor") ?? "").slice(0, 500) || null;
  try {
    return Response.json(await listJudgments({ ...f, cursor, limit }));
  } catch (e) {
    if (e instanceof CorpusNotConfiguredError) return jsonError("Case law is not available on this workspace.", 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "cases.list_failed", error: (e as Error).message }));
    return jsonError("Case law could not be searched just now. Try again in a moment.", 502, { code: "corpus_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
