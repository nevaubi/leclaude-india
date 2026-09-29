import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { corpusStatus, CorpusNotConfigured, setBackfillEnabled } from "@/modules/india/corpus/backfill";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET → corpus status: queue by state, archives per court with declared/stored/rejected counts, judgments per court, database size vs budget. */
async function handleGET() {
  try {
    return Response.json(await corpusStatus());
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
}

/**
 * POST { action: "enable" | "disable" } (administrators): turns the backfill on or off in the database state and queues
 * discovery. The deployment can also enable it with CORPUS_BACKFILL=1. Working the queue is POST /api/india/corpus/run.
 */
async function handlePOST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; deadlineMs?: number };
  try {
    if (body.action === "enable" || body.action === "disable") {
      await setBackfillEnabled(body.action === "enable");
      return Response.json(await corpusStatus());
    }
    return jsonError('action must be "enable" or "disable" (work the queue with POST /api/india/corpus/run)', 422);
  } catch (e) {
    if (e instanceof CorpusNotConfigured) return jsonError(e.message, 503);
    return jsonError((e as Error).message, 500);
  }
}

export const GET = withAuth(handleGET, { action: "read", resource: () => refs.intel() });
export const POST = withAuth(handlePOST, { action: "admin", resource: () => refs.intel() });
