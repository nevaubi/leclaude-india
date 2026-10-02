import "server-only";
import type { RemoteStore } from "@/lib/db/remote";
import { embeddingModel, queueMissingEmbeddings, type EmbedFn } from "./embed";
import { createOfficialHttp, OfficialDeadlineError, type OfficialHttp, type OfficialHttpOptions } from "./http";
import { defaultOcrModel, ocrConcurrency, ocrMaxPages, OCR_STOP_BEFORE_DEADLINE_MS, type OcrModel } from "./ocr";
import { BytesCache, PRIORITY, processUnit, scrubIndexedDocuments, type StageCounts, type UnitOutcome } from "./pipeline";
import { officialSources, sourceEnabled } from "./registry";
import type { IngestRunReport, SourceDef, SourceId } from "./types";
import { isSourceId } from "./types";
import { CAPTION_SCOPED_SOURCES } from "./causelist/query";
import { claimUnit, dbSize, type ClaimFilter, enqueueUnits, getOfficialState, officialLimitBytes, officialStore, pgArray, releaseUnit, setOfficialState, sweepExpiredUnits, unitId, UNIT_STAGES, type OfficialUnit, type UnitStage } from "./units";
import { backfillCursor, parseCursor } from "./adapters/regulators/common";

/**
 * Bounded ingest runs for the official-sources corpus (one API call / one cron slice). Durable and resumable: all work
 * is in official_units, so a run can stop anywhere (deadline, storage budget) and the next run, or a concurrent one,
 * continues. Several runs may execute at once; each worker claims its own units (FOR UPDATE SKIP LOCKED).
 *
 * Discovery is scheduled per source by its cadence (`cadenceMinutes`), or forced. Stop states:
 *   done      the queue had nothing claimable for the requested sources / stages
 *   deadline  time ran out with work left
 *   budget    the database reached OFFICIAL_MAX_DB_MB (default 60,000 MB)
 *   error     the store failed (the run stops; units keep their leases and are retried later)
 *   disabled  none of the requested sources is enabled
 *
 * Bounded by its deadline: one AbortController per run aborts at the deadline (chained with the caller's signal); it
 * reaches every fetch (each request is also cut 5 s before the deadline), embedding call and OCR request, and a unit
 * interrupted that way is released, not failed (its attempt is given back). OCR units are not started with less than
 * OCR_MIN_MS left, index units not once the run's embedding budget is used (no claim / release busy loop).
 *
 * Fair: about a quarter of the workers (at least one; every fourth claim with a single worker) first try the later
 * stages — index (embeddings), ocr, parse — in rotation, so a long discovery backlog (hundreds of fetch units) cannot
 * starve them; the other workers take the queue in priority order.
 *
 * Before the workers start, bounded housekeeping: re-scrub contact data out of documents indexed before the scrubber
 * (`scrubIndexedDocuments`), queue embeddings for indexed documents that have unembedded chunks, and re-queue OCR for
 * documents left `ocr_needed` above an OCR page cap that has since been raised (OFFICIAL_OCR_MAX_PAGES).
 */

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_DISCOVER_LIMIT = 50;
export const DEFAULT_EMBED_MAX_CHUNKS = 5_000;
/** A unit is not started with less than this left. */
const MIN_UNIT_MS = 30_000;
/** An OCR unit is not started with less than this left (its requests stop OCR_STOP_BEFORE_DEADLINE_MS early). */
export const OCR_MIN_MS = OCR_STOP_BEFORE_DEADLINE_MS + 30_000;
/** Stages the reserved workers try first, in rotation. */
const LATER_STAGES: readonly UnitStage[] = ["index", "ocr", "parse"];
/**
 * Documents re-scrubbed per run (OFFICIAL_SCRUB_BACKFILL_PER_RUN, default 200; cause lists and defect lists first). The
 * backfill also stops after about a fifth of the run's time, so ingestion always keeps most of the run.
 */
export const DEFAULT_SCRUB_PER_RUN = 200;
/** Indexed documents queued for embeddings per run. */
const EMBED_QUEUE_PER_RUN = 200;
/** ocr_needed documents re-queued per run after the OCR cap was raised. */
const OCR_REQUEUE_PER_RUN = 50;
/** Orders parsed before caption scoping, re-parsed per run (from their stored text; no request to the publisher). */
const CAPTION_REPARSE_PER_RUN = 200;
const IDLE_WAIT_MS = 1_500;
/**
 * A run stops waiting for its workers this long after its deadline (CPU-bound work such as a large PDF extraction does
 * not observe the abort signal): units still running are handed back with their attempt and resume in a later run, so
 * the function returns before the platform's limit instead of being killed with leases held.
 */
export const WATCHDOG_GRACE_MS = 20_000;
const BUDGET_CHECK_TTL_MS = 5_000;
/** Stages that send requests to the publisher (bounded per source by OFFICIAL_SOURCE_INFLIGHT). */
export const NETWORK_STAGES: readonly UnitStage[] = ["discover", "fetch"];
/**
 * Network-stage units of one source running at once in a run (OFFICIAL_SOURCE_INFLIGHT, 1–16, default 3): with the
 * per-host request rate (OFFICIAL_HOST_RPS) this keeps workers spread over sources instead of queueing behind one host.
 */
export const DEFAULT_SOURCE_INFLIGHT = 3;

export function sourceInflight(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number(env.OFFICIAL_SOURCE_INFLIGHT);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 16) : DEFAULT_SOURCE_INFLIGHT;
}

export interface OfficialRunOptions {
  sources?: SourceId[];
  stages?: UnitStage[];
  /** Workers (1–16, default 4). */
  concurrency?: number;
  deadlineMs: number;
  /** Items per discovery call and document units per source in this run. */
  limitPerSource?: number;
  /** Run discovery now even when the source's cadence has not elapsed. */
  forceDiscover?: boolean;
  /** Re-queue failed discover/fetch/ocr/index/parse units of the requested sources (not "not published" 404/410 failures). */
  retryFailed?: boolean;
  /** Bounded automatic redrive (scheduled runs): failed units older than the cooldown, at most `maxRedrives` times each. */
  redrive?: RedriveOptions;
  /** Grace after the deadline before units still running are handed back (default WATCHDOG_GRACE_MS). */
  watchdogGraceMs?: number;
  /** Backfill passes to start (default: OFFICIAL_BACKFILL / OFFICIAL_BACKFILL_GENERATION). */
  backfill?: BackfillRequest | null;
  store?: RemoteStore | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  // ---- injectable dependencies (tests) ----
  http?: (def: SourceDef) => OfficialHttp;
  httpOptions?: OfficialHttpOptions;
  ocrModel?: OcrModel;
  embed?: EmbedFn;
  /** Embedding model id; null disables embeddings for this run. Defaults to the configured embedding role. */
  embedModel?: string | null;
  maxOcrPages?: number;
  embedMaxChunks?: number;
  limitBytes?: number;
  log?: (line: Record<string, unknown>) => void;
  /** Tests: minimum time left to start a unit (default 30 s). */
  minUnitMs?: number;
  /** Documents re-scrubbed by the contact-data backfill this run (default OFFICIAL_SCRUB_BACKFILL_PER_RUN or 200; 0 = off). */
  scrubPerRun?: number;
}

export interface OfficialRunResult {
  stop: IngestRunReport["stop"];
  /** One report per requested source plus the total (sourceId "all"). */
  reports: IngestRunReport[];
  total: IngestRunReport;
  units: number;
  dbBytes: number | null;
  limitBytes: number;
  notes: string[];
  error?: string;
}

/** Deployment switch for the scheduled runner (the cron tick): OFFICIAL_INGEST=1. */
export function officialIngestEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return ["1", "true", "yes"].includes((env.OFFICIAL_INGEST ?? "").trim().toLowerCase());
}

function envInt(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.min(Math.floor(n), max) : fallback;
}

function emptyReport(sourceId: IngestRunReport["sourceId"], stage: IngestRunReport["stage"]): IngestRunReport {
  return { sourceId, stage, discovered: 0, fetched: 0, extracted: 0, ocr: 0, indexed: 0, failed: 0, skipped: 0, stop: "done", errors: [], durationMs: 0 };
}

function reportStage(stages: UnitStage[]): IngestRunReport["stage"] {
  if (stages.length === UNIT_STAGES.length) return "all";
  if (stages.length === 1 && (stages[0] === "discover" || stages[0] === "fetch" || stages[0] === "extract" || stages[0] === "index")) return stages[0];
  return "all";
}

/** Queue (or re-queue when the cadence elapsed / forced) one discovery unit per source. */
export async function scheduleDiscovery(store: RemoteStore, defs: SourceDef[], force = false): Promise<number> {
  if (!defs.length) return 0;
  const rows = defs.map((d) => ({ id: `discover:${d.id}`, source: d.id, stage: "discover", key: d.id, priority: PRIORITY.discover, payload: { cadenceMinutes: Math.max(1, Math.floor(d.cadenceMinutes || 60)), force } }));
  const r = await store.query({
    query: `WITH ins AS (
      INSERT INTO official_units (id, source, stage, key, priority, payload)
      SELECT id, source, stage, key, priority, payload FROM jsonb_to_recordset($1::jsonb) AS x(id text, source text, stage text, key text, priority int, payload jsonb)
      ON CONFLICT (id) DO UPDATE SET status = 'pending', attempts = 0, error = NULL, note = NULL, lease_until = NULL, run_after = NULL, started_at = NULL, finished_at = NULL,
        payload = EXCLUDED.payload, updated_at = now()
      WHERE official_units.status IN ('done', 'failed', 'skipped')
        AND ((EXCLUDED.payload->>'force')::boolean
          OR official_units.finished_at IS NULL
          OR official_units.finished_at < now() - ((EXCLUDED.payload->>'cadenceMinutes')::int * interval '1 minute'))
      RETURNING 1) SELECT count(*)::int AS n FROM ins`,
    params: [JSON.stringify(rows)],
  });
  return Number(r[0]?.n ?? 0);
}

function addCounts(rep: IngestRunReport, c: Partial<StageCounts>) {
  for (const k of ["discovered", "fetched", "extracted", "ocr", "indexed", "failed", "skipped"] as const) rep[k] += c[k] ?? 0;
}

/** Run the pipeline until the queue is empty, the deadline, or the storage budget (see module notes). */
export async function runOfficialIngest(o: OfficialRunOptions): Promise<OfficialRunResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const deadline = started + Math.max(1_000, o.deadlineMs);
  const stages: UnitStage[] = o.stages?.length ? [...new Set(o.stages)].filter((s) => (UNIT_STAGES as readonly string[]).includes(s)) : [...UNIT_STAGES];
  const stage = reportStage(stages);
  const limitBytes = o.limitBytes ?? officialLimitBytes();
  const log = o.log ?? ((line: Record<string, unknown>) => console.info(JSON.stringify(line)));
  const requested: SourceId[] = o.sources?.length ? [...new Set(o.sources)].filter(isSourceId) : officialSources().map((d) => d.id);
  const defs = officialSources().filter((d) => requested.includes(d.id));
  const enabled = defs.filter((d) => sourceEnabled(d.id));
  const reports = new Map<SourceId, IngestRunReport>(requested.map((id) => [id, emptyReport(id, stage)]));
  const total = emptyReport("all", stage);
  const result: OfficialRunResult = { stop: "done", reports: [], total, units: 0, dbBytes: null, limitBytes, notes: [] };
  const finish = (stop: IngestRunReport["stop"]): OfficialRunResult => {
    result.stop = stop;
    const durationMs = now() - started;
    for (const r of reports.values()) {
      r.stop = sourceEnabled(r.sourceId as SourceId) ? stop : "disabled";
      r.durationMs = durationMs;
      for (const k of ["discovered", "fetched", "extracted", "ocr", "indexed", "failed", "skipped"] as const) total[k] += r[k];
      total.errors.push(...r.errors);
    }
    total.errors = total.errors.slice(0, 50);
    total.stop = stop;
    total.durationMs = durationMs;
    result.reports = [...reports.values()];
    log({ level: stop === "error" ? "error" : "info", event: "official.run", stop, durationMs, units: result.units, sources: enabled.map((d) => d.id), stages, discovered: total.discovered, fetched: total.fetched, extracted: total.extracted, ocr: total.ocr, indexed: total.indexed, failed: total.failed, skipped: total.skipped, dbBytes: result.dbBytes, limitBytes, ...(result.error ? { error: result.error } : {}) });
    return result;
  };

  const store = await officialStore(o.store); // OfficialNotConfiguredError propagates (503 at the route)
  if (!enabled.length) { result.notes.push("none of the requested sources is enabled"); return finish("disabled"); }

  // One abort for the whole run: at the deadline, or when the caller aborts.
  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort(o.signal?.reason);
  if (o.signal?.aborted) ctrl.abort(o.signal.reason);
  else o.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new OfficialDeadlineError()), Math.max(0, deadline - now()));
  (timer as { unref?: () => void }).unref?.();
  try {
    return await runWorkers();
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onCallerAbort);
  }

  async function runWorkers(): Promise<OfficialRunResult> {
    const signal = ctrl.signal;
    const embedModel = o.embedModel === undefined ? embeddingModel() : o.embedModel;
    const maxOcrPages = o.maxOcrPages ?? ocrMaxPages();
    const sourceIds = enabled.map((d) => d.id);
    try {
      await sweepExpiredUnits(store);
      if (o.retryFailed || o.redrive) {
        const n = await retryFailedUnits(store, sourceIds, o.retryFailed ? undefined : o.redrive);
        if (n) result.notes.push(`${n} failed unit(s) re-queued`);
      }
      if (stages.includes("discover")) {
        const started = await startBackfills(store, enabled, o.backfill ?? backfillRequest());
        if (started.length) {
          await scheduleDiscovery(store, started, true);
          result.notes.push(`backfill started: ${started.map((d) => d.id).join(", ")}`);
        }
        const queued = await scheduleDiscovery(store, enabled, o.forceDiscover === true);
        if (queued) result.notes.push(`${queued} discovery unit(s) scheduled`);
      }
    } catch (e) {
      result.error = (e as Error).message.slice(0, 500);
      return finish("error");
    }
    // Housekeeping (bounded; a failure is noted and never stops ingestion).
    const scrubLimit = o.scrubPerRun ?? envInt(process.env.OFFICIAL_SCRUB_BACKFILL_PER_RUN, DEFAULT_SCRUB_PER_RUN, 0, 500);
    if (scrubLimit > 0) {
      try {
        const s = await scrubIndexedDocuments(store, { limit: scrubLimit, deadline: Math.min(deadline - MIN_UNIT_MS, now() + Math.max(5_000, Math.floor((deadline - now()) / 5))), now, embedModel, signal });
        if (s.documents || s.purged || s.payloads) {
          result.notes.push(`contact-data scrub: ${s.documents} document(s) checked, ${s.changed} rewritten (${s.chunks} chunk(s); ${s.redacted.phones} phone(s), ${s.redacted.emails} e-mail(s), ${s.redacted.links} link(s) removed)${s.purged ? `, ${s.purged} stale document(s) purged` : ""}${s.payloads ? `, ${s.payloads} unit payload(s) cleared` : ""}`);
          log({ level: "info", event: "official.scrub_backfill", documents: s.documents, changed: s.changed, chunks: s.chunks, purged: s.purged, payloads: s.payloads, phones: s.redacted.phones, emails: s.redacted.emails, links: s.redacted.links });
        }
      } catch (e) {
        result.notes.push(`contact-data scrub skipped: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    if (embedModel && stages.includes("index")) {
      try {
        const n = await queueMissingEmbeddings(store, sourceIds, EMBED_QUEUE_PER_RUN, PRIORITY.index);
        if (n) result.notes.push(`${n} document(s) queued for embeddings`);
      } catch (e) {
        result.notes.push(`embedding queue skipped: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    if (stages.includes("parse")) {
      try {
        const n = await requeueCaptionReparse(store, sourceIds, CAPTION_REPARSE_PER_RUN);
        if (n) result.notes.push(`${n} order(s) parsed before caption scoping re-queued for parsing`);
      } catch (e) {
        result.notes.push(`caption re-parse skipped: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    if (stages.includes("ocr")) {
      try {
        const n = await requeueCappedOcr(store, sourceIds, maxOcrPages, OCR_REQUEUE_PER_RUN);
        if (n) result.notes.push(`${n} document(s) above the previous OCR cap re-queued for OCR (cap ${maxOcrPages})`);
      } catch (e) {
        result.notes.push(`OCR re-queue skipped: ${(e as Error).message.slice(0, 200)}`);
      }
    }

    // Budget check (shared by workers, at most every few seconds).
    let budgetAt = 0;
    let budgetPromise: Promise<number> | null = null;
    const overBudget = async (): Promise<boolean> => {
      if (!budgetPromise || now() - budgetAt > BUDGET_CHECK_TTL_MS) { budgetAt = now(); budgetPromise = dbSize(store); }
      const size = await budgetPromise;
      result.dbBytes = size;
      return size >= limitBytes;
    };

    const perSourceUnits = new Map<string, number>();
    const unitCap = o.limitPerSource && o.limitPerSource > 0 ? Math.floor(o.limitPerSource) : null;
    const httpBySource = new Map<SourceId, OfficialHttp>();
    let ocrModelCache: OcrModel | null = o.ocrModel ?? null;
    const minUnitMs = Math.max(0, o.minUnitMs ?? MIN_UNIT_MS);
    const deps = {
      store,
      now,
      deadline,
      http: (def: SourceDef) => {
        let h = httpBySource.get(def.id);
        if (!h) { h = o.http ? o.http(def) : createOfficialHttp(def, { ...(o.httpOptions ?? {}), signal, deadline, now }); httpBySource.set(def.id, h); }
        return h;
      },
      ocrModel: () => (ocrModelCache ??= defaultOcrModel()),
      embed: o.embed,
      embedModel,
      embedBudget: { left: o.embedMaxChunks ?? envInt(process.env.OFFICIAL_EMBED_MAX_CHUNKS_PER_RUN, DEFAULT_EMBED_MAX_CHUNKS, 0, 1_000_000) },
      discoverLimit: Math.max(1, Math.min(unitCap ?? DEFAULT_DISCOVER_LIMIT, 500)),
      maxOcrPages,
      ocrConcurrency: ocrConcurrency(),
      bytes: new BytesCache(),
      signal,
      log: (event: string, data: Record<string, unknown>) => log({ level: "info", event, ...data }),
    };

    const concurrency = Math.max(1, Math.min(Math.floor(o.concurrency ?? DEFAULT_CONCURRENCY), 16));
    const reserved = concurrency >= 2 ? Math.max(1, Math.floor(concurrency / 4)) : 0;
    let active = 0;
    let claims = 0;
    let laneTurn = 0;
    let laneIdleUntil = 0;
    // Shared by the workers (an object, so control-flow narrowing does not assume it stays null).
    const run: { stop: IngestRunReport["stop"] | null } = { stop: null };

    const claimable = (): string[] => enabled.map((d) => d.id).filter((id) => unitCap == null || (perSourceUnits.get(id) ?? 0) < unitCap);
    /** Stages a worker may claim now: no OCR without enough time left, no index once the embedding budget is used. */
    const stagesNow = (): UnitStage[] => stages.filter((s) => (s !== "ocr" || deadline - now() >= OCR_MIN_MS) && (s !== "index" || deps.embedBudget.left > 0));

    const inflightCap = sourceInflight();
    const netInFlight = new Map<string, number>();
    /** Units being processed now (handed back by the watchdog if the run has to return without them). */
    const inflight = new Map<string, OfficialUnit>();
    /** Network stages of sources already at their in-flight cap are not claimed now (their other stages are). */
    const hold = (): ClaimFilter["hold"] => {
      const busy = [...netInFlight.entries()].filter(([, n]) => n >= inflightCap).map(([s]) => s);
      return busy.length ? { sources: busy, stages: [...NETWORK_STAGES] } : undefined;
    };

    async function claimNext(w: number, sources: string[], allowed: UnitStage[]): Promise<OfficialUnit | null> {
      const lane = LATER_STAGES.filter((s) => allowed.includes(s));
      const prefer = lane.length > 0 && lane.length < allowed.length && now() >= laneIdleUntil && (w < reserved || (concurrency === 1 && claims % 4 === 3));
      claims++;
      if (prefer) {
        const turn = laneTurn++;
        for (let i = 0; i < lane.length; i++) {
          const u = await claimUnit(store, { sources, stages: [lane[(turn + i) % lane.length]] });
          if (u) return u;
        }
        laneIdleUntil = now() + 5_000; // nothing in the later stages: do not ask again for a few seconds
      }
      return claimUnit(store, { sources, stages: allowed, hold: hold() });
    }

    const worker = async (w: number) => {
      try {
        await work(w);
      } catch (e) {
        // A store failure: stop every worker; claimed units keep their lease and are retried by a later run.
        result.error ??= (e as Error).message.slice(0, 500);
        run.stop = "error";
      }
    };

    const work = async (w: number) => {
      for (;;) {
        if (run.stop) return;
        if (signal.aborted) { run.stop = "deadline"; return; }
        if (now() > deadline - minUnitMs) { run.stop ??= "deadline"; return; }
        if (await overBudget()) { run.stop = "budget"; return; }
        const sources = claimable();
        const allowed = stagesNow();
        const unit = sources.length && allowed.length ? await claimNext(w, sources, allowed) : null;
        if (!unit) {
          if (active > 0 && sources.length) { await sleep(IDLE_WAIT_MS); continue; } // another worker may enqueue more
          return;
        }
        active++;
        inflight.set(unit.id, unit);
        const net = NETWORK_STAGES.includes(unit.stage);
        if (net) netInFlight.set(unit.source, (netInFlight.get(unit.source) ?? 0) + 1);
        let out: UnitOutcome;
        try {
          out = await processUnit(unit, deps);
        } finally {
          active--;
          inflight.delete(unit.id);
          if (net) netInFlight.set(unit.source, Math.max(0, (netInFlight.get(unit.source) ?? 1) - 1));
        }
        result.units++;
        if (unit.stage !== "discover" && unit.stage !== "index" && unit.stage !== "parse") perSourceUnits.set(unit.source, (perSourceUnits.get(unit.source) ?? 0) + 1);
        const rep = reports.get(unit.source as SourceId);
        if (rep) {
          addCounts(rep, out.counts);
          if (out.error && rep.errors.length < 50) rep.errors.push(out.error);
        }
      }
    };

    const workers = Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const grace = Math.max(0, o.watchdogGraceMs ?? WATCHDOG_GRACE_MS);
    const late = await Promise.race([
      workers.then(() => false),
      new Promise<boolean>((resolve) => { watchdog = setTimeout(() => resolve(true), Math.max(0, deadline + grace - now())); }),
    ]);
    clearTimeout(watchdog);
    if (late) {
      run.stop ??= "deadline";
      const held = [...inflight.values()];
      for (const u of held) await releaseUnit(store, u.id, undefined, "run ended before this unit finished; resumes in a later run").catch(() => undefined);
      if (held.length) result.notes.push(`${held.length} unit(s) still running ${Math.round(grace / 1000)} s after the deadline were handed back (${[...new Set(held.map((u) => u.stage))].join(", ")})`);
    }
    if (run.stop === "error") return finish("error");
    if (run.stop === "budget") {
      result.notes.push(`database size ${result.dbBytes ?? "?"} bytes reached the budget of ${limitBytes} bytes (OFFICIAL_MAX_DB_MB)`);
      return finish("budget");
    }
    if (run.stop === "deadline") {
      // Deadline with nothing left to claim is still "done".
      const pending = await store.query({
        query: `SELECT count(*)::int AS n FROM official_units WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND (run_after IS NULL OR run_after <= now()) AND source = ANY($1::text[]) AND stage = ANY($2::text[])`,
        params: [pgArray(enabled.map((d) => d.id)), pgArray(stages)],
      }).catch(() => [{ n: "1" }]);
      return finish(Number(pending[0]?.n ?? 1) > 0 ? "deadline" : "done");
    }
    if (unitCap != null && !claimable().length) result.notes.push(`limitPerSource (${unitCap}) reached for every source`);
    return finish("done");
  }
}

/**
 * Indexed orders of caption-scoped sources (NCLAT, SEBI incl. SAT) parsed before captions were told apart from cited
 * appeal numbers (no meta.caseKeysScope): their parse unit is re-queued once (payload.reparse), so the current parser
 * replaces the stored keys. Until then orderBindingKeys binds only the caption's number. Bounded and idempotent: a
 * document whose re-parse was already queued is not selected again, whatever its outcome.
 */
export async function requeueCaptionReparse(store: RemoteStore, sources: string[], limit: number): Promise<number> {
  const scoped = sources.filter((s) => (CAPTION_SCOPED_SOURCES as readonly string[]).includes(s));
  if (!scoped.length || limit <= 0) return 0;
  const rows = await store.query({
    query: `SELECT d.id, d.source, d.url FROM official_documents d
      WHERE d.status = 'indexed' AND d.source = ANY($1::text[]) AND d.kind IN ('order', 'judgment') AND (d.meta->>'caseKeysScope') IS NULL
        AND NOT EXISTS (SELECT 1 FROM official_units u WHERE u.id = 'parse:' || d.id AND u.payload->>'reparse' = 'caption-scope')
      ORDER BY d.id LIMIT ${Math.max(1, Math.min(Math.floor(limit), 500))}`,
    params: [pgArray(scoped)],
  });
  if (!rows.length) return 0;
  await enqueueUnits(store, rows.map((r) => ({ id: unitId("parse", String(r.id)), source: String(r.source), stage: "parse" as const, key: String(r.url), documentId: String(r.id), priority: PRIORITY.parse, payload: { reparse: "caption-scope" } })), { requeue: true });
  return rows.length;
}

/**
 * Documents left `ocr_needed` because their scanned pages exceeded the OCR cap ("N page(s) … above the OCR cap") whose
 * N is now within `cap`: their OCR unit is (re-)queued to re-target the current version (bounded, idempotent — the
 * document's note changes so it is not selected again).
 */
export async function requeueCappedOcr(store: RemoteStore, sources: string[], cap: number, limit: number): Promise<number> {
  if (!sources.length || limit <= 0) return 0;
  const rows = await store.query({
    query: `SELECT id, source, url, error FROM official_documents
      WHERE status = 'ocr_needed' AND error LIKE '%above the OCR cap%' AND source = ANY($1::text[])
        AND coalesce(substring(error from '^([0-9]+) page')::int, 2147483647) <= $2
      ORDER BY id LIMIT ${Math.max(1, Math.min(Math.floor(limit), 500))}`,
    params: [pgArray(sources), Math.floor(cap)],
  });
  if (!rows.length) return 0;
  await enqueueUnits(store, rows.map((r) => ({ id: unitId("ocr", String(r.id)), source: String(r.source), stage: "ocr" as const, key: String(r.url), documentId: String(r.id), priority: PRIORITY.ocr, payload: { sha256: null, requeuedForCap: cap } })), { requeue: true });
  for (const r of rows) {
    const n = /^(\d+) page/.exec(String(r.error ?? ""))?.[1] ?? "?";
    await store.query({ query: `UPDATE official_documents SET error = $2, updated_at = now() WHERE id = $1 AND status = 'ocr_needed'`, params: [String(r.id), `${n} page(s) queued for OCR (OFFICIAL_OCR_MAX_PAGES raised to ${Math.floor(cap)})`] });
  }
  return rows.length;
}

/**
 * Full-history backfill for the sources whose discovery walks listing pages (regulators, gazette, Parliament). Their
 * default pass is incremental (newest pages until the previous pass's newest item); a backfill pass walks every page to
 * the oldest and then switches back to incremental by itself. A request names the sources and a generation: each
 * source starts once per generation (recorded in corpus_state), so a finished backfill never restarts on its own.
 */
export interface BackfillRequest {
  generation: string;
  sources: string[];
}

/** Sources whose cursor is the walker's (./adapters/regulators/common.ts); court adapters keep their own cursors. */
export const BACKFILL_SOURCES: readonly SourceId[] = ["ibbi", "sebi-orders", "cci-orders", "sansad", "egazette", "cbic", "gst-council", "cbdt", "rbi", "aptel"];

export function backfillRequest(env: Readonly<Record<string, string | undefined>> = process.env): BackfillRequest | null {
  const sources = (env.OFFICIAL_BACKFILL ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!sources.length) return null;
  const generation = (env.OFFICIAL_BACKFILL_GENERATION ?? "1").trim().slice(0, 40) || "1";
  return { generation, sources };
}

/** Seed a backfill cursor for each requested, enabled walker source not yet started in this generation. */
export async function startBackfills(store: RemoteStore, enabled: SourceDef[], req: BackfillRequest | null): Promise<SourceDef[]> {
  if (!req) return [];
  const wanted = new Set(req.sources);
  const out: SourceDef[] = [];
  for (const def of enabled) {
    if (!wanted.has(def.id) || !BACKFILL_SOURCES.includes(def.id)) continue;
    const markerKey = `official_backfill:${def.id}`;
    const marker = await getOfficialState<{ generation?: string }>(store, markerKey);
    if (marker?.generation === req.generation) continue;
    const cursorKey = `official_cursor:${def.id}`;
    const current = parseCursor(await getOfficialState<string>(store, cursorKey));
    if (current?.mode !== "backfill") await setOfficialState(store, cursorKey, backfillCursor({ lastSeen: current?.lastSeen ?? {} }));
    await setOfficialState(store, markerKey, { generation: req.generation, startedAt: new Date().toISOString() });
    out.push(def);
  }
  return out;
}

export interface RedriveOptions {
  /** Only units that failed at least this long ago. */
  cooldownMinutes: number;
  /** Only units redriven fewer times than this (counted in payload.redrives). */
  maxRedrives: number;
}

/**
 * Re-queue failed units (and reset their documents) for a fresh attempt, e.g. after a deployment fixed the cause.
 * Units whose document the publisher answered "not published" (404/410) stay failed: that is a fact, not an error.
 * Without `redrive` this is the operator's unconditional retry; with it, only failures older than the cooldown and
 * redriven fewer than `maxRedrives` times are re-queued, and the count is recorded so a persistent failure ends failed.
 */
export async function retryFailedUnits(store: RemoteStore, sources: string[], redrive?: RedriveOptions): Promise<number> {
  if (!sources.length) return 0;
  const cooldown = redrive ? Math.max(1, Math.min(Math.floor(redrive.cooldownMinutes), 10_080)) : 0;
  const cap = redrive ? Math.max(1, Math.min(Math.floor(redrive.maxRedrives), 20)) : 0;
  const bounded = redrive
    ? `AND finished_at < now() - interval '${cooldown} minutes' AND coalesce((payload->>'redrives')::int, 0) < ${cap}`
    : "";
  const counter = redrive ? `, payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('redrives', coalesce((payload->>'redrives')::int, 0) + 1)` : "";
  const r = await store.query({
    query: `WITH u AS (
        UPDATE official_units SET status = 'pending', attempts = 0, error = NULL, run_after = NULL, lease_until = NULL, finished_at = NULL, updated_at = now()${counter}
        WHERE status = 'failed' AND stage IN ('discover', 'fetch', 'ocr', 'index', 'parse') AND source = ANY($1::text[]) ${bounded}
          AND NOT EXISTS (SELECT 1 FROM official_documents d WHERE d.id = official_units.document_id AND d.error LIKE 'not published%')
        RETURNING document_id),
      d AS (UPDATE official_documents SET status = 'discovered', error = NULL, updated_at = now()
        WHERE id IN (SELECT document_id FROM u WHERE document_id IS NOT NULL) AND status = 'failed' RETURNING 1)
      SELECT (SELECT count(*) FROM u)::int AS n, (SELECT count(*) FROM d)::int AS docs`,
    params: [pgArray(sources)],
  });
  return Number(r[0]?.n ?? 0);
}
