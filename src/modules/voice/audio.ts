import type { VoiceSession } from './shared';
export interface TurnEvent { type: string; transcript?: string; message?: string }
export class VoiceAudio {
  private stt: WebSocket | null = null;
  private tts: WebSocket | null = null;
  private input: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private contextId: string | null = null;
  private cursor = 0;
  private generationDone = true;
  private closed = false;
  private retries = { stt: 0, tts: 0 };
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  constructor(private session: VoiceSession, private audio: AudioContext, private stream: MediaStream,
    private onTurn: (event: TurnEvent) => void, private onSpeaking: (active: boolean) => void,
    private onError: (message: string) => void) {}
  async start() {
    await Promise.all([this.open('stt'),this.open('tts'),this.audio.audioWorklet.addModule('/vendor/voice-pcm.js')]);
    if(this.closed) return;
    this.input=this.audio.createMediaStreamSource(this.stream);
    this.worklet=new AudioWorkletNode(this.audio,'voice-pcm'); this.gain=this.audio.createGain(); this.gain.gain.value=0;
    this.worklet.port.onmessage=e=>{ if(!this.closed && this.stt?.readyState===WebSocket.OPEN && this.stt.bufferedAmount<128000) this.stt.send(e.data); };
    this.input.connect(this.worklet); this.worklet.connect(this.gain); this.gain.connect(this.audio.destination);
  }
  private async open(kind: 'stt'|'tts'): Promise<void> {
    const query=new URLSearchParams({access_token:this.session.accessToken,cartesia_version:this.session.version});
    if(kind==='stt') {
      query.set('model',this.session.sttModel); query.set('encoding','pcm_s16le'); query.set('sample_rate','16000');
      query.set('turn_end_timeout_ms','1000');
      for(const word of ['Pramana','Skylar','BNSS','NCLT','BNS','Supreme Court','High Court'])query.append('keyterm',word);
    }
    const socket=new WebSocket('wss://api.cartesia.ai/'+(kind==='stt'?'stt/turns':'tts')+'/websocket?'+query);
    if(kind==='stt')this.stt=socket;else this.tts=socket;
    socket.onmessage=e=>{ try {
      const event=JSON.parse(String(e.data));
      if(this.closed)return;
      if(event.type==='error') { this.onError(event.message||'Voice service error.'); return; }
      if(kind==='stt'){this.onTurn(event);return;}
      if(event.context_id!==this.contextId)return;
      if(event.type==='chunk'&&typeof event.data==='string')this.play(event.data);
      if(event.type==='done'){this.generationDone=true;if(!this.sources.size)this.onSpeaking(false);}
    } catch { this.onError('The voice service returned an unreadable message.'); } };
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.close();reject(new Error('Voice connection timed out.'));},12000);
      socket.onopen=()=>{clearTimeout(timer);resolve();};
      socket.onerror=()=>{clearTimeout(timer);reject(new Error('Could not connect to Cartesia. Check the connection and API access.'));};
      socket.onclose=()=>{clearTimeout(timer);reject(new Error('Voice connection closed.'));};
    });
    socket.onerror=()=>{};
    socket.onclose=()=>{
      if(this.closed)return;
      if(Date.now()>=this.session.expiresAt||this.retries[kind]>=2){this.onError('Voice connection ended. Stop and start a new session.');return;}
      this.retries[kind]++;
      const timer=setTimeout(()=>{this.reconnectTimers.delete(timer);if(!this.closed)void this.open(kind).catch(e=>this.onError(e.message));},350*this.retries[kind]);
      this.reconnectTimers.add(timer);
    };
  }
  speak(text: string) {
    if(this.closed||!text.trim())return;
    if(this.tts?.readyState!==WebSocket.OPEN){this.onError('Speech connection is reconnecting. Please try again.');return;}
    this.contextId ??= crypto.randomUUID(); this.generationDone=false;
    this.tts.send(JSON.stringify({model_id:this.session.ttsModel,transcript:text,voice:this.session.voiceId,context_id:this.contextId,output_format:{container:'raw',encoding:'pcm_s16le',sample_rate:24000},continue:true}));
  }
  finishSpeech() {
    if(!this.contextId||this.tts?.readyState!==WebSocket.OPEN)return;
    this.tts.send(JSON.stringify({model_id:this.session.ttsModel,transcript:'',voice:this.session.voiceId,context_id:this.contextId,output_format:{container:'raw',encoding:'pcm_s16le',sample_rate:24000},continue:false}));
  }
  private play(base64: string) {
    const raw=atob(base64);const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    const view=new DataView(bytes.buffer);const buffer=this.audio.createBuffer(1,Math.floor(bytes.length/2),24000);
    const floats=buffer.getChannelData(0);for(let i=0;i<floats.length;i++)floats[i]=view.getInt16(i*2,true)/32768;
    const source=this.audio.createBufferSource();source.buffer=buffer;source.connect(this.audio.destination);
    this.cursor=Math.max(this.audio.currentTime+0.025,this.cursor);source.start(this.cursor);this.cursor+=buffer.duration;
    this.sources.add(source);this.onSpeaking(true);
    source.onended=()=>{this.sources.delete(source);source.disconnect();if(!this.sources.size&&this.generationDone)this.onSpeaking(false);};
  }
  interrupt() {
    if(this.contextId&&this.tts?.readyState===WebSocket.OPEN)this.tts.send(JSON.stringify({context_id:this.contextId,cancel:true}));
    this.contextId=null;this.generationDone=true;for(const source of this.sources){source.onended=null;try{source.stop();source.disconnect();}catch{}}this.sources.clear();this.cursor=0;this.onSpeaking(false);
  }
  mute(value: boolean) { for(const track of this.stream.getAudioTracks())track.enabled=!value; }
  stop() {
    if(this.closed)return;this.closed=true;this.interrupt();
    for(const timer of this.reconnectTimers)clearTimeout(timer);this.reconnectTimers.clear();
    if(this.stt?.readyState===WebSocket.OPEN)this.stt.send(JSON.stringify({type:'close'}));
    this.stt?.close();this.tts?.close();this.input?.disconnect();this.worklet?.disconnect();this.gain?.disconnect();
    for(const track of this.stream.getTracks())track.stop();void this.audio.close().catch(()=>{});
  }
}
