import { describe, expect, it } from "vitest";
import { CASE_TYPES, caseTypeById, CIVIL_SUIT_STAGES, CRIMINAL_TRIAL_STAGES, EXAMINATION_STAGES, formatExhibit, formatWitness, nextNumber, parseCaseNumber, parseExhibit, parseWitness, resolveCaseType } from "@/lib/india/procedure";
import { addCourtDays, addDays, addMonths, addYears, daysBetween, isCourtOpen, isValidIsoDate, nextOpenDay, parseIsoDate, SAMPLE_CALENDAR, weekday, type CourtCalendar } from "@/lib/india/holidays";
import { computeAdValoremFee, type CourtFeeTable } from "@/lib/india/court-fees";
import { courtById } from "@/lib/india/courts";

describe("case-type registry", () => {
  it.each([
    ["W.P.", "wp"], ["WP", "wp"], ["Writ Petition", "wp"], ["W. P.", "wp"], ["W.A.", "wa"], ["Crl.P.", "crl-p"], ["CRL.P", "crl-p"],
    ["Criminal Petition", "crl-p"], ["Crl.A.", "crl-a"], ["Crl.R.P.", "crl-rp"], ["R.S.A.", "rsa"], ["RFA", "rfa"], ["M.F.A.", "mfa"],
    ["C.R.P.", "crp"], ["W.P.(PIL)", "wp-pil"], ["S.L.P.(C)", "slp-c"], ["SLP (Civil)", "slp-c"], ["S.L.P.(Crl.)", "slp-crl"],
    ["SLP(Criminal)", "slp-crl"], ["C.A.", "sc-ca"], ["T.P.(C)", "tp-c"], ["O.S.", "os"], ["O.A.", "oa"], ["A.S.", "as"], ["S.A.", "sa"],
  ])("%s → %s", (label, id) => {
    expect(resolveCaseType(label)?.id).toBe(id);
  });
  it("unknown labels are not guessed", () => {
    for (const l of ["XYZ", "W.X.", "", "Petition"]) expect(resolveCaseType(l)).toBeNull();
  });
  it("every entry is well-formed and ids are unique", () => {
    expect(new Set(CASE_TYPES.map((t) => t.id)).size).toBe(CASE_TYPES.length);
    for (const t of CASE_TYPES) {
      expect(t.abbr && t.name).toBeTruthy();
      for (const c of t.usedIn) if (c.startsWith("hc-") || c === "sci") expect(courtById(c), `${t.id}: ${c}`).not.toBeNull();
    }
    expect(caseTypeById("rsa")?.basis).toEqual(["CPC s.100"]);
  });
});

describe("parseCaseNumber", () => {
  it.each([
    ["W.P. No. 12345 of 2023", "W.P. No. 12345 of 2023"],
    ["W.P.No.12345/2023(GM-RES)", "W.P. No. 12345 of 2023 (GM-RES)"],
    ["WP 12345 / 2023 ( LB - RES )", "W.P. No. 12345 of 2023 (LB-RES)"],
    ["Crl.P. 1234/2024", "Crl.P. No. 1234 of 2024"],
    ["RSA No. 100004 of 2024", "R.S.A. No. 100004 of 2024"],
    ["O.S. No. 45 of 2019", "O.S. No. 45 of 2019"],
    ["S.L.P. (C) No. 1234 of 2023", "S.L.P. (C) No. 1234 of 2023"],
    ["Crl.A. Nos. 12 of 2021", "Crl.A. No. 12 of 2021"],
    ["Writ Petition No. 7 of 2022", "W.P. No. 7 of 2022"],
  ])("%s → %s", (raw, canonical) => {
    expect(parseCaseNumber(raw)?.canonical).toBe(canonical);
  });
  it.each(["as 12 of 2019", "W.P. No. 0 of 2020", "W.P. No. 12 of 20", "XYZ No. 1 of 2020", "W.P. No. 12", "12345 of 2023", "W.P. No. 12 of 2023 extra"])("%j → null", (raw) => {
    expect(parseCaseNumber(raw)).toBeNull();
  });
});

describe("exhibits and witnesses", () => {
  it.each([
    ["Ex.P1", "Ex.P1", "P"], ["Ex. P-1", "Ex.P1", "P"], ["Exh.D12(a)", "Ex.D12(a)", "D"], ["Exhibit C3", "Ex.C3", "C"],
    ["ex.x2", "Ex.X2", "X"], ["MO-3", "MO-3", "MO"], ["M.O.3", "MO-3", "MO"], ["Ex.P1(1)", "Ex.P1(1)", "P"],
  ])("%s → %s", (raw, canonical, series) => {
    const e = parseExhibit(raw)!;
    expect(e.canonical).toBe(canonical);
    expect(e.series).toBe(series);
  });
  it.each(["Ex.Z1", "Ex.P0", "P1", "Ex.P", "Exhibit", "Ex.P1(abcd)"])("%j is not an exhibit", (raw) => {
    expect(parseExhibit(raw)).toBeNull();
  });
  it.each([["PW-1", "PW-1"], ["P.W.1", "PW-1"], ["DW 2", "DW-2"], ["cw-10", "CW-10"], ["P.W. 12", "PW-12"]])("%s → %s", (raw, canonical) => {
    expect(parseWitness(raw)?.canonical).toBe(canonical);
  });
  it.each(["XW-1", "PW-0", "PW", "W-1", "PW-1a"])("%j is not a witness", (raw) => {
    expect(parseWitness(raw)).toBeNull();
  });
  it("formatting and numbering", () => {
    expect(formatExhibit("P", 3)).toBe("Ex.P3");
    expect(formatExhibit("MO", 2, "a")).toBe("MO-2(a)");
    expect(formatWitness("DW", 4)).toBe("DW-4");
    expect(nextNumber([{ number: 1 }, { number: 7 }, { number: 3 }])).toBe(8);
    expect(nextNumber([])).toBe(1);
  });
  it("stages", () => {
    expect(EXAMINATION_STAGES.map((s) => s.id)).toEqual(["chief", "cross", "re_examination"]);
    expect(CIVIL_SUIT_STAGES[0].id).toBe("institution");
    expect(CRIMINAL_TRIAL_STAGES.find((s) => s.id === "accused_statement")?.basis).toBe("CrPC s.313 / BNSS s.351");
  });
});

describe("dates", () => {
  it("strict ISO parsing", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2023-02-29")).toBe(false);
    expect(isValidIsoDate("2024-2-1")).toBe(false);
    expect(parseIsoDate(null)).toBeNull();
  });
  it("arithmetic", () => {
    expect(addDays("2024-01-01", 90)).toBe("2024-03-31");
    expect(addDays("2023-01-01", 90)).toBe("2023-04-01");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2023-01-31", 1)).toBe("2023-02-28");
    expect(addMonths("2024-11-15", 3)).toBe("2025-02-15");
    expect(addYears("2020-02-29", 3)).toBe("2023-02-28");
    expect(daysBetween("2024-01-05", "2024-01-25")).toBe(20);
    expect(weekday("2024-03-31")).toBe(0);
    expect(() => addDays("bad", 1)).toThrow(RangeError);
  });
});

describe("court calendar", () => {
  it("sample calendar: Sundays and fixed national holidays only, marked sample", () => {
    expect(SAMPLE_CALENDAR.sample).toBe(true);
    expect(isCourtOpen("2024-01-26", SAMPLE_CALENDAR)).toEqual({ open: false, reason: "holiday: Republic Day" });
    expect(isCourtOpen("2024-01-28", SAMPLE_CALENDAR).open).toBe(false);
    expect(isCourtOpen("2024-01-29", SAMPLE_CALENDAR).open).toBe(true);
    expect(isCourtOpen("2030-01-02", SAMPLE_CALENDAR).open).toBe("unknown");
    expect(isCourtOpen("nope", SAMPLE_CALENDAR).open).toBe("unknown");
  });
  const cal: CourtCalendar = {
    id: "test", courtId: "hc-karnataka", years: [2025], weeklyOff: [0, 6], sample: true, source: "test fixture",
    holidays: [{ date: "2025-05-01", name: "Test holiday" }],
    vacations: [{ from: "2025-05-05", to: "2025-05-09", name: "Test vacation", registryOpen: true }],
  };
  it("vacations, weekly offs and next open day", () => {
    expect(isCourtOpen("2025-05-06", cal)).toEqual({ open: false, reason: "vacation: Test vacation (registry open for filing per notification)" });
    const n = nextOpenDay("2025-05-01", cal);
    expect(n.date).toBe("2025-05-02");
    expect(nextOpenDay("2025-05-03", cal).date).toBe("2025-05-12");
    expect(nextOpenDay("2025-05-03", cal).skipped.length).toBe(9);
    expect(nextOpenDay("2026-01-05", cal)).toMatchObject({ date: null });
    expect(nextOpenDay("2025-12-31", cal).date).toBe("2025-12-31");
  });
  it("addCourtDays counts only open days and stops when the calendar ends", () => {
    expect(addCourtDays("2025-04-30", 2, cal)).toBe("2025-05-12");
    expect(addCourtDays("2025-12-30", 5, cal)).toBeNull();
  });
});

describe("court fees", () => {
  const table: CourtFeeTable = { id: "fixture", act: "Test", article: "Test", slabs: [{ upTo: 1000, fixed: 25 }, { upTo: 10000, rate: 0.05 }, { upTo: null, rate: 0.02 }], minimum: 10, verified: false, source: "test fixture, not the Karnataka schedule" };
  it("without a table: requires verification, no amount", () => {
    const r = computeAdValoremFee(50000, null);
    expect(r.status).toBe("requires_verification");
    expect(r.fee).toBeUndefined();
    expect(r.notes[0]).toMatch(/not coded from memory/);
  });
  it("computes cumulative slabs, but an unverified table stays requires_verification", () => {
    const r = computeAdValoremFee(20000, table);
    expect(r.fee).toBe(25 + 450 + 200);
    expect(r.status).toBe("requires_verification");
    expect(computeAdValoremFee(500, table).fee).toBe(25);
    expect(computeAdValoremFee(20000, { ...table, verified: true }).status).toBe("computed");
    expect(computeAdValoremFee(20000, { ...table, maximum: 100, verified: true }).fee).toBe(100);
  });
  it("rejects bad amounts", () => {
    expect(computeAdValoremFee(-1, table).status).toBe("invalid_input");
    expect(computeAdValoremFee(Number.NaN, table).status).toBe("invalid_input");
  });
});
