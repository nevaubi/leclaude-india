import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { intelConfig } from "@/modules/intel/config";
import { intelHealth } from "@/modules/intel/health";
import { runDue } from "@/modules/intel/jobs";
import { backfillEnabled, runBackfill } from "@/modules/india/corpus/backfill";
import { ensureIntelSeeded } from "@/modules/intel/seed";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";

export const runtime = "nodejs";
/** The tick runs due intel jobs (up to ~50s), then continues the judgment corpus backfill when it is enabled, and returns before 300s. */
export const maxDuration = 300;

/**
 * External cron driver. Runs due intel jobs for up to 50 seconds and also the
 * housekeeping cadences (workflow scheduler tick, integrity scans, sweep,
 * embedding backfill) that the in-process loop would otherwise cover.
 * vercel.json schedules it hourly (each run wakes the database, so a tighter cadence exhausts a free-tier quota); note that Vercel Hobby plans only
 * allow one cron invocation per day, so use an external cron (or the inline
 * runner on a persistent host) for the intended cadence. When CRON_SECRET is
 * set, the request must carry "Authorization: Bearer <secret>".
 */
async function tick(req: NextRequest) {
  const { cronSecret } = intelConfig();
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) return jsonError("Unauthorized", 401);
  }
  try { ensureIntelSeeded(); } catch { /* seeded by db() on first access */ }
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200));
  const deadlineMs = Math.max(1000, Math.min(Number(url.searchParams.get("deadlineMs") ?? 50_000) || 50_000, 55_000));
  const housekeeping = url.searchParams.get("housekeeping") !== "0";
  const started = Date.now();
  const result = await runDue({ limit, deadlineMs, housekeeping });
  // Judgment corpus backfill (durable queue in Postgres): uses the rest of the invocation when enabled.
  let corpus: Awaited<ReturnType<typeof runBackfill>> | { stop: "skipped" } = { stop: "skipped" };
  if (url.searchParams.get("corpus") !== "0" && (await backfillEnabled())) {
    const left = 270_000 - (Date.now() - started);
    if (left > 30_000) corpus = await runBackfill({ deadlineMs: left });
  }
  return Response.json({ ...result, corpus, health: intelHealth() });
}

async function handlePOST(req: NextRequest) { return tick(req); }
/** Vercel cron jobs use GET. */
async function handleGET(req: NextRequest) { return tick(req); }

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => refs.intel() }));
export const GET = withDb(withAuth(handleGET, { action: "run", resource: () => refs.intel() }));
