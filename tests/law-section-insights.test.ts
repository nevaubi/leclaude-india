import { describe, expect, it } from "vitest";
import {
  hasMixedStatus, INDIA_CODE_LEGACY_NOTE, legacyIndiaCodeNote, publisherLabel, sectionStatusBadge, statusBreakdown, statusLabel, statusTone, type LawInstrument,
} from "@/modules/law/shared";
import { criminalCodeOf, sectionCorrespondence } from "@/modules/law/code-correspondence";
import { badYear, citatorNotBuilt, sectionStatsQuery, sparkPoints, statuteTitleFor, yearSeries, EMPTY_SECTION_FILTERS } from "@/modules/law/most-cited";

const inst = (o: Partial<LawInstrument>): Pick<LawInstrument, "title" | "year" | "jurisdiction"> => ({ title: "x", year: null, jurisdiction: "central", ...o });

describe("section status badge", () => {
  it("is green only for a recorded in-force status", () => {
    expect(sectionStatusBadge({ status: "in_force", in_force: true })).toMatchObject({ label: "In force", tone: "ok" });
    expect(sectionStatusBadge({ status: "in_force", in_force: null })).toMatchObject({ tone: "ok" });
    expect(sectionStatusBadge({ status: null, in_force: true })).toMatchObject({ label: "In force", tone: "ok" });
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
    // The badge always explains that section-level repeal is not in the dataset.
    expect(sectionStatusBadge({ status: "in_force", in_force: true }).title).toMatch(/not recorded in the dataset/);
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

describe("instrument status breakdown", () => {
  it("orders the mixture largest first and flags mixed instruments", () => {
    const rows = statusBreakdown({ in_force: 412, repealed: 3, not_recorded: 2, junk: -1 as number });
    expect(rows.map((r) => [r.status, r.count, r.tone])).toEqual([["in_force", 412, "ok"], ["repealed", 3, "off"], ["not_recorded", 2, "unknown"]]);
    expect(rows[2].label).toBe("Status not recorded");
    expect(hasMixedStatus({ in_force: 10 })).toBe(false);
    expect(hasMixedStatus({ in_force: 10, repealed: 1 })).toBe(true);
    expect(statusBreakdown(null)).toEqual([]);
    expect(statusBreakdown(undefined)).toEqual([]);
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
