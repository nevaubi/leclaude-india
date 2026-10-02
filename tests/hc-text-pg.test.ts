import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { RemoteStore, Row, SqlQuery, SqlValue } from "@/lib/db/remote";

/**
 * Opt-in: the High Court text worker's SQL (src/modules/india/corpus/hc-text/repo.ts) against a real Postgres, plus the
 * Open India Law loader's supersede step. Skipped unless HC_TEXT_TEST_PG="host:port" (host may be a socket directory).
 *
 *   HC_TEXT_TEST_PG=/path/to/socketdir:55441 npx vitest run tests/hc-text-pg.test.ts
 */
const PG = process.env.HC_TEXT_TEST_PG;

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
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const [HOST, PORT] = (PG ?? ":").split(/:(?=\d+$)/);
function psql(sql: string): string {
  return execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-X", "-q", "--csv", "-P", "null=\\N", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: sql, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
}
class PsqlStore implements RemoteStore {
  calls: string[] = [];
  async query(q: SqlQuery): Promise<Row[]> {
    this.calls.push(q.query);
    const rows = parseCsv(psql(bind(q)).replace(/\n$/, ""));
    if (!rows.length) return [];
    const [head, ...body] = rows;
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "\\N" ? null : r[i] ?? null])));
  }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> {
    // One psql session in a transaction; only the last statement's rows are needed by the callers here.
    const out: Row[][] = qs.map(() => []);
    const text = psql(`BEGIN;\n${qs.map((q) => `${bind(q)};`).join("\n")}\nCOMMIT;`);
    const blocks = text.split(/\n(?=[a-z_]+(?:,[a-z_]+)*\n)/);
    const last = parseCsv(blocks[blocks.length - 1].replace(/\n$/, ""));
    if (last.length) {
      const [head, ...body] = last;
      out[out.length - 1] = body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "\\N" ? null : r[i] ?? null])));
    }
    return out;
  }
}

const BUCKET = "https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com";

async function textPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    for (let l = 0; l < 8; l++) p.drawText(`Page ${i + 1}: the writ petition under Article 226 is allowed; the impugned assessment order is quashed (${l}).`, { x: 30, y: 740 - l * 18, size: 9, font });
  }
  return doc.save();
}

describe.skipIf(!PG)("HC text SQL against Postgres", () => {
  it("queues, claims, stores guarded text, reads it back through text.ts, and reports coverage", async () => {
    psql(`DROP TABLE IF EXISTS corpus_judgments, corpus_units, corpus_rejects, corpus_state, corpus_texts, hc_text_units CASCADE`);
    const store = new PsqlStore();
    const { CORPUS_SCHEMA } = await import("@/modules/india/corpus/schema");
    for (const q of CORPUS_SCHEMA) await store.query(q);
    const { SqlHcTextRepo } = await import("@/modules/india/corpus/hc-text/repo");
    const { buildSchedule } = await import("@/modules/india/corpus/hc-text/schedule");
    const repo = new SqlHcTextRepo(store);
    expect(await repo.ensureSchema()).toEqual({ judgments: true });
    await new SqlHcTextRepo(new PsqlStore()).ensureSchema(); // idempotent on a fresh instance

    const ins = (id: string, cnr: string | null, date: string, status = "none", url = `${BUCKET}/data/pdf/${id}.pdf`, court = "hc-delhi") => psql(`INSERT INTO corpus_judgments (id, source, unit_id, dataset_key, court_id, year, title, cnr, decision_date, pdf_url, record_sha256, text_status, case_number)
      VALUES ('${id}', 'hc-open-data', 'u', '${id}', '${court}', ${date.slice(0, 4)}, 'Title ${id}', ${cnr ? `'${cnr}'` : "NULL"}, '${date}', '${url}', 'x', '${status}', 'W.P. ${id}')`);
    ins("hc:a", "DLHC010000012024", "2024-05-01");
    ins("hc:b", "DLHC010000022024", "2024-07-01");
    ins("hc:oil", "DLHC010000032024", "2024-03-01");
    ins("hc:full", "DLHC010000042024", "2024-02-01", "full");
    ins("hc:nocnr", null, "2024-02-02");
    ins("hc:elsewhere", "DLHC010000052024", "2024-02-03", "none", "https://example.com/a.pdf");
    ins("hc:dup", "DLHC010000012024", "2024-05-01");
    ins("hc:bom", "HCBM010000012024", "2024-01-01", "none", `${BUCKET}/b.pdf`, "hc-bombay");
    psql(`INSERT INTO corpus_texts (id, case_key, chunk_index, total_chunks, page_start, page_end, text, dataset_version, court_id, cnr, decision_date)
      VALUES ('oil-1', 'DLHC010000032024', 0, 1, 1, 1, 'Open India Law text of the order', 'v2026.08.1', 'hc-delhi', 'DLHC010000032024', '2024-03-01')`);

    const schedule = buildSchedule({ recentFrom: 2016, oldestYear: 2016, currentYear: 2026 });
    const delhi2024 = schedule.find((s) => s.courtId === "hc-delhi" && s.year === 2024)!;
    expect(await repo.seedSlice(delhi2024, 2)).toBe(2);
    expect(await repo.seedSlice(delhi2024, 100)).toBe(2); // the rest of the eligible Delhi 2024 records (a, b, oil, dup)
    expect(await repo.seedSlice(delhi2024, 100)).toBe(0);
    const units = await store.query({ query: `SELECT judgment_id FROM hc_text_units ORDER BY judgment_id` });
    expect(units.map((u) => u.judgment_id)).toEqual(["hc:a", "hc:b", "hc:dup", "hc:oil"]);
    expect(await repo.pendingCount()).toBe(4);

    const first = await repo.claim(10, 5);
    expect(first).toMatchObject({ judgmentId: "hc:b", status: "running", attempts: 1, decisionDate: "2024-07-01", priority: delhi2024.index });

    // Store, then re-store shorter: the stale tail is removed and the record status follows.
    const chunk = (i: number, text: string, ocr = false) => ({ index: i, pageStart: i + 1, pageEnd: i + 1, sectionType: ocr ? "ocr" : null, text });
    const input = { judgmentId: "hc:a", courtId: "hc-delhi", cnr: "DLHC010000012024", decisionDate: "2024-05-01", title: "Title hc:a", caseNumber: "W.P. hc:a", datasetVersion: "aws-hc-pdf:x1.p1" };
    expect(await repo.storeText({ ...input, status: "ocr", chunks: [chunk(0, "Assessment order quashed"), chunk(1, "Scanned annexure text", true), chunk(2, "Third")] })).toEqual({ stored: true, chunks: 3 });
    expect(await repo.storeText({ ...input, status: "full_text", chunks: [chunk(0, "Assessment order quashed; writ allowed"), chunk(1, "Second page")] })).toEqual({ stored: true, chunks: 2 });
    const rows = await store.query({ query: `SELECT id, chunk_index, total_chunks, text, dataset_version, neutral_citation, section_type FROM corpus_texts WHERE case_key = 'hc:a' ORDER BY chunk_index` });
    expect(rows.map((r) => [r.id, r.total_chunks, r.text])).toEqual([["hcpdf:hc:a:0", "2", "Assessment order quashed; writ allowed"], ["hcpdf:hc:a:1", "2", "Second page"]]);
    expect(rows[0].neutral_citation).toBeNull();
    expect((await store.query({ query: `SELECT text_status FROM corpus_judgments WHERE id = 'hc:a'` }))[0].text_status).toBe("full_text");

    // Guards: Open India Law text, a "full" record, a duplicate CNR + date, a missing record.
    expect(await repo.storeText({ ...input, judgmentId: "hc:oil", cnr: "DLHC010000032024", decisionDate: "2024-03-01", status: "full_text", chunks: [chunk(0, "pdf")] })).toEqual({ stored: false, reason: "open_india_law" });
    expect(await repo.storeText({ ...input, judgmentId: "hc:full", cnr: "DLHC010000042024", decisionDate: "2024-02-01", status: "full_text", chunks: [chunk(0, "pdf")] })).toEqual({ stored: false, reason: "record_has_text" });
    expect(await repo.storeText({ ...input, judgmentId: "hc:dup", status: "full_text", chunks: [chunk(0, "pdf")] })).toEqual({ stored: false, reason: "duplicate" });
    expect(await repo.storeText({ ...input, judgmentId: "hc:gone", status: "full_text", chunks: [chunk(0, "pdf")] })).toEqual({ stored: false, reason: "record_missing" });
    expect((await store.query({ query: `SELECT count(*)::int AS n FROM corpus_texts WHERE dataset_version LIKE 'aws-hc-pdf%'` }))[0].n).toBe("2");
    expect((await store.query({ query: `SELECT text FROM corpus_texts WHERE id = 'oil-1'` }))[0].text).toBe("Open India Law text of the order");
    expect(await repo.openIndiaLawText("DLHC010000032024", "2024-03-01")).toBe(true);
    expect(await repo.openIndiaLawText("DLHC010000012024", "2024-05-01")).toBe(false);

    // The existing readers see the PDF text immediately, with the right attribution.
    const { readJudgmentText, searchJudgmentText, resetTextTableCacheForTests } = await import("@/modules/india/corpus/text");
    resetTextTableCacheForTests();
    const read = await readJudgmentText("hc:a", {}, store);
    expect(read).toMatchObject({ cnr: "DLHC010000012024", decisionDate: "2024-05-01", totalChunks: 2, source: "court_pdf", ocr: false });
    expect(read!.attribution).toMatch(/extracted by LeClaude from the court's PDF/);
    expect(read!.chunks.map((c) => c.pageStart)).toEqual([1, 2]);
    const oilRead = await readJudgmentText("DLHC010000032024@2024-03-01", {}, store);
    expect(oilRead).toMatchObject({ source: "open_india_law" });
    expect(oilRead!.attribution).toMatch(/Open India Law/);
    const hits = await searchJudgmentText("assessment quashed", { courts: ["hc-delhi"] }, store);
    expect(hits.hits.map((h) => h.judgmentId)).toEqual(["hc:a"]);
    expect(hits.hits[0]).toMatchObject({ pageStart: 1, cnr: "DLHC010000012024" });

    // Queue state transitions.
    await repo.finish("hc:b", "done", { result: "ocr", sha256: "ab".repeat(32), bytes: 1234, pages: 3, textPages: 1, ocrPages: [2, 3], ocrFailedPages: [], ocrModel: "m", extractorVersion: 1, pipelineVersion: 1, datasetVersion: "aws-hc-pdf:x1.p1", chunks: 3, chars: 900, note: "ok", sourceUrl: `${BUCKET}/data/pdf/hc:b.pdf` });
    const b = (await store.query({ query: `SELECT status, result, pdf_sha256, ocr_pages::text AS ocr_pages, ocr_failed_pages::text AS f, lease_until FROM hc_text_units WHERE judgment_id = 'hc:b'` }))[0];
    expect(b).toMatchObject({ status: "done", result: "ocr", pdf_sha256: "ab".repeat(32), ocr_pages: "{2,3}", f: null, lease_until: null });
    const second = await repo.claim(10, 5);
    expect(second?.judgmentId).toBe("hc:a");
    await repo.saveProgress("hc:a", { sha256: "x", ocrDone: { 2: "page two" } });
    await repo.release("hc:a", "deadline");
    const a = (await store.query({ query: `SELECT status, attempts, payload->'ocrDone'->>'2' AS p2 FROM hc_text_units WHERE judgment_id = 'hc:a'` }))[0];
    expect(a).toMatchObject({ status: "pending", attempts: "0", p2: "page two" });
    await repo.defer("hc:a", 3600, "later");
    expect((await repo.claim(10, 5))?.judgmentId).toBe("hc:dup"); // hc:a waits; next by date
    await repo.retry("hc:dup", "socket hang up", 5);
    expect((await repo.claim(10, 5))?.judgmentId).toBe("hc:oil");
    expect(await repo.claim(10, 5)).toBeNull();
    await repo.finish("hc:oil", "failed", { result: "failed", error: "404" });
    await repo.markJudgmentFailed("hc:oil");
    await repo.markJudgmentFailed("hc:a"); // has text: untouched
    expect((await store.query({ query: `SELECT id, text_status FROM corpus_judgments WHERE id IN ('hc:a', 'hc:oil') ORDER BY id` })).map((r) => r.text_status)).toEqual(["full_text", "failed"]);
    expect(await repo.requeue(["failed"], 10)).toBe(1);
    expect((await store.query({ query: `SELECT text_status FROM corpus_judgments WHERE id = 'hc:oil'` }))[0].text_status).toBe("none");
    psql(`UPDATE hc_text_units SET status = 'running', lease_until = now() - interval '1 minute', attempts = 5 WHERE judgment_id = 'hc:oil'`);
    expect(await repo.sweepExpired(5)).toBe(1);
    expect(await repo.queueCounts()).toMatchObject({ pending: 2, done: 1, failed: 1, running: 0 });

    expect(await repo.claimStartSlot("hc_text_cron_start", 280)).toBe(true);
    expect(await repo.claimStartSlot("hc_text_cron_start", 280)).toBe(false);
    await repo.setState("hc_text_seed", { cursor: 3, passCompletedAt: null });
    expect(await repo.getState("hc_text_seed")).toEqual({ cursor: 3, passCompletedAt: null });
    expect(await repo.dbBytes()).toBeGreaterThan(1_000_000);

    const live = await repo.coverage();
    expect(live.every((x) => x.refreshedAt === null)).toBe(true);
    expect(await repo.staleCoverageCourts(["hc-delhi", "hc-bombay"], 30, 5)).toEqual(["hc-delhi", "hc-bombay"]);
    await repo.refreshCoverage("hc-delhi");
    expect(await repo.staleCoverageCourts(["hc-delhi", "hc-bombay"], 30, 5)).toEqual(["hc-bombay"]);
    await repo.refreshCoverage("hc-bombay");
    await repo.refreshCoverage("hc-bombay"); // idempotent recount
    const cov = await repo.coverage();
    expect(cov.every((x) => typeof x.refreshedAt === "string")).toBe(true);
    expect(cov).toHaveLength(live.length);
    const d24 = cov.find((r) => r.courtId === "hc-delhi" && r.year === 2024)!;
    expect(d24).toMatchObject({ judgments: 7, withText: 2, openIndiaLaw: 1, pdfText: 1, metadataOnly: 5 });
    expect(d24.lastUpdate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cov.find((r) => r.courtId === "hc-bombay")).toMatchObject({ judgments: 1, metadataOnly: 1 });
  }, 120_000);

  it("runs end to end with a real PDF (fake fetch only), and the Open India Law loader supersedes PDF text", async () => {
    psql(`DELETE FROM hc_text_units; DELETE FROM corpus_texts; DELETE FROM corpus_judgments; DELETE FROM corpus_state WHERE key LIKE 'hc_text_seed'`);
    psql(`INSERT INTO corpus_judgments (id, source, unit_id, dataset_key, court_id, year, title, cnr, decision_date, pdf_url, record_sha256, text_status)
      VALUES ('hc:e2e', 'hc-open-data', 'u', 'k', 'hc-delhi', 2025, 'E2E v. State', 'DLHC010000092025', '2025-08-01', '${BUCKET}/data/pdf/e2e.pdf', 'x', 'none')`);
    const store = new PsqlStore();
    const { runHcTextIngest } = await import("@/modules/india/corpus/hc-text/run");
    const { hcTextConfig } = await import("@/modules/india/corpus/hc-text/config");
    const bytes = await textPdf(3);
    const r = await runHcTextIngest({ store, deadlineMs: 200_000, config: { ...hcTextConfig({}), concurrency: 1 }, currentYear: 2026, log: () => {}, fetchPdf: async (url) => ({ ok: true, bytes, finalUrl: url }), blobStore: { kind: "none", configured: false, put: async () => null } });
    expect(r.stop, JSON.stringify(r)).toBe("done");
    expect(r.results).toEqual({ full_text: 1 });
    const u = (await store.query({ query: `SELECT status, result, pages, text_pages, chunks, pdf_sha256, dataset_version FROM hc_text_units WHERE judgment_id = 'hc:e2e'` }))[0];
    expect(u).toMatchObject({ status: "done", result: "full_text", pages: "3", text_pages: "3", dataset_version: "aws-hc-pdf:x1.p1" });
    expect(u.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    const pages = await store.query({ query: `SELECT page_start, page_end FROM corpus_texts WHERE case_key = 'hc:e2e' ORDER BY chunk_index` });
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0].page_start).toBe("1");
    expect(pages.at(-1)!.page_end).toBe("3");

    // Open India Law text for the same CNR + date arrives: the loader's mark() keeps it and removes the PDF rows.
    psql(`INSERT INTO corpus_texts (id, case_key, chunk_index, total_chunks, page_start, page_end, text, dataset_version, court_id, cnr, decision_date)
      VALUES ('oil-e2e', 'DLHC010000092025', 0, 1, 1, 1, 'OIL text', 'v2026.08.1', 'hc-delhi', 'DLHC010000092025', '2025-08-01')`);
    const script = path.resolve("scripts/law-corpus/load_hc_judgment_text.py");
    const py = `
import importlib.util, subprocess, sys
spec = importlib.util.spec_from_file_location("loader", ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Cur:
    def __init__(self): self.rowcount = 0; self.out = ""
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, sql):
        r = subprocess.run(["psql", "-h", ${JSON.stringify(HOST)}, "-p", ${JSON.stringify(PORT)}, "-U", "postgres", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True, check=True)
        self.out = r.stdout.strip()
        tag = r.stdout.strip().split("\\n")[-1]
        self.rowcount = int(tag.split()[-1]) if tag[:6] in ("UPDATE", "DELETE") else 0
    def fetchone(self): return (self.out == "t",)
class Conn:
    def cursor(self): return Cur()
    def commit(self): pass
m.mark(Conn())
`;
    const out = execFileSync("python3", ["-c", py]).toString();
    expect(out).toMatch(/pdf-text chunks replaced by Open India Law text/);
    const left = await store.query({ query: `SELECT id FROM corpus_texts WHERE cnr = 'DLHC010000092025' ORDER BY id` });
    expect(left.map((x) => x.id)).toEqual(["oil-e2e"]);
    expect((await store.query({ query: `SELECT text_status FROM corpus_judgments WHERE id = 'hc:e2e'` }))[0].text_status).toBe("full");
    expect((await store.query({ query: `SELECT oil_text, note FROM hc_text_units WHERE judgment_id = 'hc:e2e'` }))[0]).toMatchObject({ oil_text: "t", note: "superseded by Open India Law text (PDF text removed)" });
  }, 120_000);
});
