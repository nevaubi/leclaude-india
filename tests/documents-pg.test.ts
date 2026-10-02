import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemoteStore, Row, SqlQuery, SqlValue } from "@/lib/db/remote";

/**
 * Opt-in integration test: the document-set store against a real Postgres (reached with psql, Neon raw-text
 * semantics). Skipped unless DOCS_TEST_PG (or CORPUS_TEST_PG) is "host:port" (host may be a socket directory).
 *
 *   DOCS_TEST_PG=/tmp/pg:55432 npx vitest run tests/documents-pg.test.ts
 */
const PG = process.env.DOCS_TEST_PG || process.env.CORPUS_TEST_PG;

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/documents-pg-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
});

const ai = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  generateJSON: async (opts: { input: string }) => {
    ai.calls++;
    return String(opts.input).includes("indemnify")
      ? { facts: [{ statement: "The Contractor indemnifies the Client.", parties: [], category: "obligation", quote: "The Contractor shall indemnify the Client", page: 2, date: null }], events: [{ dateText: "03.04.2022", description: "Notice served", parties: [], quote: "indemnify the Client. Notice was served on 03.04.2022", page: 2 }] }
      : { facts: [], events: [] };
  },
  describeImage: async () => ({ text: "Scanned schedule naming Mumbai as the seat of arbitration.", responseId: "r" }),
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
    // One psql run: BEGIN … COMMIT, so a failing statement rolls every statement back (as Neon's batch does).
    execFileSync("psql", ["-h", this.host, "-p", this.port, "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"], { input: qs.map((q) => `${bind(q)};`).join("\n"), maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    return qs.map(() => []);
  }
}

describe.skipIf(!PG)("document sets on Postgres", () => {
  const principal = { id: "u_pg", name: "PG user", tenantId: "default", roles: ["associate" as const], matterIds: [] as string[], source: "dev" as const };
  let store: PsqlStore;

  beforeAll(async () => {
    const i = PG!.lastIndexOf(":");
    store = new PsqlStore(PG!.slice(0, i), PG!.slice(i + 1));
    await store.query({ query: `DROP TABLE IF EXISTS docs_chunks, docs_files, docs_sets, docs_extractions` });
    const { db, resetSqlite } = await import("@/lib/db");
    resetSqlite();
    db();
    const { setDocStoreForTests } = await import("@/modules/documents/server/store");
    const { PgDocStore } = await import("@/modules/documents/server/store-pg");
    setDocStoreForTests(new PgDocStore(store));
  });

  afterAll(async () => {
    const { setDocStoreForTests } = await import("@/modules/documents/server/store");
    setDocStoreForTests(null);
  });

  it("stores, searches, OCRs, extracts and deletes through the Postgres store", async () => {
    const { createSet, deleteSet, getFilePages, listFiles, listSets, storageStatus, resetStorageCacheForTests } = await import("@/modules/documents/server/sets");
    const { uploadBrowserPdf, uploadServerFile, appendPages, ocrPage } = await import("@/modules/documents/server/ingest");
    const { runExtraction, listTimeline, listFacts } = await import("@/modules/documents/server/extract");
    const { searchDocSets, readDocPassage } = await import("@/modules/documents/server");

    const set = await createSet(principal, { name: "PG bundle" });
    const up = await uploadBrowserPdf(principal, set.id, { kind: "pdf-text", name: "contract.pdf", size: 1000, sha256: "e".repeat(64), pages: ["It's the O'Brien agreement dated 3rd March, 2021.", "The Contractor shall indemnify the Client. Notice was served on 03.04.2022."], totalPages: 3 });
    expect(up).toMatchObject({ status: "created", file: { status: "partial", pagesReceived: 2 } });
    if (up.status !== "created") return;
    const dup = await uploadBrowserPdf(principal, set.id, { kind: "pdf-text", name: "again.pdf", size: 1000, sha256: "e".repeat(64), pages: ["x"] });
    expect(dup).toMatchObject({ status: "duplicate", file: { id: up.file.id } });
    // A concurrent duplicate that slips past the lookup hits the unique constraint and is reported as a duplicate.
    const { docStore, DuplicateFileError } = await import("@/modules/documents/server/store");
    const pg = await docStore();
    const raced = { ...(await pg.getFile(set.id, up.file.id))!, id: "dfile_race" };
    await expect(pg.insertFile(raced, [{ fileId: "dfile_race", setId: set.id, idx: 0, page: 1, text: "race", lead: 0 }])).rejects.toBeInstanceOf(DuplicateFileError);
    expect(await pg.getChunk("dfile_race", 0)).toBeNull(); // rolled back with the file row
    const appended = await appendPages(principal, set.id, up.file.id, { appendPages: [""], fromPage: 3 });
    expect(appended.file).toMatchObject({ status: "partial", ocrPages: [3], pagesReceived: 3 });
    const txt = await uploadServerFile(principal, set.id, { name: "memo.txt", mime: "text/plain", bytes: new TextEncoder().encode("Memo: delivery was late by six weeks.") });
    expect(txt.status).toBe("created");

    expect((await listFiles(principal, set.id, { q: "memo" })).total).toBe(1);
    expect((await listSets(principal)).find((s) => s.id === set.id)).toMatchObject({ fileCount: 2, pageCount: 4 });
    expect((await getFilePages(principal, set.id, up.file.id, 1)).pages).toEqual([{ page: 1, text: "It's the O'Brien agreement dated 3rd March, 2021." }]);

    const hits = await searchDocSets(principal, [set.id], "contractor indemnify");
    expect(hits[0]).toMatchObject({ page: 2, fileName: "contract.pdf" });
    const loose = await searchDocSets(principal, [set.id], "indemnify zebra");
    expect(loose.some((h) => h.page === 2)).toBe(true);
    expect((await readDocPassage(principal, hits[0].source))?.context).toMatch(/indemnify/);

    const png = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]).toString("base64")}`;
    const ocr = await ocrPage(principal, set.id, up.file.id, { page: 3, image: png });
    expect(ocr.file).toMatchObject({ status: "ready", ocrPages: [], ocrDonePages: [3] });
    expect((await searchDocSets(principal, [set.id], "seat arbitration Mumbai"))[0]).toMatchObject({ page: 3, ocr: true });
    // Indian scripts: whole words (vowel signs included) match in Postgres full-text search.
    const hindiSet = await createSet(principal, { name: "Hindi bundle" });
    await uploadBrowserPdf(principal, hindiSet.id, { kind: "pdf-text", name: "hindi.pdf", size: 100, sha256: "f".repeat(64), pages: ["यह किराया समझौता है। किरायेदार ने किराया नहीं दिया।"] });
    expect((await searchDocSets(principal, [hindiSet.id], "किराया")).map((h) => h.fileName)).toEqual(["hindi.pdf"]);
    await deleteSet(principal, hindiSet.id);

    const x = await runExtraction(principal, set.id, {});
    expect(x).toMatchObject({ processed: 2, failed: 0, remaining: 0 });
    const calls = ai.calls;
    expect(await runExtraction(principal, set.id, {})).toMatchObject({ processed: 0, remaining: 0 });
    expect(ai.calls).toBe(calls);
    expect((await listTimeline(principal, set.id, {})).events).toMatchObject([{ date: "2022-04-03", page: 2, quoteFound: true }]);
    expect((await listFacts(principal, set.id, {})).facts[0]).toMatchObject({ quoteFound: true, page: 2 });

    resetStorageCacheForTests();
    const storage = await storageStatus(true);
    expect(storage.backend).toBe("postgres");
    expect(storage.usedMb).toBeGreaterThan(1);
    expect(storage.limitMb).toBe(490);

    await deleteSet(principal, set.id);
    const left = await store.query({ query: `SELECT (SELECT count(*) FROM docs_chunks) AS c, (SELECT count(*) FROM docs_files) AS f, (SELECT count(*) FROM docs_extractions) AS x` });
    expect(left[0]).toEqual({ c: "0", f: "0", x: "0" });
  }, 120_000);

  it("drafting work items: atomic compare-and-set on the version column, and the version backfilled for older rows", async () => {
    const { PgWorkStore } = await import("@/modules/documents/server/work-store");
    // A table from before the version column, holding one item at JSON version 3.
    await store.query({ query: `DROP TABLE IF EXISTS docs_work` });
    await store.query({ query: `CREATE TABLE docs_work (set_id text NOT NULL, kind text NOT NULL, key text NOT NULL, data text NOT NULL, text_hash text, created_by text NOT NULL, updated_at text NOT NULL, PRIMARY KEY (set_id, kind, key))` });
    await store.query({ query: `INSERT INTO docs_work VALUES ('s1', 'dates', 'list', '{"version":3}', NULL, 'u', '2026-01-01')` });
    const ws = new PgWorkStore(store);
    const old = (await ws.get<{ version: number }>("s1", "dates", "list"))!;
    expect(old.version).toBe(3);
    const at = (v: number) => ({ setId: "s1", kind: "dates" as const, key: "list", data: { version: v }, textHash: null, createdBy: "u", updatedAt: "2026-01-02" });
    expect(await ws.putIfVersion(at(4), 2)).toBe(false); // stale expectation: nothing written
    expect(await ws.putIfVersion(at(4), 3)).toBe(true);
    expect(await ws.putIfVersion(at(5), 3)).toBe(false); // the second writer from version 3 loses
    expect((await ws.get<{ version: number }>("s1", "dates", "list"))!.version).toBe(4);
    expect(await ws.putIfVersion({ ...at(1), key: "new" }, 0)).toBe(true); // create
    expect(await ws.putIfVersion({ ...at(1), key: "new" }, 0)).toBe(false); // create over an existing row
    await ws.deleteSet("s1");
  });
});
