#!/usr/bin/env python3
"""
Load the English text of Supreme Court of India judgments (Open India Law, in_supreme-court_judgments.parquet) into
Postgres table corpus_texts, linked to corpus_judgments by neutral citation.

Source: https://oss-data-in.vaquill.ai/<version>/in_supreme-court_judgments.parquet (CC BY 4.0). The dataset's text is
extracted from the Supreme Court's own PDFs (AWS Open Data, indian-supreme-court-judgments); rows are chunks with
page numbers. Only English rows (language_code = 'en') are loaded; the dataset's court-published translations are
not loaded here.

Usage (needs DATABASE_URL; pip install duckdb "psycopg[binary]"):
    python3 scripts/law-corpus/load_sc_judgment_text.py
    TEXT_MAX_DB_MB=9000 python3 scripts/law-corpus/load_sc_judgment_text.py

Idempotent: rows are upserted by chunk id. The database size is checked between batches against TEXT_MAX_DB_MB.
After the load, corpus_judgments.text_status is set to 'full' for judgments whose neutral citation has text, and
'none' for the others it previously marked (so the flag always reflects corpus_texts).

Rules: the chunk text is `text_original` (the text as parsed, without the dataset's synthetic "Case: ... / Section: X"
header) when the parquet carries that column and the value is non-empty; otherwise the header is removed from `text`
(older snapshots). The text is otherwise stored as published. A chunk is linked to a judgment only by exact neutral
citation; there is no fuzzy linking.
"""
import os, re, sys, time

# duckdb and psycopg are imported in main() so the pure helpers can be checked without them.

VERSION = os.environ.get("LAW_DATASET_VERSION", "v2026.08.1")
URL = f"https://oss-data-in.vaquill.ai/{VERSION}/in_supreme-court_judgments.parquet"
MAX_DB_MB = int(os.environ.get("TEXT_MAX_DB_MB", "9000"))
BATCH = 5000

DDL = """
CREATE TABLE IF NOT EXISTS corpus_texts (
  id text PRIMARY KEY,                 -- dataset chunk id, e.g. 2024_INSC_735_002
  case_key text NOT NULL,              -- dataset case id, e.g. 2024_INSC_735
  neutral_citation text NOT NULL,      -- 2024 INSC 735 (upper case, single spaces)
  chunk_index int NOT NULL,
  total_chunks int,
  page_start int,
  page_end int,
  section_type text,                   -- paragraph | conclusion | body | ... as labelled by the dataset
  text text NOT NULL,
  dataset_version text NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 60000))) STORED
);
CREATE INDEX IF NOT EXISTS corpus_texts_case ON corpus_texts (neutral_citation, chunk_index);
CREATE INDEX IF NOT EXISTS corpus_texts_search ON corpus_texts USING gin (search);
CREATE INDEX IF NOT EXISTS corpus_judgments_neutral_upper ON corpus_judgments (upper(neutral_citation));
"""

HEADER = re.compile(r"^Case:.*\n(?:Section:.*\n)?\s*", re.M)


def strip_header(text):
    if text.startswith("Case:"):
        m = HEADER.match(text)
        if m:
            return text[m.end():].strip()
    return text.strip()


def chunk_body(text, text_original=None):
    """The chunk's text as published: text_original when present and non-empty, else `text` without the header."""
    if isinstance(text_original, str) and text_original.strip():
        return text_original.strip()
    return strip_header(text or "")


def parquet_columns(duck, url):
    """Column names of a parquet file (DESCRIBE reads only the footer)."""
    return {row[0] for row in duck.execute(f"DESCRIBE SELECT * FROM read_parquet('{url}')").fetchall()}


def neutral(case_id):
    m = re.match(r"^(\d{4})_INSC_(\d+)$", case_id or "")
    return f"{m.group(1)} INSC {int(m.group(2))}" if m else None


def db_mb(conn):
    with conn.cursor() as cur:
        cur.execute("select pg_database_size(current_database())")
        return cur.fetchone()[0] / 1024 / 1024


def main():
    url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if not url:
        sys.exit("DATABASE_URL is not set")
    import duckdb
    import psycopg
    duck = duckdb.connect()
    duck.execute("INSTALL httpfs; LOAD httpfs;")
    t0 = time.time()
    stored = skipped = 0
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(DDL)
        conn.commit()
        original = "text_original" if "text_original" in parquet_columns(duck, URL) else "NULL::VARCHAR"
        print(f"text column: {'text_original (header-free)' if original == 'text_original' else 'text (header stripped)'}", flush=True)
        res = duck.execute(
            f"""SELECT chunk_id, case_id, chunk_index, total_chunks, page_start, page_end, section_type, text,
                       {original} AS text_original
                FROM read_parquet('{URL}') WHERE language_code = 'en'""")
        stop = False
        while not stop:
            rows = res.fetchmany(BATCH)
            if not rows:
                break
            out = []
            for chunk_id, case_id, idx, total, p0, p1, stype, text, text_original in rows:
                n = neutral(case_id)
                body = chunk_body(text, text_original)
                if not n or not body:
                    skipped += 1
                    continue
                out.append((chunk_id, case_id, n, idx, total, p0, p1, stype, body, VERSION))
            with conn.cursor() as cur:
                cur.execute("CREATE TEMP TABLE IF NOT EXISTS ct_stage (LIKE corpus_texts INCLUDING DEFAULTS) ON COMMIT DELETE ROWS")
                with cur.copy("""COPY ct_stage (id, case_key, neutral_citation, chunk_index, total_chunks, page_start,
                        page_end, section_type, text, dataset_version) FROM STDIN""") as cp:
                    for r in out:
                        cp.write_row(r)
                cur.execute("""INSERT INTO corpus_texts (id, case_key, neutral_citation, chunk_index, total_chunks,
                        page_start, page_end, section_type, text, dataset_version)
                        SELECT id, case_key, neutral_citation, chunk_index, total_chunks, page_start, page_end,
                               section_type, text, dataset_version FROM ct_stage
                        ON CONFLICT (id) DO UPDATE SET text = excluded.text, page_start = excluded.page_start,
                          page_end = excluded.page_end, section_type = excluded.section_type,
                          total_chunks = excluded.total_chunks, dataset_version = excluded.dataset_version""")
            conn.commit()
            stored += len(out)
            if stored % 50000 < BATCH:
                size = db_mb(conn)
                print(f"{stored} chunks stored, {skipped} skipped, db {size:.0f} MB, {time.time() - t0:.0f}s", flush=True)
                if size >= MAX_DB_MB:
                    print(f"stop: database is {size:.0f} MB (limit TEXT_MAX_DB_MB={MAX_DB_MB})")
                    stop = True
        with conn.cursor() as cur:
            cur.execute("""UPDATE corpus_judgments j SET text_status = 'full'
                WHERE j.court_id = 'sci' AND j.text_status IS DISTINCT FROM 'full'
                  AND EXISTS (SELECT 1 FROM corpus_texts t WHERE t.neutral_citation = upper(j.neutral_citation))""")
            print("judgments marked full:", cur.rowcount)
            cur.execute("""SELECT count(DISTINCT t.neutral_citation),
                  count(DISTINCT t.neutral_citation) FILTER (WHERE NOT EXISTS (
                    SELECT 1 FROM corpus_judgments j WHERE upper(j.neutral_citation) = t.neutral_citation))
                FROM corpus_texts t""")
            total, unlinked = cur.fetchone()
            print(f"judgments with text: {total}; without a matching corpus record: {unlinked}")
        conn.commit()
        print(f"done: {stored} chunks, {skipped} skipped, db {db_mb(conn):.0f} MB, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
