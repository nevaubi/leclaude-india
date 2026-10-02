import { beforeEach, describe, expect, it } from "vitest";
import { CORPUS_SCHEMA_VERSION } from "@/modules/india/corpus/schema";
import { TEXT_ATTRIBUTION, TEXT_ATTRIBUTION_DISPLAY } from "@/modules/india/corpus/text";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { resetCorpusSchemaCacheForTests } from "@/modules/india/corpus/backfill";
import {
  corpusFacets, CorpusNotConfiguredError, decodeCursor, isoTimestamp, judgmentRecord, listJudgments, parseTranslations, resetFacetsCacheForTests, shapeFacets, sourceInfo,
} from "@/modules/india/corpus/directory";
import { caseFiltersToParams, caseHref, caseIdFromSegments, courtOptions, filterLabel, formatCaseDate, parseCaseFilters, yearSpan, type CourtFacet } from "@/modules/caselaw/shared";

/** A fake Neon store: answers the schema probe, records every other statement, and replies from a handler. */
class FakeStore implements RemoteStore {
  calls: SqlQuery[] = [];
  constructor(private readonly reply: (q: SqlQuery) => Row[] | Promise<Row[]> = () => []) {}
  async query(q: SqlQuery): Promise<Row[]> {
    if (q.query.includes("to_regclass")) return [{ t: "corpus_state" }];
    if (q.query.includes("FROM corpus_state WHERE key = 'schema_version'")) return [{ value: String(CORPUS_SCHEMA_VERSION) }];
    this.calls.push(q);
    return this.reply(q);
  }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> { return Promise.all(qs.map((q) => this.query(q))); }
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "sc:2024_1_1_10", source: "sci-open-data", title: "A v. B", court_id: "sci", court_code: null, bench_id: "sci-delhi", bench_code: null, bench_strength: "2",
    year: "2024", decision_date: "2024-08-07", case_number: "Civil Appeal No. 1 of 2024", cnr: "SCIN010000012024", neutral_citation: "2024 INSC 1",
    reporter_citation: "[2024] 8 S.C.R. 1", judges: '{"BELA M. TRIVEDI","SATISH CHANDRA SHARMA"}', disposal: "Dismissed", pdf_url: "https://indian-supreme-court-judgments.s3.amazonaws.com/x.pdf",
    snippet: "Headnote", text_status: "none", issues: null, ...over,
  };
}

beforeEach(() => { resetCorpusSchemaCacheForTests(); resetFacetsCacheForTests(); });

describe("directory parameters", () => {
  it("parses and clamps filters from a query string, dropping values it cannot trust", () => {
    const f = parseCaseFilters(new URLSearchParams("q=" + "x".repeat(300) + "&court=sci&court=hc-karnataka,code:99_9&court=sci';DROP TABLE x;--&from=2026&to=1990&judge=%20Trivedi%20&sort=bogus"));
    expect(f.q.length).toBe(200);
    expect(f.courts).toEqual(["sci", "hc-karnataka", "code:99_9"]);
    expect([f.yearFrom, f.yearTo]).toEqual([1990, 2026]);
    expect(f.judge).toBe("Trivedi");
    expect(f.sort).toBe("relevance");
    expect(parseCaseFilters(new URLSearchParams("from=1200&to=abc")).yearFrom).toBeUndefined();
    expect(parseCaseFilters(new URLSearchParams("")).sort).toBe("newest");
    // Round trip: defaults are omitted from the URL.
    expect(caseFiltersToParams(parseCaseFilters(new URLSearchParams("court=sci&from=2020"))).toString()).toBe("court=sci&from=2020");
  });

  it("rejects malformed cursors", () => {
    expect(decodeCursor("o:50")).toEqual({ kind: "offset", offset: 50 });
    expect(decodeCursor("o:-1")).toBeNull();
    expect(decodeCursor("o:99999")).toBeNull();
    expect(decodeCursor("k:2024-08-07|sc:abc")).toEqual({ kind: "key", date: "2024-08-07", id: "sc:abc" });
    expect(decodeCursor("k:|hc:1/2/3")).toEqual({ kind: "key", date: null, id: "hc:1/2/3" });
    expect(decodeCursor("k:2024-08-07'; drop|x")).toBeNull();
    expect(decodeCursor("garbage")).toBeNull();
  });

  it("round-trips record ids with slashes and colons through the catch-all route", () => {
    const id = "hc:29_3/karhcdharwad/KAHC020100052022_1_2024-08-07";
    const href = caseHref(id);
    expect(href).toBe("/cases/hc%3A29_3/karhcdharwad/KAHC020100052022_1_2024-08-07");
    expect(caseIdFromSegments(href.replace("/cases/", "").split("/"))).toBe(id);
    expect(caseIdFromSegments(["hc:29_3", "karhcdharwad", "x"])).toBe("hc:29_3/karhcdharwad/x");
    expect(caseIdFromSegments(["other:1"])).toBeNull();
    expect(caseIdFromSegments([])).toBeNull();
  });

  it("formats dates and spans without time zone drift", () => {
    expect(formatCaseDate("2024-08-07")).toBe("7 Aug 2024");
    expect(formatCaseDate(null)).toBeNull();
    expect(yearSpan(1950, 2026)).toBe("1950–2026");
    expect(yearSpan(2025, 2026)).toBe("2025–26");
    expect(yearSpan(2026, 2026)).toBe("2026");
    expect(isoTimestamp("2026-09-30 12:00:00.5+00")).toBe("2026-09-30T12:00:00.500Z");
    expect(isoTimestamp("nonsense")).toBeNull();
  });
});

describe("listJudgments", () => {
  it("browses by decision date with bound parameters, a probe row for hasMore and a keyset cursor", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ id: `sc:${i}`, decision_date: `2024-08-0${7 - i}` }));
    const store = new FakeStore(() => rows);
    const res = await listJudgments({ courts: ["sci", "code:99_9"], yearFrom: 2020, judge: "Trivedi'%_; DROP", disposal: "Dismissed", limit: 2 }, store);
    expect(res.mode).toBe("browse");
    expect(res.hits.map((h) => h.id)).toEqual(["sc:0", "sc:1"]);
    expect(res.hits[0]).toMatchObject({ match: "browse", court: "Supreme Court of India", judges: ["BELA M. TRIVEDI", "SATISH CHANDRA SHARMA"], bench_strength: 2 });
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe("k:2024-08-06|sc:1");
    const q = store.calls[0];
    expect(q.query).toMatch(/ORDER BY decision_date DESC NULLS LAST, id DESC LIMIT 3$/);
    expect(q.query).not.toContain("Trivedi");
    expect(q.query).not.toContain("Dismissed");
    expect(q.query).toContain("(court_id = ANY($1::text[]) OR (court_id IS NULL AND court_code = ANY($2::text[])))");
    expect(q.params).toEqual(['{"sci"}', '{"99_9"}', 2020, "%Trivedi'; DROP%", "%Dismissed%"]);

    store.calls = [];
    await listJudgments({ cursor: res.nextCursor, limit: 2 }, store);
    expect(store.calls[0].query).toContain("AND (decision_date < $1::date OR (decision_date = $1::date AND id < $2) OR decision_date IS NULL)");
    expect(store.calls[0].params).toEqual(["2024-08-06", "sc:1"]);

    store.calls = [];
    await listJudgments({ sort: "oldest", cursor: "k:|sc:9", limit: 500 }, store);
    expect(store.calls[0].query).toContain("AND decision_date IS NULL AND id > $1");
    expect(store.calls[0].query).toMatch(/ORDER BY decision_date ASC NULLS LAST, id ASC LIMIT 51$/);
  });

  it("returns no more pages when the probe row is absent", async () => {
    const store = new FakeStore(() => [row()]);
    const res = await listJudgments({ limit: 5 }, store);
    expect(res).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("searches with exact identifiers first and pages by offset within the search window", async () => {
    const store = new FakeStore((q) => {
      if (q.query.includes("cnr = $1")) return [row({ id: "sc:exact" })];
      if (q.query.includes("websearch_to_tsquery")) return Array.from({ length: 80 }, (_, i) => row({ id: `sc:t${i}`, rank: String(1 - i / 100) }));
      return [];
    });
    const res = await listJudgments({ q: "SCIN010000012024", limit: 10 }, store);
    expect(res.mode).toBe("search");
    expect(res.hits[0]).toMatchObject({ id: "sc:exact", match: "exact" });
    expect(store.calls[0].params).toEqual(["SCIN010000012024"]);
    expect(store.calls[0].query).toMatch(/LIMIT 11$/);

    const fts = new FakeStore((q) => (q.query.includes("websearch_to_tsquery('english', $1) OR") ? Array.from({ length: 80 }, (_, i) => row({ id: `sc:t${i}` })) : []));
    const p2 = await listJudgments({ q: "land acquisition", cursor: "o:50", limit: 25, sort: "newest" }, fts);
    expect(p2.hits.map((h) => h.id)).toEqual(Array.from({ length: 25 }, (_, i) => `sc:t${50 + i}`));
    expect(p2.hasMore).toBe(true);
    expect(p2.nextCursor).toBe("o:75");
    const main = fts.calls.find((c) => c.query.includes("OR search @@"))!;
    expect(main.params?.[0]).toBe("land acquisition");
    expect(main.query).toContain("ORDER BY decision_date DESC NULLS LAST, id DESC LIMIT 76");

    // Past the window: nothing, and no query.
    const none = new FakeStore();
    expect(await listJudgments({ q: "x y", cursor: "o:490", limit: 25 }, none)).toMatchObject({ hits: [], hasMore: false });
    expect(none.calls).toHaveLength(0);
  });

  it("fails closed when the corpus is not configured", async () => {
    await expect(listJudgments({}, null)).rejects.toBeInstanceOf(CorpusNotConfiguredError);
    await expect(corpusFacets(null)).rejects.toBeInstanceOf(CorpusNotConfiguredError);
    await expect(judgmentRecord("sc:1", null)).rejects.toBeInstanceOf(CorpusNotConfiguredError);
  });
});

describe("corpusFacets", () => {
  const groups: Row[] = [
    { court_id: "sci", court_code: null, year: "1950", n: "100", min_date: "1950-01-26", max_date: "1950-12-01" },
    { court_id: "sci", court_code: null, year: "2026", n: "900", min_date: "2026-01-02", max_date: "2026-09-29" },
    { court_id: "hc-karnataka", court_code: null, year: "2025", n: "50", min_date: "2025-01-01", max_date: "2025-12-31" },
    { court_id: "hc-karnataka", court_code: null, year: "2026", n: "70", min_date: "2026-01-01", max_date: "2026-09-01" },
    { court_id: null, court_code: "99_9", year: "2026", n: "3", min_date: null, max_date: null },
  ];
  const units: Row[] = [
    { source: "sci-open-data", court_code: null, done: "77", total: "77" },
    { source: "hc-open-data", court_code: "29_3", done: "4", total: "6" },
    { source: "hc-open-data", court_code: "36_29", done: "0", total: "2" },
  ];

  it("shapes counts per court and year, coverage, archive progress and unmapped codes", () => {
    const f = shapeFacets(groups, { last_ingested: "2026-09-30 10:00:00+00" }, [{ disposal: "Dismissed", n: "500" }, { disposal: null, n: "9" }], units, new Date("2026-10-01T00:00:00Z"));
    expect(f.total).toBe(1123);
    expect(f.courts.map((c) => c.key)).toEqual(["sci", "hc-karnataka", "code:99_9"]);
    expect(f.courts[0]).toMatchObject({ level: "supreme", records: 1000, minYear: 1950, maxYear: 2026, minDate: "1950-01-26", maxDate: "2026-09-29", archives: { done: 77, total: 77 } });
    expect(f.courts[0].years[0]).toEqual({ year: 2026, records: 900 });
    expect(f.courts[1]).toMatchObject({ name: "High Court of Karnataka", level: "high", records: 120, archives: { done: 4, total: 6 } });
    // Unknown dataset code: kept verbatim, never mapped to a registry court.
    expect(f.courts[2]).toMatchObject({ courtId: null, courtCode: "99_9", level: "unmapped", name: "Unmapped court code 99_9", archives: null });
    expect(f.disposals).toEqual([{ value: "Dismissed", records: 500 }]);
    expect(f.lastIngestedAt).toBe("2026-09-30T10:00:00.000Z");
  });

  it("caches for ten minutes and serves the last good copy (marked stale) when a recompute fails", async () => {
    let fail = false;
    const store = new FakeStore((q) => {
      if (fail) throw new Error("db down");
      if (q.query.includes("GROUP BY 1, 2, 3")) return groups;
      if (q.query.includes("max(ingested_at)")) return [{ last_ingested: null }];
      if (q.query.includes("FROM corpus_units")) return units;
      return [];
    });
    let t = 0;
    const now = () => t;
    const a = await corpusFacets(store, now);
    const n = store.calls.length;
    expect(n).toBe(4);
    await corpusFacets(store, now);
    expect(store.calls.length).toBe(n);
    t = 11 * 60 * 1000;
    fail = true;
    const b = await corpusFacets(store, now);
    expect(b.stale).toBe(true);
    expect(b.total).toBe(a.total);
  });
});

describe("judgmentRecord", () => {
  const rec = row({
    id: "hc:29_3/karhcdharwad/KAHC1", source: "hc-open-data", court_id: "hc-karnataka", court_code: "29_3", bench_id: "kar-dharwad", bench_code: "karhcdharwad",
    unit_id: "hc:metadata/tar/year=2026/court=29_3/bench=karhcdharwad/metadata.tar.gz", dataset_key: "metadata/json/year=2026/court=29_3/bench=karhcdharwad/KAHC1.json",
    cnr: "KAHC020100052022", neutral_citation: "2026:KHC-D:1", petitioner: "A", respondent: "B", case_type: "MFA", author: null, registration_date: "2022-12-28",
    language: "en", translations: '[{"language":"kn","origin":"court_published","url":"https://example.org/k.pdf"},{"language":"hi","url":"javascript:alert(1)"}]',
    pdf_key: "data/pdf/x.pdf", record_sha256: "a".repeat(64), ingested_at: "2026-09-01 08:00:00+00", updated_at: "2026-09-01 08:00:00+00",
    u_id: "hc:metadata/tar/year=2026/court=29_3/bench=karhcdharwad/metadata.tar.gz", u_source: "hc-open-data", u_year: "2026", u_court_code: "29_3", u_bench_code: "karhcdharwad",
    u_folder: "metadata/tar/year=2026/court=29_3/bench=karhcdharwad/", u_object_key: "metadata/tar/year=2026/court=29_3/bench=karhcdharwad/metadata.tar.gz", u_status: "done",
    u_expected: "10", u_stored: "10", u_rejected: "0", u_note: null, u_finished_at: "2026-09-01 08:05:00+00",
  });

  it("returns every field with provenance and lists same-case records with the reason, never merged", async () => {
    const store = new FakeStore((q) => {
      if (q.query.includes("LEFT JOIN corpus_units")) return q.params?.[0] === rec.id ? [rec] : [];
      if (q.query.includes("id <> $1")) return [
        row({ id: "hc:29_3/karhcdharwad/KAHC1-interim", court_id: "hc-karnataka", cnr: "KAHC020100052022", neutral_citation: null }),
        row({ id: "hc:other", court_id: "hc-karnataka", cnr: "OTHER", neutral_citation: "2026:KHC-D:1" }),
        row({ id: "hc:unrelated", cnr: "X", neutral_citation: "Y" }),
      ];
      return [];
    });
    const res = await judgmentRecord(rec.id!, store);
    expect(res).not.toBeNull();
    const r = res!.record;
    expect(r).toMatchObject({ court: "High Court of Karnataka", bench: "Dharwad Bench", case_type: "MFA", author: null, registration_date: "2022-12-28", text_status: "none", ingested_at: "2026-09-01T08:00:00.000Z" });
    expect(r.translations).toEqual([{ language: "kn", origin: "court_published", url: "https://example.org/k.pdf" }, { language: "hi", origin: null, url: null }]);
    expect(r.unit).toMatchObject({ status: "done", expected: 10, stored: 10, archiveUrl: "https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com/metadata/tar/year=2026/court=29_3/bench=karhcdharwad/metadata.tar.gz" });
    expect(r.sourceInfo).toMatchObject({ registered: true, dataset: "indian-high-court-judgments", registryUrl: "https://registry.opendata.aws/indian-high-court-judgments/" });
    const sameQ = store.calls.find((c) => c.query.includes("id <> $1"))!;
    expect(sameQ.params).toEqual([rec.id, "KAHC020100052022", "2026:KHC-D:1"]);
    expect(res!.sameCase.map((s) => [s.id, s.reasons])).toEqual([["hc:29_3/karhcdharwad/KAHC1-interim", ["cnr"]], ["hc:other", ["neutral_citation"]]]);
  });

  it("returns null for an unknown id and does not look for same-case records without identifiers", async () => {
    const store = new FakeStore(() => []);
    expect(await judgmentRecord("sc:missing", store)).toBeNull();
    const bare = new FakeStore((q) => (q.query.includes("LEFT JOIN") ? [{ ...rec, cnr: null, neutral_citation: null, u_id: null }] : []));
    const res = await judgmentRecord(rec.id!, bare);
    expect(res!.sameCase).toEqual([]);
    expect(res!.record.unit).toBeNull();
    expect(bare.calls.some((c) => c.query.includes("id <> $1"))).toBe(false);
  });

  it("describes unknown sources honestly and drops unsafe translation URLs", () => {
    expect(sourceInfo("mystery")).toMatchObject({ registered: false, registryUrl: null });
    expect(sourceInfo("mystery").licence).toMatch(/Unknown/);
    expect(sourceInfo("sci-open-data").licence).toMatch(/AWS Open Data Registry entry/);
    expect(parseTranslations("not json")).toEqual([]);
  });
});

describe("court options (unmapped courts merged)", () => {
  const facet = (over: Partial<CourtFacet>): CourtFacet => ({
    key: "sci", courtId: "sci", courtCode: null, name: "Supreme Court of India", level: "supreme", records: 10,
    minDate: "2000-01-01", maxDate: "2024-01-01", minYear: 2000, maxYear: 2024, years: [{ year: 2024, records: 10 }], archives: null, ...over,
  });
  const facets: CourtFacet[] = [
    facet({}),
    facet({ key: "hc-karnataka", courtId: "hc-karnataka", name: "High Court of Karnataka", level: "high", records: 5 }),
    facet({ key: "code:99_9", courtId: null, courtCode: "99_9", name: "Unmapped court code 99_9", level: "unmapped", records: 3, minYear: 2015, maxYear: 2019, minDate: "2015-02-01", maxDate: "2019-03-01", years: [{ year: 2019, records: 2 }, { year: 2015, records: 1 }], archives: { done: 1, total: 2 } }),
    facet({ key: "code:98_1", courtId: null, courtCode: "98_1", name: "Unmapped court code 98_1", level: "unmapped", records: 4, minYear: 2012, maxYear: 2018, minDate: "2012-05-01", maxDate: "2018-06-01", years: [{ year: 2019, records: 4 }], archives: null }),
  ];

  it("merges every unmapped code into one 'Other courts' option with summed counts and the combined span", () => {
    const opts = courtOptions(facets);
    expect(opts.map((o) => o.name)).toEqual(["Supreme Court of India", "High Court of Karnataka", "Other courts"]);
    const other = opts[2];
    expect(other).toMatchObject({ level: "unmapped", records: 7, minYear: 2012, maxYear: 2019, minDate: "2012-05-01", maxDate: "2019-03-01", archives: { done: 1, total: 2 } });
    expect(other.keys).toEqual(["code:99_9", "code:98_1"]);
    expect(other.years).toEqual([{ year: 2019, records: 6 }, { year: 2015, records: 1 }]);
    expect(opts[0].keys).toEqual(["sci"]);
    expect(courtOptions(facets.slice(0, 2)).some((o) => o.level === "unmapped")).toBe(false);
    expect(courtOptions(null)).toEqual([]);
  });

  it("labels the filter by option, counting the merged option once and never showing a raw code", () => {
    const opts = courtOptions(facets);
    expect(filterLabel(opts, [])).toBe("All courts");
    expect(filterLabel(opts, ["code:99_9", "code:98_1"])).toBe("Other courts");
    expect(filterLabel(opts, ["sci", "code:99_9", "code:98_1"])).toBe("2 courts");
    expect(filterLabel(opts, ["hc-karnataka"])).toBe("Karnataka HC");
    expect(filterLabel(opts, ["code:gone"])).toBe("Other courts");
    expect(filterLabel([], ["code:a", "code:b"])).toBe("Other courts");
  });

  it("keeps all merged codes as filter values through the URL", () => {
    const f = parseCaseFilters(new URLSearchParams(courtOptions(facets)[2].keys.map((k) => ["court", k])));
    expect(f.courts).toEqual(["code:99_9", "code:98_1"]);
    expect(caseFiltersToParams(f).getAll("court")).toEqual(["code:99_9", "code:98_1"]);
  });
});

describe("judgment text attribution", () => {
  it("keeps the full provenance for tools and a plain line for readers", () => {
    expect(TEXT_ATTRIBUTION).toMatch(/Open India Law \(Vaquill\), CC BY 4\.0/);
    expect(TEXT_ATTRIBUTION_DISPLAY).toBe("Text: Open India Law (CC BY 4.0), from the court's published PDF. The official PDF is the text of record.");
  });
});
