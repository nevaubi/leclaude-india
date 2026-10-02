import { describe, expect, it } from "vitest";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { encodeListCursor, decodeListCursor, listOfficialDocuments } from "@/modules/official/list";
import { anyWordsQuery, documentFilters, focusExcerpt, normalizeSearch, rrfFuse, searchOfficial } from "@/modules/official/search";
import { claimUnit, enqueueUnits, failUnit, MAX_ATTEMPTS, pgArray, releaseUnit } from "@/modules/official/units";
import { officialStatus } from "@/modules/official/status";
import { OFFICIAL_SCHEMA, OFFICIAL_SCHEMA_VERSION } from "@/modules/official/schema";
import { OfficialFakeStore } from "./official-fakes";

class Recorder implements RemoteStore {
  calls: SqlQuery[] = [];
  constructor(private reply: (q: SqlQuery) => Row[] = () => []) {}
  async query(q: SqlQuery) { this.calls.push(q); return this.reply(q); }
  async transaction(qs: SqlQuery[]) { const out: Row[][] = []; for (const q of qs) out.push(await this.query(q)); return out; }
}

describe("official_units queue SQL", () => {
  it("claims atomically: one UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) with a lease, attempt cap and backoff gate", async () => {
    const store = new Recorder((q) => (q.query.startsWith("UPDATE official_units SET status = 'running'") ? [{ id: "fetch:od_1", source: "nclt", stage: "fetch", key: "https://nclt.gov.in/x", document_id: "od_1", payload: '{"a":1}', priority: "10", status: "running", attempts: "1", error: null }] : []));
    const u = await claimUnit(store, { sources: ["nclt", "sci-orders"], stages: ["fetch", "ocr"] });
    expect(u).toMatchObject({ id: "fetch:od_1", stage: "fetch", documentId: "od_1", payload: { a: 1 }, priority: 10, attempts: 1 });
    const sql = store.calls[0].query.replace(/\s+/g, " ");
    expect(sql).toMatch(/^UPDATE official_units SET status = 'running', lease_until = now\(\) \+ interval '6 minutes', attempts = attempts \+ 1/);
    expect(sql).toContain("WHERE id = ( SELECT id FROM official_units WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND attempts < 5");
    expect(sql).toContain("AND (run_after IS NULL OR run_after <= now())");
    expect(sql).toContain("ORDER BY priority, id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *");
    expect(sql).toContain("AND NOT (source = ANY($3::text[]) AND stage = ANY($4::text[]))");
    expect(store.calls[0].params).toEqual(['{"nclt","sci-orders"}', '{"fetch","ocr"}', "{}", "{}"]); // nothing held
    await claimUnit(store, { sources: ["nclt", "sci-orders"], stages: ["fetch", "ocr"], hold: { sources: ["nclt"], stages: ["discover", "fetch"] } });
    expect(store.calls[1].params).toEqual(['{"nclt","sci-orders"}', '{"fetch","ocr"}', '{"nclt"}', '{"discover","fetch"}']);
    expect(await claimUnit(store, { sources: [], stages: ["fetch"] })).toBeNull();
    expect(store.calls).toHaveLength(2); // an empty filter claims nothing (and asks nothing)
  });

  it("enqueues with one INSERT … SELECT FROM jsonb_to_recordset; existing units are left alone unless re-queued", async () => {
    const store = new Recorder(() => [{ n: "2" }]);
    const n = await enqueueUnits(store, [{ id: "fetch:od_1", source: "nclt", stage: "fetch", key: "u1", documentId: "od_1" }, { id: "fetch:od_2", source: "nclt", stage: "fetch", key: "u2", documentId: "od_2", priority: 10 }]);
    expect(n).toBe(2);
    const sql = store.calls[0].query.replace(/\s+/g, " ");
    expect(sql).toContain("FROM jsonb_to_recordset($1::jsonb) AS x(id text, source text, stage text, key text, document_id text, payload jsonb, priority int, run_after timestamptz)");
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(JSON.parse(String(store.calls[0].params![0]))).toHaveLength(2);
    await enqueueUnits(store, [{ id: "fetch:od_1", source: "nclt", stage: "fetch", key: "u1" }], { requeue: true });
    // Finished units are re-queued; a pending one takes the new payload (keeping its attempts and backoff); running ones are untouched.
    expect(store.calls[1].query.replace(/\s+/g, " ")).toContain("WHERE (official_units.status IN ('done', 'failed', 'skipped')) OR official_units.status = 'pending'");
    expect(store.calls[1].query.replace(/\s+/g, " ")).toContain("attempts = CASE WHEN official_units.status = 'pending' THEN official_units.attempts ELSE 0 END");
    expect(await enqueueUnits(store, [])).toBe(0);
  });

  it("fails with exponential backoff, permanently on the last attempt, and gives the attempt back on release", async () => {
    const store = new Recorder();
    expect(await failUnit(store, { id: "u", attempts: 2 }, "timeout")).toBe("retry");
    expect(store.calls[0].query).toContain("interval '4 minutes'");
    expect(store.calls[0].params).toEqual(["u", "pending", "timeout"]);
    expect(await failUnit(store, { id: "u", attempts: MAX_ATTEMPTS }, "timeout")).toBe("failed");
    expect(await failUnit(store, { id: "u", attempts: 1 }, "404", { permanent: true })).toBe("failed");
    await releaseUnit(store, "u", { done: { "1": "x" } }, "resumes");
    expect(store.calls[3].query).toContain("attempts = greatest(attempts - 1, 0)");
    expect(JSON.parse(String(store.calls[3].params![1]))).toEqual({ done: { "1": "x" } });
  });

  it("quotes array parameters instead of interpolating them", () => {
    expect(pgArray(['a"b', "c\\d", "e,f"])).toBe('{"a\\"b","c\\\\d","e,f"}');
  });

  it("creates its schema additively and idempotently", () => {
    expect(OFFICIAL_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    for (const q of OFFICIAL_SCHEMA) expect(q.query).toMatch(/IF NOT EXISTS/);
  });
});

describe("hybrid ranking helpers", () => {
  it("fuses rankings with reciprocal rank fusion (items in both lists rise; ties keep first-list order)", () => {
    const fused = rrfFuse([["a", "b", "c"], ["c", "d", "a"]]);
    expect(fused.map((f) => f.key)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0].ranks).toEqual([1, 3]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 63, 10);
    expect(rrfFuse([["x", "y"]]).map((f) => f.key)).toEqual(["x", "y"]);
    expect(rrfFuse([["x", "x", "y"]])[0].score).toBeCloseTo(1 / 61, 10); // duplicates count once
  });

  it("cuts a verbatim excerpt around the densest cluster of query words", () => {
    const text = `${"Preliminary recitals. ".repeat(150)}The Tribunal holds that the moratorium under Section 14 applies to the guarantor. ${"Closing words. ".repeat(150)}`;
    const ex = focusExcerpt(text, "moratorium guarantor", 600);
    expect(ex.length).toBeLessThanOrEqual(600);
    expect(text.includes(ex)).toBe(true);
    expect(ex).toContain("moratorium under Section 14 applies to the guarantor");
    expect(focusExcerpt("short text", "anything")).toBe("short text");
  });

  it("validates queries and builds parameterised filters", () => {
    expect(() => normalizeSearch({ q: "  " })).toThrow(RangeError);
    expect(() => normalizeSearch({ q: "x", sources: ["nope" as never] })).toThrow(/unknown source/);
    expect(() => normalizeSearch({ q: "x", kinds: ["memo" as never] })).toThrow(/unknown kind/);
    expect(() => normalizeSearch({ q: "x", from: "01-10-2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => normalizeSearch({ q: "x", forum: "nclt'; drop" })).toThrow(/forum/);
    const n = normalizeSearch({ q: "  moratorium   guarantor ", sources: ["ibbi", "ibbi"], forum: "NCLT", from: "2026-01-01", limit: 500 });
    expect(n).toMatchObject({ q: "moratorium guarantor", sources: ["ibbi"], forum: "nclt", limit: 50, mode: "hybrid" });
    const params: (string | number | null)[] = ["q"];
    const where = documentFilters(n, params);
    expect(where).toEqual(["d.source = ANY($2::text[])", "(d.forum = $3 OR d.forum LIKE $3 || '-%')", "d.doc_date >= $4::date"]);
    expect(params).toEqual(["q", '{"ibbi"}', "nclt", "2026-01-01"]);
    expect(anyWordsQuery("Section 14 moratorium; guarantor's")).toBe("section | 14 | moratorium | guarantor"); // single letters dropped
    expect(anyWordsQuery("one")).toBeNull();
  });
});

describe("searchOfficial over the fake corpus", () => {
  function corpus() {
    const store = new OfficialFakeStore();
    const doc = (id: string, source: string, title: string, url: string) => store.docs.set(id, { id, source, kind: "order", url, file_url: null, title, doc_date: "2026-09-01", forum: null, status: "indexed", mime: "application/pdf", sha256: "x", bytes: 1, pages: 3, extraction: "text_layer", ocr_pages: [], ocr_model: null, language: "en", meta: {}, version: 1, history: [], fetch_provenance: null, text_sha256: "t", text_chars: 10, chunks: 2, embedded: 0, error: null, attempts: 1, fetched_at: null, indexed_at: null, extractor_version: 1, parse_result: null });
    doc("od_aaaaaaaaaaaaaaaaaaaaaaaa", "ibbi", "NCLAT order on guarantor moratorium", "https://ibbi.gov.in/a.pdf");
    doc("od_bbbbbbbbbbbbbbbbbbbbbbbb", "sebi-orders", "SEBI adjudication order", "https://www.sebi.gov.in/b.html");
    const chunk = (document_id: string, idx: number, page: number | null, text: string) => store.chunks.push({ document_id, idx, text_sha256: "t", page_start: page, page_end: page, heading: null, text, ocr: false, chars: text.length, embedding: null, embedding_model: null, embedding_dims: null });
    chunk("od_aaaaaaaaaaaaaaaaaaaaaaaa", 0, 1, "The appellant is the personal guarantor of the corporate debtor.");
    chunk("od_aaaaaaaaaaaaaaaaaaaaaaaa", 1, 3, "The moratorium under Section 14 does not extend to the personal guarantor.");
    chunk("od_bbbbbbbbbbbbbbbbbbbbbbbb", 0, null, "Penalty imposed for failure to make disclosures under the SAST Regulations.");
    return store;
  }

  it("returns citable hits with page refs (or chunk refs for page-less documents) and an explicit empty state", async () => {
    const store = corpus();
    const r = await searchOfficial({ q: "moratorium guarantor" }, store, { model: null });
    expect(r).toMatchObject({ mode: "keyword", empty: false, candidates: 1 });
    expect(r.hits[0]).toMatchObject({ ref: "src://od_aaaaaaaaaaaaaaaaaaaaaaaa#p3", chunkIndex: 1, sourceId: "ibbi", publisher: "Insolvency and Bankruptcy Board of India", pageStart: 3, match: "keyword", extraction: "text_layer" });
    const page = await searchOfficial({ q: "penalty disclosures" }, store, { model: null });
    expect(page.hits[0].ref).toBe("src://od_bbbbbbbbbbbbbbbbbbbbbbbb#c0");
    // OR-of-words fallback when the strict query finds nothing.
    const loose = await searchOfficial({ q: "guarantor electricity" }, store, { model: null });
    expect(loose.hits.map((h) => h.chunkIndex).sort()).toEqual([0, 1]);
    expect(store.calls.some((c) => c.query.includes("to_tsquery('english', $1)") && c.params?.[0] === "guarantor | electricity")).toBe(true);
    expect(await searchOfficial({ q: "wholly unrelated words" }, store, { model: null })).toMatchObject({ hits: [], empty: true });
    expect(await searchOfficial({ q: "guarantor", sources: [] }, store, { model: null })).toMatchObject({ hits: [], empty: true });
  });

  it("re-ranks keyword candidates by stored vectors (bytea mode) and fuses both rankings", async () => {
    const store = corpus();
    const vec = (hot: number) => { const v = new Float32Array(1024); v[hot] = 1; return v; };
    const hex = (v: Float32Array) => `\\x${Buffer.from(v.buffer).toString("hex")}`;
    for (const c of store.chunks) { c.embedding = hex(vec(c.idx === 0 ? 5 : 9)); c.embedding_model = "m"; c.embedding_dims = 1024; }
    const A = "od_aaaaaaaaaaaaaaaaaaaaaaaa", B = "od_bbbbbbbbbbbbbbbbbbbbbbbb";
    // Keyword order a#1, a#0, b#0; vectors put a#0 and b#0 first: fusion lifts a#0 to the top.
    store.keyword = () => [{ document_id: A, idx: 1 }, { document_id: A, idx: 0 }, { document_id: B, idx: 0 }];
    const r = await searchOfficial({ q: "guarantor" }, store, { model: "m", embed: async () => [vec(5)] });
    expect(r.mode).toBe("hybrid");
    expect(r.hits.map((h) => `${h.documentId.slice(3, 4)}#${h.chunkIndex}:${h.match}`)).toEqual(["a#0:both", "a#1:both", "b#0:both"]);
    // A vector of another model is never compared.
    for (const c of store.chunks) c.embedding_model = "other";
    const other = await searchOfficial({ q: "guarantor" }, store, { model: "m", embed: async () => [vec(5)] });
    expect(other.mode).toBe("keyword");
    // Embedding failure: keyword results stand.
    const k = await searchOfficial({ q: "guarantor" }, store, { model: "m", embed: async () => { throw new Error("provider down"); } });
    expect(k.mode).toBe("keyword");
    expect(k.hits).toHaveLength(3);
  });

  it("requires a store", async () => {
    await expect(searchOfficial({ q: "x" }, null)).rejects.toMatchObject({ code: "official_not_configured" });
  });
});

describe("listing and status", () => {
  it("round-trips keyset cursors and rejects tampered ones", () => {
    const c = encodeListCursor({ d: "2026-10-01", id: "od_abc" });
    expect(decodeListCursor(c)).toEqual({ d: "2026-10-01", id: "od_abc" });
    expect(() => decodeListCursor("not-a-cursor")).toThrow(RangeError);
    expect(() => decodeListCursor(Buffer.from(JSON.stringify({ d: "x", id: "od_1" })).toString("base64url"))).toThrow(RangeError);
  });

  it("builds a bounded, parameterised listing query and pages with a cursor", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `od_${i}`, source: "ibbi", kind: "order", url: `https://ibbi.gov.in/${i}`, file_url: null, title: `T${i}`, doc_date: "2026-10-0" + (3 - i), forum: "ibbi", status: "indexed", mime: null, sha256: null, bytes: null, pages: null, extraction: null, ocr_pages: "{}", ocr_model: null, language: null, meta: "{}", version: "1", fetched_at: null, indexed_at: null, error: null, attempts: "0", chunks: "0", embedded: "0", text_sha256: null }));
    const store = new Recorder((q) => (q.query.includes("FROM official_documents d") ? rows : q.query.includes("official_schema_version") ? [{ value: String(OFFICIAL_SCHEMA_VERSION) }] : []));
    const r = await listOfficialDocuments({ sources: ["ibbi"], q: "50% guarantor_", limit: 2 }, store);
    expect(r.documents.map((d) => d.id)).toEqual(["od_0", "od_1"]);
    expect(decodeListCursor(r.nextCursor)).toEqual({ d: "2026-10-02", id: "od_1" });
    const q = store.calls.find((c) => c.query.includes("FROM official_documents d"))!;
    expect(q.query).toContain("ORDER BY d.doc_date DESC NULLS LAST, d.id DESC LIMIT 3");
    expect(q.params).toContain("%50\\% guarantor\\_%");
    expect((await listOfficialDocuments({ kinds: [] }, store)).documents).toEqual([]);
    await expect(listOfficialDocuments({ sources: ["x" as never] }, store)).rejects.toThrow(RangeError);
  });

  it("reports every source with counts, queue, budget and embeddings mode; configured:false without a store", async () => {
    const off = await officialStatus(null);
    expect(off.configured).toBe(false);
    expect(off.sources.map((s) => s.id)).toContain("sat-orders");
    expect(off.sources.every((s) => s.stats.documents === 0)).toBe(true);
    const store = new OfficialFakeStore();
    store.units.set("fetch:od_1", { id: "fetch:od_1", source: "ibbi", stage: "fetch", key: "k", document_id: "od_1", payload: null, priority: 5, status: "pending", attempts: 0, error: null, note: null, run_after: null, lease_until: null, finished_at: null });
    const on = await officialStatus(store);
    expect(on).toMatchObject({ configured: true, dbBytes: 1_000_000, queue: { pending: 1, running: 0, failed: 0, done: 0 } });
    expect(on.limitBytes).toBe(60_000 * 1024 * 1024);
    expect(on.sources.find((s) => s.id === "sat-orders")?.enabled).toBe(false); // placeholder until an adapter registers
  });
});
