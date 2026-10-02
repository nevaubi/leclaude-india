import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { TokenBucket } from "@/lib/ai/toolkit/http";
import { ProviderError } from "@/modules/intel/providers/base";
import type { DiscoverResult, ParseInput, SourceAdapter } from "@/modules/official/adapter";
import { chunkMarkdown, scrubPersonalData, sha256Hex } from "@/modules/official/chunk";
import { embedPendingChunks, queueMissingEmbeddings } from "@/modules/official/embed";
import { extractDocument, extractFirecrawlMarkdown, extractPdf, pageMarkdown } from "@/modules/official/extract";
import { createOfficialHttp, type FirecrawlLike, type OfficialHttp } from "@/modules/official/http";
import { ocrDocument, type OcrModel } from "@/modules/official/ocr";
import { contentMismatch, documentIdFor, notYetUntil, scrubIndexedDocuments, scrubPages, upsertDiscovered } from "@/modules/official/pipeline";
import { readOfficialDocument } from "@/modules/official/read";
import { allowHostsFor, setOfficialAdaptersForTests } from "@/modules/official/registry";
import { requeueCappedOcr, runOfficialIngest } from "@/modules/official/run";
import { excerptPages, searchOfficial } from "@/modules/official/search";
import { officialStatus } from "@/modules/official/status";
import type { DiscoveredDoc, SourceDef } from "@/modules/official/types";
import { pgTimestampToIso } from "@/modules/official/units";
import { OfficialFakeStore, type FakeChunk, type FakeDoc } from "./official-fakes";

/**
 * Review fixes in the official-sources core (evidence integrity, personal data, boundedness, fairness, observability).
 * Fake adapter / fake HTTP / fake store throughout; no network, no database.
 */

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Pages: text → a text page; "IMAGE" → a scanned page; { stamp } → a full-page scan with a short text stamp on top; { logo } → text with a small logo. */
type PageSpec = string | { stamp: string } | { logo: string };
async function makePdf(pages: PageSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = await doc.embedPng(Buffer.from(PNG_1X1, "base64"));
  for (const spec of pages) {
    const page = doc.addPage([595, 842]);
    const lines = (t: string) => t.split("\n").forEach((line, i) => { if (line) page.drawText(line, { x: 50, y: 780 - i * 16, size: 11, font }); });
    if (spec === "IMAGE") { page.drawImage(png, { x: 50, y: 300, width: 400, height: 400 }); continue; }
    if (typeof spec === "object" && "stamp" in spec) { page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 }); lines(spec.stamp); continue; }
    if (typeof spec === "object" && "logo" in spec) { page.drawImage(png, { x: 260, y: 790, width: 40, height: 40 }); lines(spec.logo); continue; }
    lines(spec);
  }
  return doc.save();
}

const SCI: SourceDef = {
  id: "sci-orders", name: "Supreme Court orders (test)", publisher: "Supreme Court of India", kinds: ["judgment", "order"], forum: "sci",
  homepage: "https://www.sci.gov.in/", fetch: "direct", cadenceMinutes: 60, attribution: "Source: Supreme Court of India (sci.gov.in)", terms: "Government publication; verify against the official copy", enabled: true,
};
const DHC: SourceDef = {
  id: "dhc-causelist", name: "Delhi High Court cause lists (test)", publisher: "High Court of Delhi", kinds: ["cause_list"], forum: "hc-delhi",
  homepage: "https://delhihighcourt.nic.in/", fetch: "direct", cadenceMinutes: 60, attribution: "Source: High Court of Delhi", terms: "Government publication", enabled: true,
};

type Served = { bytes: Uint8Array; mime: string; finalUrl?: string } | null;
function httpFor(def: SourceDef, serve: (url: string) => Served | Promise<Served>, extra: Partial<OfficialHttp> = {}): OfficialHttp {
  return {
    def,
    allowHosts: allowHostsFor(def),
    firecrawlAllowed: def.fetch === "firecrawl_in",
    async fetchPage(url) { throw new ProviderError("t", "http", "HTTP 404 (not found)", false, 404, url); },
    async fetchFile(url) {
      const f = await serve(url);
      if (!f) throw new ProviderError(`official:${def.id}`, "http", `official:${def.id}: HTTP 404 (not found)`, false, 404, url);
      const finalUrl = f.finalUrl ?? url;
      return { url, finalUrl, status: 200, mime: f.mime, bytes: f.bytes, provenance: { via: "direct" as const, proxy: null, timezone: null, status: 200, finalUrl } };
    },
    async fetchJson() { throw new Error("not used"); },
    async postForm() { throw new Error("not used"); },
    async firecrawlPage() { return null; },
    async firecrawlDocument() { return null; },
    ...extra,
  };
}

function adapterFor(def: SourceDef, discover: (cursor: string | null) => DiscoverResult, parseCalls: ParseInput[] = []): SourceAdapter {
  return {
    def,
    async discover(ctx): Promise<DiscoverResult> { return discover(ctx.cursor); },
    parse(doc) { parseCalls.push(doc); return { records: [{ id: doc.id }], unparsed: 0 }; },
    async persist() { return { stored: 1 }; },
  };
}
const listing = (items: () => DiscoveredDoc[]) => () => ({ items: items(), nextCursor: null, done: true });

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1)));
const fakeEmbed = async (texts: string[]) => texts.map((t) => { const v = new Float32Array(1024); for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 1024] += 1; return v; });
const quiet = { sleep: tick, log: () => undefined };
const HTML_WAF = new TextEncoder().encode("<!DOCTYPE html><html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator. Your support ID is: 18394729384729384729. [Go Back]</body></html>");
const ORDER = "IN THE SUPREME COURT OF INDIA\nCIVIL APPELLATE JURISDICTION\nCivil Appeal No. 4321 of 2026\nThe written statement filed beyond ninety days shall be taken on record.";

function newDoc(store: OfficialFakeStore, d: Partial<FakeDoc> & { id: string; source: string; url: string }): FakeDoc {
  const doc: FakeDoc = { kind: "order", file_url: null, title: d.id, doc_date: null, forum: null, status: "indexed", mime: "application/pdf", sha256: "bytes", bytes: 1, pages: 1, extraction: "text_layer", ocr_pages: [], ocr_model: null, language: "en", meta: {}, version: 1, history: [], fetch_provenance: null, text_sha256: "t0", text_chars: 10, chunks: 0, embedded: 0, error: null, attempts: 1, fetched_at: null, indexed_at: null, extractor_version: 1, parse_result: null, ...d };
  store.docs.set(doc.id, doc);
  return doc;
}
function newChunk(store: OfficialFakeStore, c: Partial<FakeChunk> & { document_id: string; idx: number; text: string }): FakeChunk {
  const chunk: FakeChunk = { text_sha256: "t0", page_start: 1, page_end: 1, heading: null, ocr: false, chars: c.text.length, embedding: null, embedding_model: null, embedding_dims: null, ...c };
  store.chunks.push(chunk);
  return chunk;
}
const vec = (hot: number) => { const v = new Float32Array(1024); v[hot] = 1; return v; };
const hex = (v: Float32Array) => `\\x${Buffer.from(v.buffer).toString("hex")}`;

afterEach(() => setOfficialAdaptersForTests(null));

// ---------------------------------------------------------------------------
// 1 · HTML / WAF / soft-404 page served for a PDF
// ---------------------------------------------------------------------------

describe("content that is not the document", () => {
  it("classifies HTML for an expected PDF and an HTML page after a redirect elsewhere; accepts benign redirects", async () => {
    const pdf = await makePdf([ORDER]);
    expect(contentMismatch("https://www.sci.gov.in/a.pdf", "https://www.sci.gov.in/a.pdf", "text/html", HTML_WAF, true)).toMatch(/HTML page .* instead of the PDF/);
    expect(contentMismatch("https://www.sci.gov.in/a.pdf", null, "text/plain", new TextEncoder().encode("File not found"), true)).toMatch(/non-PDF content/);
    expect(contentMismatch("https://www.sci.gov.in/a.pdf", null, "application/pdf", pdf, true)).toBeNull();
    expect(contentMismatch("https://www.sci.gov.in/judgment/x.html", "https://www.sci.gov.in/", "text/html", HTML_WAF, false)).toMatch(/redirected to www\.sci\.gov\.in\//);
    expect(contentMismatch("http://sci.gov.in/judgment/x.html", "https://www.sci.gov.in/judgment/x.html/", "text/html", HTML_WAF, false)).toBeNull();
  });

  it("an indexed PDF re-fetched as a 200 HTML page keeps its version, hash and chunks; the attempt is a retryable failure with a reject note", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=11&type=o";
    let serve: Served = { bytes: await makePdf([ORDER]), mime: "application/pdf" };
    const items: DiscoveredDoc[] = [{ sourceId: "sci-orders", kind: "order", url, title: "Order 11", docDate: "2026-10-01", mime: "application/pdf", meta: { refetch: true } }];
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(SCI, listing(() => items)) });
    const store = new OfficialFakeStore();
    const http = httpFor(SCI, () => serve);
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, http: () => http, embedModel: null, ...quiet });
    const id = documentIdFor("sci-orders", url);
    const v1 = { ...store.docs.get(id)! };
    const chunksV1 = JSON.stringify(store.chunks.filter((c) => c.document_id === id));
    expect(v1).toMatchObject({ status: "indexed", version: 1 });

    serve = { bytes: HTML_WAF, mime: "text/html" };
    store.clock += 3 * 3600_000;
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, forceDiscover: true, http: () => http, embedModel: null, ...quiet });
    const after = store.docs.get(id)!;
    expect(after).toMatchObject({ status: "indexed", version: 1, sha256: v1.sha256, text_sha256: v1.text_sha256 });
    expect(JSON.stringify(store.chunks.filter((c) => c.document_id === id))).toBe(chunksV1);
    expect(store.units.get(`fetch:${id}`)).toMatchObject({ status: "pending", attempts: 1 });
    expect(store.units.get(`fetch:${id}`)!.error).toMatch(/HTML page/);
    expect(store.rejects.some((r) => r.stage === "fetch" && /instead of the PDF/.test(r.reason))).toBe(true);
    expect((await searchOfficial({ q: "Request Rejected administrator" }, store, { model: null })).empty).toBe(true);

    // The last attempt: the indexed version stays current (an error note, never "failed" with the WAF page).
    Object.assign(store.units.get(`fetch:${id}`)!, { attempts: 4, run_after: null });
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, stages: ["fetch"], http: () => http, embedModel: null, ...quiet });
    expect(store.docs.get(id)).toMatchObject({ status: "indexed", version: 1, sha256: v1.sha256 });
    expect(store.docs.get(id)!.error).toMatch(/re-fetch failed \(the indexed version is kept\)/);
    expect((await searchOfficial({ q: "ninety days written statement" }, store, { model: null })).empty).toBe(false);
  });

  it("a first fetch that only ever returns HTML for a PDF is never indexed", async () => {
    const url = "https://www.sci.gov.in/jonew/orders/2026/12.pdf";
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(SCI, listing(() => [{ sourceId: "sci-orders", kind: "order", url, title: "Order 12", docDate: "2026-10-01" }])) });
    const store = new OfficialFakeStore();
    const http = httpFor(SCI, () => ({ bytes: HTML_WAF, mime: "text/html" }));
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, http: () => http, embedModel: null, ...quiet });
    const id = documentIdFor("sci-orders", url);
    expect(store.docs.get(id)).toMatchObject({ status: "discovered", sha256: null, chunks: 0 });
    Object.assign(store.units.get(`fetch:${id}`)!, { attempts: 4, run_after: null });
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, stages: ["fetch"], http: () => http, embedModel: null, ...quiet });
    expect(store.docs.get(id)).toMatchObject({ status: "failed", sha256: null });
    expect(store.chunks.filter((c) => c.document_id === id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2 · OCR cut off at the output-token limit
// ---------------------------------------------------------------------------

describe("OCR stop reasons", () => {
  it("never accepts a transcription cut off at the output limit: the range is retried page by page; a page still cut off fails", async () => {
    const pdf = await makePdf(["IMAGE", "IMAGE", "IMAGE"]);
    const calls: number[][] = [];
    const model: OcrModel = {
      id: "fake",
      async transcribe(req) {
        calls.push(req.pages);
        if (req.pages.length > 1) return { text: req.pages.map((p) => `<!-- page ${p} -->\nTruncated range text ${p}`).join("\n"), stopReason: "max_tokens" };
        if (req.pages[0] === 3) return { text: "<!-- page 3 -->\nPartial page three", stopReason: "max_tokens" };
        return { text: `<!-- page ${req.pages[0]} -->\nComplete page ${req.pages[0]}`, stopReason: "end" };
      },
    };
    const r = await ocrDocument(pdf, [1, 2, 3], { model, concurrency: 1 });
    expect(calls).toEqual([[1, 2, 3], [1], [2], [3]]);
    expect(r.pages).toEqual([{ page: 1, text: "Complete page 1" }, { page: 2, text: "Complete page 2" }]);
    expect(r.failed).toEqual([{ page: 3, error: expect.stringMatching(/transcription cut off/) }]);
    expect(JSON.stringify(r.pages)).not.toMatch(/Truncated|Partial/);
    expect(r.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3 · Firecrawl page limit, sparse stamps over scans, unsupported containers
// ---------------------------------------------------------------------------

describe("extraction completeness", () => {
  it("flags a Firecrawl parse that may have stopped at the page limit", () => {
    const md = "Page one text\n\n---\n\n<!-- page 2 -->\n\nPage two text\n\n---\n\n<!-- page 3 -->\n\nPage three text";
    expect(extractFirecrawlMarkdown(md, 3, 300)).toMatchObject({ truncated: false, warning: null, pageCount: 3 });
    expect(extractFirecrawlMarkdown(md, 500, 3)).toMatchObject({ truncated: true, warning: expect.stringMatching(/first 3 of 500 pages/), pageCount: 500 });
    expect(extractFirecrawlMarkdown(md, null, 3)).toMatchObject({ truncated: true });
    expect(extractFirecrawlMarkdown("No markers at all", null, 300)).toMatchObject({ paged: false, truncated: true, warning: expect.stringMatching(/did not report the page count/) });
    expect(extractFirecrawlMarkdown("No markers at all", 12, 300)).toMatchObject({ paged: false, truncated: false });
  });

  it("sends a page whose only text is a stamp over a full-page scan to OCR; a text page with a small logo is not", async () => {
    const stamp = "Neutral Citation No. 2026:DHC:12345 Digitally signed by REGISTRAR";
    const body = `ORDER\n${"The petitioner seeks quashing of the impugned notice dated 01.09.2026 issued under the Act. ".repeat(6)}`;
    const ex = await extractPdf(await makePdf([{ stamp }, { logo: body }]));
    expect(ex.ocrPages).toEqual([1]);
    expect(ex.pages[0].text).toBe("");
    expect(ex.quality.find((q) => q.page === 1)).toMatchObject({ readable: true, hasImages: true, needsOcr: true });
    expect(ex.quality.find((q) => q.page === 2)).toMatchObject({ needsOcr: false });
    expect(ex.pages[1].text).toContain("quashing of the impugned notice");
  });

  it("an XLSX / DOCX container the parser cannot open is unsupported (excluded with a reason), not a retried failure", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x63, 0x00, ...Array.from({ length: 200 }, (_, i) => (i * 37) % 256)]);
    const sheet = await extractDocument({ bytes: zip, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", url: "https://www.sebi.gov.in/x.xlsx" });
    expect(sheet).toMatchObject({ kind: "unsupported", method: null });
    expect(sheet.warning).toMatch(/unsupported or damaged spreadsheet ZIP container/);
    const doc = await extractDocument({ bytes: zip, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", url: "https://www.sebi.gov.in/x.docx" });
    expect(doc).toMatchObject({ kind: "unsupported", method: null });
  });
});

// ---------------------------------------------------------------------------
// 4 · Semantic (pgvector) search: no padding with unrelated neighbours
// ---------------------------------------------------------------------------

describe("semantic search cutoff", () => {
  function vectorCorpus() {
    const store = new OfficialFakeStore();
    store.pgvector = true;
    newDoc(store, { id: "od_aaaaaaaaaaaaaaaaaaaaaaaa", source: "ibbi", url: "https://ibbi.gov.in/a.pdf", chunks: 2 });
    newDoc(store, { id: "od_bbbbbbbbbbbbbbbbbbbbbbbb", source: "ibbi", url: "https://ibbi.gov.in/b.pdf", chunks: 1, text_sha256: "t-new" }); // its chunk is of an older text version
    newChunk(store, { document_id: "od_aaaaaaaaaaaaaaaaaaaaaaaa", idx: 0, text: "The personal guarantor is bound by the moratorium.", embedding: hex(vec(5)), embedding_model: "m", embedding_dims: 1024 });
    newChunk(store, { document_id: "od_aaaaaaaaaaaaaaaaaaaaaaaa", idx: 1, text: "Costs are awarded to the respondent.", embedding: hex(vec(9)), embedding_model: "m", embedding_dims: 1024 });
    newChunk(store, { document_id: "od_bbbbbbbbbbbbbbbbbbbbbbbb", idx: 0, text: "Stale text of a replaced version.", embedding: hex(vec(5)), embedding_model: "m", embedding_dims: 1024 });
    store.keyword = () => [];
    return store;
  }

  it("a query that matches nothing returns empty:true (nearest neighbours beyond the distance cutoff are not hits)", async () => {
    const store = vectorCorpus();
    const none = await searchOfficial({ q: "xqzv blorf wuggle" }, store, { model: "m", embed: async () => [vec(700)] });
    expect(none).toMatchObject({ hits: [], empty: true });
    expect(store.calls.some((c) => /embedding_v <=>/.test(c.query))).toBe(true);
  });

  it("close neighbours are hits with their similarity; chunks of a replaced text version never are", async () => {
    const store = vectorCorpus();
    const r = await searchOfficial({ q: "guarantor moratorium" }, store, { model: "m", embed: async () => [vec(5)] });
    expect(r.empty).toBe(false);
    expect(r.hits.map((h) => `${h.documentId}#${h.chunkIndex}`)).toEqual(["od_aaaaaaaaaaaaaaaaaaaaaaaa#0"]);
    expect(r.hits[0]).toMatchObject({ match: "semantic", similarity: 1 });
    const loose = await searchOfficial({ q: "guarantor moratorium" }, store, { model: "m", embed: async () => [vec(5)], maxDistance: 2 });
    expect(loose.hits.map((h) => h.chunkIndex)).toEqual([0, 1]); // with no cutoff, the unrelated chunk pads the list
    expect(loose.hits.some((h) => h.documentId === "od_bbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5 · Contact data never reaches chunks, search, embeddings or parsers
// ---------------------------------------------------------------------------

describe("contact-data scrub", () => {
  const TEN_DIGITS = /(?<![\d])\d{10}(?!\d)/;

  it("scrubs phones, e-mails and meeting links deterministically and leaves case numbers, CNRs, citations and amounts", () => {
    const r = scrubPersonalData("A. SHARMA (Mob. 98100 12345, adv@x.in) https://dhcvirtualcourt.webex.com/meet/x W.P.(C) 1234/2026 CNR DLHC010012342026 (2026) 5 SCC 123 Rs. 1500000000 Ph: 011-23388922");
    expect(r.text).toBe("A. SHARMA (Mob. [phone removed], [e-mail removed]) [link removed] W.P.(C) 1234/2026 CNR DLHC010012342026 (2026) 5 SCC 123 Rs. 1500000000 Ph: [phone removed]");
    expect(r.counts).toEqual({ phones: 2, emails: 1, links: 1 });
    expect(scrubPersonalData(r.text).text).toBe(r.text); // idempotent
    expect(scrubPersonalData("see https://www.sci.gov.in/x", { allLinks: true }).text).toBe("see [link removed]");
    expect(scrubPersonalData("see https://www.sci.gov.in/x").text).toBe("see https://www.sci.gov.in/x");
  });

  it("indexes a cause list (PDF and the DHC markdown fixture) with no phone number, e-mail or VC link in any chunk; hashes stay honest", async () => {
    const md = readFileSync("tests/fixtures/official/courts/dhc-causelist-03.10.2026.md", "utf8");
    const pdfUrl = "https://delhihighcourt.nic.in/files/causelist/2026-10-05-court3.pdf";
    const pdf = await makePdf(["CAUSE LIST FOR 05.10.2026 COURT NO. 3\n1. W.P.(C) 1234/2026 RAM KUMAR V/s UNION OF INDIA\nADVOCATE: A. SHARMA Mob. 9876543210 adv@x.in"]);
    const parseCalls: ParseInput[] = [];
    const items: DiscoveredDoc[] = [
      { sourceId: "dhc-causelist", kind: "cause_list", url: pdfUrl, title: "Court 3", docDate: "2026-10-05" },
      { sourceId: "dhc-causelist", kind: "cause_list", url: "https://delhihighcourt.nic.in/cause-list/2026-10-05", title: "Main list", docDate: "2026-10-05", text: md },
    ];
    setOfficialAdaptersForTests({ "dhc-causelist": adapterFor(DHC, listing(() => items), parseCalls) });
    const store = new OfficialFakeStore();
    const r = await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, http: () => httpFor(DHC, (u) => (u === pdfUrl ? { bytes: pdf, mime: "application/pdf" } : null)), embedModel: "test-embed", embed: fakeEmbed, ...quiet });
    expect(r.total.indexed).toBe(2);
    const all = store.chunks.map((c) => c.text).join("\n");
    expect(all).not.toMatch(/@/);
    expect(all).not.toMatch(TEN_DIGITS);
    expect(all).not.toMatch(/webex|9000000|1100000003/i);
    expect(all).toContain("[phone removed]");
    expect(all).toContain("[e-mail removed]");
    expect(all).toContain("W.P.(C)-5812/2016");
    expect(all).toContain("W.P.(C) 1234/2026");
    const doc = store.docs.get(documentIdFor("dhc-causelist", pdfUrl))!;
    expect(doc.meta).toMatchObject({ scrubVersion: 1, redacted: { phones: 1, emails: 1, links: 0 } });
    expect(doc.sha256).toBe(sha256Hex(pdf)); // the publisher's bytes, verifiable at the URL
    expect(doc.text_sha256).toBe(sha256Hex(pageMarkdown(scrubPages((await extractPdf(pdf)).pages, "cause_list").pages, true))); // the scrubbed text
    expect(doc.meta.scrubSha).toBe(doc.text_sha256);
    const mdDoc = store.docs.get(documentIdFor("dhc-causelist", "https://delhihighcourt.nic.in/cause-list/2026-10-05"))!;
    expect((mdDoc.meta.redacted as { emails: number }).emails).toBeGreaterThanOrEqual(8);
    expect((await searchOfficial({ q: "9876543210" }, store, { model: null })).empty).toBe(true);
    expect(parseCalls.every((p) => !/@|9876543210/.test(p.markdown) && !/@/.test(JSON.stringify(p.pages)))).toBe(true);
    // The listing text is not kept on the finished extract unit.
    expect(store.units.get(`extract:${mdDoc.id}`)?.payload?.text).toBeUndefined();
  });

  it("backfills documents indexed before the scrubber: rewrites only changed chunks, moves doc + chunks to one new text version, clears their vectors, is idempotent", async () => {
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_cl1", source: "dhc-causelist", kind: "cause_list", url: "https://delhihighcourt.nic.in/a.pdf", chunks: 2, embedded: 2 });
    newChunk(store, { document_id: "od_cl1", idx: 0, text: "1. W.P.(C) 1234/2026 A. SHARMA (9876543210) (ADV.ONE@EXAMPLE.COM)", embedding: hex(vec(1)), embedding_model: "m", embedding_dims: 1024 });
    newChunk(store, { document_id: "od_cl1", idx: 1, text: "2. W.P.(C) 99/2026 B. RAO", embedding: hex(vec(2)), embedding_model: "m", embedding_dims: 1024 });
    newDoc(store, { id: "od_old_failed", source: "sci-orders", url: "https://www.sci.gov.in/x.pdf", status: "failed", chunks: 1 });
    newChunk(store, { document_id: "od_old_failed", idx: 0, text: "Stale text with 9123456789" });
    store.units.set("extract:od_ds", { id: "extract:od_ds", source: "mca-master", stage: "extract", key: "k", document_id: "od_ds", payload: { text: "raw listing with 9123456789" }, priority: 20, status: "done", attempts: 1, error: null, note: null, run_after: null, lease_until: null, finished_at: store.clock });

    const r = await scrubIndexedDocuments(store, { limit: 10, deadline: Date.now() + 60_000, now: Date.now, embedModel: "m" });
    expect(r).toMatchObject({ documents: 1, changed: 1, chunks: 1, purged: 1, payloads: 1, redacted: { phones: 1, emails: 1, links: 0 } });
    const d = store.docs.get("od_cl1")!;
    const cs = store.chunks.filter((c) => c.document_id === "od_cl1");
    expect(d.text_sha256).not.toBe("t0");
    expect(cs.every((c) => c.text_sha256 === d.text_sha256)).toBe(true);
    expect(cs[0].text).toBe("1. W.P.(C) 1234/2026 A. SHARMA ([phone removed]) ([e-mail removed])");
    expect(cs[0].embedding).toBeNull(); // re-embedded from the scrubbed text
    expect(cs[1].embedding).not.toBeNull();
    expect(d).toMatchObject({ embedded: 1, meta: { scrubVersion: 1, scrubSha: d.text_sha256, redacted: { phones: 1, emails: 1 } } });
    expect(store.units.get("index:od_cl1")).toMatchObject({ status: "pending", stage: "index" });
    expect(store.chunks.some((c) => c.document_id === "od_old_failed")).toBe(false);
    expect(store.units.get("extract:od_ds")!.payload).toEqual({});
    expect((await searchOfficial({ q: "9876543210" }, store, { model: null })).empty).toBe(true);
    // Idempotent: nothing left to do.
    expect(await scrubIndexedDocuments(store, { limit: 10, deadline: Date.now() + 60_000, now: Date.now })).toMatchObject({ documents: 0, changed: 0, purged: 0, payloads: 0 });
  });

  it("two overlapping backfills leave one consistent version", async () => {
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_cl2", source: "dhc-causelist", kind: "cause_list", url: "https://delhihighcourt.nic.in/b.pdf", chunks: 2 });
    newChunk(store, { document_id: "od_cl2", idx: 0, text: "Mob. 98100 12345 x@y.in" });
    newChunk(store, { document_id: "od_cl2", idx: 1, text: "Ph: 011-23388922" });
    const o = { limit: 10, deadline: Date.now() + 60_000, now: Date.now };
    await Promise.all([scrubIndexedDocuments(store, o), scrubIndexedDocuments(store, o)]);
    const d = store.docs.get("od_cl2")!;
    const cs = store.chunks.filter((c) => c.document_id === "od_cl2");
    expect(cs.every((c) => c.text_sha256 === d.text_sha256 && c.text_sha256 !== "t0")).toBe(true);
    expect(cs.map((c) => c.text)).toEqual(["Mob. [phone removed] [e-mail removed]", "Ph: [phone removed]"]);
    expect(d.meta.scrubSha).toBe(d.text_sha256);
  });

  it("re-scrubs a document re-indexed by code that does not scrub (its text version no longer matches meta.scrubSha)", async () => {
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_cl3", source: "dhc-causelist", kind: "cause_list", url: "https://delhihighcourt.nic.in/c.pdf", chunks: 1, text_sha256: "t-reindexed", meta: { scrubVersion: 1, scrubSha: "t-before" } });
    newChunk(store, { document_id: "od_cl3", idx: 0, text: "contact 9876543210", text_sha256: "t-reindexed" });
    const r = await scrubIndexedDocuments(store, { limit: 10, deadline: Date.now() + 60_000, now: Date.now });
    expect(r.changed).toBe(1);
    expect(store.chunks[0].text).toBe("contact [phone removed]");
  });
});

// ---------------------------------------------------------------------------
// 6 · The run is bounded by its deadline; an interrupted unit is released
// ---------------------------------------------------------------------------

describe("deadline and abort", () => {
  it("a fetch in flight when the caller aborts is released: attempt given back, document not failed", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=21";
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(SCI, listing(() => [{ sourceId: "sci-orders", kind: "order", url, title: "Order 21", docDate: "2026-10-01" }])) });
    const store = new OfficialFakeStore();
    const caller = new AbortController();
    const http = httpFor(SCI, () => new Promise<Served>((_, reject) => {
      caller.signal.addEventListener("abort", () => reject(new Error("socket hang up")), { once: true });
      setTimeout(() => caller.abort(), 20);
    }));
    const r = await runOfficialIngest({ store, deadlineMs: 120_000, concurrency: 1, signal: caller.signal, http: () => http, embedModel: null, ...quiet });
    expect(r.stop).toBe("deadline");
    const id = documentIdFor("sci-orders", url);
    expect(store.units.get(`fetch:${id}`)).toMatchObject({ status: "pending", attempts: 0, error: null });
    expect(store.units.get(`fetch:${id}`)!.note).toMatch(/deadline/);
    expect(store.docs.get(id)).toMatchObject({ status: "discovered", error: null });
  });

  it("the run's own deadline aborts in-flight work and releases the unit", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=22";
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(SCI, listing(() => [{ sourceId: "sci-orders", kind: "order", url, title: "Order 22", docDate: "2026-10-01" }])) });
    const store = new OfficialFakeStore();
    const http = httpFor(SCI, () => new Promise<Served>((_, reject) => setTimeout(() => reject(new ProviderError("official:sci-orders", "network", "connect ETIMEDOUT", true)), 1_400)));
    const started = Date.now();
    const r = await runOfficialIngest({ store, deadlineMs: 1_000, minUnitMs: 0, concurrency: 1, http: () => http, embedModel: null, ...quiet });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.stop).toBe("deadline");
    expect(store.units.get(`fetch:${documentIdFor("sci-orders", url)}`)).toMatchObject({ status: "pending", attempts: 0 });
  });
});

// ---------------------------------------------------------------------------
// Fairness, embedding scheduling and budget
// ---------------------------------------------------------------------------

describe("scheduling", () => {
  function recordClaims(store: OfficialFakeStore): string[] {
    const order: string[] = [];
    const query = store.query.bind(store);
    store.query = async (q) => {
      const rows = await query(q);
      if (q.query.startsWith("UPDATE official_units SET status = 'running'") && rows[0]) order.push(String(rows[0].id));
      return rows;
    };
    return order;
  }

  it("later stages (embeddings) are claimed while a long fetch backlog is still pending", async () => {
    const pdf = await makePdf([ORDER]);
    const urls = Array.from({ length: 8 }, (_, i) => `https://www.sci.gov.in/sci-get-pdf/?diary_no=${100 + i}`);
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(SCI, listing(() => urls.map((url, i) => ({ sourceId: "sci-orders", kind: "order", url, title: `Order ${i}`, docDate: "2026-10-01" })))) });
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_ready", source: "sci-orders", url: "https://www.sci.gov.in/ready.pdf", chunks: 1 });
    newChunk(store, { document_id: "od_ready", idx: 0, text: "Already indexed text awaiting embeddings." });
    store.units.set("index:od_ready", { id: "index:od_ready", source: "sci-orders", stage: "index", key: "k", document_id: "od_ready", payload: null, priority: 40, status: "pending", attempts: 0, error: null, note: null, run_after: null, lease_until: null, finished_at: null });
    const order = recordClaims(store);
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, scrubPerRun: 0, http: () => httpFor(SCI, () => ({ bytes: pdf, mime: "application/pdf" })), embedModel: "m", embed: fakeEmbed, ...quiet });
    // With one worker, every fourth claim tries the later stages first (index units in priority / id order).
    const firstIndex = order.findIndex((id) => id.startsWith("index:"));
    const lastFetch = Math.max(...order.map((id, i) => (id.startsWith("fetch:") ? i : -1)));
    expect(firstIndex).toBe(3);
    expect(firstIndex).toBeLessThan(lastFetch);
    expect(order.filter((id, i) => id.startsWith("index:") && i < lastFetch).length).toBeGreaterThanOrEqual(2);
    expect(store.chunks.find((c) => c.document_id === "od_ready")!.embedding).not.toBeNull();
  });

  it("queues embeddings for indexed documents with unembedded chunks (documents indexed while embeddings were off)", async () => {
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_e1", source: "ibbi", url: "u1", chunks: 3, embedded: 0 });
    newDoc(store, { id: "od_e2", source: "ibbi", url: "u2", chunks: 3, embedded: 3 });
    newDoc(store, { id: "od_e3", source: "ibbi", url: "u3", chunks: 2, embedded: 0 });
    store.units.set("index:od_e3", { id: "index:od_e3", source: "ibbi", stage: "index", key: "u3", document_id: "od_e3", payload: null, priority: 40, status: "failed", attempts: 5, error: "dims", note: null, run_after: null, lease_until: null, finished_at: 1 });
    expect(await queueMissingEmbeddings(store, ["ibbi"], 100, 40)).toBe(1);
    expect(store.units.get("index:od_e1")).toMatchObject({ status: "pending", stage: "index" });
    expect(store.units.has("index:od_e2")).toBe(false);
    expect(store.units.get("index:od_e3")!.status).toBe("failed"); // left to the bounded redrive
    expect(await queueMissingEmbeddings(store, ["ibbi"], 100, 40)).toBe(0); // idempotent while pending
  });

  it("does not claim index units once the run's embedding budget is used (no claim / release loop)", async () => {
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(SCI, listing(() => [])) });
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_b1", source: "sci-orders", url: "u", chunks: 1 });
    newChunk(store, { document_id: "od_b1", idx: 0, text: "Text." });
    store.units.set("index:od_b1", { id: "index:od_b1", source: "sci-orders", stage: "index", key: "u", document_id: "od_b1", payload: null, priority: 40, status: "pending", attempts: 0, error: null, note: null, run_after: null, lease_until: null, finished_at: null });
    const order = recordClaims(store);
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 2, embedMaxChunks: 0, scrubPerRun: 0, http: () => httpFor(SCI, () => null), embedModel: "m", embed: fakeEmbed, ...quiet });
    expect(order.filter((id) => id.startsWith("index:"))).toEqual([]);
    expect(store.units.get("index:od_b1")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("an embedding computed for text that changed meanwhile is not written; the unit reports rows remaining", async () => {
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_g1", source: "ibbi", url: "u", chunks: 1 });
    const c = newChunk(store, { document_id: "od_g1", idx: 0, text: "Old text." });
    const embed = async (texts: string[]) => { c.text_sha256 = "t1"; c.text = "New text."; return texts.map(() => vec(3)); };
    const r = await embedPendingChunks(store, { documentId: "od_g1", maxChunks: 10, embed, model: "m" });
    expect(r).toMatchObject({ embedded: 0, remaining: true, error: null });
    expect(c.embedding).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Discovery cursors, "not yet published", re-fetch throttle
// ---------------------------------------------------------------------------

describe("discovery and 404s", () => {
  it("keeps the adapter's cursor when a pass is done (a 'last seen' mark the next pass resumes from)", async () => {
    const seen: (string | null)[] = [];
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(SCI, (cursor) => { seen.push(cursor); return { items: [], nextCursor: "lastSeen:1300", done: true }; }) });
    const store = new OfficialFakeStore();
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, http: () => httpFor(SCI, () => null), embedModel: null, ...quiet });
    expect(JSON.parse(store.state.get("official_cursor:sci-orders")!)).toBe("lastSeen:1300");
    expect(store.units.get("discover:sci-orders")!.status).toBe("done");
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, forceDiscover: true, http: () => httpFor(SCI, () => null), embedModel: null, ...quiet });
    expect(seen).toEqual([null, "lastSeen:1300"]);
  });

  it("a 404 for a cause list of today is 'not yet published': re-checked later without consuming attempts; an old one is final", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const fresh = "https://delhihighcourt.nic.in/files/cl-today.pdf";
    const old = "https://delhihighcourt.nic.in/files/cl-old.pdf";
    setOfficialAdaptersForTests({ "dhc-causelist": adapterFor(DHC, listing(() => [
      { sourceId: "dhc-causelist", kind: "cause_list", url: fresh, title: "Today", docDate: today, meta: { urlFromPattern: true, listDate: today } },
      { sourceId: "dhc-causelist", kind: "cause_list", url: old, title: "Old", docDate: "2026-01-05" },
    ])) });
    const store = new OfficialFakeStore();
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, http: () => httpFor(DHC, () => null), embedModel: null, ...quiet });
    const f = documentIdFor("dhc-causelist", fresh);
    expect(store.units.get(`fetch:${f}`)).toMatchObject({ status: "pending", attempts: 0, payload: { notYetChecks: 1 } });
    expect(store.units.get(`fetch:${f}`)!.run_after).toBe(store.clock + 30 * 60_000);
    expect(store.docs.get(f)).toMatchObject({ status: "discovered" });
    expect(store.docs.get(f)!.error).toMatch(/^not yet published/);
    const o = documentIdFor("dhc-causelist", old);
    expect(store.docs.get(o)).toMatchObject({ status: "failed", error: "not published at this URL (HTTP 404)" });
    expect(store.units.get(`fetch:${o}`)).toMatchObject({ status: "failed" });
  });

  it("re-check windows: cause lists until the day after the list date; pattern orders until three days after their date", () => {
    const day = (iso: string) => Date.parse(`${iso}T00:00:00+05:30`);
    expect(notYetUntil({ kind: "cause_list", docDate: "2026-10-01", meta: { listDate: "2026-10-05" } })).toBe(day("2026-10-07"));
    expect(notYetUntil({ kind: "order", docDate: "2026-10-01", meta: { urlFromPattern: true, orderDate: "2026-10-02" } })).toBe(day("2026-10-06"));
    expect(notYetUntil({ kind: "order", docDate: "2026-10-01", meta: { urlFromPattern: true } })).toBe(day("2026-10-05"));
    expect(notYetUntil({ kind: "order", docDate: null, meta: {} })).toBeNull();
  });

  it("re-fetches a 'not published' document its listing shows again (bounded; never for pattern URLs); refetch is throttled", async () => {
    const store = new OfficialFakeStore();
    const mk = (url: string, finishedAgoMin: number) => {
      const id = documentIdFor("sci-orders", url);
      newDoc(store, { id, source: "sci-orders", url, status: "failed", error: "not published at this URL (HTTP 404)", sha256: null });
      store.units.set(`fetch:${id}`, { id: `fetch:${id}`, source: "sci-orders", stage: "fetch", key: url, document_id: id, payload: null, priority: 20, status: "failed", attempts: 1, error: "HTTP 404", note: null, run_after: null, lease_until: null, finished_at: store.clock - finishedAgoMin * 60_000 });
      return id;
    };
    const a = mk("https://www.sci.gov.in/a.pdf", 7 * 60);
    const b = mk("https://www.sci.gov.in/b.pdf", 60);
    const c = mk("https://www.sci.gov.in/c.pdf", 7 * 60);
    await upsertDiscovered(store, SCI, [
      { sourceId: "sci-orders", kind: "order", url: "https://www.sci.gov.in/a.pdf", title: "A", docDate: null },
      { sourceId: "sci-orders", kind: "order", url: "https://www.sci.gov.in/b.pdf", title: "B", docDate: null },
      { sourceId: "sci-orders", kind: "order", url: "https://www.sci.gov.in/c.pdf", title: "C", docDate: null, meta: { urlFromPattern: true } },
    ]);
    expect(store.units.get(`fetch:${a}`)!.status).toBe("pending");
    expect(store.units.get(`fetch:${b}`)!.status).toBe("failed"); // looked at less than 6 hours ago
    expect(store.units.get(`fetch:${c}`)!.status).toBe("failed"); // a pattern URL is not vouched for by a listing

    // meta.refetch re-queues a finished fetch only when it is older than OFFICIAL_REFETCH_MIN_MINUTES.
    const d = documentIdFor("sci-orders", "https://www.sci.gov.in/d.pdf");
    newDoc(store, { id: d, source: "sci-orders", url: "https://www.sci.gov.in/d.pdf" });
    store.units.set(`fetch:${d}`, { id: `fetch:${d}`, source: "sci-orders", stage: "fetch", key: "d", document_id: d, payload: null, priority: 20, status: "done", attempts: 1, error: null, note: null, run_after: null, lease_until: null, finished_at: store.clock - 30 * 60_000 });
    const item = { sourceId: "sci-orders" as const, kind: "order" as const, url: "https://www.sci.gov.in/d.pdf", title: "D", docDate: null, meta: { refetch: true } };
    await upsertDiscovered(store, SCI, [item]);
    expect(store.units.get(`fetch:${d}`)!.status).toBe("done");
    store.clock += 2 * 3600_000;
    await upsertDiscovered(store, SCI, [item]);
    expect(store.units.get(`fetch:${d}`)!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// OCR: progress per range, resume, re-target, raised cap; stale version guard
// ---------------------------------------------------------------------------

describe("OCR across runs", () => {
  it("saves progress per range, releases at an abort and resumes with only the missing pages", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=31";
    const pdf = await makePdf(Array.from({ length: 8 }, () => "IMAGE"));
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(SCI, listing(() => [{ sourceId: "sci-orders", kind: "order", url, title: "Scan", docDate: "2026-10-01" }])) });
    const store = new OfficialFakeStore();
    const http = () => httpFor(SCI, () => ({ bytes: pdf, mime: "application/pdf" }));
    const caller = new AbortController();
    const first: OcrModel = {
      id: "m1",
      async transcribe(req) {
        if (req.pages[0] === 7) { caller.abort(); throw new Error("This operation was aborted"); }
        return req.pages.map((p) => `<!-- page ${p} -->\nOrder text page ${p} (call 98100 12345)`).join("\n");
      },
    };
    const r1 = await runOfficialIngest({ store, deadlineMs: 240_000, concurrency: 1, signal: caller.signal, http, ocrModel: first, embedModel: null, ...quiet });
    expect(r1.stop).toBe("deadline");
    const id = documentIdFor("sci-orders", url);
    const unit = store.units.get(`ocr:${id}`)!;
    expect(unit).toMatchObject({ status: "pending", attempts: 0 });
    const done = unit.payload!.done as Record<string, string>;
    expect(Object.keys(done).sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(Object.values(done).join(" ")).not.toMatch(/98100/); // progress is stored scrubbed
    const asked: number[][] = [];
    const second: OcrModel = { id: "m2", async transcribe(req) { asked.push(req.pages); return req.pages.map((p) => `<!-- page ${p} -->\nOrder text page ${p}`).join("\n"); } };
    await runOfficialIngest({ store, deadlineMs: 240_000, concurrency: 1, http, ocrModel: second, embedModel: null, ...quiet });
    expect(asked).toEqual([[7, 8]]);
    expect(store.docs.get(id)).toMatchObject({ status: "indexed", extraction: "ocr_model", ocr_pages: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect((store.docs.get(id)!.meta.redacted as { phones: number }).phones).toBe(6);
  });

  it("an OCR request queued for an earlier version re-targets the current one; a version change during OCR writes nothing", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=32";
    const pdf = await makePdf([ORDER, "IMAGE"]);
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(SCI, listing(() => [])) });
    const store = new OfficialFakeStore();
    const id = documentIdFor("sci-orders", url);
    newDoc(store, { id, source: "sci-orders", url, status: "ocr_needed", sha256: sha256Hex(pdf), text_sha256: null });
    store.units.set(`ocr:${id}`, { id: `ocr:${id}`, source: "sci-orders", stage: "ocr", key: url, document_id: id, payload: { sha256: "an-older-version", pages: [1, 2, 3] }, priority: 30, status: "pending", attempts: 0, error: null, note: null, run_after: null, lease_until: null, finished_at: null });
    const asked: number[][] = [];
    const model: OcrModel = { id: "m", async transcribe(req) { asked.push(req.pages); return req.pages.map((p) => `<!-- page ${p} -->\nInterim order on page ${p}`).join("\n"); } };
    await runOfficialIngest({ store, deadlineMs: 240_000, concurrency: 1, scrubPerRun: 0, http: () => httpFor(SCI, () => ({ bytes: pdf, mime: "application/pdf" })), ocrModel: model, embedModel: null, ...quiet });
    expect(asked).toEqual([[2]]);
    expect(store.docs.get(id)).toMatchObject({ status: "indexed", ocr_pages: [2] });

    // Now a newer fetch lands while the OCR runs: nothing is written for the old version; the unit re-targets later.
    const store2 = new OfficialFakeStore();
    newDoc(store2, { id, source: "sci-orders", url, status: "ocr_needed", sha256: sha256Hex(pdf), text_sha256: null });
    store2.units.set(`ocr:${id}`, { id: `ocr:${id}`, source: "sci-orders", stage: "ocr", key: url, document_id: id, payload: { sha256: sha256Hex(pdf), pages: [2] }, priority: 30, status: "pending", attempts: 0, error: null, note: null, run_after: null, lease_until: null, finished_at: null });
    const racing: OcrModel = { id: "m", async transcribe(req) { store2.docs.get(id)!.sha256 = "a-newer-version"; return `<!-- page ${req.pages[0]} -->\nText`; } };
    await runOfficialIngest({ store: store2, deadlineMs: 240_000, concurrency: 1, scrubPerRun: 0, stages: ["ocr"], http: () => httpFor(SCI, () => ({ bytes: pdf, mime: "application/pdf" })), ocrModel: racing, embedModel: null, ...quiet });
    expect(store2.chunks).toHaveLength(0);
    expect(store2.docs.get(id)!.status).toBe("ocr_needed");
    expect(store2.units.get(`ocr:${id}`)!.payload).toEqual({ sha256: null });
  });

  it("documents left above an older OCR cap are re-queued once the cap is raised (bounded, idempotent)", async () => {
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_c1", source: "gst-council", url: "https://gstcouncil.gov.in/m1.pdf", status: "ocr_needed", error: "120 page(s) have no usable text layer, above the OCR cap (OFFICIAL_OCR_MAX_PAGES=80); not indexed" });
    newDoc(store, { id: "od_c2", source: "gst-council", url: "https://gstcouncil.gov.in/m2.pdf", status: "ocr_needed", error: "900 page(s) have no usable text layer, above the OCR cap (OFFICIAL_OCR_MAX_PAGES=80); not indexed" });
    expect(await requeueCappedOcr(store, ["gst-council"], 400, 50)).toBe(1);
    expect(store.units.get("ocr:od_c1")).toMatchObject({ status: "pending", stage: "ocr", payload: { sha256: null } });
    expect(store.docs.get("od_c1")!.error).toBe("120 page(s) queued for OCR (OFFICIAL_OCR_MAX_PAGES raised to 400)");
    expect(store.units.has("ocr:od_c2")).toBe(false);
    expect(await requeueCappedOcr(store, ["gst-council"], 400, 50)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Firecrawl: served host, transport switch, partial cause lists
// ---------------------------------------------------------------------------

describe("Firecrawl fallback provenance", () => {
  const FC_SCI: SourceDef = { ...SCI, fetch: "firecrawl_in" };
  const permissive = () => new TokenBucket(1000, 1000);
  const fc = (page: Record<string, unknown>): FirecrawlLike => ({ configured: true, async scrapeRich(url) { return { url, markdown: "# x", links: [], json: null, logo: null, rawHtml: "<h1>x</h1>", proxyUsed: "basic", timezone: "Asia/Kolkata", numPages: 1, contentType: "application/pdf", statusCode: 200, ...page }; } });

  it("refuses a Firecrawl copy served from a host outside the source's allowlist", async () => {
    const fetchImpl = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const http = createOfficialHttp(FC_SCI, { fetchImpl, firecrawl: fc({ url: "https://evil.example.com/landing" }), limiterFor: permissive, retries: 0, sleep: async () => undefined });
    await expect(http.firecrawlDocument("https://www.sci.gov.in/a.pdf")).rejects.toThrow(/not one of the source's hosts/);
    await expect(http.fetchPage("https://www.sci.gov.in/a")).rejects.toThrow(/not one of the source's hosts/);
  });

  it("a switch from the publisher's bytes to a Firecrawl parse is not a new version; a partial cause list is not indexed", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=41";
    const pdf = await makePdf([ORDER]);
    let direct = true;
    setOfficialAdaptersForTests({ "sci-orders": adapterFor(FC_SCI, listing(() => [{ sourceId: "sci-orders", kind: "order", url, title: "Order 41", docDate: "2026-10-01", mime: "application/pdf", meta: { refetch: true } }])) });
    const store = new OfficialFakeStore();
    const http = httpFor(FC_SCI, () => { if (direct) return { bytes: pdf, mime: "application/pdf" }; throw new ProviderError("official:sci-orders", "rate_limited", "throttled (503)", true, 503, url); }, {
      async firecrawlDocument() { return { markdown: `${ORDER}\n\n---\n\n<!-- page 2 -->\n\nSecond page as parsed`, numPages: 2, provenance: { via: "firecrawl" as const, proxy: "basic", timezone: "Asia/Kolkata", status: 200, finalUrl: url }, contentType: "application/pdf" }; },
    });
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, http: () => http, embedModel: null, ...quiet });
    const id = documentIdFor("sci-orders", url);
    expect(store.docs.get(id)).toMatchObject({ status: "indexed", version: 1 });
    direct = false;
    store.clock += 3 * 3600_000;
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, forceDiscover: true, http: () => http, embedModel: null, ...quiet });
    const d = store.docs.get(id)!;
    expect(d).toMatchObject({ status: "indexed", version: 1, extraction: "firecrawl_pdf", history: [] });
    expect(d.fetch_provenance).toMatchObject({ via: "firecrawl", hashOf: "firecrawl_markdown" });

    // A cause list whose Firecrawl parse stopped at the page limit: rejected, never indexed as the complete list.
    const clUrl = "https://delhihighcourt.nic.in/files/cl-long.pdf";
    const FC_DHC: SourceDef = { ...DHC, fetch: "firecrawl_in" };
    setOfficialAdaptersForTests({ "dhc-causelist": adapterFor(FC_DHC, listing(() => [{ sourceId: "dhc-causelist", kind: "cause_list", url: clUrl, title: "Long list", docDate: "2026-10-05", mime: "application/pdf" }])) });
    const store2 = new OfficialFakeStore();
    const partial = httpFor(FC_DHC, () => { throw new ProviderError("official:dhc-causelist", "network", "connect ETIMEDOUT", true); }, {
      async firecrawlDocument() { return { markdown: "Item 1\n\n---\n\n<!-- page 2 -->\n\nItem 2", numPages: 600, provenance: { via: "firecrawl" as const, proxy: "basic", timezone: "Asia/Kolkata", status: 200, finalUrl: clUrl }, contentType: "application/pdf" }; },
    });
    await runOfficialIngest({ store: store2, deadlineMs: 60_000, concurrency: 1, http: () => partial, embedModel: null, ...quiet });
    const cl = store2.docs.get(documentIdFor("dhc-causelist", clUrl))!;
    expect(cl.status).not.toBe("indexed");
    expect(store2.chunks).toHaveLength(0);
    expect(store2.rejects.some((r) => /partial cause list is not indexed/.test(r.reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Citations, read and status
// ---------------------------------------------------------------------------

describe("citations and status", () => {
  it("cites the page an excerpt starts on (page marks), the chunk when the page cannot be established", async () => {
    const p1 = `ORDER SHEET ${"Recital of the earlier proceedings in the matter. ".repeat(12)}`.trim();
    const p2 = `${"The tribunal considered the record and the submissions in detail. ".repeat(30)}The moratorium under Section 14 does not extend to the personal guarantor.`;
    const chunks = chunkMarkdown(pageMarkdown([{ page: 1, text: p1 }, { page: 2, text: p2 }], true));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].pageMarks).toEqual([[0, 1], [p1.length + 2, 2]]);
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_pm1", source: "ibbi", url: "https://ibbi.gov.in/pm1.pdf", chunks: 1 });
    newDoc(store, { id: "od_pm2", source: "ibbi", url: "https://ibbi.gov.in/pm2.pdf", chunks: 1 });
    newChunk(store, { document_id: "od_pm1", idx: 0, text: chunks[0].text, page_start: 1, page_end: 2, page_marks: chunks[0].pageMarks });
    newChunk(store, { document_id: "od_pm2", idx: 0, text: chunks[0].text, page_start: 1, page_end: 2 }); // indexed before page marks
    const r = await searchOfficial({ q: "moratorium personal guarantor" }, store, { model: null });
    const byDoc = new Map(r.hits.map((h) => [h.documentId, h]));
    expect(byDoc.get("od_pm1")).toMatchObject({ ref: "src://od_pm1#p2", pageStart: 2, pageEnd: 2 });
    expect(byDoc.get("od_pm2")!.ref).toBe("src://od_pm2#c0");
    expect(excerptPages({ pageStart: 3, pageEnd: 3, marks: null }, 500, 100)).toEqual({ page: 3, pageEnd: 3 });
  });

  it("serves only the current text of an indexed document", async () => {
    const store = new OfficialFakeStore();
    newDoc(store, { id: "od_rd1", source: "ibbi", url: "https://ibbi.gov.in/r1.pdf", chunks: 2, text_sha256: "t-current" });
    newChunk(store, { document_id: "od_rd1", idx: 0, text: "Current text.", text_sha256: "t-current" });
    newChunk(store, { document_id: "od_rd1", idx: 1, text: "Leftover of an older version.", text_sha256: "t-old" });
    const read = await readOfficialDocument("od_rd1", {}, store);
    expect(read!.chunks.map((c) => c.text)).toEqual(["Current text."]);
    store.docs.get("od_rd1")!.status = "failed";
    expect(await readOfficialDocument("od_rd1", {}, store)).toMatchObject({ chunks: [], hasMore: false });
    expect((await searchOfficial({ q: "current text" }, store, { model: null })).empty).toBe(true);
  });

  it("converts Postgres timestamp text to ISO and reports why a source has nothing (discover unit, cursor, recent errors)", async () => {
    expect(pgTimestampToIso("2026-10-02 09:00:00.123456+00")).toBe("2026-10-02T09:00:00.123Z");
    expect(pgTimestampToIso("2026-10-02 14:30:00+05:30")).toBe("2026-10-02T09:00:00.000Z");
    expect(pgTimestampToIso("2026-10-02T09:00:00Z")).toBe("2026-10-02T09:00:00.000Z");
    expect(pgTimestampToIso("not a date")).toBeNull();
    const store = new OfficialFakeStore();
    store.units.set("discover:egazette", { id: "discover:egazette", source: "egazette", stage: "discover", key: "egazette", document_id: null, payload: null, priority: 0, status: "pending", attempts: 3, error: "official:egazette: access denied (403)", note: null, run_after: store.clock + 8 * 60_000, lease_until: null, finished_at: null });
    store.state.set("official_cursor:egazette", JSON.stringify("id:1300"));
    const s = await officialStatus(store);
    const eg = s.sources.find((x) => x.id === "egazette") as (typeof s.sources)[number] & { discovery: Record<string, unknown>; recentErrors: { stage: string; error: string }[] };
    expect(eg.discovery).toMatchObject({ status: "pending", attempts: 3, error: "official:egazette: access denied (403)", cursor: "id:1300" });
    expect(eg.discovery.runAfter).toBe(new Date(store.clock + 8 * 60_000).toISOString());
    expect(eg.recentErrors).toEqual([expect.objectContaining({ stage: "discover", error: "official:egazette: access denied (403)" })]);
  });
});
