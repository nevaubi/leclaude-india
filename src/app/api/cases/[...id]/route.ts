import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { caseIdFromSegments } from "@/modules/caselaw/shared";
import { CorpusNotConfiguredError, judgmentRecord } from "@/modules/india/corpus/directory";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string[] }> };

/** GET /api/cases/<record id, e.g. sc:… or hc:29_3/bench/file> → CaseRecordResponse { record, sameCase }. */
async function handleGET(_req: NextRequest, ctx: Ctx) {
  const id = caseIdFromSegments((await ctx.params).id);
  if (!id) return jsonError("This is not a valid case link.", 400, { code: "bad_id" });
  try {
    const res = await judgmentRecord(id);
    return res ? Response.json(res) : jsonError("This case could not be found.", 404, { code: "not_found" });
  } catch (e) {
    if (e instanceof CorpusNotConfiguredError) return jsonError("Case law is not available on this workspace.", 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "cases.record_failed", error: (e as Error).message }));
    return jsonError("The record could not be loaded. Try again in a moment.", 502, { code: "corpus_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
