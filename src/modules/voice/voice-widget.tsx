"use client";
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Mic, MicOff, X, ChevronUp, ChevronDown, Eye, ShieldCheck, Loader2, Square, Check } from 'lucide-react';
import { ThinkingOrb, type OrbState } from '@/components/ui/thinking-orbs';
import { VoiceController } from './controller';
import type { VoicePhase, VoiceSession } from './shared';
const STATES:Record<VoicePhase,OrbState>={idle:'breathing',connecting:'connecting',listening:'listening',thinking:'solving',acting:'working',speaking:'composing',paused:'breathing',error:'breathing'};
const LABELS:Record<VoicePhase,string>={idle:'Ready',connecting:'Connecting',listening:'Listening',thinking:'Thinking',acting:'Working in your app',speaking:'Speaking',paused:'Microphone paused',error:'Connection issue'};
interface Config {configured:boolean;canConfigure:boolean;brainConfigured:boolean}
interface Line {role:'user'|'assistant';text:string}
export default function VoiceWidget({onClose}:{onClose:()=>void}) {
  const router=useRouter();const routerRef=React.useRef(router);routerRef.current=router;const [phase,setPhase]=React.useState<VoicePhase>('idle');
  const [config,setConfig]=React.useState<Config|null>(null);const [error,setError]=React.useState('');
  const [key,setKey]=React.useState('');const [saving,setSaving]=React.useState(false);
  const [vision,setVision]=React.useState(false);const visionRef=React.useRef(false);
  const [transcript,setTranscript]=React.useState('');const [lines,setLines]=React.useState<Line[]>([]);
  const [pending,setPending]=React.useState<string|null>(null);const [expanded,setExpanded]=React.useState(false);
  const [expires,setExpires]=React.useState(0);const [now,setNow]=React.useState(Date.now());
  const agent=React.useRef<VoiceController|null>(null);const starting=React.useRef(false);const mounted=React.useRef(true);const attempt=React.useRef(0);
  React.useEffect(()=>{
    const attempts=attempt;mounted.current=true;agent.current=new VoiceController({navigate:href=>routerRef.current.push(href),prefetch:href=>routerRef.current.prefetch(href),phase:setPhase,error:setError,transcript:setTranscript,
      line:(role,text)=>setLines(old=>[...old,{role,text}].slice(-100)),confirmation:setPending,vision:()=>visionRef.current});
    return()=>{mounted.current=false;attempts.current++;agent.current?.stop();};
  },[]);
  React.useEffect(()=>{let mounted=true;fetch('/api/voice/session',{cache:'no-store'}).then(async r=>{const b=await r.json();if(!r.ok)throw new Error(b.error||'Sign in to use voice.');if(mounted)setConfig(b);}).catch(e=>{if(mounted)setError(e.message);});return()=>{mounted=false;};},[]);
  React.useEffect(()=>{if(!expires)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[expires]);
  const setScreenVision=(value:boolean)=>{visionRef.current=value;setVision(value);};
  const connect=async()=>{
    setSaving(true);setError('');try{
      const r=await fetch('/api/voice/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key})});
      const b=await r.json();if(!r.ok)throw new Error(b.error||'Could not connect Cartesia.');setKey('');setConfig(c=>c?{...c,configured:true}:c);
    }catch(e){setError((e as Error).message);}finally{setSaving(false);}
  };
  const start=async()=>{
    if(starting.current)return;starting.current=true;const current=++attempt.current;setError('');setPhase('connecting');setLines([]);
    let stream:MediaStream|undefined;let context:AudioContext|undefined;
    try {
      if(!navigator.mediaDevices?.getUserMedia||!window.AudioContext)throw new Error('Voice needs a supported browser and a secure HTTPS connection.');
      context=new AudioContext();await context.resume();
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(!mounted.current||current!==attempt.current){stream.getTracks().forEach(t=>t.stop());await context.close();return;}
      const r=await fetch('/api/voice/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const b=await r.json();
      if(!r.ok)throw new Error(b.error||'Could not start voice.');
      if(!mounted.current||current!==attempt.current){stream.getTracks().forEach(t=>t.stop());await context.close();return;}
      const session=b as VoiceSession;setExpires(session.expiresAt);setNow(Date.now());
      await agent.current?.start(session,context,stream);
    }catch(e){agent.current?.stop();stream?.getTracks().forEach(t=>t.stop());void context?.close().catch(()=>{});setPhase('idle');setError((e as Error).name==='NotAllowedError'?'Microphone permission was declined. Allow microphone access and try again.':(e as Error).message);}
    finally{starting.current=false;}
  };
  const live=phase!=='idle'&&phase!=='error';const seconds=Math.max(0,Math.ceil((expires-now)/1000));
  const clock=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  const close=()=>{attempt.current++;agent.current?.stop();onClose();};
  const iconButton='flex size-8 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50';
  return <div data-voice-ui className="fixed bottom-5 right-5 z-[70] max-w-[calc(100vw-2rem)] font-sans max-sm:bottom-3 max-sm:right-3">
    {!live ? <section className="w-[340px] max-w-full rounded-2xl border bg-background p-5 shadow-2xl" aria-label="Skylar voice assistant">
      <div className="mb-3 flex items-start justify-between"><div><div className="text-[15px] font-semibold">Talk to Skylar</div><p className="mt-1 text-xs text-muted-foreground">Your AI guide to Pramana · up to 15 minutes</p></div><button onClick={close} aria-label="Close voice assistant" className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="size-4"/></button></div>
      <p className="text-xs leading-relaxed text-muted-foreground">Ask for help, navigate pages, find cases, or fill a field with your voice. You can interrupt at any time.</p>
      {!config&&!error&&<div className="my-3 flex items-center gap-2 text-xs"><Loader2 className="size-4 animate-spin"/>Checking connection…</div>}
      {config&&!config.configured&&<div data-private className="mt-4 rounded-lg border p-3">
        <div className="text-xs font-medium">Connect Cartesia</div>
        {config.canConfigure?<><p className="my-2 text-[11px] leading-relaxed text-muted-foreground">Paste your key once. It is encrypted on the server, never returned to the browser or committed to code.</p>
          <input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder="Cartesia API key" aria-label="Cartesia API key" className="h-9 w-full rounded-md border bg-background px-2.5 text-xs"/>
          <button onClick={()=>void connect()} disabled={saving||!key.trim()} className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded-md bg-primary text-xs text-primary-foreground disabled:opacity-50">{saving&&<Loader2 className="size-3 animate-spin"/>}{saving?'Connecting…':'Save connection'}</button>
        </>:<p className="mt-2 text-xs text-muted-foreground">Ask your workspace owner to connect Cartesia here, or set CARTESIA_API_KEY on the server.</p>}
      </div>}
      <label className="mt-4 flex cursor-pointer items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={vision} onChange={e=>setScreenVision(e.target.checked)}/><span>Enable screen vision<span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">Allow on-demand screenshots of this app when page text is not enough.</span></span></label>
      <div className="my-3 flex items-start gap-2 text-[10.5px] leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 size-3.5 shrink-0"/><span>Audio goes to Cartesia. Visible page context goes to your configured AI provider. No microphone audio or screenshots are saved by this feature.</span></div>
      {error&&<p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
      {config&&!config.brainConfigured&&<p className="mb-3 text-xs text-destructive">Configure an AI provider in Settings first.</p>}
      <button onClick={()=>void start()} disabled={!config?.configured||!config.brainConfigured} className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-primary text-sm font-medium text-primary-foreground disabled:opacity-40"><Mic className="size-4"/>Start conversation</button>
    </section>:<>
      {pending&&<section className="mb-3 ml-auto w-[330px] max-w-full rounded-xl border bg-background p-4 shadow-xl" aria-label="Confirm voice action"><div className="text-xs font-medium">Your confirmation is needed</div><p className="mt-2 text-xs leading-relaxed">{pending}</p><p className="mt-1 text-[11px] text-muted-foreground">Say “confirm” or “cancel”, or choose below.</p><div className="mt-3 flex gap-2"><button onClick={()=>agent.current?.answerConfirmation(true)} className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"><Check className="size-3"/>Confirm</button><button onClick={()=>agent.current?.answerConfirmation(false)} className="rounded-md border px-3 py-1.5 text-xs">Cancel</button></div></section>}
      {expanded&&<section className="mb-3 ml-auto w-[340px] max-w-full rounded-2xl border bg-background p-4 shadow-xl" aria-label="Voice conversation">
        <div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Conversation</span><label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Eye className="size-3"/><input type="checkbox" checked={vision} onChange={e=>setScreenVision(e.target.checked)}/>Screen vision</label></div>
        <div className="max-h-[35vh] space-y-3 overflow-y-auto pr-1">{lines.map((line,i)=><div key={i} className="text-xs leading-relaxed"><div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{line.role==='user'?'You':'Skylar'}</div>{line.text}</div>)}{transcript&&<div className="text-xs italic text-muted-foreground">{transcript}</div>}</div>
        <p className="mt-3 border-t pt-2 text-[10px] text-muted-foreground">Conversation stays in this tab during the live session. General legal information is not legal advice.</p>
      </section>}
      {error&&<div role="alert" className="mb-2 ml-auto flex max-w-[340px] items-start gap-2 rounded-lg border bg-background p-3 text-xs text-destructive">{error}<button aria-label="Dismiss voice message" onClick={()=>setError('')}><X className="size-3"/></button></div>}
      <div className="flex h-[74px] items-center gap-1 rounded-full border border-white/10 bg-[#15171b]/95 pl-[7px] pr-3 text-white shadow-2xl backdrop-blur-xl" style={{boxShadow:'0 12px 40px rgba(0,0,0,.22),inset 0 0 40px rgba(255,255,255,.025)'}}>
        <button onClick={()=>setExpanded(v=>!v)} className="shrink-0 rounded-full [&_canvas]:!size-14" aria-label="Toggle voice conversation"><ThinkingOrb state={STATES[phase]} size={64} theme="dark" paused={phase==='paused'}/></button>
        <button onClick={()=>setExpanded(v=>!v)} className="min-w-[108px] px-1 text-left"><div className="text-[13px] font-medium">Skylar <span className="ml-1 text-[9px] font-normal text-white/40">AI</span></div><div className="mt-0.5 text-[11px] text-white/55" role="status">{LABELS[phase]}{expires>now?' · '+clock:''}</div></button>
        <button onClick={()=>agent.current?.mute(phase!=='paused')} className={iconButton} aria-label={phase==='paused'?'Resume microphone':'Pause microphone'}>{phase==='paused'?<MicOff className="size-4"/>:<Mic className="size-4"/>}</button>
        <button onClick={()=>setExpanded(v=>!v)} className={iconButton} aria-label={expanded?'Hide transcript':'Show transcript'}>{expanded?<ChevronDown className="size-4"/>:<ChevronUp className="size-4"/>}</button>
        <button onClick={close} className={iconButton} aria-label="End voice session"><Square className="size-3.5 fill-current"/></button>
      </div>
    </>}
  </div>;
}
