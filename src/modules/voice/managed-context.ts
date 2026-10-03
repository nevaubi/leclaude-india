import { redactSecrets, type ScreenContext } from './shared';
/** Cartesia client-tool results are limited by UTF-8 bytes, not JavaScript characters. */
export function boundedUtf8(value:string,max=3900):string {
  const bytes=new TextEncoder().encode(value);return bytes.length<=max?value:new TextDecoder('utf-8',{fatal:false}).decode(bytes.subarray(0,max-3)).replace(/\uFFFD$/,'')+'…';
}
export function compactScreen(screen:ScreenContext,query='',offset=0):string {
  const terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);const all=screen.targets.filter(t=>!terms.length||terms.every(word=>(t.label+' '+t.role).toLowerCase().includes(word)));
  const start=Math.max(0,Math.floor(Number(offset)||0));let take=Math.min(18,Math.max(0,all.length-start));
  for(;;){
    const result={path:screen.path,title:screen.title,visionAllowed:screen.visionAllowed,text:screen.text.slice(0,query?700:1100),targets:all.slice(start,start+take).map(t=>({...t,label:t.label.slice(0,120),value:t.value?.slice(0,100)})),total:all.length,nextOffset:start+take<all.length?start+take:null};
    const encoded=redactSecrets(JSON.stringify(result));if(new TextEncoder().encode(encoded).length<=3800)return encoded;
    if(take>0){take--;continue;}return JSON.stringify({path:screen.path,text:boundedUtf8(screen.text,1800),targets:[],total:all.length,nextOffset:null});
  }
}
