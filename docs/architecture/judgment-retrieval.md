# Judgment retrieval (India research)

How the research engine finds, ranks, reads and cites Indian judgments, and the table contract every judgment-text
loader must meet so its text becomes searchable (keyword and semantic) without changes to the engine.

Code: `src/modules/india/corpus/{text,hybrid,embeddings,search}.ts`, `src/lib/india/{query-expansion,transition,citation-strings}.ts`,
`src/modules/search/engine/{planner,lanes,rerank,authority-status,deps,run}.ts`.

## Pipeline

```
question
→ retrieval query (stop words dropped) → Indian query expansion (old/new code sections both ways, Act names, citation forms)
→ per lane (binding / persuasive / adverse / statutes; fast mode: one lane + a light adverse lane)
   → for each query, in parallel:
        corpus_texts full text (best passage per judgment)  ┐ RRF (k = 60) = hybrid judgment text search
        corpus_text_embeddings ANN (when built, in scope)   ┘ (keyword-only + coverage note otherwise)
        corpus_judgments metadata index (exact ids first)
        local store, Indian Kanoon (when configured; skipped under bench / judge / disposal / section filters)
   → optional issue-level rerank of the top 20 judgment candidates (RESEARCH_RERANK=on; fast model; deterministic ties)
   → reads (full text only; metadata-only records are never "read")
→ synthesis (evidence blocks) → claim verification → citation cross-check → authority status table
```

## Table contract for judgment text (for every text loader, including the HC text pipeline)

Text lands in the existing `corpus_texts` table (created by `scripts/law-corpus/load_sc_judgment_text.py` and
`load_hc_judgment_text.py`). A loader must write rows with:

| column | required | meaning |
|---|---|---|
| `id` | yes, unique, stable | chunk id; re-loading the same chunk must reuse the id (embeddings are keyed by it) |
| `court_id` | yes for High Courts | registry court id (`sci`, `hc-karnataka`, …; never a guessed court) |
| `neutral_citation` | Supreme Court: yes | canonical `YYYY INSC N`; High Courts leave it NULL and use `cnr` + `decision_date` |
| `cnr`, `decision_date` | High Courts: yes | identity of one order/judgment (a CNR alone is not identity) |
| `chunk_index`, `total_chunks` | yes | order of chunks within the judgment, 0-based |
| `page_start`, `page_end` | where known | page of the court's PDF (pinpoints, `#p` links) |
| `text` | yes | the published text of the chunk, unchanged (no summaries, no headers added) |
| `title`, `case_number` | High Courts: should | shown when no `corpus_judgments` record links |
| `search` | generated | `to_tsvector('english', left(text, 60000))` (the column definition in the loaders) |

Linking to the judgment record is exact: Supreme Court by `upper(neutral_citation)`, High Courts by `cnr` and
`decision_date` against `corpus_judgments`. No fuzzy linking; unlinked text is still searchable but carries no record
metadata (and is excluded when a bench / judge / disposal / section filter is active).

After loading, set `corpus_judgments.text_status = 'full'` for judgments that now have text (as the existing loaders do):
the metadata lane uses it to decide whether a record is readable.

Nothing else is required for embeddings: the embedding worker discovers new text through `corpus_texts` and the queue.
A loader that replaces a chunk's text keeps its `id`; the old vector stops being served immediately (its `text_sha256`
no longer matches) and the next pass re-embeds the chunk.

## Embeddings (roadmap P3.1, P5.2, P5.3)

Schema (idempotent; created by `ensureJudgmentEmbedSchema` on first use, never by a migration runner):

```sql
CREATE TABLE IF NOT EXISTS corpus_text_embeddings (
  chunk_id text PRIMARY KEY,          -- corpus_texts.id
  text_key text NOT NULL,             -- '2024 INSC 735' or 'CNR@YYYY-MM-DD'
  court_id text NOT NULL,
  decision_year int,
  chunk_index int NOT NULL,
  text_sha256 text NOT NULL,          -- sha256 of the exact chunk text embedded
  embedding_model text NOT NULL,      -- model id recorded on every row
  embedding_dims int NOT NULL,        -- 1024
  embedding bytea NOT NULL,           -- float32 (fallback when pgvector is absent)
  embedded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corpus_text_embeddings_key ON corpus_text_embeddings (text_key);
CREATE INDEX IF NOT EXISTS corpus_text_embeddings_scope ON corpus_text_embeddings (embedding_model, court_id, decision_year);
CREATE TABLE IF NOT EXISTS corpus_embed_queue (
  text_key text PRIMARY KEY,
  court_id text NOT NULL,
  tier smallint NOT NULL,             -- 0 read on access, 1 SC, 2 priority HCs, 3 others
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  chunks int, embedded int NOT NULL DEFAULT 0, model text, error text,
  lease_until timestamptz, requested_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corpus_embed_queue_status CHECK (status IN ('pending', 'running', 'done', 'failed'))
);
CREATE INDEX IF NOT EXISTS corpus_embed_queue_claim ON corpus_embed_queue (status, tier, requested_at);
-- when the database offers pgvector (probed; halfvec preferred, vector(1024) fallback):
ALTER TABLE corpus_text_embeddings ADD COLUMN IF NOT EXISTS embedding_v halfvec(1024);
CREATE INDEX IF NOT EXISTS corpus_text_embeddings_v ON corpus_text_embeddings USING hnsw (embedding_v halfvec_cosine_ops);
```

Production migration note: the statements above are additive (`IF NOT EXISTS`) and do not touch `corpus_texts` or
`corpus_judgments`. The HNSW build on a large table is the only heavy step; on Neon run the `CREATE INDEX` once from a
session with a raised `maintenance_work_mem` before enabling `JUDGMENT_EMBED`, or create it `CONCURRENTLY` by hand (the
application's `IF NOT EXISTS` then finds it). Storage: about 2 KB (halfvec) + 4 KB (float32 bytea) per chunk.

Tiers and triggers:

- tier 0: a judgment read in a research run (`deps.read` of `corpus-text://…`) is queued at the head of the line;
- tier 1: Supreme Court; tier 2: `JUDGMENT_EMBED_PRIORITY_COURTS` (default `hc-karnataka hc-telangana hc-andhra`),
  newest first; tier 3: other High Courts only with `JUDGMENT_EMBED_ALL=1` (otherwise on first access only).
- Workers: `POST /api/india/corpus/embed` (operators; `GET` reports status) and the hourly tick when `JUDGMENT_EMBED=1`.
  Claims use a 6-minute lease; three failed attempts park a judgment as `failed` (re-queued on its next access).

Semantic matches: ANN top 100 within the cosine-distance cutoff `JUDGMENT_SEMANTIC_MAX_DISTANCE` (default 0.55), best
chunk per judgment, scoped by court and year; fused with the keyword list by RRF. When the model is not configured,
pgvector is missing, nothing in scope is embedded, or the query cannot be embedded, the search is keyword-only and the
lane note says so ("Retrieval coverage: …"); results are never labelled hybrid in that case.

## Filters

`SearchSettings`: `courts`, date range, `benchMin`, `judge`, `disposal`, `section`. Section filters use the citator
(`corpus_citations` statute keys, e.g. `BNSS 2023 s.482`) and include the old/new code counterpart; without the citator
the section is reported as not applied. The local store and Indian Kanoon cannot apply bench / judge / disposal / section
filters, so they are skipped (never searched unfiltered) while such a filter is set.

## Citation accuracy

- Every authority in an answer is listed in `message.authorities` (bound to the answer hash): `supported` (read, and a
  claim attributed to it was supported by its text for this hash), `read`, `found` (record exists, not read), 
  `text_not_available` (metadata-only: can be found, never supported) or `unresolved` (no corpus record carries the
  citation; never substituted with a near match).
- Citation strings are extracted by `extractAuthorityCitations` (neutral SC / HC, SCR, SCC incl. Supp, SCC OnLine, AIR,
  Cri LJ and the other coded reporters). "Cited by" counts come from mentions in judgment text (bounded: 25+).

## Transition law

`transitionNote` (`src/lib/india/transition.ts`) states, from coded data, that the offence date decides IPC/BNS (BNS
s.358 savings) and the proceeding's pending/instituted date decides CrPC/BNSS (BNSS s.531(2)(a)); "committed before 1
July 2024" fixes the side without an exact date; a missing date is stated as needed, never assumed.

## Evals

- `evals/india-research/cases/` — the five original engine cases (fictional fixtures), `tests/india-research-evals.test.ts`.
- `evals/india-research/benchmark/<category>.json` — the benchmark (116 questions: retrieval, adverse/overruled, no-answer,
  transition, citation formats, binding force; every fifth case is held out). Expected authorities are real judgments with
  `confidence` and `source`; `fixture` fields serve only the offline grader.
- Offline (CI): `npx vitest run tests/india-research-benchmark.test.ts` grades every case with the real engine code over a
  fixture index (expansion, RRF, binding classifier, claim checks, authority status, transition note) and prints
  recall@10 (with and without expansion), citation resolution rate, unsupported-claim rate, wrong-binding-force count and
  fabricated citations resolved (must be 0). It measures mechanics, not the production corpus.
- Live: `EVAL_DATABASE_URL=… npx tsx scripts/evals/india-research-live.ts [--split heldout] [--rerank] [--full] [--out r.json]`
  runs the lanes' case-law retrieval against a configured database and reports recall@10 (expansion vs base query, and
  after the reranker with `--rerank`), how many expected citations the judgment index carries, and binding-force errors;
  `--full` also runs the whole engine (model credentials required) and reads `message.authorities`. It refuses to run
  without `EVAL_DATABASE_URL`, with `NODE_ENV=production`, or when `EVAL_DATABASE_URL` equals `PRODUCTION_DATABASE_URL`.
  Never point it at production. Turn the reranker on by default (`RESEARCH_RERANK=on`) only when `--rerank` shows a
  recall@10 gain on the held-out split.
