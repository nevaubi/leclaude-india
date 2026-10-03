/* Microphone only: downsample to 16 kHz PCM16 and emit 100 ms frames. */
class VoicePCM extends AudioWorkletProcessor {
  constructor() { super(); this.buffer=new Int16Array(1600); this.index=0; this.phase=0; this.sum=0; this.count=0; }
  process(inputs) {
    const channel=inputs[0] && inputs[0][0]; if(!channel) return true;
    for(let i=0;i<channel.length;i++) {
      this.sum+=channel[i]; this.count++; this.phase+=16000;
      if(this.phase>=sampleRate) {
        this.phase-=sampleRate; const s=Math.max(-1,Math.min(1,this.sum/this.count));
        this.buffer[this.index++]=s<0?s*32768:s*32767; this.sum=0; this.count=0;
        if(this.index===1600) { this.port.postMessage(this.buffer.buffer,[this.buffer.buffer]); this.buffer=new Int16Array(1600); this.index=0; }
      }
    }
    return true;
  }
}
registerProcessor('voice-pcm',VoicePCM);
