import "server-only";
import { nanoid } from "nanoid";
import { can } from "@/lib/auth/policy";
import { refs } from "@/lib/auth/resources";
import type { Principal } from "@/lib/auth/types";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import type { AuditAction } from "@/lib/integrity/types";
import type { DocFile, DocFileStatus, DocSet } from "../types";
import { DocsError, loadSet, readableSets } from "./access";
import { docStore, publicFile } from "./store";
import { joinChunks } from "./text";

/** Set and file management (create, rename, delete, list, read pages) plus the storage status. */

const FILE_STATUSES: DocFileStatus[] = ["ready", "partial", "needs_ocr", "empty", "failed"];

export function recordAudit(principal: Principal, action: AuditAction, target: { kind: string; id?: string; label?: string; matterId?: string }, meta?: Record<string, unknown>) {
  try {
    audit(action, target, meta, { id: principal.id, name: principal.name });
  } catch (e) {
    console.warn("[documents] audit write failed", (e as Error).message);
  }
}

function cleanName(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

export async function listSets(principal: Principal): Promise<DocSet[]> {
  return readableSets(principal);
}

export async function createSet(principal: Principal, input: { name?: unknown; description?: unknown; matterId?: unknown }): Promise<DocSet> {
  const name = cleanName(input.name, 200);
  if (!name) throw new DocsError("A name is required", 422, "invalid");
  const description = input.description == null || input.description === "" ? null : cleanName(input.description, 2000);
  let matterId: string | null = null;
  if (input.matterId != null && input.matterId !== "") {
    if (typeof input.matterId !== "string") throw new DocsError("matterId must be a string", 422, "invalid");
    const matter = db().matters.get(input.matterId);
    const ref = { ...refs.matter(input.matterId), tenantId: principal.tenantId };
    // An unknown matter and a matter the caller cannot read look the same.
    if (!matter || !can(principal, "read", ref)) throw new DocsError("Matter not found", 404, "not_found");
    if (!can(principal, "write", ref)) throw new DocsError("You may not add document sets to this matter", 403, "forbidden");
    matterId = input.matterId;
  }
  const now = new Date().toISOString();
  const set: DocSet = { id: `dset_${nanoid(12)}`, name, description, matterId, ownerId: principal.id, tenantId: principal.tenantId, fileCount: 0, pageCount: 0, extractedCount: 0, createdAt: now, updatedAt: now };
  await (await docStore()).insertSet(set);
  recordAudit(principal, "create", { kind: "document_set", id: set.id, label: set.name, matterId: matterId ?? undefined });
  return set;
}

export async function getSet(principal: Principal, setId: string): Promise<DocSet> {
  return loadSet(principal, setId, "read");
}

export async function updateSet(principal: Principal, setId: string, patch: { name?: unknown; description?: unknown }): Promise<DocSet> {
  const set = await loadSet(principal, setId, "write");
  const out: { name?: string; description?: string | null } = {};
  if (patch.name !== undefined) {
    const n = cleanName(patch.name, 200);
    if (!n) throw new DocsError("A name is required", 422, "invalid");
    out.name = n;
  }
  if (patch.description !== undefined) out.description = patch.description == null || patch.description === "" ? null : cleanName(patch.description, 2000);
  const store = await docStore();
  if (out.name !== undefined || out.description !== undefined) await store.updateSet(set.id, out);
  return (await store.getSet(set.id))!;
}

export async function deleteSet(principal: Principal, setId: string): Promise<void> {
  const set = await loadSet(principal, setId, "delete");
  await (await docStore()).deleteSet(set.id);
  recordAudit(principal, "delete", { kind: "document_set", id: set.id, label: set.name, matterId: set.matterId ?? undefined }, { files: set.fileCount });
}

export async function listFiles(principal: Principal, setId: string, q: { offset?: unknown; limit?: unknown; status?: unknown; q?: unknown }): Promise<{ files: DocFile[]; total: number }> {
  const set = await loadSet(principal, setId, "read");
  const int = (v: unknown, d: number, min: number, max: number) => { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? d : Math.max(min, Math.min(max, Math.floor(n))); };
  const status = typeof q.status === "string" && FILE_STATUSES.includes(q.status as DocFileStatus) ? (q.status as DocFileStatus) : undefined;
  const res = await (await docStore()).listFiles(set.id, { offset: int(q.offset, 0, 0, 1_000_000), limit: int(q.limit, 100, 1, 500), status, q: typeof q.q === "string" ? q.q.slice(0, 200) : undefined });
  return { files: res.files.map(publicFile), total: res.total };
}

/** A file with its stored text by page (all pages, or one). Non-paged formats return one entry with page null. */
export async function getFilePages(principal: Principal, setId: string, fileId: string, page?: number): Promise<{ file: DocFile; pages: { page: number | null; text: string }[] }> {
  const set = await loadSet(principal, setId, "read");
  const store = await docStore();
  const file = await store.getFile(set.id, fileId);
  if (!file) throw new DocsError("File not found", 404, "not_found");
  const chunks = await store.fileChunks(file.id, page != null && Number.isInteger(page) && page > 0 ? page : undefined);
  const byPage = new Map<number | null, typeof chunks>();
  for (const c of chunks) { const k = c.page; if (!byPage.has(k)) byPage.set(k, []); byPage.get(k)!.push(c); }
  const pages = Array.from(byPage.entries()).map(([p, cs]) => ({ page: p, text: joinChunks(cs) })).sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  return { file: publicFile(file), pages };
}

export async function deleteFile(principal: Principal, setId: string, fileId: string): Promise<void> {
  const set = await loadSet(principal, setId, "delete");
  const store = await docStore();
  const file = await store.getFile(set.id, fileId);
  if (!file) throw new DocsError("File not found", 404, "not_found");
  await store.deleteFile(set.id, file.id);
  await store.refreshSetCounts(set.id);
  recordAudit(principal, "delete", { kind: "document_file", id: file.id, label: file.name, matterId: set.matterId ?? undefined }, { setId: set.id, sha256: file.sha256 });
}

// ---- storage guard ----------------------------------------------------------------------------------------------

export interface StorageStatus { backend: "postgres" | "sqlite"; usedMb: number | null; limitMb: number | null; full: boolean }

let storageCache: { at: number; backend: string; value: StorageStatus } | null = null;

export function docsMaxDbMb(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number(env.DOCS_MAX_DB_MB);
  return Number.isFinite(n) && n > 0 ? n : 490;
}

/** Storage use. On Postgres the database size is compared with DOCS_MAX_DB_MB (default 490); cached for 30 s. */
export async function storageStatus(fresh = false): Promise<StorageStatus> {
  const store = await docStore();
  if (!fresh && storageCache && storageCache.backend === store.backend && Date.now() - storageCache.at < 30_000) return storageCache.value;
  const { usedMb } = await store.storage();
  const limitMb = store.backend === "postgres" ? docsMaxDbMb() : null;
  const value: StorageStatus = { backend: store.backend, usedMb, limitMb, full: limitMb != null && usedMb != null && usedMb >= limitMb };
  storageCache = { at: Date.now(), backend: store.backend, value };
  return value;
}

export function resetStorageCacheForTests() { storageCache = null; }

/** Throws a clear 507 when the database is at its configured limit. */
export async function assertStorageAvailable(): Promise<void> {
  const s = await storageStatus();
  if (s.full) throw new DocsError(`Document storage is full (${s.usedMb} MB of ${s.limitMb} MB). The database plan must be upgraded (or DOCS_MAX_DB_MB raised) before more files can be added.`, 507, "storage_full");
}
