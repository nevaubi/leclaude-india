import { describe, expect, it } from "vitest";
import { arbitrationSetAsideTimeline, chequeDishonourTimeline, computeLimitation, LIMITATION_RULES, limitationRule } from "@/lib/india/limitation";
import { SAMPLE_CALENDAR, type CourtCalendar } from "@/lib/india/holidays";

describe("limitation rules table", () => {
  it("every rule cites its authority and has a unique id", () => {
    expect(new Set(LIMITATION_RULES.map((r) => r.id)).size).toBe(LIMITATION_RULES.length);
    for (const r of LIMITATION_RULES) expect(r.authority).toMatch(/Act|Constitution|Rules/);
  });
  it.each([
    ["art-116a", 90, "days"], ["art-116b", 30, "days"], ["art-117", 30, "days"], ["art-131", 90, "days"], ["art-124", 30, "days"],
    ["art-123", 30, "days"], ["art-113", 3, "years"], ["art-55", 3, "years"], ["art-54", 3, "years"], ["art-65", 12, "years"],
    ["art-64", 12, "years"], ["art-136", 12, "years"], ["art-137", 3, "years"], ["sc-slp", 90, "days"], ["arb-34", 3, "months"], ["cpa-69", 2, "years"],
  ])("%s = %i %s", (id, n, unit) => {
    expect(limitationRule(id)?.period).toEqual({ n, unit });
  });
  it("suits are not condonable under s.5; appeals are", () => {
    expect(limitationRule("art-113")?.condonable).toBe(false);
    expect(limitationRule("art-116a")?.condonable).toBe(true);
    expect(limitationRule("art-136")?.condonable).toBe(false);
  });
});

describe("computeLimitation", () => {
  it("days: first day excluded (s.12(1))", () => {
    const r = computeLimitation({ ruleId: "art-116a", from: "2023-01-01" });
    expect(r.lastDay).toBe("2023-04-01");
    expect(r.status).toBe("computed");
    expect(r.s4).toBe("not_checked");
    expect(r.condonable).toBe(true);
    expect(r.steps.map((s) => s.authority)).toEqual(expect.arrayContaining(["Limitation Act, 1963, Schedule, Art. 116(a)", "Limitation Act, 1963, s.12(1)", "Limitation Act, 1963, s.4", "Limitation Act, 1963, s.5"]));
    expect(computeLimitation({ ruleId: "art-116b", from: "2023-01-10" }).lastDay).toBe("2023-02-09");
  });
  it("years and months land on the corresponding date (clamped)", () => {
    expect(computeLimitation({ ruleId: "art-113", from: "2021-03-15" }).lastDay).toBe("2024-03-15");
    expect(computeLimitation({ ruleId: "art-55", from: "2020-02-29" }).lastDay).toBe("2023-02-28");
    expect(computeLimitation({ ruleId: "art-65", from: "2010-06-01" }).lastDay).toBe("2022-06-01");
  });
  it("s.4: court closed on the last day moves to the reopening day; sample calendars are flagged", () => {
    const r = computeLimitation({ ruleId: "art-116a", from: "2024-01-01", calendar: SAMPLE_CALENDAR });
    expect(r.lastDay).toBe("2024-03-31"); // Sunday
    expect(r.adjustedLastDay).toBe("2024-04-01");
    expect(r.s4).toBe("applied");
    expect(r.status).toBe("requires_verification");
    expect(r.uncertain.join()).toMatch(/sample data/);
    const open = computeLimitation({ ruleId: "art-116b", from: "2023-01-10", calendar: { ...SAMPLE_CALENDAR, sample: false } });
    expect(open.s4).toBe("not_needed");
    expect(open.adjustedLastDay).toBe("2023-02-09");
    expect(open.status).toBe("computed");
  });
  it("s.4 with a calendar that does not cover the year is reported, not assumed", () => {
    const cal: CourtCalendar = { ...SAMPLE_CALENDAR, years: [2020], sample: false };
    const r = computeLimitation({ ruleId: "art-116b", from: "2023-01-10", calendar: cal });
    expect(r.s4).toBe("calendar_unknown");
    expect(r.adjustedLastDay).toBeUndefined();
  });
  it("s.12(2): certified-copy time excluded only when applied within the period", () => {
    const r = computeLimitation({ ruleId: "art-116a", from: "2024-01-01", certifiedCopy: { appliedOn: "2024-01-05", readyOn: "2024-01-25" } });
    expect(r.excludedDays).toBe(20);
    expect(r.lastDay).toBe("2024-04-20");
    expect(r.status).toBe("requires_verification");
    const late = computeLimitation({ ruleId: "art-116b", from: "2023-01-10", certifiedCopy: { appliedOn: "2023-02-15", readyOn: "2023-02-20" } });
    expect(late.excludedDays).toBe(0);
    expect(late.lastDay).toBe("2023-02-09");
    const suit = computeLimitation({ ruleId: "art-113", from: "2021-03-15", certifiedCopy: { appliedOn: "2021-03-16", readyOn: "2021-04-16" } });
    expect(suit.lastDay).toBe("2024-03-15");
    expect(suit.notes.join()).toMatch(/only for appeals/);
    expect(computeLimitation({ ruleId: "art-116a", from: "2024-01-01", certifiedCopy: { appliedOn: "2024-01-10", readyOn: "2024-01-05" } }).status).toBe("invalid_input");
  });
  it("writ: no fixed period; SLP and Art. 115: requires verification", () => {
    const w = computeLimitation({ ruleId: "writ-226", from: "2024-01-01" });
    expect(w.status).toBe("no_fixed_period");
    expect(w.lastDay).toBeUndefined();
    expect(w.notes.join()).toMatch(/laches/);
    expect(computeLimitation({ ruleId: "sc-slp", from: "2024-01-01" })).toMatchObject({ status: "requires_verification", lastDay: "2024-03-31" });
    expect(computeLimitation({ ruleId: "art-115-hc", from: "2024-01-01" }).status).toBe("requires_verification");
  });
  it("invalid input", () => {
    expect(computeLimitation({ ruleId: "art-999", from: "2024-01-01" }).status).toBe("invalid_input");
    expect(computeLimitation({ ruleId: "art-113", from: "2024-02-30" }).status).toBe("invalid_input");
  });
});

describe("s.138 NI Act timeline", () => {
  it("notice, payment window and complaint deadline", () => {
    const r = chequeDishonourTimeline({ dishonourInformationOn: "2024-05-10", noticeReceivedOn: "2024-06-01" });
    expect(r.noticeDeadline).toBe("2024-06-09");
    expect(r.paymentWindowEnds).toBe("2024-06-16");
    expect(r.earliestComplaint).toBe("2024-06-17");
    expect(r.complaintLastDay).toBe("2024-07-16");
    expect(r.status).toBe("requires_verification");
    expect(r.steps.map((s) => s.authority).join()).toMatch(/s\.142\(1\)\(b\)/);
  });
  it("month-end clamping and s.4 with a calendar", () => {
    const r = chequeDishonourTimeline({ noticeReceivedOn: "2024-01-16", calendar: SAMPLE_CALENDAR });
    expect(r.paymentWindowEnds).toBe("2024-01-31");
    expect(r.complaintLastDay).toBe("2024-02-29");
    expect(r.adjustedComplaintLastDay).toBe("2024-02-29");
    const sun = chequeDishonourTimeline({ noticeReceivedOn: "2024-02-15", calendar: SAMPLE_CALENDAR });
    expect(sun.complaintLastDay).toBe("2024-04-01");
    const endFeb = chequeDishonourTimeline({ noticeReceivedOn: "2024-02-14" });
    expect(endFeb.paymentWindowEnds).toBe("2024-02-29");
    expect(endFeb.complaintLastDay).toBe("2024-03-29"); // corresponding date, not end of month
    const onSunday = chequeDishonourTimeline({ noticeReceivedOn: "2024-02-21", calendar: SAMPLE_CALENDAR });
    expect(onSunday.complaintLastDay).toBe("2024-04-07"); // Sunday
    expect(onSunday.adjustedComplaintLastDay).toBe("2024-04-08");
  });
  it("invalid input", () => {
    expect(chequeDishonourTimeline({}).status).toBe("invalid_input");
    expect(chequeDishonourTimeline({ noticeReceivedOn: "2024-13-01" }).status).toBe("invalid_input");
  });
});

describe("arbitration s.34(3)", () => {
  it("three months plus a non-extendable 30 days", () => {
    const r = arbitrationSetAsideTimeline("2024-01-31");
    expect(r.lastDay).toBe("2024-04-30");
    expect(r.outerLimit).toBe("2024-05-30");
    expect(r.condonable).toBe("special");
    expect(r.notes.join()).toMatch(/but not thereafter/);
  });
});
