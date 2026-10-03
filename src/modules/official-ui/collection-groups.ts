import type { SourceKind } from '@/modules/official/types';
import { retiredCollectionReason } from '@/modules/official/collection-policy';
export const COLLECTION_GROUPS = [
 { id:'decisions', title:'Judgments & orders', description:'Court and tribunal decisions, linked to the issuing forum.', kinds:['judgment','order'], href:'/sources?tab=browse&kind=judgment,order', relatedHref:'/cases', relatedLabel:'Judgment corpus', image:'sci' },
 { id:'regulation', title:'Regulatory materials', description:'Regulations, master circulars and notifications with publisher editions.', kinds:['regulation','circular','notification'], href:'/sources?tab=browse&kind=regulation,circular,notification', relatedHref:'/law', relatedLabel:'Acts & provisions', image:null },
 { id:'practice', title:'Court practice', description:'Cause lists, calendars and procedural notices. Not judicial precedent.', kinds:['cause_list','calendar','defect_list'], href:'/sources?tab=browse&kind=cause_list,calendar,defect_list', relatedHref:'/courts', relatedLabel:'Court directory', image:'hc-delhi' },
 { id:'research', title:'Research & legislative history', description:'Committee reports, debates and reference materials. Kept distinct from law.', kinds:['committee_report','parliament_debate','reference_report','minutes','dataset','company_record'], href:'/sources?tab=browse&kind=committee_report,parliament_debate,reference_report,minutes', relatedHref:'/sources?tab=coverage', relatedLabel:'Quality & coverage', image:null },
] as const;
export type CollectionGroup = typeof COLLECTION_GROUPS[number]['id'];
export function collectionGroup(source:string,kind:SourceKind):CollectionGroup|null {
 if(retiredCollectionReason(source,kind)) return null;
 return COLLECTION_GROUPS.find(g=>(g.kinds as readonly string[]).includes(kind))?.id ?? null;
}
