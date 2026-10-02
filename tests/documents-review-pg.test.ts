import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemoteStore, Row, SqlQuery, SqlValue } from "@/lib/db/remote";

/**
 * Opt-in integration test: document review (rows, counts, facets, filters, paging, coding, version CAS, report, export,
 * chat, and the migration of a pre-existing review-rows table) against a real Postgres reached with psql (Neon raw-text
 * semantics). Skipped unless DOCS_TEST_PG (or CORPUS_TEST_PG) is "host:port" (host may be a socket directory).
 *
 *   DOCS_TEST_PG=/tmp/pg:55432 npx vitest run tests/documents-review-pg.test.ts
 *
 * It drops and recreates the docs_* tables of that database.
 */
const PG = process.env.DOCS_TEST_PG || process.env.CORPUS_TEST_PG;

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/documents-review-pg-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
});

const ai = vi.hoisted(() => ({ calls: 0, agentFailures: 0, failReview: "" }));
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  runAgent: async (opts: { onEvent: (e: unknown) => void }) => {
    if (ai.agentFailures > 0) { ai.agentFailures--; throw new Error("model overloaded"); }
    opts.onEvent({ type: "start", model: "test-model" });
    opts.onEvent({ type: "text.delta", delta: "Mumbai [1]." });
    return { text: "Mumbai [1].", responseId: null, steps: 1, toolCalls: [], usage: { input: 0, output: 0, total: 0 } };
  },
  generateJSON: async (opts: { input: string }) => {
    ai.calls++;
    const input = String(opts.input);
    const none = { flag: "none", basis: "", quote: "", page: null };
    if (ai.failReview && input.includes(ai.failReview)) throw new Error("provider error");
    if (input.includes("CONFLICT DEED")) {
      return {
        docType: "Agreement", summary: "Deed fixing the seat at Mumbai. It also records the claim.", importance: 4,
        issues: [{ issueId: "payment", relevance: "high", reason: "Claim stated.", quote: "The total claim is Rs. 50,00,000", page: 1 }],
        privilege: { flag: "possible", basis: "Copy for the company's advocate.", quote: "copy for legal advice of counsel", page: 1 },
        cells: [
          { column: "seat", value: "Mumbai", quote: "The seat of arbitration shall be Mumbai", page: 1 },
          { column: "claim", value: "Rs. 50,00,000", quote: "The total claim is Rs. 50,00,000", page: 1 },
          { column: "fee", value: "Rs. 2,00,000", quote: "The total claim is Rs. 50,00,000", page: 1 },
          { column: "clause", value: "Yes", quote: "arbitration", page: 1 },
        ],
      };
    }
    if (input.includes("ADDENDUM")) {
      return {
        docType: "Agreement", summary: "Addendum moving the seat to Delhi.", importance: 3, issues: [], privilege: none,
        cells: [{ column: "seat", value: "Delhi", quote: "The seat of arbitration shall be Delhi", page: 3 }, { column: "claim", value: "₹50 lakh", quote: "Amount payable is ₹50 lakh in full", page: 3 }],
      };
    }
    if (input.includes("SCANNED BUNDLE")) {
      return { docType: "Notice", summary: "Partly scanned notice naming Pune.", importance: 2, issues: [{ issueId: "payment", relevance: "low", reason: "Mentions dues.", quote: "The seat of arbitration shall be Pune", page: 1 }], privilege: none, cells: [{ column: "seat", value: "Pune", quote: "The seat of arbitration shall be Pune", page: 1 }] };
    }
    return { docType: "Other", summary: "", importance: 1, issues: [], privilege: none, cells: [] };
  },
}));

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
    else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

class PsqlStore implements RemoteStore {
  constructor(private readonly host: string, private readonly port: string) {}
  async query(q: SqlQuery): Promise<Row[]> {
    const out = execFileSync("psql", ["-h", this.host, "-p", this.port, "-U", "postgres", "-X", "-q", "--csv", "-P", "null=\\N", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: bind(q), maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8");
    const rows = parseCsv(out.replace(/\n$/, ""));
    if (!rows.length) return [];
    const [head, ...body] = rows;
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "\\N" ? null : r[i] ?? null])));
  }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> {
    execFileSync("psql", ["-h", this.host, "-p", this.port, "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"], { input: qs.map((q) => `${bind(q)};`).join("\n"), maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    return qs.map(() => []);
  }
}

describe.skipIf(!PG)("document review on Postgres", () => {
  const MATTER = "m_review_pg";
  const alice = { id: "u_pg_alice", name: "Alice PG", tenantId: "default", roles: ["associate" as const], matterIds: [MATTER], source: "dev" as const };
  const bob = { ...alice, id: "u_pg_bob", name: "Bob", matterIds: [] as string[] };
  let psql: PsqlStore;

  beforeAll(async () => {
    const i = PG!.lastIndexOf(":");
    psql = new PsqlStore(PG!.slice(0, i), PG!.slice(i + 1));
    await psql.query({ query: `DROP TABLE IF EXISTS docs_chunks, docs_files, docs_sets, docs_extractions, docs_reviews, docs_review_rows` });
    // A review-rows table as created before the derived columns existed, with one legacy row to backfill.
    await psql.query({
      query: `CREATE TABLE docs_review_rows (review_id text NOT NULL, file_id text NOT NULL, set_id text NOT NULL, state text NOT NULL, review_version int, text_hash text,
        file_stamp text, windows_done int NOT NULL DEFAULT 0, result text, partials text NOT NULL DEFAULT '[]', row_hash text, decision text, error text,
        attempts int NOT NULL DEFAULT 0, updated_at text NOT NULL, PRIMARY KEY (review_id, file_id))`,
    });
    const legacy = { docType: "Notice", summary: "Legacy", importance: 3, issues: [{ issueId: "breach", relevance: "high", reason: "r", quote: "", page: null, quoteFound: false }], privilege: { flag: "possible", basis: "b", quote: "", page: null, quoteFound: false }, cells: { seat: { value: "Chennai", status: "found", quote: "q", page: 1, quoteFound: true } }, coverage: { read: 10, total: 10 } };
    await psql.query({
      query: `INSERT INTO docs_review_rows (review_id, file_id, set_id, state, result, decision, updated_at) VALUES ('drev_legacy', 'dfile_legacy', 'dset_legacy', 'done', $1, $2, 'x')`,
      params: [JSON.stringify(legacy), JSON.stringify({ coding: "relevant", issues: [], note: "Legacy note", reviewer: "u", reviewerName: null, at: "x", rowHash: "h0" })],
    });
    const { db, resetSqlite } = await import("@/lib/db");
    resetSqlite();
    db();
    db().matters.put({ id: MATTER, name: "PG matter", tenantId: "default" } as never);
    const { setDocStoreForTests } = await import("@/modules/documents/server/store");
    const { PgDocStore } = await import("@/modules/documents/server/store-pg");
    setDocStoreForTests(new PgDocStore(psql));
  });

  afterAll(async () => {
    const { setDocStoreForTests } = await import("@/modules/documents/server/store");
    setDocStoreForTests(null);
  });

  it("migrates and backfills an existing review-rows table", async () => {
    const { docStore } = await import("@/modules/documents/server/store");
    await (await docStore()).countFiles("dset_none"); // first use runs the schema, migration and backfill
    const [row] = await psql.query({ query: `SELECT cov_partial, doc_type, importance, privilege_flag, issue_ranks, coding, decision_hash, coding_note, derived_v, strpos(search_text, 'chennai') > 0 AS hit FROM docs_review_rows WHERE review_id = 'drev_legacy'` });
    expect(row).toEqual({ cov_partial: "0", doc_type: "Notice", importance: "3", privilege_flag: "possible", issue_ranks: "|breach:3|", coding: "relevant", decision_hash: "h0", coding_note: "legacy note", derived_v: "1", hit: "t" });
    await psql.query({ query: `DELETE FROM docs_review_rows WHERE review_id = 'drev_legacy'` });
  });

  it("runs, queries, codes, exports and reports through the Postgres store", async () => {
    const { createSet, deleteSet } = await import("@/modules/documents/server/sets");
    const { uploadBrowserPdf } = await import("@/modules/documents/server/ingest");
    const { codeRow, createReview, getReview, listReviews, listRows, parseRowQuery, reviewRowsForChat, updateReview } = await import("@/modules/documents/server/review");
    const { runReview } = await import("@/modules/documents/server/review-run");
    const { exportReview } = await import("@/modules/documents/server/review-export");
    const { runReport, getReport } = await import("@/modules/documents/server/review-report");
    const { docStore } = await import("@/modules/documents/server/store");

    const set = await createSet(alice, { name: "PG review bundle", matterId: MATTER });
    const filler = "Schedule of deliveries. ".repeat(1100);
    const d = await uploadBrowserPdf(alice, set.id, { kind: "pdf-text", name: "deed.pdf", size: 1000, sha256: "1".repeat(64), pages: ["CONFLICT DEED. It's O'Brien's copy for legal advice of counsel. The seat of arbitration shall be Mumbai. The total claim is Rs. 50,00,000 under the deed.", filler, "ADDENDUM. The seat of arbitration shall be Delhi. Amount payable is ₹50 lakh in full."] });
    const sc = await uploadBrowserPdf(alice, set.id, { kind: "pdf-text", name: "scanned.pdf", size: 1000, sha256: "2".repeat(64), pages: ["SCANNED BUNDLE. The seat of arbitration shall be Pune.", ""] });
    if (d.status !== "created" || sc.status !== "created") throw new Error("upload failed");
    const deed = d.file.id;
    const scanned = sc.file.id;
    const columns = [
      { id: "seat", label: "Seat", prompt: "Seat of arbitration.", kind: "text" as const },
      { id: "claim", label: "Claim", prompt: "Amount claimed.", kind: "amount" as const },
      { id: "fee", label: "Fee", prompt: "Arbitrator's fee.", kind: "amount" as const },
      { id: "clause", label: "Arbitration clause", prompt: "Is there an arbitration clause?", kind: "yes_no" as const },
    ];
    const review = await createReview(alice, set.id, { name: "PG review", docTypes: ["Agreement", "Notice"], columns, issues: [{ id: "payment", label: "Payment", description: "Payment default." }], questions: ["Where is the seat?", "What is claimed?"] });
    expect(review.counts).toMatchObject({ files: 2, pending: 2, done: 0, partial: 0 });

    expect(await runReview(alice, set.id, review.id)).toMatchObject({ processed: 2, failed: 0, remaining: 0 });
    const calls = ai.calls;
    expect(await runReview(alice, set.id, review.id)).toMatchObject({ processed: 0, remaining: 0 });
    expect(ai.calls).toBe(calls);

    const all = await listRows(alice, set.id, review.id, {});
    expect(all.total).toBe(2);
    expect(all.rows.map((r) => r.fileId)).toEqual([deed, scanned]); // importance 4 before 2
    const dr = all.rows[0];
    expect(dr).toMatchObject({ status: "done", docType: "Agreement", importance: 4 });
    expect(dr.cells.seat).toMatchObject({ value: "Mumbai", status: "conflict", alternatives: [{ value: "Delhi", page: 3 }] });
    expect(dr.cells.claim).toMatchObject({ status: "found" });
    expect(dr.cells.fee).toMatchObject({ status: "unverified" });
    expect(dr.cells.clause).toMatchObject({ status: "unverified", quoteFound: false });
    expect(dr.privilege).toMatchObject({ flag: "possible", page: 1, quoteFound: true });
    const sr = all.rows[1];
    expect(sr).toMatchObject({ status: "partial", coverage: { unreadPages: [2] } });
    expect(sr.cells.claim).toMatchObject({ status: "not_read" });
    expect(all.facets).toEqual({
      docTypes: [{ value: "Agreement", count: 1 }, { value: "Notice", count: 1 }],
      issues: [{ issueId: "payment", high: 1, medium: 0, low: 1 }],
      privilege: { possible: 1, likely: 0 },
      coding: { uncoded: 2 },
    });
    expect((await getReview(alice, set.id, review.id)).counts).toEqual({ files: 2, done: 1, partial: 1, pending: 0, failed: 0, coded: 0, stale: 0, privilegeFlags: 1 });
    expect((await listReviews(alice, set.id))[0].counts).toMatchObject({ done: 1, partial: 1 });

    const q = async (o: Record<string, unknown>) => (await listRows(alice, set.id, review.id, parseRowQuery(o))).rows.map((r) => r.fileId);
    expect(await q({ issue: "payment" })).toEqual([deed, scanned]);
    expect(await q({ issue: "payment", minRelevance: "medium" })).toEqual([deed]);
    expect(await q({ docType: "notice" })).toEqual([scanned]);
    expect(await q({ privilege: "possible" })).toEqual([deed]);
    expect(await q({ privilege: "none" })).toEqual([scanned]);
    expect(await q({ status: "partial" })).toEqual([scanned]);
    expect(await q({ q: "delhi" })).toEqual([deed]);
    expect(await q({ q: "o'brien" })).toEqual([]); // the quote text is not indexed, only values, reasons, summary and names
    expect(await q({ q: "scanned.pdf" })).toEqual([scanned]);
    expect(await q({ sort: "name", limit: "1", offset: "1" })).toEqual([scanned]);
    expect((await listRows(alice, set.id, review.id, parseRowQuery({ limit: "1" }))).total).toBe(2);

    // Coding: bound to the shown hash; 409 on a mismatch; searchable note; facets by coding.
    await expect(codeRow(alice, set.id, review.id, deed, { coding: "key", rowHash: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    const coded = await codeRow(alice, set.id, review.id, deed, { coding: "key", note: "Core O'Brien deed", rowHash: dr.rowHash! });
    expect(coded).toMatchObject({ decisionStale: false, decision: { coding: "key", rowHash: dr.rowHash } });
    expect(await q({ coding: "key" })).toEqual([deed]);
    expect(await q({ coding: "uncoded" })).toEqual([scanned]);
    expect(await q({ q: "o'brien" })).toEqual([deed]); // via the note
    expect((await listRows(alice, set.id, review.id, {})).facets.coding).toEqual({ key: 1, uncoded: 1 });

    // Version CAS, then a bump blanks every row everywhere and makes the decision stale.
    await expect(updateReview(alice, set.id, review.id, { name: "x", version: review.version + 3 })).rejects.toMatchObject({ status: 409, code: "review_changed" });
    const bumped = await updateReview(alice, set.id, review.id, { columns: columns.filter((c) => c.id !== "fee"), version: review.version });
    expect(bumped.counts).toEqual({ files: 2, done: 0, partial: 0, pending: 2, failed: 0, coded: 0, stale: 1, privilegeFlags: 0 });
    const blank = await listRows(alice, set.id, review.id, {});
    for (const r of blank.rows) expect(r).toMatchObject({ status: "pending", cells: {}, issues: [], privilege: null, docType: null, rowHash: null });
    expect(blank.facets).toMatchObject({ docTypes: [], privilege: { possible: 0, likely: 0 }, coding: { key: 1, uncoded: 1, stale: 1 } });
    expect(await q({ coding: "stale" })).toEqual([deed]);
    expect(await q({ q: "mumbai" })).toEqual([]);
    const csvBlank = String((await exportReview(alice, set.id, review.id, "csv")).body);
    expect(csvBlank).not.toMatch(/Mumbai|Pune/);
    expect((await reviewRowsForChat(alice, [set.id], { reviewId: review.id })).rows.every((r) => r.values.length === 0 && r.docType === null)).toBe(true);
    // Coding a pending row binds to "" (shown), compare-and-set against the stored old hash.
    expect(await codeRow(alice, set.id, review.id, deed, { coding: "relevant", rowHash: "" })).toMatchObject({ decisionStale: false, decision: { rowHash: "" } });

    // A failure under the new basis stores no old result.
    ai.failReview = "SCANNED BUNDLE";
    try {
      expect(await runReview(alice, set.id, review.id)).toMatchObject({ processed: 1, failed: 1 });
    } finally { ai.failReview = ""; }
    const store = await docStore();
    expect(await store.getReviewRow(review.id, scanned)).toMatchObject({ state: "failed", result: null, rowHash: null, attempts: 1 });
    expect(await runReview(alice, set.id, review.id)).toMatchObject({ processed: 1, remaining: 0 });
    expect((await getReview(alice, set.id, review.id)).counts).toMatchObject({ done: 1, partial: 1, stale: 1, coded: 0 });

    const csv = parseCsv(String((await exportReview(alice, set.id, review.id, "csv")).body).replace(/^﻿/, "").replace(/\r/g, ""));
    const head = csv[0];
    const deedLine = csv.find((r) => r[0] === "deed.pdf")!;
    expect(deedLine[head.indexOf("Seat")]).toBe("Mumbai | conflicts with: Delhi (p. 3)");
    expect(deedLine[head.indexOf("Seat — status")]).toBe("conflict");
    expect(deedLine[head.indexOf("Arbitration clause — quote found")]).toBe("no");
    expect(csv.find((r) => r[0] === "scanned.pdf")![head.indexOf("Claim — status")]).toBe("not read");
    await expect(exportReview(bob, set.id, review.id, "csv")).rejects.toMatchObject({ status: 404 });

    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      ai.agentFailures = 1;
      const report = await runReport(alice, set.id, review.id, ["Where is the seat?", "What is claimed?"], () => {});
      expect(report).toMatchObject({ status: "partial", failed: [{ error: "model overloaded" }] });
      expect(report?.answers).toHaveLength(1);
      expect((await getReport(alice, set.id, review.id))?.status).toBe("partial");
    } finally {
      ai.agentFailures = 0;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    }

    await deleteSet(alice, set.id);
    const left = await psql.query({ query: `SELECT (SELECT count(*) FROM docs_review_rows) AS r, (SELECT count(*) FROM docs_reviews) AS v, (SELECT count(*) FROM docs_files) AS f` });
    expect(left[0]).toEqual({ r: "0", v: "0", f: "0" });
  }, 180_000);
});
