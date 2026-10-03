import 'server-only';
export const VOYAGE_MODEL='voyage-context-4';
export const VOYAGE_DIMS=1024;
export interface VoyageConfig {apiKey:string;model:string}
/** Server-only environment; this override applies to the public corpus, never private matter documents. */
export async function voyageConfig():Promise<VoyageConfig|null>{
 const apiKey=process.env.VOYAGE_API_KEY?.trim();
 return apiKey?{apiKey,model:process.env.VOYAGE_EMBEDDING_MODEL?.trim()||VOYAGE_MODEL}:null;
}
export interface VoyageOptions extends VoyageConfig {query?:boolean;signal?:AbortSignal;fetchImpl?:typeof fetch}
type Part={index:number;embedding:number[]};
type Answer={model?:string;data?:{index:number;data:Part[]}[];usage?:{total_tokens?:number}};
/** Each passage is an independent document: unrelated cases NEVER share context. Stable passage hashes remain sufficient for invalidation.
 * Context-4's single-embedding mode is deliberate; this is not a claim of whole-judgment contextualization.
 * Existing citation/page boundaries are unchanged and no input is silently truncated. */
export async function voyageEmbedPassages(texts:string[],o:VoyageOptions):Promise<Float32Array[]>{
 if(!texts.length)return [];
 if(o.model!==VOYAGE_MODEL)throw new Error('Unsupported public corpus embedding model: '+o.model);
 const batches:string[][]=[];let current:string[]=[],bytes=0;
 for(const text of texts){const n=Buffer.byteLength(text,'utf8');if(!text.trim()||n>28000)throw new Error('voyage: passage exceeds the safe input limit or is empty; not truncated');
  if(current.length&&(bytes+n>28000||current.length>=64)){batches.push(current);current=[];bytes=0;}current.push(text);bytes+=n;
 }if(current.length)batches.push(current);
 const out:Float32Array[]=[];
 for(const batch of batches){
  o.signal?.throwIfAborted();const t0=Date.now();const timeout=AbortSignal.timeout(o.query?8000:20000);const signal=o.signal?AbortSignal.any([o.signal,timeout]):timeout;
  const response=await (o.fetchImpl??fetch)('https://api.voyageai.com/v1/contextualizedembeddings',{
   method:'POST',cache:'no-store',signal,headers:{'content-type':'application/json',authorization:'Bearer '+o.apiKey},
   body:JSON.stringify({model:o.model,inputs:batch.map(t=>[t]),input_type:o.query?'query':'document',output_dimension:VOYAGE_DIMS,output_dtype:'float',enable_auto_chunking:false})
  });
  if(!response.ok){const detail=await response.text().catch(()=>'');if(response.status===401||response.status===403)throw new Error('voyage: authentication failed');
   if(/insufficient.?quota|no credits|payment required|billing/i.test(detail))throw new Error('voyage: insufficient_quota');
   if(response.status===429)throw new Error('voyage: rate_limited; retry after '+Math.max(60,Number(response.headers.get('retry-after'))||60)+' seconds');
   throw new Error('voyage: HTTP '+response.status+'; no vectors stored');
  }
  const data=await response.json() as Answer;
  if(data.model!==o.model)throw new Error('voyage: response model mismatch');
  if(!Array.isArray(data.data)||data.data.length!==batch.length)throw new Error('voyage: vector count mismatch');
  const ordered=new Map(data.data.map(x=>[x.index,x]));
  if(ordered.size!==batch.length)throw new Error('voyage: duplicate vector indices');
  for(let i=0;i<batch.length;i++){const part=ordered.get(i)?.data;if(!part||part.length!==1||part[0].index!==0)throw new Error('voyage: vector order mismatch');const v=part[0].embedding;
   if(!Array.isArray(v)||v.length!==VOYAGE_DIMS||!v.every(x=>typeof x==='number'&&Number.isFinite(x))||!v.some(x=>x!==0))throw new Error('voyage: invalid vector dimensions or values');
   out.push(new Float32Array(v));
  }
  if(!o.query)console.info(JSON.stringify({event:'corpus.embed.voyage',model:o.model,passages:batch.length,tokens:data.usage?.total_tokens??null,ms:Date.now()-t0}));
 }
 return out;
}
