import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFeeTable, chequeToText, formatIsoDate, limitationToText, mappingRows, mappingRowsToTsv, parseRupees, parseSectionLine, parseSectionList, parseSlabTable, arbitrationToText, applicableToText, feeToText, DECISION_SUPPORT_FOOTER } from "@/modules/tools/lib";
import { mapSection, applicableCode } from "@/lib/india/criminal-code-map";
import { arbitrationSetAsideTimeline, chequeDishonourTimeline, computeLimitation, limitationRule } from "@/lib/india/limitation";
import { computeAdValoremFee } from "@/lib/india/court-fees";
import { SAMPLE_CALENDAR, type CourtCalendar } from "@/lib/india/holidays";
import {
  CALENDAR_CAVEAT, calendarYears, causeListQuery, choiceForum, condonationDelay, countCourtDays, courtDaysToText, delayNote, delayToText, describeCalendarChoice, addWorkingDays, nextCourtDay,
  officialChoice, resolveCalendar, COURT_CALENDAR_FORUMS, type OfficialCalendarResponse,
} from "@/modules/tools/lib";
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

  it("describes the calendar with its source, fetched date and the ad-hoc caveat", () => {
    const d = describeCalendarChoice("official:hc-delhi", { "hc-delhi": DHC_RESPONSE });
    expect(d).toContain("High Court of Delhi official calendar for 2026");
    expect(d).toContain("https://delhihighcourt.nic.in/files/calendar-2026.pdf (fetched 3 Sep 2026)");
    expect(d).toContain(CALENDAR_CAVEAT);
    expect(describeCalendarChoice("official:sci", {})).toMatch(/official calendar not loaded \(court holidays not checked\)/);
    expect(describeCalendarChoice("none", {})).toBe("None selected");
    expect(describeCalendarChoice("sample", {})).toMatch(/illustrative/);
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
  it("counts sitting days with both ends included and lists the closures", () => {
    const r = countCourtDays("2026-10-01", "2026-10-05", DHC);
    expect(r).toMatchObject({ status: "computed", open: 3, days: 5, unknown: null });
    expect(r.closed).toEqual([{ date: "2026-10-02", reason: "holiday: Gandhi Jayanti" }, { date: "2026-10-04", reason: "weekly off (Sunday)" }]);
    const text = courtDaysToText({ from: "2026-10-01", to: "2026-10-05" }, r, "Delhi HC");
    expect(text).toContain("Working days: 3 of 5 calendar days");
    expect(text).toContain("2026-10-02");
  });

  it("stops (no number) where the calendar cannot answer, and rejects bad ranges", () => {
    const r = countCourtDays("2026-12-30", "2027-01-02", DHC);
    expect(r.status).toBe("requires_verification");
    expect(r.open).toBeNull();
    expect(r.unknown?.date).toBe("2027-01-01");
    expect(countCourtDays("2026-10-05", "2026-10-01", DHC).status).toBe("invalid_input");
    expect(countCourtDays("2026-10", "2026-10-05", DHC).status).toBe("invalid_input");
    expect(countCourtDays("2026-10-01", "2026-10-03", SAMPLE_CALENDAR).status).toBe("requires_verification");
  });

  it("finds the next sitting day and adds working days", () => {
    expect(nextCourtDay("2026-10-02", DHC)).toMatchObject({ status: "computed", date: "2026-10-03", skipped: [{ date: "2026-10-02" }] });
    expect(nextCourtDay("2026-12-26", DHC)).toMatchObject({ date: null, status: "requires_verification" });
    expect(addWorkingDays("2026-10-01", 2, DHC)).toMatchObject({ status: "computed", date: "2026-10-05" });
    expect(addWorkingDays("2026-12-20", 10, DHC)).toMatchObject({ status: "requires_verification", date: null });
    expect(addWorkingDays("2026-10-01", 0, DHC).status).toBe("invalid_input");
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
    expect(causeListQuery({ ...base, date: "", caseNumber: "SLP(C) No. 1234/2026" }).qs).toBe("forum=sci&case=SLP%28C%29+No.+1234%2F2026&limit=200");
    expect(causeListQuery({ ...base, diary: "54583/2026" }).qs).toContain("diary=54583%2F2026");
    expect(causeListQuery({ ...base, advocate: "  AJAY   MARWAH " }).qs).toContain("advocate=AJAY+MARWAH");
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
