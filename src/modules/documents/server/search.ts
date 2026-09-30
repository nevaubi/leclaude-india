import "server-only";
import { docSourceId, type DocSearchHit } from "../types";
import type { ChunkRow, DocStore, ScoredChunk, StoredFile } from "./store";

/** Retrieval over stored chunks: ranked full-text search, or every chunk in order when the scope is small. */

export const WHOLE_SET_MAX_CHUNKS = 40;

async function toHits(store: DocStore, chunks: (ChunkRow & { score?: number })[]): Promise<DocSearchHit[]> {
  const bySet = new Map<string, Set<string>>();
  for (const c of chunks) { if (!bySet.has(c.setId)) bySet.set(c.setId, new Set()); bySet.get(c.setId)!.add(c.fileId); }
  const files = new Map<string, StoredFile>();
  await Promise.all(Array.from(bySet.entries()).map(async ([setId, ids]) => {
    for (const f of await store.getFiles(setId, Array.from(ids))) files.set(f.id, f);
  }));
  const out: DocSearchHit[] = [];
  for (const c of chunks) {
    const f = files.get(c.fileId);
    if (!f) continue; // a file deleted mid-query is dropped, never re-bound
    const hit: DocSearchHit = { source: docSourceId(c.setId, c.fileId, c.page, c.idx), setId: c.setId, fileId: c.fileId, fileName: f.name, page: c.page, idx: c.idx, text: c.text, score: c.score ?? 0 };
    if (c.page != null && (f.ocrDonePages ?? []).includes(c.page)) hit.ocr = true;
    out.push(hit);
  }
  return out;
}

/** Ranked full-text search over already-authorized set ids. */
export async function searchChunks(store: DocStore, setIds: string[], query: string, opts: { limit?: number; fileIds?: string[] } = {}): Promise<DocSearchHit[]> {
  if (!setIds.length) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 14, 50));
  const rows: ScoredChunk[] = await store.search(setIds, query, { limit, fileIds: opts.fileIds?.length ? opts.fileIds : undefined });
  return toHits(store, rows);
}

/**
 * Passages for a question: the whole scope in order when it holds at most `wholeSetMax` chunks, otherwise the top
 * `limit` ranked chunks. Returns `mode` so callers can say which one was used.
 */
export async function retrievePassages(store: DocStore, setIds: string[], query: string, opts: { limit?: number; fileIds?: string[]; wholeSetMax?: number } = {}): Promise<{ hits: DocSearchHit[]; mode: "whole" | "search"; scopeChunks: number }> {
  if (!setIds.length) return { hits: [], mode: "search", scopeChunks: 0 };
  const fileIds = opts.fileIds?.length ? opts.fileIds : undefined;
  const wholeMax = opts.wholeSetMax ?? WHOLE_SET_MAX_CHUNKS;
  const total = await store.countChunks(setIds, fileIds);
  if (total === 0) return { hits: [], mode: "whole", scopeChunks: 0 };
  if (total <= wholeMax) return { hits: await toHits(store, await store.allChunks(setIds, fileIds, wholeMax)), mode: "whole", scopeChunks: total };
  return { hits: await searchChunks(store, setIds, query, { limit: opts.limit ?? 14, fileIds }), mode: "search", scopeChunks: total };
}
