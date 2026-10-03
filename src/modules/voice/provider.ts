import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { remoteStore } from '@/lib/db/remote';
import { CARTESIA_VERSION, SESSION_SECONDS } from './shared';
const encryptedKey = () => {
  const secret = process.env.AUTH_JWT_SECRET || '';
  if (secret.length < 32) throw new Error('Secure sign-in must be configured before connecting voice.');
  return createHash('sha256').update('pramana-voice-v1:' + secret).digest();
};
export async function loadCartesiaKey(): Promise<string | null> {
  if (process.env.CARTESIA_API_KEY?.trim()) return process.env.CARTESIA_API_KEY.trim();
  const store = remoteStore(); if (!store) return null;
  try {
    const [row] = await store.query({ query: "SELECT encrypted FROM private_voice.provider_config WHERE id = 'cartesia'" });
    if (!row?.encrypted) return null;
    const [iv, tag, data] = row.encrypted.split('.');
    const cipher = createDecipheriv('aes-256-gcm', encryptedKey(), Buffer.from(iv, 'base64url'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8');
  } catch { return null; }
}
async function cartesia(path: string, key: string, body?: unknown) {
  const response = await fetch('https://api.cartesia.ai' + path, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(12000),
    headers: { Authorization: 'Bearer ' + key, 'Cartesia-Version': CARTESIA_VERSION, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Cartesia rejected the API key. Check its permissions.' : 'Cartesia is unavailable (' + response.status + '). Check credits and try again.');
  return data;
}
export async function connectCartesia(key: string): Promise<void> {
  if (!/^sk_car_[A-Za-z0-9_-]{12,}$/.test(key) || key.length > 400) throw new Error('Enter a valid Cartesia API key.');
  // Validate without generating speech or retaining a browser-accessible master key.
  await cartesia('/voices?limit=1&q=Skylar', key);
  const store = remoteStore(); if (!store) throw new Error('A shared database is required to save this connection.');
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptedKey(), iv);
  const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  const value = [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
  await store.transaction([
    { query: 'CREATE SCHEMA IF NOT EXISTS private_voice' },
    { query: 'REVOKE ALL ON SCHEMA private_voice FROM PUBLIC' },
    { query: 'CREATE TABLE IF NOT EXISTS private_voice.provider_config (id text PRIMARY KEY, encrypted text NOT NULL)' },
    { query: 'REVOKE ALL ON private_voice.provider_config FROM PUBLIC' },
    { query: 'ALTER TABLE private_voice.provider_config ENABLE ROW LEVEL SECURITY' },
    { query: "INSERT INTO private_voice.provider_config (id, encrypted) VALUES ('cartesia', $1) ON CONFLICT (id) DO UPDATE SET encrypted = EXCLUDED.encrypted", params: [value] },
  ]);
}
export async function createCartesiaAccessToken(key: string): Promise<string> {
  const data = await cartesia('/access-token', key, { grants: { agent: true }, expires_in: SESSION_SECONDS });
  if (typeof data.token !== 'string' || !data.token) throw new Error('Cartesia did not return a client session token.');
  return data.token;
}
