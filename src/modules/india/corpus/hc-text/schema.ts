import type { SqlQuery } from "@/lib/db/remote";

/**
 * Tables of the High Court PDF text worker (idempotent DDL; every statement can be re-run).
 *
 * - `corpus_texts` is the SAME table the Open India Law loaders write (scripts/law-corpus/load_hc_judgment_text.py) and
 *   src/modules/india/corpus/text.ts reads; the DDL here is the loader's, so either side can create it first. PDF text
 *   rows are told apart by `dataset_version LIKE 'aws-hc-pdf%'`, `id LIKE 'hcpdf:%'` and `case_key` = the judgment id.
 * - `hc_text_coverage` is the per court × year summary the dashboard reads (refreshed by the worker, see repo.ts).
 * - `hc_text_units` is one row per judgment: the durable queue (lease/claim/defer like official_units) AND the
 *   extraction provenance (PDF URL, sha256 of the PDF bytes, extractor / pipeline versions, OCR pages and model).
 *   Raw PDFs are never stored in Postgres.
 *
 * Indexes on corpus_judgments for the coverage query are a production migration (CREATE INDEX CONCURRENTLY), not run
 * here: see docs/architecture/hc-judgment-text.md.
 */
export const HC_TEXT_SCHEMA_VERSION = 1;

export const HC_TEXT_SCHEMA: SqlQuery[] = [
  { query: `CREATE TABLE IF NOT EXISTS corpus_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())` },
  {
    query: `CREATE TABLE IF NOT EXISTS corpus_texts (
      id text PRIMARY KEY, case_key text NOT NULL, neutral_citation text, chunk_index int NOT NULL, total_chunks int,
      page_start int, page_end int, section_type text, text text NOT NULL, dataset_version text NOT NULL,
      search tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 60000))) STORED
    )`,
  },
  { query: `ALTER TABLE corpus_texts ALTER COLUMN neutral_citation DROP NOT NULL` },
  { query: `ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS court_id text` },
  { query: `ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS cnr text` },
  { query: `ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS decision_date date` },
  { query: `ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS title text` },
  { query: `ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS case_number text` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_texts_cnr ON corpus_texts (cnr, decision_date, chunk_index) WHERE cnr IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_texts_court ON corpus_texts (court_id)` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_texts_first_chunk ON corpus_texts (court_id) WHERE chunk_index = 0` },
  // Same name as load_sc_judgment_text.py (a no-op where the loader ran first). PDF rows are addressed through
  // corpus_texts_cnr (cnr, decision_date), so no new index is built on the existing table here.
  { query: `CREATE INDEX IF NOT EXISTS corpus_texts_search ON corpus_texts USING gin (search)` },
  {
    query: `CREATE TABLE IF NOT EXISTS hc_text_units (
      judgment_id text PRIMARY KEY,
      court_id text NOT NULL,
      year int,
      decision_date date,
      cnr text,
      pdf_url text NOT NULL,
      priority int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempts int NOT NULL DEFAULT 0,
      run_after timestamptz,
      lease_until timestamptz,
      payload jsonb,
      result text,
      error text,
      note text,
      source_url text,
      pdf_sha256 text,
      pdf_bytes int,
      pages int,
      text_pages int,
      ocr_pages int[],
      ocr_failed_pages int[],
      ocr_model text,
      extractor_version int,
      pipeline_version int,
      dataset_version text,
      chunks int,
      chars int,
      oil_text boolean NOT NULL DEFAULT false,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS hc_text_units_claim ON hc_text_units (priority, decision_date DESC, judgment_id) WHERE status IN ('pending', 'running')` },
  { query: `CREATE INDEX IF NOT EXISTS hc_text_units_court_year ON hc_text_units (court_id, year, result)` },
  { query: `CREATE INDEX IF NOT EXISTS hc_text_units_status ON hc_text_units (status)` },
  // Coverage summary per court × decision year (year 0 = no decision date), refreshed by the worker one court at a time
  // so the dashboard never scans millions of records per request.
  {
    query: `CREATE TABLE IF NOT EXISTS hc_text_coverage (
      court_id text NOT NULL,
      year int NOT NULL,
      judgments int NOT NULL,
      with_text int NOT NULL,
      oil int NOT NULL,
      pdf int NOT NULL,
      ocr int NOT NULL,
      partial int NOT NULL,
      failed int NOT NULL,
      meta int NOT NULL,
      last_update timestamptz,
      refreshed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (court_id, year)
    )`,
  },
];
