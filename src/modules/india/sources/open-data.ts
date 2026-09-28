import "server-only";
import type { AdapterContext } from "@/modules/intel/adapters/types";
import { mapPool } from "./http";
import type { OpenDataBucket } from "./s3";
import type { OpenDataCursor, PrefixCheckpoint, S3ObjectInfo } from "./types";

/**
 * Incremental, checkpointed walk over S3 prefixes for the open judgment datasets.
 *
 * Per prefix (one year folder, or one year/court/bench folder):
 *  1. retry pass: keys that failed transiently last time are tried again first;
 *  2. backfill pass: ListObjectsV2 from the saved `start-after` key, in key order, in bounded-concurrency batches;
 *     the checkpoint advances after every batch, so a crash or budget stop resumes where it left off;
 *  3. once the prefix is complete, later runs only process objects whose LastModified is at or after the saved
 *     watermark (new judgments and re-scraped records); unchanged records are skipped by ETag without a download.
 * Items that fail permanently (404, parse) are recorded as run errors and not retried forever.
 */
export type ItemOutcome = "ingested" | "skipped" | "failed_transient" | "failed";

export interface WalkOptions {
  concurrency: number;
  maxPerPrefix: number;
  maxListPages: number;
  /** Ignore the checkpoint and start the prefix from the beginning (a full re-scan; unchanged rows are still skipped). */
  restart?: boolean;
}

export interface WalkStats { prefixes: number; listed: number; ingested: number; skipped: number; failed: number; completedPrefixes: number }

const MAX_RETRY_KEYS = 200;

export function decodeCursor(raw: string | undefined): OpenDataCursor {
  if (!raw) return { v: 1, prefixes: {} };
  try {
    const c = JSON.parse(raw) as OpenDataCursor;
    if (c && c.v === 1 && c.prefixes && typeof c.prefixes === "object") return c;
  } catch { /* fall through */ }
  return { v: 1, prefixes: {} };
}

export function encodeCursor(c: OpenDataCursor): string {
  return JSON.stringify(c);
}

type Checkpoint = PrefixCheckpoint;

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export async function walkPrefixes(
  ctx: AdapterContext<unknown>,
  bucket: OpenDataBucket,
  prefixes: string[],
  cursor: OpenDataCursor,
  handle: (obj: S3ObjectInfo) => Promise<ItemOutcome>,
  o: WalkOptions,
): Promise<WalkStats> {
  const stats: WalkStats = { prefixes: prefixes.length, listed: 0, ingested: 0, skipped: 0, failed: 0, completedPrefixes: 0 };
  const count = (r: ItemOutcome) => { if (r === "ingested") stats.ingested++; else if (r === "skipped") stats.skipped++; else stats.failed++; };
  const isJson = (k: string) => k.endsWith(".json");

  for (const prefix of prefixes) {
    if (ctx.budgetLeft() <= 0 || ctx.signal?.aborted) break;
    const cp: Checkpoint = o.restart ? {} : { ...(cursor.prefixes[prefix] ?? {}) };
    let quota = o.maxPerPrefix;
    const retryNext: string[] = [];
    const run = async (objs: S3ObjectInfo[]) => {
      const results = await mapPool(objs, o.concurrency, async (obj) => {
        let r: ItemOutcome;
        try { r = await handle(obj); } catch (e) { if ((e as Error)?.name === "AbortError" || (e as Error)?.name === "BudgetExhausted") throw e; ctx.fail(e, { label: obj.key }); r = "failed"; }
        count(r);
        if (r === "failed_transient" && retryNext.length < MAX_RETRY_KEYS) retryNext.push(obj.key);
        if (r !== "skipped") quota--;
        return r;
      }, ctx.signal);
      return results;
    };

    // 1. retry pass
    if (cp.retry?.length) {
      const keys = cp.retry.splice(0, Math.max(0, quota));
      await run(keys.map((key) => ({ key, lastModified: "", etag: "", size: 0 })));
    }

    // 2. backfill pass
    if (!cp.complete) {
      let token: string | undefined;
      let startAfter = cp.after;
      for (let page = 0; page < o.maxListPages; page++) {
        if (quota <= 0 || ctx.budgetLeft() <= 0 || ctx.signal?.aborted) break;
        // Page size follows the remaining quota (the checkpoint resumes mid-prefix), so small runs do not list 1,000 keys.
        const res = await ctx.attempt(`list ${prefix}`, () => bucket.list(prefix, { token, startAfter: token ? undefined : startAfter, maxKeys: Math.min(1000, Math.max(50, quota * 4)), signal: ctx.signal }), { provider: bucket.name });
        if (!res) break;
        const objs = res.objects.filter((x) => isJson(x.key));
        stats.listed += objs.length;
        let i = 0;
        while (i < objs.length && quota > 0 && ctx.budgetLeft() > 0 && !ctx.signal?.aborted) {
          const batch = objs.slice(i, i + Math.max(1, Math.min(o.concurrency * 2, quota, ctx.budgetLeft())));
          await run(batch);
          i += batch.length;
          cp.after = batch[batch.length - 1].key;
          for (const b of batch) cp.watermark = maxIso(cp.watermark, b.lastModified);
          cursor.prefixes[prefix] = { ...cp, retry: [...(cp.retry ?? []), ...retryNext].slice(0, MAX_RETRY_KEYS) };
        }
        if (i < objs.length) break; // stopped inside the page (budget/quota); resume from cp.after next run
        if (!res.truncated || !res.nextToken) { cp.complete = true; break; }
        token = res.nextToken;
        startAfter = undefined;
      }
    } else {
      // 3. incremental pass over a completed prefix
      const changed: S3ObjectInfo[] = [];
      let token: string | undefined;
      for (let page = 0; page < o.maxListPages; page++) {
        const res = await ctx.attempt(`list ${prefix}`, () => bucket.list(prefix, { token, maxKeys: 1000, signal: ctx.signal }), { provider: bucket.name });
        if (!res) break;
        for (const x of res.objects) if (isJson(x.key) && (!cp.watermark || x.lastModified >= cp.watermark)) changed.push(x);
        stats.listed += res.objects.length;
        if (!res.truncated || !res.nextToken) break;
        token = res.nextToken;
      }
      changed.sort((a, b) => a.lastModified.localeCompare(b.lastModified) || a.key.localeCompare(b.key));
      let i = 0;
      while (i < changed.length && quota > 0 && ctx.budgetLeft() > 0 && !ctx.signal?.aborted) {
        const batch = changed.slice(i, i + Math.max(1, Math.min(o.concurrency * 2, quota, ctx.budgetLeft())));
        await run(batch);
        i += batch.length;
        for (const b of batch) cp.watermark = maxIso(cp.watermark, b.lastModified);
      }
    }
    if (cp.complete) stats.completedPrefixes++;
    cursor.prefixes[prefix] = { after: cp.after, complete: cp.complete, watermark: cp.watermark, ...(cp.retry?.length || retryNext.length ? { retry: [...(cp.retry ?? []), ...retryNext].slice(0, MAX_RETRY_KEYS) } : {}) };
  }
  return stats;
}

/** Years to ingest: explicit list, else the last `lastYears` years ending at `now` (newest first), bounded below by `fromYear`. */
export function yearsFor(cfg: { years?: number[]; lastYears: number; fromYear?: number }, now: Date): number[] {
  if (cfg.years?.length) return Array.from(new Set(cfg.years)).sort((a, b) => b - a);
  const current = now.getUTCFullYear();
  const out: number[] = [];
  for (let y = current; y > current - cfg.lastYears; y--) if (!cfg.fromYear || y >= cfg.fromYear) out.push(y);
  return out;
}
