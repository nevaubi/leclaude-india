import "server-only";
import { remoteStore, type RemoteStore, type Row, type SqlQuery } from "@/lib/db/remote";
import { createOpenDataBucket, HC_BUCKET_URL, SCI_BUCKET_URL, type OpenDataBucket } from "../sources/s3";
import { CORPUS_SCHEMA, CORPUS_SCHEMA_VERSION } from "./schema";
import { readTar } from "./tar";
import { rowFromEntry, upsertSql, type CorpusRow, type CorpusUnitRef } from "./rows";

/**
 * Backfill of the Indian judgment corpus from the public open-data sets (Supreme Court of India; all 25 High Courts),
 * into Postgres. Durable and resumable: every source archive is a unit with a lease, a cursor and exact counts, so an
 * invocation can stop at any point (serverless time limit, storage budget) and the next one continues.
 *
 * Order: Supreme Court (newest year first), then Karnataka, Telangana and Andhra Pradesh (newest first), then the other
 * High Courts. Completeness is checked per archive against the dataset's own index (every declared record is stored or
 * recorded in corpus_rejects with the reason).
 */

export const FOCUS_HC_CODES = ["29_3", "36_29", "28_2"];
const BATCH = 400;
const LEASE_MINUTES = 7;
const MAX_ATTEMPTS = 5;
const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DB_MB = 450;

export type BackfillStop = "deadline" | "queue_empty" | "storage_budget" | "disabled" | "not_configured" | "error";

export interface BackfillResult {
  stop: BackfillStop;
  units: { id: string; status: string; stored: number; rejected: number; expected: number | null; note?: string }[];
  dbBytes?: number;
  limitBytes: number;
  error?: string;
}

export interface BackfillDeps {
  store?: RemoteStore | null;
  sci?: OpenDataBucket;
  hc?: OpenDataBucket;
  now?: () => number;
}

export class CorpusNotConfigured extends Error {}

function buckets(deps: BackfillDeps) {
  return {
    sci: deps.sci ?? createOpenDataBucket("sci-open-data", SCI_BUCKET_URL, { timeoutMs: 120_000 }),
    hc: deps.hc ?? createOpenDataBucket("hc-open-data", HC_BUCKET_URL, { timeoutMs: 120_000 }),
  };
}

export function limitBytes(): number {
  const mb = Number(process.env.CORPUS_MAX_DB_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_DB_MB) * 1024 * 1024;
}

function requireStore(deps: BackfillDeps): RemoteStore {
  const s = deps.store === undefined ? remoteStore() : deps.store;
  if (!s) throw new CorpusNotConfigured("DATABASE_URL is not set: the corpus lives in Postgres (Neon).");
  return s;
}

let schemaReady = false;
export async function ensureCorpusSchema(store: RemoteStore): Promise<void> {
  if (schemaReady) return;
  const rows = await store.query({ query: `SELECT to_regclass('public.corpus_state') AS t` });
  let version = 0;
  if (rows[0]?.t) {
    const v = await store.query({ query: `SELECT value FROM corpus_state WHERE key = 'schema_version'` });
    version = v[0]?.value ? Number(JSON.parse(v[0].value)) : 0;
  }
  if (version < CORPUS_SCHEMA_VERSION) {
    for (const q of CORPUS_SCHEMA) await store.query(q);
    await setState(store, "schema_version", CORPUS_SCHEMA_VERSION);
  }
  schemaReady = true;
}

export function resetCorpusSchemaCacheForTests() { schemaReady = false; }

export async function getState<T>(store: RemoteStore, key: string): Promise<T | null> {
  const r = await store.query({ query: `SELECT value FROM corpus_state WHERE key = $1`, params: [key] });
  return r[0]?.value ? (JSON.parse(r[0].value) as T) : null;
}

export async function setState(store: RemoteStore, key: string, value: unknown): Promise<void> {
  await store.query({ query: `INSERT INTO corpus_state (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, params: [key, JSON.stringify(value)] });
}

// ---------------------------------------------------------------------------
// Priorities and unit ids
// ---------------------------------------------------------------------------

const yearRank = (year: number) => Math.max(0, 3000 - year);

export function unitPriority(u: { kind: "discover" | "archive"; source: "sci-open-data" | "hc-open-data"; year: number; courtCode?: string | null }): number {
  if (u.source === "sci-open-data") return u.kind === "discover" ? 0 : 100_000 + yearRank(u.year);
  const focus = u.courtCode ? FOCUS_HC_CODES.indexOf(u.courtCode) : -1;
  // A year's discovery runs just before that year's focus-court archives; the other High Courts follow all focus years.
  if (u.kind === "discover") return 200_000 + yearRank(u.year) * 10;
  if (focus >= 0) return 200_000 + yearRank(u.year) * 10 + 1 + focus;
  return 300_000 + yearRank(u.year) * 100 + 50;
}

const archiveUnitId = (source: string, folder: string, name: string) => `${source === "sci-open-data" ? "sc" : "hc"}:${folder}${name}`;

function partsOf(prefix: string): { year?: number; court?: string; bench?: string } {
  const y = /year=(\d{4})/.exec(prefix)?.[1];
  return { year: y ? Number(y) : undefined, court: /court=([^/]+)/.exec(prefix)?.[1], bench: /bench=([^/]+)/.exec(prefix)?.[1] };
}

async function insertUnits(store: RemoteStore, units: { id: string; source: string; year: number; court_code: string | null; bench_code: string | null; folder: string; object_key: string; priority: number }[]): Promise<number> {
  if (!units.length) return 0;
  const r = await store.query({
    query: `WITH ins AS (
      INSERT INTO corpus_units (id, source, year, court_code, bench_code, folder, object_key, priority)
      SELECT id, source, year, court_code, bench_code, folder, object_key, priority
      FROM jsonb_to_recordset($1::jsonb) AS x(id text, source text, year int, court_code text, bench_code text, folder text, object_key text, priority int)
      ON CONFLICT (id) DO NOTHING RETURNING 1) SELECT count(*)::int AS n FROM ins`,
    params: [JSON.stringify(units)],
  });
  return Number(r[0]?.n ?? 0);
}

/** Seed the queue with the discovery units (idempotent). */
export async function seedDiscovery(store: RemoteStore, deps: BackfillDeps = {}): Promise<number> {
  const { hc } = buckets(deps);
  const units: Parameters<typeof insertUnits>[1] = [
    { id: "discover:sc", source: "sci-open-data", year: 0, court_code: null, bench_code: null, folder: "metadata/tar/", object_key: "metadata/tar/", priority: unitPriority({ kind: "discover", source: "sci-open-data", year: 0 }) },
  ];
  for (const p of await hc.folders("metadata/tar/")) {
    const year = partsOf(p).year;
    if (!year) continue;
    units.push({ id: `discover:hc:${year}`, source: "hc-open-data", year, court_code: null, bench_code: null, folder: p, object_key: p, priority: unitPriority({ kind: "discover", source: "hc-open-data", year }) });
  }
  return insertUnits(store, units);
}

const isArchive = (key: string) => /\.tar(\.gz)?$/i.test(key);

async function discover(store: RemoteStore, unit: Row, deps: BackfillDeps): Promise<{ added: number }> {
  const { sci, hc } = buckets(deps);
  const found: Parameters<typeof insertUnits>[1] = [];
  if (unit.source === "sci-open-data") {
    for (const yp of await sci.folders("metadata/tar/")) {
      const year = partsOf(yp).year;
      if (!year) continue;
      const page = await sci.list(yp);
      for (const o of page.objects) if (isArchive(o.key)) {
        const name = o.key.slice(yp.length);
        found.push({ id: archiveUnitId("sci-open-data", yp, name), source: "sci-open-data", year, court_code: null, bench_code: null, folder: yp, object_key: o.key, priority: unitPriority({ kind: "archive", source: "sci-open-data", year }) });
      }
    }
  } else {
    const year = Number(unit.year);
    for (const cp of await hc.folders(String(unit.folder))) {
      const court = partsOf(cp).court;
      for (const bp of await hc.folders(cp)) {
        const bench = partsOf(bp).bench ?? null;
        const page = await hc.list(bp);
        for (const o of page.objects) if (isArchive(o.key)) {
          const name = o.key.slice(bp.length);
          found.push({ id: archiveUnitId("hc-open-data", bp, name), source: "hc-open-data", year, court_code: court ?? null, bench_code: bench, folder: bp, object_key: o.key, priority: unitPriority({ kind: "archive", source: "hc-open-data", year, courtCode: court }) });
        }
      }
    }
  }
  const added = await insertUnits(store, found);
  return { added };
}

// ---------------------------------------------------------------------------
// Claiming and processing
// ---------------------------------------------------------------------------

async function claim(store: RemoteStore): Promise<Row | null> {
  const r = await store.query({
    query: `UPDATE corpus_units SET status = 'running', lease_until = now() + interval '${LEASE_MINUTES} minutes', attempts = attempts + 1,
      started_at = coalesce(started_at, now()), updated_at = now()
      WHERE id = (
        SELECT id FROM corpus_units
        WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND attempts < ${MAX_ATTEMPTS}
        ORDER BY priority, id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
  });
  return r[0] ?? null;
}

async function declaredFiles(bucket: OpenDataBucket, folder: string, archiveName: string): Promise<string[] | null> {
  const indexKey = `${folder}metadata.index.json`;
  let got: { bytes: Uint8Array; truncated: boolean };
  try { got = await bucket.getBytes(indexKey, { maxBytes: MAX_INDEX_BYTES }); } catch { return null; }
  if (got.truncated) return null;
  const idx = JSON.parse(new TextDecoder().decode(got.bytes)) as { parts?: { name?: string; files?: string[] }[] };
  const part = idx.parts?.find((p) => p.name === archiveName);
  return Array.isArray(part?.files) ? part!.files! : null;
}

async function processArchive(store: RemoteStore, unit: Row, deps: BackfillDeps, deadline: number, now: () => number): Promise<{ status: string; stored: number; rejected: number; expected: number | null; note?: string }> {
  const { sci, hc } = buckets(deps);
  const source = unit.source as CorpusUnitRef["source"];
  const bucket = source === "sci-open-data" ? sci : hc;
  const folder = String(unit.folder);
  const name = String(unit.object_key).slice(folder.length);
  const ref: CorpusUnitRef = { id: String(unit.id), source, year: Number(unit.year), courtCode: unit.court_code, benchCode: unit.bench_code };

  const declared = await declaredFiles(bucket, folder, name);
  const got = await bucket.getBytes(String(unit.object_key), { maxBytes: MAX_ARCHIVE_BYTES });
  if (got.truncated) throw new Error(`archive larger than ${MAX_ARCHIVE_BYTES} bytes`);
  const entries = readTar(got.bytes).filter((e) => e.name.toLowerCase().endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
  const base = (s: string) => s.split("/").pop() ?? s;
  const expected = declared ? declared.length : entries.length;
  let cursor = Number(unit.cursor ?? 0);
  let stored = Number(unit.stored ?? 0);
  let rejected = Number(unit.rejected ?? 0);

  while (cursor < entries.length) {
    if (now() > deadline) {
      await store.query({ query: `UPDATE corpus_units SET status = 'pending', lease_until = NULL, attempts = greatest(attempts - 1, 0), expected = $2, updated_at = now() WHERE id = $1`, params: [ref.id, expected] });
      return { status: "paused", stored, rejected, expected, note: `resumes at record ${cursor} of ${entries.length}` };
    }
    const slice = entries.slice(cursor, cursor + BATCH);
    const rows: CorpusRow[] = [];
    const rejects: { unit_id: string; entry: string; reason: string }[] = [];
    const seen = new Set<string>();
    for (const e of slice) {
      const r = rowFromEntry(ref, e.name, e.data);
      if (!r.ok) { rejects.push({ unit_id: ref.id, entry: base(e.name), reason: r.reason }); continue; }
      if (seen.has(r.row.id)) continue;
      seen.add(r.row.id);
      rows.push(r.row);
    }
    const qs: SqlQuery[] = [{ query: upsertSql(), params: [JSON.stringify(rows)] }];
    if (rejects.length) qs.push({ query: `INSERT INTO corpus_rejects (unit_id, entry, reason) SELECT unit_id, entry, reason FROM jsonb_to_recordset($1::jsonb) AS x(unit_id text, entry text, reason text) ON CONFLICT (unit_id, entry) DO UPDATE SET reason = EXCLUDED.reason, at = now()`, params: [JSON.stringify(rejects)] });
    cursor += slice.length;
    stored += rows.length;
    rejected += rejects.length;
    qs.push({ query: `UPDATE corpus_units SET cursor = $2, stored = $3, rejected = $4, expected = $5, lease_until = now() + interval '${LEASE_MINUTES} minutes', updated_at = now() WHERE id = $1`, params: [ref.id, cursor, stored, rejected, expected] });
    await store.transaction(qs);
  }

  // Declared in the archive index but absent from the archive: recorded, never silently skipped.
  let extraNote: string | null = null;
  if (declared) {
    const declaredSet = new Set(declared.map(base));
    const extra = entries.filter((e) => !declaredSet.has(base(e.name))).length;
    if (extra) extraNote = `${extra} record(s) in the archive are not declared in its index (stored)`;
    const present = new Set(entries.map((e) => base(e.name)));
    const missing = declared.filter((f) => !present.has(base(f)));
    if (missing.length) {
      for (let i = 0; i < missing.length; i += 1000) {
        const chunk = missing.slice(i, i + 1000).map((f) => ({ unit_id: ref.id, entry: base(f), reason: "declared in the archive index but missing from the archive" }));
        await store.query({ query: `INSERT INTO corpus_rejects (unit_id, entry, reason) SELECT unit_id, entry, reason FROM jsonb_to_recordset($1::jsonb) AS x(unit_id text, entry text, reason text) ON CONFLICT (unit_id, entry) DO NOTHING`, params: [JSON.stringify(chunk)] });
      }
      rejected += missing.length;
    }
  }
  const complete = stored + rejected >= expected;
  const note = declared ? undefined : "archive index not available; completeness measured against the archive itself";
  const unitNote = [note, extraNote].filter(Boolean).join("; ") || null;
  await store.query({ query: `UPDATE corpus_units SET status = 'done', rejected = $2, finished_at = now(), lease_until = NULL, error = $3, note = $4, updated_at = now() WHERE id = $1`, params: [ref.id, rejected, complete ? null : `stored ${stored} + rejected ${rejected} < expected ${expected}`, unitNote] });
  return { status: "done", stored, rejected, expected, note: unitNote ?? undefined };
}

async function dbSize(store: RemoteStore): Promise<number> {
  const r = await store.query({ query: `SELECT pg_database_size(current_database())::bigint AS b` });
  return Number(r[0]?.b ?? 0);
}

/** Enable or disable the scheduled backfill (the cron tick only runs it when enabled). */
export async function setBackfillEnabled(enabled: boolean, deps: BackfillDeps = {}): Promise<void> {
  const store = requireStore(deps);
  await ensureCorpusSchema(store);
  await setState(store, "enabled", enabled);
  if (enabled) await seedDiscovery(store, deps);
}

/** Deployment switch: CORPUS_BACKFILL=1 turns the backfill on (an operator decision, set in the hosting environment). */
export function backfillEnabledByEnv(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return ["1", "true", "yes"].includes((env.CORPUS_BACKFILL ?? "").trim().toLowerCase());
}

async function enabledIn(store: RemoteStore): Promise<boolean> {
  if (backfillEnabledByEnv()) return true;
  return (await getState<boolean>(store, "enabled")) === true;
}

export async function backfillEnabled(deps: BackfillDeps = {}): Promise<boolean> {
  const store = deps.store === undefined ? remoteStore() : deps.store;
  if (!store) return false;
  try { await ensureCorpusSchema(store); return await enabledIn(store); } catch { return false; }
}

/**
 * Work the queue until the deadline, the queue is empty, or the database reaches the storage budget
 * (CORPUS_MAX_DB_MB, default 450 MB — raise it after upgrading the database plan).
 */
export async function runBackfill(o: { deadlineMs: number; force?: boolean } & BackfillDeps): Promise<BackfillResult> {
  const now = o.now ?? Date.now;
  const deadline = now() + o.deadlineMs;
  const limit = limitBytes();
  const out: BackfillResult = { stop: "deadline", units: [], limitBytes: limit };
  let store: RemoteStore;
  try { store = requireStore(o); } catch (e) { return { ...out, stop: "not_configured", error: (e as Error).message }; }
  try {
    await ensureCorpusSchema(store);
    if (!o.force && !(await enabledIn(store))) return { ...out, stop: "disabled" };
    const seeded = await store.query({ query: `SELECT count(*)::int AS n FROM corpus_units WHERE id LIKE 'discover:%'` });
    if (!Number(seeded[0]?.n)) await seedDiscovery(store, o);
    while (now() < deadline - 5_000) {
      out.dbBytes = await dbSize(store);
      if (out.dbBytes >= limit) {
        await setState(store, "stop", { reason: "storage_budget", dbBytes: out.dbBytes, limitBytes: limit, at: new Date().toISOString() });
        out.stop = "storage_budget";
        return out;
      }
      const unit = await claim(store);
      if (!unit) { out.stop = "queue_empty"; return out; }
      try {
        if (String(unit.id).startsWith("discover:")) {
          const { added } = await discover(store, unit, o);
          await store.query({ query: `UPDATE corpus_units SET status = 'done', stored = $2, finished_at = now(), lease_until = NULL, error = NULL, updated_at = now() WHERE id = $1`, params: [unit.id, added] });
          out.units.push({ id: String(unit.id), status: "done", stored: added, rejected: 0, expected: null, note: `${added} archive(s) queued` });
        } else {
          const r = await processArchive(store, unit, o, deadline - 10_000, now);
          out.units.push({ id: String(unit.id), ...r });
          if (r.status === "paused") return out;
        }
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        const attempts = Number(unit.attempts ?? 1);
        await store.query({ query: `UPDATE corpus_units SET status = $2, error = $3, lease_until = NULL, updated_at = now() WHERE id = $1`, params: [unit.id, attempts >= MAX_ATTEMPTS ? "failed" : "pending", msg] });
        out.units.push({ id: String(unit.id), status: attempts >= MAX_ATTEMPTS ? "failed" : "retry", stored: 0, rejected: 0, expected: null, note: msg });
      }
    }
    return out;
  } catch (e) {
    return { ...out, stop: "error", error: (e as Error).message.slice(0, 500) };
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface CorpusStatus {
  configured: boolean;
  enabled: boolean;
  dbBytes: number | null;
  limitBytes: number;
  stop: unknown;
  units: Record<string, number>;
  discovery: { done: number; total: number };
  judgments: number;
  byCourt: { court_id: string | null; court_code: string | null; judgments: number; min_year: number | null; max_year: number | null }[];
  archives: { source: string; court_code: string | null; done: number; total: number; expected: number; stored: number; rejected: number }[];
  incomplete: { id: string; error: string | null; stored: number; rejected: number; expected: number | null }[];
  notes: { id: string; note: string }[];
  failed: { id: string; error: string | null; attempts: number }[];
  issues: { withIssues: number; unresolvedCourt: number; noDecisionDate: number };
}

export async function corpusStatus(deps: BackfillDeps = {}): Promise<CorpusStatus> {
  const store = deps.store === undefined ? remoteStore() : deps.store;
  const empty: CorpusStatus = { configured: false, enabled: false, dbBytes: null, limitBytes: limitBytes(), stop: null, units: {}, discovery: { done: 0, total: 0 }, judgments: 0, byCourt: [], archives: [], incomplete: [], notes: [], failed: [], issues: { withIssues: 0, unresolvedCourt: 0, noDecisionDate: 0 } };
  if (!store) return empty;
  await ensureCorpusSchema(store);
  const [units, disc, total, byCourt, archives, incomplete, failed, issues, size, enabled, stop, notes] = await Promise.all([
    store.query({ query: `SELECT status, count(*)::int AS n FROM corpus_units WHERE id NOT LIKE 'discover:%' GROUP BY status` }),
    store.query({ query: `SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*)::int AS total FROM corpus_units WHERE id LIKE 'discover:%'` }),
    store.query({ query: `SELECT count(*)::bigint AS n FROM corpus_judgments` }),
    store.query({ query: `SELECT court_id, court_code, count(*)::int AS n, min(year) AS min_year, max(year) AS max_year FROM corpus_judgments GROUP BY court_id, court_code ORDER BY n DESC` }),
    store.query({ query: `SELECT source, court_code, count(*) FILTER (WHERE status = 'done')::int AS done, count(*)::int AS total, coalesce(sum(expected),0)::bigint AS expected, coalesce(sum(stored),0)::bigint AS stored, coalesce(sum(rejected),0)::bigint AS rejected FROM corpus_units WHERE id NOT LIKE 'discover:%' GROUP BY source, court_code ORDER BY min(priority)` }),
    store.query({ query: `SELECT id, error, stored, rejected, expected FROM corpus_units WHERE status = 'done' AND error IS NOT NULL ORDER BY priority LIMIT 20` }),
    store.query({ query: `SELECT id, error, attempts FROM corpus_units WHERE status = 'failed' OR (status = 'pending' AND error IS NOT NULL) ORDER BY priority LIMIT 20` }),
    store.query({ query: `SELECT count(*) FILTER (WHERE issues IS NOT NULL)::int AS w, count(*) FILTER (WHERE court_id IS NULL)::int AS u, count(*) FILTER (WHERE decision_date IS NULL)::int AS d FROM corpus_judgments` }),
    dbSize(store),
    enabledIn(store),
    getState<unknown>(store, "stop"),
    store.query({ query: `SELECT id, note FROM corpus_units WHERE note IS NOT NULL ORDER BY priority LIMIT 50` }),
  ]);
  return {
    configured: true,
    enabled,
    dbBytes: size,
    limitBytes: limitBytes(),
    stop,
    units: Object.fromEntries(units.map((r) => [String(r.status), Number(r.n)])),
    discovery: { done: Number(disc[0]?.done ?? 0), total: Number(disc[0]?.total ?? 0) },
    judgments: Number(total[0]?.n ?? 0),
    byCourt: byCourt.map((r) => ({ court_id: r.court_id, court_code: r.court_code, judgments: Number(r.n), min_year: r.min_year ? Number(r.min_year) : null, max_year: r.max_year ? Number(r.max_year) : null })),
    archives: archives.map((r) => ({ source: String(r.source), court_code: r.court_code, done: Number(r.done), total: Number(r.total), expected: Number(r.expected), stored: Number(r.stored), rejected: Number(r.rejected) })),
    incomplete: incomplete.map((r) => ({ id: String(r.id), error: r.error, stored: Number(r.stored), rejected: Number(r.rejected), expected: r.expected ? Number(r.expected) : null })),
    notes: notes.map((r) => ({ id: String(r.id), note: String(r.note) })),
    failed: failed.map((r) => ({ id: String(r.id), error: r.error, attempts: Number(r.attempts) })),
    issues: { withIssues: Number(issues[0]?.w ?? 0), unresolvedCourt: Number(issues[0]?.u ?? 0), noDecisionDate: Number(issues[0]?.d ?? 0) },
  };
}
