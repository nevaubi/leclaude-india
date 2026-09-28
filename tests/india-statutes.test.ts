import { describe, expect, it } from "vitest";
import { ACTS, extractStatutes, formatStatuteRef, getAct, intToRoman, normalizeSection, parseStatuteRef, resolveAct, romanToInt, statuteKeys } from "@/lib/india/statutes";
import { applicableCode, applicableEvidenceCode, CORRESPONDENCE, mapSection, normalizeCodeSection } from "@/lib/india/criminal-code-map";

describe("parseStatuteRef", () => {
  const cases: [string, string, string, string[], Record<string, unknown>?][] = [
    ["s. 302 IPC", "ipc", "section", ["302"]],
    ["S.302 I.P.C.", "ipc", "section", ["302"]],
    ["Section 483 of BNSS", "bnss", "section", ["483"]],
    ["Section 483 of the Bharatiya Nagarik Suraksha Sanhita, 2023", "bnss", "section", ["483"], { year: 2023 }],
    ["Art. 226 of the Constitution", "constitution", "article", ["226"]],
    ["Article 19(1)(g) of the Constitution of India", "constitution", "article", ["19(1)(g)"]],
    ["Articles 14 and 21 of the Constitution", "constitution", "article", ["14", "21"]],
    ["Order XXXIX Rules 1 and 2 CPC", "cpc", "order_rule", [], { order: 39, rules: ["1", "2"] }],
    ["O. 7 R. 11(d) CPC", "cpc", "order_rule", [], { order: 7, rules: ["11(d)"] }],
    ["Order VII Rule 11 of the Code of Civil Procedure, 1908", "cpc", "order_rule", [], { order: 7, rules: ["11"] }],
    ["S.138 NI Act", "ni", "section", ["138"]],
    ["Section 138 of the N.I. Act", "ni", "section", ["138"]],
    ["Section 138 of the Negotiable Instruments Act, 1881", "ni", "section", ["138"], { year: 1881 }],
    ["Section 34 of the Arbitration and Conciliation Act, 1996", "arbitration", "section", ["34"]],
    ["Section 11 of the A&C Act", "arbitration", "section", ["11"]],
    ["u/s 302/34 IPC", "ipc", "section", ["302", "34"]],
    ["Sections 420, 468, 471 read with 34 IPC", "ipc", "section", ["420", "468", "471", "34"]],
    ["Section 302 read with Section 34 of the Indian Penal Code", "ipc", "section", ["302", "34"]],
    ["Sections 302 r/w 34 IPC", "ipc", "section", ["302", "34"]],
    ["Section 498-A IPC", "ipc", "section", ["498A"]],
    ["Section 498A IPC", "ipc", "section", ["498A"]],
    ["s. 3(5) BNS", "bns", "section", ["3(5)"]],
    ["Section 318(4) of BNS", "bns", "section", ["318(4)"]],
    ["Section 482 Cr.P.C.", "crpc", "section", ["482"]],
    ["sec. 439 CrPC", "crpc", "section", ["439"]],
    ["Section 65B of the Evidence Act", "iea", "section", ["65B"]],
    ["Section 63 of the Bharatiya Sakshya Adhiniyam", "bsa", "section", ["63"]],
    ["Section 13(1)(d) of the Hindu Marriage Act", "hma", "section", ["13(1)(d)"]],
    ["Section 20 of the Specific Relief Act", "specific-relief", "section", ["20"]],
    ["Section 5 of the Limitation Act", "limitation", "section", ["5"]],
    ["Section 53A of the Transfer of Property Act", "tpa", "section", ["53A"]],
    ["Section 73 of the Indian Contract Act", "contract", "section", ["73"]],
    ["Section 6 of the Hindu Succession Act", "hsa", "section", ["6"]],
    ["Section 166 of the MV Act", "mv", "section", ["166"]],
    ["Section 6 of the POCSO Act", "pocso", "section", ["6"]],
    ["Section 37 of the NDPS Act", "ndps", "section", ["37"]],
    ["Section 7 of the IBC", "ibc", "section", ["7"]],
    ["Section 18 of the RERA Act", "rera", "section", ["18"]],
    ["Section 66A of the Information Technology Act", "it-2000", "section", ["66A"]],
    ["Section 136 of the Karnataka Land Revenue Act", "ka-land-revenue", "section", ["136"]],
    ["Section 27 of the Karnataka Rent Act, 1999", "ka-rent", "section", ["27"]],
    ["Section 10 of the Andhra Pradesh Buildings (Lease, Rent and Eviction) Control Act, 1960", "ap-buildings-control", "section", ["10"]],
    ["Section 3(1)(r) of the SC/ST Act", "sc-st-poa", "section", ["3(1)(r)"]],
    ["Section 2 of the Companies Act, 2013", "companies-2013", "section", ["2"]],
    ["Section 2 of the Companies Act, 1956", "companies-1956", "section", ["2"]],
    ["Section 35 of the Consumer Protection Act, 2019", "cpa-2019", "section", ["35"]],
  ];
  it.each(cases)("%s", (raw, actId, kind, sections, extra) => {
    const r = parseStatuteRef(raw);
    expect(r, raw).not.toBeNull();
    expect(r!.actId).toBe(actId);
    expect(r!.kind).toBe(kind);
    expect(r!.sections).toEqual(sections);
    expect(r!.issues).toEqual([]);
    if (extra) expect(r).toMatchObject(extra);
  });

  it("flags year-less aliases resolved to the coded Act", () => {
    expect(parseStatuteRef("s. 302 IPC")!.yearAssumed).toBe(true);
    expect(parseStatuteRef("Section 302 of the Indian Penal Code, 1860")!.yearAssumed).toBeUndefined();
    expect(parseStatuteRef("Art. 21 of the Constitution")!.yearAssumed).toBeUndefined();
  });

  it("never picks between same-named Acts without a year", () => {
    for (const [raw, cands] of [
      ["Section 2 of the Companies Act", ["companies-2013", "companies-1956"]],
      ["Section 2 of the Consumer Protection Act", ["cpa-2019", "cpa-1986"]],
      ["Section 43 of the IT Act", ["it-2000", "income-tax-1961"]],
    ] as const) {
      const r = parseStatuteRef(raw)!;
      expect(r.actId).toBeUndefined();
      expect(r.actCandidates).toEqual(cands);
      expect(r.issues[0]).toMatch(/ambiguous/);
    }
  });

  it("does not resolve a year that is not coded", () => {
    const r = parseStatuteRef("Section 5 of the Code of Criminal Procedure, 1898")!;
    expect(r.actId).toBeUndefined();
    expect(r.issues[0]).toMatch(/1898/);
    expect(parseStatuteRef("Section 7 of the Arbitration Act, 1940")).toBeNull();
  });

  it("rejects mismatched units and non-CPC orders", () => {
    expect(parseStatuteRef("Section 21 of the Constitution")!.issues.join()).toMatch(/Article/);
    expect(parseStatuteRef("Order 5 Rule 1 of the NI Act")!.actId).toBeUndefined();
  });

  it("returns null for unknown Acts, bare sections and prose", () => {
    for (const raw of ["Section 5 of the Act", "Section 12 of the Foo Act", "section 5", "Art. 5", "302 IPC", "the IPC", "", "Sections of IPC"]) {
      expect(parseStatuteRef(raw), raw).toBeNull();
    }
  });
});

describe("extractStatutes", () => {
  const text = "The accused was charged u/s 302/34 IPC and Section 25 of the Arms Act. Bail was sought under Section 439 Cr.P.C.; " +
    "the writ under Art. 226 of the Constitution and an injunction under Order XXXIX Rules 1 and 2 CPC.";
  const refs = extractStatutes(text);
  it("finds each reference with exact offsets", () => {
    expect(refs.map((r) => [r.actId, r.sections.join("+") || `O${r.order}R${r.rules?.join("+")}`])).toEqual([
      ["ipc", "302+34"], ["arms", "25"], ["crpc", "439"], ["constitution", "226"], ["cpc", "O39R1+2"],
    ]);
    for (const r of refs) expect(text.slice(r.start, r.end)).toBe(r.raw);
  });
  it("normalised keys for Judgment.statutes", () => {
    expect(refs.flatMap(statuteKeys)).toEqual(["IPC 1860 s.302", "IPC 1860 s.34", "Arms Act 1959 s.25", "CrPC 1973 s.439", "Constitution art.226", "CPC 1908 O.39 R.1", "CPC 1908 O.39 R.2"]);
    expect(statuteKeys(parseStatuteRef("Section 2 of the Companies Act")!)).toEqual([]);
  });
  it("does not include a sentence-ending full stop", () => {
    expect(extractStatutes("Offence u/s 420 IPC.")[0].raw).toBe("u/s 420 IPC");
  });
});

describe("formatStatuteRef", () => {
  it("full and short styles", () => {
    expect(formatStatuteRef(parseStatuteRef("u/s 302/34 IPC")!)).toBe("Sections 302 and 34 of the Indian Penal Code, 1860");
    expect(formatStatuteRef(parseStatuteRef("u/s 302/34 IPC")!, "short")).toBe("ss. 302 and 34 IPC");
    expect(formatStatuteRef(parseStatuteRef("Art. 226 of the Constitution")!)).toBe("Article 226 of the Constitution of India");
    expect(formatStatuteRef(parseStatuteRef("Articles 14, 19 and 21 of the Constitution")!, "short")).toBe("Arts. 14, 19 and 21 of the Constitution");
    expect(formatStatuteRef(parseStatuteRef("O. 39 R. 1 & 2 CPC")!)).toBe("Order XXXIX Rules 1 and 2 of the Code of Civil Procedure, 1908");
    expect(formatStatuteRef(parseStatuteRef("S.138 NI Act")!)).toBe("Section 138 of the Negotiable Instruments Act, 1881");
  });
  it("never invents an Act", () => {
    expect(formatStatuteRef({ kind: "section", actId: undefined, sections: ["2"] })).toBeNull();
    expect(formatStatuteRef({ kind: "section", actId: "nope", sections: ["2"] })).toBeNull();
    expect(formatStatuteRef({ kind: "section", actId: "ipc", sections: [] })).toBeNull();
  });
});

describe("helpers and table integrity", () => {
  it("roman numerals round-trip and reject non-canonical forms", () => {
    for (const n of [1, 4, 9, 14, 21, 39, 40, 47, 49, 51]) expect(romanToInt(intToRoman(n))).toBe(n);
    expect(romanToInt("IIII")).toBeNull();
    expect(romanToInt("ABC")).toBeNull();
  });
  it("normalizeSection", () => {
    expect(normalizeSection("498-A")).toBe("498A");
    expect(normalizeSection("3 (5)")).toBe("3(5)");
  });
  it("act ids are unique; every Act has a year and alias", () => {
    expect(new Set(ACTS.map((a) => a.id)).size).toBe(ACTS.length);
    for (const a of ACTS) { expect(a.year).toBeGreaterThan(1800); expect(a.aliases.length).toBeGreaterThan(0); }
    expect(getAct("bns")?.actNumber).toBe("Act 45 of 2023");
    expect(getAct("ipc")?.replacedBy).toBe("bns");
    expect(resolveAct("Nothing Act").issue).toMatch(/not in the coded table/);
  });
});

describe("criminal code correspondence", () => {
  const cases: [string, string, string[], string][] = [
    ["IPC", "302", ["103(1)"], "mapped"], ["IPC", "307", ["109"], "mapped"], ["IPC", "376", ["64"], "mapped"],
    ["IPC", "420", ["318(4)"], "mapped"], ["IPC", "498A", ["85", "86"], "split"], ["IPC", "498-A", ["85", "86"], "split"],
    ["IPC", "34", ["3(5)"], "mapped"], ["IPC", "120B", ["61(2)"], "mapped"], ["IPC", "120-b", ["61(2)"], "mapped"],
    ["IPC", "506", ["351(2)", "351(3)"], "split"], ["IPC", "304B", ["80"], "mapped"],
    ["CrPC", "438", ["482"], "mapped"], ["CrPC", "439", ["483"], "mapped"], ["CrPC", "482", ["528"], "mapped"],
    ["CrPC", "154", ["173"], "mapped"], ["CrPC", "161", ["180"], "mapped"], ["CrPC", "164", ["183"], "mapped"],
    ["CrPC", "313", ["351"], "mapped"], ["CrPC", "125", ["144"], "mapped"], ["CrPC", "156(3)", ["175(3)"], "mapped"],
    ["IEA", "65B", ["63"], "mapped"], ["IEA", "3", ["2"], "mapped"], ["IEA", "25", ["23(1)"], "mapped"],
    ["IEA", "27", ["23(2)"], "mapped"], ["IEA", "32", ["26"], "mapped"], ["IEA", "45", ["39"], "mapped"], ["IEA", "114", ["119"], "mapped"],
  ];
  it.each(cases)("%s %s → %j (%s)", (code, sec, expected, status) => {
    const r = mapSection(code as "IPC", sec);
    expect(r.candidates.map((c) => c.section)).toEqual(expected);
    expect(r.status).toBe(status);
    expect(r.direction).toBe("old_to_new");
    expect(r.source).toMatch(/Gazette/);
  });
  it("IEA 27 is the proviso to BSA 23(2)", () => {
    expect(mapSection("IEA", "27").candidates[0]).toMatchObject({ code: "BSA", section: "23(2)", note: "proviso" });
  });
  it("reverse lookups return every predecessor", () => {
    expect(mapSection("BNS", "318(4)").candidates.map((c) => `${c.code} ${c.section}`)).toEqual(["IPC 420"]);
    const r318 = mapSection("BNS", "318");
    expect(r318.status).toBe("split");
    expect(r318.candidates.map((c) => c.section)).toEqual(["415", "417", "418", "420"]);
    expect(mapSection("BSA", "23(2)").candidates.map((c) => c.section)).toEqual(["26", "27"]);
    expect(mapSection("BNS", "85").candidates.map((c) => c.section)).toEqual(["498A"]);
    expect(mapSection("BNSS", "483").candidates.map((c) => `${c.code} ${c.section}`)).toEqual(["CrPC 439"]);
  });
  it("sub-section fallback is explained, unknown sections are unmapped", () => {
    const r = mapSection("IPC", "302(1)");
    expect(r.candidates.map((c) => c.section)).toEqual(["103(1)"]);
    expect(r.notes.join()).toMatch(/confirm the sub-section/);
    expect(mapSection("IPC", "124A")).toMatchObject({ status: "unmapped", candidates: [] });
    expect(mapSection("BNS", "999")).toMatchObject({ status: "unmapped", candidates: [] });
  });
  it("medium-confidence rows say so", () => {
    expect(mapSection("IPC", "380").confidence).toBe("medium");
    expect(mapSection("IPC", "302").confidence).toBe("high");
  });
  it("table integrity: unique source sections per code, no empty targets", () => {
    for (const code of ["IPC", "CrPC", "IEA"]) {
      const secs = CORRESPONDENCE.filter((r) => r.from.code === code).map((r) => r.from.section);
      expect(new Set(secs).size).toBe(secs.length);
    }
    for (const r of CORRESPONDENCE) expect(r.to.length).toBeGreaterThan(0);
    for (const r of CORRESPONDENCE.filter((x) => x.to.length > 1)) expect(r.note).toBeTruthy();
  });
  it("normalizeCodeSection", () => {
    expect(normalizeCodeSection("S. 302")).toBe("302");
    expect(normalizeCodeSection("u/s 498-a")).toBe("498A");
    expect(normalizeCodeSection("3 (5)")).toBe("3(5)");
  });
});

describe("applicableCode", () => {
  it.each([
    ["2024-06-30", "IPC"], ["2024-07-01", "BNS"], ["1990-01-01", "IPC"], ["2025-01-01", "BNS"],
    ["2024-02-30", "requires_review"], ["30/06/2024", "requires_review"], [null, "requires_review"], [undefined, "requires_review"],
  ])("offence %s → %s", (date, expected) => {
    expect(applicableCode(date as string).substantive).toBe(expected);
  });
  it("offence ranges", () => {
    expect(applicableCode({ from: "2024-01-01", to: "2024-06-30" }).substantive).toBe("IPC");
    expect(applicableCode({ from: "2024-07-01", to: "2024-08-01" }).substantive).toBe("BNS");
    const span = applicableCode({ from: "2024-06-20", to: "2024-07-05" });
    expect(span.substantive).toBe("requires_review");
    expect(span.notes.join()).toMatch(/spans 1 July 2024/);
    expect(applicableCode({ from: "2024-08-01", to: "2024-07-01" }).substantive).toBe("requires_review");
  });
  it("procedure follows the initiation date, with a review note for mixed cases", () => {
    expect(applicableCode("2024-01-01", { proceedingInitiated: "2024-03-01" }).procedure).toBe("CrPC");
    const mixed = applicableCode("2024-01-01", { proceedingInitiated: "2024-09-01" });
    expect(mixed.procedure).toBe("BNSS");
    expect(mixed.notes.join()).toMatch(/s\.531/);
    expect(applicableCode("2024-08-01", { proceedingInitiated: "bad" }).procedure).toBe("requires_review");
    expect(applicableCode("2024-08-01").procedure).toBeUndefined();
  });
  it("evidence code", () => {
    expect(applicableEvidenceCode("2024-06-30").code).toBe("IEA");
    expect(applicableEvidenceCode("2024-07-01").code).toBe("BSA");
    expect(applicableEvidenceCode(null).code).toBe("requires_review");
  });
});
