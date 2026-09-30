import "server-only";
import type { Principal } from "@/lib/auth/types";
import { parseDocSourceId, type DocSearchHit, type DocSet } from "../types";
import { readableSetIds, readableSets } from "./access";
import { searchChunks } from "./search";
import { docStore } from "./store";
import { joinChunks } from "./text";

/**
 * Server facade for document sets used outside the module (Chat tools, research). Every function authorizes against
 * the principal; set ids the principal cannot read are dropped, never widened.
 */

/** Sets the principal may read (owner, or member of the set's matter), newest first. */
export async function listDocSets(principal: Principal): Promise<DocSet[]> {
  return readableSets(principal);
}

/**
 * Full-text search across the given sets. Set ids the principal cannot read are dropped (fail closed: none left → []).
 * Never widens to other sets when `setIds` is empty.
 */
export async function searchDocSets(principal: Principal, setIds: string[], query: string, opts: { limit?: number; fileIds?: string[] } = {}): Promise<DocSearchHit[]> {
  if (!Array.isArray(setIds) || !setIds.length || typeof query !== "string" || !query.trim()) return [];
  const store = await docStore();
  const allowed = await readableSetIds(principal, setIds, store);
  if (!allowed.length) return [];
  return searchChunks(store, allowed.map((s) => s.id), query, { limit: Math.max(1, Math.min(opts.limit ?? 8, 30)), fileIds: opts.fileIds });
}

const CONTEXT_CHARS = 6000;

/** Resolve one docs:// source id to its passage (authorized), with neighbouring text on the same page. */
export async function readDocPassage(principal: Principal, source: string): Promise<{ hit: DocSearchHit; context: string } | null> {
  const ref = typeof source === "string" ? parseDocSourceId(source.trim()) : null;
  if (!ref) return null;
  const store = await docStore();
  const [set] = await readableSetIds(principal, [ref.setId], store);
  if (!set) return null;
  const chunk = await store.getChunk(ref.fileId, ref.idx);
  // The id must resolve exactly: same set and same page, or nothing.
  if (!chunk || chunk.setId !== set.id || chunk.page !== ref.page) return null;
  const [file] = await store.getFiles(set.id, [chunk.fileId]);
  if (!file) return null;
  let context: string;
  if (chunk.page != null) {
    context = joinChunks(await store.fileChunks(file.id, chunk.page));
  } else {
    const near = (await store.fileChunks(file.id)).filter((c) => Math.abs(c.idx - chunk.idx) <= 1);
    context = joinChunks(near);
  }
  if (context.length > CONTEXT_CHARS) {
    const body = chunk.text.slice(chunk.lead);
    const at = Math.max(0, context.indexOf(body));
    const start = Math.max(0, Math.min(at - Math.floor((CONTEXT_CHARS - body.length) / 2), context.length - CONTEXT_CHARS));
    context = context.slice(start, start + CONTEXT_CHARS);
  }
  const hit: DocSearchHit = { source: source.trim(), setId: set.id, fileId: file.id, fileName: file.name, page: chunk.page, idx: chunk.idx, text: chunk.text, score: 1 };
  if (chunk.page != null && (file.ocrDonePages ?? []).includes(chunk.page)) hit.ocr = true;
  return { hit, context };
}
