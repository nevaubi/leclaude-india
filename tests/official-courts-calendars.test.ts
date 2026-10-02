import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calendarCoverage,
  calendarJsonText,
  dedupeHolidays,
  normalizeOcrMath,
  parseCalendarNotes,
  parseHolidayTable,
  parseSciHolidayJson,
  truthfulCoverage,
  type HolidayRecord,
} from "@/modules/official/calendars/parse";
import { htmlParagraphs } from "@/modules/india/sources/parse-util";
import type { ParseInput } from "@/modules/official/adapter";
import { calendarParse } from "@/modules/official/adapters/courts/common";
import { sciHolidayJsonUrl } from "@/modules/official/adapters/courts/sci-calendar";
import { extractDocument, extractHtml, pageMarkdown, type ExtractedDocument } from "@/modules/official/extract";
import { scrubPages } from "@/modules/official/pipeline";
import { chunkMarkdown } from "@/modules/official/chunk";

/**
 * Fixtures (tests/fixtures/official/courts, captured 2026-10-02 via Firecrawl, location IN):
 * - sci-calendar-ajax.json: the holiday data https://www.sci.gov.in/calendar/ loads (admin-ajax.php?action=
 *   calender_get_holidays_for_this_month&year=2026&month=10...), verbatim entries (most 2027 entries trimmed).
 * - sci-calendar-page.html: the page's server-rendered holiday table (swapped header labels) and the year-PDF anchors.
 * - sci-calendar-2027.md: Firecrawl PDF text of "Calendar for the year 2027 (PDF)" (month grid partly trimmed).
 * - dhc-calendar-2026.md: Firecrawl OCR text of Delhi High Court calendar_2026.pdf (scanned; month grid partly trimmed).
 */

const FIX = path.resolve(__dirname, "fixtures/official/courts");
const read = (f: string) => readFileSync(path.join(FIX, f), "utf8");
const find = (rs: HolidayRecord[], name: RegExp) => rs.find((r) => name.test(r.name));

describe("Supreme Court holiday data (JSON behind /calendar/)", () => {
  const r = parseSciHolidayJson(read("sci-calendar-ajax.json"));

  it("maps every typed entry, keeping cross-year ranges and the year each belongs to", () => {
    expect(r.unparsed).toBe(0);
    expect(r.records).toHaveLength(28);
    expect(find(r.records, /^Republic Day 2026$/)).toMatchObject({ forum: "sci", dateFrom: "2026-01-26", dateTo: "2026-01-26", kind: "holiday", year: 2026 });
    expect(find(r.records, /^Christmas and New Year Holidays 2026$/)).toMatchObject({ dateFrom: "2026-12-21", dateTo: "2027-01-01", kind: "vacation", year: 2026 });
    expect(find(r.records, /^Christmas & New Year Holidays 2025$/)).toMatchObject({ dateFrom: "2025-12-22", dateTo: "2026-01-01", year: 2025 });
    expect(find(r.records, /^Partial Court Working Days$/)).toMatchObject({ dateFrom: "2026-06-01", dateTo: "2026-07-12", kind: "partial_working" });
    expect(find(r.records, /Mahatma Gandhi/)?.name).toBe("Mahatma Gandhi's Birthday");
  });

  it("covers only the requested year (the feed also carries the tail of 2025 and early 2027 entries)", () => {
    expect(calendarCoverage(r.records, { year: 2026, format: "json" })).toEqual([2026]);
    expect(calendarCoverage(r.records, { year: 2025, format: "json" })).toEqual([]);
    expect(calendarCoverage(r.records, { year: null, format: "json" })).toEqual([]);
  });

  it("rejects entries whose printed weekday disagrees with the date, unknown types and bad JSON", () => {
    const bad = JSON.stringify({ data: { holidays: [
      { start_date: "26/01/2026", end_date: "26/01/2026", start_year: "2026", title: "Republic Day", type: "gazetted", days_of_the_week: { start: "Tuesday", end: "" } },
      { start_date: "27/01/2026", end_date: "27/01/2026", start_year: "2026", title: "X", type: "restricted-maybe" },
      { start_date: "31/02/2026", end_date: "31/02/2026", start_year: "2026", title: "Y", type: "gazetted" },
      { start_date: "07/03/2026", end_date: "07/03/2026", start_year: "2026", title: "Notified working Saturday", type: "weekend-working" },
    ] } });
    const x = parseSciHolidayJson(bad);
    expect(x.records.map((h) => [h.kind, h.dateFrom])).toEqual([["working_day", "2026-03-07"]]);
    expect(x.unparsed).toBe(3);
    expect(x.notes.join(" ")).toMatch(/weekday mismatch.*Republic Day/);
    expect(parseSciHolidayJson("<html>").records).toEqual([]);
  });
});

describe("Supreme Court calendar page table (header labels swapped)", () => {
  it("finds the name and date columns per row and resolves the year from the printed weekdays", () => {
    const t = parseHolidayTable(htmlParagraphs(read("sci-calendar-page.html")), { forum: "sci", fetchedYear: 2026 });
    expect(t.year).toBe(2026);
    expect(t.records).toHaveLength(24);
    expect(t.records[0]).toMatchObject({ name: "Christmas and New Year Holidays 2025", dateFrom: "2026-01-02", kind: "holiday" });
    expect(find(t.records, /Partial Court Working Days/)).toMatchObject({ kind: "partial_working", dateFrom: "2026-06-01", dateTo: "2026-07-12" });
    expect(t.records[t.records.length - 1]).toMatchObject({ dateFrom: "2026-12-21", dateTo: "2027-01-01", kind: "vacation" });
    expect(calendarCoverage(t.records, { year: null, format: "html_table" })).toEqual([2026]);
  });

  it("does not guess a year when the printed weekdays fit none (or several) of the candidate years", () => {
    const rows = ["| Holiday A | January 2 | Monday |", "| Holiday B | March 3 | Monday |", "| Holiday C | May 4 | Monday |"].join("\n");
    const t = parseHolidayTable(rows, { forum: "sci", fetchedYear: 2026 });
    expect(t.records).toEqual([]);
    expect(t.year).toBeNull();
    expect(t.notes[0]).toMatch(/could not be resolved/);
  });
});

describe("Supreme Court year PDF (2027)", () => {
  const text = read("sci-calendar-2027.md");
  const t = parseHolidayTable(text, { forum: "sci", year: 2027, fetchedYear: 2026 });

  it("reads the holiday table and ignores the month grid", () => {
    expect(t.unparsed).toBe(0);
    expect(t.records).toHaveLength(20);
    expect(find(t.records, /^Holi Holidays & Good Friday$/)).toMatchObject({ dateFrom: "2027-03-22", dateTo: "2027-03-27", kind: "vacation" });
    expect(find(t.records, /^Christmas & New Year$/)).toMatchObject({ dateFrom: "2027-12-20", dateTo: "2028-01-01", kind: "vacation", year: 2027 });
    expect(calendarCoverage(t.records, { year: 2027, format: "pdf" })).toEqual([2027]);
  });

  it("reads partial court working days from the footnote (start to the day before full sittings resume)", () => {
    const n = parseCalendarNotes(text, { forum: "sci", year: 2027 });
    expect(n.records).toEqual([
      expect.objectContaining({ kind: "partial_working", dateFrom: "2027-05-31", dateTo: "2027-07-11", registryOpen: true, year: 2027 }),
    ]);
  });

  it("rejects a row whose printed weekday does not match the year", () => {
    const wrong = parseHolidayTable("| Republic Day | January 26 | Monday |", { forum: "sci", year: 2027, fetchedYear: 2026 });
    expect(wrong.records).toEqual([]);
    expect(wrong.unparsed).toBe(1);
  });
});

describe("Delhi High Court calendar 2026 (scanned PDF, OCR text)", () => {
  const text = read("dhc-calendar-2026.md");
  const t = parseHolidayTable(text, { forum: "hc-delhi", fetchedYear: 2026 });
  const n = parseCalendarNotes(text, { forum: "hc-delhi", year: 2026, ocr: true });

  it("reads the holiday table (year from the weekdays) and folds the wrapped name", () => {
    expect(t.year).toBe(2026);
    expect(t.records).toHaveLength(24);
    expect(find(t.records, /Milad-un-Nabi/)).toMatchObject({ name: "Milad-un-Nabi or Id-e-Milad (Birthday of Prophet Mohammad)", dateFrom: "2026-08-26" });
    expect(find(t.records, /Maha Shivratri/)).toMatchObject({ dateFrom: "2026-02-15" });
  });

  it("reads the High Court's vacations (not the subordinate courts'), second Saturdays and local holidays", () => {
    const vac = n.records.filter((r) => r.kind === "vacation").map((r) => [r.name, r.dateFrom, r.dateTo]);
    expect(vac).toEqual([["Summer Vacation", "2026-06-01", "2026-06-30"], ["Winter Vacation", "2026-12-26", "2026-12-31"]]);
    const second = n.records.filter((r) => r.name === "Second Saturday").map((r) => r.dateFrom);
    expect(second).toHaveLength(12);
    expect(second.slice(0, 3)).toEqual(["2026-01-10", "2026-02-14", "2026-03-14"]);
    const local = n.records.filter((r) => r.name === "Local Holiday").map((r) => r.dateFrom).sort();
    expect(local).toEqual(["2026-01-02", "2026-03-05", "2026-03-06", "2026-10-21", "2026-10-22", "2026-10-23", "2026-11-07", "2026-11-10", "2026-11-12", "2026-11-13"]);
    expect(n.records.find((r) => r.name === "Local Holiday")?.note).toMatch(/OCR/);
  });

  it("normalises OCR math artefacts before reading notes", () => {
    expect(normalizeOcrMath("$ 2 2^{\\mathrm{nd}} $ & $ 2 3^{\\mathrm{rd}} $ Oct")).toBe("22nd & 23rd Oct");
    expect(normalizeOcrMath("$ 7^{n d}, $ $ 1 0^{n d} $")).toBe("7nd, 10nd");
    expect(normalizeOcrMath("$ \\ast $Saturdays")).toBe("*Saturdays");
    expect(normalizeOcrMath("1 <sup>st</sup> June")).toBe("1st June");
  });
});

describe("Supreme Court holiday data through the ingestion pipeline (core extraction renders JSON as a fenced block)", () => {
  const bytes = new Uint8Array(readFileSync(path.join(FIX, "sci-calendar-ajax.json")));
  const meta = { forum: "sci", docKind: "calendar", format: "json", year: 2026 };
  const input = (markdown: string, pages: { page: number; text: string }[]): ParseInput => ({
    id: "od_sci_json", url: sciHolidayJsonUrl(2026), title: "Supreme Court of India — Holiday data 2026", docDate: "2026-01-01", meta, markdown, pages, fetchedAt: "2026-10-02T04:00:00.000Z",
  });

  /** What indexDocument hands the parser: scrubbed pages and their page markdown. */
  const asParsed = (ex: ExtractedDocument) => {
    const scrubbed = scrubPages(ex.pages, "calendar");
    return input(pageMarkdown(scrubbed.pages, ex.paged), scrubbed.pages);
  };
  const expect28 = (doc: ParseInput) => {
    const r = calendarParse(doc, { forum: "sci" });
    expect(r.notes).toEqual([]);
    expect(r.unparsed).toBe(0);
    expect(r.records).toHaveLength(28);
    expect(r.records.find((h) => h.name === "Republic Day 2026")).toMatchObject({ dateFrom: "2026-01-26", kind: "holiday", year: 2026 });
    expect(truthfulCoverage(r.records, { year: 2026, format: "json" }, r)).toEqual({ covers: [2026], partialYears: [] });
  };

  it("Firecrawl fallback (firecrawl_in source): the browser's <pre> rendering of the JSON becomes a ``` fence", () => {
    // Chromium renders a JSON response as <pre>…</pre>; Firecrawl returns that as rawHtml, which the pipeline extracts
    // with extractHtml (pipeline.ts firecrawlFallback).
    const raw = read("sci-calendar-ajax.json");
    const rawHtml = `<html><head><meta name="color-scheme" content="light dark"></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">${raw.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></body></html>`;
    const ex = extractHtml(rawHtml, sciHolidayJsonUrl(2026));
    expect(ex.pages[0].text.startsWith("```\n{")).toBe(true); // what the parser actually receives
    expect28(asParsed(ex));
  });

  it("a JSON response the core extractor detects as JSON becomes a ```json fence", async () => {
    const ex = await extractDocument({ bytes, mime: "application/json", url: "https://www.sci.gov.in/holidays-2026.json" });
    expect(ex.kind).toBe("json");
    expect(ex.pages[0].text.startsWith("```json\n{")).toBe(true);
    expect28(asParsed(ex));
  });

  it("direct fetch of the admin-ajax.php URL (extracted as HTML: the JSON text itself) still parses", async () => {
    const ex = await extractDocument({ bytes, mime: "application/json", url: sciHolidayJsonUrl(2026) });
    expect(ex.kind).toBe("html");
    expect28(asParsed(ex));
  });

  it("parses it when the text is rebuilt from stored chunks (parse-stage path: chunks joined with blank lines)", async () => {
    const ex = await extractDocument({ bytes, mime: "application/json", url: "https://www.sci.gov.in/holidays-2026.json" });
    const markdown = pageMarkdown(scrubPages(ex.pages, "calendar").pages, ex.paged);
    const chunks = chunkMarkdown(markdown, { target: 600, max: 900 });
    expect(chunks.length).toBeGreaterThan(1);
    const rebuilt = chunks.map((c) => c.text).join("\n\n");
    const r = calendarParse(input(rebuilt, [{ page: 1, text: rebuilt }]), { forum: "sci" });
    expect(r.records).toHaveLength(28);
    expect(r.unparsed).toBe(0);
  });

  it("reads raw JSON too, and never takes page text for JSON", () => {
    expect(calendarJsonText(read("sci-calendar-ajax.json"))).not.toBeNull();
    expect(calendarJsonText("```json\n{\"a\": 1}\n```")).toBe('{"a": 1}');
    expect(calendarJsonText("[Page 1]\nRepublic Day January 26 Monday")).toBeNull();
    expect(calendarJsonText("```\nnot json\n```")).toBeNull();
  });
});

describe("calendar coverage is truthful when rows are rejected", () => {
  // 2026 table: eight closures, two of them printed with the wrong weekday (an OCR / transcription error).
  const rows = [
    "| Republic Day | January 26 | Monday |",
    "| Holi | March 4 | Wednesday |",
    "| Good Friday | April 3 | Friday |",
    "| Independence Day | August 15 | Saturday |",
    "| Gandhi Jayanti | October 2 | Friday |",
    "| Diwali | November 8 | Sunday |",
    "| Christmas | December 25 | Thursday |",
    "| Guru Nanak's Birthday | November 24 | Wednesday |",
  ].join("\n");
  const doc = (text: string, meta: Record<string, unknown>): ParseInput => ({ id: "cal", url: "https://example.gov.in/calendar.pdf", title: "Calendar", docDate: "2026-01-01", meta, markdown: text, pages: [{ page: 1, text }], fetchedAt: "2026-10-02T04:00:00.000Z" });

  it("a year with rejected rows is partial, never covered (the court would read as open on a notified holiday)", () => {
    const r = calendarParse(doc(rows, { forum: "sci", format: "pdf", year: 2026 }), { forum: "sci" });
    expect(r.records).toHaveLength(6);
    expect(r.unparsed).toBe(2);
    expect(r.rejectedYears).toEqual([2026]);
    expect(calendarCoverage(r.records, { year: 2026, format: "pdf" })).toEqual([2026]); // six closures read: not enough
    expect(truthfulCoverage(r.records, { year: 2026, format: "pdf" }, r)).toEqual({ covers: [], partialYears: [2026] });
    // Without the mismatched rows the same table covers its year.
    const clean = rows.split("\n").filter((l) => !/Christmas|Guru/.test(l)).join("\n");
    const ok = calendarParse(doc(clean, { forum: "sci", format: "pdf", year: 2026 }), { forum: "sci" });
    expect(truthfulCoverage(ok.records, { year: 2026, format: "pdf" }, ok)).toEqual({ covers: [2026], partialYears: [] });
  });

  it("a rejected Supreme Court JSON entry blocks only the year it belongs to", () => {
    const data = JSON.parse(read("sci-calendar-ajax.json")) as { data: { holidays: Record<string, unknown>[] } };
    const bad2027 = { start_date: "26/01/2027", end_date: "26/01/2027", start_year: "2027", title: "Republic Day 2027", type: "gazetted", days_of_the_week: { start: "Monday", end: "" } }; // a Tuesday
    const r = calendarParse(doc(JSON.stringify({ data: { holidays: [...data.data.holidays, bad2027] } }), { forum: "sci", format: "json", year: 2026 }), { forum: "sci" });
    expect(r.unparsed).toBe(1);
    expect(r.rejectedYears).toEqual([2027]);
    expect(truthfulCoverage(r.records, { year: 2026, format: "json" }, r).covers).toEqual([2026]);
    const unknown = { start_date: "03/08/2026", end_date: "03/08/2026", start_year: "2026", title: "Restricted holiday", type: "restricted" };
    const r2 = calendarParse(doc(JSON.stringify({ data: { holidays: [...data.data.holidays, unknown] } }), { forum: "sci", format: "json", year: 2026 }), { forum: "sci" });
    expect(r2.notes.join(" ")).toMatch(/unknown holiday type "restricted"/);
    expect(truthfulCoverage(r2.records, { year: 2026, format: "json" }, r2)).toEqual({ covers: [], partialYears: [2026] });
  });

  it("the published calendars read without rejections keep covering their years", () => {
    const cases: [string, Record<string, unknown>, number | null, number][] = [
      [read("dhc-calendar-2026.md"), { forum: "hc-delhi", format: "pdf", year: 2026 }, 2026, 2026],
      [read("sci-calendar-2027.md"), { forum: "sci", format: "pdf", year: 2027 }, 2027, 2027],
      [htmlParagraphs(read("sci-calendar-page.html")), { forum: "sci", format: "html_table" }, null, 2026],
    ];
    for (const [text, meta, year, covered] of cases) {
      const r = calendarParse(doc(text, meta));
      expect(r.unparsed).toBe(0);
      expect(truthfulCoverage(r.records, { year, format: String(meta.format) }, r)).toEqual({ covers: [covered], partialYears: [] });
    }
  });

  it("a rejection whose year is unknown (or no attribution at all) makes every year of the document partial", () => {
    const recs = parseSciHolidayJson(read("sci-calendar-ajax.json")).records;
    expect(truthfulCoverage(recs, { year: 2026, format: "json" }, { unparsed: 1, rejectedYears: [], rejectedUndated: 1 }).covers).toEqual([]);
    expect(truthfulCoverage(recs, { year: 2026, format: "json" }, { unparsed: 1 }).covers).toEqual([]);
  });

  it("an unvalidated calendar footnote (closures missing) makes the table's year partial", () => {
    const table = rows.split("\n").filter((l) => !/Christmas|Guru/.test(l)).join("\n");
    const note = "The High Court will remain closed for Summer Vacation from Monday, 1st June to Monday, 30th June (both days inclusive).";
    const r = calendarParse(doc(`${table}\n\n${note}`, { forum: "hc-delhi", format: "pdf", year: 2026 }), { forum: "hc-delhi", format: "pdf" });
    expect(r.notes.join(" ")).toMatch(/vacation note could not be validated/);
    expect(truthfulCoverage(r.records, { year: 2026, format: "pdf" }, r)).toEqual({ covers: [], partialYears: [2026] });
  });
});

describe("dedupeHolidays", () => {
  it("collapses identical closures from several official views", () => {
    const a: HolidayRecord = { forum: "sci", dateFrom: "2026-10-02", dateTo: "2026-10-02", name: "Mahatma Gandhi's Birthday", kind: "holiday", registryOpen: null, year: 2026, note: null };
    expect(dedupeHolidays([a, { ...a, name: "Mahatma Gandhi’s  Birthday" }, { ...a, kind: "vacation" }])).toHaveLength(2);
  });
});
