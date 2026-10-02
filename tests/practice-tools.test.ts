import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFeeTable, chequeToText, formatIsoDate, limitationToText, mappingRows, mappingRowsToTsv, parseRupees, parseSectionLine, parseSectionList, parseSlabTable, arbitrationToText, applicableToText, feeToText, DECISION_SUPPORT_FOOTER } from "@/modules/tools/lib";
import { mapSection, applicableCode } from "@/lib/india/criminal-code-map";
import { arbitrationSetAsideTimeline, chequeDishonourTimeline, computeLimitation, limitationRule } from "@/lib/india/limitation";
import { computeAdValoremFee } from "@/lib/india/court-fees";
import { SAMPLE_CALENDAR, type CourtCalendar } from "@/lib/india/holidays";
import {
  CALENDAR_CAVEAT, calendarHasOcr, calendarOcrNotes, calendarSourceNotes, calendarYears, CAUSE_LIST_LIMIT, causeListCapped, causeListEntryText, causeListForumLabel, causeListQuery, causeListSearchText, causeListToText,
  choiceForum, condonationDelay, countCourtDays, courtDaysToText, delayNote, delayToText, describeCalendarChoice, addWorkingDays, addWorkingDaysToText, fetchedDate, istDate, nextCourtDay, nextCourtDayToText,
  officialChoice, resolveCalendar, weeklyOffNote, withCalendarCaveats, COURT_CALENDAR_FORUMS, type OfficialCalendarResponse,
} from "@/modules/tools/lib";
import type { CauseListEntry } from "@/modules/official/types";
import { TOOL_IDS, toolFromParam } from "@/modules/tools/ids";
import { fetchCourtCalendar } from "@/modules/tools/components/use-court-calendars";

const q = (s: string) => parseSectionLine(s).queries.map((x) => `${x.code} ${x.section}`);

describe("section input parsing", () => {
  it.each([
    ["IPC 420", ["IPC 420"]],
    ["302 IPC", ["IPC 302"]],
    ["CrPC 438", ["CrPC 438"]],
    ["Cr.P.C. 438", ["CrPC 438"]],
    ["Cr. P.C. s. 156(3)", ["CrPC 156(3)"]],
    ["BNS 318", ["BNS 318"]],
    ["BNS 318(4)", ["BNS 318(4)"]],
    ["BNS s. 318", ["BNS 318"]],
    ["BNSS 482", ["BNSS 482"]],
    ["B.N.S.S. 482", ["BNSS 482"]],
    ["BSA 63", ["BSA 63"]],
    ["u/s 498-A IPC", ["IPC 498A"]],
    ["S.498a I.P.C.", ["IPC 498A"]],
    ["ss. 420, 406 r/w 120B IPC", ["IPC 420", "IPC 406", "IPC 120B"]],
    ["IPC 420/406/34", ["IPC 420", "IPC 406", "IPC 34"]],
    ["Section 302 of the Indian Penal Code, 1860", ["IPC 302"]],
    ["Evidence Act 65B", ["IEA 65B"]],
    ["IEA 27", ["IEA 27"]],
    ["IPC420", ["IPC 420"]],
    ["IPC 420 and 420", ["IPC 420"]],
  ])("%s", (input, expected) => {
    const r = parseSectionLine(input);
    expect(r.errors).toEqual([]);
    expect(q(input)).toEqual(expected);
  });

  it("never guesses a code for a bare number, and refuses two codes on one line", () => {
    expect(parseSectionLine("420").errors[0]).toMatch(/Name the code/);
    expect(parseSectionLine("420").queries).toEqual([]);
    expect(parseSectionLine("IPC 420 / BNS 318").errors[0]).toMatch(/One code per line/);
    expect(parseSectionLine("IPC").errors[0]).toMatch(/section number/);
  });

  it("reports unreadable section tokens without dropping readable ones", () => {
    const r = parseSectionLine("IPC 420, abc");
    expect(r.queries.map((x) => x.section)).toEqual(["420"]);
    expect(r.errors[0]).toMatch(/"abc"/);
  });

  it("parses a pasted list, skipping blank lines and keeping line numbers", () => {
    const { lines, truncated } = parseSectionList("IPC 420\n\n302 IPC\nfoo\n");
    expect(truncated).toBe(false);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 3, 4]);
    expect(lines[2].errors.length).toBe(1);
    expect(parseSectionList("IPC 1\nIPC 2\nIPC 3", 2)).toMatchObject({ truncated: true });
  });

  it("maps parsed rows through the library and keeps split, unmapped and medium confidence visible in the TSV", () => {
    const { lines } = parseSectionList("IPC 498A\nIPC 999\nBNS 318\nIPC 107\nnonsense");
    const rows = mappingRows(lines, (x) => mapSection(x.code, x.section));
    expect(rows.map((r) => r.result?.status ?? "error")).toEqual(["split", "unmapped", "split", "mapped", "error"]);
    const tsv = mappingRowsToTsv(rows);
    const body = tsv.split("\n");
    expect(body[0].split("\t")).toHaveLength(7);
    expect(body[1]).toContain("BNS 85 (punishment); BNS 86 (definition of cruelty)");
    expect(body[2]).toContain("none in the coded table");
    expect(body[4]).toContain("medium");
    expect(body[5]).toContain("unreadable");
    expect(tsv).toContain("Source: MHA/BPRD correspondence table");
    expect(tsv).toContain(DECISION_SUPPORT_FOOTER);
  });
});

describe("slab table parsing", () => {
  it("reads rows with Indian digit grouping, percent rates, a header and an open last slab", () => {
    const r = parseSlabTable("upTo | rate | fixed\n# comment\n1,00,000 | 5% | \n5,00,000 | 4 | 500\nabove | 3 |");
    expect(r.errors).toEqual([]);
    expect(r.slabs).toEqual([{ upTo: 100000, rate: 0.05 }, { upTo: 500000, rate: 0.04, fixed: 500 }, { upTo: null, rate: 0.03 }]);
  });

  it("reads whitespace-separated rows and tab-separated rows", () => {
    expect(parseSlabTable("1000 10\n- 5").slabs).toEqual([{ upTo: 1000, rate: 0.1 }, { upTo: null, rate: 0.05 }]);
    expect(parseSlabTable("1000\t\t25").slabs).toEqual([{ upTo: 1000, fixed: 25 }]);
  });

  it("reads JSON (fractional rates) with min/max", () => {
    const r = parseSlabTable('{"slabs":[{"upTo":1000,"rate":0.1},{"upTo":null,"rate":0.05}],"minimum":10,"maximum":5000}');
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ minimum: 10, maximum: 5000 });
    expect(parseSlabTable('[{"upTo":null,"fixed":100}]').slabs).toEqual([{ upTo: null, fixed: 100 }]);
  });

  it("rejects malformed input instead of defaulting", () => {
    expect(parseSlabTable("").errors[0]).toMatch(/Paste or enter/);
    expect(parseSlabTable("{bad").errors[0]).toMatch(/JSON/);
    expect(parseSlabTable('{"slabs":[{"upTo":"x","rate":0.1}]}').errors[0]).toMatch(/must be numbers/);
    expect(parseSlabTable("1000 | 5\n500 | 4").errors.join(" ")).toMatch(/must increase/);
    expect(parseSlabTable("above | 5\n1000 | 4").errors.join(" ")).toMatch(/only the last slab/);
    expect(parseSlabTable("1000 | five").errors[0]).toMatch(/rate "five"/);
    expect(parseSlabTable("1000 | 150").errors.join(" ")).toMatch(/between 0% and 100%/);
    expect(parseSlabTable("1000").errors.join(" ")).toMatch(/rate or a fixed fee/);
    expect(parseSlabTable('[{"upTo":10,"rate":5}]').errors.join(" ")).toMatch(/between 0% and 100%/);
  });

  it("parses rupee amounts strictly", () => {
    expect(parseRupees("₹1,00,000")).toBe(100000);
    expect(parseRupees("Rs. 2,500/-")).toBe(2500);
    expect(parseRupees("12.5")).toBe(12.5);
    expect(parseRupees("-5")).toBeNull();
    expect(parseRupees("1e5")).toBeNull();
  });

  it("honours 'verified' only with a source, and the library then marks the result accordingly", () => {
    const parsed = parseSlabTable("1000 | 10\nabove | 5");
    const meta = { label: "My HC", act: "Some Act", article: "Sch. I", source: "", verified: true };
    expect(buildFeeTable(parsed, meta).errors[0]).toMatch(/Name the source/);
    const unverified = buildFeeTable(parsed, { ...meta, verified: false }).table!;
    expect(unverified.verified).toBe(false);
    expect(computeAdValoremFee(3000, unverified)).toMatchObject({ status: "requires_verification", fee: 200 });
    const verified = buildFeeTable(parsed, { ...meta, source: "Gazette notification no. X" }).table!;
    expect(verified.verified).toBe(true);
    const res = computeAdValoremFee(3000, verified);
    expect(res.status).toBe("computed");
    const text = feeToText(3000, verified, res);
    expect(text).toContain("Fee: ₹200");
    expect(text).toContain("Source: Gazette notification no. X");
    expect(buildFeeTable(parsed, { ...meta, verified: false, minimum: 10, maximum: 5 }).errors[0]).toMatch(/Minimum/);
  });
});

describe("copy text", () => {
  it("formats ISO dates without time-zone drift", () => {
    expect(formatIsoDate("2026-03-12")).toBe("Thu, 12 Mar 2026");
    expect(formatIsoDate("2024-02-29")).toBe("Thu, 29 Feb 2024");
    expect(formatIsoDate("bad")).toBe("bad");
  });

  it("limitation text carries the authority of every step, the s.4 state and the footer", () => {
    const rule = limitationRule("art-116a")!;
    const r = computeLimitation({ ruleId: rule.id, from: "2026-01-10" });
    const text = limitationToText(rule, r, "None");
    expect(text).toContain("Authority: Limitation Act, 1963, Schedule, Art. 116(a)");
    expect(text).toContain("[Limitation Act, 1963, s.12(1)]");
    expect(text).toContain("NOT checked");
    expect(text).toContain("2026-04-10");
    expect(text).toContain(DECISION_SUPPORT_FOOTER);
    for (const s of r.steps) if (s.authority) expect(text).toContain(`[${s.authority}]`);
  });

  it("cheque, arbitration and applicable-code text keep their authorities", () => {
    const c = chequeToText(chequeDishonourTimeline({ dishonourInformationOn: "2026-01-05", noticeReceivedOn: "2026-01-20" }), "None");
    expect(c).toContain("s.138 proviso (b)");
    expect(c).toContain("s.142(1)(b)");
    expect(c).toContain("Requires verification:");
    const a = arbitrationToText(arbitrationSetAsideTimeline("2026-01-31"), "None");
    expect(a).toContain("2026-04-30");
    expect(a).toContain("s.34(3) proviso");
    const ap = applicableToText("2024-06-30", "2024-07-15", applicableCode("2024-06-30", { proceedingInitiated: "2024-07-15" }));
    expect(ap).toContain("Substantive law: IPC");
    expect(ap).toContain("Procedure: BNSS");
    expect(ap).toContain(DECISION_SUPPORT_FOOTER);
  });
});

/* ───────────────── official court calendars, court days, condonation, cause lists ───────────────── */


const DHC: CourtCalendar = {
  id: "official:hc-delhi:2026", courtId: "hc-delhi", years: [2026], weeklyOff: [0],
  holidays: [{ date: "2026-10-02", name: "Gandhi Jayanti" }], vacations: [{ from: "2026-12-24", to: "2026-12-31", name: "Winter vacation" }],
  sample: false, source: "High Court of Delhi: official calendar data for 2026.",
};
const DHC_RESPONSE: OfficialCalendarResponse = { calendar: DHC, sources: [{ documentId: "od_1", url: "https://delhihighcourt.nic.in/files/calendar-2026.pdf", fetchedAt: "2026-09-03T10:15:00Z", years: [2026] }], forum: "hc-delhi", notes: [] };

describe("practice tools: new tools are registered", () => {
  it("lists the new tools and resolves them from ?tool=", () => {
    expect(TOOL_IDS).toEqual(["limitation", "cheque", "arbitration", "condonation", "court-days", "causelist", "codes", "fees"]);
    expect(toolFromParam("court-days")).toBe("court-days");
    expect(toolFromParam("causelist")).toBe("causelist");
    expect(toolFromParam("nope")).toBe("limitation");
  });
});

describe("court calendar choice", () => {
  it("parses official choices and resolves only loaded calendars (never a substitute)", () => {
    expect(COURT_CALENDAR_FORUMS.map((f) => f.forum)).toEqual(["sci", "hc-delhi", "hc-karnataka", "nclt", "nclat"]);
    expect(choiceForum(officialChoice("hc-delhi"))).toBe("hc-delhi");
    expect(choiceForum("sample")).toBeNull();
    expect(choiceForum("official:../x")).toBeNull();
    expect(resolveCalendar("sample", {})).toBe(SAMPLE_CALENDAR);
    expect(resolveCalendar("none", { "hc-delhi": DHC_RESPONSE })).toBeUndefined();
    expect(resolveCalendar("official:hc-delhi", { "hc-delhi": DHC_RESPONSE })).toBe(DHC);
    expect(resolveCalendar("official:sci", { "hc-delhi": DHC_RESPONSE })).toBeUndefined();
    expect(resolveCalendar("official:sci", { sci: { calendar: null, sources: [], forum: null, notes: ["no official calendar loaded for sci 2026"] } })).toBeUndefined();
    expect(calendarYears("2026-10-02")).toEqual([2025, 2026, 2027]);
  });

  it("describes the calendar with its source, fetched date (India time), weekly offs, notes and the ad-hoc caveat", () => {
    const d = describeCalendarChoice("official:hc-delhi", { "hc-delhi": DHC_RESPONSE });
    expect(d).toContain("High Court of Delhi official calendar for 2026");
    expect(d).toContain("https://delhihighcourt.nic.in/files/calendar-2026.pdf (fetched 3 Sep 2026 IST)");
    expect(d).toContain(CALENDAR_CAVEAT);
    // The weekly-off assumption is stated, from the calendar's data.
    expect(d).toContain("Weekly off in this calendar: Sunday. Saturdays are not marked closed");
    // The server's notes (here: the Supreme Court's Saturday practice) are carried, without repeating its source line.
    const sciNote = "Weekly off: Sunday. The Supreme Court's list notifies Saturday holidays individually (e.g. Independence Day 2026, a Saturday), so Saturdays are not treated as closed; benches ordinarily sit Monday to Friday and the Registry's Saturday hours vary by notification.";
    const sci: OfficialCalendarResponse = {
      calendar: { ...DHC, id: "official:sci:2026", courtId: "sci", source: `Supreme Court of India: official calendar data for 2026 from https://www.sci.gov.in/calendar-2026.pdf (fetched 2026-09-03). ${sciNote} Ad-hoc holidays may be missing.` },
      sources: [{ documentId: "od_2", url: "https://www.sci.gov.in/calendar-2026.pdf", fetchedAt: "2026-09-03T20:00:00Z", years: [2026] }], forum: "sci", notes: [],
    };
    const ds = describeCalendarChoice("official:sci", { sci });
    expect(ds).toContain(`Calendar notes: ${sciNote} Ad-hoc holidays may be missing.`);
    expect(ds).not.toContain("(fetched 2026-09-03)");
    expect(ds).toContain("(fetched 4 Sep 2026 IST)");
    expect(calendarSourceNotes(sci.calendar!)).toBe(`${sciNote} Ad-hoc holidays may be missing.`);
    expect(calendarSourceNotes({ source: "Some other wording entirely.", sample: false })).toBe("Some other wording entirely.");
    expect(calendarSourceNotes({ source: "High Court of Delhi: official calendar data for 2026.", sample: false })).toBeNull();
    expect(calendarSourceNotes(SAMPLE_CALENDAR)).toBeNull();
    expect(weeklyOffNote({ weeklyOff: [0, 6] })).toBe("Weekly off in this calendar: Sunday and Saturday.");
    expect(describeCalendarChoice("official:sci", {})).toMatch(/official calendar not loaded \(court holidays not checked\)/);
    expect(describeCalendarChoice("none", {})).toBe("None selected");
    expect(describeCalendarChoice("sample", {})).toMatch(/illustrative/);
  });

  it("dates fetches in India time, not by the UTC date", () => {
    expect(istDate("2026-09-03T20:00:00Z")).toBe("2026-09-04");
    expect(istDate("2026-09-03T10:15:00Z")).toBe("2026-09-03");
    expect(istDate("2026-09-03")).toBe("2026-09-03");
    expect(istDate("not a date")).toBeNull();
    expect(istDate(null)).toBeNull();
    expect(fetchedDate("2026-09-03T18:31:00Z")).toBe("4 Sep 2026");
    expect(fetchedDate("2026-09-03T18:29:00Z")).toBe("3 Sep 2026");
  });

  it("flags calendar dates read by OCR, from the API's flag or notes, without assuming the field exists", () => {
    expect(calendarOcrNotes(DHC_RESPONSE)).toEqual([]);
    expect(calendarHasOcr(undefined)).toBe(false);
    const ocr: OfficialCalendarResponse = { ...DHC_RESPONSE, sources: [{ ...DHC_RESPONSE.sources[0], ocr: true, note: "scanned list: OCR model x" }] };
    const notes = calendarOcrNotes(ocr);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^Dates from delhihighcourt\.nic\.in\/files\/calendar-2026\.pdf were read by OCR .* check them against the PDF\. \(scanned list: OCR model x\)$/);
    expect(calendarOcrNotes({ ...DHC_RESPONSE, sources: [{ ...DHC_RESPONSE.sources[0], notes: ["Text from OCR"] }] })).toHaveLength(1);
    expect(calendarOcrNotes({ ...DHC_RESPONSE, notes: ["2027 holidays came from OCR of a scanned notice"] })).toEqual(["2027 holidays came from OCR of a scanned notice"]);
    expect(describeCalendarChoice("official:hc-delhi", { "hc-delhi": ocr })).toContain(notes[0]);
    // A source whose link is not http(s) is never printed or named by its raw text.
    const bad: OfficialCalendarResponse = { ...DHC_RESPONSE, sources: [{ ...DHC_RESPONSE.sources[0], url: "javascript:alert(1)", ocr: true }] };
    expect(describeCalendarChoice("official:hc-delhi", { "hc-delhi": bad })).not.toContain("javascript:");
    expect(calendarOcrNotes(bad)[0]).toMatch(/^Dates from a calendar source were read by OCR/);
    // A computation that uses an OCR-read calendar requires verification.
    const r = withCalendarCaveats({ status: "computed" as const, uncertain: [] as string[] }, notes);
    expect(r).toEqual({ status: "requires_verification", uncertain: notes });
    expect(withCalendarCaveats({ status: "invalid_input" as const, uncertain: [] as string[] }, notes).status).toBe("invalid_input");
    expect(withCalendarCaveats({ status: "computed" as const, uncertain: [] as string[] }, []).status).toBe("computed");
    expect(nextCourtDay("2026-10-05", DHC, { caveats: notes })).toMatchObject({ status: "requires_verification", date: "2026-10-05", uncertain: notes });
  });

  it("classifies the calendar API's answers without inventing a calendar", async () => {
    const reply = (status: number, body: unknown) => vi.fn(async () => new Response(body === undefined ? "<html>404</html>" : JSON.stringify(body), { status, headers: { "content-type": body === undefined ? "text/html" : "application/json" } }));
    vi.stubGlobal("fetch", reply(200, DHC_RESPONSE));
    expect(await fetchCourtCalendar("hc-delhi", [2026])).toEqual({ kind: "ok", data: DHC_RESPONSE });
    vi.stubGlobal("fetch", reply(200, { calendar: null, sources: [], forum: null, notes: ["none"] }));
    expect(await fetchCourtCalendar("sci", [2026])).toMatchObject({ kind: "ok", data: { calendar: null } });
    vi.stubGlobal("fetch", reply(503, { error: "not configured", code: "official_not_configured" }));
    expect((await fetchCourtCalendar("sci", [2026])).kind).toBe("not_configured");
    vi.stubGlobal("fetch", reply(404, undefined));
    expect((await fetchCourtCalendar("sci", [2026])).kind).toBe("not_available");
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect((await fetchCourtCalendar("sci", [2026])).kind).toBe("denied");
    vi.stubGlobal("fetch", reply(500, { error: "Could not read the court calendar", code: "calendar_failed" }));
    expect(await fetchCourtCalendar("sci", [2026])).toEqual({ kind: "error", message: "Could not read the court calendar" });
    const f = reply(200, DHC_RESPONSE);
    vi.stubGlobal("fetch", f);
    await fetchCourtCalendar("hc-delhi", [2025, 2026, 2027]);
    expect(f.mock.calls[0]).toBeDefined();
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("/api/official/calendars?forum=hc-delhi&years=2025,2026,2027");
  });
  afterEach(() => { vi.unstubAllGlobals(); });
});

describe("court days", () => {
  it("counts court working days with both ends included and lists the closures", () => {
    // Mon 5 – Fri 9 Oct 2026: no Saturday in the range, so nothing rests on Saturday practice.
    const r = countCourtDays("2026-10-05", "2026-10-09", DHC);
    expect(r).toMatchObject({ status: "computed", open: 5, days: 5, unknown: null, uncertain: [] });
    const r2 = countCourtDays("2026-10-01", "2026-10-05", DHC);
    expect(r2.closed).toEqual([{ date: "2026-10-02", reason: "holiday: Gandhi Jayanti" }, { date: "2026-10-04", reason: "weekly off (Sunday)" }]);
    const text = courtDaysToText({ from: "2026-10-01", to: "2026-10-05" }, r2, "Delhi HC");
    expect(text).toContain("Court working days: 3 of 5 calendar days");
    expect(text).toContain("Days closed under the calendar:");
    expect(text).toContain("2026-10-02");
    // The result never claims the court "sits": it counts working days under the notified calendar.
    expect(text).not.toMatch(/\bsits\b|sitting day|does not sit:/);
  });

  it("requires verification when the count rests on a Saturday the calendar does not mark closed", () => {
    // Deliberately changed: Sat 3 Oct 2026 was counted as a sitting day with status "computed". The calendar's weekly off
    // is Sunday only, which says nothing about whether the court sits that Saturday.
    const r = countCourtDays("2026-10-01", "2026-10-05", DHC);
    expect(r).toMatchObject({ status: "requires_verification", open: 3, days: 5 });
    expect(r.uncertain).toEqual(["1 Saturday is counted as a court working day because the calendar does not mark it closed. If the court does not sit on that Saturday, the count is 2."]);
    expect(courtDaysToText({ from: "2026-10-01", to: "2026-10-05" }, r, "Delhi HC")).toContain("Requires verification:\n- 1 Saturday is counted");
    // With Saturdays as a notified weekly off, the same range is computed.
    expect(countCourtDays("2026-10-01", "2026-10-05", { ...DHC, weeklyOff: [0, 6] })).toMatchObject({ status: "computed", open: 2, uncertain: [] });
  });

  it("stops (no number) where the calendar cannot answer, and rejects bad ranges", () => {
    const r = countCourtDays("2026-12-30", "2027-01-02", DHC);
    expect(r.status).toBe("requires_verification");
    expect(r.open).toBeNull();
    expect(r.unknown?.date).toBe("2027-01-01");
    expect(r.uncertain[0]).toMatch(/cannot answer for 2027-01-01/);
    expect(countCourtDays("2026-10-05", "2026-10-01", DHC).status).toBe("invalid_input");
    expect(countCourtDays("2026-10", "2026-10-05", DHC).status).toBe("invalid_input");
    expect(countCourtDays("2026-10-01", "2026-10-03", SAMPLE_CALENDAR).status).toBe("requires_verification");
  });

  it("finds the next court working day and adds court working days", () => {
    expect(nextCourtDay("2026-10-04", DHC)).toMatchObject({ status: "computed", date: "2026-10-05", skipped: [{ date: "2026-10-04" }], uncertain: [] });
    expect(nextCourtDay("2026-12-26", DHC)).toMatchObject({ date: null, status: "requires_verification" });
    expect(addWorkingDays("2026-10-05", 2, DHC)).toMatchObject({ status: "computed", date: "2026-10-07", uncertain: [] });
    expect(addWorkingDays("2026-12-20", 10, DHC)).toMatchObject({ status: "requires_verification", date: null });
    expect(addWorkingDays("2026-10-01", 0, DHC).status).toBe("invalid_input");
  });

  it("marks a Saturday answer as requiring verification and gives the answer with Saturdays closed", () => {
    // Deliberately changed: Sat 3 Oct 2026 was returned as the next "sitting day" with status "computed".
    const next = nextCourtDay("2026-10-02", DHC);
    expect(next).toMatchObject({ status: "requires_verification", date: "2026-10-03", skipped: [{ date: "2026-10-02" }] });
    expect(next.uncertain).toEqual(["Sat, 3 Oct 2026 is a Saturday that the calendar does not mark closed. If the court does not sit that day, the next court working day is Mon, 5 Oct 2026 (2026-10-05)."]);
    const nextText = nextCourtDayToText("2026-10-02", next, "Delhi HC");
    expect(nextText).toContain("Next court working day: Sat, 3 Oct 2026 (2026-10-03)");
    expect(nextText).toContain("Status: Requires verification");
    expect(nextText).toContain("Mon, 5 Oct 2026 (2026-10-05)");
    expect(nextText).not.toMatch(/\bsits\b|sitting day/);
    // Deliberately changed: Thu 1 Oct + 2 counted Sat 3 Oct.
    const added = addWorkingDays("2026-10-01", 2, DHC);
    expect(added).toMatchObject({ status: "requires_verification", date: "2026-10-05" });
    expect(added.uncertain[0]).toMatch(/If the court does not sit on them, the result is Tue, 6 Oct 2026 \(2026-10-06\)\.$/);
    expect(addWorkingDaysToText("2026-10-01", 2, added, "Delhi HC")).toContain("Requires verification:");
    // A notified Saturday weekly off removes the doubt.
    expect(nextCourtDay("2026-10-02", { ...DHC, weeklyOff: [0, 6] })).toMatchObject({ status: "computed", date: "2026-10-05" });
    expect(addWorkingDays("2026-10-01", 2, { ...DHC, weeklyOff: [0, 6] })).toMatchObject({ status: "computed", date: "2026-10-06" });
  });
});

describe("condonation of delay", () => {
  it("counts days after the last day and never predicts the outcome", () => {
    const late = condonationDelay("2026-10-01", "2026-10-11");
    expect(late).toEqual({ status: "delayed", days: 10, notes: [] });
    expect(delayNote(late)).toMatch(/10 days late/);
    expect(delayNote(late)).toMatch(/does not assess it or predict the outcome/);
    expect(delayNote(late, false)).toMatch(/s\.5 of the Limitation Act does not extend time/);
    expect(delayNote(late, "special")).toMatch(/only as the special law provides/);
    expect(condonationDelay("2026-10-01", "2026-10-01")).toMatchObject({ status: "within_time", days: 0 });
    expect(condonationDelay("2026-10-05", "2026-10-01")).toMatchObject({ status: "within_time", days: 0, notes: ["Filed 4 day(s) before the last day of limitation."] });
    expect(condonationDelay("2026-10", "2026-10-01").status).toBe("invalid_input");
    const text = delayToText({ lastDay: "2026-10-01", filedOn: "2026-10-11", proceeding: "Appeal under the CPC to a High Court", authority: "Art. 116(a)" }, late, true);
    expect(text).toContain("Delay: 10 day(s)");
    expect(text).toContain("Condonation: Delay condonable on sufficient cause");
    expect(text).not.toMatch(/likely|will be condoned|chance/i);
  });
});

describe("cause list search query", () => {
  const base = { forum: "sci", date: "2026-10-05", caseNumber: "", diary: "", advocate: "" };
  it("builds exact-match queries", () => {
    expect(causeListQuery(base)).toEqual({ qs: "forum=sci&date=2026-10-05&limit=200", error: null });
    expect(CAUSE_LIST_LIMIT).toBe(200);
    expect(causeListQuery({ ...base, date: "", caseNumber: "SLP(C) No. 1234/2026" }).qs).toBe("forum=sci&case=SLP%28C%29+No.+1234%2F2026&limit=200");
    expect(causeListQuery({ ...base, diary: "54583/2026" }).qs).toContain("diary=54583%2F2026");
    expect(causeListQuery({ ...base, advocate: "  AJAY   MARWAH " }).qs).toContain("advocate=AJAY+MARWAH");
  });

  it("sends the diary number normalized, and refuses a case number typed as a diary number", () => {
    expect(new URLSearchParams(causeListQuery({ ...base, diary: "Diary No. 054583-2026" }).qs!).get("diary")).toBe("54583/2026");
    expect(new URLSearchParams(causeListQuery({ ...base, diary: "SLP(C) No. 1234/2026 (Diary No. 54583/2026)" }).qs!).get("diary")).toBe("54583/2026");
    expect(causeListQuery({ ...base, diary: "W.P.(C) 12/2026" })).toMatchObject({ qs: null, error: expect.stringMatching(/not a diary number/) });
    expect(causeListQuery({ ...base, diary: "Diary No. 1/2026, Diary No. 2/2026" }).qs).toBeNull();
  });

  it("keeps NCLT searches bench-exact: the bench-qualified key is sent, an unqualified number is refused", () => {
    const nclt = { ...base, forum: "nclt" };
    expect(new URLSearchParams(causeListQuery({ ...nclt, caseNumber: "CP(IB)/29(MB)2022" }).qs!).get("case")).toBe("CPIB/29/2022@MB");
    expect(new URLSearchParams(causeListQuery({ ...nclt, caseNumber: "IA/259(MP)2026" }).qs!).get("case")).toBe("IA/259/2026@MP");
    expect(causeListQuery({ ...nclt, caseNumber: "CP(IB) No. 29/2022" })).toMatchObject({ qs: null, error: expect.stringMatching(/repeat at every bench/) });
    expect(causeListQuery({ ...base, caseNumber: "CP(IB)/29(MB)2022" })).toMatchObject({ qs: null, error: expect.stringMatching(/NCLT number .*choose NCLT/) });
    // A date-only NCLT search is allowed: every entry is labelled with its bench.
    expect(causeListQuery(nclt).qs).toBe("forum=nclt&date=2026-10-05&limit=200");
  });
  it("refuses what it cannot match exactly", () => {
    expect(causeListQuery({ ...base, forum: "hc-mars" }).error).toMatch(/Choose a court/);
    expect(causeListQuery({ ...base, caseNumber: "anything goes" }).error).toMatch(/not one recognisable case number/);
    expect(causeListQuery({ ...base, forum: "hc-delhi", diary: "54583/2026" }).error).toMatch(/Supreme Court only/);
    expect(causeListQuery({ ...base, diary: "abc" }).error).toMatch(/not a diary number/);
    expect(causeListQuery({ ...base, advocate: "AB" }).error).toMatch(/at least 3 letters/);
    expect(causeListQuery({ ...base, date: "" }).error).toMatch(/Give a list date, or a case or diary number/);
    expect(causeListQuery({ ...base, date: "2026-13-01" }).error).toMatch(/list date in full/);
  });
});

describe("cause list results", () => {
  const entry = (o: Partial<CauseListEntry>): CauseListEntry => ({
    id: "cle_1", documentId: "od_list", forum: "nclt-mumbai", listDate: "2026-10-05", listType: "daily", courtNo: "II", bench: "Hon'ble Member (J)", itemNo: "14",
    caseNumbers: [{ printed: "CP(IB)/29(MB)2022", normalized: "CPIB/29/2022" }], diaryNo: null, parties: "A Ltd. v. B Ltd.", advocates: ["X Y"], raw: "14 CP(IB)/29(MB)2022 A Ltd. v. B Ltd.",
    page: 3, publishedAt: null, fetchedAt: "2026-10-04T20:00:00Z", parsed: true, ...o,
  } as CauseListEntry);

  it("labels each entry with its court or bench", () => {
    expect(causeListForumLabel("nclt-mumbai")).toBe("NCLT Mumbai Bench");
    expect(causeListForumLabel("nclt-new-delhi")).toBe("NCLT New Delhi Bench");
    expect(causeListForumLabel("nclt-principal")).toBe("NCLT Principal Bench, New Delhi");
    expect(causeListForumLabel("nclt")).toBe("NCLT (bench not printed)");
    expect(causeListForumLabel("nclat-chennai")).toBe("NCLAT Chennai Bench");
    expect(causeListForumLabel("sci")).toBe("Supreme Court of India");
    expect(causeListForumLabel("hc-bombay")).toBe("High Court of Bombay");
    expect(causeListForumLabel("")).toBe("Forum not recorded");
    const t = causeListEntryText(entry({}));
    expect(t.split("\n")[0]).toBe("NCLT Mumbai Bench · Mon, 5 Oct 2026 · Daily list · Court II · Item 14 · p. 3");
    expect(t).toContain("fetched 5 Oct 2026, 01:30 IST");
  });

  it("copies an unparsed entry as printed, never as an empty entry", () => {
    const t = causeListEntryText(entry({ parsed: false, caseNumbers: [], parties: null, advocates: [], raw: "14   CP(IB)/29(MB)2022\nA Ltd. v. B Ltd." }));
    expect(t).toContain("As printed (not split into fields): 14 CP(IB)/29(MB)2022 A Ltd. v. B Ltd.");
    expect(t).not.toContain("Case number not printed");
  });

  it("describes the submitted search (not the form being edited) and says when the list was cut short", () => {
    const qs = causeListQuery({ forum: "nclt", date: "2026-10-05", caseNumber: "CP(IB)/29(MB)2022", diary: "", advocate: "" }).qs!;
    expect(causeListSearchText(qs)).toBe("NCLT (all benches), list date Mon, 5 Oct 2026, case number CPIB/29/2022@MB");
    expect(causeListCapped(199, qs)).toBe(false);
    expect(causeListCapped(200, qs)).toBe(true);
    const many = Array.from({ length: 200 }, (_, k) => entry({ id: `e${k}` }));
    const text = causeListToText(qs, many);
    expect(text.split("\n")[0]).toBe("Cause list entries — NCLT (all benches), list date Mon, 5 Oct 2026, case number CPIB/29/2022@MB");
    expect(text).toContain("200 entries (only the first 200 returned; narrow the search to see the rest)");
    expect(causeListToText(qs, [entry({})])).toContain("1 entry\n");
  });
});
