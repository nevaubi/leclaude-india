import "server-only";
import { safeFetch, isSafeFetchError } from "@/lib/net/safe-fetch";
import { AIConfigError } from "@/lib/ai/config";
import { describeImage } from "@/lib/ai/agent";
import { db } from "@/lib/db";
import { defaultProviders } from "@/modules/intel/providers";
import { COLLECTION, NEWS_USER_AGENT, imageRepeatCounts } from "./service";
import { newsSourceById } from "./sources";
import { articleSortKey, type NewsArticle } from "./types";
import {
  IMAGE_REVIEW_PROMPT, MAX_LOOKUP_ATTEMPTS, MAX_REVIEW_ATTEMPTS, MIN_IMAGE_SIDE, REPEATED_IMAGE_THRESHOLD,
  absoluteImageUrl, displayImageFor, extractMetaImages, imageDimensions, imageUrlLooksGeneric, parseImageVerdict, passesImageHeuristic,
  type NewsImageReview,
} from "./images";

/**
 * Background image work for legal news, run from the cron tick after the feed refresh (never inside it):
 *
 *  1. lookupNewsImages: for headlines whose feed named no usable image, read the article page's <head> (egress-guarded,
 *     512 KB / 8 s, publisher host only) for og:image / twitter:image; when that finds nothing and Firecrawl is
 *     configured, ask Firecrawl for the page metadata (at most `maxFirecrawl` calls per run). One lookup per article,
 *     retried once after an error (MAX_LOOKUP_ATTEMPTS), never after "none".
 *  2. reviewNewsImages: for images that pass the cheap heuristic and have no verdict for their current URL, download
 *     the image (3 MB / 8 s), reject deterministically when it is not an image or is smaller than MIN_IMAGE_SIDE
 *     (no model call), otherwise ask describeImage (fast vision route) for a strict JSON verdict. At most `maxReviews`
 *     model calls per run (the spend cap); failures count against MAX_REVIEW_ATTEMPTS per URL with a growing backoff,
 *     so a broken image or a model outage cannot cause a retry storm. A missing model configuration stops the pass
 *     without charging attempts.
 *
 * Everything here is public publisher content (headline images), not matter data.
 */

export const LOOKUP_PAGE_MAX_BYTES = 512 * 1024;
export const LOOKUP_TIMEOUT_MS = 8_000;
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 8_000;
/** Only recent headlines get page lookups and reviews. */
export const IMAGE_WORK_MAX_AGE_MS = 7 * 86_400_000;
const LOOKUP_RETRY_AFTER_MS = 60 * 60_000;
const REVIEW_BACKOFF_MS = 30 * 60_000;

export interface PageFetchResult { status: number; html: string; finalUrl: string; contentType: string }
export type PageFetcher = (url: string, signal: AbortSignal) => Promise<PageFetchResult>;
export interface ImageFetchResult { status: number; bytes: Uint8Array; contentType: string }
export type ImageFetcher = (url: string, signal: AbortSignal) => Promise<ImageFetchResult>;
export interface FirecrawlImageSource { configured: boolean; imageFor(url: string, signal: AbortSignal): Promise<string | null> }
export type ImageDescriber = (imageUrl: string, prompt: string) => Promise<{ text: string }>;

export interface NewsImageJobOptions {
  now?: () => Date;
  /** Whole-pass budget (lookups then reviews). Default 25 s. */
  deadlineMs?: number;
  maxLookups?: number;
  maxFirecrawl?: number;
  /** Model-call cap per run. */
  maxReviews?: number;
  concurrency?: number;
  signal?: AbortSignal;
  pageFetcher?: PageFetcher;
  imageFetcher?: ImageFetcher;
  firecrawl?: FirecrawlImageSource | null;
  describe?: ImageDescriber;
}

export interface LookupSummary { examined: number; found: number; none: number; failed: number; firecrawlCalls: number }
export interface ReviewSummary { examined: number; accepted: number; rejected: number; probeRejected: number; failed: number; modelCalls: number; stopped: "ai_not_configured" | "deadline" | null }
export interface NewsImageJobResult { lookups: LookupSummary; reviews: ReviewSummary; durationMs: number }

const col = () => db().collection<NewsArticle>(COLLECTION);
const flag = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";
const offline = () => flag(process.env.INTEL_OFFLINE) || flag(process.env.LEGAL_NEWS_OFFLINE);
const errMsg = (e: unknown) => (isSafeFetchError(e) ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)).slice(0, 200);

// ---------------------------------------------------------------------------
// Default transports
// ---------------------------------------------------------------------------

export const httpPageFetcher: PageFetcher = async (url, signal) => {
  const res = await safeFetch(url, { signal, headers: { "user-agent": NEWS_USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" } }, {
    name: "legal-news:page", timeoutMs: LOOKUP_TIMEOUT_MS, maxBytes: LOOKUP_PAGE_MAX_BYTES, onLimit: "truncate", trustProxyResolution: true,
  });
  return { status: res.status, html: res.ok ? res.text() : "", finalUrl: res.finalUrl, contentType: res.contentType };
};

export const httpImageFetcher: ImageFetcher = async (url, signal) => {
  const res = await safeFetch(url, { signal, headers: { "user-agent": NEWS_USER_AGENT, accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" } }, {
    name: "legal-news:image", timeoutMs: IMAGE_TIMEOUT_MS, maxBytes: IMAGE_MAX_BYTES, trustProxyResolution: true,
  });
  return { status: res.status, bytes: res.body, contentType: res.contentType };
};

function defaultFirecrawl(): FirecrawlImageSource | null {
  try {
    const fc = defaultProviders().firecrawl;
    if (!fc.configured) return null;
    return { configured: true, imageFor: async (url, signal) => (await fc.scrape(url, { signal, maxChars: 500, onlyMainContent: true })).image ?? null };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** The article must live on its publisher's own site (feeds cannot point the fetcher at arbitrary hosts). */
export function onPublisherHost(a: Pick<NewsArticle, "url" | "sourceId">): boolean {
  const src = newsSourceById(a.sourceId);
  if (!src) return false;
  try {
    const host = bareHost(new URL(a.url).hostname);
    const home = bareHost(new URL(src.homepage).hostname);
    return host === home || host.endsWith(`.${home}`);
  } catch { return false; }
}

function recent(a: NewsArticle, now: Date): boolean {
  return now.getTime() - Date.parse(articleSortKey(a)) <= IMAGE_WORK_MAX_AGE_MS;
}

/** True when the article has no image worth reviewing and the page lookup may run now. */
export function needsLookup(a: NewsArticle, repeats: number, now: Date): boolean {
  const l = a.imageLookup;
  if (l) {
    if (l.status !== "failed") return false;
    if (l.attempts >= MAX_LOOKUP_ATTEMPTS) return false;
    if (now.getTime() - Date.parse(l.lastAt) < LOOKUP_RETRY_AFTER_MS) return false;
  }
  if (!a.imageUrl) return true;
  if (a.imageSource && a.imageSource !== "feed") return false;
  const rejected = a.imageReview && a.imageReview.url === a.imageUrl && !a.imageReview.ok;
  return Boolean(rejected) || !passesImageHeuristic({ url: a.imageUrl, width: a.imageWidth, height: a.imageHeight }, repeats);
}

/** True when the current image may be reviewed now. */
export function needsReview(a: NewsArticle, repeats: number, now: Date): boolean {
  if (!a.imageUrl) return false;
  if (a.imageReview && a.imageReview.url === a.imageUrl) return false;
  if (!passesImageHeuristic({ url: a.imageUrl, width: a.imageWidth, height: a.imageHeight }, repeats)) return false;
  const at = a.imageAttempts && a.imageAttempts.url === a.imageUrl ? a.imageAttempts : null;
  if (at) {
    if (at.count >= MAX_REVIEW_ATTEMPTS) return false;
    if (now.getTime() - Date.parse(at.lastAt) < REVIEW_BACKOFF_MS * at.count) return false;
  }
  return true;
}

/** Apply a patch to the stored article only if its image is still the one the work was about. */
function patch(id: string, expectUrl: string | null, fn: (a: NewsArticle) => Partial<NewsArticle>): void {
  const cur = col().get(id);
  if (!cur || cur.imageUrl !== expectUrl) return;
  col().put({ ...cur, ...fn(cur) });
}

async function pool<T>(items: T[], concurrency: number, stop: () => boolean, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length && !stop()) {
      const x = items[i++];
      await fn(x);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

const DATA_MIME: Record<string, string> = { png: "image/png", gif: "image/gif", jpeg: "image/jpeg", webp: "image/webp" };

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function lookupNewsImages(opts: NewsImageJobOptions & { deadlineAt?: number } = {}): Promise<LookupSummary> {
  const now = (opts.now ?? (() => new Date()))();
  const deadlineAt = opts.deadlineAt ?? Date.now() + (opts.deadlineMs ?? 15_000);
  const out: LookupSummary = { examined: 0, found: 0, none: 0, failed: 0, firecrawlCalls: 0 };
  if (offline() && !opts.pageFetcher) return out;
  const fetchPage = opts.pageFetcher ?? httpPageFetcher;
  const firecrawl = opts.firecrawl === undefined ? defaultFirecrawl() : opts.firecrawl;
  const maxFirecrawl = opts.maxFirecrawl ?? 3;
  const all = col().all();
  const repeats = imageRepeatCounts(all);
  const todo = all
    .filter((a) => recent(a, now) && onPublisherHost(a) && needsLookup(a, repeats.get(a.imageUrl ?? "") ?? 1, now))
    .sort((a, b) => articleSortKey(b).localeCompare(articleSortKey(a)))
    .slice(0, Math.max(0, opts.maxLookups ?? 10));
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), Math.max(0, deadlineAt - Date.now()));
  (timer as { unref?: () => void }).unref?.();
  const at = now.toISOString();
  const usable = (url: string | null, rejectUrl: string | null) =>
    !!url && url !== rejectUrl && (repeats.get(url) ?? 0) + 1 < REPEATED_IMAGE_THRESHOLD && !imageUrlLooksGeneric(url);
  try {
    await pool(todo, opts.concurrency ?? 4, () => ctrl.signal.aborted, async (a) => {
      out.examined++;
      const attempts = (a.imageLookup?.attempts ?? 0) + 1;
      const rejectUrl = a.imageUrl;
      try {
        let found: { url: string; width?: number; height?: number; via: "og" | "firecrawl" } | null = null;
        let pageError: string | null = null;
        try {
          const page = await fetchPage(a.url, ctrl.signal);
          if (page.status >= 200 && page.status < 300 && /html|xml/i.test(page.contentType || "text/html")) {
            const metas = extractMetaImages(page.html, page.finalUrl || a.url).filter((c) => usable(c.url, rejectUrl) && passesImageHeuristic(c, 1));
            if (metas[0]) found = { url: metas[0].url, width: metas[0].width, height: metas[0].height, via: "og" };
          } else pageError = `HTTP ${page.status}`;
        } catch (e) {
          if (ctrl.signal.aborted) throw e;
          pageError = errMsg(e);
        }
        if (!found && firecrawl?.configured && out.firecrawlCalls < maxFirecrawl && !ctrl.signal.aborted) {
          out.firecrawlCalls++;
          try {
            const img = absoluteImageUrl(await firecrawl.imageFor(a.url, ctrl.signal), a.url);
            if (img && usable(img, rejectUrl) && passesImageHeuristic({ url: img }, 1)) found = { url: img, via: "firecrawl" };
          } catch (e) { pageError = pageError ?? errMsg(e); }
        }
        if (found) {
          out.found++;
          const f = found;
          patch(a.id, rejectUrl, () => ({ imageUrl: f.url, imageSource: f.via, imageWidth: f.width ?? null, imageHeight: f.height ?? null, imageLookup: { attempts, lastAt: at, status: "found", via: f.via } }));
        } else if (pageError) {
          out.failed++;
          patch(a.id, rejectUrl, () => ({ imageLookup: { attempts, lastAt: at, status: "failed", error: pageError! } }));
        } else {
          out.none++;
          patch(a.id, rejectUrl, () => ({ imageLookup: { attempts, lastAt: at, status: "none" } }));
        }
      } catch (e) {
        // Deadline/abort mid-lookup: record nothing so the item is tried on the next run.
        if (!ctrl.signal.aborted) {
          out.failed++;
          patch(a.id, rejectUrl, () => ({ imageLookup: { attempts, lastAt: at, status: "failed", error: errMsg(e) } }));
        }
      }
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export async function reviewNewsImages(opts: NewsImageJobOptions & { deadlineAt?: number } = {}): Promise<ReviewSummary> {
  const now = (opts.now ?? (() => new Date()))();
  const deadlineAt = opts.deadlineAt ?? Date.now() + (opts.deadlineMs ?? 20_000);
  const out: ReviewSummary = { examined: 0, accepted: 0, rejected: 0, probeRejected: 0, failed: 0, modelCalls: 0, stopped: null };
  if (offline() && !opts.imageFetcher) return out;
  const fetchImage = opts.imageFetcher ?? httpImageFetcher;
  const describe: ImageDescriber = opts.describe ?? ((url, prompt) => describeImage(url, prompt, { fast: true }));
  const maxReviews = Math.max(0, opts.maxReviews ?? 8);
  const all = col().all();
  const repeats = imageRepeatCounts(all);
  // One review per URL; the verdict is applied to every article carrying it.
  const byUrl = new Map<string, NewsArticle[]>();
  for (const a of all.filter((x) => recent(x, now) && needsReview(x, repeats.get(x.imageUrl ?? "") ?? 1, now)).sort((x, y) => articleSortKey(y).localeCompare(articleSortKey(x)))) {
    const list = byUrl.get(a.imageUrl!) ?? [];
    list.push(a);
    byUrl.set(a.imageUrl!, list);
  }
  const urls = [...byUrl.keys()].slice(0, maxReviews * 2);
  const at = now.toISOString();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), Math.max(0, deadlineAt - Date.now()));
  (timer as { unref?: () => void }).unref?.();

  const store = (url: string, review: NewsImageReview) => {
    for (const a of byUrl.get(url) ?? []) patch(a.id, url, () => ({ imageReview: review, imageAttempts: null, ...(review.width ? { imageWidth: review.width, imageHeight: review.height ?? null } : {}) }));
  };
  const fail = (url: string, message: string) => {
    out.failed++;
    for (const a of byUrl.get(url) ?? []) {
      patch(a.id, url, (cur) => {
        const prev = cur.imageAttempts && cur.imageAttempts.url === url ? cur.imageAttempts.count : 0;
        return { imageAttempts: { url, count: prev + 1, lastAt: at, lastError: message.slice(0, 200) } };
      });
    }
  };

  try {
    await pool(urls, opts.concurrency ?? 3, () => ctrl.signal.aborted || out.stopped !== null || out.modelCalls >= maxReviews, async (url) => {
      if (out.modelCalls >= maxReviews) return;
      out.examined++;
      // 1. Deterministic probe: reachable, really an image, big enough.
      let probe: ImageFetchResult;
      try {
        probe = await fetchImage(url, ctrl.signal);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        fail(url, `fetch ${errMsg(e)}`);
        return;
      }
      const dims = imageDimensions(probe.bytes);
      const reject = (reason: string) => {
        out.probeRejected++;
        store(url, { url, ok: false, kind: "other", reason, alt: "", checkedAt: at, by: "probe", width: dims?.width, height: dims?.height });
      };
      if (probe.status === 404 || probe.status === 410) return reject(`Image URL answered HTTP ${probe.status}`);
      if (probe.status < 200 || probe.status >= 300) return fail(url, `HTTP ${probe.status}`);
      if (!dims) return reject(`Not a readable PNG, JPEG, WebP or GIF image (${probe.contentType || "no content type"})`);
      if (Math.min(dims.width, dims.height) < MIN_IMAGE_SIDE) return reject(`Image is ${dims.width}x${dims.height}, below ${MIN_IMAGE_SIDE}px`);
      // 2. Vision verdict on the exact bytes probed (data URL: works on every provider, including Bedrock).
      if (out.modelCalls >= maxReviews || ctrl.signal.aborted) return;
      out.modelCalls++;
      const dataUrl = `data:${DATA_MIME[dims.format]};base64,${Buffer.from(probe.bytes).toString("base64")}`;
      try {
        const res = await describe(dataUrl, IMAGE_REVIEW_PROMPT);
        const verdict = parseImageVerdict(res.text);
        if (verdict.ok) out.accepted++; else out.rejected++;
        store(url, { ...verdict, url, checkedAt: at, by: "vision", width: dims.width, height: dims.height });
      } catch (e) {
        if (e instanceof AIConfigError || (e as { name?: string })?.name === "AIConfigError") { out.stopped = "ai_not_configured"; out.modelCalls--; out.examined--; return; }
        fail(url, `vision ${errMsg(e)}`);
      }
    });
    if (ctrl.signal.aborted && !out.stopped) out.stopped = "deadline";
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tick entry point
// ---------------------------------------------------------------------------

let inFlight: Promise<NewsImageJobResult> | null = null;

/** Lookups then reviews inside one budget; concurrent callers share the running pass. Never throws. */
export async function runNewsImageJobs(opts: NewsImageJobOptions = {}): Promise<NewsImageJobResult> {
  if (inFlight) return inFlight;
  const started = Date.now();
  const deadlineAt = started + Math.max(1_000, opts.deadlineMs ?? 25_000);
  inFlight = (async () => {
    // Lookups get at most 40% of the budget so reviews (and their model cap) always have time.
    const lookups = await lookupNewsImages({ ...opts, deadlineAt: Math.min(deadlineAt, started + Math.round((deadlineAt - started) * 0.4)) })
      .catch((e: unknown): LookupSummary => ({ examined: 0, found: 0, none: 0, failed: 1, firecrawlCalls: 0, ...{ error: errMsg(e) } }));
    const reviews = await reviewNewsImages({ ...opts, deadlineAt })
      .catch((e: unknown): ReviewSummary => ({ examined: 0, accepted: 0, rejected: 0, probeRejected: 0, failed: 1, modelCalls: 0, stopped: null, ...{ error: errMsg(e) } }));
    return { lookups, reviews, durationMs: Date.now() - started };
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

/** Counts for operators: how many stored headlines show a verified image, a heuristic one, or the monogram. */
export function newsImageStats(): { total: number; verified: number; heuristic: number; hidden: number; noImage: number; reviewed: number; rejected: number; attemptsExhausted: number; lookups: Record<string, number> } {
  const all = col().all();
  const repeats = imageRepeatCounts(all);
  const s = { total: all.length, verified: 0, heuristic: 0, hidden: 0, noImage: 0, reviewed: 0, rejected: 0, attemptsExhausted: 0, lookups: {} as Record<string, number> };
  for (const a of all) {
    const v = displayImageFor(a, repeats.get(a.imageUrl ?? "") ?? 1);
    if (!a.imageUrl) s.noImage++;
    else if (!v) s.hidden++;
    else if (v.status === "verified") s.verified++;
    else s.heuristic++;
    if (a.imageReview && a.imageReview.url === a.imageUrl) { s.reviewed++; if (!a.imageReview.ok) s.rejected++; }
    if (a.imageAttempts && a.imageAttempts.url === a.imageUrl && a.imageAttempts.count >= MAX_REVIEW_ATTEMPTS) s.attemptsExhausted++;
    if (a.imageLookup) s.lookups[a.imageLookup.status] = (s.lookups[a.imageLookup.status] ?? 0) + 1;
  }
  return s;
}
