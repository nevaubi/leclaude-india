import { describe, expect, it } from "vitest";
import {
  canonicalCaseType,
  caseNumberKeys,
  findDiaryNos,
  isCaseKey,
  isDiaryKey,
  normalizeCaseNumber,
  normalizeDiaryNo,
  parseCaseNumber,
  parseCaseNumbers,
  qualifiedCaseKey,
  splitCaseNumbers,
} from "@/modules/official/case-numbers";

// Every printed form below is copied from a published list / page captured on 2026-10-02 (sci.gov.in, delhihighcourt.nic.in,
// nclt.gov.in, nclat.nic.in) unless marked otherwise.

describe("normalizeCaseNumber — documented contract examples stay stable", () => {
  it("keeps the four examples in the module comment", () => {
    expect(normalizeCaseNumber("SLP(C) No. 1234/2026")?.key).toBe("SLPC/1234/2026");
    expect(normalizeCaseNumber("W.P.(C)-5812/2016")?.key).toBe("WPC/5812/2016");
    expect(normalizeCaseNumber("Comp. App. (AT) (Ins) No. 351 of 2026")?.key).toBe("COMPAPPATINS/351/2026");
    const nclt = normalizeCaseNumber("CP(IB)/29(MP)2022");
    expect(nclt).toEqual({ key: "CPIB/29/2022", type: "CPIB", number: "29", year: "2022", bench: "MP" });
    expect(normalizeDiaryNo("Diary No. 54583-2026")).toBe("54583/2026");
  });
});

describe("normalizeCaseNumber — forum forms", () => {
  const cases: [string, string][] = [
    // Supreme Court
    ["SLP(Crl) No. 13176/2026", "SLPCRL/13176/2026"],
    ["SLP(Crl.) No. 13176/2026", "SLPCRL/13176/2026"],
    ["SLP (C) No. 1234/2026", "SLPC/1234/2026"],
    ["C.A. No. 166/2019", "CA/166/2019"],
    ["Crl.A. No. 166/2019", "CRLA/166/2019"],
    ["Criminal Appeal No. 166 of 2019", "CRLA/166/2019"],
    ["CIVIL APPEAL NO. 166 OF 2019", "CA/166/2019"],
    ["W.P.(C) No. 17/2026", "WPC/17/2026"],
    ["W.P.(Crl.) No. 5/2026", "WPCRL/5/2026"],
    ["Writ Petition (Civil) No. 17 of 2026", "WPC/17/2026"],
    ["T.P.(C) No. 1935/2018", "TPC/1935/2018"],
    ["T.P.(Crl.) No. 8/2026", "TPCRL/8/2026"],
    ["Special Leave Petition (Civil) No. 1234 of 2026", "SLPC/1234/2026"],
    ["MA 2911/2026", "MA/2911/2026"],
    ["CONMT.PET.(C) No. 5/2026", "CONMTPETC/5/2026"],
    // Delhi High Court
    ["CS(COMM) 123/2026", "CSCOMM/123/2026"],
    ["CRL.M.C. 4567/2026", "CRLMC/4567/2026"],
    ["CM APPL. 20687/2020", "CMAPPL/20687/2020"],
    // NCLT
    ["IA/259(MP)2026", "IA/259/2026"],
    ["CA(CAA)/8(MP)2026", "CACAA/8/2026"],
    ["C.P.(IB)/18(MP)2021", "CPIB/18/2021"],
    ["Co. Appeal/11(MP)2026", "COAPPEAL/11/2026"],
    ["Cont.App.(CP)/24(MP)2026", "CONTAPPCP/24/2026"],
    // NCLAT
    ["Comp. App. (AT) No. 351 of 2026", "COMPAPPAT/351/2026"],
    ["COMP. APP. (AT) NO. 8 OF 2023", "COMPAPPAT/8/2023"],
    ["Company Appeal (AT) (Insolvency) No. 2133 of 2024", "COMPAPPATINS/2133/2024"],
    ["Competition App. (AT) No. 01 of 2026", "COMPETITIONAPPAT/1/2026"],
    ["I.A. No. 3940 of 2026", "IA/3940/2026"],
    // High Court eCourts style (constructed)
    ["WP(C)/1234/2020", "WPC/1234/2020"],
    ["CRL.A/12/2021", "CRLA/12/2021"],
  ];
  it.each(cases)("%s → %s", (printed, key) => {
    expect(normalizeCaseNumber(printed)?.key).toBe(key);
  });

  it("removes leading zeros from the number only", () => {
    expect(normalizeCaseNumber("Competition App. (AT) No. 01 of 2026")?.number).toBe("1");
    expect(normalizeCaseNumber("W.P.(C)-05812/2016")?.key).toBe("WPC/5812/2016");
  });

  it("never guesses: diary numbers, ranges, lists, bare numbers and prose are not case numbers", () => {
    for (const s of [
      "Diary No. 54583-2026",
      "54583-2026",
      "C.A. No. 6792-6796/2023",
      "I.A. No. 2884, 5790 of 2026",
      "Main Matter",
      "Allowed 03-02-2025",
      "1234/2026",
      "",
      "No. 12/2026",
      "W.P.(C)",
      "SLP(C) No. 1234/1850",
    ]) {
      expect(normalizeCaseNumber(s), s).toBeNull();
    }
  });

  it("keeps the NCLT bench code out of the key and exposes the bench-qualified key", () => {
    const n = normalizeCaseNumber("CP(IB)/29(MP)2022")!;
    expect(qualifiedCaseKey(n)).toBe("CPIB/29/2022@MP");
    expect(caseNumberKeys("CP(IB)/29(MP)2022")).toEqual(["CPIB/29/2022", "CPIB/29/2022@MP"]);
    expect(caseNumberKeys("CP(IB)/29(MB)2022")).toEqual(["CPIB/29/2022", "CPIB/29/2022@MB"]);
  });

  it("canonicalCaseType rejects digits and diary prefixes", () => {
    expect(canonicalCaseType("SLP(C) No.")).toBe("SLPC");
    expect(canonicalCaseType("Connected C.A. No.")).toBe("CA");
    expect(canonicalCaseType("C.A. No. 3309-")).toBeNull();
    expect(canonicalCaseType("Diary No.")).toBeNull();
  });
});

describe("caseNumberKeys — ranges and lists", () => {
  it("expands short increasing ranges printed by the Supreme Court", () => {
    expect(caseNumberKeys("C.A. No. 6792-6796/2023")).toEqual(["CA/6792/2023", "CA/6793/2023", "CA/6794/2023", "CA/6795/2023", "CA/6796/2023"]);
    expect(caseNumberKeys("C.A. No. 3309-3310/1997")).toEqual(["CA/3309/1997", "CA/3310/1997"]);
  });

  it("does not expand decreasing, abbreviated or huge ranges", () => {
    expect(caseNumberKeys("C.A. No. 1234-35/2023")).toEqual([]);
    expect(caseNumberKeys("C.A. No. 1-9999/2023")).toEqual([]);
  });

  it("splits lists that share one type and year", () => {
    expect(caseNumberKeys("I.A. No. 2884, 5790 of 2026")).toEqual(["IA/2884/2026", "IA/5790/2026"]);
  });

  it("returns nothing for unrecognised text", () => {
    expect(caseNumberKeys("Main Matter")).toEqual([]);
    expect(caseNumberKeys("Diary No. 54583-2026")).toEqual([]);
  });
});

describe("splitCaseNumbers — concatenated cells", () => {
  it("splits Delhi HC cells whose numbers are glued together", () => {
    expect(splitCaseNumbers("W.P.(C)-5726/2020CM APPL. 20687/2020WITH W.P.(C) 2240/2024 W.P.(C) 6760/2020 W.P.(C) 10678/2022")).toEqual([
      "W.P.(C)-5726/2020",
      "CM APPL. 20687/2020",
      "W.P.(C) 2240/2024",
      "W.P.(C) 6760/2020",
      "W.P.(C) 10678/2022",
    ]);
    expect(splitCaseNumbers("W.P.(C)-10678/2022CM APPL. 30984/2022CM APPL. 67136/2024WITH W.P.(C) 2240/2024")).toEqual([
      "W.P.(C)-10678/2022",
      "CM APPL. 30984/2022",
      "CM APPL. 67136/2024",
      "W.P.(C) 2240/2024",
    ]);
  });

  it("splits NCLT 'in' chains and NCLAT '&' lists", () => {
    expect(splitCaseNumbers("IA/37(MP)2026 in Cont.App.(CP)/24(MP)2026 in CP/9(MP)2021")).toEqual(["IA/37(MP)2026", "Cont.App.(CP)/24(MP)2026", "CP/9(MP)2021"]);
    expect(splitCaseNumbers("Comp. App. (AT) (Ins) No. 2133 of 2024 & I.A. No. 3940 of 2026")).toEqual(["Comp. App. (AT) (Ins) No. 2133 of 2024", "I.A. No. 3940 of 2026"]);
    expect(splitCaseNumbers("Comp. App. (AT) No. 107 of 2026 & I.A. No. 2579 of 2026 (With Defects)")).toEqual(["Comp. App. (AT) No. 107 of 2026", "I.A. No. 2579 of 2026"]);
  });

  it("splits Supreme Court compound numbers and drops section codes, 'Connected' and diary numbers", () => {
    expect(splitCaseNumbers("MA 2911/2026 in SLP(C) No. 16609/2026")).toEqual(["MA 2911/2026", "SLP(C) No. 16609/2026"]);
    expect(splitCaseNumbers("R.P.(C) No. 1234-1235/2026 in SLP(C) No. 9-10/2025")).toEqual(["R.P.(C) No. 1234-1235/2026", "SLP(C) No. 9-10/2025"]);
    expect(splitCaseNumbers("SLP(Crl) No. 13176/2026 II-C")).toEqual(["SLP(Crl) No. 13176/2026"]);
    expect(splitCaseNumbers("Connected C.A. No. 3305/1997 XII-B")).toEqual(["C.A. No. 3305/1997"]);
    expect(splitCaseNumbers("Diary No. 54583-2026 II")).toEqual([]);
    expect(splitCaseNumbers("Main Matter")).toEqual([]);
  });

  it("parseCaseNumbers keeps printed text, normalized key and every exact key", () => {
    expect(parseCaseNumbers("Competition App. (AT) No. 01 of 2026 & I.A. No. 2884, 5790 of 2026")).toEqual([
      { printed: "Competition App. (AT) No. 01 of 2026", normalized: "COMPETITIONAPPAT/1/2026", keys: ["COMPETITIONAPPAT/1/2026"] },
      { printed: "I.A. No. 2884, 5790 of 2026", normalized: null, keys: ["IA/2884/2026", "IA/5790/2026"] },
    ]);
    expect(parseCaseNumber("  SLP(C) No. 1234/2026. ")).toEqual({ printed: "SLP(C) No. 1234/2026", normalized: "SLPC/1234/2026", keys: ["SLPC/1234/2026"] });
  });
});

describe("diary numbers and key validators", () => {
  it("finds only numbers printed as diary numbers", () => {
    expect(findDiaryNos("Diary No. 54583-2026 II")).toEqual(["54583/2026"]);
    expect(findDiaryNos("THE STATE VS. X - Crl.A. No. 166/2019 - Diary Number 4240 / 2015 - 01-Oct-2026")).toEqual(["4240/2015"]);
    expect(findDiaryNos("SLP(C) No. 1234/2026")).toEqual([]);
  });

  it("validates normalized keys strictly", () => {
    expect(isCaseKey("SLPC/1234/2026")).toBe(true);
    expect(isCaseKey("CPIB/29/2022@MP")).toBe(true);
    expect(isCaseKey("slpc/1234/2026")).toBe(false);
    expect(isCaseKey("SLPC/0/2026")).toBe(false);
    expect(isCaseKey("SLPC/1234/26")).toBe(false);
    expect(isDiaryKey("54583/2026")).toBe(true);
    expect(isDiaryKey("54583-2026")).toBe(false);
  });
});
