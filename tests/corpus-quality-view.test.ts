import { describe,it,expect } from 'vitest';
import { qualityMetric, readQualityView } from '@/modules/india/corpus/quality-view';
import type {RemoteStore} from '@/lib/db/remote';
describe('quality view does not manufacture coverage',()=>{
 it('keeps unknown distinct from zero',()=>{expect(qualityMetric(undefined)).toBeNull();expect(qualityMetric(null)).toBeNull();expect(qualityMetric('0')).toBe(0);expect(qualityMetric('123')).toBe(123);expect(qualityMetric('NaN')).toBeNull();});
 it('reads saved summaries only and does not expose configuration secrets',async()=>{
  const queries:string[]=[];
  const store={query:async(q:{query:string})=>{queries.push(q.query);return [{key:'corpus_quality_policy_v1',value:JSON.stringify({enabled:true,secret:'never-return-this'})}];},transaction:async()=>[]} as RemoteStore;
  const v=await readQualityView(store);expect(v.enabled).toBe(true);expect(v.coverage).toBeNull();expect(JSON.stringify(v)).not.toContain('never-return-this');expect(queries.join(' ')).not.toMatch(/COUNT|INSERT|DELETE|UPDATE/i);
 });
});
