import type { NextRequest } from 'next/server';
import { withDb } from '@/lib/db/request';
import { withAuth } from '@/lib/auth/route';
import { withCronGate } from '@/lib/auth/cron';
import { currentPrincipal } from '@/lib/auth/context';
import { refs } from '@/lib/auth/resources';
import { jsonError } from '@/lib/ai/sse';
import { remoteStore } from '@/lib/db/remote';
import { ingestGate } from '@/app/api/official/run/handler';
import { runCorpusQuality } from '@/modules/india/corpus/quality';
export const runtime = 'nodejs';
export const maxDuration = 300;
async function run(req: NextRequest) {
 const principal=currentPrincipal();
 if(req.method==='GET' && !(principal?.source==='service' && principal.roles.includes('service'))) return jsonError('Scheduled corpus quality runs require the service principal.',403,{code:'service_only'});
 if(req.method==='POST') { const gate=ingestGate(req,principal,process.env);if(!gate.ok)return jsonError(gate.message,gate.status,{code:gate.code}); }
 const store=remoteStore();if(!store)return jsonError('The corpus database is not configured.',503,{code:'corpus_not_configured'});
 return Response.json(await runCorpusQuality({store}));
}
export const GET=withCronGate(withDb(withAuth(run,{action:'run',resource:()=>refs.intel()})));
export const POST=withDb(withAuth(run,{action:'run',resource:()=>refs.intel()}));
