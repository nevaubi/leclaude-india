import "server-only";
import type { Principal } from "@/lib/auth/types";
import type { DocSearchHit, DocSet } from "../types";

/**
 * Server facade for document sets used outside the module (Chat tools, research). CONTRACT STUB — the backend
 * workstream replaces every body; nothing here ships.
 */

/** Sets the principal may read (owner, or member of the set's matter), newest first. */
export async function listDocSets(principal: Principal): Promise<DocSet[]> {
  void principal;
  throw new Error("documents: listDocSets not implemented");
}

/**
 * Full-text search across the given sets. Set ids the principal cannot read are dropped (fail closed: none left → []).
 * Never widens to other sets when `setIds` is empty.
 */
export async function searchDocSets(principal: Principal, setIds: string[], query: string, opts: { limit?: number; fileIds?: string[] } = {}): Promise<DocSearchHit[]> {
  void principal; void setIds; void query; void opts;
  throw new Error("documents: searchDocSets not implemented");
}

/** Resolve one docs:// source id to its passage (authorized), with neighbouring text on the same page. */
export async function readDocPassage(principal: Principal, source: string): Promise<{ hit: DocSearchHit; context: string } | null> {
  void principal; void source;
  throw new Error("documents: readDocPassage not implemented");
}
