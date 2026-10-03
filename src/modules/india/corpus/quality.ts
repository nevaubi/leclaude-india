import 'server-only';
import { randomUUID } from 'node:crypto';
import type { RemoteStore } from '@/lib/db/remote';
import { getState, setState } from './backfill';
import { reconcileTextBatch } from './reconcile';
import { runCitatorBuild } from '../citator/build';
import { runJudgmentEmbedding } from './embeddings';
import { sampleQualityCoverage } from './quality-view';
import { isProviderQuotaError, QUOTA_DEFER_SECONDS } from '@/lib/ai/quota';

export const QUALITY_POLICY_KEY = 'corpus_quality_policy_v1';
const LEASE_KEY = 'corpus_quality_lease_v1';
const LAST_KEY = 'corpus_quality_last_v1';
const EMBED_PAUSE_KEY = 'corpus_quality_embed_pause_v1';
export function qualityLimits(raw: Record<string, unknown>) {
  const n = Number(raw.maxEmbeddingChunks);
  return { maxEmbeddingChunks: Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 2000) : 1000, embeddings: raw.embeddings !== false };
}
interface WorkOptions { deadline: number; deadlineMs: number; maxChunks: number; now: () => number }
type Worker = (store: RemoteStore, options: WorkOptions) => Promise<unknown>;
export interface QualityWorkers { reconcile: Worker; citator: Worker; embed: Worker }
export interface QualityRun { stop: 'disabled' | 'busy' | 'done' | 'partial'; startedAt: string; finishedAt?: string; tasks: Record<string, unknown> }
const DEFAULT_WORKERS: QualityWorkers = {
  async reconcile(store, o) {
    const totals = { batches: 0, scanned: 0, updated: 0, partial: 0, unmatched: 0, passComplete: false };
    while (totals.batches < 15 && o.now() < o.deadline - 5000) {
      const r = await reconcileTextBatch(store, 2000);
      totals.batches++; totals.scanned += r.scanned; totals.updated += r.updated; totals.partial += r.partial; totals.unmatched += r.unmatched;
      if (r.passComplete) { totals.passComplete = true; break; }
    }
    return totals;
  },
  citator: (store, o) => runCitatorBuild({ store, limit: 100, deadlineMs: o.deadlineMs, now: o.now }),
  embed: (store, o) => runJudgmentEmbedding(store, { deadline: o.deadline, maxChunks: o.maxChunks, seed: 150, now: o.now }),
};
/** Separate leases and time allocations prevent bulk metadata ingestion from starving quality work. */
export async function runCorpusQuality(o: { store: RemoteStore; workers?: Partial<QualityWorkers>; now?: () => number }): Promise<QualityRun> {
  const now = o.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const policy = await getState<Record<string, unknown>>(o.store, QUALITY_POLICY_KEY);
  if (policy?.enabled !== true) return { stop: 'disabled', startedAt, tasks: {} };
  const limits = qualityLimits(policy);
  const owner = randomUUID();
  const lease = await o.store.query({ query: `INSERT INTO corpus_state(key, value, updated_at)
      VALUES ($1, jsonb_build_object('owner', $2::text, 'expiresAt', now() + interval '5 minutes'), now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      WHERE (corpus_state.value->>'expiresAt')::timestamptz < now() RETURNING key`, params: [LEASE_KEY, owner] });
  if (!lease.length) return { stop: 'busy', startedAt, tasks: {} };
  const raw = o.store;
  const store: RemoteStore = {
    query: async (q) => (await raw.transaction([{ query: "SET LOCAL statement_timeout = '15s'" }, { query: "SET LOCAL lock_timeout = '3s'" }, q]))[2],
    transaction: async (qs) => (await raw.transaction([{ query: "SET LOCAL statement_timeout = '15s'" }, { query: "SET LOCAL lock_timeout = '3s'" }, ...qs])).slice(2),
  };
  const workers = { ...DEFAULT_WORKERS, ...o.workers };
  const out: QualityRun = { stop: 'done', startedAt, tasks: {} };
  const end = now() + 225000;
  try {
    for (const [name, budget] of [['reconcile', 30000], ['citator', 75000], ['embed', 90000]] as const) {
      if (name === 'embed' && !limits.embeddings) { out.tasks[name] = { stop: 'disabled' }; continue; }
      const deadlineMs = Math.min(budget, end - now() - 15000);
      if (deadlineMs < 5000) { out.tasks[name] = { stop: 'deadline' }; out.stop = 'partial'; continue; }
      try {
        if(name==='embed') {
          const pause=await getState<{retryAfter?:string}>(store,EMBED_PAUSE_KEY);
          if(pause?.retryAfter && Date.parse(pause.retryAfter)>now()) {
            out.tasks.embed={stop:'provider_quota',retryAfter:pause.retryAfter};out.stop='partial';continue;
          }
        }
        const result = await workers[name](store, { deadline: now() + deadlineMs, deadlineMs, maxChunks: limits.maxEmbeddingChunks, now });
        out.tasks[name] = result;
        if (result && typeof result === 'object' && ('error' in result && result.error)) {
          out.stop = 'partial';
          if(name==='embed' && isProviderQuotaError(result.error)) {
            const retryAfter=new Date(now()+QUOTA_DEFER_SECONDS*1000).toISOString();
            await setState(store,EMBED_PAUSE_KEY,{retryAfter,reason:'provider_quota'});
            out.tasks.embed={...result,stop:'provider_quota',retryAfter};
          }
        }
      }
      catch (error) { out.tasks[name] = { stop: 'error', error: (error instanceof Error ? error.message : String(error)).slice(0,300) }; out.stop = 'partial'; }
    }
    if (!o.workers && now() < end - 15000) {
      try { await sampleQualityCoverage(store); } catch(error) { out.tasks.coverage = { error: error instanceof Error ? error.message.slice(0,200) : 'Snapshot unavailable' }; }
    }
    out.finishedAt = new Date(now()).toISOString();
    await setState(store, LAST_KEY, out);
    console.info(JSON.stringify({ event: 'corpus.quality', ...out }));
    return out;
  } finally {
    await raw.query({ query: "DELETE FROM corpus_state WHERE key=$1 AND value->>'owner'=$2", params: [LEASE_KEY, owner] });
  }
}
