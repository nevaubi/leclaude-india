import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { remoteStore, type RemoteStore } from "@/lib/db/remote";
import { getSqlite } from "@/lib/db/sqlite";
import { docStore } from "./store";

/**
 * Drafting work items of a document set (list-of-dates edits and synopsis, para-wise replies, translations, defect
 * notices): one small table keyed by (set, kind, key) holding JSON, on the same backend as the set's files (Postgres in
 * production, the local SQLite file in development and tests). Rows are always read through an authorized set id;
 * they are deleted with their set (and with their file where the key is file-scoped).
 */

export type WorkKind = "dates" | "parawise" | "translation" | "defects";

export interface WorkItem<T = unknown> {
  setId: string;
  kind: WorkKind;
  /** Unique within (set, kind). File-scoped items start with the file id ("<fileId>" or "<fileId>:…"). */
  key: string;
  data: T;
  /** Hash of the source text the item was derived from (staleness), when it has one. */
  textHash: string | null;
  createdBy: string;
  updatedAt: string;
}

export interface WorkStore {
  get<T>(setId: string, kind: WorkKind, key: string): Promise<WorkItem<T> | null>;
  /** Items of one kind, newest first; `prefix` narrows by key prefix. Bounded by `limit` (default 500). */
  list<T>(setId: string, kind: WorkKind, opts?: { prefix?: string; limit?: number }): Promise<WorkItem<T>[]>;
  put<T>(item: WorkItem<T>): Promise<void>;
  delete(setId: string, kind: WorkKind, key: string): Promise<void>;
  /** Every item of a set (set deleted). */
  deleteSet(setId: string): Promise<void>;
  /** Items keyed by a file ("<fileId>" or "<fileId>:…") across kinds (file deleted). */
  deleteFile(setId: string, fileId: string): Promise<void>;
}

/** Largest JSON payload stored per item (a long translation or a 300-paragraph reply fits well under it). */
export const MAX_WORK_ITEM_CHARS = 3_000_000;

const KINDS = new Set<WorkKind>(["dates", "parawise", "translation", "defects"]);

function encode<T>(item: WorkItem<T>): string {
  if (!KINDS.has(item.kind)) throw new Error(`unknown work kind ${item.kind}`);
  const json = JSON.stringify(item.data ?? null);
  if (json.length > MAX_WORK_ITEM_CHARS) throw new Error("This item is too large to store.");
  return json;
}

function decode<T>(r: Record<string, unknown>): WorkItem<T> {
  let data: unknown = null;
  try { data = typeof r.data === "string" ? JSON.parse(r.data) : r.data ?? null; } catch { data = null; }
  return { setId: String(r.set_id), kind: String(r.kind) as WorkKind, key: String(r.key), data: data as T, textHash: r.text_hash == null ? null : String(r.text_hash), createdBy: String(r.created_by ?? ""), updatedAt: String(r.updated_at) };
}

/** LIKE pattern for a literal prefix (escapes % and _ with backslash). */
const likePrefix = (p: string) => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---- SQLite ---------------------------------------------------------------------------------------------------------------

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS docs_work (
  set_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, text_hash TEXT, created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (set_id, kind, key)
);
CREATE INDEX IF NOT EXISTS docs_work_set ON docs_work(set_id, kind, updated_at DESC);
`;
const sqliteReady = new WeakSet<DatabaseSync>();

export class SqliteWorkStore implements WorkStore {
  private db(): DatabaseSync {
    const db = getSqlite();
    if (!sqliteReady.has(db)) { db.exec(SQLITE_SCHEMA); sqliteReady.add(db); }
    return db;
  }
  async get<T>(setId: string, kind: WorkKind, key: string) {
    const r = this.db().prepare(`SELECT * FROM docs_work WHERE set_id = ? AND kind = ? AND key = ?`).get(setId, kind, key) as Record<string, unknown> | undefined;
    return r ? decode<T>(r) : null;
  }
  async list<T>(setId: string, kind: WorkKind, opts: { prefix?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    const rows = opts.prefix
      ? this.db().prepare(`SELECT * FROM docs_work WHERE set_id = ? AND kind = ? AND key LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`).all(setId, kind, likePrefix(opts.prefix), limit)
      : this.db().prepare(`SELECT * FROM docs_work WHERE set_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT ?`).all(setId, kind, limit);
    return (rows as Record<string, unknown>[]).map((r) => decode<T>(r));
  }
  async put<T>(item: WorkItem<T>) {
    this.db().prepare(`INSERT INTO docs_work (set_id, kind, key, data, text_hash, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(set_id, kind, key) DO UPDATE SET data = excluded.data, text_hash = excluded.text_hash, updated_at = excluded.updated_at`)
      .run(item.setId, item.kind, item.key, encode(item), item.textHash, item.createdBy, item.updatedAt);
  }
  async delete(setId: string, kind: WorkKind, key: string) {
    this.db().prepare(`DELETE FROM docs_work WHERE set_id = ? AND kind = ? AND key = ?`).run(setId, kind, key);
  }
  async deleteSet(setId: string) {
    this.db().prepare(`DELETE FROM docs_work WHERE set_id = ?`).run(setId);
  }
  async deleteFile(setId: string, fileId: string) {
    this.db().prepare(`DELETE FROM docs_work WHERE set_id = ? AND (key = ? OR key LIKE ? ESCAPE '\\')`).run(setId, fileId, likePrefix(`${fileId}:`));
  }
}

// ---- Postgres -------------------------------------------------------------------------------------------------------------

export const DOCS_WORK_PG_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs_work (
    set_id text NOT NULL, kind text NOT NULL, key text NOT NULL, data text NOT NULL, text_hash text, created_by text NOT NULL,
    updated_at text NOT NULL, PRIMARY KEY (set_id, kind, key)
  )`,
  `CREATE INDEX IF NOT EXISTS docs_work_set ON docs_work (set_id, kind, updated_at DESC)`,
];

export class PgWorkStore implements WorkStore {
  private ready: Promise<void> | null = null;
  constructor(private readonly store: RemoteStore) {}
  private async q(query: string, params: (string | number | null)[] = []) {
    if (!this.ready) this.ready = (async () => { for (const s of DOCS_WORK_PG_SCHEMA) await this.store.query({ query: s }); })().catch((e) => { this.ready = null; throw e; });
    await this.ready;
    return this.store.query({ query, params });
  }
  async get<T>(setId: string, kind: WorkKind, key: string) {
    const rows = await this.q(`SELECT * FROM docs_work WHERE set_id = $1 AND kind = $2 AND key = $3`, [setId, kind, key]);
    return rows[0] ? decode<T>(rows[0]) : null;
  }
  async list<T>(setId: string, kind: WorkKind, opts: { prefix?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    const rows = opts.prefix
      ? await this.q(`SELECT * FROM docs_work WHERE set_id = $1 AND kind = $2 AND key LIKE $3 ESCAPE '\\' ORDER BY updated_at DESC LIMIT $4`, [setId, kind, likePrefix(opts.prefix), limit])
      : await this.q(`SELECT * FROM docs_work WHERE set_id = $1 AND kind = $2 ORDER BY updated_at DESC LIMIT $3`, [setId, kind, limit]);
    return rows.map((r) => decode<T>(r));
  }
  async put<T>(item: WorkItem<T>) {
    await this.q(`INSERT INTO docs_work (set_id, kind, key, data, text_hash, created_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (set_id, kind, key) DO UPDATE SET data = EXCLUDED.data, text_hash = EXCLUDED.text_hash, updated_at = EXCLUDED.updated_at`,
    [item.setId, item.kind, item.key, encode(item).replace(/\u0000/g, ""), item.textHash, item.createdBy, item.updatedAt]);
  }
  async delete(setId: string, kind: WorkKind, key: string) {
    await this.q(`DELETE FROM docs_work WHERE set_id = $1 AND kind = $2 AND key = $3`, [setId, kind, key]);
  }
  async deleteSet(setId: string) {
    await this.q(`DELETE FROM docs_work WHERE set_id = $1`, [setId]);
  }
  async deleteFile(setId: string, fileId: string) {
    await this.q(`DELETE FROM docs_work WHERE set_id = $1 AND (key = $2 OR key LIKE $3 ESCAPE '\\')`, [setId, fileId, likePrefix(`${fileId}:`)]);
  }
}

// ---- selection --------------------------------------------------------------------------------------------------------------

let forced: WorkStore | null = null;
let cached: { remote: unknown; store: WorkStore } | null = null;

/** Test seam: force an instance; null restores automatic selection. */
export function setWorkStoreForTests(s: WorkStore | null) { forced = s; cached = null; }

/** Same backend as the set's files: Postgres when the document store runs on Postgres, else the local SQLite file. */
export async function workStore(): Promise<WorkStore> {
  if (forced) return forced;
  const files = await docStore();
  const remote = files.backend === "postgres" ? remoteStore() : null;
  if (cached && cached.remote === remote) return cached.store;
  cached = { remote, store: remote ? new PgWorkStore(remote) : new SqliteWorkStore() };
  return cached.store;
}
