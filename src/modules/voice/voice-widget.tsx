"use client";
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Mic, MicOff, X, Eye, MessageSquare, PhoneOff, RotateCcw, Check } from 'lucide-react';
import { ThinkingOrb, type OrbState } from '@/components/ui/thinking-orbs';
import { VoiceController } from './controller';
import type { VoicePhase, VoiceSession } from './shared';
import type { VoiceCapture } from './voice-launcher';
const STATES:Record<VoicePhase,OrbState>={idle:'breathing',connecting:'connecting',listening:'listening',thinking:'solving',acting:'working',speaking:'composing',paused:'breathing',error:'breathing'};
const LABELS:Record<VoicePhase,string>={idle:'Ready',connecting:'Connecting…',listening:'Listening',thinking:'Thinking',acting:'Working',speaking:'Speaking',paused:'Paused',error:'Try again'};
interface Line {role:'user'|'assistant';text:string}
function release(media:VoiceCapture){media.stream.getTracks().forEach(t=>t.stop());void media.context.close().catch(()=>{});}
export default function VoiceWidget({capture,onClose,onRetry}:{capture:Promise<VoiceCapture>;onClose:()=>void;onRetry:()=>void}){
  const router=useRouter();const routerRef=React.useRef(router);routerRef.current=router;
  const [phase,setPhase]=React.useState<VoicePhase>('connecting');const [error,setError]=React.useState('');
  const [vision,setVision]=React.useState(false);const visionRef=React.useRef(false);
  const [transcript,setTranscript]=React.useState('');const [lines,setLines]=React.useState<Line[]>([]);
  const [pending,setPending]=React.useState<string|null>(null);const [expanded,setExpanded]=React.useState(false);
  const [expires,setExpires]=React.useState(0);const [now,setNow]=React.useState(Date.now());
  const agent=React.useRef<VoiceController|null>(null);
  React.useEffect(()=>{
    let disposed=false;let started=false;const ac=new AbortController();
    const controller=new VoiceController({navigate:href=>routerRef.current.push(href),prefetch:href=>routerRef.current.prefetch(href),phase:p=>{if(!disposed)setPhase(p);},error:message=>{if(!disposed)setError(message);},transcript:text=>{if(!disposed)setTranscript(text);},line:(role,text)=>{if(!disposed)setLines(old=>[...old,{role,text}].slice(-100));},confirmation:label=>{if(!disposed)setPending(label);},vision:()=>visionRef.current});
    agent.current=controller;
    // Defer one microtask so StrictMode's discarded effect never owns microphone resources.
    void Promise.resolve().then(async()=>{
      if(disposed)return;started=true;setPhase('connecting');setError('');setLines([]);setExpires(0);
      const sessionRequest=fetch('/api/voice/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:ac.signal}).then(async response=>{const body=await response.json();if(!response.ok)throw new Error(body.error||'Could not connect. Try again.');return body as VoiceSession;});
      const [media,session]=await Promise.all([capture,sessionRequest]);
      if(disposed){release(media);return;}
      setExpires(session.expiresAt);setNow(Date.now());await controller.start(session,media.context,media.stream);
    }).catch(error=>{
      if(disposed)return;ac.abort();controller.stop();void capture.then(release).catch(()=>{});
      setPhase('error');setError(error.name==='NotAllowedError'?'Allow microphone access, then retry.':error.message||'Could not connect.');
    });
    return()=>{disposed=true;ac.abort();controller.stop();if(started)void capture.then(release).catch(()=>{});};
  },[capture]);
  React.useEffect(()=>{if(!expires)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[expires]);
  const seconds=Math.max(0,Math.ceil((expires-now)/1000));const clock=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  const live=phase!=='idle'&&phase!=='error';
  const close=()=>{agent.current?.stop();onClose();};
  const toggleVision=()=>{visionRef.current=!visionRef.current;setVision(visionRef.current);};
  const button='flex size-8 shrink-0 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40';
  return <div data-voice-ui className="fixed bottom-5 right-5 z-[70] max-w-[calc(100vw-1.5rem)] font-sans max-sm:bottom-3 max-sm:right-3" style={{animation:'skylar-in 180ms ease-out'}}>
    <style>{'@keyframes skylar-in{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}@media(prefers-reduced-motion:reduce){[data-voice-ui]{animation:none!important}}'}</style>
    {pending&&<section className="mb-2 ml-auto w-72 max-w-full rounded-2xl border bg-background p-3.5 shadow-lg" aria-label="Confirm voice action"><p className="text-xs leading-relaxed">{pending}</p><div className="mt-3 flex justify-end gap-2"><button onClick={()=>agent.current?.answerConfirmation(false)} className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">Cancel</button><button onClick={()=>agent.current?.answerConfirmation(true)} className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground"><Check className="size-3"/>Confirm</button></div></section>}
    {expanded&&<section className="mb-2 ml-auto w-[310px] max-w-full overflow-hidden rounded-2xl border bg-background/95 shadow-xl backdrop-blur-xl" aria-label="Voice conversation"><div className="flex items-center justify-between px-4 py-3"><span className="text-xs font-medium">Conversation</span><button onClick={()=>setExpanded(false)} aria-label="Hide transcript" className="rounded-full p-1 text-muted-foreground hover:bg-muted"><X className="size-3.5"/></button></div><div className="max-h-[35vh] space-y-3 overflow-y-auto px-4 pb-4">{lines.map((line,i)=><div key={i} className={line.role==='user'?'ml-8 rounded-xl bg-muted px-3 py-2 text-xs leading-relaxed':'mr-4 text-xs leading-relaxed text-foreground/85'}>{line.text}</div>)}{transcript&&<div className="ml-8 text-xs text-muted-foreground">{transcript}</div>}{!lines.length&&!transcript&&<p className="py-2 text-xs text-muted-foreground">What would you like to do?</p>}</div></section>}
    {error&&<div role="alert" className="mb-2 ml-auto flex w-[290px] max-w-full items-start gap-2 rounded-xl border bg-background px-3 py-2.5 text-xs leading-relaxed shadow-lg"><span className="min-w-0 flex-1">{error}</span><button aria-label="Dismiss voice message" onClick={()=>setError('')} className="shrink-0 p-0.5 text-muted-foreground"><X className="size-3"/></button></div>}
    <div className="flex h-16 items-center gap-0.5 rounded-full border border-white/[.09] bg-[#1c1e23]/95 pl-1 pr-2 text-white backdrop-blur-xl" style={{boxShadow:'0 10px 35px rgba(15,23,42,.2),inset 0 1px 0 rgba(255,255,255,.04)'}}>
      <button onClick={()=>setExpanded(v=>!v)} aria-label="Toggle voice conversation" className="flex size-14 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/40 [&_canvas]:!size-12"><ThinkingOrb state={STATES[phase]} size={64} theme="dark" paused={phase==='paused'}/></button>
      <div className="min-w-[76px] pr-2"><div className="text-[13px] font-medium tracking-[-.01em]">Skylar</div><div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[10px] text-white/45" role="status"><span>{LABELS[phase]}</span>{live&&expires>now&&<span className="tabular-nums text-white/25">{clock}</span>}</div></div>
      {live?<button onClick={()=>agent.current?.mute(phase!=='paused')} className={button} aria-label={phase==='paused'?'Resume microphone':'Pause microphone'} title={phase==='paused'?'Resume microphone':'Pause microphone'}>{phase==='paused'?<MicOff className="size-[15px] text-white"/>:<Mic className="size-[15px]"/>}</button>:<button onClick={onRetry} className={button} aria-label="Retry voice connection" title="Reconnect"><RotateCcw className="size-[15px]"/></button>}
      <button onClick={toggleVision} className={button+(vision?' bg-white/10 text-white':'')} aria-label="Screen vision" aria-pressed={vision} title={vision?'Screen vision on — click to disable':'Enable screen vision'}><Eye className="size-[15px]"/></button>
      <button onClick={()=>setExpanded(v=>!v)} className={button+(expanded?' text-white':'')} aria-label={expanded?'Hide transcript':'Show transcript'} aria-expanded={expanded} title="Conversation"><MessageSquare className="size-[14px]"/></button>
      <span className="mx-1 h-4 w-px bg-white/10"/>
      <button onClick={close} aria-label="End voice session" title="End conversation" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/[.07] text-white/70 transition-colors hover:bg-red-400/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"><PhoneOff className="size-[14px]"/></button>
    </div>
  </div>;
}
