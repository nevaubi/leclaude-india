import "server-only";
import fs from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getSqlite } from "@/lib/db/sqlite";
import type { DocSet } from "../types";
import {
  chunkFromRow, DuplicateFileError, EXTRACTOR_VERSION, extractionFromRow, FILE_COLS, fileFromRow, fileToRow, MAX_EXTRACTION_ATTEMPTS, queryTerms,
  SET_COLS, setFromRow, setToRow, type ChunkRow, type DocStore, type ExtractionRow, type FileListFilter, type ScoredChunk, type SearchOptions,
  type SetListFilter, type StoredFile,
} from "./store";

/** Development / test backend: the local SQLite file, with an FTS5 index over chunk text (bm25 ranking). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs_sets (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, matter_id TEXT, name TEXT NOT NULL, description TEXT,
  file_count INTEGER NOT NULL DEFAULT 0, page_count INTEGER NOT NULL DEFAULT 0, extracted_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_sets_tenant ON docs_sets(tenant_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS docs_files (
  id TEXT PRIMARY KEY, set_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  hash_origin TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, pages INTEGER NOT NULL, pages_received INTEGER NOT NULL,
  ocr_pages TEXT NOT NULL DEFAULT '[]', ocr_done_pages TEXT NOT NULL DEFAULT '[]', chars INTEGER NOT NULL, doc_date TEXT, note TEXT,
  uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, extraction TEXT NOT NULL DEFAULT 'pending', extraction_version INTEGER,
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (set_id, sha256)
);
CREATE INDEX IF NOT EXISTS docs_files_set ON docs_files(set_id, uploaded_at);
CREATE TABLE IF NOT EXISTS docs_chunks (
  file_id TEXT NOT NULL, idx INTEGER NOT NULL, set_id TEXT NOT NULL, page INTEGER, text TEXT NOT NULL, lead INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (file_id, idx)
);
CREATE INDEX IF NOT EXISTS docs_chunks_set ON docs_chunks(set_id);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_chunks_fts USING fts5(text, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS docs_extractions (
  file_id TEXT PRIMARY KEY, set_id TEXT NOT NULL, text_hash TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  facts TEXT NOT NULL DEFAULT '[]', events TEXT NOT NULL DEFAULT '[]', error TEXT, windows_done INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_extractions_set ON docs_extractions(set_id);
`;

const ready = new WeakSet<DatabaseSync>();

type Rec = Record<string, unknown>;

const PENDING_WHERE = `set_id = ? AND status IN ('ready','partial') AND chars > 0 AND pages_received >= pages AND (
  extraction = 'pending' OR (extraction = 'done' AND (extraction_version IS NULL OR extraction_version <> ${EXTRACTOR_VERSION}))
  OR (extraction = 'failed' AND extraction_attempts < ${MAX_EXTRACTION_ATTEMPTS}))`;

const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** An FTS5 query string from words: each word quoted (so operators in user text are inert). */
function ftsQuery(words: string[], op: "AND" | "OR"): string {
  return words.map((w) => `"${w.replace(/"/g, "")}"`).join(op === "AND" ? " " : " OR ");
}

export class SqliteDocStore implements DocStore {
  readonly backend = "sqlite" as const;

  private db(): DatabaseSync {
    const db = getSqlite();
    if (!ready.has(db)) {
      db.exec(SCHEMA);
      ready.add(db);
    }
    return db;
  }

  private all(sql: string, params: SQLInputValue[] = []): Rec[] {
    return this.db().prepare(sql).all(...params) as Rec[];
  }

  private get(sql: string, params: SQLInputValue[] = []): Rec | undefined {
    return this.db().prepare(sql).get(...params) as Rec | undefined;
  }

  private run(sql: string, params: SQLInputValue[] = []) {
    return this.db().prepare(sql).run(...params);
  }

  private tx<T>(fn: () => T): T {
    const db = this.db();
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  }

  private insertChunks(chunks: ChunkRow[]) {
    const ins = this.db().prepare(`INSERT INTO docs_chunks (file_id, idx, set_id, page, text, lead) VALUES (?, ?, ?, ?, ?, ?)`);
    const fts = this.db().prepare(`INSERT INTO docs_chunks_fts (rowid, text) VALUES (?, ?)`);
    for (const c of chunks) {
      const r = ins.run(c.fileId, c.idx, c.setId, c.page, c.text, c.lead);
      fts.run(Number(r.lastInsertRowid), c.text);
    }
  }

  private deleteChunksWhere(where: string, params: SQLInputValue[]) {
    this.run(`DELETE FROM docs_chunks_fts WHERE rowid IN (SELECT rowid FROM docs_chunks WHERE ${where})`, params);
    this.run(`DELETE FROM docs_chunks WHERE ${where}`, params);
  }

  // ---- sets

  async insertSet(set: DocSet) {
    const row = setToRow(set);
    this.run(`INSERT INTO docs_sets (${SET_COLS.join(", ")}) VALUES (${ph(SET_COLS.length)})`, SET_COLS.map((c) => row[c]));
  }

  async getSet(id: string) {
    const r = this.get(`SELECT * FROM docs_sets WHERE id = ?`, [id]);
    return r ? setFromRow(r) : null;
  }

  async listSets(f: SetListFilter) {
    const params: SQLInputValue[] = [f.tenantId, f.ownerId];
    let matter = "";
    if (f.matterIds === "*") matter = " OR matter_id IS NOT NULL";
    else if (f.matterIds.length) { matter = ` OR matter_id IN (${ph(f.matterIds.length)})`; params.push(...f.matterIds); }
    return this.all(`SELECT * FROM docs_sets WHERE tenant_id = ? AND ((matter_id IS NULL AND owner_id = ?)${matter}) ORDER BY updated_at DESC LIMIT 500`, params).map(setFromRow);
  }

  async updateSet(id: string, patch: { name?: string; description?: string | null }) {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
    if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
    sets.push("updated_at = ?");
    params.push(new Date().toISOString(), id);
    this.run(`UPDATE docs_sets SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  async deleteSet(id: string) {
    this.tx(() => {
      this.deleteChunksWhere("set_id = ?", [id]);
      this.run(`DELETE FROM docs_extractions WHERE set_id = ?`, [id]);
      this.run(`DELETE FROM docs_files WHERE set_id = ?`, [id]);
      this.run(`DELETE FROM docs_sets WHERE id = ?`, [id]);
    });
  }

  async refreshSetCounts(id: string) {
    this.run(
      `UPDATE docs_sets SET
        file_count = (SELECT count(*) FROM docs_files WHERE set_id = ?),
        page_count = (SELECT coalesce(sum(pages), 0) FROM docs_files WHERE set_id = ?),
        extracted_count = (SELECT count(*) FROM docs_files WHERE set_id = ? AND extraction = 'done' AND extraction_version = ${EXTRACTOR_VERSION}),
        updated_at = ?
      WHERE id = ?`,
      [id, id, id, new Date().toISOString(), id],
    );
  }

  // ---- files

  async countFiles(setId: string) {
    return Number(this.get(`SELECT count(*) AS n FROM docs_files WHERE set_id = ?`, [setId])?.n ?? 0);
  }

  async findFileBySha(setId: string, sha256: string) {
    const r = this.get(`SELECT * FROM docs_files WHERE set_id = ? AND sha256 = ?`, [setId, sha256]);
    return r ? fileFromRow(r) : null;
  }

  async insertFile(file: StoredFile, chunks: ChunkRow[]) {
    const row = fileToRow(file);
    try {
      this.tx(() => {
        this.run(`INSERT INTO docs_files (${FILE_COLS.join(", ")}) VALUES (${ph(FILE_COLS.length)})`, FILE_COLS.map((c) => row[c]));
        this.insertChunks(chunks);
      });
    } catch (e) {
      if (/UNIQUE constraint failed: docs_files\.set_id, docs_files\.sha256/.test((e as Error).message)) throw new DuplicateFileError();
      throw e;
    }
  }

  async getFile(setId: string, fileId: string) {
    const r = this.get(`SELECT * FROM docs_files WHERE set_id = ? AND id = ?`, [setId, fileId]);
    return r ? fileFromRow(r) : null;
  }

  async getFiles(setId: string, fileIds: string[]) {
    if (!fileIds.length) return [];
    return this.all(`SELECT * FROM docs_files WHERE set_id = ? AND id IN (${ph(fileIds.length)})`, [setId, ...fileIds]).map(fileFromRow);
  }

  async listFiles(setId: string, f: FileListFilter) {
    const where = ["set_id = ?"];
    const params: SQLInputValue[] = [setId];
    if (f.status) { where.push("status = ?"); params.push(f.status); }
    if (f.q?.trim()) { where.push("lower(name) LIKE ? ESCAPE '\\'"); params.push(`%${f.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    const w = where.join(" AND ");
    const total = Number(this.get(`SELECT count(*) AS n FROM docs_files WHERE ${w}`, params)?.n ?? 0);
    const files = this.all(`SELECT * FROM docs_files WHERE ${w} ORDER BY uploaded_at DESC, name LIMIT ? OFFSET ?`, [...params, f.limit ?? 100, f.offset ?? 0]).map(fileFromRow);
    return { files, total };
  }

  async updateFile(file: StoredFile) {
    const row = fileToRow(file);
    const cols = FILE_COLS.filter((c) => c !== "id" && c !== "set_id");
    this.run(`UPDATE docs_files SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND set_id = ?`, [...cols.map((c) => row[c]), file.id, file.setId]);
  }

  async deleteFile(setId: string, fileId: string) {
    this.tx(() => {
      this.deleteChunksWhere("file_id = ? AND set_id = ?", [fileId, setId]);
      this.run(`DELETE FROM docs_extractions WHERE file_id = ? AND set_id = ?`, [fileId, setId]);
      this.run(`DELETE FROM docs_files WHERE id = ? AND set_id = ?`, [fileId, setId]);
    });
  }

  // ---- chunks

  async addChunks(chunks: ChunkRow[]) {
    if (chunks.length) this.tx(() => this.insertChunks(chunks));
  }

  async replacePageChunks(fileId: string, page: number, chunks: ChunkRow[]) {
    this.tx(() => {
      this.deleteChunksWhere("file_id = ? AND page = ?", [fileId, page]);
      this.insertChunks(chunks);
    });
  }

  async fileChunks(fileId: string, page?: number) {
    const rows = page == null
      ? this.all(`SELECT * FROM docs_chunks WHERE file_id = ? ORDER BY coalesce(page, 0), idx`, [fileId])
      : this.all(`SELECT * FROM docs_chunks WHERE file_id = ? AND page = ? ORDER BY idx`, [fileId, page]);
    return rows.map(chunkFromRow);
  }

  async maxChunkIdx(fileId: string) {
    const r = this.get(`SELECT max(idx) AS m FROM docs_chunks WHERE file_id = ?`, [fileId]);
    return r?.m == null ? -1 : Number(r.m);
  }

  async getChunk(fileId: string, idx: number) {
    const r = this.get(`SELECT * FROM docs_chunks WHERE file_id = ? AND idx = ?`, [fileId, idx]);
    return r ? chunkFromRow(r) : null;
  }

  private scope(setIds: string[], fileIds: string[] | undefined, alias = ""): { sql: string; params: SQLInputValue[] } {
    const a = alias ? `${alias}.` : "";
    let sql = `${a}set_id IN (${ph(setIds.length)})`;
    const params: SQLInputValue[] = [...setIds];
    if (fileIds?.length) { sql += ` AND ${a}file_id IN (${ph(fileIds.length)})`; params.push(...fileIds); }
    return { sql, params };
  }

  async countChunks(setIds: string[], fileIds?: string[]) {
    if (!setIds.length) return 0;
    const s = this.scope(setIds, fileIds);
    return Number(this.get(`SELECT count(*) AS n FROM docs_chunks WHERE ${s.sql}`, s.params)?.n ?? 0);
  }

  async allChunks(setIds: string[], fileIds: string[] | undefined, limit: number) {
    if (!setIds.length) return [];
    const s = this.scope(setIds, fileIds);
    return this.all(`SELECT * FROM docs_chunks WHERE ${s.sql} ORDER BY set_id, file_id, coalesce(page, 0), idx LIMIT ?`, [...s.params, limit]).map(chunkFromRow);
  }

  async search(setIds: string[], query: string, o: SearchOptions): Promise<ScoredChunk[]> {
    const words = queryTerms(query);
    if (!setIds.length || !words.length) return [];
    const out: ScoredChunk[] = [];
    const seen = new Set<string>();
    const s = this.scope(setIds, o.fileIds, "c");
    const run = (fts: string, max: number) => {
      const rows = this.all(
        `SELECT c.*, bm25(docs_chunks_fts) AS rank FROM docs_chunks_fts JOIN docs_chunks c ON c.rowid = docs_chunks_fts.rowid
         WHERE docs_chunks_fts MATCH ? AND ${s.sql} ORDER BY rank LIMIT ?`,
        [fts, ...s.params, max],
      );
      for (const r of rows) {
        const key = `${r.file_id}#${r.idx}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...chunkFromRow(r), score: -Number(r.rank) });
        if (out.length >= o.limit) break;
      }
    };
    run(ftsQuery(words, "AND"), o.limit);
    if (out.length < o.limit && words.length > 1) run(ftsQuery(words, "OR"), o.limit * 2);
    return out;
  }

  // ---- extraction

  async pendingExtraction(setId: string, limit: number) {
    return this.all(`SELECT * FROM docs_files WHERE ${PENDING_WHERE} ORDER BY uploaded_at, id LIMIT ?`, [setId, limit]).map(fileFromRow);
  }

  async countPendingExtraction(setId: string) {
    return Number(this.get(`SELECT count(*) AS n FROM docs_files WHERE ${PENDING_WHERE}`, [setId])?.n ?? 0);
  }

  async getExtraction(fileId: string) {
    const r = this.get(`SELECT * FROM docs_extractions WHERE file_id = ?`, [fileId]);
    return r ? extractionFromRow(r) : null;
  }

  async putExtraction(x: ExtractionRow) {
    this.run(
      `INSERT INTO docs_extractions (file_id, set_id, text_hash, version, status, facts, events, error, windows_done, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (file_id) DO UPDATE SET set_id = excluded.set_id, text_hash = excluded.text_hash, version = excluded.version, status = excluded.status,
         facts = excluded.facts, events = excluded.events, error = excluded.error, windows_done = excluded.windows_done, updated_at = excluded.updated_at`,
      [x.fileId, x.setId, x.textHash, x.version, x.status, JSON.stringify(x.facts), JSON.stringify(x.events), x.error, x.windowsDone, x.updatedAt],
    );
  }

  async deleteExtraction(fileId: string) {
    this.run(`DELETE FROM docs_extractions WHERE file_id = ?`, [fileId]);
  }

  async listExtractions(setId: string, fileId?: string) {
    const rows = fileId
      ? this.all(`SELECT * FROM docs_extractions WHERE set_id = ? AND file_id = ? AND status = 'done' AND version = ${EXTRACTOR_VERSION} AND file_id IN (SELECT id FROM docs_files WHERE set_id = ?)`, [setId, fileId, setId])
      : this.all(`SELECT * FROM docs_extractions WHERE set_id = ? AND status = 'done' AND version = ${EXTRACTOR_VERSION} AND file_id IN (SELECT id FROM docs_files WHERE set_id = ?)`, [setId, setId]);
    return rows.map(extractionFromRow);
  }

  async storage() {
    try {
      const file = (this.db() as unknown as { location?: () => string | null }).location?.();
      if (file && fs.existsSync(file)) return { usedMb: Math.round((fs.statSync(file).size / 1024 / 1024) * 10) / 10 };
    } catch { /* unknown */ }
    return { usedMb: null };
  }
}
