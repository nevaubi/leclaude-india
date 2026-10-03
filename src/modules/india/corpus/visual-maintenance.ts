import 'server-only';
import {randomUUID} from 'node:crypto';
import {COURTS} from '@/lib/india/courts';
import type {RemoteStore} from '@/lib/db/remote';
import {getState,setState} from './backfill';
import {REGULATOR_SITES} from '@/modules/media/logos';
import {runVisuals} from '@/modules/media/visuals';
/** Fill missing, provenance-checked visuals in small batches. Failed keys cool down for a day. */
export async function maintainCorpusVisuals(store:RemoteStore){
 const policy=await getState<Record<string,unknown>>(store,'corpus_quality_policy_v1');
 if(policy?.enabled!==true||policy.visuals===false)return {stop:'disabled'};
 const owner=randomUUID();const lease='corpus_visuals_lease_v1';
 const claimed=await store.query({query:`INSERT INTO corpus_state(key,value,updated_at) VALUES($1,jsonb_build_object('owner',$2::text,'expiresAt',now()+interval '3 minutes'),now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now() WHERE (corpus_state.value->>'expiresAt')::timestamptz<now() RETURNING key`,params:[lease,owner]});
 if(!claimed.length)return {stop:'busy'};
 try{
  const shown=await store.query({query:"SELECT key FROM visuals WHERE hidden=false AND vision->>'ok'='true' AND COALESCE(vision->>'containsStateEmblem','true')='false'"});
  const known=new Set(shown.map(r=>r.key));
  const attempts=await getState<Record<string,string>>(store,'corpus_visuals_attempts_v1')??{};
  const targets=[...COURTS.map(c=>c.id),...REGULATOR_SITES.map(s=>s.key)];
  const now=Date.now();
  const remaining=targets.filter(k=>!known.has(k)&&(!attempts[k]||now-Date.parse(attempts[k])>86400000));
  const keys=remaining.slice(0,2);
  if(!keys.length)return {stop:'up_to_date_or_cooling_down',remaining:targets.filter(k=>!known.has(k)).length};
  const result=await runVisuals({keys,kinds:['court_building','regulator_logo'],refresh:false},{store,deadlineMs:110000,concurrency:2,maxTries:2});
  for(const key of keys)attempts[key]=new Date().toISOString();
  await setState(store,'corpus_visuals_attempts_v1',attempts);
  const report={at:new Date().toISOString(),keys,result};
  await setState(store,'corpus_visuals_last_v1',report);
  console.info(JSON.stringify({event:'corpus.visuals',keys,counts:result.counts}));
  return report;
 }finally{await store.query({query:"DELETE FROM corpus_state WHERE key=$1 AND value->>'owner'=$2",params:[lease,owner]});}
}
