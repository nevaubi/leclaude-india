import "server-only";
import { classifyFailure, emptyMetrics, isAbortError, isTransientFailure, type FailureKind, type RunMetrics, type TokenUsage } from "@/lib/ai/events";

/**
 * Runtime contract for the research orchestrator (constitution §14, §36, §47):
 * bounded, dependency-aware lane scheduling; per-lane timeouts linked to the run's
 * cancellation signal; retry with backoff for transient failures only; and the
 * per-run metrics recorder. No model or provider code lives here.
 */

export interface RunPolicy {
  /** How long a lane waits for the fast-model plan after its first retrieval wave. */
  planWaitMs: number;
  /** How long a soft-dependent lane waits for its dependency's first retrieval wave. */
  softDepWaitMs: number;
  /** How long synthesis waits for in-flight treatment checks once the lanes are done. */
  treatmentWaitMs: number;
  /** How long a regional-language question waits for its English search terms before lanes start on its own words. */
  translateWaitMs: number;
  /** How long the run waits for the (cached) Indian law corpus coverage summary before planning without it. */
  coverageWaitMs?: number;
  /** Lanes running at once. */
  laneConcurrency: number;
  /** Default per-lane wall-clock budget when the planner sets none. */
  laneTimeoutMs: number;
  /** Whole-run wall-clock budget; no new round starts past it. */
  runTimeMs: number;
  /** Retries for transient provider/read failures (rate limit, outage, timeout). */
  retrievalRetries: number;
  /** Retries for transient model-call failures (verification, correction). */
  modelRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

/**
 * Deep research. 2026-10 (before → after): planWaitMs 4s → 6s, treatmentWaitMs 2.5s → 4s, laneTimeoutMs 120s → 150s.
 * runTimeMs stays 8 min: the effective budget is the run wall (researchWallMs, 265s → 280s under the 300s function limit).
 */
export const DEFAULT_POLICY: Readonly<RunPolicy> = {
  planWaitMs: 6_000,
  softDepWaitMs: 30_000,
  treatmentWaitMs: 4_000,
  translateWaitMs: 6_000,
  coverageWaitMs: 2_500,
  laneConcurrency: 6,
  laneTimeoutMs: 150_000,
  runTimeMs: 8 * 60_000,
  retrievalRetries: 2,
  modelRetries: 1,
  retryBaseMs: 600,
  retryMaxMs: 4_000,
};

/** Fast mode. 2026-10 (before → after): laneTimeoutMs 45s → 75s, runTimeMs 120s → 180s (the fast adverse lane needs room). */
export const FAST_POLICY: Readonly<RunPolicy> = {
  ...DEFAULT_POLICY,
  laneTimeoutMs: 75_000,
  runTimeMs: 3 * 60_000,
  retrievalRetries: 1,
  modelRetries: 1,
};

export function resolvePolicy(mode: "deep" | "fast", over?: Partial<RunPolicy>): RunPolicy {
  const base = mode === "fast" ? FAST_POLICY : DEFAULT_POLICY;
  const out: RunPolicy = { ...base, ...(over ?? {}) };
  out.laneConcurrency = Math.max(1, Math.floor(out.laneConcurrency));
  return out;
}

export function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Sleep that rejects with AbortError as soon as the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface LinkedSignal {
  signal: AbortSignal;
  /** True once the timeout fired (as opposed to the parent aborting). */
  timedOut: () => boolean;
  /** Stop the timer and detach from the parent. */
  release: () => void;
}

/** A signal that aborts when the parent aborts or when `timeoutMs` elapses. */
export function linkedSignal(parent?: AbortSignal, timeoutMs?: number): LinkedSignal {
  const ctrl = new AbortController();
  let timedOut = false;
  const onParent = () => ctrl.abort();
  if (parent?.aborted) ctrl.abort();
  else parent?.addEventListener("abort", onParent, { once: true });
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    release: () => { if (timer) clearTimeout(timer); parent?.removeEventListener("abort", onParent); },
  };
}

export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs?: number;
  signal?: AbortSignal;
  /** Called before each backoff sleep with the failure that triggered it. */
  onRetry?: (info: { error: unknown; failure: FailureKind; attempt: number; delayMs: number }) => void;
  /** Deterministic jitter for tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * Retry `fn` on transient failures only (constitution §47). Exponential backoff with
 * jitter, bounded by `retries`; never retries cancellation, configuration, auth or
 * malformed-output failures.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const random = opts.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const failure = classifyFailure(e);
      if (isAbortError(e) || opts.signal?.aborted || !isTransientFailure(failure) || attempt >= opts.retries) throw e;
      const delayMs = Math.min(opts.maxMs ?? Number.POSITIVE_INFINITY, Math.round(opts.baseMs * Math.pow(2, attempt) * (0.75 + random() * 0.5)));
      opts.onRetry?.({ error: e, failure, attempt: attempt + 1, delayMs });
      await sleep(delayMs, opts.signal);
    }
  }
}

/** Race a promise against a timeout; the timeout rejects with a `timeout` error that classifies as transient. */
export function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })), ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); resolve(v); }, (e) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// Lane scheduler
// ---------------------------------------------------------------------------

export interface SchedulableLane {
  id: string;
  dependsOn?: string[];
  timeoutMs?: number;
}

export interface LaneSlot<R> {
  /** Lane-scoped signal: aborts on run cancellation or on the lane's timeout. */
  signal: AbortSignal;
  /** True once this lane's own timeout fired. */
  timedOut: () => boolean;
  /** Results of the lanes this lane declared as dependencies (those that settled). */
  priors: R[];
  /** How long the lane waited for a slot. */
  queuedMs: number;
}

export interface ScheduleOptions<L extends SchedulableLane, R> {
  concurrency: number;
  signal?: AbortSignal;
  defaultTimeoutMs: number;
  /** Result for a lane that never started because the run was cancelled first. */
  skipped: (lane: L) => R;
  onQueueWait?: (ms: number) => void;
}

/**
 * Run lanes with bounded concurrency, honouring `dependsOn` (a lane starts only once its
 * dependencies have settled and receives their results). Unknown or cyclic dependencies
 * are treated as satisfied so the scheduler can never deadlock. Lanes that have not
 * started when the run signal fires are reported through `skipped`.
 */
export async function scheduleLanes<L extends SchedulableLane, R>(lanes: L[], run: (lane: L, slot: LaneSlot<R>) => Promise<R>, opts: ScheduleOptions<L, R>): Promise<Map<string, R>> {
  const results = new Map<string, R>();
  const pending = [...lanes];
  const running = new Map<string, Promise<void>>();
  const enqueuedAt = Date.now();
  const ids = new Set(lanes.map((l) => l.id));
  /** Lanes whose dependencies were released to break a cycle. */
  const released = new Set<string>();
  const depsOf = (lane: L) => (released.has(lane.id) ? [] : (lane.dependsOn ?? []));
  const ready = (lane: L) => depsOf(lane).every((d) => !ids.has(d) || results.has(d));

  const start = (lane: L) => {
    const link = linkedSignal(opts.signal, lane.timeoutMs ?? opts.defaultTimeoutMs);
    const queuedMs = Date.now() - enqueuedAt;
    if (queuedMs > 0) opts.onQueueWait?.(queuedMs);
    const priors = depsOf(lane).map((d) => results.get(d)).filter((r): r is R => r !== undefined);
    const p = run(lane, { signal: link.signal, timedOut: link.timedOut, priors, queuedMs })
      // Lane runners report failures in their result; a thrown error is reported like a lane that never ran.
      .then((r) => { results.set(lane.id, r); }, () => { results.set(lane.id, opts.skipped(lane)); })
      .finally(() => { link.release(); running.delete(lane.id); });
    running.set(lane.id, p);
  };

  while (pending.length || running.size) {
    if (opts.signal?.aborted) {
      for (const lane of pending.splice(0)) results.set(lane.id, opts.skipped(lane));
    }
    // Start every ready lane while a slot is free.
    let started = false;
    for (let i = 0; i < pending.length && running.size < opts.concurrency; ) {
      const lane = pending[i];
      if (ready(lane)) { pending.splice(i, 1); start(lane); started = true; } else i++;
    }
    if (!running.size) {
      if (!pending.length) break;
      // Nothing running, nothing ready: dependencies are cyclic or point at lanes that never ran. Release the head.
      if (!started) released.add(pending[0].id);
      continue;
    }
    await Promise.race(Array.from(running.values()));
  }
  return results;
}

/**
 * Soft-dependency board: a lane publishes its retrieval results as soon as its first wave settles,
 * and dependent lanes wait for them with a bound instead of waiting for the whole lane (constitution §14
 * dependency-aware scheduling without serialising independent retrieval).
 */
export interface LaneBoard<T> {
  publish(id: string, value: T): void;
  /** Resolves with the published value, or undefined after `timeoutMs` / on abort. Never rejects. */
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<T | undefined>;
  get(id: string): T | undefined;
}

export function createLaneBoard<T>(): LaneBoard<T> {
  const values = new Map<string, T>();
  const waiters = new Map<string, ((v: T) => void)[]>();
  return {
    publish(id, value) {
      values.set(id, value);
      for (const w of waiters.get(id) ?? []) w(value);
      waiters.delete(id);
    },
    get: (id) => values.get(id),
    wait(id, timeoutMs, signal) {
      if (values.has(id)) return Promise.resolve(values.get(id));
      return new Promise<T | undefined>((resolve) => {
        let done = false;
        const finish = (v: T | undefined) => { if (done) return; done = true; clearTimeout(t); signal?.removeEventListener("abort", onAbort); resolve(v); };
        const onAbort = () => finish(undefined);
        const t = setTimeout(() => finish(undefined), Math.max(0, timeoutMs));
        signal?.addEventListener("abort", onAbort, { once: true });
        const list = waiters.get(id) ?? [];
        list.push((v) => finish(v));
        waiters.set(id, list);
      });
    },
  };
}

/** Await a promise for at most `ms` (undefined on timeout, rejection or abort). Never rejects. */
export function settleWithin<T>(p: Promise<T> | undefined, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  if (!p) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | undefined) => { if (done) return; done = true; clearTimeout(t); signal?.removeEventListener("abort", onAbort); resolve(v); };
    const onAbort = () => finish(undefined);
    const t = setTimeout(() => finish(undefined), Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then((v) => finish(v), () => finish(undefined));
  });
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type MetricMark = "acknowledged" | "firstEvidence" | "firstRead" | "firstModelToken" | "firstSourceBacked" | "finalAnswer" | "verifiedAnswer";

/** Records §36 milestones once each (the first time they happen) plus cumulative tool/model time and tokens. */
export class MetricsRecorder {
  private readonly m: RunMetrics;
  constructor(requestedAt: number, private readonly now: () => number = Date.now) {
    this.m = emptyMetrics(requestedAt);
  }
  /** Set a milestone the first time it is reached. Returns true when this call set it. */
  mark(name: MetricMark): boolean {
    const key = `${name}Ms` as const;
    if (this.m[key] != null) return false;
    this.m[key] = Math.max(0, this.now() - this.m.requestedAt);
    return true;
  }
  /** Overwrite a milestone (used when the final answer is re-finalised after a correction). */
  set(name: MetricMark): void {
    const key = `${name}Ms` as const;
    this.m[key] = Math.max(0, this.now() - this.m.requestedAt);
  }
  /** Set a milestone from a wall-clock time captured earlier (e.g. when the last current verification completed). */
  markAt(name: MetricMark, epochMs: number): void {
    const key = `${name}Ms` as const;
    this.m[key] = Math.max(0, epochMs - this.m.requestedAt);
  }
  has(name: MetricMark): boolean {
    return this.m[`${name}Ms` as const] != null;
  }
  addToolTime(ms: number): void { this.m.toolTimeMs += Math.max(0, ms); this.m.toolCalls += 1; }
  addModelTime(ms: number, usage?: TokenUsage | null): void {
    this.m.modelTimeMs += Math.max(0, ms);
    this.m.modelCalls += 1;
    if (usage) { this.m.tokens.input += usage.input; this.m.tokens.output += usage.output; this.m.tokens.total += usage.total; this.m.tokens.reportedCalls += 1; }
  }
  addQueueWait(ms: number): void { this.m.queueWaitMs += Math.max(0, ms); }
  snapshot(): RunMetrics {
    return { ...this.m, tokens: { ...this.m.tokens }, totalMs: Math.max(0, this.now() - this.m.requestedAt) };
  }
}

/** Time an async call and report it to the recorder as model time. */
export async function timedModelCall<T>(metrics: MetricsRecorder, fn: () => Promise<T>, usageOf?: (r: T) => TokenUsage | undefined | null): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    metrics.addModelTime(Date.now() - t0, usageOf?.(r) ?? null);
    return r;
  } catch (e) {
    metrics.addModelTime(Date.now() - t0, null);
    throw e;
  }
}
