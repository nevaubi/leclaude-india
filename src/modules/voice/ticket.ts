import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { SESSION_SECONDS } from './shared';
export function createVoiceTicket(user: string, tenant: string, secret: string, now = Math.floor(Date.now()/1000)): string {
  if (secret.length < 32) throw new Error('Voice requires the existing secure sign-in configuration.');
  const payload = Buffer.from(JSON.stringify({ user, tenant, iat: now, exp: now + SESSION_SECONDS, nonce: randomUUID(), purpose: 'voice' })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function verifyVoiceTicket(token: string, user: string, tenant: string, secret: string, now = Math.floor(Date.now()/1000)): boolean {
  try {
    if (!secret || token.length > 1500) return false;
    const parts = token.split('.'); if (parts.length !== 2) return false;
    const expected = createHmac('sha256', secret).update(parts[0]).digest();
    const supplied = Buffer.from(parts[1], 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return p.purpose === 'voice' && p.user === user && p.tenant === tenant && Number.isFinite(p.iat) && Number.isFinite(p.exp) && p.iat <= now && p.exp > now && p.exp - p.iat <= SESSION_SECONDS;
  } catch { return false; }
}
