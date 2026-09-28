import "server-only";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/integrity/hash";
import type { ReadRef } from "../types";

/** Full-text source reads are cached for 24 hours so lanes, the reader sheet and re-runs never fetch the same page twice. */
export const SOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 120_000;

export interface CachedSource {
  id: string;
  key: string;
  kind: ReadRef["kind"];
  title?: string;
  cite?: string;
  url?: string;
  text: string;
  length: number;
  fetchedAt: string;
  hits: number;
}

export const sourceCache = () => db().collection<CachedSource>("search_source_cache");

export function cacheKey(ref: ReadRef): string {
  switch (ref.kind) {
    case "opinion": return `opinion:${ref.id}`;
    case "cfr": return `cfr:${ref.title}:${ref.section}`;
    case "fr": return `fr:${ref.id}`;
    case "library": return `library:${ref.id}`;
    case "edoc": return `edoc:${ref.id}`;
    case "url":
    case "statute": return `url:${ref.url.trim()}`;
    case "judgment": return `judgment:${ref.id}`;
    case "section": return `section:${ref.id}`;
  }
}

export function getCached(ref: ReadRef, now = Date.now()): CachedSource | null {
  const key = cacheKey(ref);
  const row = sourceCache().get(sha256(key).slice(0, 24));
  if (!row) return null;
  if (now - new Date(row.fetchedAt).getTime() > SOURCE_CACHE_TTL_MS) { sourceCache().delete(row.id); return null; }
  sourceCache().put({ ...row, hits: row.hits + 1 });
  return row;
}

export function putCached(ref: ReadRef, r: { title?: string; cite?: string; url?: string; text: string }): CachedSource {
  const key = cacheKey(ref);
  // Matter documents, library items, corpus judgments and India Code sections are already local; caching them buys nothing and risks staleness after edits.
  const row: CachedSource = { id: sha256(key).slice(0, 24), key, kind: ref.kind, title: r.title, cite: r.cite, url: r.url, text: r.text.slice(0, MAX_TEXT), length: r.text.length, fetchedAt: new Date().toISOString(), hits: 0 };
  if (ref.kind !== "edoc" && ref.kind !== "library" && ref.kind !== "judgment" && ref.kind !== "section") sourceCache().put(row);
  return row;
}

/** Drop expired rows (called opportunistically at the end of a run). */
export function sweepCache(now = Date.now()): number {
  const c = sourceCache();
  let n = 0;
  for (const row of c.all()) if (now - new Date(row.fetchedAt).getTime() > SOURCE_CACHE_TTL_MS) { c.delete(row.id); n++; }
  return n;
}

/**
 * Per-run shared read registry (constitution §14 "shared evidence + read registry"):
 * lanes that read the same source concurrently share one in-flight fetch, and a source
 * is never re-read once its text is in the run. Sits in front of the 24h persistent cache.
 */
export interface ReadRegistry {
  /** Text already read in this run, by source id. */
  texts: Map<string, string>;
  /**
   * Read (or join the in-flight read of) a source; `fetch` runs at most once per key
   * unless the lane that started it was cancelled, in which case a live joiner fetches itself.
   */
  read<T extends { text: string }>(key: string, fetch: () => Promise<T>, signal?: AbortSignal): Promise<T & { shared: boolean }>;
  /** How many reads joined an in-flight fetch instead of fetching again. */
  sharedReads: () => number;
}

export function createReadRegistry(texts: Map<string, string> = new Map()): ReadRegistry {
  const inflight = new Map<string, Promise<{ text: string }>>();
  let shared = 0;
  const startFetch = <T extends { text: string }>(key: string, fetch: () => Promise<T>): Promise<T> => {
    const p = fetch().then((r) => { texts.set(key, r.text ?? ""); return r; }).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
    inflight.set(key, p);
    return p;
  };
  return {
    texts,
    async read(key, fetch, signal) {
      const existing = inflight.get(key) as Promise<Awaited<ReturnType<typeof fetch>>> | undefined;
      if (existing) {
        shared++;
        try {
          return { ...(await existing), shared: true };
        } catch (e) {
          // The lane that owned the fetch was aborted (timeout/cancel); this lane is still live, so it reads for itself.
          if ((e as Error)?.name !== "AbortError" || signal?.aborted) throw e;
        }
      }
      return { ...(await startFetch(key, fetch)), shared: false };
    },
    sharedReads: () => shared,
  };
}
