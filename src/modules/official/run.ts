import "server-only";
import type { RemoteStore } from "@/lib/db/remote";
import { embeddingModel, type EmbedFn } from "./embed";
import { createOfficialHttp, type OfficialHttp, type OfficialHttpOptions } from "./http";
import { defaultOcrModel, ocrConcurrency, ocrMaxPages, type OcrModel } from "./ocr";
import { BytesCache, PRIORITY, processUnit, type StageCounts, type UnitOutcome } from "./pipeline";
import { officialSources, sourceEnabled } from "./registry";
import type { IngestRunReport, SourceDef, SourceId } from "./types";
import { isSourceId } from "./types";
import { claimUnit, dbSize, officialLimitBytes, officialStore, pgArray, sweepExpiredUnits, UNIT_STAGES, type UnitStage } from "./units";

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
 */

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_DISCOVER_LIMIT = 50;
export const DEFAULT_EMBED_MAX_CHUNKS = 5_000;
/** A unit is not started with less than this left. */
const MIN_UNIT_MS = 30_000;
const IDLE_WAIT_MS = 1_500;
const BUDGET_CHECK_TTL_MS = 5_000;

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

  try {
    await sweepExpiredUnits(store);
    if (stages.includes("discover")) {
      const queued = await scheduleDiscovery(store, enabled, o.forceDiscover === true);
      if (queued) result.notes.push(`${queued} discovery unit(s) scheduled`);
    }
  } catch (e) {
    result.error = (e as Error).message.slice(0, 500);
    return finish("error");
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
  const embedModel = o.embedModel === undefined ? embeddingModel() : o.embedModel;
  const deps = {
    store,
    now,
    deadline,
    http: (def: SourceDef) => {
      let h = httpBySource.get(def.id);
      if (!h) { h = o.http ? o.http(def) : createOfficialHttp(def, { ...(o.httpOptions ?? {}), signal: o.signal }); httpBySource.set(def.id, h); }
      return h;
    },
    ocrModel: () => (ocrModelCache ??= defaultOcrModel()),
    embed: o.embed,
    embedModel,
    embedBudget: { left: o.embedMaxChunks ?? envInt(process.env.OFFICIAL_EMBED_MAX_CHUNKS_PER_RUN, DEFAULT_EMBED_MAX_CHUNKS, 0, 1_000_000) },
    discoverLimit: Math.max(1, Math.min(unitCap ?? DEFAULT_DISCOVER_LIMIT, 500)),
    maxOcrPages: o.maxOcrPages ?? ocrMaxPages(),
    ocrConcurrency: ocrConcurrency(),
    bytes: new BytesCache(),
    signal: o.signal,
    log: (event: string, data: Record<string, unknown>) => log({ level: "info", event, ...data }),
  };

  const concurrency = Math.max(1, Math.min(Math.floor(o.concurrency ?? DEFAULT_CONCURRENCY), 16));
  let active = 0;
  // Shared by the workers (an object, so control-flow narrowing does not assume it stays null).
  const run: { stop: IngestRunReport["stop"] | null } = { stop: null };

  const claimable = (): string[] => enabled.map((d) => d.id).filter((id) => unitCap == null || (perSourceUnits.get(id) ?? 0) < unitCap);

  const worker = async () => {
    try {
      await work();
    } catch (e) {
      // A store failure: stop every worker; claimed units keep their lease and are retried by a later run.
      result.error ??= (e as Error).message.slice(0, 500);
      run.stop = "error";
    }
  };

  const work = async () => {
    for (;;) {
      if (run.stop) return;
      if (o.signal?.aborted) { run.stop = "deadline"; return; }
      if (now() > deadline - MIN_UNIT_MS) { run.stop ??= "deadline"; return; }
      if (await overBudget()) { run.stop = "budget"; return; }
      const sources = claimable();
      const unit = sources.length ? await claimUnit(store, { sources, stages }) : null;
      if (!unit) {
        if (active > 0 && sources.length) { await sleep(IDLE_WAIT_MS); continue; } // another worker may enqueue more
        return;
      }
      active++;
      let out: UnitOutcome;
      try {
        out = await processUnit(unit, deps);
      } finally {
        active--;
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

  await Promise.all(Array.from({ length: concurrency }, worker));
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
