import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ProviderError } from "@/modules/intel/providers/base";
import type { DiscoverResult, ParseInput, SourceAdapter } from "@/modules/official/adapter";
import type { OfficialHttp } from "@/modules/official/http";
import type { OcrModel } from "@/modules/official/ocr";
import { documentIdFor } from "@/modules/official/pipeline";
import { allowHostsFor, setOfficialAdaptersForTests } from "@/modules/official/registry";
import { runOfficialIngest } from "@/modules/official/run";
import { readOfficialDocument } from "@/modules/official/read";
import { searchOfficial } from "@/modules/official/search";
import type { DiscoveredDoc, SourceDef } from "@/modules/official/types";
import { OfficialFakeStore } from "./official-fakes";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Pages: a string → a text page; "IMAGE" → an image-only (scanned) page; "" → a blank page. */
async function makePdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = await doc.embedPng(Buffer.from(PNG_1X1, "base64"));
  for (const text of pages) {
    const page = doc.addPage([595, 842]);
    if (text === "IMAGE") { page.drawImage(png, { x: 50, y: 300, width: 400, height: 400 }); continue; }
    text.split("\n").forEach((line, i) => { if (line) page.drawText(line, { x: 50, y: 780 - i * 16, size: 11, font }); });
  }
  return doc.save();
}

const DEF: SourceDef = {
  id: "sci-orders", name: "Supreme Court orders (test)", publisher: "Supreme Court of India", kinds: ["judgment", "order"], forum: "sci",
  homepage: "https://www.sci.gov.in/", fetch: "direct", cadenceMinutes: 60, attribution: "Source: Supreme Court of India (sci.gov.in)", terms: "Government publication; verify against the official copy", enabled: true,
};

function fakeHttp(files: Record<string, { bytes: Uint8Array; mime: string }>, calls: string[] = []): OfficialHttp {
  const prov = (url: string) => ({ via: "direct" as const, proxy: null, timezone: null, status: 200, finalUrl: url });
  return {
    def: DEF,
    allowHosts: allowHostsFor(DEF),
    firecrawlAllowed: false,
    async fetchPage(url) { calls.push(`page ${url}`); throw new ProviderError("t", "http", "HTTP 404 (not found)", false, 404, url); },
    async fetchFile(url) {
      calls.push(`file ${url}`);
      const f = files[url];
      if (!f) throw new ProviderError("official:sci-orders", "http", "official:sci-orders: HTTP 404 (not found)", false, 404, url);
      return { url, finalUrl: url, status: 200, mime: f.mime, bytes: f.bytes, provenance: prov(url) };
    },
    async fetchJson() { throw new Error("not used"); },
    async postForm() { throw new Error("not used"); },
    async firecrawlPage() { return null; },
    async firecrawlDocument() { return null; },
  };
}

const ORDER_P1 = "IN THE SUPREME COURT OF INDIA\nCIVIL APPELLATE JURISDICTION\nCivil Appeal No. 1234 of 2026\nThe appeal concerns the limitation period for filing a written statement.";
const ORDER_P2 = "ORDER\nHaving heard learned counsel for the parties, the appeal is allowed.\nThe written statement filed beyond ninety days shall be taken on record.";

function adapter(items: () => DiscoveredDoc[], parseCalls: ParseInput[] = []): SourceAdapter {
  return {
    def: DEF,
    async discover(): Promise<DiscoverResult> { return { items: items(), nextCursor: null, done: true }; },
    parse(doc) { parseCalls.push(doc); return { records: [{ id: doc.id }], unparsed: 0 }; },
    async persist() { return { stored: 1 }; },
  };
}

const fakeEmbed = async (texts: string[]) => texts.map((t) => { const v = new Float32Array(1024); for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 1024] += 1; return v; });
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1)));

afterEach(() => setOfficialAdaptersForTests(null));

describe("runOfficialIngest end to end (fake adapter, fake fetch, fake store)", () => {
  it("discovers, fetches, extracts, chunks, embeds and parses; rejects off-host items; a 404 is 'not published'", async () => {
    const pdfUrl = "https://www.sci.gov.in/sci-get-pdf/?diary_no=1&type=o&order_date=2026-10-01";
    const missingUrl = "https://api.sci.gov.in/jonew/missing.pdf";
    const pdf = await makePdf([ORDER_P1, ORDER_P2]);
    const items: DiscoveredDoc[] = [
      { sourceId: "sci-orders", kind: "order", url: pdfUrl, title: "Civil Appeal No. 1234 of 2026 — order", docDate: "2026-10-01", meta: { caseNumbers: ["CA/1234/2026"] } },
      { sourceId: "sci-orders", kind: "judgment", url: "https://www.sci.gov.in/judgment/abc", title: "Listing text judgment", docDate: "2026-09-30", text: "The Court held that the notice under Section 138 must be issued within thirty days of the information of dishonour." },
      { sourceId: "sci-orders", kind: "order", url: missingUrl, title: "Missing order", docDate: "2026-10-01" },
      { sourceId: "sci-orders", kind: "order", url: "https://evil.example.com/x.pdf", title: "Off-host", docDate: null },
    ];
    const parseCalls: ParseInput[] = [];
    setOfficialAdaptersForTests({ "sci-orders": adapter(() => items, parseCalls) });
    const store = new OfficialFakeStore();
    const calls: string[] = [];
    const http = fakeHttp({ [pdfUrl]: { bytes: pdf, mime: "application/pdf" } }, calls);
    const logs: Record<string, unknown>[] = [];
    const r = await runOfficialIngest({ store, deadlineMs: 120_000, concurrency: 2, sleep: tick, http: () => http, embedModel: "test-embed", embed: fakeEmbed, log: (l) => logs.push(l) });

    expect(r.stop).toBe("done");
    expect(r.total).toMatchObject({ sourceId: "all", discovered: 3, fetched: 1, indexed: 2, failed: 1 });
    const pdfDoc = store.docs.get(documentIdFor("sci-orders", pdfUrl))!;
    expect(pdfDoc.id).toMatch(/^od_[0-9a-f]{24}$/);
    expect(pdfDoc).toMatchObject({ status: "indexed", extraction: "text_layer", pages: 2, mime: "application/pdf", version: 1, language: "en", forum: "sci" });
    expect(pdfDoc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pdfDoc.fetch_provenance).toMatchObject({ via: "direct", status: 200 });
    const chunks = store.chunks.filter((c) => c.document_id === pdfDoc.id);
    expect(chunks.length).toBe(pdfDoc.chunks);
    expect(chunks.every((c) => c.text_sha256 === pdfDoc.text_sha256 && !c.text.includes("<!-- page"))).toBe(true);
    expect(chunks[0].page_start).toBe(1);
    expect(chunks.map((c) => c.text).join("\n")).toContain("ninety days");
    // Embeddings: every chunk embedded with the model id and 1024 dims; the document count follows.
    expect(chunks.every((c) => c.embedding && c.embedding_model === "test-embed" && c.embedding_dims === 1024)).toBe(true);
    expect(pdfDoc.embedded).toBe(chunks.length);
    // Parsed deterministically with positional items from the text layer.
    expect(parseCalls.find((p) => p.id === pdfDoc.id)?.items?.length).toBeGreaterThan(0);
    expect(pdfDoc.parse_result).toMatchObject({ records: 1, unparsed: 0, stored: 1 });

    const textDoc = store.docs.get(documentIdFor("sci-orders", "https://www.sci.gov.in/judgment/abc"))!;
    expect(textDoc).toMatchObject({ status: "indexed", extraction: "dataset", mime: "text/plain" });
    expect(calls.some((c) => c.includes("judgment/abc"))).toBe(false); // listing text: never fetched

    const missing = store.docs.get(documentIdFor("sci-orders", missingUrl))!;
    expect(missing.status).toBe("failed");
    expect(missing.error).toMatch(/not published/);
    expect(store.units.get(`fetch:${missing.id}`)).toMatchObject({ status: "failed", attempts: 1 }); // a 404 is not retried
    expect(store.rejects.map((x) => [x.stage, x.url])).toEqual(expect.arrayContaining([["discover", "https://evil.example.com/x.pdf"], ["fetch", missingUrl]]));
    expect([...store.docs.values()].some((d) => d.url.includes("evil.example.com"))).toBe(false);
    expect(JSON.parse(store.state.get("official_discover:sci-orders")!)).toMatchObject({ found: 3, inserted: 3, rejected: 1, done: true });
    const runLog = logs.find((l) => l.event === "official.run")!;
    expect(runLog).toMatchObject({ stop: "done", indexed: 2, failed: 1 });
    expect(JSON.stringify(runLog)).not.toContain("ninety days"); // no document text in logs

    // Search and read over what was indexed: stable refs, verbatim excerpts, publisher attribution.
    const s = await searchOfficial({ q: "written statement ninety days" }, store, { model: null });
    expect(s.empty).toBe(false);
    expect(s.mode).toBe("keyword");
    expect(s.hits[0]).toMatchObject({ documentId: pdfDoc.id, sourceId: "sci-orders", publisher: "Supreme Court of India", url: pdfUrl, match: "keyword" });
    expect(s.hits[0].ref).toMatch(new RegExp(`^src://${pdfDoc.id}#p\\d+$`));
    const none = await searchOfficial({ q: "electricity tariff regulation" }, store, { model: null });
    expect(none).toMatchObject({ empty: true, hits: [] });
    const read = await readOfficialDocument(s.hits[0].ref, {}, store);
    expect(read?.document.id).toBe(pdfDoc.id);
    expect(read?.chunks.map((c) => c.text).join(" ")).toContain("appeal is allowed");
    expect(read?.attribution).toContain("Supreme Court of India");
    const blankPage = await readOfficialDocument(pdfDoc.id, { page: 9 }, store);
    expect(blankPage).toMatchObject({ chunks: [], hasMore: false, nextChunk: null }); // never the nearest page

    // A re-discovery that asks for a refetch of unchanged bytes: nothing is re-indexed, the version stays.
    items[0] = { ...items[0], meta: { ...items[0].meta, refetch: true } };
    const before = store.chunks.length;
    const r2 = await runOfficialIngest({ store, deadlineMs: 120_000, concurrency: 1, sleep: tick, forceDiscover: true, http: () => http, embedModel: "test-embed", embed: fakeEmbed, log: () => undefined });
    expect(r2.stop).toBe("done");
    expect(r2.total).toMatchObject({ discovered: 0, fetched: 1, skipped: 1, indexed: 0 });
    expect(store.docs.get(pdfDoc.id)).toMatchObject({ version: 1, status: "indexed" });
    expect(store.chunks.length).toBe(before);
  });

  it("changed bytes at the same URL become version 2 with the previous hash in history", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=2";
    const files = { [url]: { bytes: await makePdf([ORDER_P1]), mime: "application/pdf" } };
    const items: DiscoveredDoc[] = [{ sourceId: "sci-orders", kind: "order", url, title: "Order", docDate: "2026-10-01", meta: { refetch: true } }];
    setOfficialAdaptersForTests({ "sci-orders": adapter(() => items) });
    const store = new OfficialFakeStore();
    const http = fakeHttp(files);
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, sleep: tick, http: () => http, embedModel: null, log: () => undefined });
    const id = documentIdFor("sci-orders", url);
    const first = store.docs.get(id)!.sha256;
    files[url] = { bytes: await makePdf([ORDER_P1, ORDER_P2]), mime: "application/pdf" };
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, sleep: tick, forceDiscover: true, http: () => http, embedModel: null, log: () => undefined });
    const d = store.docs.get(id)!;
    expect(d.version).toBe(2);
    expect(d.sha256).not.toBe(first);
    expect(d.history).toEqual([expect.objectContaining({ version: 1, sha256: first })]);
    expect(d.pages).toBe(2);
    expect(store.chunks.filter((c) => c.document_id === id).map((c) => c.text).join(" ")).toContain("appeal is allowed");
    // Embeddings off: no index (embedding) units queued; chunks stay keyword-searchable.
    expect([...store.units.values()].some((u) => u.stage === "index")).toBe(false);
  });

  it("a new version that cannot be indexed yet removes the previous version's chunks (never served as current)", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=5";
    const files = { [url]: { bytes: await makePdf([ORDER_P1]), mime: "application/pdf" } };
    setOfficialAdaptersForTests({ "sci-orders": adapter(() => [{ sourceId: "sci-orders", kind: "order", url, title: "Order", docDate: null, meta: { refetch: true } }]) });
    const store = new OfficialFakeStore();
    const http = fakeHttp(files);
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, sleep: tick, http: () => http, embedModel: null, log: () => undefined });
    const id = documentIdFor("sci-orders", url);
    expect(store.chunks.filter((c) => c.document_id === id).length).toBeGreaterThan(0);
    files[url] = { bytes: await makePdf(["IMAGE", "IMAGE"]), mime: "application/pdf" };
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, sleep: tick, forceDiscover: true, http: () => http, embedModel: null, maxOcrPages: 1, log: () => undefined });
    expect(store.docs.get(id)).toMatchObject({ status: "ocr_needed", version: 2, chunks: 0, embedded: 0, text_sha256: null });
    expect(store.chunks.filter((c) => c.document_id === id)).toHaveLength(0);
    expect((await searchOfficial({ q: "limitation period written statement" }, store, { model: null })).empty).toBe(true);
  });

  it("OCRs only the scanned page, keeps page markers, labels the text as OCR and records the model", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=3";
    const pdf = await makePdf([ORDER_P1, "IMAGE", ""]);
    setOfficialAdaptersForTests({ "sci-orders": adapter(() => [{ sourceId: "sci-orders", kind: "order", url, title: "Scanned order", docDate: "2026-10-02" }]) });
    const store = new OfficialFakeStore();
    const requests: number[][] = [];
    const model: OcrModel = { id: "fake-ocr-1", async transcribe(req) { requests.push(req.pages); return req.pages.map((p) => `<!-- page ${p} -->\n\nORDER\nThe interim stay granted earlier is extended until the next date of hearing (page ${p}).`).join("\n\n"); } };
    const r = await runOfficialIngest({ store, deadlineMs: 120_000, concurrency: 1, sleep: tick, http: () => fakeHttp({ [url]: { bytes: pdf, mime: "application/pdf" } }), ocrModel: model, embedModel: null, log: () => undefined });
    expect(r.stop).toBe("done");
    expect(requests).toEqual([[2]]); // never the text-layer page, never the blank page
    const d = store.docs.get(documentIdFor("sci-orders", url))!;
    expect(d).toMatchObject({ status: "indexed", extraction: "ocr_model", ocr_pages: [2], ocr_model: "fake-ocr-1", pages: 3 });
    const chunks = store.chunks.filter((c) => c.document_id === d.id);
    const all = chunks.map((c) => c.text).join("\n");
    expect(all).toContain("interim stay granted earlier is extended until the next date of hearing (page 2)");
    expect(all).toContain("CIVIL APPELLATE JURISDICTION");
    expect(chunks.some((c) => c.ocr && c.page_start! <= 2 && (c.page_end ?? c.page_start)! >= 2)).toBe(true);
    expect(r.total.ocr).toBe(1);
  });

  it("a document needing more OCR pages than the cap stays ocr_needed with a note (never silently truncated)", async () => {
    const url = "https://www.sci.gov.in/sci-get-pdf/?diary_no=4";
    const pdf = await makePdf(["IMAGE", "IMAGE", "IMAGE"]);
    setOfficialAdaptersForTests({ "sci-orders": adapter(() => [{ sourceId: "sci-orders", kind: "order", url, title: "Long scan", docDate: null }]) });
    const store = new OfficialFakeStore();
    let calls = 0;
    const model: OcrModel = { id: "fake", async transcribe() { calls++; return ""; } };
    await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, sleep: tick, http: () => fakeHttp({ [url]: { bytes: pdf, mime: "application/pdf" } }), ocrModel: model, maxOcrPages: 2, embedModel: null, log: () => undefined });
    const d = store.docs.get(documentIdFor("sci-orders", url))!;
    expect(d.status).toBe("ocr_needed");
    expect(d.error).toMatch(/3 page\(s\).*OFFICIAL_OCR_MAX_PAGES=2.*not indexed/);
    expect(calls).toBe(0);
    expect(store.chunks.filter((c) => c.document_id === d.id)).toHaveLength(0);
  });

  it("stops with 'budget' before claiming work when the database is over OFFICIAL_MAX_DB_MB", async () => {
    setOfficialAdaptersForTests({ "sci-orders": adapter(() => [{ sourceId: "sci-orders", kind: "order", url: "https://www.sci.gov.in/a.pdf", title: "A", docDate: null }]) });
    const store = new OfficialFakeStore({ dbBytes: 70_000 * 1024 * 1024 });
    const r = await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 2, sleep: tick, http: () => fakeHttp({}), embedModel: null, log: () => undefined });
    expect(r.stop).toBe("budget");
    expect(r.units).toBe(0);
    expect(r.notes.join(" ")).toMatch(/OFFICIAL_MAX_DB_MB/);
    expect(store.docs.size).toBe(0);
  });

  it("reports 'disabled' for sources without an enabled adapter and does no work", async () => {
    setOfficialAdaptersForTests({});
    const store = new OfficialFakeStore();
    const r = await runOfficialIngest({ store, sources: ["nclt"], deadlineMs: 30_000, http: () => fakeHttp({}), embedModel: null, log: () => undefined });
    expect(r.stop).toBe("disabled");
    expect(r.reports).toEqual([expect.objectContaining({ sourceId: "nclt", stop: "disabled" })]);
    expect(store.units.size).toBe(0);
  });

  it("throws OfficialNotConfiguredError without a store", async () => {
    await expect(runOfficialIngest({ store: null, deadlineMs: 10_000 })).rejects.toMatchObject({ code: "official_not_configured" });
  });
});
