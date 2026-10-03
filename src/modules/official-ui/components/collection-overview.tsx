"use client";
/* eslint-disable @next/next/no-img-element -- Uses our authenticated, content-addressed WebP loader with responsive srcSet. */
import Link from 'next/link';
import {ArrowUpRight,BookOpen,Building2,Gavel,Landmark} from 'lucide-react';
import type {OfficialStatus} from '@/modules/official/service';
import {COLLECTION_GROUPS} from '../collection-groups';
import {retiredCollectionReason} from '@/modules/official/collection-policy';
import {useVisuals,courtVisual,regulatorVisual} from '@/modules/media/use-visuals';
import {displayImageUrl,displayImageSrcSet} from '@/modules/media/display';
import {creditLine} from '@/modules/media/visuals-types';
const ICONS=[Gavel,Landmark,Building2,BookOpen];
export function CollectionOverview({status}:{status:OfficialStatus}){
 const visuals=useVisuals();
 const sources=status.sources.filter(s=>s.enabled&&!retiredCollectionReason(s.id));
 return <section aria-label="Research collections" className="mb-6 space-y-4">
  <div><div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Research collections</div><h2 className="mt-1 text-[19px] font-semibold tracking-tight">Start with the right authority</h2><p className="mt-1 text-[12px] text-muted-foreground">Explore by legal function, then narrow to a publisher, court or document.</p></div>
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
   {COLLECTION_GROUPS.map((group,index)=>{const picture=courtVisual(visuals,group.image);const Icon=ICONS[index];return <article key={group.id} className="group overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md">
    <div className="relative h-20 overflow-hidden bg-muted/40">
     {picture?<><img src={displayImageUrl(picture.url,640)} srcSet={displayImageSrcSet(picture.url)} sizes="(min-width:768px) 400px, 100vw" alt={picture.alt} loading="lazy" decoding="async" className="h-full w-full object-cover" onError={e=>{e.currentTarget.style.visibility='hidden';}}/><div className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent"/></>:<div className="flex h-full items-center justify-between px-5"><Icon className="size-7 text-foreground/45"/><span className="text-[36px] font-light tracking-tighter text-foreground/10">0{index+1}</span></div>}
    </div>
    <div className="p-4"><Link href={group.href} className="flex items-center justify-between gap-2 text-[13px] font-semibold hover:text-primary">{group.title}<ArrowUpRight className="size-3.5 text-muted-foreground"/></Link><p className="mt-1 min-h-8 text-[11.5px] leading-relaxed text-muted-foreground">{group.description}</p>
     <div className="mt-3 flex items-center justify-between border-t pt-2"><Link className="text-[11px] font-medium hover:underline" href={group.relatedHref}>{group.relatedLabel} →</Link>{picture&&<a href={picture.credit.sourceUrl} target="_blank" rel="noopener noreferrer" title={creditLine(picture)} className="max-w-[45%] truncate text-[9px] text-muted-foreground hover:underline">{picture.credit.author||picture.credit.sourceName} · {picture.credit.license}</a>}</div>
    </div>
   </article>})}
  </div>
  <details className="rounded-lg border bg-card"><summary className="cursor-pointer px-3.5 py-2.5 text-[12px] font-medium">Browse by publisher <span className="ml-1 text-muted-foreground">{sources.length} active source feeds</span></summary>
   <div className="grid gap-px border-t bg-border sm:grid-cols-2">{sources.map(source=>{const logo=regulatorVisual(visuals,source.id.replace(/-orders$/,''));return <Link key={source.id} href={'/sources?tab=browse&source='+source.id} className="flex min-w-0 items-center gap-2.5 bg-card px-3.5 py-3 hover:bg-accent">
    {logo?<img src={displayImageUrl(logo.url,64)} alt={logo.alt} title={creditLine(logo)} className="size-7 object-contain" loading="lazy" decoding="async"/>:<Landmark className="size-5 shrink-0 text-muted-foreground/60"/>}
    <span className="min-w-0 flex-1"><span className="block truncate text-[11.5px] font-medium">{source.name}</span><span className="block text-[10.5px] text-muted-foreground">{(source.stats.byStatus.indexed??0).toLocaleString('en-IN')} text-searchable documents</span></span><ArrowUpRight className="size-3 shrink-0 text-muted-foreground"/>
   </Link>})}</div>
  </details>
 </section>;
}
