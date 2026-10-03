import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read=(name:string)=>readFileSync(resolve(process.cwd(),'src/modules/voice/'+name),'utf8');
describe('compact Skylar voice',()=>{
 it('does not present the old setup modal',()=>{const src=read('voice-widget.tsx');expect(src).not.toContain('Connect Cartesia');expect(src).not.toContain('Ask your workspace owner');expect(src).not.toContain('General legal information');expect(src).not.toContain('Start conversation');});
 it('starts microphone from the launcher click',()=>{expect(read('voice-launcher.tsx')).toContain('getUserMedia');expect(read('voice-widget.tsx')).toContain('capture');});
});
