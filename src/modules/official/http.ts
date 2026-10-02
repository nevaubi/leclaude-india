import "server-only";
import https from "node:https";
import { constants } from "node:crypto";
import { rateLimiter, type TokenBucket } from "@/lib/ai/toolkit/http";
import type { EgressPolicy } from "@/lib/net/safe-fetch";
import { isSafeFetchError, validateEgressUrl } from "@/lib/net/safe-fetch";
import { isLegacyTlsError, legacyTlsAllowed } from "@/modules/media/legacy-tls";
import { completeChain, isIncompleteChainError, knownChainAgent } from "./tls-chain";
import { isProviderError, ProviderError } from "@/modules/intel/providers/base";
import { createFirecrawl, type FirecrawlRichOptions, type FirecrawlRichPage } from "@/modules/intel/providers/firecrawl";
import { SourceHttp, type SourceResponse } from "@/modules/india/sources/http";
import type { AdapterContext, FetchedFile, FetchedPage } from "./adapter";
import { allowHostsFor } from "./registry";
import type { FetchProvenance, SourceDef } from "./types";

/**
 * Outbound HTTP for official sources and the AdapterContext factory.
 *
 * - Direct first: `SourceHttp` over `safeFetch` (HTTP/S only, the source's host allowlist, private-address and redirect
 *   checks, byte limit, timeout), one polite token bucket per host (default 1.5 requests/s, OFFICIAL_HOST_RPS), a
 *   browser-like User-Agent (many NIC/gov.in WAFs refuse others), retries for transient failures.
 * - Legacy TLS: gov.in / nic.in servers that still need unsafe legacy renegotiation are retried once with a node:https
 *   transport that allows it (certificates still verified); the host is remembered for the process.
 * - Incomplete certificate chains (the server omits its intermediate): the chain is completed from the certificate's
 *   AIA "CA Issuers" URL (see ./tls-chain.ts) and the request retried with full verification.
 * - Firecrawl (location IN) for pages when the direct fetch fails (not on a 404, which means "not published", and not
 *   on an egress-policy denial) and the source fetches via `firecrawl_in` or the caller asks for it; pages that need
 *   browser actions go to Firecrawl directly. Firecrawl's IN location can silently fall back to another country, so
 *   the proxy and timezone it reports are recorded in the provenance, never assumed.
 * - Files are size-limited (OFFICIAL_MAX_FILE_MB, default 40 MB).
 */

export const DEFAULT_HOST_RPS = 1.5;
export const DEFAULT_HOST_BURST = 2;
export const DEFAULT_MAX_FILE_MB = 40;
const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const JSON_MAX_BYTES = 16 * 1024 * 1024;

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

export function officialUserAgent(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.OFFICIAL_USER_AGENT?.trim() || BROWSER_UA;
}

export function maxFileBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const mb = Number(env.OFFICIAL_MAX_FILE_MB);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? Math.min(mb, 200) : DEFAULT_MAX_FILE_MB) * 1024 * 1024);
}

function hostRps(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number(env.OFFICIAL_HOST_RPS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : DEFAULT_HOST_RPS;
}

/** Firecrawl surface the pipeline uses (injectable in tests). */
export interface FirecrawlLike {
  configured: boolean;
  scrapeRich(url: string, o?: FirecrawlRichOptions): Promise<FirecrawlRichPage>;
}

let defaultFirecrawl: FirecrawlLike | null | undefined;
function firecrawlDefault(): FirecrawlLike | null {
  if (defaultFirecrawl === undefined) {
    const rps = Number(process.env.OFFICIAL_FIRECRAWL_RPS);
    const fc = createFirecrawl({ maxWaitMs: 60_000, ...(Number.isFinite(rps) && rps > 0 ? { rps, burst: Math.max(1, Math.ceil(rps * 2)) } : {}) });
    defaultFirecrawl = fc.configured ? fc : null;
  }
  return defaultFirecrawl;
}

export interface OfficialHttpOptions {
  /** Transport for direct requests (tests). When set, the legacy-TLS transport is not used. */
  fetchImpl?: typeof fetch;
  /** Firecrawl client; `null` disables it; default from FIRECRAWL_API_KEY. */
  firecrawl?: FirecrawlLike | null;
  /** Per-host bucket (tests may pass a permissive one). */
  limiterFor?: (host: string) => TokenBucket;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retries?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
  /**
   * Epoch ms by which the run must end: every request (with its retries) is cut `DEADLINE_MARGIN_MS` before it and then
   * fails with OfficialDeadlineError (the unit is released, not failed).
   */
  deadline?: number;
  now?: () => number;
  userAgent?: string;
  /** Called after every successful fetch with its provenance (for run logs). */
  onFetch?: (p: FetchProvenance & { url: string; bytes: number }) => void;
}

/** Requests stop this long before the run deadline (time to record the outcome). */
export const DEADLINE_MARGIN_MS = 5_000;

/** A request could not finish before the run's deadline (not a publisher failure: the unit is released and resumes). */
export class OfficialDeadlineError extends Error {
  readonly code = "official_deadline";
  constructor(message = "the run's deadline was reached before the request finished") {
    super(message);
    this.name = "OfficialDeadlineError";
  }
}

export function isDeadlineError(e: unknown): boolean {
  return e instanceof OfficialDeadlineError || (e instanceof Error && e.name === "OfficialDeadlineError");
}

export interface OfficialHttp {
  def: SourceDef;
  allowHosts: string[];
  fetchPage: AdapterContext["fetchPage"];
  fetchFile: AdapterContext["fetchFile"];
  fetchJson: AdapterContext["fetchJson"];
  postForm: AdapterContext["postForm"];
  /** Fetch a page through Firecrawl only (location IN). Null when Firecrawl is not configured. */
  firecrawlPage(url: string): Promise<FetchedPage | null>;
  /**
   * Parse a PDF (or any URL) through Firecrawl (location IN): markdown + provenance (+ the content type Firecrawl
   * reports, when it does). Null when Firecrawl is off.
   */
  firecrawlDocument(url: string, opts?: { maxPages?: number; timeoutMs?: number }): Promise<{ markdown: string; numPages: number | null; provenance: FetchProvenance; contentType?: string | null } | null>;
  firecrawlAllowed: boolean;
}

// ---------------------------------------------------------------------------
// Legacy-TLS transport (gov.in / nic.in only), with request bodies and a byte cap
// ---------------------------------------------------------------------------

const legacyHosts = new Set<string>();
const legacyAgent = new https.Agent({ secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT, keepAlive: false });

function legacyFetchFor(maxBytes: number): typeof fetch {
  return agentFetch(maxBytes, legacyAgent, (url) => (legacyTlsAllowed(url) ? null : "legacy TLS is allowed only for https government hosts"));
}

/** fetch over node:https with a given agent (no automatic redirects; safeFetch follows and validates them). */
function agentFetch(maxBytes: number, agent: https.Agent, refuse: (url: string) => string | null): typeof fetch {
  return (input, init) => new Promise<Response>((resolve, reject) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const why = refuse(url);
    if (why) { reject(new Error(why)); return; }
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : null;
    if (body != null) headers["content-length"] = String(Buffer.byteLength(body));
    const req = https.request(url, { method: init?.method ?? "GET", headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error(`response larger than ${maxBytes} bytes`)); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v != null) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        const status = res.statusCode ?? 502;
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: h }));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    init?.signal?.addEventListener("abort", () => req.destroy(new Error("This operation was aborted")), { once: true });
    if (body != null) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function directProvenance(r: SourceResponse): FetchProvenance {
  return { via: "direct", proxy: null, timezone: null, status: r.status, finalUrl: r.finalUrl };
}

/** True for failures where another transport may succeed (network, timeout, 403/429/5xx); never for 404 or a policy denial. */
/**
 * Our own per-host token bucket refused the request (no HTTP status: the publisher was not asked). Not a failure of the
 * document or the publisher: the unit waits briefly and keeps its attempts, and no other route (Firecrawl) is tried.
 */
export function isLocalRateLimit(e: unknown): boolean {
  return isProviderError(e) && e.code === "rate_limited" && e.status == null && /local rate limit/i.test(e.message);
}

export function fallbackWorthy(e: unknown): boolean {
  if (isLocalRateLimit(e)) return false;
  if (isProviderError(e)) {
    if (e.status === 404 || e.status === 410) return false;
    if (e.code === "not_configured" && e.status !== 401 && e.status !== 403) return false; // egress policy denial / offline
    if (e.code === "parse" && !e.status) return /too large|truncated/i.test(e.message) ? false : true;
    return true;
  }
  if (isSafeFetchError(e)) return e.code === "network" || e.code === "timeout" || e.code === "dns";
  return true;
}

export function isNotPublished(e: unknown): boolean {
  return isProviderError(e) && (e.status === 404 || e.status === 410);
}

export function isTooLarge(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (isSafeFetchError(e) && e.code === "body_too_large") || /byte limit|larger than|too large/i.test(msg);
}

export function createOfficialHttp(def: SourceDef, opts: OfficialHttpOptions = {}): OfficialHttp {
  const allowHosts = allowHostsFor(def);
  const fileCap = opts.maxFileBytes ?? maxFileBytes();
  const ua = opts.userAgent ?? officialUserAgent();
  const firecrawl = opts.firecrawl === undefined ? firecrawlDefault() : opts.firecrawl;
  const firecrawlAllowed = def.fetch === "firecrawl_in";
  const egress: EgressPolicy = { name: `official:${def.id}`, allowHosts, allowedSchemes: ["https:", "http:"], trustProxyResolution: true };
  const clients = new Map<string, SourceHttp>();

  function limiter(host: string): TokenBucket {
    if (opts.limiterFor) return opts.limiterFor(host);
    const rps = hostRps();
    return rateLimiter(`official:${host}`, { capacity: DEFAULT_HOST_BURST, refillPerSecond: rps });
  }

  function client(url: string, legacy: boolean, chain: https.Agent | null = null): SourceHttp {
    const host = hostOf(url);
    const key = `${host}|${chain ? "chain" : legacy ? "legacy" : "std"}`;
    let c = clients.get(key);
    if (!c) {
      const cap = Math.max(fileCap, PAGE_MAX_BYTES);
      c = new SourceHttp({
        name: `official:${def.id}`,
        egress: legacy || chain ? { ...egress, dnsCheck: true } : egress,
        limiter: limiter(host),
        timeoutMs: opts.timeoutMs ?? 60_000,
        retries: opts.retries ?? 2,
        backoffMs: 800,
        sleep: opts.sleep,
        userAgent: ua,
        fetchImpl: chain ? agentFetch(cap, chain, (u) => (u.startsWith("https:") ? null : "chain completion applies to https only")) : legacy ? legacyFetchFor(cap) : opts.fetchImpl,
      });
      clients.set(key, c);
    }
    return c;
  }

  /**
   * The signal for one request: the caller's (the run's) signal, cut DEADLINE_MARGIN_MS before the run's deadline.
   * `cut()` tells whether the deadline (not the caller) ended it.
   */
  function bounded(): { signal: AbortSignal | undefined; cut: () => boolean; timeoutMs: number | null } {
    if (opts.deadline == null) return { signal: opts.signal, cut: () => false, timeoutMs: null };
    const left = opts.deadline - (opts.now ?? Date.now)() - DEADLINE_MARGIN_MS;
    if (left <= 0) throw new OfficialDeadlineError();
    const timer = AbortSignal.timeout(left);
    return { signal: opts.signal ? AbortSignal.any([opts.signal, timer]) : timer, cut: () => timer.aborted && !opts.signal?.aborted, timeoutMs: left };
  }

  /** Direct request with the legacy-TLS retry for government hosts and chain completion for incomplete chains. */
  async function direct(url: string, req: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; maxBytes: number }): Promise<SourceResponse> {
    validateEgressUrl(url, egress); // fail fast (and without a token) on hosts outside the source's allowlist
    const host = hostOf(url);
    const https_ = url.startsWith("https:");
    const chain = !opts.fetchImpl && https_ ? knownChainAgent(host) : null;
    const useLegacy = !chain && !opts.fetchImpl && legacyHosts.has(host) && legacyTlsAllowed(url);
    const b = bounded();
    const send = (c: SourceHttp) => c.request(url, { method: req.method ?? "GET", headers: req.headers, body: req.body, maxBytes: req.maxBytes, signal: b.signal });
    const retry = async (c: SourceHttp) => {
      try { return await send(c); } catch (e2) { if (b.cut()) throw new OfficialDeadlineError(); throw e2; }
    };
    try {
      return await send(client(url, useLegacy, chain));
    } catch (e) {
      if (b.cut()) throw new OfficialDeadlineError();
      if (!chain && !useLegacy && !opts.fetchImpl && isLegacyTlsError(e) && legacyTlsAllowed(url)) {
        legacyHosts.add(host);
        return retry(client(url, true));
      }
      if (!chain && !opts.fetchImpl && https_ && isIncompleteChainError(e)) {
        const agent = await completeChain(host);
        if (agent) return retry(client(url, false, agent));
      }
      throw e;
    }
  }

  /**
   * The URL Firecrawl reports having served must be on the source's hosts (a publisher redirect to another site is
   * not the official copy). FirecrawlRichPage.url is metadata.sourceURL today; a `finalUrl` field is used when the
   * provider exposes one (metadata.url).
   */
  function servedUrl(p: { url?: string; finalUrl?: string }, requested: string): string {
    const served = (typeof p.finalUrl === "string" && p.finalUrl) || p.url || requested;
    try {
      validateEgressUrl(served, egress);
    } catch {
      // An egress-policy refusal (code not_configured without an HTTP status): never retried through another route.
      throw new ProviderError("firecrawl", "not_configured", `firecrawl: the publisher served ${hostOf(served) || "an invalid URL"}, which is not one of the source's hosts`, false, undefined, requested);
    }
    return served;
  }

  async function viaFirecrawl(url: string, o: { waitForMs?: number; actions?: Array<Record<string, unknown>> }): Promise<FetchedPage> {
    if (!firecrawl) throw new ProviderError("firecrawl", "not_configured", "firecrawl: FIRECRAWL_API_KEY is not configured", false, undefined, url);
    validateEgressUrl(url, egress);
    const b = bounded();
    const p = await firecrawl.scrapeRich(url, { markdown: true, links: true, rawHtml: true, onlyMainContent: false, country: "IN", waitFor: o.waitForMs, actions: o.actions, api: "v2", timeoutMs: Math.min(60_000, b.timeoutMs ?? 60_000), maxBytes: 12 * 1024 * 1024, signal: b.signal })
      .catch((e: unknown) => { throw b.cut() ? new OfficialDeadlineError() : e; });
    const status = typeof p.statusCode === "number" ? p.statusCode : 200;
    if (status >= 400) throw new ProviderError("firecrawl", "http", `firecrawl: HTTP ${status} from the publisher${status === 404 ? " (not found)" : ""}`, status >= 500, status, url);
    const finalUrl = servedUrl(p, url);
    const provenance: FetchProvenance = { via: "firecrawl", proxy: p.proxyUsed, timezone: p.timezone, status, finalUrl };
    opts.onFetch?.({ ...provenance, url, bytes: (p.rawHtml ?? p.markdown ?? "").length });
    const links = p.links.filter((l) => /^https?:\/\//i.test(l));
    return { url, finalUrl, status, html: p.rawHtml, markdown: p.markdown || null, links, provenance };
  }

  const http: OfficialHttp = {
    def,
    allowHosts,
    firecrawlAllowed,
    async fetchPage(url, o = {}) {
      const allowFc = Boolean(o.firecrawl) || firecrawlAllowed;
      if (o.actions?.length) return viaFirecrawl(url, o); // browser actions only exist in Firecrawl
      try {
        const r = await direct(url, { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-IN,en;q=0.9", ...(o.headers ?? {}) }, maxBytes: PAGE_MAX_BYTES });
        const html = new TextDecoder("utf-8", { fatal: false }).decode(r.body);
        const provenance = directProvenance(r);
        opts.onFetch?.({ ...provenance, url, bytes: r.body.byteLength });
        return { url, finalUrl: r.finalUrl, status: r.status, html, markdown: null, links: extractLinks(html, r.finalUrl), provenance };
      } catch (e) {
        if (allowFc && firecrawl && fallbackWorthy(e)) return viaFirecrawl(url, o);
        throw e;
      }
    },
    async fetchFile(url, o = {}) {
      const cap = Math.min(o.maxBytes ?? fileCap, fileCap);
      const r = await direct(url, { headers: { Accept: o.accept ?? "application/pdf,application/octet-stream,*/*;q=0.8", ...(o.headers ?? {}) }, maxBytes: cap });
      if (r.truncated) throw new ProviderError(`official:${def.id}`, "parse", `file larger than ${cap} bytes`, false, r.status, url);
      const provenance = directProvenance(r);
      opts.onFetch?.({ ...provenance, url, bytes: r.body.byteLength });
      const mime = (r.contentType || "").split(";")[0].trim().toLowerCase() || null;
      const out: FetchedFile = { url, finalUrl: r.finalUrl, status: r.status, mime, bytes: r.body, provenance };
      return out;
    },
    async fetchJson<T = unknown>(url: string, o: { headers?: Record<string, string> } = {}): Promise<T> {
      const r = await direct(url, { headers: { Accept: "application/json", ...(o.headers ?? {}) }, maxBytes: JSON_MAX_BYTES });
      opts.onFetch?.({ ...directProvenance(r), url, bytes: r.body.byteLength });
      const s = new TextDecoder("utf-8").decode(r.body);
      try { return JSON.parse(s) as T; } catch (e) {
        throw new ProviderError(`official:${def.id}`, "parse", `official:${def.id}: invalid JSON (${(e as Error).message.slice(0, 80)})`, false, r.status, url);
      }
    },
    async postForm(url, fields, o = {}) {
      const body = new URLSearchParams(fields).toString();
      const r = await direct(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "text/html,application/json,*/*;q=0.8", ...(o.headers ?? {}) }, maxBytes: PAGE_MAX_BYTES });
      opts.onFetch?.({ ...directProvenance(r), url, bytes: r.body.byteLength });
      return { status: r.status, text: new TextDecoder("utf-8", { fatal: false }).decode(r.body), finalUrl: r.finalUrl };
    },
    async firecrawlPage(url) {
      if (!firecrawl) return null;
      return viaFirecrawl(url, {});
    },
    async firecrawlDocument(url, o = {}) {
      if (!firecrawl) return null;
      validateEgressUrl(url, egress);
      const b = bounded();
      const p = await firecrawl.scrapeRich(url, { markdown: true, onlyMainContent: false, country: "IN", pdf: { maxPages: o.maxPages, pageMarkers: true }, timeoutMs: Math.min(o.timeoutMs ?? 90_000, b.timeoutMs ?? 90_000), maxBytes: 16 * 1024 * 1024, signal: b.signal })
        .catch((e: unknown) => { throw b.cut() ? new OfficialDeadlineError() : e; });
      const status = typeof p.statusCode === "number" ? p.statusCode : 200;
      if (status >= 400) throw new ProviderError("firecrawl", "http", `firecrawl: HTTP ${status} from the publisher${status === 404 ? " (not found)" : ""}`, status >= 500, status, url);
      const provenance: FetchProvenance = { via: "firecrawl", proxy: p.proxyUsed, timezone: p.timezone, status, finalUrl: servedUrl(p, url) };
      opts.onFetch?.({ ...provenance, url, bytes: p.markdown.length });
      return { markdown: p.markdown, numPages: p.numPages, provenance, contentType: p.contentType ?? null };
    },
  };
  return http;
}

/** Absolute http(s) links of a page (hrefs and src attributes), deduplicated, in document order. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim().replace(/&amp;/g, "&");
    if (!raw || /^(javascript|mailto|tel|data):/i.test(raw) || raw.startsWith("#")) continue;
    let abs: string;
    try { abs = new URL(raw, baseUrl).toString(); } catch { continue; }
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** Today's date in India (Asia/Kolkata), YYYY-MM-DD. */
export function indiaToday(now: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

export interface AdapterContextOptions extends OfficialHttpOptions {
  limit: number;
  deadline: number;
  cursor: string | null;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Reuse an existing http client (the runner shares one per source per run). */
  http?: OfficialHttp;
}

/** The AdapterContext handed to `adapter.discover` (bounded, polite, SSRF-safe fetchers for this source only). */
export function makeAdapterContext(def: SourceDef, o: AdapterContextOptions): AdapterContext {
  const http = o.http ?? createOfficialHttp(def, o);
  const now = o.now ?? Date.now;
  return {
    limit: Math.max(1, Math.floor(o.limit)),
    deadline: o.deadline,
    cursor: o.cursor,
    today: indiaToday(now()),
    fetchPage: http.fetchPage,
    fetchFile: http.fetchFile,
    fetchJson: http.fetchJson,
    postForm: http.postForm,
    signal: o.signal,
    log: o.log ?? ((message, data) => console.info(JSON.stringify({ level: "info", event: "official.adapter", source: def.id, message, ...(data ?? {}) }))),
  };
}
