import { describe, it, expect, vi } from 'vitest';
import type { RemoteStore, SqlQuery } from '@/lib/db/remote';
import { runCorpusQuality, qualityLimits } from '@/modules/india/corpus/quality';
function store(enabled = true, locked = false): RemoteStore { return { async query(q: SqlQuery) { if(q.query.includes('SELECT value'))return [{value:JSON.stringify({enabled,maxEmbeddingChunks:1000})}]; if(q.query.includes('RETURNING key'))return locked?[]:[{key:'lease'}]; return []; },async transaction(qs) { return Promise.all(qs.map(q=>this.query(q))); } }; }
const workers=()=>({reconcile:vi.fn(async()=>({updated:1})),citator:vi.fn(async()=>({processed:1})),embed:vi.fn(async()=>({embedded:1}))});
describe('independent bounded corpus quality worker',()=>{
 it('is disabled without an explicit persisted operator policy',async()=>{const w=workers();expect((await runCorpusQuality({store:store(false),workers:w})).stop).toBe('disabled');expect(w.embed).not.toHaveBeenCalled();});
 it('does not run a concurrent pass while its lease is held',async()=>{const w=workers();expect((await runCorpusQuality({store:store(true,true),workers:w})).stop).toBe('busy');expect(w.citator).not.toHaveBeenCalled();});
 it('reserves separate work budgets and records failures without starving later stages',async()=>{const w=workers();w.citator.mockRejectedValueOnce(new Error('parse failed'));const r=await runCorpusQuality({store:store(),workers:w});expect(w.reconcile).toHaveBeenCalledTimes(1);expect(w.embed).toHaveBeenCalledTimes(1);expect(r.tasks.citator).toMatchObject({stop:'error',error:'parse failed'});expect(w.embed.mock.calls[0]).toHaveLength(2);});
 it('caps paid embedding work and rejects invalid numeric policy values',()=>{expect(qualityLimits({maxEmbeddingChunks:999999}).maxEmbeddingChunks).toBe(2000);expect(qualityLimits({maxEmbeddingChunks:-1}).maxEmbeddingChunks).toBe(1000);expect(qualityLimits({maxEmbeddingChunks:NaN}).maxEmbeddingChunks).toBe(1000);});
});

it('pauses quota-blocked embeddings without starving text and citation maintenance',async()=>{const s=store();const q=s.query.bind(s);s.query=async x=>x.params?.[0]==='corpus_quality_embed_pause_v1'?[{value:JSON.stringify({retryAfter:new Date(Date.now()+1800000).toISOString()})}]:q(x);const w=workers();const result=await runCorpusQuality({store:s,workers:w});expect(w.reconcile).toHaveBeenCalled();expect(w.citator).toHaveBeenCalled();expect(w.embed).not.toHaveBeenCalled();expect(result.tasks.embed).toMatchObject({stop:'provider_quota'});});
