import {withDb} from '@/lib/db/request';
import {withAuth} from '@/lib/auth/route';
import {withCronGate} from '@/lib/auth/cron';
import {currentPrincipal} from '@/lib/auth/context';
import {refs} from '@/lib/auth/resources';
import {remoteStore} from '@/lib/db/remote';
import {maintainCorpusVisuals} from '@/modules/india/corpus/visual-maintenance';
export const runtime='nodejs';
export const maxDuration=180;
async function handleGET(){
 const p=currentPrincipal();if(p?.source!=='service'||!p.roles.includes('service'))return Response.json({error:'Service principal required'},{status:403});
 const store=remoteStore();if(!store)return Response.json({error:'Corpus not configured'},{status:503});
 return Response.json(await maintainCorpusVisuals(store));
}
export const GET=withCronGate(withDb(withAuth(handleGET,{action:'run',resource:()=>refs.intel()})));
