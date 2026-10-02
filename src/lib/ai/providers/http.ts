/**
 * Shared HTTP plumbing for the fetch-based providers: bounded retries with backoff that honour `retry-after`
 * and the caller's AbortSignal, SSE line parsing, and error normalisation. No provider SDKs (constitution §41:
 * every outbound call is a plain fetch with a timeout, a size-bounded body read and no credential logging).
 */
import { InferenceError, type InferenceErrorCode, type ProviderId } from "./types";

export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function isAbortError(e: unknown): boolean {
  return Boolean(e) && typeof e === "object" && ((e as { name?: string }).name === "AbortError" || (e as { code?: string }).code === "ABORT_ERR");
}

/** The caller cancelled: rethrow as the DOMException the SSE layer already recognises. */
export function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Parse a `retry-after` header (seconds or HTTP date) into milliseconds, capped. */
export function retryAfterMs(header: string | null, capMs = 20_000): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.min(capMs, Math.max(0, secs * 1000));
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(capMs, Math.max(0, at - Date.now()));
  return null;
}

export function backoffMs(attempt: number, base = 500, cap = 8_000): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Combine the caller's signal with a request timeout. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return { signal: ctrl.signal, clear: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }, timedOut: () => timedOut };
}

/** A provider message or code that says the input exceeded the model's context window (or the request size limit). */
export function isContextLengthError(code: string | undefined | null, message: string | undefined | null): boolean {
  if (code && /context_length_exceeded|string_above_max_length|request_too_large/i.test(code)) return true;
  return /context[_ ]length|maximum context|context window|prompt is too long|input is too long|too many (input )?tokens|exceeds the (model'?s )?(maximum|context)|input tokens exceed|request_too_large/i.test(message ?? "");
}

export function errorCodeForStatus(status: number): InferenceErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500 || status === 529) return "provider_unavailable";
  return "unknown";
}

/** Read at most `limit` bytes of an error body as text (never the whole thing into memory). */
export async function readErrorBody(res: Response, limit = 8_000): Promise<string> {
  try { const t = await res.text(); return t.length > limit ? t.slice(0, limit) + "…" : t; } catch { return ""; }
}

export function providerError(provider: ProviderId, status: number, body: string, hint?: string): InferenceError {
  let message = body;
  try {
    const j = JSON.parse(body) as { error?: { message?: string; type?: string }; message?: string; Message?: string };
    message = j.error?.message ?? j.message ?? j.Message ?? body;
    if (j.error?.type) message = `${j.error.type}: ${message}`;
  } catch { /* plain text */ }
  // A 400 that rejects the credentials themselves (unscoped key without a workspace, invalid key) is an auth failure.
  const code = status === 400 && /api[ -]?key|workspace|x-api-key|authentication|credential/i.test(message) ? "auth" : (status === 400 || status === 413) && isContextLengthError(null, message) ? "context_length" : errorCodeForStatus(status);
  return new InferenceError(code, `${provider} HTTP ${status}${message ? `: ${message.slice(0, 600)}` : ""}${hint ? ` (${hint})` : ""}`, { status, provider, retryable: RETRYABLE_STATUS.has(status) });
}

export function toInferenceError(e: unknown, provider: ProviderId, timedOut = false): InferenceError {
  if (e instanceof InferenceError) return e;
  if (timedOut) return new InferenceError("timeout", `${provider} request timed out`, { provider, retryable: true });
  const msg = e instanceof Error ? e.message : String(e);
  // Network failures (DNS, reset, TLS) are transient from the runtime's point of view.
  const network = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(msg);
  return new InferenceError(network ? "provider_unavailable" : "unknown", `${provider}: ${msg}`, { provider, retryable: network });
}

export interface RetryOptions {
  maxRetries?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  provider: ProviderId;
  /** Called before each retry (for status events / logging). */
  onRetry?: (info: { attempt: number; status?: number; delayMs: number }) => void;
}

/**
 * POST with retries on 429/529/5xx and network errors. Returns the open Response (the caller streams the body).
 * Retries only happen before any body bytes were consumed, so a streaming consumer never sees duplicated output.
 */
export async function fetchWithRetry(url: string, init: RequestInit | (() => RequestInit), opts: RetryOptions): Promise<{ res: Response; clear: () => void }> {
  const maxRetries = opts.maxRetries ?? 3;
  let lastError: InferenceError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw abortError();
    const t = withTimeout(opts.signal, opts.timeoutMs ?? 120_000);
    let res: Response;
    try {
      const requestInit = typeof init === "function" ? init() : init;
      res = await fetch(url, { ...requestInit, signal: t.signal });
    } catch (e) {
      t.clear();
      if (opts.signal?.aborted) throw abortError();
      lastError = toInferenceError(e, opts.provider, t.timedOut());
      if (!lastError.retryable || attempt === maxRetries) throw lastError;
      const delay = backoffMs(attempt);
      opts.onRetry?.({ attempt: attempt + 1, delayMs: delay });
      await sleep(delay, opts.signal);
      continue;
    }
    if (res.ok) return { res, clear: t.clear };
    const body = await readErrorBody(res);
    t.clear();
    lastError = providerError(opts.provider, res.status, body);
    if (!lastError.retryable || attempt === maxRetries) throw lastError;
    const delay = retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt);
    opts.onRetry?.({ attempt: attempt + 1, status: res.status, delayMs: delay });
    await sleep(delay, opts.signal);
  }
  throw lastError ?? new InferenceError("unknown", `${opts.provider}: request failed`, { provider: opts.provider });
}

// ---------------- Server-sent events ----------------

export interface SSEMessage { event?: string; data: string }

/** Incremental SSE parser: feed decoded text chunks, get complete messages. Handles CRLF and multi-line data. */
export class SSEParser {
  private buffer = "";
  push(chunk: string): SSEMessage[] {
    this.buffer += chunk;
    const out: SSEMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.search(/\r?\n\r?\n/)) >= 0) {
      const sep = this.buffer.slice(idx).match(/^\r?\n\r?\n/)![0];
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + sep.length);
      const msg = parseBlock(block);
      if (msg) out.push(msg);
    }
    return out;
  }
  /** Flush a trailing block without a terminating blank line. */
  end(): SSEMessage[] {
    const msg = parseBlock(this.buffer);
    this.buffer = "";
    return msg ? [msg] : [];
  }
}

function parseBlock(block: string): SSEMessage | null {
  if (!block.trim()) return null;
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const i = rawLine.indexOf(":");
    const field = i < 0 ? rawLine : rawLine.slice(0, i);
    let value = i < 0 ? "" : rawLine.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

/** Iterate a streaming body as decoded text chunks. */
export async function* textChunks(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/** Iterate a streaming body as raw byte chunks. */
export async function* byteChunks(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
