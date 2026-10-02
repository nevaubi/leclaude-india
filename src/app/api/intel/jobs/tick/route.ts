import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { intelConfig } from "@/modules/intel/config";
import { intelHealth } from "@/modules/intel/health";
import { runDue } from "@/modules/intel/jobs";
import { backfillEnabled, runBackfill } from "@/modules/india/corpus/backfill";
import { ensureIntelSeeded } from "@/modules/intel/seed";
import { withAuth } from "@/lib/auth/route";
import { currentPrincipal } from "@/lib/auth/context";
import { refs } from "@/lib/auth/resources";
import { refreshLegalNews } from "@/modules/news/service";
import { runNewsImageJobs } from "@/modules/news/image-jobs";
import { officialIngestEnabled, runOfficialIngest } from "@/modules/official/run";
import { OfficialNotConfiguredError } from "@/modules/official/service";

export const runtime = "nodejs";
/** The tick runs due intel jobs (up to ~50s), then continues the judgment corpus backfill and the official-sources ingest when they are enabled, and returns before 300s. */
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
  // Indian legal news feeds (throttled to one run per 15 minutes, 20 s budget) run alongside the intel jobs; a
  // failure is reported in the response and never fails the tick.
  const news = url.searchParams.get("news") === "0"
    ? Promise.resolve({ status: "skipped" as const, reason: "disabled" })
    : refreshLegalNews({ deadlineMs: 20_000 })
      .then((r) => ({ status: r.status, reason: r.reason, added: r.run?.added ?? 0, failed: r.run?.feeds.filter((f) => !f.ok).map((f) => f.sourceId) ?? [] }))
      .catch((e: unknown) => ({ status: "failed" as const, error: e instanceof Error ? e.message : String(e) }));
  // News images (og:image lookups, then capped vision review) after the refresh, on their own 25 s budget.
  const newsImages = url.searchParams.get("news") === "0" ? Promise.resolve(null) : news.then(() => runNewsImageJobs({ deadlineMs: 25_000, maxReviews: 8 }));
  const result = await runDue({ limit, deadlineMs, housekeeping });
  const legalNews = { ...(await news), images: await newsImages };
  // Judgment corpus backfill (durable queue in Postgres): uses the rest of the invocation when enabled.
  let corpus: Awaited<ReturnType<typeof runBackfill>> | { stop: "skipped" } = { stop: "skipped" };
  if (url.searchParams.get("corpus") !== "0" && (await backfillEnabled())) {
    const left = 270_000 - (Date.now() - started);
    if (left > 30_000) corpus = await runBackfill({ deadlineMs: left });
  }
  // Official-sources corpus (durable queue in Postgres, OFFICIAL_INGEST=1): continues with whatever time is left — only
  // for the scheduled service principal (CRON_SECRET bearer). Anyone else starts ingest runs through
  // /api/official/run (operator token, or the throttled cron kick), never through this tick.
  let official: Record<string, unknown> = { stop: "skipped" };
  const p = currentPrincipal();
  const service = Boolean(p && p.source === "service" && p.roles.includes("service"));
  if (url.searchParams.get("official") !== "0" && officialIngestEnabled() && !service) official = { stop: "skipped", reason: "official ingest runs from this tick only for the scheduled service principal" };
  else if (url.searchParams.get("official") !== "0" && officialIngestEnabled()) {
    const left = 270_000 - (Date.now() - started);
    if (left > 45_000) {
      const workers = Number(process.env.OFFICIAL_CONCURRENCY);
      try {
        const r = await runOfficialIngest({ deadlineMs: left - 5_000, concurrency: Number.isInteger(workers) && workers >= 1 ? Math.min(workers, 16) : 4 });
        official = { stop: r.stop, units: r.units, total: r.total, dbBytes: r.dbBytes, limitBytes: r.limitBytes, notes: r.notes, ...(r.error ? { error: r.error } : {}) };
      } catch (e) {
        official = e instanceof OfficialNotConfiguredError ? { stop: "not_configured" } : { stop: "error", error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
      }
    }
  }
  return Response.json({ ...result, corpus, official, legalNews, health: intelHealth() });
}

async function handlePOST(req: NextRequest) { return tick(req); }
/** Vercel cron jobs use GET. */
async function handleGET(req: NextRequest) { return tick(req); }

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => refs.intel() }));
export const GET = withDb(withAuth(handleGET, { action: "run", resource: () => refs.intel() }));
