import { describe, expect, it } from "vitest";
import { displayLawCitation, humanizeCitation, lawCitation, repeatedProvisionLabel } from "@/modules/law/shared";

const ACT = { kind: "act", title: "X Act, 2000", year: 2000 };

describe("user-facing law citations", () => {
  it("matches lawCitation when the provision number is unique", () => {
    expect(displayLawCitation(ACT, "5")).toBe(lawCitation(ACT, "5"));
    expect(displayLawCitation(ACT, "_")).toBe(lawCitation(ACT, "_"));
  });

  it("describes a repeated provision number in plain words, never the internal variant index", () => {
    expect(displayLawCitation(ACT, "14", 1)).toBe("Section 14 (second so numbered), X Act, 2000");
    expect(displayLawCitation(ACT, "14", 1)).not.toMatch(/variant|dataset/);
    expect(repeatedProvisionLabel(ACT, "14", 2)).toBe("third section numbered 14");
    expect(repeatedProvisionLabel({ kind: "regulation", title: "SEBI Regulations" }, "3", 1)).toBe("second regulation numbered 3");
  });

  it("rewrites a stored citation for display without touching anything else", () => {
    const stored = lawCitation(ACT, "14", 5);
    expect(stored).toContain("variant 6 in the dataset");
    expect(humanizeCitation(stored)).toBe("Section 14 (sixth so numbered), X Act, 2000");
    expect(humanizeCitation("2023 INSC 1066")).toBe("2023 INSC 1066");
  });
});
