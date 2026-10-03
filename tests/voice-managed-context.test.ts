import {describe,it,expect} from 'vitest';
import {boundedUtf8,compactScreen} from '@/modules/voice/managed-context';
import {MANAGED_TOOLS,managedAgentConfig} from '@/modules/voice/managed-agent';
import {SKYLAR_VOICE_ID} from '@/modules/voice/shared';
describe('managed agent configuration and result limits',()=>{
 it('uses the real Skylar voice and a continuing conversational agent',()=>{const c=managedAgentConfig(['one']);expect(c.audio.output.voice_id).toBe(SKYLAR_VOICE_ID);expect(c.model.id).toBe('gpt-5.4-mini');expect(c.turn.inactivity_end_call_secs).toBe(240);expect(c.tools).toEqual([{id:'one'}]);});
 it('expects results for every app tool and enables asynchronous vision',()=>{expect(MANAGED_TOOLS).toHaveLength(6);expect(MANAGED_TOOLS.every(t=>t.expects_response)).toBe(true);expect(MANAGED_TOOLS.find(t=>t.name==='screenshot')?.execution_mode).toBe('async');for(const tool of MANAGED_TOOLS)expect(tool.parameters).not.toHaveProperty('additionalProperties');});
 it('never sends more than 4096 bytes, including multibyte text',()=>{const value=boundedUtf8('नमस्ते 🌟 '.repeat(1000),4096);expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(4096);expect(value).not.toContain('�');});
 it('returns parseable paged screen context and lets the model find a specific field',()=>{const screen={path:'/judges',title:'Judges',text:'Visible text '.repeat(1000),visionAllowed:false,targets:Array.from({length:100},(_,i)=>({id:'v'+i,label:i===80?'Judge search':'Open button '+i,role:'button',editable:false,confirm:false}))};const json=compactScreen(screen);expect(new TextEncoder().encode(json).length).toBeLessThan(4096);expect(JSON.parse(json).nextOffset).toBeGreaterThan(0);expect(JSON.parse(compactScreen(screen,'Judge search')).targets[0].id).toBe('v80');});
});
