import "server-only";
import { remoteStore } from "@/lib/db/remote";
import type { DocEvent, DocFact, DocFile, DocFileStatus, DocSet } from "../types";

/**
 * Storage for document sets: dedicated tables queried in place (never the mirror collections). Postgres (Neon, via
 * `remoteStore()`) in production, the local SQLite file in development and tests. Both implement `DocStore`.
 */

/** Bumped whenever the facts/events prompt or schema changes; files extracted with an older version are re-run. */
export const EXTRACTOR_VERSION = 1;

/** Failed extractions are retried this many times in total before they stop counting as remaining. */
export const MAX_EXTRACTION_ATTEMPTS = 2;

export interface ChunkRow {
  fileId: string;
  setId: string;
  idx: number;
  page: number | null;
  /** Chunk text, including `lead` characters of overlap with the previous chunk of the same page. */
  text: string;
  lead: number;
}

export interface ScoredChunk extends ChunkRow { score: number }

/** A file row with the bookkeeping the API does not expose. */
export interface StoredFile extends DocFile {
  extractionVersion: number | null;
  extractionAttempts: number;
}

export interface ExtractionRow {
  fileId: string;
  setId: string;
  textHash: string;
  version: number;
  /** partial: the deadline stopped a long file part way; `windowsDone` windows (in order) are already in facts/events. */
  status: "done" | "failed" | "partial";
  windowsDone: number;
  facts: DocFact[];
  events: DocEvent[];
  error: string | null;
  updatedAt: string;
}

export interface SetListFilter {
  tenantId: string;
  ownerId: string;
  /** Matters the caller may read ("*" = every matter in the tenant). */
  matterIds: string[] | "*";
}

export interface FileListFilter {
  offset?: number;
  limit?: number;
  status?: DocFileStatus;
  q?: string;
}

export interface SearchOptions {
  limit: number;
  fileIds?: string[];
}

export interface DocStore {
  readonly backend: "postgres" | "sqlite";
  // sets
  insertSet(set: DocSet): Promise<void>;
  getSet(id: string): Promise<DocSet | null>;
  /** Sets in the tenant owned by the caller or attached to a readable matter; the caller still checks each one. */
  listSets(f: SetListFilter): Promise<DocSet[]>;
  updateSet(id: string, patch: { name?: string; description?: string | null }): Promise<void>;
  deleteSet(id: string): Promise<void>;
  /** Recompute file/page/extracted counts and touch updated_at. */
  refreshSetCounts(id: string): Promise<void>;
  // files
  countFiles(setId: string): Promise<number>;
  findFileBySha(setId: string, sha256: string): Promise<StoredFile | null>;
  /** Insert a file with its chunks atomically. Throws `DuplicateFileError` when (set, sha256) already exists. */
  insertFile(file: StoredFile, chunks: ChunkRow[]): Promise<void>;
  getFile(setId: string, fileId: string): Promise<StoredFile | null>;
  getFiles(setId: string, fileIds: string[]): Promise<StoredFile[]>;
  listFiles(setId: string, f: FileListFilter): Promise<{ files: StoredFile[]; total: number }>;
  updateFile(file: StoredFile): Promise<void>;
  deleteFile(setId: string, fileId: string): Promise<void>;
  // chunks
  addChunks(chunks: ChunkRow[]): Promise<void>;
  /** Replace every chunk of one page of a file (OCR). */
  replacePageChunks(fileId: string, page: number, chunks: ChunkRow[]): Promise<void>;
  /** Chunks of a file (optionally one page), ordered by page then idx. */
  fileChunks(fileId: string, page?: number): Promise<ChunkRow[]>;
  maxChunkIdx(fileId: string): Promise<number>;
  getChunk(fileId: string, idx: number): Promise<ChunkRow | null>;
  countChunks(setIds: string[], fileIds?: string[]): Promise<number>;
  /** Every chunk of the sets, in set/file/page/idx order (small sets only). */
  allChunks(setIds: string[], fileIds: string[] | undefined, limit: number): Promise<ChunkRow[]>;
  /** Ranked full-text search: every word first, then any word to fill the limit. */
  search(setIds: string[], query: string, o: SearchOptions): Promise<ScoredChunk[]>;
  // extraction
  pendingExtraction(setId: string, limit: number): Promise<StoredFile[]>;
  countPendingExtraction(setId: string): Promise<number>;
  getExtraction(fileId: string): Promise<ExtractionRow | null>;
  putExtraction(row: ExtractionRow): Promise<void>;
  deleteExtraction(fileId: string): Promise<void>;
  listExtractions(setId: string, fileId?: string): Promise<ExtractionRow[]>;
  // storage
  storage(): Promise<{ usedMb: number | null }>;
}

export class DuplicateFileError extends Error {
  constructor() { super("A file with the same SHA-256 is already in this set"); this.name = "DuplicateFileError"; }
}

// ---- shared row mapping -----------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const num = (v: unknown, d = 0) => { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? d : n; };
const strOrNull = (v: unknown) => (v == null ? null : String(v));
function jsonArr<T>(v: unknown): T[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v as T[];
  try { const p = JSON.parse(String(v)); return Array.isArray(p) ? (p as T[]) : []; } catch { return []; }
}

export const SET_COLS = ["id", "tenant_id", "owner_id", "matter_id", "name", "description", "file_count", "page_count", "extracted_count", "created_at", "updated_at"] as const;

export function setFromRow(r: Raw): DocSet {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), ownerId: String(r.owner_id), matterId: strOrNull(r.matter_id),
    name: String(r.name), description: strOrNull(r.description), fileCount: num(r.file_count), pageCount: num(r.page_count),
    extractedCount: num(r.extracted_count), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function setToRow(s: DocSet): Record<(typeof SET_COLS)[number], string | number | null> {
  return {
    id: s.id, tenant_id: s.tenantId, owner_id: s.ownerId, matter_id: s.matterId ?? null, name: s.name, description: s.description ?? null,
    file_count: s.fileCount, page_count: s.pageCount, extracted_count: s.extractedCount, created_at: s.createdAt, updated_at: s.updatedAt,
  };
}

export const FILE_COLS = [
  "id", "set_id", "name", "mime", "size", "sha256", "hash_origin", "method", "status", "pages", "pages_received", "ocr_pages", "ocr_done_pages",
  "chars", "doc_date", "note", "uploaded_by", "uploaded_at", "extraction", "extraction_version", "extraction_attempts",
] as const;

export function fileFromRow(r: Raw): StoredFile {
  const pages = num(r.pages);
  const f: StoredFile = {
    id: String(r.id), setId: String(r.set_id), name: String(r.name), mime: String(r.mime), size: num(r.size), sha256: String(r.sha256),
    hashOrigin: r.hash_origin === "browser" ? "browser" : "server", method: String(r.method) as DocFile["method"], status: String(r.status) as DocFileStatus,
    pages, ocrPages: jsonArr<number>(r.ocr_pages), ocrDonePages: jsonArr<number>(r.ocr_done_pages), pagesReceived: num(r.pages_received, pages),
    chars: num(r.chars), docDate: strOrNull(r.doc_date), note: strOrNull(r.note), uploadedBy: String(r.uploaded_by), uploadedAt: String(r.uploaded_at),
    extraction: (["pending", "done", "failed"].includes(String(r.extraction)) ? String(r.extraction) : "pending") as DocFile["extraction"],
    extractionVersion: r.extraction_version == null ? null : num(r.extraction_version), extractionAttempts: num(r.extraction_attempts),
  };
  return f;
}

export function fileToRow(f: StoredFile): Record<(typeof FILE_COLS)[number], string | number | null> {
  return {
    id: f.id, set_id: f.setId, name: f.name, mime: f.mime, size: f.size, sha256: f.sha256, hash_origin: f.hashOrigin, method: f.method, status: f.status,
    pages: f.pages, pages_received: f.pagesReceived ?? f.pages, ocr_pages: JSON.stringify(f.ocrPages ?? []), ocr_done_pages: JSON.stringify(f.ocrDonePages ?? []),
    chars: f.chars, doc_date: f.docDate ?? null, note: f.note ?? null, uploaded_by: f.uploadedBy, uploaded_at: f.uploadedAt, extraction: f.extraction,
    extraction_version: f.extractionVersion, extraction_attempts: f.extractionAttempts,
  };
}

/** The public shape (bookkeeping fields removed). */
export function publicFile(f: StoredFile): DocFile {
  const { extractionVersion, extractionAttempts, ...rest } = f;
  void extractionAttempts;
  // A file extracted with an older extractor is pending again.
  return rest.extraction === "done" && extractionVersion !== EXTRACTOR_VERSION ? { ...rest, extraction: "pending" } : rest;
}

export function chunkFromRow(r: Raw): ChunkRow {
  return { fileId: String(r.file_id), setId: String(r.set_id), idx: num(r.idx), page: r.page == null ? null : num(r.page), text: String(r.text ?? ""), lead: num(r.lead) };
}

export function extractionFromRow(r: Raw): ExtractionRow {
  return {
    fileId: String(r.file_id), setId: String(r.set_id), textHash: String(r.text_hash), version: num(r.version), status: r.status === "failed" ? "failed" : r.status === "partial" ? "partial" : "done", windowsDone: num(r.windows_done),
    facts: jsonArr<DocFact>(r.facts), events: jsonArr<DocEvent>(r.events), error: strOrNull(r.error), updatedAt: String(r.updated_at),
  };
}

// ---- query terms ------------------------------------------------------------------------------------------------

const STOP = new Set("a an and are as at be but by for from has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was were what when where which who whom why will with would you your do does did not no can could should shall may might must about any all also how".split(" "));

/** Distinct content words of a query (letters/digits), at most 16. */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const m of (q ?? "").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 16) break;
  }
  return out;
}

// ---- backend selection ------------------------------------------------------------------------------------------

let forced: DocStore | "sqlite" | "postgres" | null = null;
let cachedPg: { remote: unknown; store: DocStore } | null = null;
let cachedSqlite: DocStore | null = null;

/** Test seam: force a backend (or an instance); `null` restores automatic selection. */
export function setDocStoreForTests(v: DocStore | "sqlite" | "postgres" | null) {
  forced = v;
  cachedPg = null;
  cachedSqlite = null;
}

export async function docStore(): Promise<DocStore> {
  if (forced && typeof forced === "object") return forced;
  const remote = forced === "sqlite" ? null : remoteStore();
  if (remote) {
    if (cachedPg?.remote !== remote) {
      const { PgDocStore } = await import("./store-pg");
      cachedPg = { remote, store: new PgDocStore(remote) };
    }
    return cachedPg.store;
  }
  if (forced === "postgres") throw new Error("documents: Postgres backend forced but no remote store is configured");
  if (!cachedSqlite) {
    const { SqliteDocStore } = await import("./store-sqlite");
    cachedSqlite = new SqliteDocStore();
  }
  return cachedSqlite;
}
