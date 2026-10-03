import {withDb} from '@/lib/db/request';
import {withAuth} from '@/lib/auth/route';
import {refs} from '@/lib/auth/resources';
import {remoteStore} from '@/lib/db/remote';
import {readQualityView} from '@/modules/india/corpus/quality-view';
export const runtime='nodejs';
async function handleGET(){
 const store=remoteStore();if(!store)return Response.json({error:'Corpus is not configured'},{status:503});
 try{return Response.json(await readQualityView(store),{headers:{'Cache-Control':'private, max-age=15'}});}
 catch{return Response.json({error:'Quality snapshot is temporarily unavailable'},{status:503});}
}
export const GET=withDb(withAuth(handleGET,{action:'read',resource:()=>refs.intel()}));
