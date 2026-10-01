import "server-only";
import { clip, envValue, ProviderClient, ProviderError, providerEgress, type ProviderFactoryOptions } from "./base";

/** Firecrawl REST v1 (scrape, search, crawl). Requires FIRECRAWL_API_KEY. */
const BASE = "https://api.firecrawl.dev/v1";

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

export function createFirecrawl(opts: ProviderFactoryOptions = {}) {
  const key = envValue(opts, "FIRECRAWL_API_KEY");
  const client = new ProviderClient({ name: "firecrawl", egress: providerEgress("firecrawl"), rps: 1, burst: 3, timeoutMs: 60_000, cache: opts.cache, fetchImpl: opts.fetchImpl, offline: opts.offline, limiter: opts.limiter, sleep: opts.sleep, maxWaitMs: opts.maxWaitMs });
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
     * One scrape asking for several formats at once: markdown, links, branding (site logo) and/or JSON extraction
     * against a schema. Returns the raw pieces; callers validate them (extraction output is untrusted).
     */
    async scrapeRich(url: string, o: { markdown?: boolean; links?: boolean; branding?: boolean; json?: { schema: Record<string, unknown>; prompt?: string }; onlyMainContent?: boolean; waitFor?: number; signal?: AbortSignal; ttlMs?: number; timeoutMs?: number } = {}): Promise<FirecrawlPage & { links: string[]; json: unknown; logo: string | null }> {
      require();
      const formats: string[] = [];
      if (o.markdown !== false) formats.push("markdown");
      if (o.links) formats.push("links");
      if (o.branding) formats.push("branding");
      if (o.json) formats.push("json");
      const body: Record<string, unknown> = { url, formats, onlyMainContent: o.onlyMainContent ?? true, waitFor: o.waitFor, timeout: o.timeoutMs ?? 55_000 };
      if (o.json) body.jsonOptions = { schema: o.json.schema, ...(o.json.prompt ? { prompt: o.json.prompt } : {}) };
      const data = await client.postJSON<{ success?: boolean; data?: Record<string, unknown>; error?: string }>(`${BASE}/scrape`, body, { headers: headers(), signal: o.signal, ttlMs: o.ttlMs ?? 0, timeoutMs: (o.timeoutMs ?? 55_000) + 5_000 });
      if (!data?.success || !data.data) throw new ProviderError("firecrawl", "parse", `firecrawl: scrape failed (${data?.error ?? "no data"})`, false, undefined, url);
      const d = data.data;
      const p = page(d, url);
      const branding = (d.branding ?? {}) as Record<string, unknown>;
      const images = (branding.images ?? {}) as Record<string, unknown>;
      const links = Array.isArray(d.links) ? d.links.filter((l): l is string => typeof l === "string") : [];
      return { ...p, links, json: d.json ?? null, logo: str(images.logo) ?? str(branding.logo) ?? null };
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
