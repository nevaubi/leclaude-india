import {afterEach,describe,expect,it,vi} from 'vitest';
import type {VoiceSession} from '@/modules/voice/shared';
const test=vi.hoisted(()=>({audio:[] as Array<{event:(e:unknown)=>void;stop:ReturnType<typeof vi.fn>;sendToolResult:ReturnType<typeof vi.fn>;mute:ReturnType<typeof vi.fn>}>}));
vi.mock('@/modules/voice/audio',()=>({VoiceAudio:class {stop=vi.fn();sendToolResult=vi.fn();mute=vi.fn();interrupt=vi.fn();constructor(_s:unknown,_a:unknown,_m:unknown,public event:(e:unknown)=>void){test.audio.push(this);}async start(){}}}));
vi.mock('@/modules/voice/screen',()=>({observeScreen:()=>({path:'/judges',title:'Judges',text:'Judges directory',targets:[],visionAllowed:false}),executeAction:vi.fn(async()=>({ok:true,message:'Opened /judges'}))}));
import {VoiceController} from '@/modules/voice/controller';
const fixture=()=>{test.audio=[];const cb={navigate:vi.fn(),prefetch:vi.fn(),phase:vi.fn(),error:vi.fn(),transcript:vi.fn(),line:vi.fn(),confirmation:vi.fn(),vision:()=>false};const controller=new VoiceController(cb);const session={token:'ticket',accessToken:'temporary',agentId:'agent_test',transport:'managed',version:'2026-08-14',sampleRate:24000,audioFormat:'pcm_24000',expiresAt:Date.now()+900000} as VoiceSession;return {cb,controller,session};};
afterEach(()=>vi.useRealTimers());
describe('persistent managed voice lifecycle',()=>{
 it('retains one connection across repeated user and assistant turns and sends no per-turn LLM request',async()=>{
   const f=fixture();await f.controller.start(f.session,{} as AudioContext,{} as MediaStream);
   const ws=test.audio[0];for(let turn=1;turn<=6;turn++)ws.event({type:'turn_ended',turn,role:turn%2?'user':'assistant',text:'message '+turn});
   expect(f.cb.line).toHaveBeenCalledTimes(6);expect(test.audio).toHaveLength(1);expect(ws.stop).not.toHaveBeenCalled();f.controller.stop();
 });
 it('returns tool results with the original ID and remains available for the next turn',async()=>{
   const f=fixture();await f.controller.start(f.session,{} as AudioContext,{} as MediaStream);const ws=test.audio[0];
   ws.event({type:'client_tool_call',tool_call_id:'call-one',tool_name:'read_screen',parameters:{},expects_response:true});
   await vi.waitFor(()=>expect(ws.sendToolResult).toHaveBeenCalledWith('call-one',expect.stringContaining('/judges'),false));
   ws.event({type:'turn_ended',turn:5,role:'user',text:'Now go back'});expect(f.cb.line).toHaveBeenLastCalledWith('user','Now go back');f.controller.stop();
 });
 it('ends at fifteen minutes, not after the first response',async()=>{
   vi.useFakeTimers();const f=fixture();await f.controller.start(f.session,{} as AudioContext,{} as MediaStream);const ws=test.audio[0];
   await vi.advanceTimersByTimeAsync(899999);expect(ws.stop).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(ws.stop).toHaveBeenCalledOnce();expect(f.cb.error).toHaveBeenCalledWith('Your 15-minute session has ended.');
 });
 it('ends a server-closed call without reconnecting into a different conversation',async()=>{
   const f=fixture();await f.controller.start(f.session,{} as AudioContext,{} as MediaStream);test.audio[0].event({type:'session_closed',code:1000});
   expect(test.audio[0].stop).toHaveBeenCalledOnce();expect(test.audio).toHaveLength(1);expect(f.cb.error).not.toHaveBeenCalled();
 });
});
