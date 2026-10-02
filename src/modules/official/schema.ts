import "server-only";
import type { RemoteStore, SqlQuery } from "@/lib/db/remote";

/**
 * Official-sources corpus tables (Postgres, created by the app; idempotent; versioned in corpus_state).
 *
 * official_units      work queue: one row per (source, stage, key). Claimed atomically with FOR UPDATE SKIP LOCKED and a
 *                     lease (same pattern as corpus_units), so any number of concurrent run calls share the work safely.
 * official_documents  one row per published document (identity = source + canonical URL). Raw bytes are not stored:
 *                     the official URL, the SHA-256 of the bytes read, when and how they were fetched are.
 * official_chunks     page-marked markdown chunks (no overlap; neighbours are read for context) with a generated
 *                     tsvector; `embedding` holds float32 vectors (bytea) when no pgvector column is available.
 * official_rejects    anything a stage refused (wrong type, too large, unreadable), never silently dropped.
 * causelist_entries   items parsed deterministically from published cause lists.
 * court_holidays      holidays / vacations parsed from official court calendars and notifications.
 *
 * Owner of later changes: the official-core stream (bump OFFICIAL_SCHEMA_VERSION; additive only).
 */

export const OFFICIAL_SCHEMA_VERSION = 2;

export const OFFICIAL_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS official_units (
      id text PRIMARY KEY,
      source text NOT NULL,
      stage text NOT NULL,
      key text NOT NULL,
      document_id text,
      payload jsonb,
      priority int NOT NULL DEFAULT 5,
      status text NOT NULL DEFAULT 'pending',
      attempts int NOT NULL DEFAULT 0,
      error text,
      lease_until timestamptz,
      run_after timestamptz,
      started_at timestamptz,
      finished_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT official_units_stage CHECK (stage IN ('discover', 'fetch', 'extract', 'ocr', 'index', 'parse')),
      CONSTRAINT official_units_status CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped'))
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS official_units_claim ON official_units (status, priority, id)` },
  { query: `CREATE INDEX IF NOT EXISTS official_units_source ON official_units (source, stage, status)` },
  {
    query: `CREATE TABLE IF NOT EXISTS official_documents (
      id text PRIMARY KEY,
      source text NOT NULL,
      kind text NOT NULL,
      url text NOT NULL,
      file_url text,
      title text NOT NULL,
      doc_date date,
      forum text,
      status text NOT NULL DEFAULT 'discovered',
      mime text,
      sha256 text,
      bytes bigint,
      pages int,
      extraction text,
      ocr_pages int[] NOT NULL DEFAULT '{}',
      ocr_model text,
      language text,
      meta jsonb NOT NULL DEFAULT '{}'::jsonb,
      version int NOT NULL DEFAULT 1,
      history jsonb NOT NULL DEFAULT '[]'::jsonb,
      fetch_provenance jsonb,
      text_sha256 text,
      text_chars int,
      chunks int NOT NULL DEFAULT 0,
      embedded int NOT NULL DEFAULT 0,
      error text,
      attempts int NOT NULL DEFAULT 0,
      discovered_at timestamptz NOT NULL DEFAULT now(),
      fetched_at timestamptz,
      indexed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      search tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(meta->>'number', '') || ' ' || coalesce(meta->>'caseNumbers', '') || ' ' || coalesce(meta->>'diaryNo', '')), 'A')
      ) STORED,
      CONSTRAINT official_documents_url UNIQUE (source, url)
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS official_documents_source_date ON official_documents (source, doc_date DESC)` },
  { query: `CREATE INDEX IF NOT EXISTS official_documents_status ON official_documents (status, source)` },
  { query: `CREATE INDEX IF NOT EXISTS official_documents_sha ON official_documents (sha256) WHERE sha256 IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS official_documents_search ON official_documents USING gin (search)` },
  { query: `CREATE INDEX IF NOT EXISTS official_documents_meta ON official_documents USING gin (meta jsonb_path_ops)` },
  {
    query: `CREATE TABLE IF NOT EXISTS official_chunks (
      document_id text NOT NULL REFERENCES official_documents(id) ON DELETE CASCADE,
      idx int NOT NULL,
      text_sha256 text NOT NULL,
      page_start int,
      page_end int,
      heading text,
      text text NOT NULL,
      ocr boolean NOT NULL DEFAULT false,
      chars int NOT NULL,
      embedding_model text,
      embedding_dims int,
      embedding bytea,
      search tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
        setweight(to_tsvector('english', left(text, 60000)), 'B')
      ) STORED,
      PRIMARY KEY (document_id, idx)
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS official_chunks_search ON official_chunks USING gin (search)` },
  { query: `CREATE INDEX IF NOT EXISTS official_chunks_unembedded ON official_chunks (document_id) WHERE embedding IS NULL` },
  {
    query: `CREATE TABLE IF NOT EXISTS official_rejects (
      id bigserial PRIMARY KEY,
      source text NOT NULL,
      url text NOT NULL,
      stage text NOT NULL,
      reason text NOT NULL,
      at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS official_rejects_source ON official_rejects (source, at DESC)` },
  {
    query: `CREATE TABLE IF NOT EXISTS causelist_entries (
      id text PRIMARY KEY,
      document_id text NOT NULL REFERENCES official_documents(id) ON DELETE CASCADE,
      forum text NOT NULL,
      list_date date NOT NULL,
      list_type text NOT NULL,
      court_no text,
      bench text,
      item_no text,
      case_numbers jsonb NOT NULL DEFAULT '[]'::jsonb,
      case_keys text[] NOT NULL DEFAULT '{}',
      diary_no text,
      parties text,
      advocates text[] NOT NULL DEFAULT '{}',
      raw text NOT NULL,
      page int,
      published_at timestamptz,
      fetched_at timestamptz NOT NULL,
      parsed boolean NOT NULL DEFAULT true
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS causelist_entries_date ON causelist_entries (forum, list_date)` },
  { query: `CREATE INDEX IF NOT EXISTS causelist_entries_keys ON causelist_entries USING gin (case_keys)` },
  { query: `CREATE INDEX IF NOT EXISTS causelist_entries_diary ON causelist_entries (diary_no) WHERE diary_no IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS causelist_entries_doc ON causelist_entries (document_id)` },
  {
    query: `CREATE TABLE IF NOT EXISTS court_holidays (
      id text PRIMARY KEY,
      forum text NOT NULL,
      date_from date NOT NULL,
      date_to date NOT NULL,
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'holiday',
      registry_open boolean,
      document_id text REFERENCES official_documents(id) ON DELETE CASCADE,
      source_url text NOT NULL,
      year int NOT NULL,
      note text,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT court_holidays_kind CHECK (kind IN ('holiday', 'vacation', 'partial_working', 'ad_hoc', 'working_day'))
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS court_holidays_forum ON court_holidays (forum, year, date_from)` },
  // ---- v2 (official-core pipeline; additive) ----
  { query: `ALTER TABLE official_units ADD COLUMN IF NOT EXISTS note text` },
  { query: `CREATE INDEX IF NOT EXISTS official_units_doc ON official_units (document_id) WHERE document_id IS NOT NULL` },
  /** Outcome of the adapter's deterministic parse of this document ({records, unparsed, notes, at}). */
  { query: `ALTER TABLE official_documents ADD COLUMN IF NOT EXISTS parse_result jsonb` },
  /** Extractor version that produced the stored text (a new version re-extracts unchanged bytes). */
  { query: `ALTER TABLE official_documents ADD COLUMN IF NOT EXISTS extractor_version int` },
  { query: `CREATE INDEX IF NOT EXISTS official_documents_list ON official_documents (doc_date DESC NULLS LAST, id DESC)` },
  { query: `CREATE INDEX IF NOT EXISTS official_chunks_pages ON official_chunks (document_id, page_start)` },
];

const ready = new WeakSet<RemoteStore>();

/** Create the official-sources tables once per process (idempotent). */
export async function ensureOfficialSchema(store: RemoteStore): Promise<void> {
  if (ready.has(store)) return;
  const rows = await store.query({ query: `SELECT value FROM corpus_state WHERE key = 'official_schema_version'` }).catch(() => [] as Record<string, string | null>[]);
  const current = Number(rows[0]?.value ?? 0);
  if (!(current >= OFFICIAL_SCHEMA_VERSION)) {
    await store.query({ query: `CREATE TABLE IF NOT EXISTS corpus_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())` });
    for (const q of OFFICIAL_SCHEMA) await store.query(q);
    await store.query({
      query: `INSERT INTO corpus_state (key, value, updated_at) VALUES ('official_schema_version', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      params: [JSON.stringify(OFFICIAL_SCHEMA_VERSION)],
    });
  }
  ready.add(store);
}

export function resetOfficialSchemaCacheForTests(): void {
  // WeakSet cannot be cleared; tests use fresh store instances.
}
