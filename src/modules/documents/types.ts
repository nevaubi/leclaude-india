/**
 * Document sets: bulk upload a set of files, then ask questions, pull out key facts and build a timeline across them.
 *
 * Storage (server): dedicated tables queried in place — Postgres (Neon) when a remote store is configured, the local
 * SQLite file otherwise. Never the mirror collections: a set can hold thousands of files and the mirror hydrates
 * everything on every cold start. Original file bytes are not kept; the extracted text (with page numbers), the file's
 * SHA-256, size, type and the extraction method are. Every item derived from a file (answer citation, fact, event)
 * points back to file + page + a quote that is checked against the stored text in code.
 *
 * This file is shared by client and server (no server imports).
 */

/** How the text of a file was obtained. */
export type ExtractionMethod =
  | "browser-pdfjs" // PDF text layer read in the browser (pdf.js), page by page
  | "server-docx" // DOCX via the server extractor
  | "server-text" // plain text / CSV / Markdown / HTML (tags stripped)
  | "server-eml" // RFC 822 email (headers + body)
  | "server-pdf" // PDF text layer read on the server (small PDFs sent as bytes)
  | "ocr-ai"; // page image transcribed by the vision model (scanned pages); labelled as such everywhere

export type DocFileStatus =
  | "ready" // text extracted and indexed
  | "partial" // some pages have text, some are scanned images still needing OCR
  | "needs_ocr" // no text layer at all (scanned); searchable only after OCR
  | "empty" // readable but contains no text
  | "failed"; // could not be read (reason in `note`)

export interface DocSet {
  id: string;
  name: string;
  description?: string | null;
  /** Optional matter the set belongs to; access then follows matter access. Without one only the owner sees it. */
  matterId?: string | null;
  ownerId: string;
  tenantId: string;
  fileCount: number;
  pageCount: number;
  /** Files whose facts/events extraction is current. */
  extractedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocFile {
  id: string;
  setId: string;
  name: string;
  mime: string;
  size: number;
  /** Hex SHA-256 of the original bytes. `hashOrigin` says who computed it. */
  sha256: string;
  hashOrigin: "server" | "browser";
  method: ExtractionMethod;
  status: DocFileStatus;
  pages: number;
  /** 1-based page numbers with no text layer (candidates for OCR). */
  ocrPages: number[];
  /** 1-based pages whose stored text was transcribed by the vision model (method "ocr-ai" for those pages). */
  ocrDonePages?: number[];
  /** Batched PDF uploads: pages received so far (equals `pages` once complete). */
  pagesReceived?: number;
  chars: number;
  /** Date carried by the file itself (PDF/DOCX metadata, email Date header), ISO; never the upload time. */
  docDate?: string | null;
  note?: string | null;
  uploadedBy: string;
  uploadedAt: string;
  /** Extraction (facts + events) state for the current text. */
  extraction: "pending" | "done" | "failed";
}

/** One stored text unit; PDFs are chunked within a page so a citation always names a single page. */
export interface DocChunk {
  fileId: string;
  setId: string;
  idx: number;
  /** 1-based page; null for formats without pages. */
  page: number | null;
  text: string;
}

/** Stable, server-resolvable source id for a passage: docs://<setId>/<fileId>/p/<page>#<chunkIdx>. */
export type DocSourceId = string;

export interface DocSearchHit {
  source: DocSourceId;
  setId: string;
  fileId: string;
  fileName: string;
  page: number | null;
  idx: number;
  text: string;
  score: number;
  /** True when the page text was transcribed by the vision model (OCR), not read from a text layer. */
  ocr?: boolean;
}

/** A citation in an answer: the [n] marker and the passage it points to. */
export interface DocCitation {
  n: number;
  source: DocSourceId;
  fileId: string;
  fileName: string;
  page: number | null;
  snippet: string;
}

export interface DocAnswer {
  question: string;
  answer: string;
  citations: DocCitation[];
  /** [n] markers in the answer that point at no supplied passage (shown as unresolved, never re-bound). */
  unresolved: number[];
  /** True when retrieval found nothing relevant; the answer then says the documents do not establish it. */
  noEvidence: boolean;
  passagesSearched: number;
  model?: string;
  durationMs: number;
}

export type DatePrecision = "day" | "month" | "year";

export interface DocFact {
  id: string;
  setId: string;
  fileId: string;
  fileName: string;
  page: number | null;
  /** One self-contained factual statement, as the document states it (not a conclusion). */
  statement: string;
  /** People and organisations the fact is about. */
  parties: string[];
  category: "party" | "date" | "amount" | "obligation" | "event" | "admission" | "claim" | "other";
  /** Verbatim words from the document supporting the statement. */
  quote: string;
  /** Checked in code: the quote occurs in the file's stored text (whitespace/case-insensitive). */
  quoteFound: boolean;
  /** Date the fact refers to, when the document gives one. */
  date?: string | null;
  datePrecision?: DatePrecision | null;
}

export interface DocEvent {
  id: string;
  setId: string;
  fileId: string;
  fileName: string;
  page: number | null;
  /** ISO date (YYYY-MM-DD, YYYY-MM or YYYY per precision). */
  date: string;
  datePrecision: DatePrecision;
  /** The date exactly as written in the document ("3rd March, 2021"). */
  dateText: string;
  description: string;
  parties: string[];
  quote: string;
  quoteFound: boolean;
}

export interface ExtractProgress {
  processed: number;
  failed: number;
  remaining: number;
  /** Files that failed in this call, with the reason. */
  errors: { fileId: string; name: string; error: string }[];
}

// ---- upload payloads ------------------------------------------------------------------------------------------------

/** Browser-extracted PDF (any size): the page texts plus what the browser measured. */
export interface BrowserPdfUpload {
  kind: "pdf-text";
  name: string;
  size: number;
  sha256: string;
  /** Page texts in order (index 0 = page 1). Pages with no text layer are "". */
  pages: string[];
  /** PDF metadata creation/modification date, ISO, when present. */
  docDate?: string | null;
  lastModified?: number;
}

export type UploadResult =
  | { status: "created"; file: DocFile }
  | { status: "duplicate"; file: DocFile }
  | { status: "rejected"; name: string; reason: string };

/** Server-side limits the client respects (also enforced on the server). */
export const DOCS_LIMITS = {
  /** Bytes per non-PDF file sent to the server (serverless request bodies are capped near 4.5 MB). */
  maxServerFileBytes: 4 * 1024 * 1024,
  /** Largest PDF the browser will read. */
  maxPdfBytes: 200 * 1024 * 1024,
  maxPdfPages: 3000,
  /** Characters stored per file. */
  maxFileChars: 2_000_000,
  maxFilesPerSet: 5000,
  /** Parallel uploads from one browser. */
  uploadConcurrency: 3,
  /** Page-image size accepted for OCR. */
  maxOcrImageBytes: 3 * 1024 * 1024,
} as const;

/** File types accepted for upload (by extension, lowercase). PDFs go through the browser; the rest through the server. */
export const DOCS_ACCEPT = [".pdf", ".docx", ".txt", ".md", ".csv", ".html", ".htm", ".eml", ".json"] as const;

export const docSourceId = (setId: string, fileId: string, page: number | null, idx: number): DocSourceId =>
  `docs://${setId}/${fileId}/p/${page ?? 0}#${idx}`;

export function parseDocSourceId(source: string): { setId: string; fileId: string; page: number | null; idx: number } | null {
  const m = /^docs:\/\/([^/]+)\/([^/]+)\/p\/(\d+)#(\d+)$/.exec(source);
  if (!m) return null;
  const page = Number(m[3]);
  return { setId: m[1], fileId: m[2], page: page > 0 ? page : null, idx: Number(m[4]) };
}
