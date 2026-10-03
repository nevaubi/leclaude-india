import { withDb } from '@/lib/db/request';
import { withAuth, requirePrincipal } from '@/lib/auth/route';
import { refs } from '@/lib/auth/resources';
import { getWorkspace } from '@/lib/workspace';
import { DEFAULT_MANAGED_AGENT_ID } from '@/modules/voice/managed-agent';
import { retryAfter, recordFailure } from '@/lib/auth/rate-limit';
import { loadCartesiaKey, connectCartesia, createCartesiaAccessToken } from '@/modules/voice/provider';
import { createVoiceTicket } from '@/modules/voice/ticket';
import { CARTESIA_VERSION, SESSION_SECONDS } from '@/modules/voice/shared';
export const runtime = 'nodejs';
export const maxDuration = 30;
const headers = { 'Cache-Control': 'private, no-store' };
function canConfigure() { const p = requirePrincipal(); return p.source !== 'dev' && p.id === getWorkspace().owner?.id; }
async function get() {
  return Response.json({ configured: Boolean(await loadCartesiaKey()), canConfigure: canConfigure(), brainConfigured: Boolean(await loadCartesiaKey()), mode: 'managed' }, { headers });
}
async function post(req: Request) {
  const p = requirePrincipal();
  const rule = { max: 6, windowMs: 15 * 60_000 };
  const bucket = 'voice-session:' + p.tenantId + ':' + p.id;
  if (retryAfter(bucket, rule)) return Response.json({ error: 'Too many new voice sessions. Try again shortly.' }, { status: 429, headers });
  recordFailure(bucket);
  try {
    if (Number(req.headers.get('content-length') || 0) > 2000) return Response.json({ error: 'Request too large' }, { status: 413, headers });
    const raw = await req.text(); if (raw.length > 2000) return Response.json({ error: 'Request too large' }, { status: 413, headers });
    const body = raw ? JSON.parse(raw) : {};
    if (body.apiKey !== undefined) {
      if (!canConfigure()) return Response.json({ error: 'Only the signed-in workspace owner can connect Cartesia.' }, { status: 403, headers });
      await connectCartesia(String(body.apiKey).trim());
      return Response.json({ configured: true }, { headers });
    }
    const key = await loadCartesiaKey();
    if (!key) return Response.json({ error: 'Connect Cartesia first.', code: 'cartesia_not_configured' }, { status: 503, headers });
    const now = Math.floor(Date.now()/1000);
    const token = createVoiceTicket(p.id, p.tenantId, process.env.AUTH_JWT_SECRET || '', now);
    const accessToken = await createCartesiaAccessToken(key);
    return Response.json({ token, accessToken, expiresAt: (now + SESSION_SECONDS)*1000, agentId: process.env.CARTESIA_AGENT_ID || DEFAULT_MANAGED_AGENT_ID, transport: 'managed', version: CARTESIA_VERSION, sampleRate: 24000, audioFormat: 'pcm_24000' }, { headers });
  } catch (e) { return Response.json({ error: e instanceof SyntaxError ? 'Invalid request' : (e as Error).message }, { status: 502, headers }); }
}
export const GET = withDb(withAuth(get, { action: 'read', resource: () => refs.research() }));
export const POST = withDb(withAuth(post, { action: 'run', resource: () => refs.research() }));
