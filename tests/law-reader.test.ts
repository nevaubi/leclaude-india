import { describe, expect, it } from "vitest";
import { chapterNumber, displayChapterTitle, displayHeading, exactCentralAct, groupToc, lawBlocks, normActTitle } from "@/modules/law/reader";
import type { LawTocEntry } from "@/modules/law/shared";

const S303 = [
  "CHAPTER XVII", "OF OFFENCES AGAINST PROPERTY", "Of theft",
  "303. Theft.— (1) Whoever, intending to take dishonestly any movable property … is said to commit theft.",
  "Explanation 1. — A thing so long as it is attached to the earth … severed from the earth.",
  "Explanation 2. — A moving effected by the same act which affects the severance may be a theft.",
  "Illustrations.",
  "(a) A cuts down a tree on Z's ground … he has committed theft.",
  "(b) A puts a bait for dogs in his pocket … follow A.",
  "(2) Whoever commits theft shall be punished … and with fine:",
  "Provided that in cases of theft where the value … punished with community service.",
].join("\n\n");

describe("statute reader blocks", () => {
  it("classifies paragraphs without changing a character", () => {
    const blocks = lawBlocks(S303, "303");
    expect(blocks.map((b) => b.kind)).toEqual(["headnote", "headnote", "headnote", "lead", "explanation", "explanation", "illustrations", "illustration", "illustration", "subsection", "proviso"]);
    const rebuilt = blocks.map((b) => b.label + b.text).join("\n\n");
    expect(rebuilt).toBe(S303);
    expect(blocks[3]).toMatchObject({ label: "303. Theft.— ", anchor: "ss-1" });
    expect(blocks.map((b) => b.anchor).filter(Boolean)).toEqual(["ss-1", "expl-1", "expl-2", "illustrations", "ill-a", "ill-b", "ss-2", "proviso-1"]);
  });

  it("treats nothing as a headnote when the section's own number is not found", () => {
    const blocks = lawBlocks("CHAPTER I\n\nSome text without the number.", "9");
    expect(blocks.map((b) => b.kind)).toEqual(["para", "para"]);
    expect(lawBlocks("(a) one\n\n(a) two", "_").map((b) => b.anchor)).toEqual(["cl-a", "cl-a-2"]);
  });
});

describe("table of contents grouping", () => {
  const e = (section: string, chapter: string | null, chapter_title: string | null): LawTocEntry => ({ section, variant: 0, ord: 0, heading: null, chapter, chapter_title, parts: 1 });
  it("groups contiguous runs and flags chapters that jump out of statutory order", () => {
    const g = groupToc([
      e("1", "I", "PRELIMINARY"), e("2", "XX", "REPEAL AND SAVINGS"), e("3", "XX", "REPEAL AND SAVINGS"), e("6", "II", "OF PUNISHMENTS"),
      e("7", "XX", "REPEAL AND SAVINGS"), e("8", "II", "OF PUNISHMENTS"), e("14", "III", "GENERAL EXCEPTIONS"), e("358", "XX", "REPEAL AND SAVINGS"),
    ]);
    expect(g.map((x) => [x.chapter, x.entries.length, x.outOfSequence])).toEqual([["I", 1, false], ["XX", 2, true], ["II", 1, false], ["XX", 1, true], ["II", 1, false], ["III", 1, false], ["XX", 1, false]]);
    expect([chapterNumber("XVII"), chapterNumber("IVA"), chapterNumber("12"), chapterNumber("Part")]).toEqual([17, 4, 12, null]);
  });
  it("cleans display-only artefacts", () => {
    expect(displayChapterTitle(". - OFFENCES AGAINST PROPERTY")).toBe("OFFENCES AGAINST PROPERTY");
    expect(displayHeading("Amount of fine, liability in default of payment of fine, etc**")).toBe("Amount of fine, liability in default of payment of fine, etc");
  });
});

describe("key Central Acts", () => {
  it("matches only the exact Central title", () => {
    expect(normActTitle("The Code of Civil Procedure, 1908")).toBe("code of civil procedure 1908");
    const hits = [
      { title: "The Code of Civil Procedure (Amendment) Act, 1976", year: 1976, jurisdiction: "central" },
      { title: "The Code of Civil Procedure, 1908", year: 1908, jurisdiction: "state" },
      { title: "The Code of Civil Procedure, 1908", year: 1908, jurisdiction: "central" },
    ];
    expect(exactCentralAct("Code of Civil Procedure, 1908", hits)).toBe(hits[2]);
    expect(exactCentralAct("Limitation Act, 1963", hits)).toBeNull();
  });
});
