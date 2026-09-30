import "server-only";
import type { RemoteStore, SqlQuery, SqlValue } from "@/lib/db/remote";
import type { DocSet } from "../types";
import {
  chunkFromRow, DuplicateFileError, EXTRACTOR_VERSION, extractionFromRow, FILE_COLS, fileFromRow, fileToRow, MAX_EXTRACTION_ATTEMPTS, queryTerms,
  SET_COLS, setFromRow, setToRow, type ChunkRow, type DocStore, type ExtractionRow, type FileListFilter, type ScoredChunk, type SearchOptions,
  type SetListFilter, type StoredFile,
} from "./store";

/**
 * Production backend: Postgres (Neon HTTP) queried in place. Chunk text carries a generated english tsvector with a
 * GIN index; search is websearch_to_tsquery over every query word, then an OR-of-words fallback (as the corpus does).
 * Bulk inserts go through jsonb_to_recordset so one statement carries many rows.
 */
export const DOCS_PG_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS docs_sets (
      id text PRIMARY KEY, tenant_id text NOT NULL, owner_id text NOT NULL, matter_id text, name text NOT NULL, description text,
      file_count int NOT NULL DEFAULT 0, page_count int NOT NULL DEFAULT 0, extracted_count int NOT NULL DEFAULT 0,
      created_at text NOT NULL, updated_at text NOT NULL
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS docs_sets_tenant ON docs_sets (tenant_id, updated_at DESC)` },
  {
    query: `CREATE TABLE IF NOT EXISTS docs_files (
      id text PRIMARY KEY, set_id text NOT NULL, name text NOT NULL, mime text NOT NULL, size bigint NOT NULL, sha256 text NOT NULL,
      hash_origin text NOT NULL, method text NOT NULL, status text NOT NULL, pages int NOT NULL, pages_received int NOT NULL,
      ocr_pages text NOT NULL DEFAULT '[]', ocr_done_pages text NOT NULL DEFAULT '[]', chars int NOT NULL, doc_date text, note text,
      uploaded_by text NOT NULL, uploaded_at text NOT NULL, extraction text NOT NULL DEFAULT 'pending', extraction_version int,
      extraction_attempts int NOT NULL DEFAULT 0,
      UNIQUE (set_id, sha256)
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS docs_files_set ON docs_files (set_id, uploaded_at)` },
  {
    query: `CREATE TABLE IF NOT EXISTS docs_chunks (
      file_id text NOT NULL, idx int NOT NULL, set_id text NOT NULL, page int, text text NOT NULL, lead int NOT NULL DEFAULT 0,
      search tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
      PRIMARY KEY (file_id, idx)
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS docs_chunks_search ON docs_chunks USING gin (search)` },
  { query: `CREATE INDEX IF NOT EXISTS docs_chunks_set ON docs_chunks (set_id)` },
  {
    query: `CREATE TABLE IF NOT EXISTS docs_extractions (
      file_id text PRIMARY KEY, set_id text NOT NULL, text_hash text NOT NULL, version int NOT NULL, status text NOT NULL,
      facts text NOT NULL DEFAULT '[]', events text NOT NULL DEFAULT '[]', error text, windows_done int NOT NULL DEFAULT 0, updated_at text NOT NULL
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS docs_extractions_set ON docs_extractions (set_id)` },
];

const PENDING_WHERE = `set_id = $1 AND status IN ('ready','partial') AND chars > 0 AND pages_received >= pages AND (
  extraction = 'pending' OR (extraction = 'done' AND (extraction_version IS NULL OR extraction_version <> ${EXTRACTOR_VERSION}))
  OR (extraction = 'failed' AND extraction_attempts < ${MAX_EXTRACTION_ATTEMPTS}))`;

const FILE_DEFS = `id text, set_id text, name text, mime text, size bigint, sha256 text, hash_origin text, method text, status text, pages int,
  pages_received int, ocr_pages text, ocr_done_pages text, chars int, doc_date text, note text, uploaded_by text, uploaded_at text, extraction text,
  extraction_version int, extraction_attempts int`;

/** Rows per bulk chunk insert, bounded by characters so one request stays well under the HTTP body limit. */
function batches(chunks: ChunkRow[], maxChars = 1_500_000, maxRows = 1000): ChunkRow[][] {
  const out: ChunkRow[][] = [];
  let cur: ChunkRow[] = [];
  let chars = 0;
  for (const c of chunks) {
    if (cur.length && (chars + c.text.length > maxChars || cur.length >= maxRows)) { out.push(cur); cur = []; chars = 0; }
    cur.push(c);
    chars += c.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

function chunkInserts(chunks: ChunkRow[]): SqlQuery[] {
  return batches(chunks).map((b) => ({
    query: `INSERT INTO docs_chunks (file_id, idx, set_id, page, text, lead)
      SELECT file_id, idx, set_id, page, text, lead FROM jsonb_to_recordset($1::jsonb) AS x(file_id text, idx int, set_id text, page int, text text, lead int)`,
    params: [JSON.stringify(b.map((c) => ({ file_id: c.fileId, idx: c.idx, set_id: c.setId, page: c.page, text: c.text.replace(/\u0000/g, ""), lead: c.lead })))],
  }));
}

const isUniqueViolation = (e: unknown) => /duplicate key value violates unique constraint|docs_files_set_id_sha256_key/i.test((e as Error)?.message ?? "");

export class PgDocStore implements DocStore {
  readonly backend = "postgres" as const;
  private schema: Promise<void> | null = null;

  constructor(private readonly store: RemoteStore) {}

  private ensure(): Promise<void> {
    if (!this.schema) {
      this.schema = (async () => { for (const q of DOCS_PG_SCHEMA) await this.store.query(q); })().catch((e) => { this.schema = null; throw e; });
    }
    return this.schema;
  }

  private async q(query: string, params: SqlValue[] = []) {
    await this.ensure();
    return this.store.query({ query, params });
  }

  private async tx(qs: SqlQuery[]) {
    await this.ensure();
    return this.store.transaction(qs);
  }

  /** `col IN (…)` over a JSON array parameter (no string building of ids). */
  private static inList(col: string, n: number) {
    return `${col} IN (SELECT jsonb_array_elements_text($${n}::jsonb))`;
  }

  // ---- sets

  async insertSet(set: DocSet) {
    const row = setToRow(set);
    await this.q(`INSERT INTO docs_sets (${SET_COLS.join(", ")}) VALUES (${SET_COLS.map((_, i) => `$${i + 1}`).join(", ")})`, SET_COLS.map((c) => row[c]));
  }

  async getSet(id: string) {
    const rows = await this.q(`SELECT * FROM docs_sets WHERE id = $1`, [id]);
    return rows[0] ? setFromRow(rows[0]) : null;
  }

  async listSets(f: SetListFilter) {
    const params: SqlValue[] = [f.tenantId, f.ownerId];
    let matter = "";
    if (f.matterIds === "*") matter = " OR matter_id IS NOT NULL";
    else if (f.matterIds.length) { params.push(JSON.stringify(f.matterIds)); matter = ` OR ${PgDocStore.inList("matter_id", 3)}`; }
    const rows = await this.q(`SELECT * FROM docs_sets WHERE tenant_id = $1 AND ((matter_id IS NULL AND owner_id = $2)${matter}) ORDER BY updated_at DESC LIMIT 500`, params);
    return rows.map(setFromRow);
  }

  async updateSet(id: string, patch: { name?: string; description?: string | null }) {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.name !== undefined) { params.push(patch.name); sets.push(`name = $${params.length}`); }
    if (patch.description !== undefined) { params.push(patch.description); sets.push(`description = $${params.length}`); }
    params.push(new Date().toISOString());
    sets.push(`updated_at = $${params.length}`);
    params.push(id);
    await this.q(`UPDATE docs_sets SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  }

  async deleteSet(id: string) {
    await this.tx([
      { query: `DELETE FROM docs_chunks WHERE set_id = $1`, params: [id] },
      { query: `DELETE FROM docs_extractions WHERE set_id = $1`, params: [id] },
      { query: `DELETE FROM docs_files WHERE set_id = $1`, params: [id] },
      { query: `DELETE FROM docs_sets WHERE id = $1`, params: [id] },
    ]);
  }

  async refreshSetCounts(id: string) {
    await this.q(
      `UPDATE docs_sets s SET file_count = c.n, page_count = c.p, extracted_count = c.x, updated_at = $2
       FROM (SELECT count(*)::int AS n, coalesce(sum(pages), 0)::int AS p,
                    count(*) FILTER (WHERE extraction = 'done' AND extraction_version = ${EXTRACTOR_VERSION})::int AS x
             FROM docs_files WHERE set_id = $1) c
       WHERE s.id = $1`,
      [id, new Date().toISOString()],
    );
  }

  // ---- files

  async countFiles(setId: string) {
    const rows = await this.q(`SELECT count(*)::int AS n FROM docs_files WHERE set_id = $1`, [setId]);
    return Number(rows[0]?.n ?? 0);
  }

  async findFileBySha(setId: string, sha256: string) {
    const rows = await this.q(`SELECT * FROM docs_files WHERE set_id = $1 AND sha256 = $2`, [setId, sha256]);
    return rows[0] ? fileFromRow(rows[0]) : null;
  }

  async insertFile(file: StoredFile, chunks: ChunkRow[]) {
    const row = fileToRow(file);
    try {
      await this.tx([
        { query: `INSERT INTO docs_files (${FILE_COLS.join(", ")}) SELECT ${FILE_COLS.join(", ")} FROM jsonb_to_recordset($1::jsonb) AS x(${FILE_DEFS})`, params: [JSON.stringify([row])] },
        ...chunkInserts(chunks),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateFileError();
      throw e;
    }
  }

  async getFile(setId: string, fileId: string) {
    const rows = await this.q(`SELECT * FROM docs_files WHERE set_id = $1 AND id = $2`, [setId, fileId]);
    return rows[0] ? fileFromRow(rows[0]) : null;
  }

  async getFiles(setId: string, fileIds: string[]) {
    if (!fileIds.length) return [];
    const rows = await this.q(`SELECT * FROM docs_files WHERE set_id = $1 AND ${PgDocStore.inList("id", 2)}`, [setId, JSON.stringify(fileIds)]);
    return rows.map(fileFromRow);
  }

  async listFiles(setId: string, f: FileListFilter) {
    const where = ["set_id = $1"];
    const params: SqlValue[] = [setId];
    if (f.status) { params.push(f.status); where.push(`status = $${params.length}`); }
    if (f.q?.trim()) { params.push(`%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`name ILIKE $${params.length}`); }
    const w = where.join(" AND ");
    const [count, rows] = await Promise.all([
      this.q(`SELECT count(*)::int AS n FROM docs_files WHERE ${w}`, params),
      this.q(`SELECT * FROM docs_files WHERE ${w} ORDER BY uploaded_at DESC, name LIMIT ${Math.max(1, Math.min(f.limit ?? 100, 1000))} OFFSET ${Math.max(0, f.offset ?? 0)}`, params),
    ]);
    return { files: rows.map(fileFromRow), total: Number(count[0]?.n ?? 0) };
  }

  async updateFile(file: StoredFile) {
    const row = fileToRow(file);
    const cols = FILE_COLS.filter((c) => c !== "id" && c !== "set_id");
    await this.q(
      `UPDATE docs_files f SET ${cols.map((c) => `${c} = x.${c}`).join(", ")} FROM jsonb_to_recordset($1::jsonb) AS x(${FILE_DEFS}) WHERE f.id = x.id AND f.set_id = x.set_id`,
      [JSON.stringify([row])],
    );
  }

  async deleteFile(setId: string, fileId: string) {
    await this.tx([
      { query: `DELETE FROM docs_chunks WHERE file_id = $1 AND set_id = $2`, params: [fileId, setId] },
      { query: `DELETE FROM docs_extractions WHERE file_id = $1 AND set_id = $2`, params: [fileId, setId] },
      { query: `DELETE FROM docs_files WHERE id = $1 AND set_id = $2`, params: [fileId, setId] },
    ]);
  }

  // ---- chunks

  async addChunks(chunks: ChunkRow[]) {
    if (chunks.length) await this.tx(chunkInserts(chunks));
  }

  async replacePageChunks(fileId: string, page: number, chunks: ChunkRow[]) {
    await this.tx([{ query: `DELETE FROM docs_chunks WHERE file_id = $1 AND page = $2`, params: [fileId, page] }, ...chunkInserts(chunks)]);
  }

  async fileChunks(fileId: string, page?: number) {
    const rows = page == null
      ? await this.q(`SELECT file_id, idx, set_id, page, text, lead FROM docs_chunks WHERE file_id = $1 ORDER BY coalesce(page, 0), idx`, [fileId])
      : await this.q(`SELECT file_id, idx, set_id, page, text, lead FROM docs_chunks WHERE file_id = $1 AND page = $2 ORDER BY idx`, [fileId, page]);
    return rows.map(chunkFromRow);
  }

  async maxChunkIdx(fileId: string) {
    const rows = await this.q(`SELECT max(idx) AS m FROM docs_chunks WHERE file_id = $1`, [fileId]);
    return rows[0]?.m == null ? -1 : Number(rows[0].m);
  }

  async getChunk(fileId: string, idx: number) {
    const rows = await this.q(`SELECT file_id, idx, set_id, page, text, lead FROM docs_chunks WHERE file_id = $1 AND idx = $2`, [fileId, idx]);
    return rows[0] ? chunkFromRow(rows[0]) : null;
  }

  private scope(setIds: string[], fileIds: string[] | undefined, params: SqlValue[]): string {
    params.push(JSON.stringify(setIds));
    let sql = PgDocStore.inList("set_id", params.length);
    if (fileIds?.length) { params.push(JSON.stringify(fileIds)); sql += ` AND ${PgDocStore.inList("file_id", params.length)}`; }
    return sql;
  }

  async countChunks(setIds: string[], fileIds?: string[]) {
    if (!setIds.length) return 0;
    const params: SqlValue[] = [];
    const s = this.scope(setIds, fileIds, params);
    const rows = await this.q(`SELECT count(*)::int AS n FROM docs_chunks WHERE ${s}`, params);
    return Number(rows[0]?.n ?? 0);
  }

  async allChunks(setIds: string[], fileIds: string[] | undefined, limit: number) {
    if (!setIds.length) return [];
    const params: SqlValue[] = [];
    const s = this.scope(setIds, fileIds, params);
    const rows = await this.q(`SELECT file_id, idx, set_id, page, text, lead FROM docs_chunks WHERE ${s} ORDER BY set_id, file_id, coalesce(page, 0), idx LIMIT ${Math.max(1, Math.floor(limit))}`, params);
    return rows.map(chunkFromRow);
  }

  async search(setIds: string[], query: string, o: SearchOptions): Promise<ScoredChunk[]> {
    const words = queryTerms(query);
    if (!setIds.length || !words.length) return [];
    const out: ScoredChunk[] = [];
    const seen = new Set<string>();
    const run = async (tsq: string, max: number) => {
      const params: SqlValue[] = [tsq];
      const s = this.scope(setIds, o.fileIds, params);
      const rows = await this.q(
        `SELECT file_id, idx, set_id, page, text, lead, ts_rank_cd(search, websearch_to_tsquery('english', $1)) AS rank
         FROM docs_chunks WHERE search @@ websearch_to_tsquery('english', $1) AND ${s}
         ORDER BY rank DESC, file_id, idx LIMIT ${Math.max(1, Math.floor(max))}`,
        params,
      );
      for (const r of rows) {
        const key = `${r.file_id}#${r.idx}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...chunkFromRow(r), score: Number(r.rank ?? 0) });
        if (out.length >= o.limit) break;
      }
    };
    await run(words.join(" "), o.limit);
    if (out.length < o.limit && words.length > 1) await run(words.join(" or "), o.limit * 2);
    return out;
  }

  // ---- extraction

  async pendingExtraction(setId: string, limit: number) {
    const rows = await this.q(`SELECT * FROM docs_files WHERE ${PENDING_WHERE} ORDER BY uploaded_at, id LIMIT ${Math.max(1, Math.floor(limit))}`, [setId]);
    return rows.map(fileFromRow);
  }

  async countPendingExtraction(setId: string) {
    const rows = await this.q(`SELECT count(*)::int AS n FROM docs_files WHERE ${PENDING_WHERE}`, [setId]);
    return Number(rows[0]?.n ?? 0);
  }

  async getExtraction(fileId: string) {
    const rows = await this.q(`SELECT * FROM docs_extractions WHERE file_id = $1`, [fileId]);
    return rows[0] ? extractionFromRow(rows[0]) : null;
  }

  async putExtraction(x: ExtractionRow) {
    await this.q(
      `INSERT INTO docs_extractions (file_id, set_id, text_hash, version, status, facts, events, error, windows_done, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (file_id) DO UPDATE SET set_id = EXCLUDED.set_id, text_hash = EXCLUDED.text_hash, version = EXCLUDED.version, status = EXCLUDED.status,
         facts = EXCLUDED.facts, events = EXCLUDED.events, error = EXCLUDED.error, windows_done = EXCLUDED.windows_done, updated_at = EXCLUDED.updated_at`,
      [x.fileId, x.setId, x.textHash, x.version, x.status, JSON.stringify(x.facts), JSON.stringify(x.events), x.error, x.windowsDone, x.updatedAt],
    );
  }

  async deleteExtraction(fileId: string) {
    await this.q(`DELETE FROM docs_extractions WHERE file_id = $1`, [fileId]);
  }

  async listExtractions(setId: string, fileId?: string) {
    const rows = fileId
      ? await this.q(`SELECT * FROM docs_extractions WHERE set_id = $1 AND file_id = $2 AND status = 'done' AND version = ${EXTRACTOR_VERSION} AND file_id IN (SELECT id FROM docs_files WHERE set_id = $1)`, [setId, fileId])
      : await this.q(`SELECT * FROM docs_extractions WHERE set_id = $1 AND status = 'done' AND version = ${EXTRACTOR_VERSION} AND file_id IN (SELECT id FROM docs_files WHERE set_id = $1)`, [setId]);
    return rows.map(extractionFromRow);
  }

  async storage() {
    const rows = await this.store.query({ query: `SELECT pg_database_size(current_database())::bigint AS b` });
    const b = Number(rows[0]?.b);
    return { usedMb: Number.isFinite(b) ? Math.round((b / 1024 / 1024) * 10) / 10 : null };
  }
}
