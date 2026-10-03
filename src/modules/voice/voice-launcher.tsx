"use client";
import * as React from 'react';
import dynamic from 'next/dynamic';
import { Mic, Loader2 } from 'lucide-react';
const VoiceWidget=dynamic(()=>import('./voice-widget'),{ssr:false,loading:()=> <div data-voice-ui className="fixed bottom-5 right-5 z-[70] flex size-14 items-center justify-center rounded-full border bg-background shadow-xl" role="status" aria-label="Loading voice assistant"><Loader2 className="size-5 animate-spin"/></div>});
export function VoiceLauncher(){
  const [open,setOpen]=React.useState(false);
  const [ready,setReady]=React.useState(false);React.useEffect(()=>setReady(true),[]);
  if(open)return <VoiceWidget onClose={()=>setOpen(false)}/>;
  return <button data-voice-ui disabled={!ready} onClick={()=>setOpen(true)} onPointerEnter={()=>void import('./voice-widget')} aria-label="Talk to Skylar, your AI voice assistant" title="Talk to Skylar" className="fixed bottom-5 right-5 z-[60] flex size-13 items-center justify-center rounded-full border border-border/70 bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transform-none max-sm:bottom-3 max-sm:right-3"><Mic className="size-5" strokeWidth={1.8}/></button>;
}
