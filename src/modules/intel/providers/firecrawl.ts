import "server-only";
import { rateLimiter } from "@/lib/ai/toolkit/http";
import { clip, envValue, ProviderClient, ProviderError, providerEgress, type ProviderFactoryOptions } from "./base";

/** Firecrawl REST v1 (scrape, search, crawl); v2 scrape for PDF parser options. Requires FIRECRAWL_API_KEY. */
const BASE = "https://api.firecrawl.dev/v1";
const BASE_V2 = "https://api.firecrawl.dev/v2";
const DEFAULT_RPS = 1;
const DEFAULT_BURST = 3;

function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Options for one rich scrape (see `scrapeRich`). */
export interface FirecrawlRichOptions {
  markdown?: boolean;
  links?: boolean;
  branding?: boolean;
  json?: { schema: Record<string, unknown>; prompt?: string };
  /** Also return the page's raw HTML (Firecrawl strips onclick handlers and javascript: hrefs from it). */
  rawHtml?: boolean;
  /** Parse a PDF URL to markdown (v2 `parsers`), optionally limited to the first `maxPages` pages and with
   *  `<!-- page N -->` markers at page breaks (`pageMarkers`). Uses the v2 API. */
  pdf?: { maxPages?: number; pageMarkers?: boolean };
  /** Proxy tier ("basic", "stealth", "auto"); Firecrawl's default when omitted. */
  proxy?: "basic" | "stealth" | "auto";
  /** v2 only: accept a cached copy at most this old (default 0 = always live). */
  maxAgeMs?: number;
  /** Which REST version to call (default v1; v2 when `pdf` is set). */
  api?: "v1" | "v2";
  /** Response byte limit (default 2.5 MB; raise it for raw HTML or long PDFs). */
  maxBytes?: number;
  onlyMainContent?: boolean;
  waitFor?: number;
  signal?: AbortSignal;
  ttlMs?: number;
  timeoutMs?: number;
  country?: string;
  actions?: Array<Record<string, unknown>>;
}

export interface FirecrawlRichPage extends FirecrawlPage {
  links: string[];
  json: unknown;
  logo: string | null;
  /** Raw HTML when requested. */
  rawHtml: string | null;
  /** Which proxy served the request (metadata.proxyUsed: "basic", "stealth", ...), when reported. */
  proxyUsed: string | null;
  /** Timezone of the egress location (metadata.timezone, e.g. "Asia/Kolkata"), when reported. A request for location
   *  IN can silently fall back to another country's proxy; this is how callers tell. */
  timezone: string | null;
  /** PDF pages parsed / total pages, when reported. */
  numPages: number | null;
  contentType: string | null;
}

export interface FirecrawlPage {
  url: string;
  title?: string;
  description?: string;
  markdown: string;
  statusCode?: number;
  language?: string;
  publishedAt?: string;
  /** The page's og:image (Firecrawl metadata `ogImage` / `og:image`), when it declares one. */
  image?: string;
}

/**
 * Rate: FIRECRAWL_RPS / FIRECRAWL_BURST (defaults 1 / 3) for the shared bucket; `opts.rps` / `opts.burst` give a caller
 * its own bucket (bulk ingestion), still bounded by the plan's concurrency on Firecrawl's side.
 */
export function createFirecrawl(opts: ProviderFactoryOptions & { rps?: number; burst?: number } = {}) {
  const key = envValue(opts, "FIRECRAWL_API_KEY");
  const envRps = positiveNumber(process.env.FIRECRAWL_RPS);
  const envBurst = positiveNumber(process.env.FIRECRAWL_BURST);
  const rps = positiveNumber(opts.rps) ?? envRps ?? DEFAULT_RPS;
  const burst = Math.max(1, Math.floor(positiveNumber(opts.burst) ?? envBurst ?? DEFAULT_BURST));
  const custom = opts.rps !== undefined || opts.burst !== undefined;
  const limiter = opts.limiter ?? (custom ? rateLimiter(`intel:firecrawl:${rps}:${burst}`, { capacity: burst, refillPerSecond: rps }) : undefined);
  const client = new ProviderClient({ name: "firecrawl", egress: providerEgress("firecrawl"), rps, burst, timeoutMs: 60_000, cache: opts.cache, fetchImpl: opts.fetchImpl, offline: opts.offline, limiter, sleep: opts.sleep, maxWaitMs: opts.maxWaitMs });
  const headers = () => ({ Authorization: `Bearer ${key}` });
  const require = () => { if (!key) throw new ProviderError("firecrawl", "not_configured", "firecrawl: FIRECRAWL_API_KEY is not configured", false); };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const page = (d: Record<string, unknown>, fallbackUrl?: string): FirecrawlPage => {
    const meta = (d.metadata ?? {}) as Record<string, unknown>;
    return { url: str(meta.sourceURL) ?? str(d.url) ?? fallbackUrl ?? "", title: str(meta.title) ?? str(d.title), description: str(meta.description) ?? str(d.description), markdown: str(d.markdown) ?? str(d.content) ?? "", statusCode: typeof meta.statusCode === "number" ? meta.statusCode : undefined, language: str(meta.language), publishedAt: str(meta.publishedTime) ?? str(meta["article:published_time"]), image: str(meta.ogImage) ?? str(meta["og:image"]) };
  };
  return {
    name: "firecrawl" as const,
    client,
    configured: Boolean(key),
    async scrape(url: string, o: { maxChars?: number; onlyMainContent?: boolean; signal?: AbortSignal; ttlMs?: number; waitFor?: number } = {}): Promise<FirecrawlPage> {
      require();
      const data = await client.postJSON<{ success?: boolean; data?: Record<string, unknown>; error?: string }>(`${BASE}/scrape`, { url, formats: ["markdown"], onlyMainContent: o.onlyMainContent ?? true, waitFor: o.waitFor }, { headers: headers(), signal: o.signal, ttlMs: o.ttlMs, timeoutMs: 60_000 });
      if (!data?.success || !data.data) throw new ProviderError("firecrawl", "parse", `firecrawl: scrape failed (${data?.error ?? "no data"})`, false, undefined, url);
      const p = page(data.data, url);
      p.markdown = clip(p.markdown, o.maxChars ?? 200_000);
      return p;
    },
    /**
     * One scrape asking for several formats at once: markdown, links, raw HTML, branding (site logo) and/or JSON
     * extraction against a schema; PDF URLs can be parsed to markdown with a page limit (`pdf`, v2 API). Returns the raw
     * pieces plus how the request was served (proxy, timezone); callers validate them (page content is untrusted).
     */
    async scrapeRich(url: string, o: FirecrawlRichOptions = {}): Promise<FirecrawlRichPage> {
      require();
      const v2 = o.api === "v2" || Boolean(o.pdf);
      const formats: string[] = [];
      if (o.markdown !== false) formats.push("markdown");
      if (o.links) formats.push("links");
      if (o.rawHtml) formats.push("rawHtml");
      if (o.branding) formats.push("branding");
      if (o.json) formats.push("json");
      const timeout = Math.max(1_000, Math.min(o.timeoutMs ?? 55_000, 300_000));
      const body: Record<string, unknown> = { url, formats, onlyMainContent: o.onlyMainContent ?? true, waitFor: o.waitFor, timeout };
      if (o.json) body.jsonOptions = { schema: o.json.schema, ...(o.json.prompt ? { prompt: o.json.prompt } : {}) };
      // Fetch from a proxy in this country (some official Indian sites only answer requests from India).
      if (o.country) body.location = { country: o.country };
      if (o.actions?.length) body.actions = o.actions;
      if (o.proxy) body.proxy = o.proxy;
      if (v2) {
        body.maxAge = Math.max(0, Math.floor(o.maxAgeMs ?? 0));
        if (o.pdf) {
          const parser: Record<string, unknown> = { type: "pdf" };
          if (o.pdf.maxPages) parser.maxPages = Math.max(1, Math.floor(o.pdf.maxPages));
          if (o.pdf.pageMarkers) parser.pageMarkers = true;
          body.parsers = Object.keys(parser).length > 1 ? [parser] : ["pdf"];
        }
      }
      const data = await client.postJSON<{ success?: boolean; data?: Record<string, unknown>; error?: string }>(`${v2 ? BASE_V2 : BASE}/scrape`, body, { headers: headers(), signal: o.signal, ttlMs: o.ttlMs ?? 0, timeoutMs: timeout + 5_000, maxBytes: o.maxBytes });
      if (!data?.success || !data.data) throw new ProviderError("firecrawl", "parse", `firecrawl: scrape failed (${data?.error ?? "no data"})`, false, undefined, url);
      const d = data.data;
      const p = page(d, url);
      const meta = (d.metadata ?? {}) as Record<string, unknown>;
      const branding = (d.branding ?? {}) as Record<string, unknown>;
      const images = (branding.images ?? {}) as Record<string, unknown>;
      const links = Array.isArray(d.links) ? d.links.filter((l): l is string => typeof l === "string") : [];
      const numPages = typeof meta.numPages === "number" ? meta.numPages : typeof meta.totalPages === "number" ? meta.totalPages : null;
      return {
        ...p,
        links,
        json: d.json ?? null,
        logo: str(images.logo) ?? str(branding.logo) ?? null,
        rawHtml: str(d.rawHtml) ?? null,
        proxyUsed: str(meta.proxyUsed) ?? str(d.proxyUsed) ?? null,
        timezone: str(meta.timezone) ?? null,
        numPages,
        contentType: str(meta.contentType) ?? null,
      };
    },
    async search(query: string, o: { limit?: number; tbs?: string; lang?: string; country?: string; scrape?: boolean; signal?: AbortSignal; ttlMs?: number } = {}): Promise<FirecrawlPage[]> {
      require();
      const body: Record<string, unknown> = { query, limit: Math.min(o.limit ?? 10, 50), lang: o.lang ?? "en", country: o.country ?? "us" };
      if (o.tbs) body.tbs = o.tbs;
      if (o.scrape) body.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
      const data = await client.postJSON<{ success?: boolean; data?: Array<Record<string, unknown>>; error?: string }>(`${BASE}/search`, body, { headers: headers(), signal: o.signal, ttlMs: o.ttlMs ?? 6 * 3600_000, timeoutMs: 60_000 });
      if (!data?.success || !Array.isArray(data.data)) throw new ProviderError("firecrawl", "parse", `firecrawl: search failed (${data?.error ?? "no data"})`, false);
      return data.data.map((d) => page(d));
    },
    /** Start a crawl and poll until it completes (bounded by maxWaitMs). */
    async crawl(url: string, o: { limit?: number; maxDepth?: number; includePaths?: string[]; excludePaths?: string[]; maxWaitMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ id: string; status: string; pages: FirecrawlPage[] }> {
      require();
      const start = await client.postJSON<{ success?: boolean; id?: string; error?: string }>(`${BASE}/crawl`, { url, limit: Math.min(o.limit ?? 25, 200), maxDepth: o.maxDepth ?? 2, includePaths: o.includePaths, excludePaths: o.excludePaths, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }, { headers: headers(), signal: o.signal, ttlMs: 0, timeoutMs: 60_000 });
      if (!start?.success || !start.id) throw new ProviderError("firecrawl", "parse", `firecrawl: crawl could not start (${start?.error ?? "no id"})`, false, undefined, url);
      const sleep = o.sleep ?? opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const deadline = Date.now() + (o.maxWaitMs ?? 120_000);
      let status = "scraping";
      const pages: FirecrawlPage[] = [];
      while (Date.now() < deadline) {
        const poll = await client.getJSON<{ status?: string; data?: Array<Record<string, unknown>>; next?: string }>(`${BASE}/crawl/${start.id}`, { headers: headers(), signal: o.signal, ttlMs: 0, timeoutMs: 60_000 });
        status = poll.status ?? status;
        if (Array.isArray(poll.data)) for (const d of poll.data) pages.push(page(d));
        if (status === "completed" || status === "failed" || status === "cancelled") break;
        await sleep(3000);
      }
      const seen = new Set<string>();
      return { id: start.id, status, pages: pages.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true))) };
    },
  };
}

export type FirecrawlProvider = ReturnType<typeof createFirecrawl>;
