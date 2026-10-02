import "server-only";
import type { RemoteStore, SqlQuery } from "@/lib/db/remote";
import { ensureCorpusSchema, getState, setState } from "../corpus/backfill";

/**
 * Citator tables in the corpus Postgres (next to corpus_judgments / corpus_texts).
 *
 * - `corpus_citations`: one row per distinct authority a judgment's text cites. Case citations carry the exact-match
 *   resolution against corpus_judgments (resolved: one judgment carries the citation; ambiguous: several do, none
 *   chosen; unresolved: none does), the sentence around the citation and an optional deterministic text cue
 *   (`signal` + the verbatim `cue`), which is never a verified treatment. Statute rows carry the Act and section.
 *   The citing judgment's court and year are denormalised for section statistics.
 * - `corpus_citator_scans`: one row per judgment whose text was scanned (also when it cites nothing), so "not built"
 *   and coverage are explicit.
 * - Progress (cursor of the current pass) lives in corpus_state under `citator_cursor`.
 */
export const CITATOR_SCHEMA_VERSION = 1;

/** SQL for the compact key of a citation column (must match `compactKey` in extract.ts). */
export const compactSql = (col: string) => `upper(regexp_replace(${col}, '[^A-Za-z0-9]', '', 'g'))`;

export const CITATOR_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS corpus_citations (
      citing_id text NOT NULL,
      seq int NOT NULL,
      kind text NOT NULL,
      raw text NOT NULL,
      key text NOT NULL,
      cited_id text,
      resolution text NOT NULL,
      candidates int NOT NULL DEFAULT 0,
      act_id text,
      section text,
      chunk_index int,
      page int,
      context text,
      signal text,
      cue text,
      occurrences int NOT NULL DEFAULT 1,
      citing_court text,
      citing_year int,
      extractor_version int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (citing_id, seq),
      CONSTRAINT corpus_citations_kind CHECK (kind IN ('case', 'statute')),
      CONSTRAINT corpus_citations_resolution CHECK (resolution IN ('resolved', 'unresolved', 'ambiguous'))
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS corpus_citations_cited ON corpus_citations (cited_id) WHERE cited_id IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_citations_key ON corpus_citations (key)` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_citations_sections ON corpus_citations (act_id, section, citing_year) WHERE kind = 'statute' AND act_id IS NOT NULL` },
  {
    query: `CREATE TABLE IF NOT EXISTS corpus_citator_scans (
      citing_id text PRIMARY KEY,
      extractor_version int NOT NULL,
      citations int NOT NULL,
      text_chars int NOT NULL,
      truncated boolean NOT NULL DEFAULT false,
      scanned_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  // Exact-match resolution looks citations up by their compact form (letters and digits); the result is confirmed by
  // the citation parser in application code, so these indexes only narrow the candidates.
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_neutral_compact ON corpus_judgments (${compactSql("neutral_citation")}) WHERE neutral_citation IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_reporter_compact ON corpus_judgments (${compactSql("reporter_citation")}) WHERE reporter_citation IS NOT NULL` },
];

let ready = false;

/** Create the citator tables once per process (idempotent; versioned in corpus_state). */
export async function ensureCitatorSchema(store: RemoteStore): Promise<void> {
  if (ready) return;
  await ensureCorpusSchema(store);
  const v = await getState<number>(store, "citator_schema_version");
  if (!v || Number(v) < CITATOR_SCHEMA_VERSION) {
    for (const q of CITATOR_SCHEMA) await store.query(q);
    await setState(store, "citator_schema_version", CITATOR_SCHEMA_VERSION);
  }
  ready = true;
}

export function resetCitatorSchemaCacheForTests() { ready = false; }
