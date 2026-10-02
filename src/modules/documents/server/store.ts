import "server-only";
import { remoteStore } from "@/lib/db/remote";
import { RELEVANCE_RANK, type CodingDecision, type DocReview, type IssueAssessment, type PrivilegeScreen, type ReviewCell, type ReviewCounts, type ReviewFacets, type ReviewReport, type RowQuery } from "../review-types";
import type { DocEvent, DocFact, DocFile, DocFileStatus, DocSet } from "../types";
import { normalizeForMatch } from "./text";

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

/** Bumped whenever the reviewer prompt, schema or checks change; rows produced by an older reviewer are pending again. */
export const REVIEWER_VERSION = 2;

/**
 * Cheap fingerprint of a file's text state; it changes when pages are appended or OCR'd. Must equal `fileStampSql`
 * (review-sql.ts) character for character: the row query decides "current" in SQL with the same formula.
 */
export function fileStamp(f: Pick<DocFile, "chars" | "pagesReceived" | "pages" | "status" | "ocrDonePages">): string {
  return `r${REVIEWER_VERSION}|${f.chars}|${f.pagesReceived ?? f.pages}|${f.pages}|${f.status}|${JSON.stringify(f.ocrDonePages ?? [])}`;
}

/** A review's definition as stored (counts are computed, never stored). */
export type StoredReview = Omit<DocReview, "counts">;

/** The checked result of reviewing one file (or one window of it). */
export interface ReviewResult {
  docType: string | null;
  summary: string;
  importance: number | null;
  issues: IssueAssessment[];
  privilege: PrivilegeScreen | null;
  cells: Record<string, ReviewCell>;
  coverage: ReviewCoverage;
}

/** Characters read vs total (unread scanned pages counted into total) and the pages that had no text to read. */
export interface ReviewCoverage { read: number; total: number; unreadPages: number[] }

/** True when part of the file was not read (length cap or pages awaiting OCR). */
export function coveragePartial(c: Partial<ReviewCoverage> | null | undefined): boolean {
  return !!c && ((c.read ?? 0) < (c.total ?? 0) || (c.unreadPages?.length ?? 0) > 0);
}

/**
 * One file's review row. `state` progress = some windows done (resumable, shown as pending); `pending` = a placeholder
 * holding only a coding decision. The run never writes `decision`; coding never writes the model columns.
 */
export interface ReviewRowRecord {
  reviewId: string;
  setId: string;
  fileId: string;
  state: "pending" | "progress" | "done" | "failed";
  /** Review version the row was produced under (null for a placeholder). */
  reviewVersion: number | null;
  textHash: string | null;
  /** Cheap file fingerprint (chars, pages received, OCR pages): a different stamp means the text changed. */
  fileStamp: string | null;
  windowsDone: number;
  result: ReviewResult | null;
  /** Per-window results kept while a long file is part way through (state progress). */
  partials: ReviewResult[];
  rowHash: string | null;
  decision: CodingDecision | null;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

/** A row record without its model output (what run bookkeeping and listings need). */
export type ReviewRowMeta = Omit<ReviewRowRecord, "result" | "partials">;

/** One file with its row record (result loaded, partials never) for a page of the row query. */
export interface ReviewRowItem { file: StoredFile; rec: ReviewRowRecord | null }

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
  // reviews
  /** Every file of a set (no text), oldest first; bounded by DOCS_LIMITS.maxFilesPerSet. */
  allFiles(setId: string): Promise<StoredFile[]>;
  insertReview(review: StoredReview): Promise<void>;
  getReview(setId: string, reviewId: string): Promise<StoredReview | null>;
  listReviews(setId: string): Promise<StoredReview[]>;
  /** Compare-and-set on the stored version: false when the review changed (or vanished) since `expectedVersion` was read. */
  updateReview(review: StoredReview, expectedVersion: number): Promise<boolean>;
  /** The review, its rows and its report. */
  deleteReview(setId: string, reviewId: string): Promise<void>;
  /** Row bookkeeping only (never result or partials). */
  listReviewRows(reviewId: string): Promise<ReviewRowMeta[]>;
  /** One row with its result; `partials` only when asked (the run resuming a long file). */
  getReviewRow(reviewId: string, fileId: string, opts?: { partials?: boolean }): Promise<ReviewRowRecord | null>;
  /** Upsert the model columns of a row; an existing decision is never touched. */
  putReviewRow(row: ReviewRowRecord): Promise<void>;
  /** Bulk form of putReviewRow (one statement / transaction). */
  putReviewRows(rows: ReviewRowRecord[]): Promise<void>;
  /**
   * Set (or clear) the decision only if the row's stored hash still equals `expectedRowHash` ("" = no hash stored).
   * Creates a placeholder row when none exists and "" is expected. Returns false on a hash mismatch.
   */
  setReviewDecision(reviewId: string, setId: string, fileId: string, decision: CodingDecision | null, expectedRowHash: string): Promise<boolean>;
  /** Counts per review of the set (computed in SQL over every file); reviews with no files are absent (all zero). */
  reviewCounts(setId: string, reviewId?: string): Promise<Map<string, ReviewCounts>>;
  /** Facets over every file of one review (computed in SQL). */
  reviewFacets(setId: string, reviewId: string, issueIds: string[]): Promise<ReviewFacets>;
  /** Filtered, sorted page of rows (filters, sort and paging in SQL); results are loaded for the page only. */
  queryReviewRows(setId: string, reviewId: string, q: RowQuery, page: { offset: number; limit: number }): Promise<{ total: number; items: ReviewRowItem[] }>;
  putReviewReport(reviewId: string, report: ReviewReport): Promise<void>;
  getReviewReport(reviewId: string): Promise<ReviewReport | null>;
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

export const REVIEW_COLS = ["id", "set_id", "name", "playbook_id", "area", "doc_types", "issues", "columns", "questions", "version", "created_by", "created_at", "updated_at"] as const;

function jsonOf<T>(v: unknown): T | null {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return null; }
}

export function reviewFromRow(r: Raw): StoredReview {
  return {
    id: String(r.id), setId: String(r.set_id), name: String(r.name), playbookId: strOrNull(r.playbook_id), area: String(r.area) as DocReview["area"],
    docTypes: jsonArr<string>(r.doc_types), issues: jsonArr(r.issues), columns: jsonArr(r.columns), questions: jsonArr<string>(r.questions),
    version: num(r.version, 1), createdBy: String(r.created_by), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function reviewToRow(v: StoredReview): Record<(typeof REVIEW_COLS)[number], string | number | null> {
  return {
    id: v.id, set_id: v.setId, name: v.name, playbook_id: v.playbookId, area: v.area, doc_types: JSON.stringify(v.docTypes), issues: JSON.stringify(v.issues),
    columns: JSON.stringify(v.columns), questions: JSON.stringify(v.questions), version: v.version, created_by: v.createdBy, created_at: v.createdAt, updated_at: v.updatedAt,
  };
}

/**
 * Columns derived from a row's result / decision so that counts, facets, filters, sort and paging run in SQL. Added to
 * existing tables by migration (guarded ADD COLUMN) and backfilled from `result` / `decision` where `derived_v` is
 * missing or older than ROW_DERIVED_VERSION.
 */
export const ROW_DERIVED_VERSION = 1;
export const ROW_ADDED_COLUMNS: ReadonlyArray<readonly [string, "INTEGER" | "TEXT"]> = [
  ["cov_partial", "INTEGER"], ["doc_type", "TEXT"], ["importance", "INTEGER"], ["privilege_flag", "TEXT"], ["issue_ranks", "TEXT"], ["search_text", "TEXT"],
  ["coding", "TEXT"], ["decision_hash", "TEXT"], ["coding_note", "TEXT"], ["derived_v", "INTEGER"],
];

/** Run-derived columns: coverage, doc type, importance, privilege flag, "|issue:rank|…|" and normalized search text. */
export function derivedRunCols(result: ReviewResult | null) {
  if (!result) return { cov_partial: null, doc_type: null, importance: null, privilege_flag: null, issue_ranks: null, search_text: null };
  const ranked = (result.issues ?? []).filter((i) => i.relevance !== "none" && RELEVANCE_RANK[i.relevance]).map((i) => `${i.issueId}:${RELEVANCE_RANK[i.relevance]}`);
  const values = Object.values(result.cells ?? {}).flatMap((c) => [c.value ?? "", ...(c.alternatives ?? []).map((a) => a.value)]);
  const search = normalizeForMatch([result.docType ?? "", result.summary ?? "", ...values, ...(result.issues ?? []).map((i) => i.reason), result.privilege?.basis ?? ""].join(" \u0001 "));
  return {
    cov_partial: coveragePartial(result.coverage) ? 1 : 0,
    doc_type: result.docType ?? null,
    importance: typeof result.importance === "number" ? result.importance : null,
    privilege_flag: result.privilege?.flag ?? null,
    issue_ranks: ranked.length ? `|${ranked.join("|")}|` : "",
    search_text: search,
  };
}

/** Decision-derived columns (written with the decision). */
export function derivedDecisionCols(d: CodingDecision | null) {
  return { coding: d?.coding ?? null, decision_hash: d ? d.rowHash ?? "" : null, coding_note: d?.note ? normalizeForMatch(d.note) : null };
}

/** Columns the run writes (decision columns are written only by setReviewDecision). */
export const ROW_COLS = [
  "review_id", "file_id", "set_id", "state", "review_version", "text_hash", "file_stamp", "windows_done", "result", "partials", "row_hash", "error", "attempts", "updated_at",
  "cov_partial", "doc_type", "importance", "privilege_flag", "issue_ranks", "search_text", "derived_v",
] as const;
/** Row columns without the large JSON ones (result, partials). */
export const ROW_META_COLS = ["review_id", "file_id", "set_id", "state", "review_version", "text_hash", "file_stamp", "windows_done", "row_hash", "decision", "error", "attempts", "updated_at"] as const;

export function reviewRowFromRow(r: Raw): ReviewRowRecord {
  const state = String(r.state);
  return {
    reviewId: String(r.review_id), fileId: String(r.file_id), setId: String(r.set_id),
    state: (["pending", "progress", "done", "failed"].includes(state) ? state : "pending") as ReviewRowRecord["state"],
    reviewVersion: r.review_version == null ? null : num(r.review_version), textHash: strOrNull(r.text_hash), fileStamp: strOrNull(r.file_stamp),
    windowsDone: num(r.windows_done), result: jsonOf<ReviewResult>(r.result), partials: jsonArr<ReviewResult>(r.partials), rowHash: strOrNull(r.row_hash),
    decision: jsonOf<CodingDecision>(r.decision), error: strOrNull(r.error), attempts: num(r.attempts), updatedAt: String(r.updated_at),
  };
}

export function reviewRowMetaFromRow(r: Raw): ReviewRowMeta {
  const { result, partials, ...meta } = reviewRowFromRow({ ...r, result: null, partials: null });
  void result; void partials;
  return meta;
}

export function reviewRowToRow(x: ReviewRowRecord): Record<(typeof ROW_COLS)[number], string | number | null> {
  return {
    review_id: x.reviewId, file_id: x.fileId, set_id: x.setId, state: x.state, review_version: x.reviewVersion, text_hash: x.textHash, file_stamp: x.fileStamp,
    windows_done: x.windowsDone, result: x.result ? JSON.stringify(x.result) : null, partials: JSON.stringify(x.partials ?? []), row_hash: x.rowHash,
    error: x.error, attempts: x.attempts, updated_at: x.updatedAt, ...derivedRunCols(x.result), derived_v: ROW_DERIVED_VERSION,
  };
}

/** Parse a number column (Postgres returns text, SQLite numbers). */
export const numOf = (v: unknown) => num(v);

export function reportFromJson(v: unknown): ReviewReport | null {
  return jsonOf<ReviewReport>(v);
}

// ---- query terms ------------------------------------------------------------------------------------------------

const STOP = new Set("a an and are as at be but by for from has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was were what when where which who whom why will with would you your do does did not no can could should shall may might must about any all also how".split(" "));

/** Distinct content words of a query (letters/digits), at most 16. */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  // \p{M} keeps vowel signs and viramas inside words (Devanagari, Tamil, Kannada, Bengali…), which \p{L} alone would split.
  for (const m of (q ?? "").toLowerCase().normalize("NFC").matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length < 2 && !/\d/.test(w) && /^[\p{Script=Latin}]+$/u.test(w)) continue;
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
