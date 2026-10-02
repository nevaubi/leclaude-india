import "server-only";
import { remoteStore, type RemoteStore, type Row } from "@/lib/db/remote";
import { ensureOfficialSchema } from "./schema";
import { OfficialNotConfiguredError } from "./service";

/**
 * Durable work queue for the official-sources pipeline (official_units), the same claim/lease pattern as the judgment
 * corpus backfill (src/modules/india/corpus/backfill.ts): a unit is claimed by ONE single-statement
 * `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` with a lease, so any number of concurrent run invocations
 * (and workers inside one invocation) share the queue without double processing. A unit whose lease expired is
 * claimable again; attempts are bounded; failures back off with `run_after`; a deadline gives the attempt back.
 */

export type UnitStage = "discover" | "fetch" | "extract" | "ocr" | "index" | "parse";
export const UNIT_STAGES: readonly UnitStage[] = ["discover", "fetch", "extract", "ocr", "index", "parse"];
export const LEASE_MINUTES = 6;
export const MAX_ATTEMPTS = 5;
export const DEFAULT_MAX_DB_MB = 60_000;

export interface OfficialUnit {
  id: string;
  source: string;
  stage: UnitStage;
  key: string;
  documentId: string | null;
  payload: Record<string, unknown> | null;
  priority: number;
  status: string;
  attempts: number;
  error: string | null;
}

export interface UnitInput {
  id: string;
  source: string;
  stage: UnitStage;
  key: string;
  documentId?: string | null;
  payload?: Record<string, unknown> | null;
  priority?: number;
  /** ISO timestamp before which the unit is not claimed. */
  runAfter?: string | null;
}

/** The configured Postgres store, or OfficialNotConfiguredError (never a silent empty result). */
export function requireOfficialStore(store?: RemoteStore | null): RemoteStore {
  const s = store === undefined ? remoteStore() : store;
  if (!s) throw new OfficialNotConfiguredError();
  return s;
}

/** Store + schema (idempotent, once per store instance). */
export async function officialStore(store?: RemoteStore | null): Promise<RemoteStore> {
  const s = requireOfficialStore(store);
  await ensureOfficialSchema(s);
  return s;
}

export function unitId(stage: UnitStage, key: string): string {
  return `${stage}:${key}`;
}

function parseJson(v: string | null | undefined): Record<string, unknown> | null {
  if (v == null || v === "") return null;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch { return null; }
}

export function toUnit(r: Row): OfficialUnit {
  return {
    id: String(r.id),
    source: String(r.source),
    stage: String(r.stage) as UnitStage,
    key: String(r.key ?? ""),
    documentId: r.document_id ?? null,
    payload: parseJson(r.payload),
    priority: Number(r.priority ?? 5),
    status: String(r.status ?? "pending"),
    attempts: Number(r.attempts ?? 0),
    error: r.error ?? null,
  };
}

/**
 * Insert units (one statement; existing ids are left alone). With `requeue`, a unit that already finished (done,
 * failed or skipped) is put back to pending with fresh attempts — used for re-discovery and changed documents; a unit
 * that is pending or running is never touched.
 */
export async function enqueueUnits(store: RemoteStore, units: UnitInput[], opts: { requeue?: boolean } = {}): Promise<number> {
  if (!units.length) return 0;
  const rows = units.map((u) => ({ id: u.id, source: u.source, stage: u.stage, key: u.key, document_id: u.documentId ?? null, payload: u.payload ?? null, priority: u.priority ?? 5, run_after: u.runAfter ?? null }));
  const conflict = opts.requeue
    ? `ON CONFLICT (id) DO UPDATE SET status = 'pending', attempts = 0, error = NULL, note = NULL, payload = EXCLUDED.payload, priority = EXCLUDED.priority,
        run_after = EXCLUDED.run_after, lease_until = NULL, started_at = NULL, finished_at = NULL, updated_at = now()
        WHERE official_units.status IN ('done', 'failed', 'skipped')`
    : `ON CONFLICT (id) DO NOTHING`;
  const r = await store.query({
    query: `WITH ins AS (
      INSERT INTO official_units (id, source, stage, key, document_id, payload, priority, run_after)
      SELECT id, source, stage, key, document_id, payload, priority, run_after
      FROM jsonb_to_recordset($1::jsonb) AS x(id text, source text, stage text, key text, document_id text, payload jsonb, priority int, run_after timestamptz)
      ${conflict} RETURNING 1) SELECT count(*)::int AS n FROM ins`,
    params: [JSON.stringify(rows)],
  });
  return Number(r[0]?.n ?? 0);
}

export interface ClaimFilter {
  sources: string[];
  stages: UnitStage[];
}

/** Atomically claim the next unit (priority, id) for these sources/stages; null when nothing is claimable. */
export async function claimUnit(store: RemoteStore, filter: ClaimFilter, leaseMinutes = LEASE_MINUTES): Promise<OfficialUnit | null> {
  if (!filter.sources.length || !filter.stages.length) return null;
  const lease = Math.max(1, Math.min(Math.floor(leaseMinutes), 60));
  const r = await store.query({
    query: `UPDATE official_units SET status = 'running', lease_until = now() + interval '${lease} minutes', attempts = attempts + 1,
      started_at = coalesce(started_at, now()), updated_at = now()
      WHERE id = (
        SELECT id FROM official_units
        WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND attempts < ${MAX_ATTEMPTS}
          AND (run_after IS NULL OR run_after <= now())
          AND source = ANY($1::text[]) AND stage = ANY($2::text[])
        ORDER BY priority, id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    params: [pgArray(filter.sources), pgArray(filter.stages)],
  });
  return r[0] ? toUnit(r[0]) : null;
}

/** Postgres array literal for a text[] parameter (values are quoted; never interpolated into SQL). */
export function pgArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

export async function completeUnit(store: RemoteStore, id: string, note?: string | null): Promise<void> {
  await store.query({ query: `UPDATE official_units SET status = 'done', finished_at = now(), lease_until = NULL, error = NULL, note = $2, updated_at = now() WHERE id = $1`, params: [id, note ?? null] });
}

export async function skipUnit(store: RemoteStore, id: string, note: string): Promise<void> {
  await store.query({ query: `UPDATE official_units SET status = 'skipped', finished_at = now(), lease_until = NULL, note = $2, updated_at = now() WHERE id = $1`, params: [id, note.slice(0, 500)] });
}

/**
 * Record a failure. Permanent failures (and the last attempt) end in `failed`; others go back to `pending` with an
 * exponential backoff (2^attempts minutes, at most 60).
 */
export async function failUnit(store: RemoteStore, unit: Pick<OfficialUnit, "id" | "attempts">, error: string, opts: { permanent?: boolean } = {}): Promise<"failed" | "retry"> {
  const final = opts.permanent || unit.attempts >= MAX_ATTEMPTS;
  const backoff = Math.min(60, 2 ** Math.max(0, unit.attempts));
  await store.query({
    query: `UPDATE official_units SET status = $2, error = $3, lease_until = NULL, run_after = ${final ? "NULL" : `now() + interval '${backoff} minutes'`},
      finished_at = ${final ? "now()" : "NULL"}, updated_at = now() WHERE id = $1`,
    params: [unit.id, final ? "failed" : "pending", error.slice(0, 1000)],
  });
  return final ? "failed" : "retry";
}

/** Put a claimed unit back (deadline reached): the attempt is given back and the payload (progress) may be updated. */
export async function releaseUnit(store: RemoteStore, id: string, payload?: Record<string, unknown> | null, note?: string): Promise<void> {
  if (payload !== undefined) {
    await store.query({ query: `UPDATE official_units SET status = 'pending', lease_until = NULL, attempts = greatest(attempts - 1, 0), payload = $2::jsonb, note = $3, updated_at = now() WHERE id = $1`, params: [id, payload == null ? null : JSON.stringify(payload), note ?? null] });
    return;
  }
  await store.query({ query: `UPDATE official_units SET status = 'pending', lease_until = NULL, attempts = greatest(attempts - 1, 0), note = $2, updated_at = now() WHERE id = $1`, params: [id, note ?? null] });
}

/** Extend the lease of a long-running unit (OCR of a long document). */
export async function extendLease(store: RemoteStore, id: string, leaseMinutes = LEASE_MINUTES): Promise<void> {
  const lease = Math.max(1, Math.min(Math.floor(leaseMinutes), 60));
  await store.query({ query: `UPDATE official_units SET lease_until = now() + interval '${lease} minutes', updated_at = now() WHERE id = $1 AND status = 'running'`, params: [id] });
}

/** Units whose lease expired on their last attempt can never be claimed again: close them as failed (recorded). */
export async function sweepExpiredUnits(store: RemoteStore): Promise<number> {
  const r = await store.query({
    query: `WITH s AS (UPDATE official_units SET status = 'failed', error = coalesce(error, 'lease expired on the last attempt'), lease_until = NULL, finished_at = now(), updated_at = now()
      WHERE status = 'running' AND lease_until < now() AND attempts >= ${MAX_ATTEMPTS} RETURNING 1) SELECT count(*)::int AS n FROM s`,
  });
  return Number(r[0]?.n ?? 0);
}

export async function queueCounts(store: RemoteStore): Promise<{ pending: number; running: number; failed: number; done: number; skipped: number }> {
  const rows = await store.query({ query: `SELECT status, count(*)::int AS n FROM official_units GROUP BY status` });
  const out = { pending: 0, running: 0, failed: 0, done: 0, skipped: 0 };
  for (const r of rows) {
    const k = String(r.status) as keyof typeof out;
    if (k in out) out[k] = Number(r.n ?? 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage budget and state
// ---------------------------------------------------------------------------

/** OFFICIAL_MAX_DB_MB (default 60,000 MB) in bytes. */
export function officialLimitBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const mb = Number(env.OFFICIAL_MAX_DB_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_DB_MB) * 1024 * 1024;
}

export async function dbSize(store: RemoteStore): Promise<number> {
  const r = await store.query({ query: `SELECT pg_database_size(current_database())::bigint AS b` });
  return Number(r[0]?.b ?? 0);
}

export async function getOfficialState<T>(store: RemoteStore, key: string): Promise<T | null> {
  const r = await store.query({ query: `SELECT value FROM corpus_state WHERE key = $1`, params: [key] });
  if (!r[0]?.value) return null;
  try { return JSON.parse(r[0].value) as T; } catch { return null; }
}

export async function setOfficialState(store: RemoteStore, key: string, value: unknown): Promise<void> {
  await store.query({ query: `INSERT INTO corpus_state (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, params: [key, JSON.stringify(value)] });
}
