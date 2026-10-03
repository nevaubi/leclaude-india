/** Client/server contracts. Never place provider secrets here. */
export const SESSION_SECONDS = 15 * 60;
export const CARTESIA_VERSION = '2026-08-14';
export const SKYLAR_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'acting' | 'speaking' | 'paused' | 'error';
export interface VoiceSession { token:string; accessToken:string; expiresAt:number; agentId:string; transport:'managed'; version:string; sampleRate:24000; audioFormat:'pcm_24000' }
export interface ScreenTarget { id: string; label: string; role: string; href?: string; value?: string; editable: boolean; confirm: boolean }
export interface ScreenContext { path: string; title: string; text: string; targets: ScreenTarget[]; visionAllowed: boolean }
export interface VoiceAction { id: string; name: string; args: Record<string, unknown> }
const ROOTS = new Set(['', 'search', 'chat', 'matters', 'diary', 'documents', 'cases', 'law', 'sources', 'courts', 'judges', 'tools', 'news', 'office', 'library', 'settings', 'intel', 'workflows', 'ediscovery']);
export function safeVoiceHref(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 800 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (/(^|\/)\.{1,2}(\/|$)/.test(decoded.split(/[?#]/)[0]) || decoded.startsWith('//')) return null;
    const u = new URL(value, 'https://voice.local');
    if (u.origin !== 'https://voice.local' || !ROOTS.has(u.pathname.split('/')[1])) return null;
    return u.pathname + u.search + u.hash;
  } catch { return null; }
}
export function needsConfirmation(label: string): boolean {
  return /\b(delete|remove|archive|send|invite|share|publish|submit|save|confirm|pay|purchase|buy|transfer|upload|download|export|generate|run|start workflow|reset|deactivate|sign out|log out|grant|permission|approve)\b/i.test(label);
}
export function redactSecrets(text: string): string {
  return text.replace(/\b(?:sk[-_][a-z0-9_-]{8,}|npg_[a-z0-9_-]+|nt_live_[a-z0-9_-]+)\b/gi, '[REDACTED]')
    .replace(/((?:password|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
