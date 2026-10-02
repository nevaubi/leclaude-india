import "server-only";
import { remoteStore, type RemoteStore } from "@/lib/db/remote";
import { embeddingModel, recordedVectorSupport } from "./embed";
import { officialSources } from "./registry";
import { ensureOfficialSchema } from "./schema";
import type { OfficialStatus } from "./service";
import type { DocumentStatus, SourceId, SourceStats } from "./types";
import { dbSize, officialLimitBytes, queueCounts } from "./units";

/**
 * Corpus status: per-source document counts by status, chunks and embedded chunks, last discovery / indexing time and
 * last error, queue counts, database size against the storage budget, and the embeddings mode. Without Postgres it
 * reports `configured: false` (with every source listed and zero counts) rather than failing.
 */

function emptyStats(id: SourceId): SourceStats {
  return { sourceId: id, documents: 0, byStatus: {}, chunks: 0, embedded: 0, lastDiscoveredAt: null, lastIndexedAt: null, lastError: null };
}

const iso = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = Date.parse(v.includes("T") ? v : v.replace(" ", "T"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export async function officialStatus(storeArg?: RemoteStore | null): Promise<OfficialStatus> {
  const defs = officialSources();
  const store = storeArg === undefined ? remoteStore() : storeArg;
  const model = embeddingModel();
  if (!store) {
    return { configured: false, sources: defs.map((d) => ({ ...d, stats: emptyStats(d.id) })), dbBytes: null, limitBytes: officialLimitBytes(), embeddings: "none", queue: { pending: 0, running: 0, failed: 0, done: 0 } };
  }
  await ensureOfficialSchema(store);
  const [byStatus, totals, errors, discovered, queue, size, vector] = await Promise.all([
    store.query({ query: `SELECT source, status, count(*)::int AS n FROM official_documents GROUP BY source, status` }),
    store.query({ query: `SELECT source, coalesce(sum(chunks), 0)::bigint AS chunks, coalesce(sum(embedded), 0)::bigint AS embedded, max(indexed_at) AS last_indexed, max(discovered_at) AS last_discovered FROM official_documents GROUP BY source` }),
    store.query({ query: `SELECT DISTINCT ON (source) source, error FROM official_documents WHERE error IS NOT NULL AND status IN ('failed', 'ocr_needed') ORDER BY source, updated_at DESC` }),
    store.query({ query: `SELECT key, value FROM corpus_state WHERE key LIKE 'official_discover:%'` }),
    queueCounts(store),
    dbSize(store).catch(() => null),
    recordedVectorSupport(store).catch(() => null),
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
  const embeddings: OfficialStatus["embeddings"] = !model ? "none" : vector?.mode === "pgvector" ? "pgvector" : "bytea";
  return {
    configured: true,
    sources: defs.map((d) => ({ ...d, stats: stats.get(d.id)! })),
    dbBytes: size,
    limitBytes: officialLimitBytes(),
    embeddings,
    queue: { pending: queue.pending, running: queue.running, failed: queue.failed, done: queue.done },
  };
}
