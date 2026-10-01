import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRemoteStoreForTests, type RemoteStore, type Row, type SqlQuery } from "@/lib/db/remote";
import { LawCorpusNotConfiguredError, LawCorpusNotLoadedError, LawSearchTimeoutError, lawStore, resetLawReadyCacheForTests } from "@/modules/india/law/common";
import { getInstrument, getSection, lawFacets, readProvisionText, resetLawFacetsCacheForTests, shapeLawFacets } from "@/modules/india/law/directory";
import { provisionSearchSql, searchInstruments, searchProvisions } from "@/modules/india/law/search";
import {
  cleanLawText, lawCitation, lawFiltersToParams, lawHref, lawIdFromSegments, lawSourceId, normSectionKey, parseLawFilters, parseLawSourceId, publisherLabel, snippetParts, statusLabel,
} from "@/modules/law/shared";
import { indiaResearchTools, INDIA_TOOLS, listLawInstrumentsTool, readLawSectionTool, searchLawTool } from "@/lib/ai/toolkit/india";
import type { ToolContext } from "@/lib/ai/tools";

/** A fake Neon store: tables present (unless told otherwise), every other statement recorded and answered by a handler. */
class FakeStore implements RemoteStore {
  calls: SqlQuery[] = [];
  regclass = 0;
  constructor(private readonly reply: (q: SqlQuery) => Row[] | Promise<Row[]> = () => [], private readonly tables = true) {}
  async query(q: SqlQuery): Promise<Row[]> {
    if (q.query.includes("to_regclass")) {
      this.regclass++;
      return [this.tables ? { law_datasets: "law_datasets", law_instruments: "law_instruments", law_provisions: "law_provisions" } : { law_datasets: null, law_instruments: "law_instruments", law_provisions: null }];
    }
    if (q.query.includes("set_config('statement_timeout'")) return [{ t: String(q.params?.[0]) }];
    this.calls.push(q);
    return this.reply(q);
  }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> {
    const out: Row[][] = [];
    for (const q of qs) out.push(await this.query(q));
    return out;
  }
}

const BNS: Row = {
  id: "IND_central_20062", kind: "act", title: "The Bharatiya Nyaya Sanhita, 2023", jurisdiction: "central", state: null, state_code: null, regulator: null,
  publisher: "Legislative Department", year: "2023", status: "in_force", amendment_count: "0", source_url: "https://www.indiacode.nic.in/handle/123456789/20062",
  mirror_url: "https://mirror.example.org/bns.pdf", provisions: "420", sections: "358", subjects: '{"Criminal law","Offences"}', dataset_file: "in_central_legislation.parquet", dataset_version: "v2026.08.1",
};

const ctx = (): ToolContext & { events: unknown[] } => {
  const events: unknown[] = [];
  return { emit: (e: unknown) => events.push(e), state: {}, events } as unknown as ToolContext & { events: unknown[] };
};

beforeEach(() => { resetLawReadyCacheForTests(); resetLawFacetsCacheForTests(); });
afterEach(() => { setRemoteStoreForTests(undefined); });

describe("shared contracts", () => {
  it("parses and clamps directory filters, dropping values it cannot trust", () => {
    const f = parseLawFilters(new URLSearchParams("q=" + "x".repeat(300) + "&j=state&state=ka&reg=sebi&status=bogus&kind=act&from=2020&to=1990&mode=sections"));
    expect(f.q.length).toBe(200);
    expect(f).toMatchObject({ mode: "sections", jurisdiction: "state", state: "KA", regulator: "", status: "in_force", kind: "act", yearFrom: 1990, yearTo: 2020, sort: "relevance" });
    expect(parseLawFilters(new URLSearchParams("state=K'A;--&reg=SEBI;DROP")).state).toBe("");
    expect(parseLawFilters(new URLSearchParams("reg=sebi"))).toMatchObject({ jurisdiction: "regulator", regulator: "sebi", sort: "title" });
    expect(lawFiltersToParams(parseLawFilters(new URLSearchParams("j=central&status=all"))).toString()).toBe("j=central&status=all");
    expect(lawFiltersToParams(parseLawFilters(new URLSearchParams(""))).toString()).toBe("");
  });

  it("builds hrefs and stable sources that round-trip", () => {
    expect(lawHref("IND_central_20062")).toBe("/law/IND_central_20062");
    expect(lawHref("IND_central_20062", "303")).toBe("/law/IND_central_20062?s=303");
    expect(lawHref("IND_central_20062", "10A", 1)).toBe("/law/IND_central_20062?s=10A&v=1");
    expect(lawSourceId("IND_central_20062", "303")).toBe("law://IND_central_20062/s/303");
    expect(lawSourceId("IND_central_20062", "10A", 2)).toBe("law://IND_central_20062/s/10A~2");
    expect(parseLawSourceId("law://IND_central_20062/s/10A~2")).toEqual({ actId: "IND_central_20062", section: "10A", variant: 2 });
    expect(parseLawSourceId("law://IND_central_20062")).toEqual({ actId: "IND_central_20062", section: null, variant: 0 });
    expect(parseLawSourceId("statute://x/s/1")).toBeNull();
    expect(lawIdFromSegments(["IND_central_20062"])).toBe("IND_central_20062");
    expect(lawIdFromSegments(["a", "b"])).toBeNull();
    expect(lawIdFromSegments(["../etc"])).toBeNull();
  });

  it("accepts printed section numbers only", () => {
    expect(normSectionKey("303")).toBe("303");
    expect(normSectionKey("Section 10A")).toBe("10A");
    expect(normSectionKey("s. 482")).toBe("482");
    expect(normSectionKey("_")).toBe("_");
    expect(normSectionKey("1; DROP TABLE x")).toBeNull();
    expect(normSectionKey("")).toBeNull();
  });

  it("cites, labels and cleans without changing words", () => {
    expect(lawCitation({ kind: "act", title: "The Bharatiya Nyaya Sanhita, 2023", year: 2023 }, "303")).toBe("Section 303, Bharatiya Nyaya Sanhita, 2023");
    expect(lawCitation({ kind: "act", title: "Karnataka Rent Act", year: 1999 }, "27")).toBe("Section 27, Karnataka Rent Act, 1999");
    expect(lawCitation({ kind: "regulation", title: "SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015", year: 2015 }, "23")).toBe("Regulation 23, SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015");
    expect(lawCitation({ kind: "act", title: "X Act, 2000", year: 2000 }, "5", 1)).toContain("variant 2");
    expect(publisherLabel({ source_url: "https://www.indiacode.nic.in/handle/1", regulator: null, publisher: null })).toBe("India Code (Legislative Department)");
    expect(publisherLabel({ source_url: "https://www.sebi.gov.in/legal/x.html", regulator: "sebi", publisher: null })).toBe("SEBI");
    expect(publisherLabel({ source_url: "javascript:alert(1)", regulator: "rbi", publisher: null })).toBe("RBI");
    expect(statusLabel("in_force")).toBe("In force");
    expect(statusLabel(null)).toBe("Status not recorded");
    const raw = "**303. Organised crime.**—( _1_ ) Any continuing unlawful activity\n> including __robbery__, *extortion*\n\n\n\\(2\\) Whoever commits 2*3 = 6.";
    const clean = cleanLawText(raw);
    expect(clean).toBe("303. Organised crime.—(1) Any continuing unlawful activity\nincluding robbery, extortion\n\n(2) Whoever commits 2*3 = 6.");
    for (const w of ["Organised", "continuing", "unlawful", "robbery", "extortion", "Whoever"]) expect(clean).toContain(w);
    expect(snippetParts("a «bail» b")).toEqual([{ text: "a ", mark: false }, { text: "bail", mark: true }, { text: " b", mark: false }]);
  });
});

describe("not configured / not loaded", () => {
  it("fails closed without a database, and when the loader's tables are missing", async () => {
    await expect(lawStore(null)).rejects.toBeInstanceOf(LawCorpusNotConfiguredError);
    await expect(searchInstruments({ q: "rent" }, null)).rejects.toMatchObject({ code: "law_corpus_not_configured" });
    const missing = new FakeStore(() => [], false);
    const err = await lawStore(missing).catch((e) => e);
    expect(err).toBeInstanceOf(LawCorpusNotLoadedError);
    expect(err.code).toBe("law_corpus_not_loaded");
    expect(err.missing).toEqual(["law_datasets", "law_provisions"]);
    // A negative check is not cached: once the tables exist the corpus is served.
    expect(missing.calls).toHaveLength(0);
  });

  it("caches a positive table check per store", async () => {
    const store = new FakeStore();
    await lawStore(store);
    await lawStore(store);
    expect(store.regclass).toBe(1);
  });
});

describe("facets", () => {
  const groups: Row[] = [
    { jurisdiction: "central", state_code: null, state: null, regulator: null, status: "in_force", n: "900", sections: "40000", min_year: "1836", max_year: "2026" },
    { jurisdiction: "central", state_code: null, state: null, regulator: null, status: "repealed", n: "668", sections: "9000", min_year: "1850", max_year: "2020" },
    { jurisdiction: "state", state_code: "KA", state: "Karnataka", regulator: null, status: "in_force", n: "700", sections: "12000", min_year: "1950", max_year: "2025" },
    { jurisdiction: "regulator", state_code: null, state: null, regulator: "sebi", status: null, n: "300", sections: "5000", min_year: "1992", max_year: "2026" },
  ];
  const datasets: Row[] = [{ file: "in_central_legislation.parquet", version: "v2026.08.1", kind: "legislation", jurisdiction: "central", label: "Central", rows_in_file: "100", rows_stored: "99", rows_skipped: "1", instruments: "1568", status: "done", error: null, started_at: "2026-09-30 10:00:00+00", finished_at: "2026-09-30 11:00:00+00" }];

  it("shapes counts per jurisdiction, State, regulator and status with dataset rows", () => {
    const f = shapeLawFacets(groups, datasets, new Date("2026-10-01T00:00:00Z"));
    expect(f.total).toBe(2568);
    expect(f.sections).toBe(66000);
    expect(f.jurisdictions.map((j) => j.value)).toEqual(["central", "state", "regulator"]);
    expect(f.jurisdictions[0]).toEqual({ value: "central", instruments: 1568, sections: 49000 });
    expect(f.states).toEqual([{ code: "KA", name: "Karnataka", instruments: 700 }]);
    expect(f.regulators).toEqual([{ value: "sebi", label: "SEBI", instruments: 300 }]);
    expect(f.statuses.find((s) => s.value === null)?.instruments).toBe(300);
    expect([f.minYear, f.maxYear]).toEqual([1836, 2026]);
    expect(f.datasets[0]).toMatchObject({ status: "done", instruments: 1568, finished_at: "2026-09-30T11:00:00.000Z" });
    expect(f.versions).toEqual(["v2026.08.1"]);
  });

  it("caches for ten minutes and falls back to a stale copy when a recompute fails", async () => {
    let fail = false;
    const store = new FakeStore((q) => {
      if (fail) throw new Error("db down");
      return q.query.includes("FROM law_datasets") ? datasets : groups;
    });
    let t = 1_000_000;
    const now = () => t;
    const a = await lawFacets(store, now);
    const calls = store.calls.length;
    expect(calls).toBe(2);
    await lawFacets(store, now);
    expect(store.calls.length).toBe(calls);
    t += 11 * 60 * 1000;
    fail = true;
    const stale = await lawFacets(store, now);
    expect(stale.stale).toBe(true);
    expect(stale.total).toBe(a.total);
  });
});

describe("instrument and exact section", () => {
  const sectionRows: Row[] = [
    { id: "IND_central_20062_s303_p0", ord: "330", part: "0", heading: "Organised crime", chapter: "VI", chapter_title: "OF OFFENCES AFFECTING THE HUMAN BODY", section_type: "section", provision_type: null, status: "in_force", in_force: "t", has_proviso: "f", has_non_obstante: "f", defined_terms: '{"organised crime"}', acts_referenced: null, text: "**303. Organised crime.**—( _1_ ) Any continuing unlawful activity", source_url: "https://www.indiacode.nic.in/handle/123456789/20062" },
    { id: "IND_central_20062_s303_p1", ord: "331", part: "1", heading: null, chapter: "VI", chapter_title: null, section_type: "section", provision_type: null, status: "in_force", in_force: "t", has_proviso: "t", has_non_obstante: "f", defined_terms: null, acts_referenced: '{"BNSS"}', text: "( _2_ ) Whoever commits organised crime shall", source_url: null },
  ];

  it("reads a section exactly, joins its parts in order and reports neighbours and other variants", async () => {
    const store = new FakeStore((q) => {
      if (q.query.includes("FROM law_instruments i WHERE i.id = $1")) return [BNS];
      if (q.query.includes("SELECT DISTINCT variant")) return [{ variant: "0" }, { variant: "1" }];
      if (q.query.includes("ord < $2")) return [{ section_number: "302", variant: "0" }];
      if (q.query.includes("ord > $2")) return [{ section_number: "304", variant: "0" }];
      if (q.query.includes("FROM law_provisions WHERE act_id = $1 AND lower(section_number)")) return sectionRows;
      return [];
    });
    const res = await getSection("IND_central_20062", "303", 0, store);
    expect(res).not.toBeNull();
    const main = store.calls.find((c) => c.query.includes("ORDER BY ord, part"))!;
    expect(main.query).toContain("act_id = $1 AND lower(section_number) = lower($2) AND variant = $3");
    expect(main.query).toMatch(/LIMIT \d+$/);
    expect(main.params).toEqual(["IND_central_20062", "303", 0]);
    expect(res!.section.text).toBe("303. Organised crime.—(1) Any continuing unlawful activity\n\n(2) Whoever commits organised crime shall");
    expect(res!.section).toMatchObject({ heading: "Organised crime", chapter: "VI", chapter_title: "OF OFFENCES AFFECTING THE HUMAN BODY", in_force: true, has_proviso: true, defined_terms: ["organised crime"], acts_referenced: ["BNSS"], provisionIds: ["IND_central_20062_s303_p0", "IND_central_20062_s303_p1"] });
    expect(res!.variants).toEqual([1]);
    expect(res!.prev).toEqual({ section: "302", variant: 0 });
    expect(res!.next).toEqual({ section: "304", variant: 0 });
    expect(res!.citation).toBe("Section 303, Bharatiya Nyaya Sanhita, 2023");
  });

  it("returns not-found for an unknown section or instrument — never the nearest section", async () => {
    const store = new FakeStore((q) => (q.query.includes("FROM law_instruments i WHERE i.id = $1") ? [BNS] : []));
    expect(await getSection("IND_central_20062", "303Z", 0, store)).toBeNull();
    expect(store.calls.some((c) => /ord [<>]/.test(c.query))).toBe(false);
    const none = new FakeStore(() => []);
    expect(await getSection("IND_central_99999", "1", 0, none)).toBeNull();
    expect(await getSection("IND_central_20062", "1; drop", 0, store)).toBeNull();
    expect(await readProvisionText("IND_central_20062", "999", 0, 5000, store)).toBeNull();
  });

  it("reads unnumbered provisions with the _ key", async () => {
    const store = new FakeStore((q) => (q.query.includes("FROM law_instruments") ? [BNS] : q.query.includes("ORDER BY ord, part") ? [{ ...sectionRows[0], heading: "Preamble", text: "An Act to consolidate" }] : []));
    const res = await getSection("IND_central_20062", "_", 0, store);
    expect(store.calls.find((c) => c.query.includes("ORDER BY ord, part"))!.query).toContain("(section_number IS NULL OR section_number = '')");
    expect(res!.section.text).toBe("An Act to consolidate");
  });

  it("truncates long sections for agents with an explicit marker", async () => {
    const long = { ...sectionRows[0], text: "word ".repeat(5000) };
    const store = new FakeStore((q) => (q.query.includes("FROM law_instruments") ? [BNS] : q.query.includes("ORDER BY ord, part") ? [long] : []));
    const r = await readProvisionText("IND_central_20062", "303", 0, 1000, store);
    expect(r!.section.truncated).toBe(true);
    expect(r!.text).toMatch(/…\[truncated: the section has [\d,]+ characters\]$/);
  });

  it("pages the table of contents with a GROUP BY over (section, variant)", async () => {
    const store = new FakeStore((q) => {
      if (q.query.includes("FROM law_instruments i WHERE i.id = $1")) return [BNS];
      if (q.query.includes("GROUP BY")) return [
        { section: "_", variant: "0", ord: "0", heading: "Preamble", chapter: null, chapter_title: null, parts: "1", total: "359" },
        { section: "1", variant: "0", ord: "1", heading: "Short title, commencement and application", chapter: "I", chapter_title: "PRELIMINARY", parts: "2", total: "359" },
      ];
      return [];
    });
    const res = await getInstrument("IND_central_20062", { tocOffset: 300 }, store);
    const toc = store.calls.find((c) => c.query.includes("GROUP BY"))!;
    expect(toc.query).toContain("FROM law_provisions WHERE act_id = $1");
    expect(toc.query).toContain("GROUP BY coalesce(nullif(section_number, ''), '_'), variant");
    expect(toc.query).toMatch(/LIMIT 300 OFFSET 300$/);
    expect(res!.instrument).toMatchObject({ id: "IND_central_20062", year: 2023, status: "in_force", sections: 358, subjects: ["Criminal law", "Offences"] });
    expect(res!.toc).toMatchObject({ total: 359, offset: 300, hasMore: true });
    expect(res!.toc.entries[1]).toMatchObject({ section: "1", chapter_title: "PRELIMINARY", parts: 2 });
    expect(await getInstrument("../x", {}, store)).toBeNull();
  });
});

describe("search", () => {
  it("builds a bounded, filtered provision search with bound parameters", () => {
    const { query, params, limit, offset } = provisionSearchSql({ q: "eviction 'arrears'; drop", jurisdiction: "state", state: "ka", regulator: "x';--", inForceOnly: true, actId: "IND_KA_1", limit: 500, offset: 9999 });
    expect(limit).toBe(50);
    expect(offset).toBe(150);
    expect(query).toContain("websearch_to_tsquery('english', $1)");
    expect(query).toContain("ts_rank_cd(p.search, q.tsq)");
    expect(query).toContain("WHERE p.search @@ q.tsq AND i.jurisdiction = $2 AND i.state_code = $3 AND i.status = 'in_force' AND i.id = $4 AND p.in_force IS NOT FALSE");
    expect(query).toContain("LIMIT 400");
    expect(query).toContain("DISTINCT ON (act_id, coalesce(nullif(section_number, ''), '_'), variant)");
    expect(query).toContain("LIMIT 51 OFFSET 150");
    expect(query).not.toContain("arrears");
    expect(query).not.toContain("x';--");
    expect(params.slice(0, 4)).toEqual(["eviction 'arrears'; drop", "state", "KA", "IND_KA_1"]);
  });

  it("returns section-level hits under a statement timeout and never scans provisions without a query", async () => {
    const store = new FakeStore((q) => q.query.includes("FROM law_provisions") ? [
      { act_id: "IND_central_20062", section_number: "303", variant: "0", ord: "330", chapter_title: "X", in_force: "t", source_url: null, rank: "0.5", heading: "Organised crime", snippet: "continuing «unlawful» **activity**", act_title: "The Bharatiya Nyaya Sanhita, 2023", kind: "act", jurisdiction: "central", state: null, state_code: null, regulator: null, year: "2023", instrument_status: "in_force", dataset_version: "v2026.08.1", act_source_url: "https://www.indiacode.nic.in/handle/123456789/20062" },
    ] : []);
    const res = await searchProvisions({ q: "unlawful activity", limit: 10 }, store);
    expect(res.hits[0]).toMatchObject({ actId: "IND_central_20062", section: "303", variant: 0, in_force: true, snippet: "continuing «unlawful» activity", source_url: "https://www.indiacode.nic.in/handle/123456789/20062", instrumentStatus: "in_force" });
    expect(res.hasMore).toBe(false);
    const empty = new FakeStore();
    expect((await searchProvisions({ q: "  " }, empty)).hits).toEqual([]);
    expect(empty.calls).toHaveLength(0);
  });

  it("maps a statement timeout to an explicit 'too broad' error", async () => {
    const store = new FakeStore(() => { throw new Error("Database error: canceling statement due to statement timeout"); });
    await expect(searchProvisions({ q: "the" }, store)).rejects.toBeInstanceOf(LawSearchTimeoutError);
  });

  it("searches instruments by title with an exact-title boost and pages by offset", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...BNS, id: `IND_KA_${i}`, title: `Karnataka Rent Act ${i}`, jurisdiction: "state", state_code: "KA", rank: "0.3", exact: "0" }));
    const store = new FakeStore(() => rows);
    const res = await searchInstruments({ q: "Karnataka Rent Act", jurisdiction: "state", state: "KA", status: "in_force", limit: 2 }, store);
    expect(res).toMatchObject({ mode: "search", sort: "relevance", hasMore: true, nextCursor: "o:2" });
    expect(res.hits).toHaveLength(2);
    const q = store.calls[0];
    expect(q.query).toContain("websearch_to_tsquery('english', $1)");
    expect(q.query).toContain("lower(i.title) LIKE $2 ESCAPE");
    expect(q.query).toContain("ORDER BY exact DESC, rank DESC");
    expect(q.query).toMatch(/LIMIT 3 OFFSET 0$/);
    expect(q.params).toEqual(["Karnataka Rent Act", "%karnataka rent act%", "state", "KA"]);
    store.calls = [];
    await searchInstruments({ cursor: "o:50", sort: "newest" }, store);
    expect(store.calls[0].query).toMatch(/ORDER BY CASE i.jurisdiction WHEN .central. THEN 0 .*i.year DESC NULLS LAST/);
    expect(store.calls[0].query).toMatch(/LIMIT 51 OFFSET 50$/);
    expect(store.calls[0].query).not.toContain("tsquery");
  });
});

describe("agent tools", () => {
  it("are offered only with a database", () => {
    const off = indiaResearchTools({ indianKanoon: false, corpus: false }).map((t) => t.name);
    const on = indiaResearchTools({ indianKanoon: false, corpus: true }).map((t) => t.name);
    for (const n of ["search_law", "read_law_section", "list_law_instruments"]) { expect(off).not.toContain(n); expect(on).toContain(n); expect(INDIA_TOOLS.map((t) => t.name)).toContain(n); }
    expect(on).toContain("search_statutes");
  });

  it("search_law returns search_result rows with law:// sources, status and the publisher URL", async () => {
    setRemoteStoreForTests(new FakeStore((q) => q.query.includes("FROM law_provisions") ? [
      { act_id: "IND_central_20062", section_number: "303", variant: "0", ord: "330", chapter_title: null, in_force: "t", source_url: "https://www.indiacode.nic.in/handle/123456789/20062", rank: "0.5", heading: "Organised crime", snippet: "continuing «unlawful» activity", act_title: "The Bharatiya Nyaya Sanhita, 2023", kind: "act", jurisdiction: "central", state: null, state_code: null, regulator: null, year: "2023", instrument_status: "in_force", dataset_version: "v2026.08.1", act_source_url: null },
      { act_id: "IND_REP_1", section_number: "10A", variant: "1", ord: "12", chapter_title: null, in_force: "f", source_url: null, rank: "0.2", heading: null, snippet: "old", act_title: "Old Act", kind: "act", jurisdiction: "central", state: null, state_code: null, regulator: null, year: "1900", instrument_status: "repealed", dataset_version: "v2026.08.1", act_source_url: null },
    ] : []));
    const c = ctx();
    const out = (await searchLawTool.execute({ query: "unlawful activity", in_force: false }, c)) as { count: number; results: Record<string, unknown>[]; note: string };
    expect(out.count).toBe(2);
    expect(out.results[0]).toMatchObject({ type: "search_result", source: "law://IND_central_20062/s/303", title: "Section 303, Bharatiya Nyaya Sanhita, 2023 — Organised crime", content: ["continuing unlawful activity"], status: "In force", source_url: "https://www.indiacode.nic.in/handle/123456789/20062" });
    expect(out.results[1]).toMatchObject({ source: "law://IND_REP_1/s/10A~1", status: "Repealed", provision_in_force: false });
    expect(out.note).toContain("third-party");
    expect(c.events[0]).toMatchObject({ type: "evidence" });
  });

  it("read_law_section is exact: an absent section is an error, never the nearest one", async () => {
    setRemoteStoreForTests(new FakeStore((q) => (q.query.includes("FROM law_instruments") ? [BNS] : [])));
    await expect(Promise.resolve(readLawSectionTool.execute({ act_id: "IND_central_20062", section: "999" }, ctx()))).rejects.toThrow(/No section 999 in instrument IND_central_20062/);
  });

  it("read_law_section returns the citation, status, official source and attribution", async () => {
    setRemoteStoreForTests(new FakeStore((q) => {
      if (q.query.includes("FROM law_instruments")) return [BNS];
      if (q.query.includes("ORDER BY ord, part")) return [{ id: "p0", ord: "1", part: "0", heading: "Organised crime", chapter: null, chapter_title: null, section_type: null, provision_type: null, status: null, in_force: "t", has_proviso: "f", has_non_obstante: "f", defined_terms: null, acts_referenced: null, text: "(1) A.\n\n(2) B.", source_url: null }];
      return [];
    }));
    const r = (await readLawSectionTool.execute({ act_id: "IND_central_20062", section: "303" }, ctx())) as Record<string, unknown>;
    expect(r).toMatchObject({ source: "law://IND_central_20062/s/303", citation: "Section 303, Bharatiya Nyaya Sanhita, 2023", content: ["(1) A.", "(2) B."], status: "In force", official_source: BNS.source_url, publisher: "India Code (Legislative Department)", dataset_version: "v2026.08.1" });
  });

  it("list_law_instruments finds an Act by title", async () => {
    setRemoteStoreForTests(new FakeStore(() => [{ ...BNS, id: "IND_KA_77", title: "The Karnataka Rent Act, 1999", jurisdiction: "state", state: "Karnataka", state_code: "KA", rank: "1", exact: "1" }]));
    const r = (await listLawInstrumentsTool.execute({ query: "Karnataka Rent Act" }, ctx())) as { results: Record<string, unknown>[] };
    expect(r.results[0]).toMatchObject({ act_id: "IND_KA_77", source: "law://IND_KA_77", jurisdiction: "Karnataka", status: "In force" });
  });

  it("tools report the not-configured state instead of an empty result", async () => {
    setRemoteStoreForTests(null);
    await expect(Promise.resolve(searchLawTool.execute({ query: "bail" }, ctx()))).rejects.toBeInstanceOf(LawCorpusNotConfiguredError);
  });
});
