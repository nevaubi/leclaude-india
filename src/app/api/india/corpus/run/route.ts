import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { runBackfill } from "@/modules/india/corpus/backfill";

export const runtime = "nodejs";
/** A run works for up to ~270s and returns; call again (or let the hourly cron tick) to continue. */
export const maxDuration = 300;

/**
 * POST { deadlineMs? } → work the corpus queue now, until the deadline (default 240s, max 270s), the queue is empty, or
 * the storage budget (CORPUS_MAX_DB_MB) is reached. Only continues a backfill that is enabled (CORPUS_BACKFILL=1 or an
 * administrator's switch); it returns stop "disabled" otherwise. Same permission as the cron tick.
 */
async function handlePOST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { deadlineMs?: number };
  try {
    const deadlineMs = Math.max(10_000, Math.min(Number(body.deadlineMs) || 240_000, 270_000));
    return Response.json(await runBackfill({ deadlineMs }));
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
}

export const POST = withAuth(handlePOST, { action: "run", resource: () => refs.intel() });
