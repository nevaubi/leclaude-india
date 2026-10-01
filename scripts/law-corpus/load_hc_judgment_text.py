#!/usr/bin/env python3
"""
Load the English text of High Court judgments (Open India Law, in_<court>_judgments.parquet) into corpus_texts, linked
to corpus_judgments by CNR and decision date.

Source: https://oss-data-in.vaquill.ai/<version>/in_<court>_judgments.parquet (CC BY 4.0); text extracted from the
judgments published on the eCourts judgments portal (AWS Open Data, indian-high-court-judgments).

Usage (needs DATABASE_URL; pip install duckdb "psycopg[binary]"):
    python3 scripts/law-corpus/load_hc_judgment_text.py karnataka [telangana andhra-pradesh ...]
    TEXT_MAX_DB_MB=20000 python3 scripts/law-corpus/load_hc_judgment_text.py karnataka

Rules:
- Only English rows. The dataset's synthetic header ("Case: ... / Section: X") is removed; text is otherwise as published.
- Rows are keyed by the dataset chunk id (idempotent upserts).
- A judgment record is marked text_status = 'full' only when its CNR and decision date both match the text's; a CNR
  with several orders is never given another order's text.
"""
import os, re, sys, time

import duckdb
import psycopg

VERSION = os.environ.get("LAW_DATASET_VERSION", "v2026.08.1")
MAX_DB_MB = int(os.environ.get("TEXT_MAX_DB_MB", "20000"))
BATCH = 5000

# dataset file name -> registry court id (src/lib/india/courts.ts)
COURTS = {
    "karnataka": "hc-karnataka", "telangana": "hc-telangana", "andhra-pradesh": "hc-andhra", "bombay": "hc-bombay",
    "madras": "hc-madras", "delhi": "hc-delhi", "kerala": "hc-kerala", "calcutta": "hc-calcutta", "gujarat": "hc-gujarat",
    "allahabad": "hc-allahabad", "punjab-and-haryana": "hc-ph", "rajasthan": "hc-rajasthan",
    "madhya-pradesh": "hc-mp", "patna": "hc-patna", "orissa": "hc-orissa", "gauhati": "hc-gauhati",
    "jharkhand": "hc-jharkhand", "chhattisgarh": "hc-chhattisgarh", "uttarakhand": "hc-uttarakhand",
    "himachal-pradesh": "hc-hp", "jammu-and-kashmir": "hc-jk", "tripura": "hc-tripura",
    "manipur": "hc-manipur", "meghalaya": "hc-meghalaya", "sikkim": "hc-sikkim",
}

MIGRATE = """
CREATE TABLE IF NOT EXISTS corpus_texts (
  id text PRIMARY KEY, case_key text NOT NULL, neutral_citation text, chunk_index int NOT NULL, total_chunks int,
  page_start int, page_end int, section_type text, text text NOT NULL, dataset_version text NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 60000))) STORED
);
ALTER TABLE corpus_texts ALTER COLUMN neutral_citation DROP NOT NULL;
ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS court_id text;
ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS cnr text;
ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS decision_date date;
ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE corpus_texts ADD COLUMN IF NOT EXISTS case_number text;
CREATE INDEX IF NOT EXISTS corpus_texts_cnr ON corpus_texts (cnr, decision_date, chunk_index) WHERE cnr IS NOT NULL;
CREATE INDEX IF NOT EXISTS corpus_texts_court ON corpus_texts (court_id);
-- Coverage counts (one row per judgment): src/modules/india/corpus/coverage.ts
CREATE INDEX IF NOT EXISTS corpus_texts_first_chunk ON corpus_texts (court_id) WHERE chunk_index = 0;
CREATE INDEX IF NOT EXISTS corpus_judgments_cnr_date ON corpus_judgments (cnr, decision_date);
UPDATE corpus_texts SET court_id = 'sci' WHERE court_id IS NULL AND neutral_citation IS NOT NULL;
"""

HEADER = re.compile(r"^Case:.*\n(?:Section:.*\n)?\s*", re.M)
CNR = re.compile(r"^[A-Z]{4}\d{12}$")


def strip_header(text):
    if text.startswith("Case:"):
        m = HEADER.match(text)
        if m:
            return text[m.end():].strip()
    return text.strip()


def db_mb(conn):
    with conn.cursor() as cur:
        cur.execute("select pg_database_size(current_database())")
        return cur.fetchone()[0] / 1024 / 1024


def load(conn, duck, name):
    court_id = COURTS[name]
    url = f"https://oss-data-in.vaquill.ai/{VERSION}/in_{name}_judgments.parquet"
    t0 = time.time()
    stored = skipped = 0
    res = duck.execute(
        f"""SELECT chunk_id, case_id, chunk_index, total_chunks, page_start, page_end, section_type, text,
                   try_cast(substr(decision_date, 1, 10) AS DATE) AS d, title, case_number
            FROM read_parquet('{url}') WHERE language_code = 'en'""")
    while True:
        rows = res.fetchmany(BATCH)
        if not rows:
            break
        out = []
        for chunk_id, case_id, idx, total, p0, p1, stype, text, d, title, case_number in rows:
            cnr = (case_id or "").strip().upper()
            body = strip_header(text or "")
            if not CNR.match(cnr) or not body or d is None:
                skipped += 1
                continue
            out.append((chunk_id, case_id, None, idx, total, p0, p1, stype, body, VERSION, court_id, cnr, d, (title or None), (case_number or None)))
        with conn.cursor() as cur:
            cur.execute("CREATE TEMP TABLE IF NOT EXISTS hct_stage (LIKE corpus_texts INCLUDING DEFAULTS) ON COMMIT DELETE ROWS")
            with cur.copy("""COPY hct_stage (id, case_key, neutral_citation, chunk_index, total_chunks, page_start, page_end,
                    section_type, text, dataset_version, court_id, cnr, decision_date, title, case_number) FROM STDIN""") as cp:
                for r in out:
                    cp.write_row(r)
            cur.execute("""INSERT INTO corpus_texts (id, case_key, neutral_citation, chunk_index, total_chunks, page_start,
                    page_end, section_type, text, dataset_version, court_id, cnr, decision_date, title, case_number)
                    SELECT id, case_key, neutral_citation, chunk_index, total_chunks, page_start, page_end, section_type,
                           text, dataset_version, court_id, cnr, decision_date, title, case_number FROM hct_stage
                    ON CONFLICT (id) DO UPDATE SET text = excluded.text, page_start = excluded.page_start,
                      page_end = excluded.page_end, section_type = excluded.section_type, total_chunks = excluded.total_chunks,
                      court_id = excluded.court_id, cnr = excluded.cnr, decision_date = excluded.decision_date,
                      title = excluded.title, case_number = excluded.case_number, dataset_version = excluded.dataset_version""")
        conn.commit()
        stored += len(out)
        if stored % 100000 < BATCH:
            size = db_mb(conn)
            print(f"{name}: {stored} chunks stored, {skipped} skipped, db {size:.0f} MB, {time.time() - t0:.0f}s", flush=True)
            if size >= MAX_DB_MB:
                print(f"stop: database is {size:.0f} MB (limit TEXT_MAX_DB_MB={MAX_DB_MB})", flush=True)
                return False
    print(f"{name}: done, {stored} chunks, {skipped} skipped, {time.time() - t0:.0f}s", flush=True)
    return True


def mark(conn):
    with conn.cursor() as cur:
        cur.execute("""UPDATE corpus_judgments j SET text_status = 'full'
            WHERE j.court_id LIKE 'hc-%' AND j.text_status IS DISTINCT FROM 'full' AND j.cnr IS NOT NULL
              AND EXISTS (SELECT 1 FROM corpus_texts t WHERE t.cnr = j.cnr AND t.decision_date = j.decision_date)""")
        print("high court records marked full:", cur.rowcount, flush=True)
    conn.commit()


def main():
    names = sys.argv[1:]
    unknown = [n for n in names if n not in COURTS]
    if not names or unknown:
        sys.exit(f"usage: load_hc_judgment_text.py <court> ...; unknown: {unknown}; known: {sorted(COURTS)}")
    url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if not url:
        sys.exit("DATABASE_URL is not set")
    duck = duckdb.connect()
    duck.execute("INSTALL httpfs; LOAD httpfs;")
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(MIGRATE)
        conn.commit()
        for name in names:
            if not load(conn, duck, name):
                break
        mark(conn)
        print(f"database size: {db_mb(conn):.0f} MB")


if __name__ == "__main__":
    main()
