import 'server-only';
import type {SourceAdapter,ParseInput} from '../../adapter';
import type {DiscoveredDoc,SourceDef} from '../../types';
import {attr,clean,htmlText,safeUrl} from '../regulators/common';
const BASE='https://www.sci.gov.in/judges-library/';
const HOSTS=['sci.gov.in','cdn.s3waas.gov.in','cdnbbsr.s3waas.gov.in'];
/** Discover the handbook link actually printed in the Court's navigation, not guessed CDN paths. */
export function sciLibraryItems(html:string):DiscoveredDoc[]{
 const seen=new Set<string>();const items:DiscoveredDoc[]=[];
 for(const m of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)){
  const label=clean(htmlText(m[0]));if(!/^(?:handbook on )?practice and procedure$/i.test(label))continue;
  const url=safeUrl(attr(m[0],'href'),BASE,HOSTS);if(!url||!new URL(url).pathname.endsWith('.pdf')||seen.has(url))continue;seen.add(url);
  items.push({sourceId:'sci-library',kind:'reference_report',url,fileUrl:url,title:'Supreme Court of India — Handbook on Practice and Procedure and Office Procedure',docDate:null,mime:'application/pdf',meta:{forum:'sci',listedOn:BASE,authorityType:'practice_handbook',legalVerification:'not_assessed',dateBasis:'edition date recorded after text extraction',effectiveDate:null}});
 }
 return items;
}
/** Keep edition-as-of separate from publication/commencement: neither is inferred from the CDN upload date. */
export function libraryPublicationMeta(text:string){
 const m=/Updated\s+as\s+on\s+(\d{2})[.]([0-9]{2})[.]([0-9]{4})/i.exec(text.slice(0,8000));
 const date=m?m[3]+'-'+m[2]+'-'+m[1]:null;
 const valid=date&&!Number.isNaN(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;
 return {authorityType:'practice_handbook',editionAsOf:valid?date:null,editionLabel:valid?'Updated as on '+m![1]+'.'+m![2]+'.'+m![3]:null,effectiveDate:null,legalVerification:'not_assessed'};
}
export const def:SourceDef={id:'sci-library',name:'Supreme Court practice publications',publisher:'Supreme Court of India',kinds:['reference_report'],forum:'sci',homepage:BASE,fetch:'direct',cadenceMinutes:1440,enabled:true,attribution:'Source: Supreme Court of India, Handbook on Practice and Procedure and Office Procedure. Cite the stated edition and original PDF page.',terms:'Supreme Court website copyright policy permits reproduction with prominent source acknowledgement, excluding third-party copyrighted materials.',notes:['Reference handbook, not a judgment or an independently consolidated statement of current rules. Edition date is extracted from the cover; Gazette collections remain excluded.']};
export const adapter:SourceAdapter={def,async discover(ctx){const page=await ctx.fetchPage(BASE);const items=sciLibraryItems(page.html??'');if(!items.length)throw new Error('The Supreme Court practice handbook link was not found; source layout needs review.');return {items,done:true,nextCursor:null};},parse(doc:ParseInput){const text=doc.pages.slice(0,3).map(p=>p.text).join('\n')||doc.markdown.slice(0,8000);return {records:[{meta:libraryPublicationMeta(text)}],unparsed:0,notes:[]};}};
