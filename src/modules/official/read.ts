import "server-only";
import type { RemoteStore, Row } from "@/lib/db/remote";
import { sourceDef } from "./registry";
import { boundedQuery, SEARCH_TIMEOUT_MS } from "./search";
import type { OfficialReadResult } from "./service";
import { parseSourceRef, type DocumentStatus, type ExtractionMethod, type SourceChunk, type SourceDocument, type SourceId, type SourceKind } from "./types";
import { officialStore } from "./units";

/**
 * Reading official documents: a bounded run of chunks from a chunk index or from the chunk that contains a page.
 * A page with no chunk (blank, or beyond the document) returns no text — never the nearest page — with `nextChunk`
 * pointing at what follows so the caller can choose to continue explicitly.
 */

export const DEFAULT_READ_CHARS = 20_000;
export const MAX_READ_CHARS = 120_000;
const ID_RE = /^[A-Za-z0-9_.:-]{6,160}$/;

export const DOC_COLS = `id, source, kind, url, file_url, title, doc_date::text AS doc_date, forum, status, mime, sha256, bytes, pages, extraction, ocr_pages, ocr_model, language, meta, version, fetched_at, indexed_at, error, attempts, chunks, embedded, text_sha256`;

const STATUSES: DocumentStatus[] = ["discovered", "fetched", "extracted", "ocr_needed", "indexed", "failed", "excluded"];
const METHODS: ExtractionMethod[] = ["text_layer", "html", "firecrawl_pdf", "ocr_model", "dataset"];

const int = (v: string | null | undefined): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

/** Postgres int[] text ("{1,2,3}") → numbers. */
export function parseIntArray(v: string | null | undefined): number[] {
  if (!v) return [];
  return v.replace(/^\{|\}$/g, "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
}

function parseObject(v: string | null | undefined): Record<string, unknown> {
  if (!v) return {};
  try { const o = JSON.parse(v) as unknown; return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {}; } catch { return {}; }
}

const iso = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = Date.parse(v.includes("T") ? v : v.replace(" ", "T"));
  return Number.isFinite(t) ? new Date(t).toISOString() : v;
};

export function toSourceDocument(r: Row): SourceDocument {
  const status = STATUSES.includes(r.status as DocumentStatus) ? (r.status as DocumentStatus) : "discovered";
  return {
    id: String(r.id),
    // Rows are written only by the pipeline with validated ids; the stored value is reported as is (never remapped).
    sourceId: String(r.source) as SourceId,
    kind: String(r.kind) as SourceKind,
    url: String(r.url ?? ""),
    fileUrl: r.file_url ?? null,
    title: String(r.title ?? ""),
    docDate: r.doc_date ? String(r.doc_date).slice(0, 10) : null,
    status,
    mime: r.mime ?? null,
    sha256: r.sha256 ?? null,
    bytes: int(r.bytes),
    pages: int(r.pages),
    extraction: METHODS.includes(r.extraction as ExtractionMethod) ? (r.extraction as ExtractionMethod) : null,
    ocrPages: parseIntArray(r.ocr_pages),
    language: r.language ?? null,
    meta: parseObject(r.meta),
    version: int(r.version) ?? 1,
    fetchedAt: iso(r.fetched_at),
    indexedAt: iso(r.indexed_at),
    error: r.error ?? null,
    attempts: int(r.attempts) ?? 0,
    chunks: int(r.chunks) ?? 0,
  };
}

export function toSourceChunk(r: Row): SourceChunk {
  return {
    documentId: String(r.document_id),
    index: Number(r.idx),
    pageStart: int(r.page_start),
    pageEnd: int(r.page_end),
    heading: r.heading ?? null,
    text: String(r.text ?? ""),
  };
}

/** Attribution line shown with any text read from the document. */
export function attributionFor(doc: Pick<SourceDocument, "sourceId" | "url" | "extraction" | "fetchedAt" | "version">): string {
  const def = sourceDef(doc.sourceId);
  const parts = [def?.attribution ?? `Source: ${doc.url}`, def?.terms ?? "Government publication; verify against the official copy"];
  parts.push(`Official copy: ${doc.url}${doc.fetchedAt ? ` (fetched ${doc.fetchedAt.slice(0, 10)}, version ${doc.version})` : ""}.`);
  if (doc.extraction === "ocr_model") parts.push("Text obtained by OCR (model transcription): check quotes against the official PDF before filing.");
  if (doc.extraction === "firecrawl_pdf") parts.push("Text obtained by a third-party PDF parser: check quotes against the official PDF before filing.");
  return parts.join(" ");
}

/** Resolve "od_…" ids and "src://…" refs; null when it is neither (never guessed). */
export function resolveDocumentRef(idOrRef: string): { id: string; page: number | null; chunk: number | null } | null {
  const s = String(idOrRef ?? "").trim();
  if (s.startsWith("src://")) {
    const r = parseSourceRef(s);
    return r ? { id: r.documentId, page: r.page, chunk: r.chunk } : null;
  }
  return ID_RE.test(s) ? { id: s, page: null, chunk: null } : null;
}

export async function getOfficialDocument(id: string, store: RemoteStore): Promise<SourceDocument | null> {
  const rows = await store.query({ query: `SELECT ${DOC_COLS} FROM official_documents WHERE id = $1`, params: [id] });
  return rows[0] ? toSourceDocument(rows[0]) : null;
}

/** Read a document's chunks (see module notes). Null when the document does not exist. */
export async function readOfficialDocument(idOrRef: string, opts: { fromChunk?: number; page?: number; maxChars?: number } = {}, storeArg?: RemoteStore | null): Promise<OfficialReadResult | null> {
  const ref = resolveDocumentRef(idOrRef);
  if (!ref) return null;
  const store = await officialStore(storeArg);
  const doc = await getOfficialDocument(ref.id, store);
  if (!doc) return null;
  const maxChars = Math.max(1_000, Math.min(Math.floor(Number(opts.maxChars) || DEFAULT_READ_CHARS), MAX_READ_CHARS));
  const attribution = attributionFor(doc);
  const page = opts.page ?? ref.page ?? null;
  let start: number | null = opts.fromChunk != null ? Math.max(0, Math.floor(opts.fromChunk)) : ref.chunk;
  if (start == null && page != null) {
    const at = await store.query({ query: `SELECT idx FROM official_chunks WHERE document_id = $1 AND page_start <= $2 AND coalesce(page_end, page_start) >= $2 ORDER BY idx LIMIT 1`, params: [doc.id, page] });
    if (!at.length) {
      const after = await store.query({ query: `SELECT idx FROM official_chunks WHERE document_id = $1 AND page_start > $2 ORDER BY idx LIMIT 1`, params: [doc.id, page] });
      return { document: doc, chunks: [], hasMore: after.length > 0, nextChunk: after[0] ? Number(after[0].idx) : null, attribution };
    }
    start = Number(at[0].idx);
  }
  const from = start ?? 0;
  const rows = await boundedQuery(store, `SELECT document_id, idx, page_start, page_end, heading, text FROM official_chunks WHERE document_id = $1 AND idx >= $2 ORDER BY idx LIMIT 200`, [doc.id, from], SEARCH_TIMEOUT_MS);
  const chunks: SourceChunk[] = [];
  let used = 0;
  let i = 0;
  for (; i < rows.length; i++) {
    const c = toSourceChunk(rows[i]);
    if (chunks.length && used + c.text.length > maxChars) break;
    chunks.push(c);
    used += c.text.length;
  }
  const hasMore = i < rows.length || (rows.length === 200 && i === rows.length);
  const nextChunk = hasMore ? (chunks.length ? chunks[chunks.length - 1].index + 1 : from) : null;
  return { document: doc, chunks, hasMore, nextChunk, attribution };
}
