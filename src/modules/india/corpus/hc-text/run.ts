import "server-only";
import { PROVIDER_QUOTA_RE } from "@/lib/ai/quota";
import { remoteStore, type RemoteStore } from "@/lib/db/remote";
import { extractPdf } from "@/modules/official/extract";
import { defaultOcrModel, ocrDocument, type OcrModel } from "@/modules/official/ocr";
import { blobStoreFromEnv, type BlobStore } from "./blob-store";
import { courtOrder, hcTextConfig, type HcTextConfig } from "./config";
import { createPdfFetcher, type PdfFetcher } from "./fetch";
import { LEASE_MINUTES, MAX_ATTEMPTS, processHcUnit, type ProcessDeps, type ProcessResult } from "./process";
import { SqlHcTextRepo, type HcTextRepo, type HcUnit, type QueueCounts } from "./repo";
import { buildSchedule } from "./schedule";

/**
 * Bounded runs of the High Court PDF text worker (one cron slice / one API call). Durable and resumable: all work is in
 * hc_text_units (one row per judgment, claimed with a lease by FOR UPDATE SKIP LOCKED), so a run can stop anywhere
 * and the next one, or a concurrent one, continues.
 *
 * A run: sweep expired leases → (optionally) re-queue failed / partial units → top up the queue from the schedule
 * (court × year slices, see ./schedule.ts) when it runs low → workers claim and process units until the deadline, the
 * per-run limit, the storage budget or an empty queue. Like the official runner (src/modules/official/run.ts), a
 * watchdog hands back units still running WATCHDOG_GRACE_MS after the deadline (CPU-bound PDF parsing does not observe
 * the abort signal), so the function returns before the platform kills it with leases held.
 *
 * Stop states: done | deadline | budget | error | no_corpus (corpus_judgments absent).
 */

export const WATCHDOG_GRACE_MS = 20_000;
const MIN_UNIT_MS = 30_000;
const BUDGET_CHECK_TTL_MS = 5_000;
const IDLE_WAIT_MS = 1_000;
/** Slice queries per run while topping up the queue (bounded: most slices are cheap index probes). */
export const MAX_SEED_SLICES = 80;
/** After a full pass over the schedule, the next pass (records added since) starts this much later. */
export const SEED_PASS_PAUSE_MS = 6 * 3600_000;
export const SEED_STATE_KEY = "hc_text_seed";
/** Coverage summary: courts recounted per run (missing first, then oldest), only when older than this. */
export const COVERAGE_COURTS_PER_RUN = 3;
export const COVERAGE_MAX_AGE_MIN = 30;
/** Time a coverage recount may still start before the deadline. */
const COVERAGE_MIN_MS = 15_000;

export type HcRunStop = "done" | "deadline" | "budget" | "error" | "no_corpus";

export interface HcRunOptions {
  deadlineMs: number;
  concurrency?: number;
  /** Judgments processed in this run at most (default HC_TEXT_LIMIT_PER_RUN). */
  limit?: number;
  /** Re-queue units that ended failed or partial (operator retry after a fix). */
  retryFailed?: boolean;
  /** Top up the queue from the schedule (default true). */
  seed?: boolean;
  watchdogGraceMs?: number;
  minUnitMs?: number;
  ocrMinMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
  // ---- injectable dependencies (tests) ----
  store?: RemoteStore | null;
  repo?: HcTextRepo;
  config?: HcTextConfig;
  fetchPdf?: PdfFetcher;
  extract?: ProcessDeps["extract"];
  ocr?: ProcessDeps["ocr"];
  ocrModel?: OcrModel | (() => OcrModel);
  blobStore?: BlobStore;
  currentYear?: number;
}

export interface HcRunResult {
  stop: HcRunStop;
  processed: number;
  results: Partial<Record<ProcessResult, number>>;
  queued: number;
  queue: QueueCounts | null;
  dbBytes: number | null;
  limitBytes: number;
  notes: string[];
  errors: string[];
  durationMs: number;
  error?: string;
}

export class HcTextNotConfiguredError extends Error {
  readonly status = 503;
  constructor() {
    super("DATABASE_URL is not set: High Court judgment text lives in Postgres (Neon).");
    this.name = "HcTextNotConfiguredError";
  }
}

export function hcRepo(store?: RemoteStore | null): HcTextRepo {
  const s = store === undefined ? remoteStore() : store;
  if (!s) throw new HcTextNotConfiguredError();
  return new SqlHcTextRepo(s);
}

interface SeedState { cursor: number; passCompletedAt: number | null }

/** Queue judgments from the schedule until `want` are queued, MAX_SEED_SLICES slices were probed, or the pass ended. */
export async function seedQueue(repo: HcTextRepo, cfg: HcTextConfig, want: number, o: { now: () => number; currentYear: number; deadline: number }): Promise<{ queued: number; slices: number; cursor: number; total: number }> {
  const schedule = buildSchedule({ recentFrom: cfg.recentFrom, oldestYear: cfg.oldestYear, currentYear: o.currentYear });
  const st: SeedState = { cursor: 0, passCompletedAt: null, ...((await repo.getState<SeedState>(SEED_STATE_KEY)) ?? {}) };
  if (st.cursor >= schedule.length && st.passCompletedAt != null && o.now() - st.passCompletedAt >= SEED_PASS_PAUSE_MS) st.cursor = 0;
  let queued = 0;
  let slices = 0;
  while (queued < want && st.cursor < schedule.length && slices < MAX_SEED_SLICES && o.now() < o.deadline - MIN_UNIT_MS) {
    const ask = want - queued;
    const n = await repo.seedSlice(schedule[st.cursor], ask);
    slices++;
    queued += n;
    if (n < ask) st.cursor++; // slice exhausted for this pass
  }
  if (st.cursor >= schedule.length) st.passCompletedAt ??= o.now();
  else st.passCompletedAt = null;
  await repo.setState(SEED_STATE_KEY, st);
  return { queued, slices, cursor: st.cursor, total: schedule.length };
}

export async function runHcTextIngest(o: HcRunOptions): Promise<HcRunResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cfg = o.config ?? hcTextConfig();
  const started = now();
  const deadline = started + Math.max(1_000, o.deadlineMs);
  const log = o.log ?? ((line: Record<string, unknown>) => console.info(JSON.stringify(line)));
  const result: HcRunResult = { stop: "done", processed: 0, results: {}, queued: 0, queue: null, dbBytes: null, limitBytes: cfg.maxDbBytes, notes: [], errors: [], durationMs: 0 };
  const repo = o.repo ?? hcRepo(o.store); // HcTextNotConfiguredError propagates (503 at the route)
  const finish = async (stop: HcRunStop): Promise<HcRunResult> => {
    result.stop = stop;
    result.durationMs = now() - started;
    result.queue = await repo.queueCounts().catch(() => null);
    log({ level: stop === "error" ? "error" : "info", event: "hc_text.run", stop, processed: result.processed, results: result.results, queued: result.queued, dbBytes: result.dbBytes, limitBytes: cfg.maxDbBytes, durationMs: result.durationMs, ...(result.error ? { error: result.error } : {}) });
    return result;
  };

  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort(o.signal?.reason);
  if (o.signal?.aborted) ctrl.abort(o.signal.reason);
  else o.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error("hc-text run deadline")), Math.max(0, deadline - now()));
  (timer as { unref?: () => void }).unref?.();
  try {
    return await run();
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onCallerAbort);
  }

  async function run(): Promise<HcRunResult> {
    const signal = ctrl.signal;
    let budgetAt = 0;
    let budgetPromise: Promise<number> | null = null;
    const overBudget = async (): Promise<boolean> => {
      if (!budgetPromise || now() - budgetAt > BUDGET_CHECK_TTL_MS) { budgetAt = now(); budgetPromise = repo.dbBytes(); }
      result.dbBytes = await budgetPromise;
      return result.dbBytes >= cfg.maxDbBytes;
    };
    try {
      const { judgments } = await repo.ensureSchema();
      if (!judgments) { result.notes.push("corpus_judgments does not exist: load High Court metadata first (corpus backfill)"); return finish("no_corpus"); }
      const swept = await repo.sweepExpired(MAX_ATTEMPTS);
      if (swept) result.notes.push(`${swept} unit(s) whose lease expired on the last attempt closed as failed`);
      if (repo.requeueMatching) {
        // Texts stored partial (or failed) only because the OCR provider had no credit are tried again.
        const q = await repo.requeueMatching(PROVIDER_QUOTA_RE.source, 2_000);
        if (q) result.notes.push(`${q} unit(s) left partial or failed for lack of OCR provider credit re-queued`);
      }
      if (o.retryFailed) {
        const n = await repo.requeue(["failed", "partial"], 5_000);
        if (n) result.notes.push(`${n} failed or partial unit(s) re-queued`);
      }
      if (await overBudget()) {
        result.notes.push(`database size ${result.dbBytes} bytes reached the budget of ${cfg.maxDbBytes} bytes (HC_TEXT_MAX_DB_MB)`);
        return finish("budget");
      }
      if (o.seed !== false) {
        const pending = await repo.pendingCount();
        if (pending < cfg.enqueuePerRun) {
          const s = await seedQueue(repo, cfg, cfg.enqueuePerRun - pending, { now, currentYear: o.currentYear ?? new Date(now()).getUTCFullYear(), deadline });
          result.queued = s.queued;
          if (s.queued) result.notes.push(`${s.queued} judgment(s) queued (${s.slices} slice(s) probed; schedule position ${s.cursor}/${s.total})`);
        }
      }
    } catch (e) {
      result.error = (e as Error).message.slice(0, 500);
      return finish("error");
    }

    const limit = Math.max(1, Math.floor(o.limit ?? cfg.limitPerRun));
    const concurrency = Math.max(1, Math.min(Math.floor(o.concurrency ?? cfg.concurrency), 16));
    const minUnitMs = Math.max(0, o.minUnitMs ?? MIN_UNIT_MS);
    let modelCache: OcrModel | null = null;
    const deps: ProcessDeps = {
      repo,
      config: cfg,
      fetchPdf: o.fetchPdf ?? createPdfFetcher({ maxBytes: cfg.maxPdfBytes, timeoutMs: cfg.fetchTimeoutMs, rps: cfg.hostRps, burst: cfg.hostBurst }),
      extract: o.extract ?? ((bytes) => extractPdf(bytes, { withItems: false })),
      ocr: o.ocr ?? ocrDocument,
      ocrModel: () => {
        if (typeof o.ocrModel === "function") return o.ocrModel();
        if (o.ocrModel) return o.ocrModel;
        return (modelCache ??= defaultOcrModel({ OFFICIAL_OCR_MODEL: cfg.ocrModel ?? undefined }));
      },
      blobStore: o.blobStore ?? blobStoreFromEnv(),
      deadline,
      now,
      signal,
      ocrMinMs: o.ocrMinMs,
      log: (event, data) => log({ level: "info", event, ...data }),
    };

    /** Recount a few courts into the coverage summary (bounded; a failure is a note, never a run failure). */
    const refreshCoverage = async () => {
      try {
        const courts = await repo.staleCoverageCourts(courtOrder(), COVERAGE_MAX_AGE_MIN, COVERAGE_COURTS_PER_RUN);
        const done: string[] = [];
        for (const c of courts) {
          if (deadline + Math.max(0, o.watchdogGraceMs ?? WATCHDOG_GRACE_MS) - now() < COVERAGE_MIN_MS) break;
          await repo.refreshCoverage(c);
          done.push(c);
        }
        if (done.length) result.notes.push(`coverage recounted: ${done.join(", ")}`);
      } catch (e) {
        result.notes.push(`coverage recount skipped: ${(e as Error).message.slice(0, 200)}`);
      }
    };

    const state: { stop: HcRunStop | null } = { stop: null };
    const inflight = new Map<string, HcUnit>();
    let claimed = 0;
    let active = 0;

    const work = async () => {
      for (;;) {
        if (state.stop) return;
        if (signal.aborted || now() > deadline - minUnitMs) { state.stop ??= "deadline"; return; }
        if (claimed >= limit) return;
        if (await overBudget()) { state.stop = "budget"; return; }
        claimed++;
        const unit = await repo.claim(LEASE_MINUTES, MAX_ATTEMPTS);
        if (!unit) {
          claimed--;
          if (active > 0) { await sleep(IDLE_WAIT_MS); if (active > 0) continue; }
          return;
        }
        active++;
        inflight.set(unit.judgmentId, unit);
        try {
          const out = await processHcUnit(unit, deps);
          result.processed++;
          result.results[out.result] = (result.results[out.result] ?? 0) + 1;
          if (out.error && result.errors.length < 50) result.errors.push(`${unit.judgmentId}: ${out.error}`);
        } catch (e) {
          // A store failure (or an unexpected error): stop every worker; the unit keeps its lease and is retried later.
          result.error ??= `${unit.judgmentId}: ${(e as Error).message.slice(0, 400)}`;
          state.stop = "error";
        } finally {
          active--;
          inflight.delete(unit.judgmentId);
        }
      }
    };

    const workers = Promise.all(Array.from({ length: concurrency }, () => work()));
    const grace = Math.max(0, o.watchdogGraceMs ?? WATCHDOG_GRACE_MS);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const late = await Promise.race([
      workers.then(() => false),
      new Promise<boolean>((resolve) => { watchdog = setTimeout(() => resolve(true), Math.max(0, deadline + grace - now())); }),
    ]);
    clearTimeout(watchdog);
    if (late) {
      state.stop ??= "deadline";
      const held = [...inflight.values()];
      for (const u of held) await repo.release(u.judgmentId, "run ended before this unit finished; resumes in a later run").catch(() => undefined);
      if (held.length) result.notes.push(`${held.length} unit(s) still running ${Math.round(grace / 1000)} s after the deadline were handed back`);
    }
    if (state.stop === "error") return finish("error");
    if (!late) await refreshCoverage();
    if (state.stop === "budget") {
      result.notes.push(`database size ${result.dbBytes} bytes reached the budget of ${cfg.maxDbBytes} bytes (HC_TEXT_MAX_DB_MB)`);
      return finish("budget");
    }
    if (state.stop === "deadline") return finish((await repo.pendingCount().catch(() => 1)) > 0 ? "deadline" : "done");
    if (claimed >= limit) result.notes.push(`per-run limit (${limit}) reached`);
    return finish("done");
  }
}
