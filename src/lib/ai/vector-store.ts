import "server-only";
import MiniSearch from "minisearch";
import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "@/lib/db/sqlite";
import { markDirty, registerVectorInvalidator } from "@/lib/db/sync";
import { aiConfig } from "./config";
import { bufferToFloat32, chunkText, cosine, embedTexts, embedText, float32ToBuffer } from "./embeddings";

/**
 * Retrieval scope (constitution §22, §27, §44).
 *
 * Every row in the vector index carries the tenant, the matter (for matter evidence) and the corpus (for tenant-wide
 * non-matter corpora) it belongs to, and every query narrows to an explicit scope. A missing scope never widens to
 * "search all matters": in strict mode (LECLAUDE_STRICT_SCOPE=true) it is an error; otherwise the call is recorded
 * as unscoped (see `unscopedRetrievalReport`) and only the caller's own filter applies, so nothing is widened silently.
 *
 * Scope shapes (client-safe types):
 *   { tenantId, matterIds }            matter evidence — rows whose matter is in the list
 *   { tenantId, corpus, matterIds? }   a tenant-wide corpus (authority, library, intel); `matterIds` optionally
 *                                      restricts the corpus's matter-linked rows (firm-wide rows always match)
 */
export type RetrievalCorpus = "authority" | "library" | "intel";
export const RETRIEVAL_CORPORA: readonly RetrievalCorpus[] = ["authority", "library", "intel"];

export interface MatterRetrievalScope {
  tenantId: string;
  /** Concrete matter ids; an empty list matches nothing (never "all"). */
  matterIds: string[];
}

export interface CorpusRetrievalScope {
  tenantId: string;
  corpus: RetrievalCorpus;
  /** When present, matter-linked rows of the corpus must belong to one of these matters. */
  matterIds?: string[];
}

export type RetrievalScope = MatterRetrievalScope | CorpusRetrievalScope;

export class ScopeError extends Error {
  readonly code = "scope_required" as const;
  constructor(message = "retrieval without scope") {
    super(message);
    this.name = "ScopeError";
  }
}

export function isCorpusScope(scope: RetrievalScope): scope is CorpusRetrievalScope {
  return typeof (scope as CorpusRetrievalScope).corpus === "string";
}

export function isMatterScope(scope: RetrievalScope): scope is MatterRetrievalScope {
  return !isCorpusScope(scope);
}

/** Human-readable scope for logs and traces (ids only, never content). */
export function describeScope(scope: RetrievalScope | undefined): string {
  if (!scope) return "unscoped";
  if (isCorpusScope(scope)) return `corpus:${scope.tenantId}/${scope.corpus}${scope.matterIds ? `[${scope.matterIds.join(",")}]` : ""}`;
  return `matter:${scope.tenantId}/[${scope.matterIds.join(",")}]`;
}

/** Throws when a scope is malformed (empty tenant, non-string matter ids, unknown corpus). */
export function assertValidScope(scope: RetrievalScope): void {
  if (!scope || typeof scope !== "object") throw new ScopeError("scope must be an object");
  if (typeof scope.tenantId !== "string" || !scope.tenantId.trim()) throw new ScopeError("scope.tenantId is required");
  const ids = (scope as MatterRetrievalScope).matterIds;
  if (isCorpusScope(scope)) {
    if (!RETRIEVAL_CORPORA.includes(scope.corpus)) throw new ScopeError(`unknown corpus "${String(scope.corpus)}"`);
    if (ids !== undefined && !(Array.isArray(ids) && ids.every((m) => typeof m === "string" && m.length > 0))) throw new ScopeError("scope.matterIds must be a list of matter ids");
    return;
  }
  if (!Array.isArray(ids) || !ids.every((m) => typeof m === "string" && m.length > 0)) throw new ScopeError("scope.matterIds must be a list of matter ids");
}

/** LECLAUDE_STRICT_SCOPE=true makes every unscoped retrieval an error (the follow-up wave turns this on in tests/evals). */
export function strictScopeEnabled(): boolean {
  const v = process.env.LECLAUDE_STRICT_SCOPE?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/**
 * The configured tenant, used only to stamp legacy/unscoped rows in development. Mirrors `tenantId()` in
 * src/lib/auth/principal.ts (same env var, same default); a test keeps the two in sync. Kept here so the retrieval
 * layer does not import the auth layer (which imports the database, which seeds through this module).
 */
export function configuredTenantId(): string {
  return process.env.LECLAUDE_TENANT_ID?.trim() || "default";
}

/** Well-known vector collections. Rows in the two library-visible collections belong to the "library" corpus. */
export const VECTOR_COLLECTIONS = { edocs: "ediscovery_documents", library: "library_items", office: "office_documents", depositions: "depositions" } as const;

/** Corpus assigned to legacy rows (indexed before scope existed) and to unscoped index calls in lenient mode. */
const LEGACY_CORPUS_BY_COLLECTION: Record<string, RetrievalCorpus> = {
  [VECTOR_COLLECTIONS.library]: "library",
  [VECTOR_COLLECTIONS.office]: "library",
  intel: "intel",
};

export interface VectorHit {
  docId: string;
  chunkIndex: number;
  text: string;
  score: number; // 0..1 fused score
  semantic?: number;
  keyword?: number;
  meta?: Record<string, unknown>;
  tenantId?: string | null;
  matterId?: string | null;
  corpus?: string | null;
}

interface Row {
  doc_id: string;
  chunk_index: number;
  text: string;
  embedding: Uint8Array | null;
  meta: string | null;
  model: string | null;
  tenant_id: string | null;
  matter_id: string | null;
  corpus: string | null;
}

interface RowScope { tenantId: string | null; matterId: string | null; corpus: string | null }

/** Pure scope predicate over a stored row (exported for tests and for callers that filter their own rows). */
export function rowInScope(row: RowScope, scope: RetrievalScope): boolean {
  if (row.tenantId !== scope.tenantId) return false;
  if (isCorpusScope(scope)) {
    if (row.corpus !== scope.corpus) return false;
    if (row.matterId == null) return true;
    return !scope.matterIds || scope.matterIds.includes(row.matterId);
  }
  return row.matterId != null && scope.matterIds.includes(row.matterId);
}

// ---------------------------------------------------------------------------
// Schema migration: scope columns on the vectors table (created in src/lib/db/sqlite.ts without them).
// ---------------------------------------------------------------------------

const migrated = new WeakSet<DatabaseSync>();

function parseMeta(meta: string | null): Record<string, unknown> {
  if (!meta) return {};
  try { const v = JSON.parse(meta); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

function matterIdFromMeta(meta: Record<string, unknown>): string | null {
  return typeof meta.matterId === "string" && meta.matterId ? meta.matterId : null;
}

/**
 * Adds tenant_id / matter_id / corpus to `vectors` when missing and backfills legacy rows from their own metadata
 * (matter from `meta.matterId`, corpus from the collection). The tenant of a legacy row cannot be recovered from the
 * row, so it is stamped with the configured tenant: legacy rows only exist in single-tenant development databases.
 * Idempotent; runs once per database handle.
 */
function ensureScopeSchema(db: DatabaseSync): void {
  if (migrated.has(db)) return;
  const cols = new Set((db.prepare("PRAGMA table_info(vectors)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("tenant_id")) db.exec("ALTER TABLE vectors ADD COLUMN tenant_id TEXT");
  if (!cols.has("matter_id")) db.exec("ALTER TABLE vectors ADD COLUMN matter_id TEXT");
  if (!cols.has("corpus")) db.exec("ALTER TABLE vectors ADD COLUMN corpus TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS vectors_scope ON vectors(collection, tenant_id, matter_id)");
  const legacy = db.prepare("SELECT collection, doc_id, chunk_index, meta FROM vectors WHERE tenant_id IS NULL").all() as { collection: string; doc_id: string; chunk_index: number; meta: string | null }[];
  if (legacy.length) {
    const tenant = configuredTenantId();
    const upd = db.prepare("UPDATE vectors SET tenant_id = ?, matter_id = ?, corpus = ? WHERE collection = ? AND doc_id = ? AND chunk_index = ?");
    db.exec("BEGIN");
    try {
      for (const r of legacy) upd.run(tenant, matterIdFromMeta(parseMeta(r.meta)), LEGACY_CORPUS_BY_COLLECTION[r.collection] ?? null, r.collection, r.doc_id, r.chunk_index);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    console.warn(JSON.stringify({ level: "warn", event: "retrieval.scope.backfill", rows: legacy.length, tenantId: tenant, note: "legacy vector rows stamped with the configured tenant and their meta.matterId" }));
  }
  migrated.add(db);
}

function sqlite(): DatabaseSync {
  const db = getSqlite();
  ensureScopeSchema(db);
  return db;
}

// ---------------------------------------------------------------------------
// Unscoped call-site report (lenient mode). One structured warning per site; counts for the follow-up wave.
// ---------------------------------------------------------------------------

export type RetrievalOperation = "search" | "index";

export interface UnscopedCallSite {
  site: string;
  operation: RetrievalOperation;
  collection: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

type ReportGlobal = typeof globalThis & { __leclaudeUnscopedRetrieval?: Map<string, UnscopedCallSite> };

function reportMap(): Map<string, UnscopedCallSite> {
  const g = globalThis as ReportGlobal;
  if (!g.__leclaudeUnscopedRetrieval) g.__leclaudeUnscopedRetrieval = new Map();
  return g.__leclaudeUnscopedRetrieval;
}

function callSite(): string {
  const cwd = process.cwd();
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    if (/vector-store\.[cm]?[jt]s/.test(line) || /node:internal|node_modules/.test(line)) continue;
    return line.replace(/^at\s+/, "").replace(/file:\/\//g, "").split(cwd + "/").join("./").replace(/\?[^\s:)]*/g, "");
  }
  return "unknown";
}

function noteUnscoped(operation: RetrievalOperation, collection: string): void {
  const site = callSite();
  const key = `${operation}|${collection}|${site}`;
  const now = new Date().toISOString();
  const map = reportMap();
  const entry = map.get(key);
  if (entry) { entry.count++; entry.lastAt = now; return; }
  map.set(key, { site, operation, collection, count: 1, firstAt: now, lastAt: now });
  console.warn(JSON.stringify({ level: "warn", event: "retrieval.unscoped", operation, collection, site, hint: "pass { scope } (RetrievalScope); LECLAUDE_STRICT_SCOPE=true turns this into a ScopeError" }));
}

/** Unscoped retrieval calls seen by this process (lenient mode), grouped by call site. */
export function unscopedRetrievalReport(): { strict: boolean; total: number; sites: UnscopedCallSite[] } {
  const sites = Array.from(reportMap().values()).sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));
  return { strict: strictScopeEnabled(), total: sites.reduce((n, s) => n + s.count, 0), sites };
}

export function resetUnscopedRetrievalReport(): void {
  reportMap().clear();
}

/** Validates an explicit scope, or applies the strict/lenient policy when none was given. */
function requireScope(scope: RetrievalScope | undefined, operation: RetrievalOperation, collection: string): RetrievalScope | undefined {
  if (scope) { assertValidScope(scope); return scope; }
  if (strictScopeEnabled()) throw new ScopeError(`retrieval without scope (${operation} ${collection})`);
  noteUnscoped(operation, collection);
  return undefined;
}

/** Scope columns for one document being indexed. Never binds a document to a matter it did not declare. */
function rowScopeFor(collection: string, scope: RetrievalScope | undefined, doc: { id: string; matterId?: string | null; meta?: Record<string, unknown> }): RowScope {
  const declared = doc.matterId ?? matterIdFromMeta(doc.meta ?? {});
  if (!scope) return { tenantId: configuredTenantId(), matterId: declared, corpus: LEGACY_CORPUS_BY_COLLECTION[collection] ?? null };
  if (isCorpusScope(scope)) {
    if (declared && scope.matterIds && !scope.matterIds.includes(declared)) throw new ScopeError(`document ${doc.id} declares matter ${declared} outside the ${scope.corpus} scope`);
    return { tenantId: scope.tenantId, matterId: declared, corpus: scope.corpus };
  }
  const matterId = declared ?? (scope.matterIds.length === 1 ? scope.matterIds[0] : null);
  if (!matterId) throw new ScopeError(`document ${doc.id} does not declare a matter; matter evidence indexed under a multi-matter scope must carry matterId`);
  if (!scope.matterIds.includes(matterId)) throw new ScopeError(`document ${doc.id} declares matter ${matterId} outside scope [${scope.matterIds.join(",")}]`);
  return { tenantId: scope.tenantId, matterId, corpus: null };
}

// ---------------------------------------------------------------------------
// In-memory per-collection index (rows + vectors + BM25), keyed by database handle so a reset drops it.
// ---------------------------------------------------------------------------

interface Entry { rows: Row[]; vecs: (Float32Array | null)[]; metas: (Record<string, unknown> | undefined)[]; mini: MiniSearch<{ id: string; text: string }> }

const caches = new WeakMap<DatabaseSync, Map<string, Entry>>();

function cache(db: DatabaseSync): Map<string, Entry> {
  let c = caches.get(db);
  if (!c) { c = new Map(); caches.set(db, c); }
  return c;
}

function loadCollection(collection: string): Entry {
  const db = sqlite();
  const c = cache(db);
  let entry = c.get(collection);
  if (entry) return entry;
  const rows = db.prepare("SELECT doc_id, chunk_index, text, embedding, meta, model, tenant_id, matter_id, corpus FROM vectors WHERE collection = ?").all(collection) as unknown as Row[];
  const vecs = rows.map((r) => (r.embedding ? bufferToFloat32(r.embedding) : null));
  const mini = new MiniSearch<{ id: string; text: string }>({ fields: ["text"], storeFields: [], searchOptions: { prefix: true, fuzzy: 0.15, combineWith: "AND" } });
  mini.addAll(rows.map((r, i) => ({ id: String(i), text: r.text })));
  entry = { rows, vecs, metas: rows.map(() => undefined), mini };
  c.set(collection, entry);
  return entry;
}

function invalidate(collection: string) {
  cache(sqlite()).delete(collection);
}

// Rows pulled from the shared store (serverless mode) must drop the parsed cache too.
registerVectorInvalidator(invalidate);

function metaOf(entry: Entry, i: number): Record<string, unknown> {
  let m = entry.metas[i];
  if (!m) { m = parseMeta(entry.rows[i].meta); entry.metas[i] = m; }
  return m;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export interface IndexOptions {
  /** Scope every indexed row is stamped with. Required in strict mode. */
  scope?: RetrievalScope;
  embed?: boolean;
  chunkSize?: number;
}

export interface IndexableDocument {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
  /** The matter this document is evidence in (falls back to meta.matterId). */
  matterId?: string | null;
}

/**
 * Index a document's text as embedded chunks. Keyword-only indexing happens
 * even when embeddings fail (no API key), so search degrades gracefully.
 */
export async function indexDocument(collection: string, docId: string, text: string, meta: Record<string, unknown> = {}, opts: IndexOptions = {}) {
  const scope = requireScope(opts.scope, "index", collection);
  const row = rowScopeFor(collection, scope, { id: docId, meta });
  const db = sqlite();
  const chunks = chunkText(text, { size: opts.chunkSize ?? 1600 });
  let vecs: (Float32Array | null)[] = chunks.map(() => null);
  let model: string | null = null;
  if (opts.embed !== false && aiConfig().hasKey && chunks.length) {
    try { vecs = await embedTexts(chunks); model = aiConfig().embeddingModel; } catch (e) { console.warn(`[vector-store] embedding failed for ${collection}/${docId}:`, (e as Error).message); }
  }
  const del = db.prepare("DELETE FROM vectors WHERE collection = ? AND doc_id = ?");
  const ins = db.prepare("INSERT INTO vectors (collection, doc_id, chunk_index, text, embedding, meta, model, tenant_id, matter_id, corpus) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    del.run(collection, docId);
    chunks.forEach((t, i) => ins.run(collection, docId, i, t, vecs[i] ? float32ToBuffer(vecs[i]!) : null, JSON.stringify(meta), model, row.tenantId, row.matterId, row.corpus));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  markDirty("vectors", collection, docId);
  invalidate(collection);
  return { chunks: chunks.length, embedded: vecs.filter(Boolean).length };
}

/** Index many documents; embeds in batches for throughput. Every document is validated against the scope before any write. */
export async function indexDocuments(collection: string, docs: IndexableDocument[], opts: IndexOptions & { onProgress?: (done: number, total: number) => void } = {}) {
  const scope = requireScope(opts.scope, "index", collection);
  const rowScopes = new Map(docs.map((d) => [d.id, rowScopeFor(collection, scope, d)] as const));
  const db = sqlite();
  const all: { docId: string; idx: number; text: string; meta: Record<string, unknown> }[] = [];
  for (const d of docs) chunkText(d.text, { size: opts.chunkSize ?? 1600 }).forEach((t, i) => all.push({ docId: d.id, idx: i, text: t, meta: d.meta ?? {} }));
  let vecs: (Float32Array | null)[] = all.map(() => null);
  let model: string | null = null;
  if (opts.embed !== false && aiConfig().hasKey && all.length) {
    try { vecs = await embedTexts(all.map((a) => a.text)); model = aiConfig().embeddingModel; } catch (e) { console.warn(`[vector-store] batch embedding failed:`, (e as Error).message); }
  }
  const del = db.prepare("DELETE FROM vectors WHERE collection = ? AND doc_id = ?");
  const ins = db.prepare("INSERT INTO vectors (collection, doc_id, chunk_index, text, embedding, meta, model, tenant_id, matter_id, corpus) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const d of docs) del.run(collection, d.id);
    all.forEach((a, i) => {
      const rs = rowScopes.get(a.docId)!;
      ins.run(collection, a.docId, a.idx, a.text, vecs[i] ? float32ToBuffer(vecs[i]!) : null, JSON.stringify(a.meta), model, rs.tenantId, rs.matterId, rs.corpus);
    });
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  for (const d of docs) markDirty("vectors", collection, d.id);
  invalidate(collection);
  opts.onProgress?.(docs.length, docs.length);
  return { docs: docs.length, chunks: all.length, embedded: vecs.filter(Boolean).length };
}

export function removeDocument(collection: string, docId: string) {
  sqlite().prepare("DELETE FROM vectors WHERE collection = ? AND doc_id = ?").run(collection, docId);
  markDirty("vectors", collection, docId);
  invalidate(collection);
}

/** Index size. Counts are not evidence, so an unscoped call is allowed; with a scope only rows in scope are counted. */
export function indexStats(collection: string, scope?: RetrievalScope) {
  const entry = loadCollection(collection);
  if (scope) assertValidScope(scope);
  const idx = scope ? entry.rows.map((_, i) => i).filter((i) => rowInScope(rowScopeOf(entry.rows[i]), scope)) : entry.rows.map((_, i) => i);
  const docs = new Set(idx.map((i) => entry.rows[i].doc_id)).size;
  return { docs, chunks: idx.length, embedded: idx.filter((i) => entry.vecs[i]).length };
}

function rowScopeOf(r: Row): RowScope {
  return { tenantId: r.tenant_id, matterId: r.matter_id, corpus: r.corpus };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Scope rows are filtered by before ranking (keyword and semantic paths). Required in strict mode. */
  scope?: RetrievalScope;
  k?: number;
  /** Additional caller narrowing (never widening) over the row's meta and document id. */
  filter?: (meta: Record<string, unknown>, docId: string) => boolean;
  perDoc?: number;
}

/**
 * Hybrid search: cosine similarity over embeddings fused (reciprocal rank)
 * with BM25 keyword results. Works keyword-only when no embeddings exist.
 * Both paths only ever see rows inside `scope`.
 */
export async function hybridSearch(collection: string, query: string, opts: SearchOptions = {}): Promise<VectorHit[]> {
  const scope = requireScope(opts.scope, "search", collection);
  const k = opts.k ?? 10;
  if (scope && !isCorpusScope(scope) && scope.matterIds.length === 0) return [];
  const entry = loadCollection(collection);
  const { rows, vecs, mini } = entry;
  if (!rows.length || !query.trim()) return [];

  const allowed = (i: number) => {
    const r = rows[i];
    if (scope && !rowInScope(rowScopeOf(r), scope)) return false;
    return opts.filter ? opts.filter(metaOf(entry, i), r.doc_id) : true;
  };

  // keyword
  const kw = new Map<number, number>();
  try {
    const res = mini.search(query, { combineWith: "AND" });
    const res2 = res.length ? res : mini.search(query, { combineWith: "OR" });
    res2.forEach((r, rank) => { const i = Number(r.id); if (allowed(i)) kw.set(i, 1 / (60 + rank)); });
  } catch { /* ignore */ }

  // semantic
  const sem = new Map<number, number>();
  const semRaw = new Map<number, number>();
  const hasVecs = vecs.some(Boolean);
  if (hasVecs && aiConfig().hasKey) {
    try {
      const q = await embedText(query);
      const scored: { i: number; s: number }[] = [];
      for (let i = 0; i < rows.length; i++) { const v = vecs[i]; if (!v || !allowed(i)) continue; scored.push({ i, s: cosine(q, v) }); }
      scored.sort((a, b) => b.s - a.s).slice(0, k * 4).forEach((r, rank) => { sem.set(r.i, 1 / (60 + rank)); semRaw.set(r.i, r.s); });
    } catch (e) { console.warn("[vector-store] query embedding failed:", (e as Error).message); }
  }

  const fused = new Map<number, number>();
  for (const [i, s] of kw) fused.set(i, (fused.get(i) ?? 0) + s);
  for (const [i, s] of sem) fused.set(i, (fused.get(i) ?? 0) + s * 1.1);
  const max = Math.max(...fused.values(), 1e-9);

  const perDoc = opts.perDoc ?? 2;
  const seen = new Map<string, number>();
  const hits: VectorHit[] = [];
  for (const [i, s] of Array.from(fused.entries()).sort((a, b) => b[1] - a[1])) {
    const r = rows[i];
    const n = seen.get(r.doc_id) ?? 0;
    if (n >= perDoc) continue;
    seen.set(r.doc_id, n + 1);
    hits.push({ docId: r.doc_id, chunkIndex: r.chunk_index, text: r.text, score: s / max, semantic: semRaw.get(i), keyword: kw.get(i), meta: r.meta ? metaOf(entry, i) : undefined, tenantId: r.tenant_id, matterId: r.matter_id, corpus: r.corpus });
    if (hits.length >= k) break;
  }
  return hits;
}
