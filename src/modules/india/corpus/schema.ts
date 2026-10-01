import "server-only";
import type { SqlQuery } from "@/lib/db/remote";

/**
 * Corpus tables in Postgres (Neon). Unlike the application mirror (loaded into memory per request), the corpus is
 * queried in place: it is sized for millions of judgments.
 *
 * - `corpus_units`: one row per source archive (a year of Supreme Court metadata, or a year of one High Court bench).
 *   The backfill claims units, records how many records the archive declared and how many were stored, and resumes
 *   an interrupted archive from its cursor. A unit is `done` only when every declared record was stored or explicitly
 *   rejected with a reason.
 * - `corpus_judgments`: one row per judgment. Identity is the dataset's own record key; court identity comes from the
 *   court registry (an unknown code is kept verbatim in `court_code` with `court_id` null, never mapped to a nearby
 *   court). `search` is a weighted full-text vector over the citation fields, parties, judges and the source snippet.
 * - `corpus_rejects`: records that could not be parsed, with the reason (never silently dropped).
 * - `corpus_state`: small key/value state (budget stop reason, discovery progress).
 */
export const CORPUS_SCHEMA_VERSION = 3;

export const CORPUS_SCHEMA: SqlQuery[] = [
  { query: `CREATE TABLE IF NOT EXISTS corpus_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())` },
  {
    query: `CREATE TABLE IF NOT EXISTS corpus_units (
      id text PRIMARY KEY,
      source text NOT NULL,
      year int NOT NULL,
      court_code text,
      bench_code text,
      folder text NOT NULL,
      object_key text NOT NULL,
      expected int,
      priority int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      cursor int NOT NULL DEFAULT 0,
      stored int NOT NULL DEFAULT 0,
      rejected int NOT NULL DEFAULT 0,
      attempts int NOT NULL DEFAULT 0,
      error text,
      lease_until timestamptz,
      started_at timestamptz,
      finished_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS corpus_units_claim ON corpus_units (status, priority, id)` },
  {
    query: `CREATE TABLE IF NOT EXISTS corpus_judgments (
      id text PRIMARY KEY,
      source text NOT NULL,
      unit_id text NOT NULL,
      dataset_key text NOT NULL,
      court_id text,
      court_code text,
      bench_id text,
      bench_code text,
      year int,
      title text NOT NULL,
      petitioner text,
      respondent text,
      case_number text,
      case_type text,
      cnr text,
      neutral_citation text,
      reporter_citation text,
      judges text[] NOT NULL DEFAULT '{}',
      judges_text text,
      author text,
      bench_strength int,
      decision_date date,
      registration_date date,
      disposal text,
      language text NOT NULL DEFAULT 'en',
      translations jsonb,
      pdf_key text,
      pdf_url text,
      snippet text,
      issues text[],
      record_sha256 text NOT NULL,
      text_status text NOT NULL DEFAULT 'none',
      ingested_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      search tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(neutral_citation, '') || ' ' || coalesce(reporter_citation, '') || ' ' || coalesce(case_number, '') || ' ' || coalesce(cnr, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(judges_text, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(snippet, '')), 'C')
      ) STORED
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_search ON corpus_judgments USING gin (search)` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_court_date ON corpus_judgments (court_id, decision_date DESC)` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_cnr ON corpus_judgments (cnr) WHERE cnr IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_neutral ON corpus_judgments (neutral_citation) WHERE neutral_citation IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_case ON corpus_judgments (lower(case_number)) WHERE case_number IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_unit ON corpus_judgments (unit_id)` },
  {
    query: `CREATE TABLE IF NOT EXISTS corpus_rejects (
      unit_id text NOT NULL,
      entry text NOT NULL,
      reason text NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (unit_id, entry)
    )`,
  },
  // v2: facts about an archive that are not errors (records present but not declared in the dataset index).
  { query: `ALTER TABLE corpus_units ADD COLUMN IF NOT EXISTS note text` },
  // v2: a judgment's year is its decision year (rows written by v1 took the dataset folder's year).
  { query: `UPDATE corpus_judgments SET year = extract(year FROM decision_date)::int WHERE decision_date IS NOT NULL AND year IS DISTINCT FROM extract(year FROM decision_date)::int` },
  // v3: keyset browsing by date for the case-law directory (all courts).
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_date_id ON corpus_judgments (decision_date DESC, id DESC)` },
];
