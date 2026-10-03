import "server-only";
import { remoteStore, type RemoteStore, type Row } from "@/lib/db/remote";
import { embeddingModel, recordedVectorSupport } from "./embed";
import { officialSources } from "./registry";
import { ensureOfficialSchema } from "./schema";
import { boundedQuery } from "./search";
import type { OfficialStatus } from "./service";
import type { DocumentStatus, SourceId, SourceStats } from "./types";
import { dbSize, officialLimitBytes, pgTimestampToIso, queueCounts } from "./units";

/**
 * Corpus status: per-source document counts by status, chunks and embedded chunks, last discovery / indexing time and
 * last error, queue counts, database size against the storage budget, and the embeddings mode. Without Postgres it
 * reports `configured: false` (with every source listed and zero counts) rather than failing.
 *
 * Per source it also says why a source may have nothing: `discovery` (the source's discover unit: status, attempts,
 * last error / note, when it may run next, and the stored listing cursor) and `recentErrors` (the latest unit errors,
 * at most RECENT_ERRORS per source; messages only, never document text). Aggregates run under a statement timeout.
 * Timestamps are ISO 8601 (Postgres text output such as "2026-10-02 09:00:00.123+00" is converted).
 */

export const RECENT_ERRORS = 5;
const STATUS_TIMEOUT_MS = 6_000;

function emptyStats(id: SourceId): SourceStats {
  return { sourceId: id, documents: 0, byStatus: {}, chunks: 0, embedded: 0, lastDiscoveredAt: null, lastIndexedAt: null, lastError: null };
}

const iso = pgTimestampToIso;

export interface SourceDiscoveryState {
  /** The discover unit's queue status (pending / running / done / failed / skipped); null when never scheduled. */
  status: string | null;
  attempts: number;
  error: string | null;
  note: string | null;
  /** Not claimable before this time (backoff), ISO. */
  runAfter: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  /** The adapter's stored listing cursor (first 120 characters), null when the next pass starts afresh. */
  cursor: string | null;
}

export interface SourceUnitError {
  stage: string;
  status: string;
  attempts: number;
  /** The unit's key (a document URL or the source id). */
  key: string;
  error: string;
  at: string | null;
}

function emptyDiscovery(): SourceDiscoveryState {
  return { status: null, attempts: 0, error: null, note: null, runAfter: null, finishedAt: null, updatedAt: null, cursor: null };
}

function cursorSummary(v: string | null | undefined): string | null {
  if (v == null) return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (parsed == null) return null;
    const s = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    return s.slice(0, 120);
  } catch { return String(v).slice(0, 120); }
}

const settled = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

export async function officialStatus(storeArg?: RemoteStore | null): Promise<OfficialStatus> {
  const defs = officialSources();
  const store = storeArg === undefined ? remoteStore() : storeArg;
  const model = (await embeddingModel());
  if (!store) {
    return { configured: false, sources: defs.map((d) => ({ ...d, stats: emptyStats(d.id), discovery: emptyDiscovery(), recentErrors: [] })), dbBytes: null, limitBytes: officialLimitBytes(), embeddings: "none", queue: { pending: 0, running: 0, failed: 0, done: 0 } };
  }
  await ensureOfficialSchema(store);
  const bounded = (query: string) => boundedQuery(store, query, [], STATUS_TIMEOUT_MS);
  const [byStatus, totals, errors, discovered, queue, size, vector, discoverUnits, cursors, unitErrors] = await Promise.all([
    bounded(`SELECT source, status, count(*)::int AS n FROM official_documents GROUP BY source, status`),
    bounded(`SELECT source, coalesce(sum(chunks), 0)::bigint AS chunks, coalesce(sum(embedded), 0)::bigint AS embedded, max(indexed_at) AS last_indexed, max(discovered_at) AS last_discovered FROM official_documents GROUP BY source`),
    bounded(`SELECT DISTINCT ON (source) source, error FROM official_documents WHERE error IS NOT NULL AND status IN ('failed', 'ocr_needed') ORDER BY source, updated_at DESC`),
    store.query({ query: `SELECT key, value FROM corpus_state WHERE key LIKE 'official_discover:%'` }),
    queueCounts(store),
    dbSize(store).catch(() => null),
    recordedVectorSupport(store).catch(() => null),
    settled(bounded(`SELECT source, status, attempts, error, note, run_after, finished_at, updated_at FROM official_units WHERE stage = 'discover'`), [] as Row[]),
    settled(store.query({ query: `SELECT key, value FROM corpus_state WHERE key LIKE 'official_cursor:%'` }), [] as Row[]),
    settled(bounded(`SELECT source, stage, status, attempts, key, error, updated_at FROM (
        SELECT source, stage, status, attempts, key, left(error, 300) AS error, updated_at, row_number() OVER (PARTITION BY source ORDER BY updated_at DESC) AS rn
        FROM official_units WHERE error IS NOT NULL AND status IN ('failed', 'pending')) e
      WHERE rn <= ${RECENT_ERRORS} ORDER BY source, updated_at DESC`), [] as Row[]),
  ]);
  const stats = new Map<string, SourceStats>(defs.map((d) => [d.id, emptyStats(d.id)]));
  for (const r of byStatus) {
    const s = stats.get(String(r.source));
    if (!s) continue;
    const n = Number(r.n ?? 0);
    s.byStatus[String(r.status) as DocumentStatus] = n;
    s.documents += n;
  }
  for (const r of totals) {
    const s = stats.get(String(r.source));
    if (!s) continue;
    s.chunks = Number(r.chunks ?? 0);
    s.embedded = Number(r.embedded ?? 0);
    s.lastIndexedAt = iso(r.last_indexed);
    s.lastDiscoveredAt = iso(r.last_discovered);
  }
  for (const r of errors) { const s = stats.get(String(r.source)); if (s) s.lastError = r.error ?? null; }
  for (const r of discovered) {
    const id = String(r.key).slice("official_discover:".length);
    const s = stats.get(id);
    if (!s || !r.value) continue;
    try {
      const v = JSON.parse(r.value) as { at?: string };
      const at = iso(v.at ?? null);
      if (at && (!s.lastDiscoveredAt || at > s.lastDiscoveredAt)) s.lastDiscoveredAt = at;
    } catch { /* ignore malformed state */ }
  }
  const discovery = new Map<string, SourceDiscoveryState>(defs.map((d) => [d.id, emptyDiscovery()]));
  for (const r of discoverUnits) {
    const d = discovery.get(String(r.source));
    if (!d) continue;
    Object.assign(d, { status: r.status ?? null, attempts: Number(r.attempts ?? 0), error: r.error ? String(r.error).slice(0, 300) : null, note: r.note ? String(r.note).slice(0, 300) : null, runAfter: iso(r.run_after), finishedAt: iso(r.finished_at), updatedAt: iso(r.updated_at) });
  }
  for (const r of cursors) {
    const d = discovery.get(String(r.key).slice("official_cursor:".length));
    if (d) d.cursor = cursorSummary(r.value);
  }
  const recent = new Map<string, SourceUnitError[]>();
  for (const r of unitErrors) {
    const list = recent.get(String(r.source)) ?? [];
    if (list.length >= RECENT_ERRORS) continue;
    list.push({ stage: String(r.stage ?? ""), status: String(r.status ?? ""), attempts: Number(r.attempts ?? 0), key: String(r.key ?? "").slice(0, 300), error: String(r.error ?? "").slice(0, 300), at: iso(r.updated_at) });
    recent.set(String(r.source), list);
  }
  const embeddings: OfficialStatus["embeddings"] = !model ? "none" : vector?.mode === "pgvector" ? "pgvector" : "bytea";
  // Additive per-source fields (`discovery`, `recentErrors`) beside the OfficialStatus source shape.
  const sources: (OfficialStatus["sources"][number] & { discovery: SourceDiscoveryState; recentErrors: SourceUnitError[] })[] = defs.map((d) => ({ ...d, stats: stats.get(d.id)!, discovery: discovery.get(d.id)!, recentErrors: recent.get(d.id) ?? [] }));
  return {
    configured: true,
    sources,
    dbBytes: size,
    limitBytes: officialLimitBytes(),
    embeddings,
    queue: { pending: queue.pending, running: queue.running, failed: queue.failed, done: queue.done },
  };
}
