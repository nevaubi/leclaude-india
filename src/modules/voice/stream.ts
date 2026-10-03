import { readSSE } from '@/lib/ai/sse';
import type { InferenceMessage } from '@/lib/ai/providers/types';
import { observeScreen } from './screen';
import type { VoiceAction, VoiceSession } from './shared';
export interface VoiceReply { type:'complete'; assistant:InferenceMessage; calls:VoiceAction[] }
type Event = VoiceReply | {type:'text';delta:string} | {type:'error';message:string};
export async function voiceRequest(session:VoiceSession,messages:InferenceMessage[],signal:AbortSignal,vision:boolean,onText?:(text:string)=>void,screenshot?:string,phase:'turn'|'anticipate'='turn'):Promise<VoiceReply> {
  const response=await fetch('/api/voice/turn',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal,body:JSON.stringify({token:session.token,phase,messages,screen:observeScreen(vision),...(screenshot?{screenshot}:{})})});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||'Voice request failed ('+response.status+').');}
  let result:VoiceReply|undefined;let error:string|undefined;
  await readSSE<Event>(response,event=>{if(event.type==='text')onText?.(event.delta);if(event.type==='complete')result=event;if(event.type==='error')error=event.message;},signal);
  if(signal.aborted)throw new DOMException('Cancelled','AbortError');
  if(error)throw new Error(error);if(!result)throw new Error('The voice response ended early. Please try again.');return result;
}
