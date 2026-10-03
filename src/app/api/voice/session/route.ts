import { withDb } from '@/lib/db/request';
import { withAuth, requirePrincipal } from '@/lib/auth/route';
import { refs } from '@/lib/auth/resources';
import { getWorkspace } from '@/lib/workspace';
import { aiRuntimeStatus } from '@/lib/ai/config';
import { retryAfter, recordFailure } from '@/lib/auth/rate-limit';
import { loadCartesiaKey, connectCartesia, createCartesiaAccessToken } from '@/modules/voice/provider';
import { createVoiceTicket } from '@/modules/voice/ticket';
import { CARTESIA_VERSION, SESSION_SECONDS, SKYLAR_VOICE_ID } from '@/modules/voice/shared';
export const runtime = 'nodejs';
export const maxDuration = 30;
const headers = { 'Cache-Control': 'private, no-store' };
function canConfigure() { const p = requirePrincipal(); return p.source !== 'dev' && p.id === getWorkspace().owner?.id; }
async function get() {
  return Response.json({ configured: Boolean(await loadCartesiaKey()), canConfigure: canConfigure(), brainConfigured: Boolean(aiRuntimeStatus().roles.fast) }, { headers });
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
    if (!aiRuntimeStatus().roles.fast) return Response.json({ error: 'Configure an AI provider in Settings before starting voice.' }, { status: 503, headers });
    const key = await loadCartesiaKey();
    if (!key) return Response.json({ error: 'Connect Cartesia first.', code: 'cartesia_not_configured' }, { status: 503, headers });
    const now = Math.floor(Date.now()/1000);
    const token = createVoiceTicket(p.id, p.tenantId, process.env.AUTH_JWT_SECRET || '', now);
    const accessToken = await createCartesiaAccessToken(key);
    return Response.json({ token, accessToken, expiresAt: (now + SESSION_SECONDS)*1000, voiceId: process.env.CARTESIA_VOICE_ID || SKYLAR_VOICE_ID, version: CARTESIA_VERSION, ttsModel: process.env.CARTESIA_TTS_MODEL || 'sonic-3.6', sttModel: process.env.CARTESIA_STT_MODEL || 'ink-2' }, { headers });
  } catch (e) { return Response.json({ error: e instanceof SyntaxError ? 'Invalid request' : (e as Error).message }, { status: 502, headers }); }
}
export const GET = withDb(withAuth(get, { action: 'read', resource: () => refs.research() }));
export const POST = withDb(withAuth(post, { action: 'run', resource: () => refs.research() }));
