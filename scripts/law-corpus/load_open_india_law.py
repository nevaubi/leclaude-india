#!/usr/bin/env python3
"""
Load the Open India Law legislation and regulator files into Postgres (law_instruments, law_provisions).

Source: https://oss-data-in.vaquill.ai/<version>/ (mirror of huggingface.co/datasets/vaquill/open-india-law).
Data licence: CC BY 4.0 (attribution: Open India Law by Vaquill; underlying texts from India Code and the regulators).

Usage (needs DATABASE_URL; pip install duckdb "psycopg[binary]"):
    python3 scripts/law-corpus/load_open_india_law.py                 # every legislation and regulator file
    python3 scripts/law-corpus/load_open_india_law.py central karnataka sebi
    LAW_MAX_DB_MB=8000 python3 scripts/law-corpus/load_open_india_law.py

Each file is replaced as a unit in one transaction (its instruments are deleted and reloaded), so a re-run is safe.
Before each file the database size is compared with LAW_MAX_DB_MB (default 9000); the loader stops there.

Rules:
- Rows are stored as published (one row per dataset chunk). Nothing is merged, re-numbered or rewritten, except that
  the dataset's synthetic header line ("Act: ... | Section N: heading") is removed from the text and parsed into
  `heading`, `chapter_title`.
- A duplicate-marked chunk (`_d1`, `_d2`) whose text is identical to its base chunk is skipped and counted.
- Every row keeps `source_url` (the publisher's page). Rows without one stay without one; none is invented.
"""
import json, os, re, sys, time, urllib.request
from collections import Counter, defaultdict

import duckdb
import psycopg

VERSION = os.environ.get("LAW_DATASET_VERSION", "v2026.08.1")
BASE = f"https://oss-data-in.vaquill.ai/{VERSION}/"
MAX_DB_MB = int(os.environ.get("LAW_MAX_DB_MB", "9000"))
HERE = os.path.dirname(os.path.abspath(__file__))

LEGISLATION = [
    "andaman-nicobar", "andhra-pradesh", "arunachal-pradesh", "assam", "bihar", "central", "chandigarh", "chhattisgarh",
    "dadra-nagar-haveli", "delhi", "goa", "gujarat", "haryana", "himachal-pradesh", "jammu-kashmir", "jharkhand",
    "karnataka", "kerala", "ladakh", "lakshadweep", "madhya-pradesh", "maharashtra", "manipur", "meghalaya", "mizoram",
    "nagaland", "odisha", "puducherry", "punjab", "rajasthan", "sikkim", "tamil-nadu", "telangana", "tripura",
    "uttar-pradesh", "uttarakhand", "west-bengal",
]
REGULATORS = ["cbic", "cpcb", "dfs", "dgft", "irdai", "law-commission", "mca", "moefcc", "rbi", "sebi", "state-gst", "trai"]

# Display names and two-letter codes (vehicle-registration style, as used by src/lib/india/courts.ts StateCode).
STATES = {
    "andaman-nicobar": ("Andaman and Nicobar Islands", "AN"), "andhra-pradesh": ("Andhra Pradesh", "AP"),
    "arunachal-pradesh": ("Arunachal Pradesh", "AR"), "assam": ("Assam", "AS"), "bihar": ("Bihar", "BR"),
    "chandigarh": ("Chandigarh", "CH"), "chhattisgarh": ("Chhattisgarh", "CG"),
    "dadra-nagar-haveli": ("Dadra and Nagar Haveli", "DN"), "delhi": ("Delhi", "DL"), "goa": ("Goa", "GA"),
    "gujarat": ("Gujarat", "GJ"), "haryana": ("Haryana", "HR"), "himachal-pradesh": ("Himachal Pradesh", "HP"),
    "jammu-kashmir": ("Jammu and Kashmir", "JK"), "jharkhand": ("Jharkhand", "JH"), "karnataka": ("Karnataka", "KA"),
    "kerala": ("Kerala", "KL"), "ladakh": ("Ladakh", "LA"), "lakshadweep": ("Lakshadweep", "LD"),
    "madhya-pradesh": ("Madhya Pradesh", "MP"), "maharashtra": ("Maharashtra", "MH"), "manipur": ("Manipur", "MN"),
    "meghalaya": ("Meghalaya", "ML"), "mizoram": ("Mizoram", "MZ"), "nagaland": ("Nagaland", "NL"),
    "odisha": ("Odisha", "OD"), "puducherry": ("Puducherry", "PY"), "punjab": ("Punjab", "PB"),
    "rajasthan": ("Rajasthan", "RJ"), "sikkim": ("Sikkim", "SK"), "tamil-nadu": ("Tamil Nadu", "TN"),
    "telangana": ("Telangana", "TS"), "tripura": ("Tripura", "TR"), "uttar-pradesh": ("Uttar Pradesh", "UP"),
    "uttarakhand": ("Uttarakhand", "UK"), "west-bengal": ("West Bengal", "WB"),
}
REGULATOR_NAMES = {
    "cbic": "CBIC", "cpcb": "CPCB", "dfs": "DFS", "dgft": "DGFT", "irdai": "IRDAI", "law-commission": "Law Commission",
    "mca": "MCA", "moefcc": "MoEFCC", "rbi": "RBI", "sebi": "SEBI", "state-gst": "State GST", "trai": "TRAI",
}

HEADER_ACT = re.compile(r"^Act:.*$")
HEADER_SECTION = re.compile(r"^(?:Chapter\s+(?P<chap>[^:|]*):\s*(?:#+\s*)?(?P<chapt>[^|]*?)\s*\|\s*)?Section\s+(?P<num>[^:]*):\s*(?P<head>.*)$")
CHUNK_TAIL = re.compile(r"^s(?P<sec>[^_]*)(?:_p(?P<part>\d+))?(?:_d(?P<var>\d+))?$")
NUM = re.compile(r"^(\d+)(.*)$")


def strip_header(text):
    """Remove the dataset's synthetic header; return (body, heading, chapter_title)."""
    lines = text.split("\n")
    heading = chapter_title = None
    i = 0
    if i < len(lines) and HEADER_ACT.match(lines[i]):
        i += 1
        if i < len(lines):
            m = HEADER_SECTION.match(lines[i].strip())
            if m:
                heading = (m.group("head") or "").strip() or None
                chapter_title = (m.group("chapt") or "").strip() or None
                i += 1
        while i < len(lines) and not lines[i].strip():
            i += 1
        return "\n".join(lines[i:]).strip(), heading, chapter_title
    return text.strip(), None, None


def sort_key(section_number, tail, variant, part):
    s = (section_number or "").strip()
    m = NUM.match(s)
    if m:
        return (1, int(m.group(1)), m.group(2).lower(), variant, part, tail)
    if not s:
        return (0, 0, "", variant, part, tail)
    return (2, 0, s.lower(), variant, part, tail)


def parse_tail(chunk_id, act_id):
    tail = chunk_id[len(act_id) + 1:] if chunk_id.startswith(act_id + "_") else chunk_id
    m = CHUNK_TAIL.match(tail)
    if not m:
        return tail, 0, 0
    return tail, int(m.group("var") or 0), int(m.group("part") or 0)


def db_mb(conn):
    with conn.cursor() as cur:
        cur.execute("select pg_database_size(current_database())")
        return cur.fetchone()[0] / 1024 / 1024


def checksums():
    try:
        req = urllib.request.Request(BASE + "SHA256SUMS.json", headers={"User-Agent": "leclaude-law-loader/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
        if isinstance(data, dict):
            return {k.split("/")[-1]: (v if isinstance(v, str) else v.get("sha256")) for k, v in data.items()}
    except Exception as e:  # noqa: BLE001 - checksums are informative; the load does not depend on them
        print("checksums unavailable:", e)
    return {}


def load_file(conn, duck, name, sums):
    if name in REGULATORS:
        file, kind, juris = f"in_{name}_regulations.parquet", "regulation", "regulator"
        label = REGULATOR_NAMES[name]
    else:
        file, kind, juris = f"in_{name}_legislation.parquet", "act", "central" if name == "central" else "state"
        label = "Central" if name == "central" else STATES[name][0]
    state, state_code = (STATES[name] if juris == "state" else (None, None))
    regulator = name if juris == "regulator" else None

    t0 = time.time()
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO law_datasets (file, version, sha256, kind, jurisdiction, label, status, started_at)
               VALUES (%s,%s,%s,%s,%s,%s,'loading',now())
               ON CONFLICT (file) DO UPDATE SET version=excluded.version, sha256=excluded.sha256, status='loading',
                 error=null, started_at=now(), finished_at=null""",
            (file, VERSION, sums.get(file), kind, juris, label))
    conn.commit()

    cols = ["act_id", "chunk_id", "title", "chapter", "section_number", "text", "act_status", "in_force", "section_type",
            "provision_type", "legal_subject", "has_proviso", "has_non_obstante", "defined_terms", "acts_referenced",
            "amendment_count", "year", "source_url", "source_publisher", "mirror_url"]
    rows = duck.execute(f"SELECT {', '.join(cols)} FROM read_parquet('{BASE}{file}')").fetchall()
    total = len(rows)
    by_chunk = {r[1]: r for r in rows}

    acts = defaultdict(list)
    skipped = 0
    for r in rows:
        act_id, chunk_id = r[0], r[1]
        tail, variant, part = parse_tail(chunk_id, act_id)
        if variant:
            base_id = re.sub(r"_d\d+$", "", chunk_id)
            base = by_chunk.get(base_id)
            if base is not None and base[5] == r[5]:
                skipped += 1
                continue
        acts[act_id].append((r, tail, variant, part))

    inst_rows, prov_rows = [], []
    for act_id, items in acts.items():
        items.sort(key=lambda it: sort_key(it[0][4], it[1], it[2], it[3]))
        first = items[0][0]
        statuses = Counter((it[0][6] or "") for it in items)
        urls = Counter((it[0][17] or "") for it in items if it[0][17])
        pubs = Counter((it[0][18] or "") for it in items if it[0][18])
        mirrors = Counter((it[0][19] or "") for it in items if it[0][19])
        subjects = Counter()
        for it in items:
            ls = it[0][10]
            if isinstance(ls, str):
                for s in re.findall(r"[A-Za-z_][A-Za-z_ ]*", ls):
                    subjects[s.strip()] += 1
            elif isinstance(ls, (list, tuple)):
                for s in ls:
                    subjects[str(s)] += 1
        chars = 0
        sections = set()
        for ord_, (r, tail, variant, part) in enumerate(items):
            body, heading, chapter_title = strip_header(r[5] or "")
            if not body:
                continue
            chars += len(body)
            sections.add(((r[4] or "").strip(), variant))
            prov_rows.append((
                r[1], act_id, ord_, (r[4] or "").strip() or None, variant, part, heading, (r[3] or "").strip() or None,
                chapter_title, r[8], r[9], r[6], r[7], r[11], r[12],
                list(r[13]) if r[13] is not None else None, list(r[14]) if r[14] is not None else None,
                body, r[17] or None,
            ))
        year = int(first[16]) if first[16] is not None else None
        inst_rows.append((
            act_id, kind, (first[2] or act_id).strip(), juris, state, state_code, regulator,
            pubs.most_common(1)[0][0] if pubs else None, year, statuses.most_common(1)[0][0] or None,
            int(first[15]) if first[15] is not None else None,
            urls.most_common(1)[0][0] if urls else None, mirrors.most_common(1)[0][0] if mirrors else None,
            len(items), len(sections), chars, [s for s, _ in subjects.most_common(6) if s and s != "general"] or None,
            file, VERSION,
        ))

    with conn.cursor() as cur:
        cur.execute("DELETE FROM law_instruments WHERE dataset_file = %s", (file,))
        with cur.copy("""COPY law_instruments (id, kind, title, jurisdiction, state, state_code, regulator, publisher, year,
                status, amendment_count, source_url, mirror_url, provisions, sections, chars, subjects, dataset_file,
                dataset_version) FROM STDIN""") as cp:
            for row in inst_rows:
                cp.write_row(row)
        with cur.copy("""COPY law_provisions (id, act_id, ord, section_number, variant, part, heading, chapter, chapter_title,
                section_type, provision_type, status, in_force, has_proviso, has_non_obstante, defined_terms,
                acts_referenced, text, source_url) FROM STDIN""") as cp:
            for row in prov_rows:
                cp.write_row(row)
        cur.execute(
            """UPDATE law_datasets SET rows_in_file=%s, rows_stored=%s, rows_skipped=%s, instruments=%s, status='done',
                 finished_at=now() WHERE file=%s""",
            (total, len(prov_rows), skipped, len(inst_rows), file))
    conn.commit()
    print(f"{file}: {total} rows, {len(prov_rows)} stored, {skipped} duplicate chunks skipped, "
          f"{len(inst_rows)} instruments, {time.time() - t0:.1f}s", flush=True)


def main():
    names = sys.argv[1:] or (LEGISLATION + REGULATORS)
    unknown = [n for n in names if n not in LEGISLATION and n not in REGULATORS]
    if unknown:
        sys.exit(f"unknown dataset names: {unknown}")
    url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if not url:
        sys.exit("DATABASE_URL is not set")
    duck = duckdb.connect()
    duck.execute("INSTALL httpfs; LOAD httpfs;")
    sums = checksums()
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(open(os.path.join(HERE, "schema.sql")).read())
        conn.commit()
        for name in names:
            size = db_mb(conn)
            if size >= MAX_DB_MB:
                print(f"stop: database is {size:.0f} MB (limit LAW_MAX_DB_MB={MAX_DB_MB})")
                break
            try:
                load_file(conn, duck, name, sums)
            except Exception as e:  # noqa: BLE001 - record the failure on the dataset row and continue
                conn.rollback()
                with conn.cursor() as cur:
                    cur.execute("UPDATE law_datasets SET status='error', error=%s, finished_at=now() WHERE file LIKE %s",
                                (str(e)[:2000], f"in_{name}_%"))
                conn.commit()
                print(f"{name}: ERROR {e}", flush=True)
        print(f"database size: {db_mb(conn):.0f} MB")


if __name__ == "__main__":
    main()
