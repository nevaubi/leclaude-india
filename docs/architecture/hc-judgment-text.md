# High Court judgment text from the court PDFs

Roadmap P1.1. Code: `src/modules/india/corpus/hc-text/**`; cron route: `/api/india/hc-text/run`; dashboard:
`/sources/coverage` (API `/api/india/hc-text/coverage`).

## What it does

For every High Court record in `corpus_judgments` whose `text_status` is `none` or `metadata`, whose `pdf_url` is on the
AWS Open Data bucket `indian-high-court-judgments` and which has a valid CNR and decision date, the worker:

1. fetches the PDF from exactly `https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com/` (HTTPS only; the URL
   is checked before any connection, `safeFetch` re-checks every redirect hop and refuses private addresses; size cap
   `HC_TEXT_MAX_PDF_MB`, timeout, per-host token bucket). A larger PDF is refused and recorded, never truncated;
2. hashes the bytes (sha256) and extracts the text layer with the official-sources extractor
   (`src/modules/official/extract.ts`: pdfjs, per-page readability gate, scans and glyph garbage detected per page);
3. OCRs only the pages without a usable text layer through `src/modules/official/ocr.ts` (the configured vision model via
   the model router; `<!-- page N -->` markers with the original page numbers; a response whose markers do not match is
   retried page by page; per-document cap `HC_TEXT_OCR_MAX_PAGES`). OCR progress is saved on the unit after every
   range, so a run that stops at its deadline resumes without paying for those pages again;
4. removes contact data (phone numbers, e-mail addresses, video-conference links) with the same scrubber as official
   documents (`scrubPersonalData`), visibly (`[phone removed]`);
5. chunks the page-marked text with the official chunker (`chunkJudgmentPages` in `hc-text/chunk.ts`: ~2,500
   characters, never over 4,000, closed at page boundaries; every chunk has `page_start` / `page_end`; chunks that
   include an OCR page get `section_type = 'ocr'`);
6. writes the chunks and the record's `text_status` in ONE guarded statement, and the provenance on its unit.

Raw PDFs are not stored anywhere by default. The source of record is the public, immutable dataset object; its URL and
the sha256 of the bytes that were read are kept in `hc_text_units`.

## Storage contract (for retrieval / embeddings)

PDF text lives in the **same table** as Open India Law text, `corpus_texts`, so `src/modules/india/corpus/text.ts`
(`readJudgmentText`, `searchJudgmentText`, `findCitationMentions`), the coverage summary and the citator see it with no
change of query:

| column | PDF text rows |
|---|---|
| `id` | `hcpdf:<judgment id>:<chunk index>` (stable; a re-run rewrites in place) |
| `case_key` | the `corpus_judgments.id` the text was extracted for |
| `neutral_citation` | `NULL` (High Court text is keyed by CNR + date, as for Open India Law HC rows) |
| `cnr`, `decision_date` | the record's CNR and decision date (the identity readers use) |
| `court_id`, `title`, `case_number` | from the record |
| `chunk_index`, `total_chunks` | 0-based order; total for the judgment |
| `page_start`, `page_end` | 1-based PDF page numbers |
| `section_type` | `'ocr'` when the chunk includes an OCR'd page, else `NULL` |
| `text` | scrubbed chunk text |
| `dataset_version` | `aws-hc-pdf:x<extractor version>.p<pipeline version>` (Open India Law rows carry its snapshot version, e.g. `v2026.08.1`) |
| `search` | generated tsvector (unchanged) |

Rules an embedding / hybrid-retrieval worker can rely on:

- One text per judgment: for a CNR + date there are either Open India Law rows or PDF rows, never both (see below).
- Rows are only ever replaced by the same judgment's re-run (same ids; a shorter re-run deletes its stale tail).
- `chunkJudgmentPages(pages, ocrPages)` is the chunking function (pure; page numbers in, chunks with page numbers out).
- Embeddings should key on `corpus_texts.id` and be invalidated when the row's `text` changes (compare a hash), as for
  official chunks. OCR rows should keep their `section_type = 'ocr'` label through retrieval results.

`text_status` values (`src/modules/india/corpus/text-status.ts`): `none`/`metadata` (no text), `full` (Open India
Law), `full_text` (PDF text layer), `ocr` (some or all pages OCR'd), `partial` (some pages missing: OCR capped, off,
unavailable or failed, or text cut at the extraction limit), `failed` (no text could be obtained; reason on the unit).
Readers treat `full`, `full_text`, `ocr` and `partial` as "has text" (`hasJudgmentText`). Tool results label OCR and
partial text, and `readJudgmentText` returns `source: "court_pdf" | "open_india_law"`, `ocr`, and an attribution that
names the producer of the text (never Open India Law for PDF text).

## Open India Law and PDF text: which one is served

Open India Law text is never replaced.

- Before fetching, a record whose `text_status` is `full`, or whose CNR + date already has Open India Law rows, is
  skipped (`oil_text = true` on the unit). The store statement re-checks both in the same snapshot as the insert.
- If Open India Law text is loaded later, `scripts/law-corpus/load_hc_judgment_text.py` (`mark()`) deletes the PDF
  rows for every CNR + date that now has Open India Law rows, records `oil_text = true` and a note on the unit, and marks
  the record `full`. Both texts are therefore never interleaved for one judgment.
- A second record with the same CNR + date as a record that already has PDF text is skipped (not stored twice).

## Queue (`hc_text_units`)

One row per judgment: the durable queue and the provenance.

- Claim: one `UPDATE … WHERE judgment_id = (SELECT … FOR UPDATE SKIP LOCKED)` with a 10-minute lease, ordered by
  `priority` (the schedule slice), then newest decision date. Attempts are bounded (5); transient download failures
  back off 2^attempts minutes; an expired lease on the last attempt is closed as failed (`sweepExpired`).
- Hand-back: a unit interrupted by the run's deadline is released with its attempt given back; a unit that cannot start
  OCR in the time left, or whose OCR stopped at the deadline, is deferred past the deadline with its OCR progress.
- Watchdog: like `src/modules/official/run.ts`, a run stops waiting 20 s after its deadline and hands back units still
  running (CPU-bound PDF parsing does not observe the abort), so the function returns before the platform kills it.
- Schedule (`hc-text/schedule.ts`): slices of court × decision year. First 2016–present (`HC_TEXT_RECENT_FROM`):
  Delhi, Bombay, Madras, Allahabad, Punjab & Haryana, Karnataka, Calcutta, Gujarat, Kerala, then every other High Court,
  newest year first within a court; then older years down to `HC_TEXT_OLDEST_YEAR` in the same court order. Each run
  tops the queue up to `HC_TEXT_ENQUEUE_PER_RUN` when it runs low, probing at most 80 slices; after a full pass the next
  pass starts 6 hours later (picks up records the metadata backfill added).
- Budget: the run stops with `budget` when `pg_database_size` reaches `HC_TEXT_MAX_DB_MB` (else `OFFICIAL_MAX_DB_MB`,
  else 60,000 MB). Stop states: `done`, `deadline`, `budget`, `error`, `no_corpus`.

## Coverage

`hc_text_coverage` holds counts per court × decision year (records, with text, Open India Law, PDF text, OCR, partial,
failed, metadata only, latest text update). Each run recounts up to three courts whose summary is missing or older than
30 minutes (missing first), so the dashboard never scans millions of records per request. Until the first recount the
API counts live (one grouped scan with a 20 s statement timeout; fine for small deployments). The page
`/sources/coverage` is private: the middleware keeps anonymous visitors out when sign-in is enforced, the page renders a
sign-in state without a principal, and both APIs authorize `read` on research data (`withAuth`, client guests refused).

## Schema and production migration

The DDL is in `hc-text/schema.ts` and runs idempotently on the first run (`CREATE … IF NOT EXISTS`, `ALTER … ADD COLUMN
IF NOT EXISTS` under a 5 s lock timeout). It creates `hc_text_units`, `hc_text_coverage` and, if absent, `corpus_texts`
with the loader's columns and indexes (`corpus_texts_cnr`, `corpus_texts_court`, `corpus_texts_first_chunk`,
`corpus_texts_search` — the same names as the loaders, so no index is rebuilt where they ran). No index is created on
the existing large tables at runtime. Recommended once, outside a request (production, concurrently):

```sql
-- Seeding filters by court and decision date (already served by corpus_judgments_court_date); this one makes the
-- per-court coverage recount an index-only scan on large courts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS corpus_judgments_court_date_status ON corpus_judgments (court_id, decision_date, text_status);
```

## Raw copies (object storage)

`hc-text/blob-store.ts` defines `BlobStore`. Default `none`. `HC_TEXT_BLOB_STORE=local` uses the SQLite blobs table in
development only, and is refused when `DATABASE_URL`/`POSTGRES_URL` is set (that table syncs to Postgres). To keep raw
copies in production, implement `BlobStore` over S3/R2 (an S3 client with KMS, key `hc-pdf/<sha256>.pdf`) or Vercel
Blob (`@vercel/blob` with `BLOB_READ_WRITE_TOKEN`). Neither package is installed today; adding one is a dependency
change.

## Configuration

| variable | default | meaning |
|---|---|---|
| `HC_TEXT_INGEST` | off | `1` lets the cron run the worker |
| `HC_TEXT_CONCURRENCY` | 4 | workers per run (1–16) |
| `HC_TEXT_LIMIT_PER_RUN` | 300 | judgments processed per run |
| `HC_TEXT_ENQUEUE_PER_RUN` | 500 | queue top-up per run |
| `HC_TEXT_RECENT_FROM` / `HC_TEXT_OLDEST_YEAR` | 2016 / 1950 | schedule window |
| `HC_TEXT_HOST_RPS` / `HC_TEXT_HOST_BURST` | 4 / 8 | requests per second to the bucket |
| `HC_TEXT_MAX_PDF_MB` | 25 | larger PDFs are refused (failed) |
| `HC_TEXT_FETCH_TIMEOUT_MS` | 60000 | per download |
| `HC_TEXT_OCR` | on | `0` disables OCR (records with scanned pages become partial or wait) |
| `HC_TEXT_OCR_MAX_PAGES` | 40 | documents needing more OCR pages keep their text layer as partial |
| `HC_TEXT_OCR_CONCURRENCY` | 3 | OCR requests in flight per document |
| `HC_TEXT_OCR_MODEL` | `OFFICIAL_OCR_MODEL`, else the runtime fast model | OCR model id (vision-capable) |
| `HC_TEXT_MAX_DB_MB` | `OFFICIAL_MAX_DB_MB`, else 60000 | storage budget |
| `HC_TEXT_BLOB_STORE` | none | `local` (development only) |

The cron route is gated exactly like `/api/official/run`: with `CRON_SECRET` only the cron service principal runs it;
without it, only in `AUTH_MODE=dev` an unauthenticated call is a throttled kick (one per 280 s, claimed in Postgres).
`POST` needs `run` on intel and `x-official-token` = `OFFICIAL_INGEST_TOKEN` (or the service principal); body
`{ deadlineMs?, concurrency?, limit?, retryFailed?, seed? }`. `retryFailed` re-queues failed and partial units (for
example after an OCR model is configured).

## Volume and cost (estimates; assumptions stated)

Assumptions, to be replaced by measured values from `hc_text_units` (`pdf_bytes`, `pages`, `ocr_pages`, `chars`):
average judgment PDF 4 pages and 150 KB; 3,000 characters of text per page; 5 chunks per judgment; Postgres cost per
judgment about 25 KB (text with TOAST compression, generated tsvector, GIN entries, row overhead; embeddings excluded);
5% of pages need OCR from 2016 onward and 30% before 2010; OCR on a fast vision model at about 1,500 input and 1,000
output tokens per page, about USD 0.002 per page (depends on the configured model's price).

Per 100,000 judgments (one large High Court-year; smaller courts are 5,000–30,000 a year):

| item | 2016 onward | before 2010 |
|---|---|---|
| downloads from the bucket | ~15 GB | ~15 GB |
| Postgres (text + search) | ~2.5 GB | ~2.5 GB |
| pages OCR'd | ~20,000 | ~120,000 |
| OCR cost | ~USD 40 | ~USD 240 |

Throughput on the Vercel cron: one run every 5 minutes, 240 s, 4 workers, about 1–2 s per text-layer PDF → up to the
per-run limit of 300 judgments, about 86,000 a day. The dataset holds on the order of 16 million High Court
judgments, so a full backfill on cron alone takes months and its storage (~400 GB at 25 KB each) is far above the
default budget: the budget stop is expected, and bulk work belongs on a worker (roadmap P5.5) with object storage for
text (P5.1).
