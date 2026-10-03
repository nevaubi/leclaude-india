import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceAudio } from '@/modules/voice/audio';
import type { VoiceSession } from '@/modules/voice/shared';
class Socket {
  static OPEN=1; static instances:Socket[]=[]; readyState=0; bufferedAmount=0; sent:string[]=[];
  onopen:(()=>void)|null=null; onmessage:((e:{data:string})=>void)|null=null; onclose:((e:{code:number;reason:string})=>void)|null=null; onerror:(()=>void)|null=null;
  constructor(public url:string){Socket.instances.push(this);}
  send(data:string){this.sent.push(data);} close(code=1000,reason=''){this.readyState=3;this.onclose?.({code,reason});}
  open(){this.readyState=1;this.onopen?.();} emit(event:unknown){this.onmessage?.({data:JSON.stringify(event)});}
}
function fixture(){
  Socket.instances=[];vi.stubGlobal('WebSocket',Socket);
  const connect=()=>({connect:vi.fn(),disconnect:vi.fn()});const worklet={...connect(),port:{onmessage:null as null|((e:{data:ArrayBuffer})=>void)}};
  vi.stubGlobal('AudioWorkletNode',class {constructor(){return worklet;}});
  const track={stop:vi.fn(),enabled:true};const stream={getTracks:()=>[track],getAudioTracks:()=>[track]} as unknown as MediaStream;
  const sources:Array<{stop:ReturnType<typeof vi.fn>;onended:(()=>void)|null}>=[];
  const audio={state:'running',currentTime:0,audioWorklet:{addModule:vi.fn().mockResolvedValue(undefined)},destination:{},createMediaStreamSource:connect,createGain:()=>({...connect(),gain:{value:1}}),resume:vi.fn().mockResolvedValue(undefined),close:vi.fn().mockResolvedValue(undefined),createBuffer:vi.fn((_c:number,n:number,rate:number)=>({duration:n/rate,getChannelData:()=>new Float32Array(n)})),createBufferSource:()=>{const s={...connect(),buffer:null,start:vi.fn(),stop:vi.fn(),onended:null as null|(()=>void)};sources.push(s);return s;}};
  const events=vi.fn(),speaking=vi.fn(),error=vi.fn();
  const session={token:'ticket',accessToken:'temporary',expiresAt:Date.now()+900000,agentId:'agent_test',transport:'managed',version:'2026-08-14',sampleRate:24000,audioFormat:'pcm_24000'} as unknown as VoiceSession;
  const client=new VoiceAudio(session,audio as unknown as AudioContext,stream,events,speaking,error);
  return {client,worklet,audio,track,events,speaking,error,sources};
}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe('Cartesia managed conversation protocol',()=>{
  it('uses one agent socket and waits for session_ready before streaming JSON PCM frames',async()=>{
    const f=fixture();const start=f.client.start();void start.catch(()=>{});
    try {
      expect(Socket.instances).toHaveLength(1);const ws=Socket.instances[0];expect(ws.url).toContain('/v1/agents/websocket/agent_test');
      ws.open();expect(JSON.parse(ws.sent[0])).toMatchObject({type:'session_create',audio:{input_format:'pcm_24000'}});expect(JSON.parse(ws.sent[0])).not.toHaveProperty('dynamic_variables');
      ws.emit({type:'session_ready',call_id:'same-call',audio:{input_format:'pcm_24000'}});await start;
      f.worklet.port.onmessage?.({data:new Int16Array([0,100,-100]).buffer});expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({type:'audio_input',audio:expect.any(String)});
      for(let turn=1;turn<=4;turn++)ws.emit({type:'turn_ended',turn,role:turn%2?'user':'assistant',text:'turn '+turn});
      expect(f.events.mock.calls.filter(([e])=>e.type==='turn_ended')).toHaveLength(4);expect(Socket.instances).toHaveLength(1);
    } finally {f.client.stop();}
  });
  it('plays at the negotiated rate and clears queued audio immediately on interruption',async()=>{
    const f=fixture();const start=f.client.start();void start.catch(()=>{});try {
      expect(Socket.instances).toHaveLength(1);const ws=Socket.instances[0];ws.open();ws.emit({type:'session_ready',call_id:'call',audio:{input_format:'pcm_24000'}});await start;
      ws.emit({type:'audio_output',audio:Buffer.alloc(2400).toString('base64')});expect(f.audio.createBuffer).toHaveBeenCalledWith(1,1200,24000);
      ws.emit({type:'audio_output_clear'});expect(f.sources[0].stop).toHaveBeenCalled();expect(f.speaking).toHaveBeenLastCalledWith(false);
      ws.emit({type:'audio_output',audio:Buffer.alloc(2400).toString('base64')});expect(f.sources).toHaveLength(2);
    } finally {f.client.stop();}expect(f.track.stop).toHaveBeenCalled();
  });
});
