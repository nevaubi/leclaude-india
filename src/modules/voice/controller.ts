import type { InferenceMessage } from '@/lib/ai/providers/types';
import { VoiceAudio, type TurnEvent } from './audio';
import { executeAction } from './screen';
import { voiceRequest } from './stream';
import { safeVoiceHref, type VoicePhase, type VoiceSession } from './shared';
export interface VoiceCallbacks {
  navigate:(href:string)=>void; prefetch:(href:string)=>void; phase:(phase:VoicePhase)=>void; error:(message:string)=>void;
  transcript:(text:string)=>void; line:(role:'user'|'assistant',text:string)=>void;
  confirmation:(label:string|null)=>void; vision:()=>boolean;
}
export class VoiceController {
  private audio:VoiceAudio|null=null; private session:VoiceSession|null=null;
  private history:InferenceMessage[]=[]; private running:AbortController|null=null; private planning:AbortController|null=null;
  private expiry:ReturnType<typeof setTimeout>|null=null; private pending:((yes:boolean)=>void)|null=null;
  private generation=0; private finalTaken=false; private anticipated=false; private lastPlan=0;
  private partial=''; private paused=false; private speaking=false;
  constructor(private cb:VoiceCallbacks){}
  async start(session:VoiceSession,context:AudioContext,stream:MediaStream) {
    this.stop();this.session=session;this.history=[];this.paused=false;this.cb.phase('connecting');
    this.audio=new VoiceAudio(session,context,stream,event=>this.onTurn(event),active=>{
      this.speaking=active;if(this.session&&!this.paused)this.cb.phase(active?'speaking':this.running?'thinking':'listening');
    },message=>{this.stop();this.cb.error(message);});
    this.expiry=setTimeout(()=>{this.stop();this.cb.error('Your 15-minute session has ended. Start another when ready.');},Math.max(0,session.expiresAt-Date.now()));
    await this.audio.start();if(!this.session)return;this.cb.phase('listening');
    const greeting='Hi, I’m Skylar, your AI guide. What would you like to do?';
    this.cb.line('assistant',greeting);this.audio.speak(greeting);this.audio.finishSpeech();
  }
  private onTurn(event:TurnEvent) {
    if(!this.session||this.paused)return;
    if(event.type==='turn.start'){
      this.finalTaken=false;this.anticipated=false;this.partial='';this.audio?.interrupt();
      if(!this.pending){this.generation++;this.running?.abort();this.running=null;this.planning?.abort();this.planning=null;}
      this.cb.phase('listening');
    }
    if(event.type==='turn.resume'){this.planning?.abort();this.planning=null;}
    if(event.type==='turn.update'||event.type==='turn.eager_end'){
      this.partial=event.transcript||'';this.cb.transcript(this.partial);if(!this.pending)void this.anticipate(this.partial);
    }
    if(event.type==='turn.end'&&!this.finalTaken){this.finalTaken=true;const text=(event.transcript||this.partial).trim();this.cb.transcript('');if(text)void this.submit(text);}
  }
  private async anticipate(text:string) {
    if(!this.session||this.anticipated||this.planning||text.split(/\s+/).length<4||Date.now()-this.lastPlan<1800||/\b(don't|do not|not|never|maybe|if|would)\b/i.test(text))return;
    this.lastPlan=Date.now();const generation=this.generation;const ac=new AbortController();this.planning=ac;
    try {
      const result=await voiceRequest(this.session,[{role:'user',content:[{type:'text',text}]}],ac.signal,false,undefined,undefined,'anticipate');
      if(ac.signal.aborted||!this.session||generation!==this.generation)return;
      const action=result.calls.find(c=>c.name==='navigate');const href=safeVoiceHref(action?.args.href);
      // Partial speech may warm a destination, but never clicks, types, or commits user changes.
      if(href){this.anticipated=true;this.cb.prefetch(href);}
    }catch{/* Final utterances always use the main loop. */}
    finally{if(this.planning===ac)this.planning=null;}
  }
  answerConfirmation(yes:boolean){const resolve=this.pending;this.pending=null;this.cb.confirmation(null);resolve?.(yes);}
  private confirm(label:string):Promise<boolean>{if(!this.session)return Promise.resolve(false);this.cb.confirmation(label);this.audio?.speak(label+' Say confirm or cancel.');return new Promise(resolve=>{this.pending=resolve;});}
  private async submit(text:string) {
    if(this.pending){
      if(/^(yes|yeah|yep|confirm|confirmed|do it|go ahead|okay|ok)[.!\s]*$/i.test(text)){this.answerConfirmation(true);return;}
      if(/^(no|nope|cancel|don't|stop)[.!\s]*$/i.test(text)){this.answerConfirmation(false);return;}
      this.answerConfirmation(false);
    }
    if(/^(stop listening|end (the )?(call|session|conversation)|disconnect)[.!\s]*$/i.test(text)){this.stop();return;}
    if(/^(stop|pause|wait)[.!\s]*$/i.test(text)){this.interrupt();return;}
    this.planning?.abort();this.planning=null;this.running?.abort();
    const ac=new AbortController();this.running=ac;const generation=++this.generation;
    this.audio?.interrupt();this.cb.line('user',text);this.cb.phase('thinking');
    this.history.push({role:'user',content:[{type:'text',text:text.slice(0,12000)}]});
    this.history=this.history.length>70?[...this.history.slice(0,4),...this.history.slice(-66)]:this.history;const messages:InferenceMessage[]=[...this.history];
    let spoken='';let sentence='';let screenshot:string|undefined;const actions=new Set<string>();
    try {
      for(let round=0;round<6;round++){
        if(ac.signal.aborted||!this.session)break;let roundText='';
        const result=await voiceRequest(this.session,messages,ac.signal,this.cb.vision(),delta=>{
          if(ac.signal.aborted)return;roundText+=delta;sentence+=delta;const end=sentence.search(/[.!?](?:\s|$)/);
          if(end>=0){this.audio?.speak(sentence.slice(0,end+1));sentence=sentence.slice(end+1);}
          else if(sentence.length>180){const split=sentence.lastIndexOf(' ',160);if(split>0){this.audio?.speak(sentence.slice(0,split));sentence=sentence.slice(split);}}
        },screenshot);
        if(ac.signal.aborted)break;spoken+=roundText;
        if(roundText.trim())this.cb.line('assistant',roundText.trim());messages.push(result.assistant);screenshot=undefined;
        if(!result.calls.length)break;
        if(sentence.trim()){this.audio?.speak(sentence);sentence='';}
        let halt=false;
        for(const action of result.calls){
          const key=action.name+JSON.stringify(action.args);let outcome:{ok:boolean;message:string;screenshot?:string};
          if(halt||actions.has(key))outcome={ok:false,message:'Skipped: previous action failed or this exact action was attempted. Re-observe or ask the user.'};
          else {
            actions.add(key);this.cb.phase('acting');
            outcome=await executeAction(action,{navigate:this.cb.navigate,signal:ac.signal,visionAllowed:this.cb.vision(),confirm:label=>this.confirm(label)});
          }
          if(outcome.screenshot)screenshot=outcome.screenshot;
          messages.push({role:'tool',content:[{type:'tool_result',callId:action.id,content:outcome.message,isError:!outcome.ok}]});if(!outcome.ok)halt=true;
        }
        if(round===5){const note='I’ve reached the action limit for this turn. Tell me the next step.';this.cb.line('assistant',note);this.audio?.speak(note);spoken+=note;}
      }
      if(!ac.signal.aborted&&sentence.trim())this.audio?.speak(sentence);
      if(!ac.signal.aborted)this.audio?.finishSpeech();
    }catch(e){if(!ac.signal.aborted)this.cb.error((e as Error).message||'Could not process that request.');}
    finally {
      if(spoken.trim())this.history.push({role:'assistant',content:[{type:'text',text:spoken.slice(0,13950)+(ac.signal.aborted?' [interrupted]':'')}]});
      if(generation===this.generation){this.running=null;if(this.session&&!this.paused)this.cb.phase(this.speaking?'speaking':'listening');}
    }
  }
  interrupt(){this.generation++;this.running?.abort();this.running=null;this.planning?.abort();this.planning=null;this.audio?.interrupt();this.answerConfirmation(false);if(this.session)this.cb.phase(this.paused?'paused':'listening');}
  mute(value:boolean){this.paused=value;this.interrupt();this.audio?.mute(value);if(this.session)this.cb.phase(value?'paused':'listening');}
  stop(){this.generation++;this.running?.abort();this.running=null;this.planning?.abort();this.planning=null;if(this.expiry)clearTimeout(this.expiry);this.expiry=null;this.session=null;this.answerConfirmation(false);this.audio?.stop();this.audio=null;this.cb.phase('idle');this.cb.transcript('');}
}
