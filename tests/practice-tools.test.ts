import { describe, expect, it } from "vitest";
import { buildFeeTable, chequeToText, formatIsoDate, limitationToText, mappingRows, mappingRowsToTsv, parseRupees, parseSectionLine, parseSectionList, parseSlabTable, arbitrationToText, applicableToText, feeToText, DECISION_SUPPORT_FOOTER } from "@/modules/tools/lib";
import { mapSection, applicableCode } from "@/lib/india/criminal-code-map";
import { arbitrationSetAsideTimeline, chequeDishonourTimeline, computeLimitation, limitationRule } from "@/lib/india/limitation";
import { computeAdValoremFee } from "@/lib/india/court-fees";

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
