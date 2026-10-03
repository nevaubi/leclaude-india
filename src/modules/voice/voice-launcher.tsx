"use client";
import * as React from 'react';
import dynamic from 'next/dynamic';
import { Mic, Loader2 } from 'lucide-react';
export interface VoiceCapture { context: AudioContext; stream: MediaStream }
const VoiceWidget=dynamic(()=>import('./voice-widget'),{ssr:false,loading:()=> <div data-voice-ui role="status" aria-label="Connecting Skylar" className="fixed bottom-5 right-5 z-[70] flex h-16 items-center gap-3 rounded-full bg-[#1c1e23] px-5 text-white shadow-xl"><Loader2 className="size-5 animate-spin text-white/65"/><span className="text-xs">Connecting…</span></div>});
export function VoiceLauncher(){
  const [call,setCall]=React.useState<{capture:Promise<VoiceCapture>}|null>(null);
  const [ready,setReady]=React.useState(false);React.useEffect(()=>setReady(true),[]);
  const begin=()=>{
    let context:AudioContext|undefined;
    let capture:Promise<VoiceCapture>;
    try{
      if(!navigator.mediaDevices?.getUserMedia||!window.AudioContext)throw new Error('Microphone unavailable in this browser.');
      context=new AudioContext();
      // Both permissions and audio activation begin in the original button gesture.
      const resume=context.resume();const audio=context;
      capture=navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}).then(async stream=>{
        try{await resume;return {context:audio,stream};}catch(error){stream.getTracks().forEach(track=>track.stop());throw error;}
      }).catch(error=>{void audio.close().catch(()=>{});throw error;});
    }catch(error){void context?.close().catch(()=>{});capture=Promise.reject(error);}
    void capture.catch(()=>{});setCall({capture});
  };
  if(call)return <VoiceWidget capture={call.capture} onRetry={begin} onClose={()=>setCall(null)}/>;
  return <button data-voice-ui disabled={!ready} onClick={begin} onPointerEnter={()=>void import('./voice-widget')} onFocus={()=>void import('./voice-widget')} aria-label="Talk to Skylar, your AI voice assistant" title="Talk to Skylar" className="group fixed bottom-5 right-5 z-[60] flex size-14 items-center justify-center rounded-full border border-white/10 bg-[#1c1e23] text-white shadow-[0_8px_28px_rgba(15,23,42,0.18)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#272a31] hover:shadow-[0_12px_32px_rgba(15,23,42,0.24)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 motion-reduce:transform-none max-sm:bottom-3 max-sm:right-3"><Mic className="size-[21px] text-white/90" strokeWidth={1.7}/></button>;
}
