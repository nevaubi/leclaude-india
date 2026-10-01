import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { isSafeFetchError, safeFetch } from "@/lib/net/safe-fetch";
import { parseFeed } from "./parse";
import { normalizeItem } from "./normalize";
import { displayImageFor } from "./images";
import { EXCLUDED_FEEDS, NEWS_SOURCES, enabledNewsSources, type NewsSource } from "./sources";
import { articleSortKey, type FeedRunResult, type FeedStatus, type NewsArticle, type NewsListResponse, type NewsRunSummary, type NewsSourcesResponse, type RefreshResult } from "./types";

/**
 * Indian legal news: fetch the registered RSS feeds in parallel, normalise and dedupe headlines, store them in the
 * `legal_news` collection (pruned to recent items) and record per-feed status in kv.
 *
 * Copyright: only headline, the feed's own summary (truncated), attribution and link are stored or shown.
 */

export const COLLECTION = "legal_news";
const KV_FEEDS = "legal_news:feeds";
const KV_LAST_RUN = "legal_news:last_run";

export const REFRESH_INTERVAL_MS = 15 * 60_000;
/** Even a forced refresh waits this long after the previous run (protects publishers from refresh storms). */
export const FORCE_FLOOR_MS = 60_000;
export const FEED_TIMEOUT_MS = 15_000;
export const FEED_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ITEMS = 1_500;
export const MAX_AGE_DAYS = 45;
/** No successful fetch for this long marks the feed (and the list) stale. */
export const STALE_AFTER_MS = 3 * 60 * 60_000;

export const NEWS_USER_AGENT = "LeClaude-India-LegalNews/1.0 (headline reader; links every item to its publisher)";

export function articles() { return db().collection<NewsArticle>(COLLECTION); }

export function feedStatuses(): Record<string, FeedStatus> {
  return db().kv.get<Record<string, FeedStatus>>(KV_FEEDS) ?? {};
}

export function lastRun(): NewsRunSummary | null {
  return db().kv.get<NewsRunSummary>(KV_LAST_RUN);
}

function emptyStatus(sourceId: string): FeedStatus {
  return { sourceId, lastAttemptAt: null, lastSuccessAt: null, lastError: null, itemCount: 0, added: 0, httpStatus: null, etag: null, lastModified: null, durationMs: null, consecutiveFailures: 0, notModified: false };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface FetchedFeed { status: number; body: string; etag: string | null; lastModified: string | null; notModified: boolean }

export type FeedFetcher = (source: NewsSource, conditional: { etag: string | null; lastModified: string | null }, signal: AbortSignal) => Promise<FetchedFeed>;

class FeedError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/**
 * Production fetcher: egress-guarded (safeFetch blocks private/internal targets on every redirect hop), 15 s timeout,
 * 5 MB cap, conditional GET with the stored ETag/Last-Modified. Feed URLs come only from the registry constants.
 */
export function httpFeedFetcher(fetchImpl?: typeof fetch): FeedFetcher {
  return async (source, conditional, signal) => {
    const headers: Record<string, string> = {
      "user-agent": NEWS_USER_AGENT,
      accept: "application/rss+xml, application/atom+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.3",
    };
    if (conditional.etag) headers["if-none-match"] = conditional.etag;
    if (conditional.lastModified) headers["if-modified-since"] = conditional.lastModified;
    const res = await safeFetch(source.feedUrl, { headers, signal, fetchImpl }, {
      name: `legal-news:${source.id}`,
      timeoutMs: FEED_TIMEOUT_MS,
      maxBytes: FEED_MAX_BYTES,
      trustProxyResolution: true,
    });
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    if (res.status === 304) return { status: 304, body: "", etag: etag ?? conditional.etag, lastModified: lastModified ?? conditional.lastModified, notModified: true };
    if (!res.ok) throw new FeedError(`http_${res.status}`, `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    return { status: res.status, body: res.text(), etag, lastModified, notModified: false };
  };
}

/**
 * Development/test fetcher reading `<dir>/<sourceId>.xml`. Enabled only outside production through
 * LEGAL_NEWS_FIXTURE_DIR (the feeds are unreachable from some sandboxes); a missing file is a feed failure.
 */
export function fixtureFeedFetcher(dir: string): FeedFetcher {
  return async (source) => {
    try {
      const body = await readFile(path.join(dir, `${source.id}.xml`), "utf8");
      return { status: 200, body, etag: null, lastModified: null, notModified: false };
    } catch {
      throw new FeedError("fixture_missing", `No fixture for ${source.id}`);
    }
  };
}

const flag = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";

function defaultFetcher(): FeedFetcher {
  const dir = process.env.LEGAL_NEWS_FIXTURE_DIR;
  if (dir && process.env.NODE_ENV !== "production") return fixtureFeedFetcher(dir);
  if (flag(process.env.INTEL_OFFLINE) || flag(process.env.LEGAL_NEWS_OFFLINE)) {
    return async () => { throw new FeedError("offline", "Outbound network is disabled (INTEL_OFFLINE / LEGAL_NEWS_OFFLINE)"); };
  }
  return httpFeedFetcher();
}

function describeError(e: unknown): { code: string; message: string } {
  if (isSafeFetchError(e)) return { code: e.code, message: e.message.slice(0, 300) };
  if (e instanceof FeedError) return { code: e.code, message: e.message.slice(0, 300) };
  return { code: "error", message: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Image fields after a re-listing. A page-derived image (og/Firecrawl) is kept unless the feed now names one that is
 * different from the feed image it replaced; a changed feed image replaces the old one (its review is then void
 * because reviews are keyed by URL).
 */
function mergeImage(existing: NewsArticle, a: NewsArticle): Partial<NewsArticle> {
  const candidates = a.imageCandidates?.length ? a.imageCandidates : existing.imageCandidates ?? [];
  if (!a.imageUrl) return { imageCandidates: candidates };
  const pageImage = existing.imageSource === "og" || existing.imageSource === "firecrawl";
  const sameFeedImage = (existing.imageCandidates ?? []).some((c) => c.url === a.imageUrl);
  if (pageImage && sameFeedImage) return { imageCandidates: candidates };
  if (a.imageUrl === existing.imageUrl) return { imageCandidates: candidates, imageWidth: existing.imageWidth ?? a.imageWidth, imageHeight: existing.imageHeight ?? a.imageHeight };
  return { imageUrl: a.imageUrl, imageSource: "feed", imageWidth: a.imageWidth ?? null, imageHeight: a.imageHeight ?? null, imageCandidates: candidates };
}

/** Merge freshly normalised items into the store. Returns the number of new headlines. Exported for tests. */
export function mergeArticles(incoming: NewsArticle[], now: Date): number {
  const col = articles();
  const ts = now.toISOString();
  const toPut = new Map<string, NewsArticle>();
  let added = 0;
  for (const a of incoming) {
    const existing = toPut.get(a.id) ?? col.get(a.id);
    if (!existing) { toPut.set(a.id, a); added++; continue; }
    if (existing.sourceId !== a.sourceId) {
      // Same canonical URL from another feed: keep the first publisher, record the syndication.
      if (existing.syndicatedBy.some((s) => s.sourceId === a.sourceId)) continue;
      toPut.set(a.id, { ...existing, syndicatedBy: [...existing.syndicatedBy, { sourceId: a.sourceId, url: a.url, seenAt: ts }] });
      continue;
    }
    // Same publisher re-listing the item: refresh what the publisher may have corrected; keep first-seen.
    toPut.set(a.id, {
      ...existing,
      title: a.title || existing.title,
      summary: a.summary || existing.summary,
      authors: a.authors.length ? a.authors : existing.authors,
      categories: a.categories.length ? a.categories : existing.categories,
      tags: a.tags.length ? a.tags : existing.tags,
      labels: a.labels,
      courtIds: a.courtIds,
      publishedAt: a.publishedAt ?? existing.publishedAt,
      publishedRaw: a.publishedRaw ?? existing.publishedRaw,
      ...mergeImage(existing, a),
      lastSeenAt: ts,
    });
  }
  if (toPut.size) col.putMany([...toPut.values()]);
  return added;
}

/** Keep the most recent `maxItems` headlines no older than `maxAgeDays` (by publish time, else first seen). */
export function pruneArticles(now: Date, opts: { maxItems?: number; maxAgeDays?: number } = {}): number {
  const maxItems = opts.maxItems ?? MAX_ITEMS;
  const cutoff = new Date(now.getTime() - (opts.maxAgeDays ?? MAX_AGE_DAYS) * 86_400_000).toISOString();
  const col = articles();
  const all = col.all().sort((a, b) => articleSortKey(b).localeCompare(articleSortKey(a)) || a.id.localeCompare(b.id));
  let pruned = 0;
  all.forEach((a, i) => {
    if (i >= maxItems || articleSortKey(a) < cutoff) { col.delete(a.id); pruned++; }
  });
  return pruned;
}

async function runFeed(source: NewsSource, fetcher: FeedFetcher, signal: AbortSignal, now: () => Date): Promise<{ result: FeedRunResult; items: NewsArticle[]; status: FeedStatus }> {
  const prev = feedStatuses()[source.id] ?? emptyStatus(source.id);
  const started = Date.now();
  const at = now().toISOString();
  try {
    const fetched = await fetcher(source, { etag: prev.etag, lastModified: prev.lastModified }, signal);
    const durationMs = Date.now() - started;
    if (fetched.notModified) {
      return {
        result: { sourceId: source.id, ok: true, items: prev.itemCount, added: 0, notModified: true, durationMs },
        items: [],
        status: { ...prev, lastAttemptAt: at, lastSuccessAt: at, lastError: null, added: 0, httpStatus: 304, durationMs, consecutiveFailures: 0, notModified: true, etag: fetched.etag, lastModified: fetched.lastModified },
      };
    }
    const parsed = parseFeed(fetched.body);
    if (parsed.format === "unknown") throw new FeedError("not_a_feed", "The response is not an RSS or Atom feed");
    const firstSeen = now();
    const items = parsed.items.map((raw) => normalizeItem(raw, source, firstSeen)).filter((x): x is NewsArticle => x !== null);
    return {
      result: { sourceId: source.id, ok: true, items: items.length, added: 0, notModified: false, durationMs },
      items,
      status: { ...prev, lastAttemptAt: at, lastSuccessAt: at, lastError: null, itemCount: items.length, added: 0, httpStatus: fetched.status, durationMs, consecutiveFailures: 0, notModified: false, etag: fetched.etag, lastModified: fetched.lastModified },
    };
  } catch (e) {
    const { code, message } = describeError(e);
    const durationMs = Date.now() - started;
    return {
      result: { sourceId: source.id, ok: false, items: 0, added: 0, notModified: false, error: message, code, durationMs },
      items: [],
      status: { ...prev, lastAttemptAt: at, lastError: { at, message, code }, added: 0, durationMs, consecutiveFailures: prev.consecutiveFailures + 1, notModified: false, httpStatus: code.startsWith("http_") ? Number(code.slice(5)) : prev.httpStatus },
    };
  }
}

export interface RefreshOptions {
  force?: boolean;
  now?: () => Date;
  fetcher?: FeedFetcher;
  /** Overall budget for the run (all feeds run in parallel; each also has its own 15 s timeout). */
  deadlineMs?: number;
  signal?: AbortSignal;
  sources?: NewsSource[];
}

let inFlight: Promise<RefreshResult> | null = null;

/**
 * Fetch every enabled feed in parallel and store new headlines. Throttled: a run within 15 minutes of the previous
 * one is skipped unless `force` (and even then not within 60 s). One failing feed never blocks the others.
 */
export async function refreshLegalNews(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const now = opts.now ?? (() => new Date());
  const prev = lastRun();
  const prevAt = prev ? Date.parse(prev.startedAt) : NaN;
  const since = Number.isFinite(prevAt) ? now().getTime() - prevAt : Infinity;
  const nextAllowed = (ms: number) => (Number.isFinite(prevAt) ? new Date(prevAt + ms).toISOString() : null);
  if (since < (opts.force ? FORCE_FLOOR_MS : REFRESH_INTERVAL_MS)) {
    return { status: "skipped", reason: "throttled", lastRunAt: prev?.startedAt ?? null, nextAllowedAt: nextAllowed(opts.force ? FORCE_FLOOR_MS : REFRESH_INTERVAL_MS) };
  }
  if (inFlight) {
    await inFlight.catch(() => undefined);
    const latest = lastRun();
    return { status: "skipped", reason: "in_flight", lastRunAt: latest?.startedAt ?? null, nextAllowedAt: latest ? new Date(Date.parse(latest.startedAt) + REFRESH_INTERVAL_MS).toISOString() : null };
  }
  inFlight = runAll(opts, now);
  try { return await inFlight; } finally { inFlight = null; }
}

async function runAll(opts: RefreshOptions, now: () => Date): Promise<RefreshResult> {
  const started = now();
  const fetcher = opts.fetcher ?? defaultFetcher();
  const sources = opts.sources ?? enabledNewsSources();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), Math.max(1_000, opts.deadlineMs ?? FEED_TIMEOUT_MS + 5_000));
  (timer as { unref?: () => void }).unref?.();
  try {
    const settled = await Promise.allSettled(sources.map((s) => runFeed(s, fetcher, ctrl.signal, now)));
    const statuses = { ...feedStatuses() };
    const feeds: FeedRunResult[] = [];
    let added = 0;
    settled.forEach((r, i) => {
      const source = sources[i];
      if (r.status === "rejected") {
        const { code, message } = describeError(r.reason);
        const prev = statuses[source.id] ?? emptyStatus(source.id);
        const at = now().toISOString();
        statuses[source.id] = { ...prev, lastAttemptAt: at, lastError: { at, message, code }, consecutiveFailures: prev.consecutiveFailures + 1 };
        feeds.push({ sourceId: source.id, ok: false, items: 0, added: 0, notModified: false, error: message, code, durationMs: 0 });
        return;
      }
      // Registry order decides "first publisher" for an item carried by two feeds in the same run.
      const n = mergeArticles(r.value.items, now());
      added += n;
      statuses[source.id] = { ...r.value.status, added: n };
      feeds.push({ ...r.value.result, added: n });
    });
    const finished = now();
    const pruned = pruneArticles(finished);
    const summary: NewsRunSummary = { startedAt: started.toISOString(), finishedAt: finished.toISOString(), feeds, added, pruned, total: articles().count() };
    db().kv.set(KV_FEEDS, statuses);
    db().kv.set(KV_LAST_RUN, summary);
    return { status: "ran", lastRunAt: summary.startedAt, nextAllowedAt: new Date(started.getTime() + REFRESH_INTERVAL_MS).toISOString(), run: summary };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface NewsQuery { source?: string | null; court?: string | null; q?: string | null; limit?: number | null; before?: string | null }

function cursorOf(a: NewsArticle): string { return `${articleSortKey(a)}|${a.id}`; }

function matchesQuery(a: NewsArticle, q: string): boolean {
  const hay = `${a.title}\n${a.summary}\n${a.publisher}\n${a.categories.join(" ")}\n${a.authors.join(" ")}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

/** How many stored headlines share each image URL (a publisher's default image repeats across items). */
export function imageRepeatCounts(items: NewsArticle[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of items) if (a.imageUrl) m.set(a.imageUrl, (m.get(a.imageUrl) ?? 0) + 1);
  return m;
}

export function lastSuccessAt(statuses = feedStatuses()): string | null {
  let best: string | null = null;
  for (const s of Object.values(statuses)) if (s.lastSuccessAt && (!best || s.lastSuccessAt > best)) best = s.lastSuccessAt;
  return best;
}

/** Headlines, newest first (publish time, else first seen), with filters, a cursor and facet counts. */
export function listLegalNews(query: NewsQuery = {}, now: Date = new Date()): NewsListResponse {
  const all = articles().all().sort((a, b) => articleSortKey(b).localeCompare(articleSortKey(a)) || b.id.localeCompare(a.id));
  const facets = { sources: {} as Record<string, number>, courts: {} as Record<string, number> };
  for (const a of all) {
    facets.sources[a.sourceId] = (facets.sources[a.sourceId] ?? 0) + 1;
    for (const c of a.courtIds) facets.courts[c] = (facets.courts[c] ?? 0) + 1;
  }
  const q = query.q?.trim().toLowerCase() ?? "";
  const filtered = all.filter((a) =>
    (!query.source || a.sourceId === query.source || a.syndicatedBy.some((s) => s.sourceId === query.source)) &&
    (!query.court || a.courtIds.includes(query.court)) &&
    (!q || matchesQuery(a, q)));
  const start = query.before ? filtered.findIndex((a) => cursorOf(a) < query.before!) : 0;
  const limit = Math.max(1, Math.min(Number(query.limit) || 50, 200));
  const page = start < 0 ? [] : filtered.slice(start, start + limit);
  const more = start >= 0 && start + limit < filtered.length;
  const statuses = feedStatuses();
  const success = lastSuccessAt(statuses);
  const repeats = imageRepeatCounts(all);
  return {
    items: page.map((a) => ({ ...a, image: displayImageFor(a, repeats.get(a.imageUrl ?? "") ?? 1) })),
    nextBefore: more && page.length ? cursorOf(page[page.length - 1]) : null,
    total: filtered.length,
    lastRun: lastRun(),
    stale: !success || now.getTime() - Date.parse(success) > STALE_AFTER_MS,
    lastSuccessAt: success,
    facets,
  };
}

/** The registry with each feed's status and stored-item count. */
export function legalNewsSources(): NewsSourcesResponse {
  const statuses = feedStatuses();
  const counts: Record<string, number> = {};
  for (const a of articles().all()) counts[a.sourceId] = (counts[a.sourceId] ?? 0) + 1;
  return {
    sources: NEWS_SOURCES.map((s) => ({
      id: s.id, publisher: s.publisher, homepage: s.homepage, feedUrl: s.feedUrl, type: s.type, language: s.language, country: s.country, format: s.format,
      carries: s.carries, enabled: s.enabled, verifiedAt: s.verifiedAt, stored: counts[s.id] ?? 0, status: statuses[s.id] ?? null,
    })),
    excluded: EXCLUDED_FEEDS,
    lastRun: lastRun(),
    refreshIntervalMinutes: REFRESH_INTERVAL_MS / 60_000,
  };
}

/** Test helper: forget stored headlines and feed status. */
export function resetLegalNews(): void {
  articles().clear();
  db().kv.delete(KV_FEEDS);
  db().kv.delete(KV_LAST_RUN);
}
