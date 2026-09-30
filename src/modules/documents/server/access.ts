import "server-only";
import { can } from "@/lib/auth/policy";
import { refs } from "@/lib/auth/resources";
import type { Action, Principal } from "@/lib/auth/types";
import type { DocSet } from "../types";
import { docStore, type DocStore } from "./store";

/**
 * Authorization for document sets (constitution §22). A set on a matter follows the matter policy
 * (`can(principal, action, refs.matter(matterId))`); a personal set is visible to its owner only. The tenant must
 * match in both cases. Unknown and unreadable sets are indistinguishable (404); a readable set the caller may not
 * change is a 403.
 */

export class DocsError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "DocsError";
  }
}

export const setNotFound = () => new DocsError("Document set not found", 404, "not_found");

export type SetAction = Extract<Action, "read" | "write" | "delete">;

export function canAccessSet(principal: Principal, set: DocSet, action: SetAction): boolean {
  if (!principal?.id || set.tenantId !== principal.tenantId) return false;
  if (set.matterId) return can(principal, action, { ...refs.matter(set.matterId), tenantId: set.tenantId });
  return set.ownerId === principal.id;
}

/** Resolve a set for `action`, or throw 404 (unknown or unreadable) / 403 (readable, action not allowed). */
export async function loadSet(principal: Principal, setId: string, action: SetAction = "read", store?: DocStore): Promise<DocSet> {
  const s = store ?? (await docStore());
  const set = typeof setId === "string" && setId ? await s.getSet(setId) : null;
  if (!set || !canAccessSet(principal, set, "read")) throw setNotFound();
  if (action !== "read" && !canAccessSet(principal, set, action)) throw new DocsError("You may not change this document set", 403, "forbidden");
  return set;
}

/** Sets the principal may read, newest first. */
export async function readableSets(principal: Principal, store?: DocStore): Promise<DocSet[]> {
  const s = store ?? (await docStore());
  const sets = await s.listSets({ tenantId: principal.tenantId, ownerId: principal.id, matterIds: principal.matterIds });
  return sets.filter((set) => canAccessSet(principal, set, "read"));
}

/** The subset of `setIds` the principal may read (unknown ids dropped). Never widens: an empty input stays empty. */
export async function readableSetIds(principal: Principal, setIds: string[], store?: DocStore): Promise<DocSet[]> {
  const s = store ?? (await docStore());
  const out: DocSet[] = [];
  for (const id of Array.from(new Set(setIds.filter((x) => typeof x === "string" && x)))) {
    const set = await s.getSet(id);
    if (set && canAccessSet(principal, set, "read")) out.push(set);
  }
  return out;
}
