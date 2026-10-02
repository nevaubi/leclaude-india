import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { remoteStore } from "@/lib/db/remote";
import { judgmentEmbedStatus, runJudgmentEmbedding } from "@/modules/india/corpus/embeddings";

export const runtime = "nodejs";
/** A pass works for up to ~270s and returns; call again (or let the hourly tick with JUDGMENT_EMBED=1 continue it). */
export const maxDuration = 300;

/**
 * GET → judgment-embedding status (queue by status, judgments embedded with the configured model, pgvector mode).
 * POST { deadlineMs?, maxChunks? } → work the judgment-embedding queue now (tiered: read-on-access, Supreme Court,
 * priority High Courts). Same permission as the corpus backfill. Nothing is embedded without an embedding provider.
 */
async function handleGET() {
  const store = remoteStore();
  if (!store) return jsonError("The judgment corpus is not configured (DATABASE_URL).", 503);
  try { return Response.json(await judgmentEmbedStatus(store)); } catch (e) { return jsonError((e as Error).message, 500); }
}

async function handlePOST(req: NextRequest) {
  const store = remoteStore();
  if (!store) return jsonError("The judgment corpus is not configured (DATABASE_URL).", 503);
  const body = (await req.json().catch(() => ({}))) as { deadlineMs?: number; maxChunks?: number };
  const deadlineMs = Math.max(15_000, Math.min(Number(body.deadlineMs) || 240_000, 270_000));
  const maxChunks = Math.max(32, Math.min(Number(body.maxChunks) || 4_000, 20_000));
  try {
    return Response.json(await runJudgmentEmbedding(store, { deadline: Date.now() + deadlineMs, maxChunks, signal: req.signal }));
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
}

export const GET = withAuth(handleGET, { action: "read", resource: () => refs.intel() });
export const POST = withAuth(handlePOST, { action: "run", resource: () => refs.intel() });
