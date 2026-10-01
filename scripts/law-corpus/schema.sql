-- Indian law corpus (Acts, rules and regulator instruments), Postgres (Neon).
--
-- Source: Open India Law (Vaquill), snapshot v2026.08.1, data licensed CC BY 4.0. That dataset is a section-level
-- parse of India Code (central, State and Union Territory legislation) and of regulator publications (SEBI, RBI, MCA,
-- CBIC, IRDAI, TRAI, ...). Every row keeps the publisher's own page (`source_url`) so a provision can always be checked
-- against the authoritative text. The parse is third-party: the application labels it as such and never presents it as
-- the official text.
--
-- Queried in place by the application (src/modules/india/law/**); loaded by scripts/law-corpus/load_open_india_law.py.
-- Idempotent: every statement can be re-run.

CREATE TABLE IF NOT EXISTS law_datasets (
  file text PRIMARY KEY,                -- e.g. in_central_legislation.parquet
  version text NOT NULL,                -- e.g. v2026.08.1
  sha256 text,                          -- from the snapshot's SHA256SUMS.json
  kind text NOT NULL,                   -- legislation | regulation
  jurisdiction text NOT NULL,           -- central | state | regulator
  label text NOT NULL,                  -- "Central", "Karnataka", "SEBI"
  rows_in_file int NOT NULL DEFAULT 0,
  rows_stored int NOT NULL DEFAULT 0,
  rows_skipped int NOT NULL DEFAULT 0,  -- exact duplicate chunks (same text as their base chunk)
  instruments int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending', -- pending | loading | done | error
  error text,
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS law_instruments (
  id text PRIMARY KEY,                  -- dataset act_id, e.g. IND_central_20062
  kind text NOT NULL,                   -- act | regulation
  title text NOT NULL,
  jurisdiction text NOT NULL,           -- central | state | regulator
  state text,                           -- State / UT name for state legislation
  state_code text,                      -- two-letter code where known (KA, TS, AP, MH, DL, ...)
  regulator text,                       -- sebi, rbi, mca, ... for regulator instruments
  publisher text,                       -- issuing body as named by the dataset
  year int,
  status text,                          -- in_force | repealed | spent | superseded | ...
  amendment_count int,
  source_url text,                      -- publisher's own page (India Code handle, sebi.gov.in, ...)
  mirror_url text,                      -- dataset mirror copy of the PDF
  provisions int NOT NULL DEFAULT 0,
  sections int NOT NULL DEFAULT 0,
  chars bigint NOT NULL DEFAULT 0,
  subjects text[],
  dataset_file text NOT NULL,
  dataset_version text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(state, '') || ' ' || coalesce(regulator, '') || ' ' || coalesce(publisher, '')), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS law_instruments_search ON law_instruments USING gin (search);
CREATE INDEX IF NOT EXISTS law_instruments_juris ON law_instruments (jurisdiction, state_code, regulator, year DESC);
CREATE INDEX IF NOT EXISTS law_instruments_title_lower ON law_instruments (lower(title));

CREATE TABLE IF NOT EXISTS law_provisions (
  id text PRIMARY KEY,                  -- dataset chunk_id, e.g. IND_central_20062_s303_p1
  act_id text NOT NULL REFERENCES law_instruments(id) ON DELETE CASCADE,
  ord int NOT NULL,                     -- position within the instrument (statutory order, then variant, then part)
  section_number text,                  -- as printed: "303", "10A", "" for preamble/schedule text
  variant int NOT NULL DEFAULT 0,       -- dataset duplicate-section marker (_d1, _d2): a second provision with the same number
  part int NOT NULL DEFAULT 0,          -- chunk index within one section (_p0, _p1 ...)
  heading text,                         -- section heading parsed from the dataset's chunk header
  chapter text,                         -- chapter number (roman), as given
  chapter_title text,
  section_type text,                    -- section | sub_section | definitions | preamble | schedule | ...
  provision_type text,
  status text,
  in_force boolean,
  has_proviso boolean,
  has_non_obstante boolean,
  defined_terms text[],
  acts_referenced text[],
  text text NOT NULL,                   -- provision text without the dataset's synthetic header line
  source_url text,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
    setweight(to_tsvector('english', left(coalesce(text, ''), 60000)), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS law_provisions_act_ord ON law_provisions (act_id, ord);
CREATE INDEX IF NOT EXISTS law_provisions_act_section ON law_provisions (act_id, lower(section_number));
CREATE INDEX IF NOT EXISTS law_provisions_search ON law_provisions USING gin (search);
