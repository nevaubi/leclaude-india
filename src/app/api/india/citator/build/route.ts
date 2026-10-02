import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { CorpusNotConfiguredError } from "@/modules/india/corpus/directory";
import { MAX_BATCH, runCitatorBuild } from "@/modules/india/citator/build";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST { limit?, deadlineMs?, restart? } → CitatorRunResult. Same permission as the corpus and enrichment runs.
 * Scans judgments with full text in id order from the stored cursor, writes their citations (idempotent per
 * judgment) and stops at the deadline; call again to continue. `restart: true` starts a new pass from the beginning.
 */
async function handlePOST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { limit?: unknown; deadlineMs?: unknown; restart?: unknown };
  if (body.limit !== undefined && (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > MAX_BATCH)) return jsonError(`limit must be an integer between 1 and ${MAX_BATCH}`, 400, { code: "bad_limit" });
  if (body.restart !== undefined && typeof body.restart !== "boolean") return jsonError("restart must be a boolean", 400, { code: "bad_restart" });
  const deadlineMs = Math.max(10_000, Math.min(Number(body.deadlineMs) || 240_000, 270_000));
  try {
    const r = await runCitatorBuild({ limit: body.limit as number | undefined, deadlineMs, restart: body.restart === true });
    console.info(JSON.stringify({ level: "info", event: "citator.build", processed: r.processed, citations: r.citations, resolved: r.resolved, unresolved: r.unresolved, ambiguous: r.ambiguous, stop: r.stop, cursor: r.nextCursor }));
    return Response.json(r);
  } catch (e) {
    if (e instanceof CorpusNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "citator.build_failed", error: (e as Error).message }));
    return jsonError((e as Error).message, 500, { code: "citator_build_failed" });
  }
}

export const POST = withAuth(handlePOST, { action: "run", resource: () => refs.intel() });
