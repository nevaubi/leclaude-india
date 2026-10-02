/**
 * Official-sources agent tools over the facade (src/modules/official/service.ts) with fake implementations: a
 * deterministic "not available" result when the corpus is not configured or not wired, search_result-shaped hits with
 * stable src:// sources and OCR flags, exact reads (an unknown id is an error, never another document), exact cause-list
 * matching through the case-number normaliser (unparsed identifiers are never guessed), calendars with the ad-hoc
 * notification caveat, and capability gating / routing in the toolkit and personas.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "@/lib/ai/tools";
import { causelistLookupTool, courtCalendarTool, OFFICIAL_TOOL_NAMES, readOfficialDocumentTool, searchOfficialSourcesTool } from "@/lib/ai/toolkit/india-official";
import { indiaResearchTools, INDIA_TOOLS } from "@/lib/ai/toolkit/india";
import { indiaRoutingFor, ROUTED_INDIA_TOOLS } from "@/lib/ai/india-guidance";
import { AGENT_PERSONAS, evidenceFromToolCalls, isNonEvidenceResult, toolsFor } from "@/lib/ai/agents/registry";
import { OfficialNotConfiguredError, registerOfficialImpl, type CauseListQuery } from "@/modules/official/service";
import type { CauseListEntry, SourceChunk, SourceDocument, SourceSearchHit } from "@/modules/official/types";

type Exec = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
const run = (tool: { execute: unknown }, args: Record<string, unknown>, ctx?: ToolContext) => (tool.execute as Exec)(args, ctx ?? { emit: () => {}, state: {} });

const DOC: SourceDocument = {
  id: "sebi-orders_9f3a1c2b7e", sourceId: "sebi-orders", kind: "order", url: "https://www.sebi.gov.in/enforcement/orders/oct-2026/order-x.html", fileUrl: "https://www.sebi.gov.in/sebi_data/attachdocs/oct-2026/order-x.pdf",
  title: "Final order in the matter of XYZ Ltd.", docDate: "2026-09-30", status: "indexed", mime: "application/pdf", sha256: "a".repeat(64), bytes: 120_000, pages: 12,
  extraction: "text_layer", ocrPages: [4], language: "en", meta: {}, version: 1, fetchedAt: "2026-10-01T10:00:00Z", indexedAt: "2026-10-01T10:05:00Z", error: null, attempts: 1, chunks: 9,
};
const CHUNKS: SourceChunk[] = [
  { documentId: DOC.id, index: 2, pageStart: 3, pageEnd: 3, heading: null, text: "13. The Noticee traded while in possession of unpublished price sensitive information." },
  { documentId: DOC.id, index: 3, pageStart: 4, pageEnd: 4, heading: null, text: "14. Accordingly, a penalty of Rs. 10,00,000 is imposed under section 15G." },
];
/** A document whose chunks, as read at max_chars 60,000, serialize past the tool's 64,000-character result bound. */
const BIG_DOC: SourceDocument = { ...DOC, id: "sebi-orders_bigbigbig01", pages: 40, chunks: 40 };
const BIG_CHUNKS: SourceChunk[] = Array.from({ length: 34 }, (_, i) => ({ documentId: BIG_DOC.id, index: i, pageStart: i + 1, pageEnd: i + 1, heading: null, text: `${i + 1}. "${"Para text with \"quotes\" and lines\n".repeat(52)}"`.slice(0, 1_990) }));
const HITS: SourceSearchHit[] = [
  { ref: "src://sebi-orders_9f3a1c2b7e#p3", documentId: DOC.id, chunkIndex: 2, sourceId: "sebi-orders", kind: "order", title: DOC.title, publisher: "Securities and Exchange Board of India", url: DOC.url, docDate: "2026-09-30", pageStart: 3, pageEnd: 3, text: CHUNKS[0].text, score: 0.9, match: "both", extraction: "text_layer" },
  { ref: "src://ibbi_5c1d2e3f4a#p2", documentId: "ibbi_5c1d2e3f4a", chunkIndex: 1, sourceId: "ibbi", kind: "order", title: "NCLAT order in Comp. App. (AT) (Ins) No. 351 of 2026", publisher: "Insolvency and Bankruptcy Board of India", url: "https://ibbi.gov.in/orders/nclat", docDate: "2026-09-12", pageStart: 2, pageEnd: 2, text: "The appeal is dismissed.", score: 0.7, match: "keyword", extraction: "ocr_model" },
];
const entry = (over: Partial<CauseListEntry>): CauseListEntry => ({
  id: "cle_1", documentId: "sci-causelist_0a1b2c3d4e", forum: "sci", listDate: "2026-10-05", listType: "daily", courtNo: "5", bench: "HON'BLE MR. JUSTICE A", itemNo: "12",
  caseNumbers: [{ printed: "SLP(C) No. 1234/2026", normalized: "SLPC/1234/2026" }], diaryNo: null, parties: "A v. B", advocates: ["X Y"], raw: "12 SLP(C) No. 1234/2026 A v. B", page: 7, publishedAt: "2026-10-04T18:00:00Z", fetchedAt: "2026-10-04T19:00:00Z", parsed: true, ...over,
});

describe("not available on this deployment", () => {
  it("official not-available and empty results are not evidence (an agent that read nothing is not source-backed)", async () => {
    const na = [
      { name: "search_official_sources", result: await run(searchOfficialSourcesTool, { q: "insider trading" }) },
      { name: "read_official_document", result: await run(readOfficialDocumentTool, { id: "src://sebi-orders_9f3a1c2b7e#p3" }) },
      { name: "causelist_lookup", result: await run(causelistLookupTool, { date: "2026-10-05", case_number: "SLP(C) No. 1234/2026" }) },
      { name: "court_calendar", result: await run(courtCalendarTool, { forum: "sci", year: 2026 }) },
      { name: "causelist_lookup", result: { status: "unparsed_identifier", count: 0, entries: [], note: "Could not normalise" } },
      { name: "search_official_sources", result: { available: true, count: 0, results: [], note: "No official document matched." } },
    ];
    for (const c of na) expect(JSON.stringify(c.result).length, c.name).toBeGreaterThan(40); // long enough to have counted before
    expect(na.every((c) => isNonEvidenceResult(c.result))).toBe(true);
    expect(evidenceFromToolCalls(na, { maxSources: 24, maxChars: 20_000 })).toEqual([]);
    const read = { name: "read_official_document", result: { type: "search_result", source: "src://x#p1", title: "Order", content: ["13. The Noticee traded while in possession of UPSI."], available: undefined } };
    expect(evidenceFromToolCalls([...na, read], { maxSources: 24, maxChars: 20_000 })).toHaveLength(1);
  });

  it("returns a deterministic not-available result while the corpus is not configured (no Postgres in tests)", async () => {
    await expect(run(searchOfficialSourcesTool, { q: "insider trading" })).resolves.toMatchObject({ available: false, status: "not_available", reason: "official_not_configured", count: 0, results: [] });
    await expect(run(readOfficialDocumentTool, { id: "src://sebi-orders_9f3a1c2b7e#p3" })).resolves.toMatchObject({ available: false, reason: "official_not_configured" });
    await expect(run(causelistLookupTool, { date: "2026-10-05", case_number: "SLP(C) No. 1234/2026" })).resolves.toMatchObject({ available: false, entries: [] });
    await expect(run(courtCalendarTool, { forum: "sci", year: 2026 })).resolves.toMatchObject({ available: false, status: "not_available" });
  });

  it("returns not_configured when the corpus has no database", async () => {
    registerOfficialImpl({ searchOfficial: async () => { throw new OfficialNotConfiguredError(); } });
    const r = (await run(searchOfficialSourcesTool, { q: "circular" })) as { available: boolean; reason: string; note: string };
    expect(r).toMatchObject({ available: false, reason: "official_not_configured" });
    expect(r.note).toMatch(/do not cite/);
  });
});

describe("with the official corpus", () => {
  const reads: { id: string; opts?: { fromChunk?: number; page?: number; maxChars?: number } }[] = [];
  const causeQueries: CauseListQuery[] = [];
  beforeAll(() => registerOfficialImpl({
    searchOfficial: async (q) => ({ hits: q.q === "nothing" ? [] : HITS.slice(0, q.limit ?? 8), mode: "hybrid", candidates: 40, empty: q.q === "nothing" }),
    readOfficialDocument: async (id, opts) => {
      reads.push({ id, opts });
      if (id === BIG_DOC.id) return { document: BIG_DOC, chunks: BIG_CHUNKS, hasMore: false, nextChunk: null, attribution: "Securities and Exchange Board of India — sebi.gov.in" };
      return id === DOC.id ? { document: DOC, chunks: CHUNKS, hasMore: true, nextChunk: 4, attribution: "Securities and Exchange Board of India — sebi.gov.in" } : null;
    },
    causeListEntries: async (q) => { causeQueries.push(q); return [entry({}), entry({ id: "cle_2", parsed: false, raw: "unparsed line SLP(C) 1234/2026" })].filter((e) => (!q.caseKeys?.length || e.caseNumbers.some((c) => q.caseKeys!.includes(c.normalized ?? ""))) && (!q.diaryNos?.length || q.diaryNos.includes(e.diaryNo ?? ""))); },
    courtCalendar: async (forum, years) => {
      if (forum === "sci") return { id: "sci-2026", courtId: "sci", years: [2026, 2027], weeklyOff: [0], holidays: [{ date: "2026-10-02", name: "Mahatma Gandhi's Birthday" }, { date: "2027-01-01", name: "New Year Holiday" }], vacations: [{ from: "2026-10-19", to: "2026-10-24", name: "Dussehra Holidays" }], sample: false, source: "https://www.sci.gov.in/calendar/" };
      if (forum === "hc-sample") return { id: "s", courtId: "sample", years, weeklyOff: [0], holidays: [], vacations: [], sample: true, source: "sample" };
      return null;
    },
  }));

  it("search returns citable hits with stable src:// sources, publisher, page, OCR flags and out-of-band provenance", async () => {
    const emitted: unknown[] = [];
    const r = (await run(searchOfficialSourcesTool, { q: "insider trading UPSI", sources: ["sebi-orders", "ibbi"], limit: 5 }, { emit: (e) => emitted.push(e), state: {} })) as { available: boolean; count: number; results: Record<string, unknown>[] };
    expect(r.available).toBe(true);
    expect(r.count).toBe(2);
    expect(r.results[0]).toMatchObject({ type: "search_result", source: "src://sebi-orders_9f3a1c2b7e#p3", id: DOC.id, publisher: "Securities and Exchange Board of India", page: 3, content: [CHUNKS[0].text] });
    expect(String(r.results[0].title)).toContain("p. 3");
    expect(r.results[0]).not.toHaveProperty("ocr");
    expect(String(r.results[1].ocr)).toMatch(/OCR text/);
    expect(emitted).toEqual([expect.objectContaining({ type: "evidence", evidence: expect.arrayContaining([expect.objectContaining({ source: "src://sebi-orders_9f3a1c2b7e#p3", provider: "official:sebi-orders", kind: "opinion" })]) })]);
    await expect(run(searchOfficialSourcesTool, { q: "x", sources: ["not-a-source"] })).rejects.toThrow(/registered official source/);
    await expect(run(searchOfficialSourcesTool, { q: "x", from: "05-10-2026" })).rejects.toThrow(/ISO date/);
    expect(await run(searchOfficialSourcesTool, { q: "nothing" })).toMatchObject({ count: 0, note: expect.stringMatching(/do not cite an official document that was not found/) });
  });

  it("read resolves src:// references exactly (page from the ref), never substitutes another document", async () => {
    const r = (await run(readOfficialDocumentTool, { id: "src://sebi-orders_9f3a1c2b7e#p3" })) as Record<string, unknown> & { content: string[] };
    expect(reads.at(-1)).toMatchObject({ id: DOC.id, opts: { page: 3, maxChars: 20_000 } });
    expect(r).toMatchObject({ type: "search_result", source: "src://sebi-orders_9f3a1c2b7e#p3", id: DOC.id, url: DOC.url, sha256: DOC.sha256, extraction: "text_layer", has_more: true, next_chunk: 4 });
    expect(r.content[0]).toBe(`[p. 3] ${CHUNKS[0].text}`);
    expect(r.content[1]).toBe(`[p. 4 (OCR)] ${CHUNKS[1].text}`);
    expect(String(r.ocr)).toMatch(/checked against the official PDF/);
    await run(readOfficialDocumentTool, { id: DOC.id, from_chunk: 4, max_chars: 999_999 });
    expect(reads.at(-1)).toMatchObject({ id: DOC.id, opts: { fromChunk: 4, maxChars: 60_000 } });
    await expect(run(readOfficialDocumentTool, { id: "src://sci-orders_ffffffffff" })).rejects.toThrow(/not substituted with another document/);
    await expect(run(readOfficialDocumentTool, { id: "../../etc/passwd" })).rejects.toThrow(/not an official document id/);
    await expect(run(readOfficialDocumentTool, { id: "src://bad ref" })).rejects.toThrow(/not a valid official source reference/);
  });

  it("a read that would exceed the result bound returns fewer WHOLE chunks and next_chunk from what was returned", async () => {
    const r = (await run(readOfficialDocumentTool, { id: BIG_DOC.id, max_chars: 60_000 })) as { content: string[]; has_more: boolean; next_chunk: number; chunks: string };
    const json = JSON.stringify(r);
    expect(json.length).toBeLessThanOrEqual(64_000 - 512);
    expect(json).not.toMatch(/truncated/);
    expect(r.has_more).toBe(true);
    const returned = Number(r.chunks.split("–")[1]);
    expect(returned).toBeLessThan(BIG_CHUNKS.length - 1);
    expect(r.next_chunk).toBe(returned + 1);
    // Every returned chunk is whole (its full text is in the content blocks).
    const text = r.content.join("\n\n");
    for (const c of BIG_CHUNKS.slice(0, returned + 1)) expect(text).toContain(c.text.slice(-40));
  });

  it("cause-list ranges count both dates (31 days accepted, 32 refused) and an unparsed number stops the lookup even with an advocate", async () => {
    await expect(run(causelistLookupTool, { from: "2026-10-01", to: "2026-10-31", case_number: "SLP(C) No. 1234/2026" })).resolves.toMatchObject({ status: "listed" });
    await expect(run(causelistLookupTool, { from: "2026-10-01", to: "2026-11-01", case_number: "SLP(C) No. 1234/2026" })).rejects.toThrow(/longer than 31 days/);
    const before = causeQueries.length;
    const r = (await run(causelistLookupTool, { date: "2026-10-05", case_number: "the bail matter", advocate: "X Y" })) as { status: string; count: number; entries: unknown[] };
    expect(r).toMatchObject({ status: "unparsed_identifier", count: 0, entries: [] });
    expect(causeQueries.length).toBe(before); // the advocate's other listings are never reported as this matter's
    const d = (await run(causelistLookupTool, { date: "2026-10-05", case_number: "SLP(C) No. 1234/2026", diary_no: "not a diary number" })) as { status: string };
    expect(d.status).toBe("unparsed_identifier");
  });

  it("cause-list lookup matches the normalised case number exactly and never reports an unparsed line", async () => {
    const r = (await run(causelistLookupTool, { forum: "sci", date: "2026-10-05", case_number: "SLP(C) No. 1234/2026" })) as { status: string; entries: Record<string, unknown>[]; caveat: string; matched_on: Record<string, unknown> };
    expect(causeQueries.at(-1)).toMatchObject({ forum: "sci", date: "2026-10-05", caseKeys: ["SLPC/1234/2026"] });
    expect(r.status).toBe("listed");
    expect(r.matched_on.case_number).toBe("SLPC/1234/2026");
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ source: "src://sci-causelist_0a1b2c3d4e#p7", item_no: "12", court_no: "5", parsed: true });
    expect(r.caveat).toMatch(/Confirm the item number/);
    const none = (await run(causelistLookupTool, { forum: "sci", from: "2026-10-01", to: "2026-10-09", case_number: "W.P.(C) 5812/2016" })) as { status: string; note: string };
    expect(none.status).toBe("no_match_in_loaded_lists");
    expect(none.note).toMatch(/does not prove the matter is not listed/);
    const before = causeQueries.length;
    const unparsed = (await run(causelistLookupTool, { date: "2026-10-05", case_number: "the bail matter" })) as { status: string };
    expect(unparsed.status).toBe("unparsed_identifier");
    expect(causeQueries.length).toBe(before); // nothing guessed, nothing looked up
    const diary = await run(causelistLookupTool, { date: "2026-10-05", diary_no: "Diary No. 54583-2026" });
    expect(causeQueries.at(-1)).toMatchObject({ diaryNos: ["54583/2026"] });
    expect(diary).toMatchObject({ status: "no_match_in_loaded_lists" });
    // NCLT numbers repeat across benches: a bench-coded number is looked up with its bench, never as the bare key.
    const nclt = (await run(causelistLookupTool, { forum: "nclt", date: "2026-10-05", case_number: "CP(IB)/29(MP)2022" })) as { matched_on: { case_number: string } };
    const sent = causeQueries.at(-1)?.caseKeys ?? [];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/@MP$/);
    expect(nclt.matched_on.case_number).toBe(sent[0]);
    await expect(run(causelistLookupTool, { case_number: "SLP(C) No. 1234/2026" })).rejects.toThrow(/Give a list date/);
    await expect(run(causelistLookupTool, { from: "2026-01-01", to: "2026-03-01", case_number: "SLP(C) No. 1234/2026" })).rejects.toThrow(/longer than 31 days/);
    await expect(run(causelistLookupTool, { date: "2026-10-05" })).rejects.toThrow(/case_number, diary_no or advocate/);
  });

  it("court calendar returns the year's notified holidays with the ad-hoc notification caveat; sample data is refused", async () => {
    const r = (await run(courtCalendarTool, { forum: "sci", year: 2026 })) as { available: boolean; holidays: { date: string }[]; vacations: unknown[]; weekly_off: string[]; caveat: string };
    expect(r.available).toBe(true);
    expect(r.holidays.map((h) => h.date)).toEqual(["2026-10-02"]);
    expect(r.vacations).toHaveLength(1);
    expect(r.weekly_off).toEqual(["Sunday"]);
    expect(r.caveat).toMatch(/separate notification/);
    expect(await run(courtCalendarTool, { forum: "hc-sample", year: 2026 })).toMatchObject({ available: false, status: "sample_only" });
    expect(await run(courtCalendarTool, { forum: "hc-delhi", year: 2026 })).toMatchObject({ available: false, status: "no_calendar" });
    expect(await run(courtCalendarTool, { forum: "sci", year: 2031 })).toMatchObject({ available: false, status: "no_calendar" });
    await expect(run(courtCalendarTool, { forum: "sci", year: 26 })).rejects.toThrow(/calendar year/);
  });
});

describe("toolkit, personas and routing", () => {
  it("offers the official tools with the corpus capability only, routes them and gives them to research, analyst and drafter", () => {
    expect(OFFICIAL_TOOL_NAMES).toEqual(["search_official_sources", "read_official_document", "causelist_lookup", "court_calendar"]);
    const on = indiaResearchTools({ indianKanoon: false, corpus: true }).map((t) => t.name);
    const off = indiaResearchTools({ indianKanoon: false, corpus: false }).map((t) => t.name);
    for (const n of OFFICIAL_TOOL_NAMES) {
      expect(on).toContain(n);
      expect(off).not.toContain(n);
      expect(INDIA_TOOLS.map((t) => t.name)).toContain(n);
      expect(ROUTED_INDIA_TOOLS as readonly string[]).toContain(n);
    }
    expect(indiaRoutingFor(["causelist_lookup"])).toMatch(/causelist_lookup with the case number as printed/);
    expect(indiaRoutingFor(["search_official_sources"])).toMatch(/search_official_sources → read_official_document/);
    for (const p of ["research", "analyst", "drafter"] as const) expect(AGENT_PERSONAS[p].tools).toEqual(expect.arrayContaining(["search_official_sources", "read_official_document"]));
    expect(AGENT_PERSONAS.analyst.tools).toContain("causelist_lookup");
    const without = toolsFor(AGENT_PERSONAS.analyst.tools, { from: "analyst", caps: { corpus: false, indianKanoon: false } });
    expect(without.unavailable).toEqual(expect.arrayContaining(OFFICIAL_TOOL_NAMES));
    expect(without.unknown).toEqual([]);
    const withDb = toolsFor(AGENT_PERSONAS.analyst.tools, { from: "analyst", caps: { corpus: true, indianKanoon: false } });
    expect(withDb.tools.map((t) => t.name)).toEqual(expect.arrayContaining(OFFICIAL_TOOL_NAMES));
  });
});

