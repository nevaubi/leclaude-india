import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { RemoteStore, Row, SqlQuery, SqlValue } from "@/lib/db/remote";

/**
 * Opt-in integration test: the corpus backfill against real open-data archives (network) and a real Postgres
 * (CORPUS_TEST_PG="host:port", reached with psql). Skipped unless CORPUS_TEST_PG is set.
 *
 *   CORPUS_TEST_PG=/tmp/pg:55432 npx vitest run tests/india-corpus-pg.test.ts
 */
const PG = process.env.CORPUS_TEST_PG;

function literal(v: SqlValue): string {
  if (v === null) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Uint8Array) return `'\\x${Buffer.from(v).toString("hex")}'::bytea`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function bind(q: SqlQuery): string {
  let sql = q.query;
  const params = q.params ?? [];
  for (let i = params.length; i >= 1; i--) sql = sql.split(`$${i}`).join(literal(params[i - 1]));
  return sql;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') { quoted = true; wasQuoted = true; }
    else if (c === ",") { row.push(wasQuoted ? cur : cur); cur = ""; wasQuoted = false; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; wasQuoted = false; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** A RemoteStore over psql with Neon raw-text semantics (every value is text or null). */
class PsqlStore implements RemoteStore {
  constructor(private readonly host: string, private readonly port: string) {}
  async query(q: SqlQuery): Promise<Row[]> {
    const out = execFileSync("psql", ["-h", this.host, "-p", this.port, "-U", "postgres", "-X", "-q", "--csv", "-P", "null=\\N", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: bind(q), maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
    const rows = parseCsv(out.replace(/\n$/, ""));
    if (!rows.length) return [];
    const [head, ...body] = rows;
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "\\N" ? null : r[i] ?? null])));
  }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> {
    const out: Row[][] = [];
    for (const q of qs) out.push(await this.query(q));
    return out;
  }
}

describe.skipIf(!PG)("corpus backfill against real archives and Postgres", () => {
  it("stores every declared record of a Supreme Court year and a High Court bench-year, mapped to the registry, and retrieves them", async () => {
    const [host, port] = PG!.split(":");
    const store = new PsqlStore(host, port);
    await store.query({ query: `DROP TABLE IF EXISTS corpus_judgments, corpus_units, corpus_rejects, corpus_state` });
    const { ensureCorpusSchema, runBackfill, resetCorpusSchemaCacheForTests, corpusStatus, setState } = await import("@/modules/india/corpus/backfill");
    const { searchCorpus } = await import("@/modules/india/corpus/search");
    resetCorpusSchemaCacheForTests();
    await ensureCorpusSchema(store);
    // Mark discovery done and queue exactly two real archives.
    await store.query({ query: `INSERT INTO corpus_units (id, source, year, folder, object_key, priority, status) VALUES ('discover:sc', 'sci-open-data', 0, 'metadata/tar/', 'metadata/tar/', 0, 'done')` });
    await store.query({ query: `INSERT INTO corpus_units (id, source, year, court_code, bench_code, folder, object_key, priority) VALUES
      ('sc:metadata/tar/year=2023/metadata.tar', 'sci-open-data', 2023, NULL, NULL, 'metadata/tar/year=2023/', 'metadata/tar/year=2023/metadata.tar', 1),
      ('hc:metadata/tar/year=2024/court=29_3/bench=karhcdharwad/part-20260514T170715Z.tar.gz', 'hc-open-data', 2024, '29_3', 'karhcdharwad', 'metadata/tar/year=2024/court=29_3/bench=karhcdharwad/', 'metadata/tar/year=2024/court=29_3/bench=karhcdharwad/part-20260514T170715Z.tar.gz', 2)` });
    await setState(store, "enabled", true);

    let result = await runBackfill({ deadlineMs: 600_000, store });
    for (let i = 0; i < 5 && result.stop === "deadline"; i++) result = await runBackfill({ deadlineMs: 600_000, store });
    expect(result.stop, JSON.stringify(result)).toBe("queue_empty");

    const units = await store.query({ query: `SELECT id, status, expected, stored, rejected, error FROM corpus_units WHERE id NOT LIKE 'discover:%' ORDER BY priority` });
    for (const u of units) {
      expect(u.status, u.id!).toBe("done");
      expect(Number(u.stored) + Number(u.rejected), u.id!).toBe(Number(u.expected));
    }
    const sc = units[0];
    const hc = units[1];
    expect(Number(sc.expected)).toBe(856);
    expect(Number(hc.expected)).toBe(23249);
    // Row counts in the table equal the unit counters (distinct ids).
    const counts = await store.query({ query: `SELECT unit_id, count(*)::int AS n FROM corpus_judgments GROUP BY unit_id` });
    const byUnit = Object.fromEntries(counts.map((r) => [r.unit_id!, Number(r.n)]));
    expect(byUnit[sc.id!]).toBe(Number(sc.stored));
    expect(byUnit[hc.id!]).toBe(Number(hc.stored));

    // Mapping: every HC row resolves to the Karnataka High Court and its Dharwad bench; every SC row to the Supreme Court.
    const map = await store.query({ query: `SELECT court_id, bench_id, count(*)::int AS n, count(*) FILTER (WHERE decision_date IS NULL)::int AS nodate, count(*) FILTER (WHERE cnr IS NULL)::int AS nocnr FROM corpus_judgments GROUP BY court_id, bench_id` });
    const kar = map.find((r) => r.court_id === "hc-karnataka");
    expect(kar?.bench_id).toBe("kar-dharwad");
    expect(Number(kar?.n)).toBe(Number(hc.stored));
    const sci = map.find((r) => r.court_id === "sci");
    expect(Number(sci?.n)).toBe(Number(sc.stored));
    expect(map.filter((r) => r.court_id === null)).toEqual([]);
    console.log("mapping", JSON.stringify(map));

    // Retrieval: exact CNR, neutral citation, and full text.
    const one = await store.query({ query: `SELECT cnr FROM corpus_judgments WHERE court_id = 'hc-karnataka' AND cnr IS NOT NULL LIMIT 1` });
    const byCnr = await searchCorpus({ q: one[0].cnr! }, store);
    expect(byCnr.hits[0]?.cnr).toBe(one[0].cnr);
    expect(byCnr.hits[0]?.match).toBe("exact");
    const nc = await store.query({ query: `SELECT neutral_citation FROM corpus_judgments WHERE court_id = 'sci' AND neutral_citation IS NOT NULL LIMIT 1` });
    if (nc[0]) {
      const byNc = await searchCorpus({ q: nc[0].neutral_citation! }, store);
      expect(byNc.hits[0]?.neutral_citation).toBe(nc[0].neutral_citation);
    }
    const text = await searchCorpus({ q: "land acquisition compensation", courts: ["hc-karnataka"], limit: 5 }, store);
    expect(text.hits.length).toBeGreaterThan(0);
    expect(text.hits.every((h) => h.court_id === "hc-karnataka")).toBe(true);

    // Re-running is idempotent: nothing is rewritten.
    await store.query({ query: `UPDATE corpus_units SET status = 'pending', cursor = 0, stored = 0, rejected = 0 WHERE id = $1`, params: [hc.id!] });
    const before = await store.query({ query: `SELECT max(updated_at)::text AS t FROM corpus_judgments` });
    await runBackfill({ deadlineMs: 600_000, store });
    const after = await store.query({ query: `SELECT max(updated_at)::text AS t, count(*)::int AS n FROM corpus_judgments` });
    expect(after[0].t).toBe(before[0].t);

    const status = await corpusStatus({ store });
    console.log("status", JSON.stringify({ judgments: status.judgments, byCourt: status.byCourt, archives: status.archives, issues: status.issues, dbBytes: status.dbBytes }));
    const rejects = await store.query({ query: `SELECT reason, count(*)::int AS n FROM corpus_rejects GROUP BY reason` });
    console.log("rejects", JSON.stringify(rejects));
  }, 900_000);
});
