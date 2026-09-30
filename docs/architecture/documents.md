# Document sets (LeClaude India)

Bulk upload a set of files, then ask questions across them, pull out key facts and build a timeline. Replaces the
e-discovery workspace in the India product (e-discovery stays in the code base but is hidden from navigation).

Types: `src/modules/documents/types.ts`. Server facade for other modules: `src/modules/documents/server/index.ts`.

## Storage

Dedicated tables, queried in place, never the mirror collections (a set can hold thousands of files and the mirror
hydrates everything on every cold start):

| table | key | contents |
|---|---|---|
| `docs_sets` | id | tenant, owner, matter, name, description, counts, timestamps |
| `docs_files` | id, unique (set_id, sha256) | name, mime, size, sha256, hash origin, method, status, pages, ocr pages (json), chars, doc date, note, uploader, extraction state |
| `docs_chunks` | (file_id, idx) | set_id, page, text; Postgres: generated `tsvector` (english) + GIN; SQLite: FTS5 table `docs_chunks_fts` |
| `docs_extractions` | file_id | set_id, text hash, extractor version, status, facts json, events json, error |

Backend: Postgres through `remoteStore()` when `DATABASE_URL` is set (production), the local SQLite file otherwise
(dev, tests). One small `DocStore` interface with the two implementations; an opt-in Postgres test like the corpus
(`CORPUS_TEST_PG`).

Storage guard: before accepting a file on Postgres, `pg_database_size` is compared with `DOCS_MAX_DB_MB`
(default 490). Over the limit, uploads are refused with a clear message (the Neon plan must be upgraded).

Original bytes are not stored. Text is stored with page numbers; SHA-256, size, type and method are recorded.

## Upload paths

- PDF (any size up to 200 MB / 3000 pages): read in the browser with pdf.js (`src/modules/office/pdf/pdfjs.ts`), page
  texts + SHA-256 (WebCrypto) sent as JSON (`BrowserPdfUpload`), in page batches if large (see API). Pages with no text
  layer are recorded in `ocrPages`.
- Other types (DOCX, TXT, MD, CSV, HTML, EML, JSON) up to 4 MB: multipart upload of the bytes; the server validates
  with `scanUpload` (magic bytes vs type), hashes, extracts with `extractTextFromBytes`.
- Duplicates (same SHA-256 in the set) return `duplicate` with the existing file. Every file gets an explicit result.
- Scanned pages: the client rasterises the page (pdf.js) to JPEG and posts it to the OCR endpoint; the server
  transcribes it with the vision model (`describeImage`, fast role), stores the page text with method `ocr-ai`.

Chunking: within a page, ~1,500 characters on paragraph/sentence boundaries with ~150 characters overlap.

## Query

- Ask: full-text retrieval (Postgres `websearch_to_tsquery` with an OR-of-terms fallback; SQLite FTS5 bm25), top 14
  passages (whole set when it is small), passed as citation-native evidence to `runAgent` (no tools), answer streams
  with `[n]` markers; markers are mapped to passages in code, unknown markers listed as unresolved. No passages →
  `noEvidence: true` and "The documents in this set do not establish this."
- Facts and timeline: one extraction pass per file (fast model, `generateJSON`, windows of ~14,000 characters with
  page markers) producing facts and dated events with page and verbatim quote. Stored per file with the text hash and
  extractor version, so re-runs only process new or changed files. Quotes are checked against the stored text in code
  (`quoteFound`). Dates are normalised in code to ISO with a precision; events without a resolvable date are dropped.
  The client drives extraction by calling the extract endpoint until `remaining` is 0 (each call works for at most
  ~200 s, 4 files in parallel).

## API

| route | method | body / query | result |
|---|---|---|---|
| `/api/documents/status` | GET | | `{ ai: boolean, storage: { backend, usedMb, limitMb, full } }` |
| `/api/documents/sets` | GET | | `{ sets: DocSet[] }` |
| `/api/documents/sets` | POST | `{ name, description?, matterId? }` | `{ set }` |
| `/api/documents/sets/[id]` | GET, PATCH, DELETE | PATCH `{ name?, description? }` | `{ set }` / `{ ok }` |
| `/api/documents/sets/[id]/files` | GET | `?offset&limit&status&q` | `{ files: DocFile[], total }` |
| `/api/documents/sets/[id]/files` | POST | JSON `BrowserPdfUpload` (pages ≤ 3.5 MB of text per call; larger PDFs send `{ ...upload, pages: firstBatch, totalPages }` then `PATCH /files/[fileId]` with `{ appendPages, fromPage }`) or multipart `file` + `lastModified` | `UploadResult` |
| `/api/documents/sets/[id]/files/[fileId]` | GET | `?page` | `{ file, pages: { page, text }[] }` |
| `/api/documents/sets/[id]/files/[fileId]` | PATCH | `{ appendPages: string[], fromPage }` | `{ file }` |
| `/api/documents/sets/[id]/files/[fileId]` | DELETE | | `{ ok }` |
| `/api/documents/sets/[id]/files/[fileId]/ocr` | POST | `{ page, image }` (data URL, ≤ 3 MB) | `{ file, page, chars }` |
| `/api/documents/sets/[id]/ask` | POST (SSE) | `{ question, fileIds? }` | events `status`, `passages {count}`, `delta {text}`, `done {answer: DocAnswer}`, `error {message}` |
| `/api/documents/sets/[id]/extract` | POST | `{ max? }` | `ExtractProgress` |
| `/api/documents/sets/[id]/facts` | GET | `?file&q&category` | `{ facts: DocFact[], extracted, total }` |
| `/api/documents/sets/[id]/timeline` | GET | `?file&q` | `{ events: DocEvent[], extracted, total }` |

Authorization: every route resolves the set and checks it in code — matter sets through the policy
(`can(principal, action, refs.matter(set.matterId))`), personal sets by owner. Creating a set on a matter requires
write on the matter. Unknown or unreadable sets both return 404.

Routes: `export const runtime = "nodejs"`, `withDb(withAuth(...))`, `maxDuration` 300 on ask/extract/ocr/files.

## Chat

The Chat composer's knowledge switch selects Web, Indian law (judgments, statutes, sections), the firm library and
document sets. Selected sets are validated on the server against `listDocSets(principal)`; the `search_documents`
tool only searches those.
