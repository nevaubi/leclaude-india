import type { VoiceSession } from './shared';
import { boundedUtf8 } from './managed-context';
export interface TurnEvent { type:string; role?:'user'|'assistant'; turn?:number; text?:string; interrupted?:boolean; call_id?:string; tool_call_id?:string; tool_name?:string; parameters?:Record<string,unknown>; expects_response?:boolean; message?:string; fatal?:boolean; code?:string|number }
/** One Managed Agent socket owns the whole conversation. Never recreate it between turns. */
export class VoiceAudio {
  private socket:WebSocket|null=null;private input:MediaStreamAudioSourceNode|null=null;private worklet:AudioWorkletNode|null=null;private gain:GainNode|null=null;
  private sources=new Set<AudioBufferSourceNode>();private cursor=0;private closed=false;private ready=false;private muted=false;
  private heartbeat:ReturnType<typeof setInterval>|null=null;private lastInput=0;private startupTimer:ReturnType<typeof setTimeout>|null=null;private rejectStartup:((e:Error)=>void)|null=null;
  constructor(private session:VoiceSession,private audio:AudioContext,private stream:MediaStream,private onTurn:(event:TurnEvent)=>void,private onSpeaking:(active:boolean)=>void,private onError:(message:string)=>void){}
  async start():Promise<void>{
    if(!this.session.agentId)throw new Error('Voice agent is not configured.');
    const query=new URLSearchParams({access_token:this.session.accessToken,cartesia_version:this.session.version});
    const ws=new WebSocket('wss://api.cartesia.ai/v1/agents/websocket/'+encodeURIComponent(this.session.agentId)+'?'+query);this.socket=ws;
    const connected=new Promise<void>((resolve,reject)=>{
      this.rejectStartup=reject;this.startupTimer=setTimeout(()=>this.fail('Voice connection timed out.'),20000);
      ws.onopen=()=>{if(this.closed)return;ws.send(JSON.stringify({type:'session_create',audio:{input_format:'pcm_24000',output_delivery:'as_available'}}));};
      ws.onerror=()=>this.fail('Could not connect to the voice agent.');
      ws.onclose=e=>{if(this.closed)return;if(!this.ready){this.fail('Voice connection closed before it was ready.');return;}this.ready=false;this.onTurn({type:'session_closed',code:e.code,message:e.code===1000?'':'Voice connection interrupted. Reconnect to start another call.'});};
      ws.onmessage=e=>{
        if(this.closed)return;let event:TurnEvent&{audio?:string|{input_format?:string}};
        try{event=JSON.parse(String(e.data));}catch{this.fail('Voice service returned an invalid event.');return;}
        if(event.type==='error'){if(event.fatal!==false)this.fail(event.message||'Voice service error.');else this.onTurn(event);return;}
        if(event.type==='session_ready'){
          if(typeof event.audio==='object'&&event.audio.input_format!=='pcm_24000'){this.fail('Voice audio format did not match.');return;}
          this.ready=true;this.clearStartup();this.rejectStartup=null;this.onTurn(event);resolve();return;
        }
        if(event.type==='audio_output'&&typeof event.audio==='string'){if(!this.muted)this.play(event.audio);return;}
        if(event.type==='audio_output_clear')this.interrupt();
        this.onTurn(event);
      };
    });
    await Promise.all([connected,this.audio.audioWorklet.addModule('/vendor/voice-pcm.js')]);
    if(this.closed)return;
    this.input=this.audio.createMediaStreamSource(this.stream);
    this.worklet=new AudioWorkletNode(this.audio,'voice-pcm',{processorOptions:{sampleRate:24000,frameMs:50}});
    this.gain=this.audio.createGain();this.gain.gain.value=0;
    this.worklet.port.onmessage=e=>this.sendAudio(e.data as ArrayBuffer);
    this.input.connect(this.worklet);this.worklet.connect(this.gain);this.gain.connect(this.audio.destination);
    // A valid silent audio event keeps transport alive if the browser temporarily suspends its AudioContext.
    this.heartbeat=setInterval(()=>{if(Date.now()-this.lastInput>1000)this.sendAudio(new ArrayBuffer(2400));},1000);
  }
  private clearStartup(){if(this.startupTimer)clearTimeout(this.startupTimer);this.startupTimer=null;}
  private fail(message:string){const reject=this.rejectStartup;this.rejectStartup=null;this.clearStartup();reject?.(new Error(message));this.onError(message);this.stop();}
  private sendAudio(buffer:ArrayBuffer){
    const ws=this.socket;if(this.closed||!this.ready||ws?.readyState!==WebSocket.OPEN)return;
    if(ws.bufferedAmount>256000){this.fail('Voice connection is too slow. Please reconnect.');return;}
    const bytes=this.muted?new Uint8Array(buffer.byteLength):new Uint8Array(buffer);let raw='';for(let i=0;i<bytes.length;i++)raw+=String.fromCharCode(bytes[i]);
    ws.send(JSON.stringify({type:'audio_input',audio:btoa(raw)}));this.lastInput=Date.now();
  }
  sendToolResult(id:string,result:string,isError=false){
    if(this.closed||!this.ready||this.socket?.readyState!==WebSocket.OPEN)return;
    this.socket.send(JSON.stringify({type:'client_tool_result',tool_call_id:id,result:boundedUtf8(result,4096),is_error:isError}));
  }
  private play(base64:string){
    try{
      const raw=atob(base64);if(raw.length%2)throw new Error('unaligned PCM');const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
      const view=new DataView(bytes.buffer);const buffer=this.audio.createBuffer(1,bytes.length/2,24000);const floats=buffer.getChannelData(0);
      for(let i=0;i<floats.length;i++)floats[i]=view.getInt16(i*2,true)/32768;
      const source=this.audio.createBufferSource();source.buffer=buffer;source.connect(this.audio.destination);this.cursor=Math.max(this.audio.currentTime+0.02,this.cursor);
      source.onended=()=>{this.sources.delete(source);source.disconnect();if(!this.sources.size)this.onSpeaking(false);};
      this.sources.add(source);source.start(this.cursor);this.cursor+=buffer.duration;this.onSpeaking(true);
    }catch{this.fail('Voice audio could not be decoded.');}
  }
  interrupt(){for(const source of this.sources){source.onended=null;try{source.stop();source.disconnect();}catch{}}this.sources.clear();this.cursor=0;this.onSpeaking(false);}
  mute(value:boolean){this.muted=value;for(const track of this.stream.getAudioTracks())track.enabled=!value;if(value)this.interrupt();}
  stop(){
    if(this.closed)return;this.closed=true;this.ready=false;this.clearStartup();this.rejectStartup?.(new Error('Voice session stopped.'));this.rejectStartup=null;
    if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=null;this.interrupt();this.socket?.close(1000,'session completed');
    if(this.worklet)this.worklet.port.onmessage=null;this.input?.disconnect();this.worklet?.disconnect();this.gain?.disconnect();
    for(const track of this.stream.getTracks())track.stop();void this.audio.close().catch(()=>{});
  }
}
