import "server-only";
import { rateLimiter, type TokenBucket } from "@/lib/ai/toolkit/http";
import { safeFetch, type EgressPolicy } from "@/lib/net/safe-fetch";
import { asProviderError, isProviderError, ProviderError } from "@/modules/intel/providers/base";

/**
 * Binary-safe HTTP for the India source connectors. Every request goes through `safeFetch` (HTTP/S only, host
 * allowlist, private-address and redirect checks, byte limit, timeout, cancellation). Transient failures (network,
 * timeout, 408, 429, 5xx) are retried with exponential backoff up to `retries` times; everything else fails at once
 * with a structured `ProviderError` (404 → http/not retryable, 401/403 → not_configured, policy denial →
 * not_configured). A client marked offline never opens a connection.
 */
export interface SourceHttpOptions {
  name: string;
  egress: EgressPolicy;
  /** Requests per second and burst for this connector. */
  rps?: number;
  burst?: number;
  timeoutMs?: number;
  retries?: number;
  /** Base backoff in ms (doubles each attempt). */
  backoffMs?: number;
  offline?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  limiter?: TokenBucket;
  userAgent?: string;
}

export interface SourceResponse {
  status: number;
  body: Uint8Array;
  contentType: string;
  finalUrl: string;
  headers: Headers;
  truncated: boolean;
}

export interface SourceRequest {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Treat these statuses as success (e.g. 404 when probing). */
  allowStatuses?: number[];
}

const UA = "LeClaude-India/1.0 (+internal legal research platform)";

export class SourceHttp {
  readonly name: string;
  readonly stats = { requests: 0, retries: 0, errors: 0, bytes: 0 };
  private readonly limiter: TokenBucket;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: SourceHttpOptions) {
    this.name = opts.name;
    this.limiter = opts.limiter ?? rateLimiter(`india:${opts.name}`, { capacity: opts.burst ?? 8, refillPerSecond: opts.rps ?? 8 });
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get offline(): boolean { return Boolean(this.opts.offline); }

  async request(url: string, req: SourceRequest = {}): Promise<SourceResponse> {
    if (this.opts.offline) throw new ProviderError(this.name, "not_configured", `${this.name}: outbound network is disabled (INTEL_OFFLINE)`, false, undefined, url);
    const retries = this.opts.retries ?? 3;
    let attempt = 0;
    for (;;) {
      if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const ok = await this.limiter.take(15_000);
      if (!ok) throw new ProviderError(this.name, "rate_limited", `${this.name}: local rate limit reached`, true, undefined, url);
      this.stats.requests++;
      try {
        const res = await safeFetch(url, { method: req.method ?? "GET", body: req.body, signal: req.signal, fetchImpl: this.opts.fetchImpl, headers: { "User-Agent": this.opts.userAgent ?? UA, ...(req.headers ?? {}) } }, { ...this.opts.egress, timeoutMs: this.opts.timeoutMs ?? this.opts.egress.timeoutMs ?? 60_000, maxBytes: req.maxBytes ?? this.opts.egress.maxBytes ?? 32 * 1024 * 1024 });
        this.stats.bytes += res.bytes;
        if ((res.status >= 200 && res.status < 300) || req.allowStatuses?.includes(res.status)) {
          return { status: res.status, body: res.body, contentType: res.contentType, finalUrl: res.finalUrl, headers: res.headers, truncated: res.truncated };
        }
        const err = this.statusError(res.status, url, res.headers.get("retry-after"));
        if (err.retryable && attempt < retries) { attempt++; this.stats.retries++; await this.sleep(this.backoff(attempt, err.retryAfterMs)); continue; }
        this.stats.errors++;
        throw err;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") throw e;
        if (isProviderError(e)) throw e; // an HTTP status error classified (and counted) above
        const err = asProviderError(this.name, e, url);
        if (err.retryable && attempt < retries) { attempt++; this.stats.retries++; await this.sleep(this.backoff(attempt)); continue; }
        this.stats.errors++;
        throw err;
      }
    }
  }

  async text(url: string, req: SourceRequest = {}): Promise<string> {
    const r = await this.request(url, req);
    return new TextDecoder("utf-8").decode(r.body);
  }

  async json<T>(url: string, req: SourceRequest = {}): Promise<T> {
    const r = await this.request(url, { ...req, headers: { Accept: "application/json", ...(req.headers ?? {}) } });
    const s = new TextDecoder("utf-8").decode(r.body);
    try { return JSON.parse(s) as T; } catch (e) {
      throw new ProviderError(this.name, "parse", `${this.name}: invalid JSON (${(e as Error).message.slice(0, 80)})${r.truncated ? " — body truncated at the byte limit" : ""}`, false, r.status, url);
    }
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
    const base = this.opts.backoffMs ?? 500;
    return Math.min(30_000, Math.max(retryAfterMs ?? 0, base * 2 ** (attempt - 1)));
  }

  private statusError(status: number, url: string, retryAfter: string | null): ProviderError {
    if (status === 429 || status === 503) {
      const ms = retryAfter ? Number(retryAfter) * 1000 : undefined;
      return new ProviderError(this.name, "rate_limited", `${this.name}: throttled by the provider (${status})`, true, status, url, Number.isFinite(ms) ? ms : undefined);
    }
    if (status === 401 || status === 403) return new ProviderError(this.name, "not_configured", `${this.name}: access denied (${status})`, false, status, url);
    const retry = status >= 500 || status === 408;
    return new ProviderError(this.name, "http", `${this.name}: HTTP ${status}${status === 404 ? " (not found)" : ""}`, retry, status, url);
  }
}

/** True for a ProviderError that means "the object is not there" (never retried, never substituted). */
export function isNotFound(e: unknown): boolean {
  return isProviderError(e) && e.status === 404;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
