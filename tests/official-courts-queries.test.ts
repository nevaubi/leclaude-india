import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { setRemoteStoreForTests, type RemoteStore, type Row, type SqlQuery } from "@/lib/db/remote";
import type { CauseListEntry } from "@/modules/official/types";
import { OfficialNotConfiguredError } from "@/modules/official/service";
import * as service from "@/modules/official/service";
import { parseCauseList } from "@/modules/official/causelist/parse";
import { entryCaseKeys, persistCauseListEntries } from "@/modules/official/causelist/persist";
import { causeListEntries, CauseListQueryError, listingsForMatters, ordersForIdentifiers, caseKeyOf, diaryKeyOf } from "@/modules/official/causelist/query";
import { caseKeyBindable, expandForum, forumMatches } from "@/modules/official/causelist/forums";
import { courtCalendar, courtCalendarWithSources, CalendarQueryError } from "@/modules/official/calendars/query";
import { persistHolidays } from "@/modules/official/calendars/persist";
import { isCourtOpen, nextOpenDay } from "@/lib/india/holidays";
import { wireCourts } from "@/modules/official/wire-courts";
import * as calendarsRoute from "@/app/api/official/calendars/route";
import * as causelistsRoute from "@/app/api/official/causelists/route";

/** Fake Postgres: records statements, answers the official-schema version check, replies per test. */
class FakeStore implements RemoteStore {
  calls: SqlQuery[] = [];
  txs: SqlQuery[][] = [];
  constructor(private readonly reply: (q: SqlQuery) => Row[] = () => []) {}
  async query(q: SqlQuery): Promise<Row[]> {
    if (q.query.includes("'official_schema_version'") && q.query.startsWith("SELECT")) return [{ value: "1" }];
    this.calls.push(q);
    return this.reply(q);
  }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> {
    this.txs.push(qs);
    const out: Row[][] = [];
    for (const q of qs) out.push(await this.query(q));
    return out;
  }
  sql(): string[] {
    return this.calls.map((c) => c.query).filter((q) => !q.includes("set_config"));
  }
  last(): SqlQuery {
    return this.calls.filter((c) => !c.query.includes("set_config")).at(-1)!;
  }
}

const FIX = path.resolve(__dirname, "fixtures/official/courts");
const read = (f: string) => readFileSync(path.join(FIX, f), "utf8");

afterEach(() => setRemoteStoreForTests(undefined));

function entryRow(e: Partial<Record<string, string | null>>): Row {
  return {
    id: "cle_1", document_id: "doc_1", forum: "sci", list_date: "2026-10-05", list_type: "main", court_no: "5", bench: "HON'BLE MR. JUSTICE X",
    item_no: "54", case_numbers: JSON.stringify([{ printed: "SLP(C) No. 1234/2026", normalized: "SLPC/1234/2026" }]), case_keys: '{"SLPC/1234/2026"}',
    diary_no: null, parties: "A Versus B", advocates: '{"AJAY MARWAH (AOR 2312)","B. \\"QUOTED\\" NAME"}', raw: "54 | SLP(C) No. 1234/2026", page: "3",
    published_at: null, fetched_at: "2026-10-02T10:00:00Z", parsed: "t", ...e,
  };
}

// ---------------------------------------------------------------------------------------------------------------------

describe("persistCauseListEntries", () => {
  const nclt = parseCauseList({ id: "doc_nclt", markdown: read("nclt-indore-05.10.2026.md"), pages: [], fetchedAt: "2026-10-02T10:00:00.000Z" }, { layout: "tribunal", forum: "nclt-indore", listType: "daily", listDate: "2026-10-05" });

  it("replaces the document's entries in one transaction with exact keys (NCLT bench-qualified, ranges expanded)", async () => {
    const store = new FakeStore();
    const range: CauseListEntry = { ...nclt.records[0], id: "cle_range", forum: "sci", itemNo: "1", caseNumbers: [{ printed: "C.A. No. 3309-3310/1997", normalized: null }], diaryNo: "54583/2026" };
    const unparsed: CauseListEntry = { ...nclt.records[0], id: "cle_unparsed", parsed: false, diaryNo: "1/2026" };
    const res = await persistCauseListEntries(store, "doc_nclt", [...nclt.records, range, unparsed]);
    expect(res.stored).toBe(nclt.records.length + 2);
    expect(store.txs).toHaveLength(1);
    const [del, ins] = store.txs[0];
    expect(del).toEqual({ query: "DELETE FROM causelist_entries WHERE document_id = $1", params: ["doc_nclt"] });
    expect(ins.query).toMatch(/^INSERT INTO causelist_entries .* FROM jsonb_to_recordset\(\$1::jsonb\)/s);
    expect(ins.query).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
    const rows = JSON.parse(String(ins.params![0])) as { id: string; case_keys: string[]; diary_no: string | null; raw: string; advocates: string[] }[];
    expect(rows.find((r) => r.id === nclt.records[0].id)!.case_keys).toEqual(["CPIB/29/2022", "CPIB/29/2022@MP"]);
    expect(rows.find((r) => r.id === "cle_range")!.case_keys).toEqual(["CA/3309/1997", "CA/3310/1997"]);
    expect(rows.find((r) => r.id === "cle_range")!.diary_no).toBe("54583/2026");
    // Unparsed entries are stored for display but carry no key and no diary number: they can never match a matter.
    expect(rows.find((r) => r.id === "cle_unparsed")).toMatchObject({ case_keys: [], diary_no: null });
    expect(JSON.stringify(rows)).not.toMatch(/@[A-Z0-9-]+\.[A-Z]{2,}/i);
  });

  it("only stores entries that belong to the document and scrubs contact data that slipped into a field", async () => {
    const store = new FakeStore();
    const e = { ...nclt.records[0], parties: "A V/s B (lawyer@example.com) 9000000001" };
    await persistCauseListEntries(store, "doc_nclt", [e, { ...e, id: "other", documentId: "doc_other" }]);
    const rows = JSON.parse(String(store.txs[0][1].params![0])) as { id: string; parties: string }[];
    expect(rows.map((r) => r.id)).toEqual([e.id]);
    expect(rows[0].parties).not.toMatch(/@|9000000001/);
  });

  it("an empty parse still replaces (deletes) the document's previous entries", async () => {
    const store = new FakeStore();
    await persistCauseListEntries(store, "doc_x", []);
    expect(store.txs[0]).toEqual([{ query: "DELETE FROM causelist_entries WHERE document_id = $1", params: ["doc_x"] }]);
  });

  it("large documents are upserted in batches, then leftovers of the old version are removed", async () => {
    const store = new FakeStore();
    const base = nclt.records[0];
    const many = Array.from({ length: 2600 }, (_, i) => ({ ...base, id: `cle_${i}`, raw: `${i} `.repeat(150) }));
    await persistCauseListEntries(store, "doc_nclt", many);
    expect(store.txs.length).toBeGreaterThan(2);
    const inserts = store.txs.slice(0, -1);
    expect(inserts.every((t) => t.length === 1 && t[0].query.startsWith("INSERT INTO causelist_entries"))).toBe(true);
    const final = store.txs.at(-1)!;
    expect(final[0].query).toMatch(/DELETE FROM causelist_entries WHERE document_id = \$1 AND NOT \(id = ANY/);
    expect(JSON.parse(String(final[0].params![1]))).toHaveLength(2600);
    expect(inserts.reduce((n, t) => n + JSON.parse(String(t[0].params![0])).length, 0)).toBe(2600);
  });

  it("entryCaseKeys is empty for unparsed entries", () => {
    expect(entryCaseKeys({ ...nclt.records[0], parsed: false })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("causeListEntries", () => {
  it("lists nothing without a date window or an identifier, and does not touch the database", async () => {
    const store = new FakeStore();
    expect(await causeListEntries({ forum: "sci" }, store)).toEqual([]);
    expect(await causeListEntries({ caseKeys: ["not a key"] }, store)).toEqual([]);
    expect(await causeListEntries({ date: "2026-10-05", caseKeys: ["nope"] }, store)).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it("filters by forum family and date window with bound parameters", async () => {
    const store = new FakeStore(() => [entryRow({ forum: "nclt-indore" })]);
    const out = await causeListEntries({ forum: "nclt", from: "2026-10-01", to: "2026-10-09" }, store);
    const q = store.last();
    expect(q.query).toContain("(forum = $1 OR forum LIKE $2)");
    expect(q.query).toContain("list_date BETWEEN $3::date AND $4::date");
    expect(q.params).toEqual(["nclt", "nclt-%", "2026-10-01", "2026-10-09", 200]);
    expect(out[0]).toMatchObject({ forum: "nclt-indore", page: 3, parsed: true, advocates: ["AJAY MARWAH (AOR 2312)", 'B. "QUOTED" NAME'] });
    expect(out[0].caseNumbers).toEqual([{ printed: "SLP(C) No. 1234/2026", normalized: "SLPC/1234/2026" }]);
  });

  it("matches case keys / diary numbers exactly and advocates by whole name", async () => {
    const store = new FakeStore(() => []);
    await causeListEntries({ caseKeys: ["SLPC/1234/2026", "bogus"], diaryNos: ["Diary No. 54583-2026"], advocate: "  Ajay   Marwah ", limit: 5000 }, store);
    const q = store.last();
    expect(q.query).toContain("case_keys && $1::text[]");
    expect(q.query).toContain("diary_no = ANY($2::text[])");
    expect(q.query).toContain("lower(regexp_replace(a, '\\s*\\(AOR [0-9]+\\)$', '')) = $3");
    expect(q.query).not.toMatch(/ILIKE|%Ajay|similarity|~\*/i);
    expect(q.params).toEqual(['{"SLPC/1234/2026"}', '{"54583/2026"}', "ajay marwah", 1000]);
  });

  it("rejects malformed or over-wide windows and unknown forums", async () => {
    const store = new FakeStore();
    await expect(causeListEntries({ date: "05-10-2026" }, store)).rejects.toBeInstanceOf(CauseListQueryError);
    await expect(causeListEntries({ from: "2026-01-01", to: "2026-06-01" }, store)).rejects.toThrow(/at most 62 days/);
    await expect(causeListEntries({ from: "2026-10-09", to: "2026-10-01" }, store)).rejects.toBeInstanceOf(CauseListQueryError);
    await expect(causeListEntries({ date: "2026-10-05", forum: "SCI; DROP" }, store)).rejects.toThrow(/unknown forum/);
    await expect(causeListEntries({ date: "2026-10-05", advocate: "1" }, store)).rejects.toBeInstanceOf(CauseListQueryError);
  });

  it("throws OfficialNotConfiguredError without Postgres", async () => {
    setRemoteStoreForTests(null);
    await expect(causeListEntries({ date: "2026-10-05" })).rejects.toBeInstanceOf(OfficialNotConfiguredError);
  });

  it("parses route parameters into keys without guessing", () => {
    expect(caseKeyOf("SLP(C) No. 1234/2026")).toBe("SLPC/1234/2026");
    expect(caseKeyOf("slpc/1234/2026")).toBe("SLPC/1234/2026");
    expect(caseKeyOf("C.A. No. 1-2/2026")).toBeNull();
    expect(diaryKeyOf("Diary No. 54583-2026")).toBe("54583/2026");
    expect(diaryKeyOf("abc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("forum matching", () => {
  it("is exact, with family roots and known aliases", () => {
    expect(forumMatches("sci", "sci")).toBe(true);
    expect(forumMatches("sc", "sci")).toBe(true);
    expect(forumMatches("hc-delhi", "sci")).toBe(false);
    expect(forumMatches("delhi-hc", "hc-delhi")).toBe(true);
    expect(forumMatches("nclt", "nclt-indore")).toBe(true);
    expect(forumMatches("nclt-indore", "nclt-mumbai")).toBe(false);
    expect(forumMatches("hc", "hc-delhi")).toBe(false);
    expect(expandForum("delhi-nclt")).toEqual(["nclt-principal", "nclt-new-delhi"]);
    expect(caseKeyBindable("nclt", "CPIB/29/2022", "nclt-indore")).toBe(false);
    expect(caseKeyBindable("nclt", "CPIB/29/2022@MP", "nclt-indore")).toBe(true);
    expect(caseKeyBindable("nclt-indore", "CPIB/29/2022", "nclt-indore")).toBe(true);
  });
});

describe("listingsForMatters", () => {
  const rows: Row[] = [
    entryRow({ id: "A", forum: "sci" }),
    entryRow({ id: "B", forum: "nclt-indore", case_keys: '{"CPIB/29/2022","CPIB/29/2022@MP"}', case_numbers: JSON.stringify([{ printed: "CP(IB)/29(MP)2022", normalized: "CPIB/29/2022" }]) }),
    entryRow({ id: "C", forum: "nclt-mumbai", case_keys: '{"CPIB/29/2022","CPIB/29/2022@MB"}', case_numbers: JSON.stringify([{ printed: "CP(IB)/29(MB)2022", normalized: "CPIB/29/2022" }]) }),
    entryRow({ id: "D", forum: "sci", case_keys: "{}", case_numbers: "[]", diary_no: "54583/2026" }),
    entryRow({ id: "E", forum: "sci", parsed: "f" }),
  ];

  it("binds identifiers only by exact key / diary number in a compatible forum", async () => {
    const store = new FakeStore(() => rows);
    const out = await listingsForMatters(
      [
        { matterId: "m1", identifiers: [{ forum: "sci", kind: "case_number", value: "SLPC/1234/2026" }] },
        { matterId: "m2", identifiers: [{ forum: "hc-delhi", kind: "case_number", value: "SLPC/1234/2026" }] },
        { matterId: "m3", identifiers: [{ forum: "nclt", kind: "case_number", value: "CPIB/29/2022" }] },
        { matterId: "m4", identifiers: [{ forum: "nclt-indore", kind: "case_number", value: "CPIB/29/2022" }] },
        { matterId: "m5", identifiers: [{ forum: "nclt", kind: "case_number", value: "CPIB/29/2022@MB" }] },
        { matterId: "m6", identifiers: [{ forum: "sci", kind: "diary_no", value: "54583/2026" }, { forum: "sci", kind: "case_number", value: "SLPC/1234/2026" }] },
        { matterId: "m7", identifiers: [{ forum: "sci", kind: "cnr", value: "SCIN010000012024" }, { forum: "sci", kind: "case_number", value: "SLP(C) No. 1234/2026" }] },
      ],
      { from: "2026-10-01", to: "2026-10-31" },
      store,
    );
    expect(out.map((m) => [m.matterId, m.entry.id, m.matchedOn.kind])).toEqual([
      ["m1", "A", "case_number"],
      ["m6", "A", "case_number"],
      ["m4", "B", "case_number"],
      ["m5", "C", "case_number"],
      ["m6", "D", "diary_no"],
    ]);
    const q = store.last();
    expect(q.query).toContain("WHERE parsed AND list_date BETWEEN $1::date AND $2::date");
    expect(q.params?.[0]).toBe("2026-10-01");
    expect(String(q.params?.[2])).toContain("CPIB/29/2022@MB");
    expect(String(q.params?.[2])).not.toContain("SLP(C)"); // printed values are not keys: never normalized on the fly
  });

  it("does nothing without valid identifiers and rejects bad windows", async () => {
    const store = new FakeStore(() => rows);
    expect(await listingsForMatters([{ matterId: "m", identifiers: [{ forum: "sci", kind: "case_number", value: "x" }] }], { from: "2026-10-01", to: "2026-10-02" }, store)).toEqual([]);
    expect(store.calls).toEqual([]);
    await expect(listingsForMatters([], { from: "2026-10-01", to: "2027-10-01" }, store)).rejects.toBeInstanceOf(CauseListQueryError);
  });
});

describe("ordersForIdentifiers", () => {
  const docRow = (id: string, meta: Record<string, unknown>, forum: string | null = null): Row => ({
    id, source: "sci-orders", kind: "order", url: `https://www.sci.gov.in/view-pdf/?diary_no=${id}`, file_url: null, title: id, doc_date: "2026-10-01", forum,
    status: "indexed", mime: "application/pdf", sha256: "ab", bytes: "10", pages: "2", extraction: "text_layer", ocr_pages: "{}", language: "en",
    meta: JSON.stringify(meta), version: "1", fetched_at: "2026-10-02T00:00:00Z", indexed_at: null, error: null, attempts: "1", chunks: "3",
  });

  it("matches published metadata exactly and checks the forum", async () => {
    const store = new FakeStore(() => [
      docRow("d1", { forum: "sci", diaryNo: "4240/2015", caseKeys: ["CRLA/166/2019"] }),
      docRow("d2", { forum: "hc-delhi", caseKeys: ["CRLA/166/2019"] }),
      docRow("d3", { caseKeys: ["CRLA/166/2019"] }, null),
    ]);
    const out = await ordersForIdentifiers([{ forum: "sci", kind: "case_number", value: "CRLA/166/2019" }], { since: "2026-09-01", limit: 10 }, store);
    expect(out.map((d) => d.id)).toEqual(["d1"]);
    expect(out[0]).toMatchObject({ sourceId: "sci-orders", kind: "order", pages: 2, chunks: 3, ocrPages: [] });
    const q = store.last();
    expect(q.query).toContain("meta @> $1::jsonb");
    expect(q.query).toContain("kind IN ('order', 'judgment')");
    expect(q.params?.[0]).toBe('{"caseKeys":["CRLA/166/2019"]}');
    expect(q.params?.[1]).toBe("2026-09-01");
  });

  it("matches diary numbers and refuses to answer for invalid identifiers", async () => {
    const store = new FakeStore(() => [docRow("d1", { forum: "sci", diaryNo: "4240/2015" })]);
    expect((await ordersForIdentifiers([{ forum: "sci", kind: "diary_no", value: "4240/2015" }], {}, store)).map((d) => d.id)).toEqual(["d1"]);
    const empty = new FakeStore();
    expect(await ordersForIdentifiers([{ forum: "sci", kind: "diary_no", value: "4240-2015" }], {}, empty)).toEqual([]);
    expect(empty.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

function holidayRow(h: Partial<Record<string, string | null>>): Row {
  return {
    forum: "sci", date_from: "2026-10-02", date_to: "2026-10-02", name: "Mahatma Gandhi's Birthday", kind: "holiday", registry_open: null,
    document_id: "doc_json", source_url: "https://www.sci.gov.in/wp-admin/admin-ajax.php?action=calender_get_holidays_for_this_month&year=2026", year: "2026",
    note: null, fetched_at: "2026-10-02T04:00:00Z", covers: "[2026]", doc_url: "https://www.sci.gov.in/wp-admin/admin-ajax.php?action=calender_get_holidays_for_this_month&year=2026", ...h,
  };
}

describe("courtCalendar", () => {
  const sciRows = [
    holidayRow({}),
    holidayRow({ date_from: "2026-10-19", date_to: "2026-10-24", name: "Dussehra Holidays 2026", kind: "vacation" }),
    holidayRow({ date_from: "2026-12-21", date_to: "2027-01-01", name: "Christmas and New Year Holidays 2026", kind: "vacation" }),
    holidayRow({ date_from: "2026-06-01", date_to: "2026-07-12", name: "Partial Court Working Days", kind: "partial_working" }),
    holidayRow({ date_from: "2026-03-02", date_to: "2026-03-03", name: "Two-day holiday", kind: "holiday" }),
    holidayRow({ date_from: "2026-10-02", date_to: "2026-10-02", name: "Mahatma Gandhi's Birthday", document_id: "doc_html", covers: "[2026]", doc_url: "https://www.sci.gov.in/calendar/" }),
    holidayRow({ date_from: "2025-12-22", date_to: "2026-01-01", name: "Christmas & New Year Holidays 2025", kind: "vacation", year: "2025" }),
  ];

  it("builds the notified calendar for covered years only, with closures and sources", async () => {
    const store = new FakeStore(() => sciRows);
    const r = await courtCalendarWithSources("sci", [2026, 2027], store);
    const cal = r.calendar!;
    expect(cal).toMatchObject({ id: "official:sci:2026", courtId: "sci", years: [2026], weeklyOff: [0], sample: false });
    expect(cal.holidays).toEqual([
      { date: "2026-03-02", name: "Two-day holiday" },
      { date: "2026-03-03", name: "Two-day holiday" },
      { date: "2026-10-02", name: "Mahatma Gandhi's Birthday" },
    ]);
    expect(cal.vacations.map((v) => [v.from, v.to])).toEqual([["2025-12-22", "2026-01-01"], ["2026-10-19", "2026-10-24"], ["2026-12-21", "2027-01-01"]]);
    expect(cal.source).toContain("https://www.sci.gov.in/calendar/");
    expect(cal.source).toContain("Partial court working days (not closures): 2026-06-01 to 2026-07-12");
    expect(r.sources.map((s) => s.documentId).sort()).toEqual(["doc_html", "doc_json"]);
    // Through holidays.ts: closures close the court, partial working days do not, uncovered years stay unknown.
    expect(isCourtOpen("2026-10-02", cal)).toEqual({ open: false, reason: "holiday: Mahatma Gandhi's Birthday" });
    expect(isCourtOpen("2026-06-15", cal)).toEqual({ open: true });
    expect(isCourtOpen("2027-01-04", cal).open).toBe("unknown");
    expect(nextOpenDay("2026-10-19", cal).date).toBe("2026-10-26");
    const q = store.last();
    expect(q.params).toEqual(['{"sci"}', "2025-12-01", "2027-12-31"]);
  });

  it("returns null (never a sample) when no official calendar covers the years", async () => {
    const store = new FakeStore(() => sciRows.map((r) => ({ ...r, covers: "[]" })));
    const r = await courtCalendarWithSources("sci", [2026], store);
    expect(r.calendar).toBeNull();
    expect(r.notes[0]).toMatch(/no official calendar loaded/);
    expect(await courtCalendar("hc-delhi", [2026], new FakeStore())).toBeNull();
  });

  it("falls back from an NCLT bench to the tribunal-wide calendar", async () => {
    const store = new FakeStore(() => [holidayRow({ forum: "nclt", document_id: "doc_nclt", covers: "[2026]", doc_url: "https://nclt.gov.in/sites/default/files/Ncltcalender/Calendar%202026.pdf" })]);
    const r = await courtCalendarWithSources("nclt-indore", [2026], store);
    expect(r.forum).toBe("nclt");
    expect(r.calendar?.courtId).toBe("nclt");
    expect(store.last().params?.[0]).toBe('{"nclt-indore","nclt"}');
  });

  it("validates forum and years", async () => {
    await expect(courtCalendarWithSources("SCI!", [2026], new FakeStore())).rejects.toBeInstanceOf(CalendarQueryError);
    await expect(courtCalendarWithSources("sci", [], new FakeStore())).rejects.toBeInstanceOf(CalendarQueryError);
    await expect(courtCalendarWithSources("sci", [2020, 2021, 2022, 2023, 2024, 2025, 2026], new FakeStore())).rejects.toBeInstanceOf(CalendarQueryError);
  });

  it("persistHolidays replaces the document's rows and records the covered years in one transaction", async () => {
    const store = new FakeStore();
    await persistHolidays(store, { id: "doc_json", url: "https://www.sci.gov.in/calendar/", fetchedAt: "2026-10-02T04:00:00Z" }, [
      { forum: "sci", dateFrom: "2026-10-02", dateTo: "2026-10-02", name: "Gandhi Jayanti", kind: "holiday", registryOpen: null, year: 2026, note: null },
      { forum: "sci", dateFrom: "2026-10-02", dateTo: "2026-10-02", name: "Gandhi Jayanti", kind: "holiday", registryOpen: null, year: 2026, note: null },
    ], [2026]);
    const [del, ins, upd] = store.txs[0];
    expect(del.query).toBe("DELETE FROM court_holidays WHERE document_id = $1");
    expect(JSON.parse(String(ins.params![0]))).toHaveLength(1);
    expect(upd.query).toContain("meta = meta || jsonb_build_object('coversYears', $2::jsonb, 'holidaysParsed', $3::int)");
    expect(upd.params).toEqual(["doc_json", "[2026]", 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("service facade wiring", () => {
  it("wire-courts registers the courts implementations", async () => {
    wireCourts();
    const store = new FakeStore(() => [entryRow({})]);
    expect(await service.causeListEntries({ date: "2026-10-05" }, store)).toHaveLength(1);
    expect(await service.courtCalendar("sci", [2026], new FakeStore())).toBeNull();
    expect(await service.listingsForMatters([], { from: "2026-10-01", to: "2026-10-02" }, store)).toEqual([]);
    expect(await service.ordersForIdentifiers([], {}, store)).toEqual([]);
  });
});

describe("routes", () => {
  const req = (p: string) => new NextRequest(`http://localhost${p}`);

  it("GET /api/official/calendars", async () => {
    setRemoteStoreForTests(new FakeStore(() => [holidayRow({})]));
    const ok = await calendarsRoute.GET(req("/api/official/calendars?forum=sci&years=2026"));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.calendar).toMatchObject({ courtId: "sci", years: [2026], sample: false });
    expect(body.sources).toHaveLength(1);
    expect((await calendarsRoute.GET(req("/api/official/calendars?forum=x%20y"))).status).toBe(400);
    expect((await calendarsRoute.GET(req("/api/official/calendars?forum=sci&years=20x6"))).status).toBe(400);
    setRemoteStoreForTests(null);
    const off = await calendarsRoute.GET(req("/api/official/calendars?forum=sci&years=2026"));
    expect(off.status).toBe(503);
    expect((await off.json()).code).toBe("official_not_configured");
  });

  it("GET /api/official/causelists", async () => {
    setRemoteStoreForTests(new FakeStore(() => [entryRow({})]));
    const ok = await causelistsRoute.GET(req("/api/official/causelists?forum=sci&date=2026-10-05&case=SLP(C)%20No.%201234/2026"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).count).toBe(1);
    expect((await causelistsRoute.GET(req("/api/official/causelists?forum=sci"))).status).toBe(400);
    const bad = await causelistsRoute.GET(req("/api/official/causelists?case=SLP%20something"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("bad_case_number");
    expect((await causelistsRoute.GET(req("/api/official/causelists?from=2026-01-01&to=2026-12-31"))).status).toBe(400);
    setRemoteStoreForTests(null);
    expect((await causelistsRoute.GET(req("/api/official/causelists?date=2026-10-05"))).status).toBe(503);
  });
});
