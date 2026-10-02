import { describe, expect, it } from "vitest";
import {
  ACT_IN_FORCE_NOTE, INDIA_CODE_LEGACY_NOTE, legacyIndiaCodeNote, publisherLabel, sectionStatusBadge, statusLabel, statusTone, type LawInstrument,
} from "@/modules/law/shared";
import { codeRepeal, criminalCodeOf, sectionCorrespondence } from "@/modules/law/code-correspondence";
import { badYear, citatorNotBuilt, linkableSection, sectionStatsQuery, sparkPoints, statuteTitleFor, yearSeries, EMPTY_SECTION_FILTERS } from "@/modules/law/most-cited";

const inst = (o: Partial<LawInstrument>): Pick<LawInstrument, "title" | "year" | "jurisdiction"> => ({ title: "x", year: null, jurisdiction: "central", ...o });

describe("section status badge", () => {
  it("is green only when the dataset flags the provision itself in force", () => {
    expect(sectionStatusBadge({ status: "in_force", in_force: true })).toMatchObject({ label: "In force", tone: "ok" });
    expect(sectionStatusBadge({ status: null, in_force: true })).toMatchObject({ label: "In force", tone: "ok" });
    // Deliberately changed: `status` is the Act's status repeated on every provision, so an in-force Act with no
    // provision flag is "Act in force" (neutral), not a green "In force" for the section.
    expect(sectionStatusBadge({ status: "in_force", in_force: null })).toMatchObject({ label: "Act in force", tone: "unknown", title: ACT_IN_FORCE_NOTE });
    expect(ACT_IN_FORCE_NOTE).toMatch(/does not record whether this provision itself is in force/);
    for (const s of ["repealed", "superseded", "spent", "omitted", "substituted", "replaced"]) {
      expect(sectionStatusBadge({ status: s, in_force: false }).tone, s).toBe("off");
      expect(sectionStatusBadge({ status: s, in_force: true }).tone, s).toBe("off");
    }
    expect(sectionStatusBadge({ status: "superseded", in_force: false }).label).toBe("Superseded");
    expect(sectionStatusBadge({ status: "omitted", in_force: null }).label).toBe("Omitted");
  });

  it("never shows green when the flags disagree or nothing is recorded", () => {
    expect(sectionStatusBadge({ status: "in_force", in_force: false })).toMatchObject({ label: "Not in force", tone: "off" });
    expect(sectionStatusBadge({ status: null, in_force: false })).toMatchObject({ label: "Not in force", tone: "off" });
    expect(sectionStatusBadge({ status: null, in_force: null })).toMatchObject({ label: "Status not recorded", tone: "unknown" });
    expect(sectionStatusBadge({ status: "  ", in_force: null })).toMatchObject({ label: "Status not recorded", tone: "unknown" });
    expect(sectionStatusBadge({ status: "partially_in_force", in_force: null })).toMatchObject({ label: "Partly in force", tone: "unknown" });
    expect(sectionStatusBadge({ status: "weird_value", in_force: null })).toMatchObject({ label: "Weird value", tone: "unknown" });
    // The badge always explains that section-level repeal may be missing from the dataset.
    expect(sectionStatusBadge({ status: "in_force", in_force: true }).title).toMatch(/may not be recorded in the dataset/);
  });

  it("always shows the IPC, CrPC and Evidence Act as repealed from 1 July 2024, whatever the dataset records", () => {
    const ipc = codeRepeal(inst({ title: "The Indian Penal Code", year: 1860 }))!;
    expect(ipc).toMatchObject({ code: "IPC", on: "1 July 2024" });
    expect(ipc.note).toMatch(/Bharatiya Nyaya Sanhita, 2023 \(s\.358, repeal and savings\)/);
    expect(codeRepeal(inst({ title: "Code of Criminal Procedure, 1973", year: 1974 }))!.note).toMatch(/Bharatiya Nagarik Suraksha Sanhita, 2023 \(s\.531/);
    expect(codeRepeal(inst({ title: "Indian Evidence Act, 1872", year: 1872 }))!.note).toMatch(/Bharatiya Sakshya Adhiniyam, 2023 \(s\.170/);
    // The new codes, other Acts and same-titled State instruments are not repealed by this rule.
    expect(codeRepeal(inst({ title: "Bharatiya Nyaya Sanhita, 2023", year: 2023 }))).toBeNull();
    expect(codeRepeal(inst({ title: "Indian Contract Act, 1872", year: 1872 }))).toBeNull();
    expect(codeRepeal(inst({ title: "The Indian Penal Code", year: 1860, jurisdiction: "state" }))).toBeNull();
    for (const flags of [{ status: "in_force", in_force: true }, { status: "in_force", in_force: null }, { status: null, in_force: null }, { status: "repealed", in_force: false }]) {
      expect(sectionStatusBadge({ ...flags, repealedOn: ipc.on, repealedNote: ipc.note })).toEqual({ label: "Repealed (1 July 2024)", tone: "off", title: ipc.note });
    }
  });

  it("labels substituted / replaced and keeps their tone off", () => {
    expect(statusLabel("substituted")).toBe("Substituted");
    expect(statusLabel("replaced")).toBe("Replaced");
    expect(statusTone("substituted")).toBe("off");
    expect(statusTone("replaced")).toBe("off");
    expect(statusTone("in_force")).toBe("ok");
    expect(statusTone("amended")).toBe("unknown");
  });
});

describe("India Code links", () => {
  it("labels both hosts and notes old renumbered handles without rewriting them", () => {
    expect(publisherLabel({ source_url: "https://indiacode.gov.in/handle/123456789/496549", regulator: null, publisher: null })).toBe("India Code (Legislative Department)");
    expect(legacyIndiaCodeNote("https://www.indiacode.nic.in/handle/123456789/20062")).toBe(INDIA_CODE_LEGACY_NOTE);
    expect(legacyIndiaCodeNote("https://indiacode.nic.in/bitstream/123456789/8634/1/act.pdf")).toMatch(/this link may not resolve/);
    expect(legacyIndiaCodeNote("https://indiacode.gov.in/handle/123456789/496549")).toBeNull();
    expect(legacyIndiaCodeNote("https://evil-indiacode.nic.in.example.com/handle/1")).toBeNull();
    expect(legacyIndiaCodeNote("javascript:alert(1)")).toBeNull();
    expect(legacyIndiaCodeNote(null)).toBeNull();
  });
});

describe("IPC / CrPC / IEA correspondence in the reader", () => {
  it("recognises the six codes only by exact Central title", () => {
    expect(criminalCodeOf(inst({ title: "The Indian Penal Code", year: 1860 }))).toBe("IPC");
    expect(criminalCodeOf(inst({ title: "THE CODE OF CRIMINAL PROCEDURE, 1973", year: 1974 }))).toBe("CrPC");
    expect(criminalCodeOf(inst({ title: "The Bharatiya Sakshya Adhiniyam, 2023", year: 2023 }))).toBe("BSA");
    expect(criminalCodeOf(inst({ title: "The Indian Penal Code", year: 1860, jurisdiction: "state" }))).toBeNull();
    expect(criminalCodeOf(inst({ title: "The Indian Penal Code (Amendment) Act, 2013", year: 2013 }))).toBeNull();
    expect(criminalCodeOf(inst({ title: "Code of Criminal Procedure, 1898", year: 1898 }))).toBeNull();
  });

  it("maps an IPC section to its BNS counterpart and opens the base section", () => {
    const c = sectionCorrespondence(inst({ title: "Indian Penal Code", year: 1860 }), "420")!;
    expect(c).toMatchObject({ direction: "old_to_new", status: "mapped", otherCode: "BNS", otherTitle: "Bharatiya Nyaya Sanhita, 2023" });
    expect(c.targets).toEqual([{ code: "BNS", section: "318(4)", readerSection: "318", label: "BNS s.318(4)" }]);
    expect(c.headline).toMatch(/^Replaced from 1 July 2024 by the Bharatiya Nyaya Sanhita, 2023\.$/);
  });

  it("keeps a split as a split and an unmapped section as unmapped", () => {
    const split = sectionCorrespondence(inst({ title: "Indian Penal Code", year: 1860 }), "498A")!;
    expect(split.status).toBe("split");
    expect(split.targets.map((t) => t.label)).toEqual(["BNS s.85", "BNS s.86"]);
    expect(split.headline).toMatch(/split across several provisions/);
    const none = sectionCorrespondence(inst({ title: "Indian Penal Code", year: 1860 }), "999")!;
    expect(none.status).toBe("unmapped");
    expect(none.targets).toEqual([]);
    expect(none.headline).toMatch(/Not in the coded correspondence table/);
  });

  it("maps new-code sections back and ignores other Acts and unnumbered text", () => {
    const back = sectionCorrespondence(inst({ title: "Bharatiya Nagarik Suraksha Sanhita, 2023", year: 2023 }), "482")!;
    expect(back).toMatchObject({ direction: "new_to_old", otherCode: "CrPC" });
    expect(back.targets.map((t) => t.label)).toContain("CrPC s.438");
    const ev = sectionCorrespondence(inst({ title: "Indian Evidence Act, 1872", year: 1872 }), "65B")!;
    expect(ev.targets.map((t) => t.label)).toEqual(["BSA s.63"]);
    expect(sectionCorrespondence(inst({ title: "Indian Contract Act, 1872", year: 1872 }), "10")).toBeNull();
    expect(sectionCorrespondence(inst({ title: "Indian Penal Code", year: 1860 }), "_")).toBeNull();
  });
});

describe("most-cited sections helpers", () => {
  it("builds the citator query, ordering years and dropping bad values", () => {
    expect(sectionStatsQuery(EMPTY_SECTION_FILTERS)).toBe("limit=15");
    expect(sectionStatsQuery({ act: "ipc", court: "sci", from: "2020", to: "2010" }, 20)).toBe("act=ipc&court=sci&from=2010&to=2020&limit=20");
    expect(sectionStatsQuery({ act: "not-an-act", court: "", from: "20x0", to: "" })).toBe("limit=15");
    expect(badYear("19")).toBe(true);
    expect(badYear("1850")).toBe(true);
    expect(badYear("2024")).toBe(false);
    expect(badYear("")).toBe(false);
  });

  it("fills missing years with zero and never interpolates", () => {
    expect(yearSeries([{ year: 2022, judgments: 3 }, { year: 2020, judgments: 1 }])).toEqual([{ year: 2020, judgments: 1 }, { year: 2021, judgments: 0 }, { year: 2022, judgments: 3 }]);
    expect(yearSeries([])).toEqual([]);
    const pts = sparkPoints([{ judgments: 0 }, { judgments: 4 }], 100, 20).split(" ");
    expect(pts).toHaveLength(2);
    expect(pts[0]).toBe("1.5,18.5");
    expect(pts[1]).toBe("98.5,1.5");
    expect(sparkPoints([{ judgments: 2 }], 100, 20)).toBe("50,1.5");
  });

  it("links only plain section numbers into the reader (never an order/rule reference)", () => {
    for (const s of ["302", "498A", "65B", "10AA"]) expect(linkableSection(s), s).toBe(true);
    for (const s of ["O.39 R.1", "O.7 R.11", "302(1)", "498-A", "498a", "Art. 21", "", "12ABCD"]) expect(linkableSection(s), s).toBe(false);
    expect(linkableSection(null)).toBe(false);
  });

  it("resolves only central section-numbered Acts to statute titles, and recognises an unbuilt citator", () => {
    expect(statuteTitleFor("ipc")).toBe("Indian Penal Code, 1860");
    expect(statuteTitleFor("bns")).toBe("Bharatiya Nyaya Sanhita, 2023");
    expect(statuteTitleFor("constitution")).toBeNull();
    expect(statuteTitleFor("ka-rent")).toBeNull();
    expect(statuteTitleFor("nope")).toBeNull();
    expect(citatorNotBuilt({ sections: [], scannedJudgments: 0, note: "The citator has not been built on this deployment yet." })).toBe(true);
    expect(citatorNotBuilt({ sections: [], scannedJudgments: 120, note: "Counts are judgments…" })).toBe(false);
    expect(citatorNotBuilt({ sections: [{}], scannedJudgments: 0, note: "" })).toBe(false);
  });
});
