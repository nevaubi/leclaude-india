import 'server-only';
import type { RemoteStore } from '@/lib/db/remote';
import { getState, setState } from './backfill';
export interface ChunkSet { chunks: number; uniqueChunks: number; first: number; last: number; expectedMin: number; expectedMax: number; declared: number; nonempty: number }
/** Dataset completeness, not verification against the judicial original. */
export function assessChunkSet(s: ChunkSet): 'full' | 'partial' | null {
  if (!s.chunks || !s.nonempty) return null;
  return s.expectedMin > 0 && s.expectedMin === s.expectedMax && s.chunks === s.expectedMin && s.uniqueChunks === s.chunks && s.declared === s.chunks && s.nonempty === s.chunks && s.first === 0 && s.last === s.expectedMin - 1 ? 'full' : 'partial';
}
const KEY = 'corpus_text_reconcile_v1';
export interface ReconcileResult { scanned: number; updated: number; partial: number; unmatched: number; cursor: string; passComplete: boolean; at: string }
/** A bounded keyset walk catches metadata imported after its matching parsed text. */
export async function reconcileTextBatch(store: RemoteStore, limit = 500): Promise<ReconcileResult> {
  limit = Math.max(1, Math.min(Math.floor(limit), 2000));
  const prior = await getState<{ cursor?: string; updatedTotal?: number }>(store, KEY);
  const rows = await store.query({ query: `WITH keys AS MATERIALIZED (
      SELECT id, cnr, decision_date, court_id, dataset_version FROM corpus_texts
      WHERE chunk_index = 0 AND court_id LIKE 'hc-%' AND cnr IS NOT NULL AND decision_date IS NOT NULL
        AND dataset_version NOT LIKE 'aws-hc-pdf%' AND id > $1 ORDER BY id LIMIT $2
    ) SELECT k.id, k.cnr, k.decision_date::text AS decision_date, k.court_id, c.*,
      (SELECT coalesce(json_agg(j.id), '[]')::text FROM corpus_judgments j
       WHERE j.cnr = k.cnr AND j.decision_date = k.decision_date AND j.court_id = k.court_id) AS judgment_ids
    FROM keys k CROSS JOIN LATERAL (
      SELECT count(*) AS chunks, count(DISTINCT t.chunk_index) AS unique_chunks,
        min(t.chunk_index) AS first, max(t.chunk_index) AS last,
        min(t.total_chunks) AS expected_min, max(t.total_chunks) AS expected_max,
        count(t.total_chunks) AS declared, count(*) FILTER (WHERE length(trim(t.text)) > 0) AS nonempty
      FROM corpus_texts t WHERE t.cnr = k.cnr AND t.decision_date = k.decision_date
        AND t.court_id = k.court_id AND t.dataset_version = k.dataset_version
    ) c ORDER BY k.id`, params: [prior?.cursor ?? '', limit] });
  const updates: { id: string; cnr: string; decision_date: string; court_id: string; status: string }[] = [];
  let partial = 0, unmatched = 0;
  for (const r of rows) {
    const status = assessChunkSet({ chunks: Number(r.chunks), uniqueChunks: Number(r.unique_chunks), first: Number(r.first), last: Number(r.last), expectedMin: Number(r.expected_min), expectedMax: Number(r.expected_max), declared: Number(r.declared), nonempty: Number(r.nonempty) });
    const ids = JSON.parse(r.judgment_ids ?? '[]') as string[];
    if (!ids.length) unmatched++;
    if (!status) continue;
    if (status === 'partial') partial++;
    for (const id of ids) updates.push({ id, cnr: r.cnr!, decision_date: r.decision_date!, court_id: r.court_id!, status });
  }
  const changed = updates.length ? await store.query({ query: `WITH changed AS (
    UPDATE corpus_judgments j SET text_status = x.status, updated_at = now()
    FROM jsonb_to_recordset($1::jsonb) AS x(id text, cnr text, decision_date date, court_id text, status text)
    WHERE j.id = x.id AND j.cnr = x.cnr AND j.decision_date = x.decision_date AND j.court_id = x.court_id
      AND j.text_status IN ('none', 'failed') RETURNING j.id
  ) SELECT count(*) AS n FROM changed`, params: [JSON.stringify(updates)] }) : [];
  const out: ReconcileResult = { scanned: rows.length, updated: Number(changed[0]?.n ?? 0), partial, unmatched, cursor: rows.length < limit ? '' : rows[rows.length - 1].id!, passComplete: rows.length < limit, at: new Date().toISOString() };
  await setState(store, KEY, { ...out, updatedTotal: (prior?.updatedTotal ?? 0) + out.updated });
  return out;
}
