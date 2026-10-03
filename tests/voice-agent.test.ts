import { describe, expect, it } from 'vitest';
import { safeVoiceHref, needsConfirmation, SESSION_SECONDS, redactSecrets } from '@/modules/voice/shared';
import { createVoiceTicket, verifyVoiceTicket } from '@/modules/voice/ticket';
const secret='test-voice-secret-not-real-0123456789abcdef';
describe('voice agent boundaries',()=>{
 it('allows only in-app routes and rejects API or external targets',()=>{expect(safeVoiceHref('/judges?court=hc-delhi')).toBe('/judges?court=hc-delhi');for(const s of ['//evil.test','https://evil.test','/api/people','/login','javascript:alert(1)','/settings/../api/reset','/office/../../api/delete'])expect(safeVoiceHref(s)).toBeNull();});
 it('asks before state changes, not navigation',()=>{for(const label of ['Delete document','Send invitation','Save changes','Share folder','Submit filing','Confirm payment','Generate report'])expect(needsConfirmation(label)).toBe(true);for(const label of ['Open judges','Expand navigation','Next page','Search','Close panel'])expect(needsConfirmation(label)).toBe(false);});
 it('redacts credentials from screen context',()=>expect(redactSecrets('api_key=example-private-token password: hunter2')).not.toContain('hunter2'));
 it('limits signed sessions to fifteen minutes and binds them to a user',()=>{expect(SESSION_SECONDS).toBe(900);const token=createVoiceTicket('p1','t1',secret,1000);expect(verifyVoiceTicket(token,'p1','t1',secret,1100)).toBe(true);expect(verifyVoiceTicket(token,'p2','t1',secret,1100)).toBe(false);expect(verifyVoiceTicket(token,'p1','t2',secret,1100)).toBe(false);expect(verifyVoiceTicket(token,'p1','t1',secret,1900)).toBe(false);expect(verifyVoiceTicket(token+'x','p1','t1',secret,1100)).toBe(false);});
});
