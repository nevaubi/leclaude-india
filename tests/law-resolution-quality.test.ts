import { describe,it,expect } from 'vitest';
import { resolveAct } from '@/modules/india/law/official-sections';
import type { DspaceItem,IndiaCodeClient } from '@/modules/india/sources/india-code';
const act=(id:string,state='CENTRAL',year='1996'):DspaceItem=>({id,metadata:{'dc.title':[{value:'The Arbitration and Conciliation Act, 1996'}],'dc.identifier.collection':[{value:'ACT'}],'dc.identifier.state_name':[{value:state}],'dc.date.act_year':[{value:year}]}});
const client=(pages:DspaceItem[][],handle=act('wrong','Maharashtra'))=>({getByHandle:async()=>handle,jurisdictionQuery:()=> 'dc.identifier.state_name:CENTRAL',searchActs:async(q:{page?:number})=>({items:pages[q.page??0]??[],page:{number:q.page??0,size:100,totalPages:pages.length,totalElements:pages.flat().length}})}) as unknown as IndiaCodeClient;
describe('India Code exact reconciliation across its complete result window',()=>{
 it('does not accept a same-title handle from a different jurisdiction',async()=>{expect(await resolveAct(client([[act('right')]]),{title:'The Arbitration and Conciliation Act, 1996',year:'1996',handle:'1/2'})).toMatchObject({ok:true,item:{id:'right'},method:'title_year'});});
 it('does not accept a same-title handle with the wrong year',async()=>{expect(await resolveAct(client([[act('right')]],act('wrong','CENTRAL','1995')),{title:'The Arbitration and Conciliation Act, 1996',year:'1996',handle:'1/2'})).toMatchObject({ok:true,item:{id:'right'}});});
 it('continues beyond page one instead of wrongly labelling a core Act missing',async()=>{expect(await resolveAct(client([[act('state','Maharashtra')],[act('right')]]),{title:'The Arbitration and Conciliation Act, 1996',year:'1996',handle:null})).toMatchObject({ok:true,item:{id:'right'}});});
 it('does not claim a unique mapping before checking subsequent pages for ambiguity',async()=>{expect(await resolveAct(client([[act('first')],[act('second')]]),{title:'The Arbitration and Conciliation Act, 1996',year:'1996',handle:null})).toMatchObject({ok:false});});
});
