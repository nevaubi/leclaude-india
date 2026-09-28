import { describe, expect, it } from "vitest";
import { citationBindingEffect, citationKey, extractCitations, normalizeCitation, parseCitation, toIndianCitation } from "@/lib/india/citations";
import { authorityKey, buildTableOfAuthorities, CitationTracker, formatCaseCitation, formatIndianDate, formatPinpoint, normalizeCaseName, tableOfAuthoritiesMarkdown } from "@/lib/india/citation-style";
import { courtById } from "@/lib/india/courts";
import { extractStatutes } from "@/lib/india/statutes";

const now = new Date("2026-09-28T00:00:00Z");
const P = (s: string) => parseCitation(s, { now });

describe("parseCitation: valid forms", () => {
  const cases: [string, string, string, string | undefined, Partial<ReturnType<typeof P>>?][] = [
    // raw, kind, normalized, courtId, extra
    ["2024 INSC 735", "neutral", "2024 INSC 735", "sci", { year: 2024 }],
    ["2024INSC735", "neutral", "2024 INSC 735", "sci"],
    ["2024:KHC:1234", "neutral", "2024:KHC:1234", "hc-karnataka", { benchId: "kar-bengaluru" }],
    ["2024:KHC-D:7336", "neutral", "2024:KHC-D:7336", "hc-karnataka", { benchId: "kar-dharwad" }],
    ["2024:KHC-K:12", "neutral", "2024:KHC-K:12", "hc-karnataka", { benchId: "kar-kalaburagi" }],
    ["2024 : KHC - D : 7336", "neutral", "2024:KHC-D:7336", "hc-karnataka"],
    ["2024:TSHC:55", "neutral", "2024:TSHC:55", "hc-telangana"],
    ["2024:APHC:9", "neutral", "2024:APHC:9", "hc-andhra"],
    ["2023:DHC:1234", "neutral", "2023:DHC:1234", "hc-delhi"],
    ["2023:DHC:1234-DB", "neutral", "2023:DHC:1234-DB", "hc-delhi"],
    ["2023:BHC-AS:1234", "neutral", "2023:BHC-AS:1234", "hc-bombay", { benchLabel: "AS" }],
    ["(2017) 10 SCC 1", "reporter", "(2017) 10 SCC 1", "sci", { reporter: "SCC", year: 2017, volume: 10, page: 1 }],
    ["(2017) 3 SCC (Cri) 123", "reporter", "(2017) 3 SCC (Cri) 123", "sci", { reporter: "SCC (Cri)" }],
    ["(2010) 2 SCC (L&S) 45", "reporter", "(2010) 2 SCC (L&S) 45", "sci"],
    ["(1973) 4 S.C.C. 225", "reporter", "(1973) 4 SCC 225", "sci"],
    ["2023 SCC OnLine SC 123", "reporter", "2023 SCC OnLine SC 123", "sci"],
    ["2022 SCC OnLine Kar 456", "reporter", "2022 SCC OnLine Kar 456", "hc-karnataka"],
    ["2022 SCC OnLine TS 456", "reporter", "2022 SCC OnLine TS 456", "hc-telangana"],
    ["2021 SCC OnLine AP 4", "reporter", "2021 SCC OnLine AP 4", "hc-andhra"],
    ["2020 SCC OnLine Del 7", "reporter", "2020 SCC OnLine Del 7", "hc-delhi"],
    ["AIR 1973 SC 1461", "reporter", "AIR 1973 SC 1461", "sci", { reporter: "AIR", page: 1461 }],
    ["AIR 2005 Kar 12", "reporter", "AIR 2005 Kar 12", "hc-karnataka"],
    ["AIR 2005 Kant 12", "reporter", "AIR 2005 Kant 12", "hc-karnataka"],
    ["A.I.R. 1950 SC 27", "reporter", "AIR 1950 SC 27", "sci"],
    ["[1973] Supp. S.C.R. 1", "reporter", "[1973] Supp. SCR 1", "sci", { series: "Supp." }],
    ["(1950) SCR 88", "reporter", "[1950] SCR 88", "sci"],
    ["[1973] 1 SCR 12", "reporter", "[1973] 1 SCR 12", "sci", { volume: 1 }],
    ["[1962] Supp. (3) SCR 1", "reporter", "[1962] Supp. (3) SCR 1", "sci"],
    ["ILR 2005 Kar 1234", "reporter", "ILR 2005 Kar 1234", "hc-karnataka"],
    ["ILR 2005 KAR 1234", "reporter", "ILR 2005 Kar 1234", "hc-karnataka"],
    ["2019 (2) KarLJ 45", "reporter", "2019 (2) KarLJ 45", undefined],
    ["2019 (2) Kar. L.J. 45", "reporter", "2019 (2) KarLJ 45", undefined],
    ["(2019) 2 ALT 123", "reporter", "2019 (2) ALT 123", undefined],
    ["2019 (1) ALT (Crl) 45", "reporter", "2019 (1) ALT (Crl) 45", undefined],
    ["2019 (2) ALD 123", "reporter", "2019 (2) ALD 123", undefined],
    ["2019 (2) ALD (Crl) 12", "reporter", "2019 (2) ALD (Crl) 12", undefined],
    ["2006 Cri LJ 1234", "reporter", "2006 Cri LJ 1234", undefined],
    ["2006 Crl.L.J. 1234", "reporter", "2006 Cri LJ 1234", undefined],
    ["2006 CriLJ 1234", "reporter", "2006 Cri LJ 1234", undefined],
    ["(2023) 5 SCALE 123", "reporter", "(2023) 5 SCALE 123", "sci"],
    ["JT 2023 (5) SC 123", "reporter", "JT 2023 (5) SC 123", "sci"],
    ["W.P. No. 12345 of 2023", "case_number", "W.P. No. 12345 of 2023", undefined, { caseTypeId: "wp" }],
    ["WP 12345/2023", "case_number", "W.P. No. 12345 of 2023", undefined],
    ["W.P.No.12345/2023 (GM-RES)", "case_number", "W.P. No. 12345 of 2023 (GM-RES)", undefined, { subject: "GM-RES" }],
    ["Crl.P. 1234/2024", "case_number", "Crl.P. No. 1234 of 2024", undefined, { caseTypeId: "crl-p" }],
    ["CRL.P No. 1234 of 2024", "case_number", "Crl.P. No. 1234 of 2024", undefined],
    ["RSA No. 100004 of 2024", "case_number", "R.S.A. No. 100004 of 2024", undefined, { caseTypeId: "rsa" }],
    ["O.S. No. 45 of 2019", "case_number", "O.S. No. 45 of 2019", undefined, { caseTypeId: "os" }],
    ["S.L.P. (C) No. 1234 of 2023", "case_number", "S.L.P. (C) No. 1234 of 2023", undefined, { caseTypeId: "slp-c" }],
    ["SLP (Civil) No. 1234 of 2023", "case_number", "S.L.P. (C) No. 1234 of 2023", undefined],
    ["SLP(Crl) No. 55 of 2022", "case_number", "S.L.P. (Crl.) No. 55 of 2022", undefined, { caseTypeId: "slp-crl" }],
    ["Crl.A. No. 7 of 2020", "case_number", "Crl.A. No. 7 of 2020", undefined],
    ["W.P.(PIL) No. 9 of 2021", "case_number", "W.P. (PIL) No. 9 of 2021", undefined, { caseTypeId: "wp-pil" }],
    ["Crl.R.P. No. 100 of 2022", "case_number", "Crl.R.P. No. 100 of 2022", undefined, { caseTypeId: "crl-rp" }],
    ["M.F.A. No. 3 of 2018", "case_number", "M.F.A. No. 3 of 2018", undefined],
    ["C.R.P. No. 3 of 2018", "case_number", "C.R.P. No. 3 of 2018", undefined],
    ["KAHC020000022024", "cnr", "KAHC020000022024", "hc-karnataka", { cnrState: "KA", cnrSerial: 2, year: 2024 }],
    ["HBHC010012342023", "cnr", "HBHC010012342023", "hc-telangana"],
    ["APHC010000012020", "cnr", "APHC010000012020", "hc-andhra"],
    ["KABC010012342019", "cnr", "KABC010012342019", undefined, { cnrState: "KA", cnrDistrict: "BC" }],
  ];
  it.each(cases)("%s", (raw, kind, normalized, courtId, extra) => {
    const p = P(raw);
    expect(p.kind).toBe(kind);
    expect(p.valid).toBe(true);
    expect(p.issues).toEqual([]);
    expect(p.normalized).toBe(normalized);
    expect(p.courtId).toBe(courtId);
    expect(p.raw).toBe(raw);
    if (extra) expect(p).toMatchObject(extra);
  });
});

describe("parseCitation: nothing is guessed", () => {
  const unknowns = ["Kesavananda Bharati", "2024 INSC", "INSC 735", "(2017) SCC 1", "2023 SCC OnLine 123", "AIR SC 1461", "", "   ", "KA01AB1234", "10:30", "2024:KHC", "(2017) 10 SCC 1 and (2018) 1 SCC 2"];
  it.each(unknowns)("%j → unknown", (raw) => {
    const p = P(raw);
    expect(p.kind).toBe("unknown");
    expect(p.courtId).toBeUndefined();
    expect(p.valid).toBe(false);
    expect(p.raw).toBe(raw);
  });

  const invalid: [string, RegExp, string?][] = [
    ["2024:KHC-X:7336", /unknown bench suffix/, "KHC-X"],
    ["2024:KXC:7336", /unknown neutral citation prefix/, "KXC"],
    ["2024:INSC:735", /YYYY INSC N/, "INSC"],
    ["2027 INSC 12", /future/, "INSC"],
    ["1949 INSC 1", /before this form existed/, "INSC"],
    ["2024 INSC 0", /number 0/, "INSC"],
    ["(1960) 1 SCC 1", /before this form existed/],
    ["2016 SCC OnLine AP 12", /predecessor High Court/, "AP"],
    ["2018 SCC OnLine TS 12", /predecessor High Court/, "TS"],
    ["AIR 1990 AP 12", /predecessor High Court/, "AP"],
    ["2020 SCC OnLine Xyz 5", /not in the coded SCC OnLine table/, "Xyz"],
    ["AIR 1960 Mys 5", /not in the coded AIR table/, "Mys"],
    ["2019 (2) KarLJ (Crl) 45", /no \(Crl\) series/],
    ["KAHC020000002024", /serial number 0/],
    ["KAHC020000012031", /future/],
    ["W.P. No. 12 of 2031", /future/],
  ];
  it.each(invalid)("%s is recognised but invalid, with no court", (raw, issue, unresolved) => {
    const p = P(raw);
    expect(p.kind).not.toBe("unknown");
    expect(p.valid).toBe(false);
    expect(p.issues.join(" ")).toMatch(issue);
    expect(p.courtId).toBeUndefined();
    if (unresolved) expect(p.unresolvedCourt).toBe(unresolved);
  });

  it("does not treat an unknown case-type label as a case number", () => {
    expect(P("XYZ No. 12 of 2020").kind).toBe("unknown");
    expect(P("as 12 of 2019").kind).toBe("unknown");
  });

  it("strips trailing punctuation but keeps raw", () => {
    const p = P("(2017) 10 SCC 1,");
    expect(p.normalized).toBe("(2017) 10 SCC 1");
    expect(p.raw).toBe("(2017) 10 SCC 1,");
    expect(normalizeCitation("2024INSC735")).toBe("2024 INSC 735");
    expect(normalizeCitation("nonsense")).toBeNull();
  });

  it("toIndianCitation keeps only the shared contract fields", () => {
    const c = toIndianCitation(P("(2017) 10 SCC 1"));
    expect(c).toEqual({ raw: "(2017) 10 SCC 1", kind: "reporter", reporter: "SCC", year: 2017, volume: 10, page: 1, courtId: "sci" });
  });
});

describe("extractCitations", () => {
  const text = "As held in Kesavananda Bharati v. State of Kerala, (1973) 4 SCC 225 : AIR 1973 SC 1461, and followed in 2024:KHC-D:7336 (RSA No. 100004 of 2024), " +
    "see also 2023 SCC OnLine Kar 12 and CNR KAHC020000022024. Offence u/s 420 IPC.";
  const out = extractCitations(text, { now });
  it("finds every citation with exact offsets", () => {
    expect(out.map((c) => c.normalized)).toEqual(["(1973) 4 SCC 225", "AIR 1973 SC 1461", "2024:KHC-D:7336", "R.S.A. No. 100004 of 2024", "2023 SCC OnLine Kar 12", "KAHC020000022024"]);
    for (const c of out) expect(text.slice(c.start, c.end)).toBe(c.raw);
  });
  it("adds statute references on request", () => {
    const withStat = extractCitations(text, { now, statutes: true });
    const stat = withStat.find((c) => c.kind === "statute");
    expect(stat?.raw).toBe("u/s 420 IPC");
    expect(stat?.normalized).toBe("s. 420 IPC");
  });
  it("prefers the longest match at the same start and never overlaps", () => {
    const o = extractCitations("(2017) 3 SCC (Cri) 123", { now });
    expect(o).toHaveLength(1);
    expect(o[0].reporter).toBe("SCC (Cri)");
    const o2 = extractCitations("2023:BHC-AS:1234 and 2023 INSC 5", { now });
    expect(o2.map((c) => c.normalized)).toEqual(["2023:BHC-AS:1234", "2023 INSC 5"]);
  });
  it("returns nothing for plain prose and dates", () => {
    expect(extractCitations("On 12.03.2024 at 10:30 the court sat. Phone 080-2222 3333.", { now })).toEqual([]);
  });
  it("handles a large document quickly", () => {
    const big = (text + " Lorem ipsum dolor sit amet. ").repeat(400);
    const t0 = Date.now();
    const r = extractCitations(big, { now, statutes: true });
    expect(r.length).toBe(400 * 7);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("court mapping and binding effect", () => {
  const ka = courtById("hc-karnataka")!;
  it.each([
    ["2024 INSC 735", "binding"], ["(2017) 10 SCC 1", "binding"], ["2024:KHC:1", "binding"], ["2024:TSHC:1", "persuasive"],
    ["2024:APHC:1", "persuasive"], ["2019 (2) KarLJ 45", "unknown"], ["2024:KHC-X:1", "unknown"], ["W.P. No. 1 of 2024", "unknown"],
  ])("%s in the Karnataka High Court → %s", (raw, expected) => {
    expect(citationBindingEffect(P(raw), ka)).toBe(expected);
  });
  it("citationKey separates same numbers in different courts", () => {
    expect(citationKey(P("2024:KHC:100"))).not.toBe(citationKey(P("2024:TSHC:100")));
  });
});

describe("citation style", () => {
  it("formats SCC-style, neutral first, parallel with ' : '", () => {
    expect(formatCaseCitation({ caseName: "Kesavananda Bharati vs. State of Kerala", reporters: ["(1973) 4 SCC 225"] }).citation).toBe("Kesavananda Bharati v. State of Kerala, (1973) 4 SCC 225");
    const r = formatCaseCitation({ caseName: "X v. Y", neutral: "2024INSC735", reporters: ["AIR 2024 SC 5", "(2024) 10 SCC 1"] }, { pinpoint: 45 });
    expect(r.citation).toBe("X v. Y, 2024 INSC 735 : (2024) 10 SCC 1 : AIR 2024 SC 5, para 45");
    expect(r.courtId).toBe("sci");
    expect(r.short).toBe("X (supra)");
    expect(formatCaseCitation({ caseName: "X v. Y", neutral: "2024:KHC-D:7336" }, { pinpoint: { from: 12, to: 14 } }).citation).toBe("X v. Y, 2024:KHC-D:7336, paras 12–14");
    expect(formatCaseCitation({ caseName: "X v. Y", neutral: "2024 INSC 1", reporters: ["(2024) 1 SCC 1"] }, { parallel: false }).citation).toBe("X v. Y, 2024 INSC 1");
  });
  it("emphasis modes", () => {
    expect(formatCaseCitation({ caseName: "A v. B", neutral: "2024 INSC 1" }, { emphasis: "markdown" }).citation).toBe("*A v. B*, 2024 INSC 1");
    expect(formatCaseCitation({ caseName: "A & B v. C<D>", neutral: "2024 INSC 1" }, { emphasis: "html" }).citation).toBe("<i>A &amp; B v. C&lt;D></i>, 2024 INSC 1");
  });
  it("pinpoints", () => {
    expect(formatPinpoint(5)).toBe(", para 5");
    expect(formatPinpoint([9, 3, 7])).toBe(", paras 3, 7 and 9");
    expect(formatPinpoint({ from: 4, to: 4 })).toBe(", para 4");
    expect(formatPinpoint("at p. 12")).toBe(", at p. 12");
    expect(formatPinpoint(undefined)).toBe("");
  });
  it("case-name normalisation does not eat initials", () => {
    expect(normalizeCaseName("K. V. Rao  Vs  State of A.P.")).toBe("K. V. Rao v. State of A.P.");
    expect(normalizeCaseName("A versus B")).toBe("A v. B");
    expect(normalizeCaseName("A v/s B,")).toBe("A v. B");
  });
  it("refuses invalid, unknown or inconsistent citations instead of formatting them", () => {
    expect(formatCaseCitation({ caseName: "X v. Y", neutral: "2024:KHC-X:1" }).citation).toBeNull();
    expect(formatCaseCitation({ caseName: "X v. Y", reporters: ["some reporter 12"] }).errors[0]).toMatch(/not a recognised/);
    expect(formatCaseCitation({ caseName: "X v. Y", neutral: "2024 INSC 1", reporters: ["2024 SCC OnLine Kar 1"] }).errors.join()).toMatch(/different courts/);
    expect(formatCaseCitation({ caseName: "X v. Y", neutral: "2024 INSC 1", courtId: "hc-karnataka" }).errors.join()).toMatch(/does not match/);
    expect(formatCaseCitation({ caseName: "", neutral: "2024 INSC 1" }).citation).toBeNull();
  });
  it("unreported decisions need case number, registry court and date", () => {
    expect(formatCaseCitation({ caseName: "A v. B", caseNumber: "W.P. No. 12345 of 2023", courtId: "hc-karnataka", decisionDate: "2024-03-12" }).citation)
      .toBe("A v. B (W.P. No. 12345 of 2023, High Court of Karnataka, decided on 12 March 2024)");
    const bad = formatCaseCitation({ caseName: "A v. B", caseNumber: "W.P. No. 1 of 2023", courtId: "hc-nowhere" });
    expect(bad.citation).toBeNull();
    expect(bad.errors.join()).toMatch(/courtId/);
    expect(bad.errors.join()).toMatch(/decisionDate/);
    expect(formatIndianDate("2024-13-01")).toBeNull();
  });
  it("labels translations, machine translations explicitly", () => {
    expect(formatCaseCitation({ caseName: "A v. B", neutral: "2024:KHC:5", translation: { language: "kn", origin: "machine" } }).citation).toBe("A v. B, 2024:KHC:5 [machine translation, Kannada]");
    expect(formatCaseCitation({ caseName: "A v. B", neutral: "2024:KHC:5", translation: { language: "en", origin: "original" } }).citation).toBe("A v. B, 2024:KHC:5");
  });
});

describe("CitationTracker", () => {
  const kb = { caseName: "Kesavananda Bharati v. State of Kerala", reporters: ["(1973) 4 SCC 225"] };
  const other = { caseName: "Maneka Gandhi v. Union of India", reporters: ["(1978) 1 SCC 248"] };
  it("full → ibid → supra", () => {
    const t = new CitationTracker();
    expect(t.cite(kb, 10)).toMatchObject({ form: "full", text: "Kesavananda Bharati v. State of Kerala, (1973) 4 SCC 225, para 10" });
    expect(t.cite(kb, 12)).toMatchObject({ form: "ibid", text: "Ibid., para 12" });
    expect(t.cite(other).form).toBe("full");
    expect(t.cite(kb, 45)).toMatchObject({ form: "supra", text: "Kesavananda Bharati (supra), para 45" });
  });
  it("uses the full name when first parties collide, and the citation when full names collide", () => {
    const a = { caseName: "State of Karnataka v. Ramesh", neutral: "2024:KHC:1" };
    const b = { caseName: "State of Karnataka v. Suresh", neutral: "2024:KHC:2" };
    const t = new CitationTracker([a, b]);
    t.cite(a); t.cite(b);
    expect(t.cite(a).text).toBe("State of Karnataka v. Ramesh (supra)");
  });
  it("an invalid authority yields errors, not text", () => {
    const t = new CitationTracker();
    const r = t.cite({ caseName: "A v. B", neutral: "2099 INSC 1" });
    expect(r.text).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("table of authorities", () => {
  const statutes = extractStatutes("Section 302 IPC, Section 34 IPC, Art. 226 of the Constitution, Order XXXIX Rules 1 and 2 CPC and s. 302 IPC");
  const toa = buildTableOfAuthorities([
    { caseName: "Maneka Gandhi v. Union of India", reporters: ["(1978) 1 SCC 248"] },
    { caseName: "The State v. Abdul", neutral: "2024 INSC 3" },
    { caseName: "Ramesh v. State", neutral: "2024:TSHC:100" },
    { caseName: "Ramesh v. State", neutral: "2024:KHC:100" },
    { caseName: "Ramesh v. State", neutral: "2024:KHC:100" },
    { caseName: "Unknown Court Case", reporters: ["2019 (2) KarLJ 45"] },
    { caseName: "Broken", neutral: "2024:KHC-Z:1" },
  ], statutes);
  it("groups SC, High Courts, unidentified courts and statutes; dedupes; reports errors", () => {
    expect(toa.groups.map((g) => g.heading)).toEqual(["Supreme Court of India", "High Courts", "Court not identified", "Constitution and statutes"]);
    expect(toa.groups[0].cases!.map((c) => c.caseName)).toEqual(["Maneka Gandhi v. Union of India", "The State v. Abdul"]);
    // High Courts sort by court name, then case name.
    expect(toa.groups[1].cases!.map((c) => c.courtId)).toEqual(["hc-telangana", "hc-karnataka"]);
    expect(toa.groups[2].cases!.map((c) => c.citation)).toEqual(["Unknown Court Case, 2019 (2) KarLJ 45"]);
    expect(toa.errors.map((e) => e.caseName)).toEqual(["Broken"]);
    const st = toa.groups[3].statutes!;
    expect(st[0]).toEqual({ actId: "constitution", title: "Constitution of India", provisions: ["Art. 226"] });
    expect(st.find((s) => s.actId === "ipc")).toEqual({ actId: "ipc", title: "Indian Penal Code, 1860", provisions: ["s. 34", "s. 302"] });
    expect(st.find((s) => s.actId === "cpc")?.provisions).toEqual(["O. XXXIX R. 1", "O. XXXIX R. 2"]);
  });
  it("renders markdown with court sub-headings and an exclusions list", () => {
    const md = tableOfAuthoritiesMarkdown(toa);
    expect(md).toContain("### Supreme Court of India");
    expect(md).toContain("**High Court of Karnataka**");
    expect(md).toContain("**High Court for the State of Telangana**");
    expect(md).toContain("### Not included (citation could not be verified)");
    expect(md).toContain("- Indian Penal Code, 1860 — s. 34, s. 302");
  });
  it("authorityKey prefers explicit ids and never uses the name alone for cited cases", () => {
    expect(authorityKey({ id: "j1", caseName: "A v. B" })).toBe("id:j1");
    expect(authorityKey({ caseName: "A v. B", neutral: "2024:KHC:1" })).not.toBe(authorityKey({ caseName: "A v. B", neutral: "2024:TSHC:1" }));
  });
});
