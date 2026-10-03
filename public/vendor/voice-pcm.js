/* Resample the microphone to the negotiated mono PCM16 rate; emit short audio frames. */
class VoicePCM extends AudioWorkletProcessor {
  constructor(options) { super();const config=options.processorOptions||{};this.rate=config.sampleRate===24000?24000:16000;this.frame=Math.round(this.rate*(config.frameMs===50?0.05:0.1));this.buffer=new Int16Array(this.frame);this.index=0;this.phase=0;this.sum=0;this.count=0; }
  process(inputs) {
    const channel=inputs[0]&&inputs[0][0];if(!channel)return true;
    for(let i=0;i<channel.length;i++){
      this.sum+=channel[i];this.count++;this.phase+=this.rate;
      if(this.phase>=sampleRate){this.phase-=sampleRate;const s=Math.max(-1,Math.min(1,this.sum/this.count));this.buffer[this.index++]=s<0?s*32768:s*32767;this.sum=0;this.count=0;
        if(this.index===this.frame){this.port.postMessage(this.buffer.buffer,[this.buffer.buffer]);this.buffer=new Int16Array(this.frame);this.index=0;}}
    }return true;
  }
}
registerProcessor('voice-pcm',VoicePCM);
