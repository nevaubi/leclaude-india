import 'server-only';
import type { RemoteStore } from '@/lib/db/remote';
import { setState } from './backfill';
export const QUALITY_COVERAGE_KEY='corpus_quality_coverage_v1';
export function qualityMetric(value:unknown):number|null {
 if(value==null || value==='')return null;
 const n=Number(value);return Number.isFinite(n)&&n>=0?n:null;
}
export interface QualityCoverage { sampledAt:string; counts:Record<string,number|null> }
export interface QualityView { enabled:boolean; coverage:QualityCoverage|null; maintenance:Record<string,unknown>|null; reconcile:Record<string,unknown>|null; visuals:Record<string,unknown>|null }
/** Browsing reads small saved summaries only: no corpus scan or ingestion on page loads. */
export async function readQualityView(store:RemoteStore):Promise<QualityView> {
 const keys=['corpus_quality_policy_v1',QUALITY_COVERAGE_KEY,'corpus_quality_last_v1','corpus_text_reconcile_v1','corpus_visuals_last_v1'];
 const rows=await store.query({query:'SELECT key,value FROM corpus_state WHERE key = ANY($1::text[])',params:[JSON.stringify(keys).replace(/^\[/,'{').replace(/\]$/,'}')]});
 const values:Record<string,Record<string,unknown>>={};
 for(const r of rows){try{values[String(r.key)]=typeof r.value==='string'?JSON.parse(r.value):r.value??{};}catch{}}
 return {enabled:values[keys[0]]?.enabled===true,coverage:values[QUALITY_COVERAGE_KEY] as unknown as QualityCoverage??null,maintenance:values[keys[2]]??null,reconcile:values[keys[3]]??null,visuals:values[keys[4]]??null};
}
/** Bounded offline statistics, recorded by the quality worker, never by the interactive page. */
export async function sampleQualityCoverage(store:RemoteStore):Promise<void>{
 const metrics:Record<string,string>={
  judgment_passages:'SELECT count(*) n FROM corpus_texts',
  judgment_vectors:'SELECT count(*) n FROM corpus_text_embeddings WHERE embedding_v IS NOT NULL',
  citation_scans:'SELECT count(*) n FROM corpus_citator_scans',
  citation_edges:'SELECT count(*) n FROM corpus_citations',
  resolved_case_citations:"SELECT count(*) n FROM corpus_citations WHERE kind='case' AND resolution='resolved'",
  unlinked_case_citations:"SELECT count(*) n FROM corpus_citations WHERE kind='case' AND resolution<>'resolved'",
  law_instruments:'SELECT count(*) n FROM law_instruments',
  law_provisions:'SELECT count(*) n FROM law_provisions',
  official_sections:'SELECT count(*) n FROM law_official_sections',
  matched_acts:"SELECT count(*) n FROM law_official_acts WHERE status='done'",
  retired_documents:"SELECT count(*) n FROM official_documents WHERE kind IN ('parliament_question','gazette') OR source='egazette'",
  court_visuals:"SELECT count(*) n FROM visuals WHERE kind='court_building' AND hidden=false AND vision->>'ok'='true'",
  entity_visuals:"SELECT count(*) n FROM visuals WHERE kind='regulator_logo' AND hidden=false AND vision->>'ok'='true'",
 };
 const fields=Object.entries(metrics).map(([key,q])=>'('+q+') AS '+key);
 const [row]=await store.query({query:'SELECT '+fields.join(', ')});
 const counts:Record<string,number|null>={};
 for(const key of Object.keys(metrics))counts[key]=qualityMetric(row?.[key]);
 await setState(store,QUALITY_COVERAGE_KEY,{sampledAt:new Date().toISOString(),counts});
}
