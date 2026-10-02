import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficialStatus } from "@/modules/official/service";
import type { SourceDef, SourceStats } from "@/modules/official/types";
import { fetchOfficialJson, OfficialApiError } from "@/modules/official-ui/fetch";
import {
  chunkFromOcr, COVERAGE_NOTE, coverageRows, documentApiHref, EMPTY_SOURCES_FILTERS, formatBytes, formatDocDate, formatFetchedAt, forumOptions, hasSourceFilters, isOcrText, kindLabel, lastRunOf, listApiQuery,
  pageLabel, parseSourcesFilters, positiveInt, returnLabel, safeHttp, safeReturnPath, searchApiQuery, searchHitKey, sourceDocHref, sourceDocIdFromParam, sourcesFiltersToParams, storageLine,
} from "@/modules/official-ui/shared";

const def = (o: Partial<SourceDef>): SourceDef => ({
  id: "sci-orders", name: "Supreme Court judgments and daily orders", publisher: "Supreme Court of India", kinds: ["order", "judgment"], forum: "sci",
  homepage: "https://www.sci.gov.in/", fetch: "direct", cadenceMinutes: 60, attribution: "Supreme Court of India", terms: "Government publication; verify against the official copy", enabled: true, ...o,
});
const stats = (o: Partial<SourceStats>): SourceStats => ({ sourceId: "sci-orders", documents: 0, byStatus: {}, chunks: 0, embedded: 0, lastDiscoveredAt: null, lastIndexedAt: null, lastError: null, ...o });

const STATUS: OfficialStatus = {
  configured: true,
  sources: [
    { ...def({ id: "sebi-orders", name: "SEBI orders", publisher: "Securities and Exchange Board of India", forum: "sebi", kinds: ["order"] }), stats: stats({ sourceId: "sebi-orders", documents: 40, byStatus: { indexed: 30, failed: 2, ocr_needed: 3, discovered: 5 }, embedded: 25, chunks: 400, lastIndexedAt: "2026-09-30T10:00:00Z", lastDiscoveredAt: "2026-10-01T04:00:00Z", lastError: "HTTP 503" }) },
    { ...def({}), stats: stats({ documents: 12, byStatus: { indexed: 12 }, embedded: 12, chunks: 90 }) },
    { ...def({ id: "sat-orders", name: "SAT portal", publisher: "Securities Appellate Tribunal", forum: "sat", enabled: false, notes: ["CAPTCHA-gated; SAT orders come via SEBI"] }), stats: stats({ sourceId: "sat-orders" }) },
  ],
  dbBytes: 1_288_490_189,
  limitBytes: 9 * 1024 ** 3,
  embeddings: "pgvector",
  queue: { pending: 4, running: 1, failed: 0, done: 20 },
};

describe("official sources: URL state", () => {
  it("parses filters, dropping unknown values instead of guessing", () => {
    const f = parseSourcesFilters(new URLSearchParams("tab=browse&q=moratorium&source=sebi-orders&source=nope,sci-orders&kind=order&kind=bogus&forum=NCLT-Mumbai&from=2026-09-30&to=2026-01-01"));
    expect(f).toEqual({ tab: "browse", q: "moratorium", sources: ["sci-orders", "sebi-orders"], kinds: ["order"], forum: "nclt-mumbai", from: "2026-01-01", to: "2026-09-30" });
    expect(parseSourcesFilters(new URLSearchParams("tab=x&from=2026-1-1&forum=../x"))).toEqual(EMPTY_SOURCES_FILTERS);
    expect(sourcesFiltersToParams(f).toString()).toBe("tab=browse&q=moratorium&source=sci-orders&source=sebi-orders&kind=order&forum=nclt-mumbai&from=2026-01-01&to=2026-09-30");
    expect(sourcesFiltersToParams(EMPTY_SOURCES_FILTERS).toString()).toBe("");
    expect(hasSourceFilters(f)).toBe(true);
    expect(hasSourceFilters({ ...EMPTY_SOURCES_FILTERS, q: "x" })).toBe(false);
  });

  it("builds API queries; a too-short query is not sent", () => {
    expect(searchApiQuery({ ...EMPTY_SOURCES_FILTERS, q: "a" })).toBeNull();
    expect(searchApiQuery({ ...EMPTY_SOURCES_FILTERS, q: "section 14 moratorium", sources: ["ibbi"], kinds: ["order"], forum: "nclt", from: "2026-01-01" })).toBe("q=section+14+moratorium&source=ibbi&kind=order&forum=nclt&from=2026-01-01&limit=30");
    expect(listApiQuery(EMPTY_SOURCES_FILTERS, null)).toBe("limit=50");
    expect(listApiQuery({ ...EMPTY_SOURCES_FILTERS, sources: ["cbic"], q: "circular" }, "abc", 500)).toBe("source=cbic&q=circular&cursor=abc&limit=100");
    expect(documentApiHref("od_abc123", { page: 4 })).toBe("/api/official/documents/od_abc123?page=4&maxChars=60000");
    expect(documentApiHref("od_abc123", { fromChunk: 7, maxChars: 1000 })).toBe("/api/official/documents/od_abc123?fromChunk=7&maxChars=1000");
    expect(sourceDocHref("od_abc123", { page: 2 })).toBe("/sources/od_abc123?page=2");
    expect(sourceDocHref("od_abc123", { chunk: 0 })).toBe("/sources/od_abc123?chunk=0");
    expect(sourceDocHref("od_abc123")).toBe("/sources/od_abc123");
  });

  it("carries a same-site return path to the reader, so its back link keeps the search, filters and tab", () => {
    const from = "/sources?tab=browse&q=moratorium&source=sebi-orders";
    const href = sourceDocHref("od_abc123", { page: 2 }, from);
    expect(href).toBe(`/sources/od_abc123?page=2&from=${encodeURIComponent(from)}`);
    expect(safeReturnPath(new URL(href, "https://app.example").searchParams.get("from"))).toBe(from);
    expect(sourceDocHref("od_abc123", undefined, "/cases/sc:1")).toBe("/sources/od_abc123?from=%2Fcases%2Fsc%3A1");
    // Never another origin, a protocol-relative URL, a script URL or control characters.
    for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "sources", "/sources\nx", "", null]) {
      expect(safeReturnPath(bad), String(bad)).toBeNull();
      expect(sourceDocHref("od_abc123", undefined, bad)).toBe("/sources/od_abc123");
    }
    expect(returnLabel(from)).toBe("Official sources");
    expect(returnLabel(null)).toBe("Official sources");
    expect(returnLabel("/cases/sc:1")).toBe("Case record");
    expect(returnLabel("/tools?tool=causelist")).toBe("Practice tools");
    expect(returnLabel("/matters/m1")).toBe("Back");
  });

  it("keys search hits by document and chunk: several passages can share one page-level ref", () => {
    const hits = [
      { ref: "src://od_1#p3", documentId: "od_1", chunkIndex: 7 },
      { ref: "src://od_1#p3", documentId: "od_1", chunkIndex: 8 },
      { ref: "src://od_1#p3", documentId: "od_1", chunkIndex: 9 },
      { ref: "src://od_2#p3", documentId: "od_2", chunkIndex: 7 },
    ];
    expect(new Set(hits.map((h) => h.ref)).size).toBe(2);
    expect(new Set(hits.map(searchHitKey)).size).toBe(hits.length);
    expect(searchHitKey(hits[0])).toBe("od_1#7");
  });

  it("accepts only well-formed document ids from the route", () => {
    expect(sourceDocIdFromParam("od_abc123")).toBe("od_abc123");
    expect(sourceDocIdFromParam("od%5Fabc123")).toBe("od_abc123");
    expect(sourceDocIdFromParam("../etc")).toBeNull();
    expect(sourceDocIdFromParam("abc")).toBeNull();
    expect(sourceDocIdFromParam(undefined)).toBeNull();
    expect(positiveInt("12")).toBe(12);
    expect(positiveInt("0")).toBeNull();
    expect(positiveInt("12", 10)).toBeNull();
    expect(positiveInt("x")).toBeNull();
  });
});

describe("official sources: display", () => {
  it("labels OCR text everywhere it applies, conservatively", () => {
    // The pipeline's real states: a text layer with no OCR; "ocr_model" with the OCR'd pages listed whenever any page
    // was OCR'd (the rest keep their text layer); a document never stays "text_layer" with OCR pages.
    expect(isOcrText("text_layer", [])).toBe(false);
    expect(isOcrText("html", [])).toBe(false);
    expect(isOcrText("ocr_model", [3, 4])).toBe(true);
    expect(isOcrText("ocr_model", [])).toBe(true);
    expect(isOcrText(null)).toBe(false);
    const partial = { extraction: "ocr_model" as const, ocrPages: [3, 4] };
    // Conservative: once any page of a document came from OCR, every passage of it carries the OCR label.
    expect(chunkFromOcr(partial, { pageStart: 1, pageEnd: 2 })).toBe(true);
    expect(chunkFromOcr(partial, { pageStart: 4, pageEnd: null })).toBe(true);
    expect(chunkFromOcr(partial, { pageStart: null, pageEnd: null })).toBe(true);
    const clean = { extraction: "text_layer" as const, ocrPages: [] as number[] };
    expect(chunkFromOcr(clean, { pageStart: 1, pageEnd: 2 })).toBe(false);
    expect(chunkFromOcr(clean, { pageStart: null, pageEnd: null })).toBe(false);
  });

  it("formats pages, dates, sizes and links conservatively", () => {
    expect(pageLabel(3)).toBe("p. 3");
    expect(pageLabel(3, 5)).toBe("pp. 3–5");
    expect(pageLabel(null, 5)).toBeNull();
    expect(formatDocDate("2026-09-14")).toBe("14 Sep 2026");
    expect(formatDocDate(null)).toBeNull();
    expect(formatFetchedAt("2026-09-14T03:35:00Z")).toBe("14 Sep 2026, 09:05 IST");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(null)).toBeNull();
    expect(safeHttp("javascript:alert(1)")).toBeNull();
    expect(safeHttp("https://www.sci.gov.in/x.pdf")).toBe("https://www.sci.gov.in/x.pdf");
    expect(kindLabel("cause_list")).toBe("Cause list");
    expect(kindLabel("something_new")).toBe("Something new");
  });
});

describe("official sources: coverage", () => {
  it("reports each source as collected so far, in registry order, never estimating", () => {
    const rows = coverageRows(STATUS);
    expect(rows.map((r) => r.id)).toEqual(["sci-orders", "sebi-orders", "sat-orders"]);
    expect(rows[1]).toMatchObject({ documents: 40, indexed: 30, embedded: 25, failed: 2, ocrNeeded: 3, waiting: 5, lastError: "HTTP 503", homepage: "https://www.sci.gov.in/" });
    expect(rows[2]).toMatchObject({ enabled: false, documents: 0, indexed: 0, notes: ["CAPTCHA-gated; SAT orders come via SEBI"] });
    expect(lastRunOf(rows[1])).toBe("2026-10-01T04:00:00Z");
    expect(lastRunOf(rows[0])).toBeNull();
    expect(COVERAGE_NOTE).toMatch(/do not show how much a publisher has published/);
    expect(storageLine(STATUS)).toBe("1.2 GB of 9 GB storage budget");
    expect(storageLine({ dbBytes: null, limitBytes: null })).toBeNull();
    expect(forumOptions(STATUS).map((f) => f.forum)).toEqual(["sebi", "sat", "sci"]); // by publisher name
    expect(forumOptions(null)).toEqual([]);
  });
});

describe("official sources: API error states", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const respond = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));

  it("classifies not configured, not deployed, not found, denied and bad input", async () => {
    const fail = async () => { try { await fetchOfficialJson("/api/official"); } catch (e) { return e as OfficialApiError; } throw new Error("expected a failure"); };
    respond(503, { error: "The official-sources corpus is not configured", code: "official_not_configured" });
    expect((await fail()).notConfigured).toBe(true);
    respond(404, "<!doctype html><title>404</title>");
    const missing = await fail();
    expect([missing.notAvailable, missing.notFound]).toEqual([true, false]);
    respond(404, { error: "No such official document.", code: "not_found" });
    const nf = await fail();
    expect([nf.notAvailable, nf.notFound, nf.message]).toEqual([false, true, "No such official document."]);
    respond(403, { error: "Forbidden" });
    expect((await fail()).forbidden).toBe(true);
    respond(401, { error: "Unauthenticated" });
    expect((await fail()).unauthenticated).toBe(true);
    respond(400, { error: "dates must be YYYY-MM-DD", code: "bad_request" });
    expect((await fail()).badRequest).toBe(true);
    respond(200, { hits: [], mode: "keyword", candidates: 0, empty: true });
    await expect(fetchOfficialJson("/api/official/search?q=x")).resolves.toEqual({ hits: [], mode: "keyword", candidates: 0, empty: true });
  });
});
