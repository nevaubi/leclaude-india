import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { corpusStatus, CorpusNotConfigured, runBackfill, setBackfillEnabled } from "@/modules/india/corpus/backfill";

export const runtime = "nodejs";
/** A backfill run works for up to ~240s (plus the lease grace) and returns; call again (or let the cron tick) to continue. */
export const maxDuration = 300;

/** GET → corpus status: queue by state, archives per court with declared/stored/rejected counts, judgments per court, database size vs budget. */
async function handleGET() {
  try {
    return Response.json(await corpusStatus());
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
}

/**
 * POST { action: "enable" | "disable" | "run", deadlineMs? }.
 * enable: turns the scheduled backfill on and queues discovery (idempotent). run: works the queue now until the deadline
 * (default 240s, max 270s), the queue is empty, or the storage budget (CORPUS_MAX_DB_MB) is reached.
 */
async function handlePOST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; deadlineMs?: number };
  try {
    if (body.action === "enable" || body.action === "disable") {
      await setBackfillEnabled(body.action === "enable");
      return Response.json(await corpusStatus());
    }
    if (body.action === "run") {
      const deadlineMs = Math.max(10_000, Math.min(Number(body.deadlineMs) || 240_000, 270_000));
      return Response.json(await runBackfill({ deadlineMs }));
    }
    return jsonError('action must be "enable", "disable" or "run"', 422);
  } catch (e) {
    if (e instanceof CorpusNotConfigured) return jsonError(e.message, 503);
    return jsonError((e as Error).message, 500);
  }
}

export const GET = withAuth(handleGET, { action: "read", resource: () => refs.intel() });
export const POST = withAuth(handlePOST, { action: "admin", resource: () => refs.intel() });
