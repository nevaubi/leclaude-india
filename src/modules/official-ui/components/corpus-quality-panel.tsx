"use client";
import * as React from 'react';
import Link from 'next/link';
import {Activity,ArrowUpRight,RefreshCw} from 'lucide-react';
import type {QualityView} from '@/modules/india/corpus/quality-view';
import {Button} from '@/components/ui/button';
const METRICS=[['judgment_passages','Judgment passages','/cases'],['judgment_vectors','Judgment vectors stored','/cases'],['citation_scans','Judgments citation-scanned','/cases'],['citation_edges','Citation records extracted','/cases'],['law_provisions','Indexed law provisions','/law'],['official_sections','India Code sections stored','/law']] as const;
export function CorpusQualityPanel(){
 const [data,setData]=React.useState<QualityView|null>(null),[error,setError]=React.useState(false),[nonce,setNonce]=React.useState(0);
 React.useEffect(()=>{const ac=new AbortController();setError(false);fetch('/api/india/corpus/quality',{signal:ac.signal,cache:'no-store'}).then(async r=>{if(!r.ok)throw Error();setData(await r.json());}).catch(()=>{if(!ac.signal.aborted)setError(true);});return()=>ac.abort();},[nonce]);
 const counts=data?.coverage?.counts??{};const n=(key:string)=>counts[key]==null?'Not measured':Number(counts[key]).toLocaleString('en-IN');
 const last=data?.maintenance;const stamp=data?.coverage?.sampledAt;
 const tasks=last?.tasks as Record<string,{stop?:string;error?:string;retryAfter?:string}>|undefined;
 const embed=tasks?.embed;
 const quota=embed?.stop==='provider_quota'||/no credits remaining|insufficient[_ ]quota/i.test(embed?.error??'');
 return <section aria-label="Corpus quality" className="mb-5 overflow-hidden rounded-xl border bg-card">
  <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><div className="flex items-center gap-2"><Activity className="size-4"/><h2 className="text-[13px] font-semibold">Corpus quality</h2><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{data?data.enabled?'Maintenance enabled':'Maintenance disabled':'Status pending'}</span></div><Button size="xs" variant="ghost" onClick={()=>setNonce(x=>x+1)}><RefreshCw className="size-3"/>Refresh status</Button></header>
  <div className="grid grid-cols-2 divide-x sm:grid-cols-3">{METRICS.map(([key,label,href])=><Link key={key} href={href} className="border-b px-4 py-3 transition-colors hover:bg-accent"><span className="block text-[10.5px] text-muted-foreground">{label}</span><span className="mt-1 flex items-center justify-between text-[19px] font-semibold tracking-tight tabular-nums">{n(key)}<ArrowUpRight className="size-3 text-muted-foreground"/></span></Link>)}</div>
  <div className="space-y-1.5 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
   <p><span className="font-medium text-foreground">Separate quality checks:</span> parsed text is not a verified ruling; an extracted citation is not a resolved target; a resolved target is not a good-law assessment. Vector totals count stored embeddings; retrieval also requires a matching model and text version.</p>
   {counts.retired_documents!=null&&<p>Retired collections: <span className={counts.retired_documents?'font-semibold text-destructive':'text-foreground'}>{n('retired_documents')} remaining</span> · Court visuals: {n('court_visuals')} · Publisher logos: {n('entity_visuals')}</p>}
   {quota&&<p className="font-medium text-amber-700 dark:text-amber-300">Semantic enrichment paused: the embedding provider has no available credit. Text search and citation maintenance continue.{embed?.retryAfter?' Next retry: '+new Date(embed.retryAfter).toLocaleString():''}</p>}
   {last&&<p>Last maintenance: {String(last.stop??'unknown')} · {String(last.finishedAt??last.startedAt??'not recorded')}</p>}
   <p>{error?'The latest status could not be loaded. Existing corpus search is unchanged.':stamp?'Database snapshot: '+new Date(stamp).toLocaleString()+'. Counts update in the background, not on navigation.':'Waiting for the first bounded quality snapshot. Missing measurements are not zero.'}</p>
  </div>
 </section>;
}
