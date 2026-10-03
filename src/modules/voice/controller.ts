import { VoiceAudio, type TurnEvent } from './audio';
import { executeAction, observeScreen } from './screen';
import { compactScreen } from './managed-context';
import type { VoicePhase, VoiceSession } from './shared';
export interface VoiceCallbacks {
  navigate:(href:string)=>void;prefetch:(href:string)=>void;phase:(phase:VoicePhase)=>void;error:(message:string)=>void;
  transcript:(text:string)=>void;line:(role:'user'|'assistant',text:string)=>void;confirmation:(label:string|null)=>void;vision:()=>boolean;
}
/** Cartesia owns dialogue memory and turn-taking; this controller only plays audio and executes local tools. */
export class VoiceController {
  private audio:VoiceAudio|null=null;private session:VoiceSession|null=null;private expiry:ReturnType<typeof setTimeout>|null=null;
  private pending:((yes:boolean)=>void)|null=null;private confirmationTimer:ReturnType<typeof setTimeout>|null=null;
  private lifetime=new AbortController();private actionAbort=new AbortController();private queue:Promise<void>=Promise.resolve();
  private seen=new Set<string>();private ended=new Set<number>();private paused=false;private speaking=false;private working=0;
  constructor(private cb:VoiceCallbacks){}
  async start(session:VoiceSession,context:AudioContext,stream:MediaStream){
    this.stop();this.session=session;this.lifetime=new AbortController();this.actionAbort=new AbortController();this.seen.clear();this.ended.clear();this.queue=Promise.resolve();this.paused=false;this.working=0;
    this.cb.phase('connecting');
    this.expiry=setTimeout(()=>{this.stop();this.cb.error('Your 15-minute session has ended.');},Math.max(0,session.expiresAt-Date.now()));
    // Browser tokens cannot set dynamic variables; current context is obtained through read_screen.
    this.audio=new VoiceAudio(session,context,stream,event=>this.onEvent(event),active=>{this.speaking=active;this.updatePhase();},message=>{this.stop();this.cb.error(message);});
    try{await this.audio.start();if(this.session)this.updatePhase();}catch(e){this.stop();throw e;}
  }
  private updatePhase(){if(this.session)this.cb.phase(this.paused?'paused':this.speaking?'speaking':this.working?'acting':'listening');}
  private onEvent(event:TurnEvent){
    if(!this.session)return;
    if(event.type==='error'){this.cb.error(event.message||'Voice event failed.');return;}
    if(event.type==='session_closed'){const message=event.message;this.stop();if(message)this.cb.error(message);return;}
    if(event.type==='turn_started'){
      if(event.role==='user'){
        this.audio?.interrupt();if(!this.pending){this.actionAbort.abort();this.actionAbort=new AbortController();}
        if(!this.paused)this.cb.phase('listening');
      }else if(!this.paused&&!this.speaking)this.cb.phase(this.working?'acting':'thinking');
    }
    if(event.type==='turn_ended'&&typeof event.turn==='number'&&!this.ended.has(event.turn)){
      this.ended.add(event.turn);const text=event.text?.trim()||'';
      if(text&&event.role)this.cb.line(event.role,text);this.cb.transcript('');
      if(event.role==='user'&&this.pending){
        if(/^(yes|yeah|yep|confirm|confirmed|do it|go ahead|okay|ok)[.!\s]*$/i.test(text))this.answerConfirmation(true);
        else if(text)this.answerConfirmation(false);
      }
      if(event.role==='user'&&!this.paused&&!this.pending)this.cb.phase('thinking');
      if(event.role==='assistant')this.updatePhase();
    }
    if(event.type==='client_tool_call'&&event.tool_call_id&&!this.seen.has(event.tool_call_id)){
      this.seen.add(event.tool_call_id);const signal=this.actionAbort.signal;this.working++;this.updatePhase();
      this.queue=this.queue.then(()=>this.runTool(event,signal)).catch(()=>{}).finally(()=>{this.working=Math.max(0,this.working-1);this.updatePhase();});
    }
  }
  private async runTool(event:TurnEvent,signal:AbortSignal){
    const socket=this.audio;const session=this.session;const lifetime=this.lifetime.signal;if(!session||!socket)return;
    let result='';let failed=false;
    try{
      if(signal.aborted||lifetime.aborted)throw new Error('Cancelled by the user.');
      const name=event.tool_name||'';const args=event.parameters||{};
      if(name==='read_screen')result=compactScreen(observeScreen(this.cb.vision()),typeof args.query==='string'?args.query:'',typeof args.offset==='number'?args.offset:0);
      else {
        const outcome=await executeAction({id:event.tool_call_id!,name,args},{navigate:this.cb.navigate,signal,visionAllowed:this.cb.vision(),confirm:label=>this.confirm(label)});
        failed=!outcome.ok;result=outcome.message;
        if(outcome.screenshot&&this.cb.vision()){
          const response=await fetch('/api/voice/vision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:session.token,image:outcome.screenshot,question:String(args.reason||'Describe the current app screen.').slice(0,1000)}),signal:AbortSignal.any([lifetime,signal,AbortSignal.timeout(30000)])});
          const data=await response.json();if(!response.ok)throw new Error(data.error||'Screen vision is unavailable.');result=String(data.description||'No visual detail returned.');
        }else if(outcome.ok)result=outcome.message+'\n'+compactScreen(observeScreen(this.cb.vision()));
      }
    }catch(e){failed=true;result=(e as Error).message||'The action failed.';}
    // A result is always returned, including cancellation/errors, so the managed dialogue never hangs on a tool.
    if(event.expects_response!==false&&!lifetime.aborted)socket.sendToolResult(event.tool_call_id!,result,failed);
  }
  answerConfirmation(yes:boolean){if(this.confirmationTimer)clearTimeout(this.confirmationTimer);this.confirmationTimer=null;const done=this.pending;this.pending=null;this.cb.confirmation(null);done?.(yes);}
  private confirm(label:string):Promise<boolean>{
    if(!this.session)return Promise.resolve(false);this.answerConfirmation(false);this.cb.confirmation(label);
    return new Promise(resolve=>{this.pending=resolve;this.confirmationTimer=setTimeout(()=>this.answerConfirmation(false),90000);});
  }
  interrupt(){this.audio?.interrupt();this.actionAbort.abort();this.actionAbort=new AbortController();this.answerConfirmation(false);this.updatePhase();}
  mute(value:boolean){this.paused=value;this.audio?.mute(value);if(value)this.interrupt();this.updatePhase();}
  stop(){
    this.session=null;this.lifetime.abort();this.actionAbort.abort();if(this.expiry)clearTimeout(this.expiry);this.expiry=null;
    this.answerConfirmation(false);this.audio?.stop();this.audio=null;this.speaking=false;this.cb.phase('idle');this.cb.transcript('');
  }
}
