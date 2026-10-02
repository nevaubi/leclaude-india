import { describe, expect, it } from "vitest";
import { areaOfPath, expandActAbbreviation, lawTabOfPath, parseSectionQuery, routeLawQuery } from "@/components/corpus/law-intent";
import { creditLabel, placeholderColor, safeLink } from "@/components/corpus/visual-credit";
import { groupKeyActs, KEY_ACT_GROUPS, NEW_CRIMINAL_LAWS } from "@/modules/law/components/law-subjects";
import type { Visual } from "@/modules/media/visuals-types";

const href = (q: string, scope?: Parameters<typeof routeLawQuery>[1], area?: Parameters<typeof routeLawQuery>[2]) => {
  const r = routeLawQuery(q, scope, area);
  return r?.kind === "href" ? r.href : r ? `section:${r.section}@${r.actTitle}|${r.fallback}` : null;
};

describe("law hub search intent", () => {
  it("sends citations, CNRs and party titles to case law", () => {
    expect(href("2023 INSC 1066", "auto", "law")).toBe("/cases?q=2023%20INSC%201066");
    expect(href("2026:KHC-D:1234", "auto", "judges")).toBe("/cases?q=2026%3AKHC-D%3A1234");
    expect(href("(2024) 2 SCC 145", "auto", "courts")).toMatch(/^\/cases\?q=/);
    expect(href("KAHC020100052022", "auto", "law")).toBe("/cases?q=KAHC020100052022");
    expect(href("Union of India v. Rajesh Kumar", "auto", "law")).toMatch(/^\/cases\?q=Union/);
  });

  it("opens a provision of an Act given by section and abbreviation, with a title search as the fallback", () => {
    expect(href("s. 303 BNS")).toBe("section:303@Bharatiya Nyaya Sanhita, 2023|/law?q=Bharatiya%20Nyaya%20Sanhita%2C%202023");
    expect(href("Section 482 of the BNSS")).toMatch(/^section:482@Bharatiya Nagarik Suraksha Sanhita, 2023/);
    expect(href("302 IPC")).toMatch(/^section:302@Indian Penal Code, 1860/);
    expect(href("sec 498a ipc")).toMatch(/^section:498A@Indian Penal Code, 1860/);
    expect(href("s. 9 Arbitration and Conciliation Act, 1996")).toMatch(/^section:9@Arbitration and Conciliation Act, 1996/);
    expect(parseSectionQuery("302 days")).toBeNull();
  });

  it("expands abbreviations exactly and never guesses", () => {
    expect(expandActAbbreviation("Cr.P.C.")).toBe("Code of Criminal Procedure, 1973");
    expect(expandActAbbreviation("NI Act")).toBe("Negotiable Instruments Act, 1881");
    expect(expandActAbbreviation("BNSX")).toBeNull();
    expect(href("IBC")).toBe("/law?q=Insolvency%20and%20Bankruptcy%20Code%2C%202016");
    expect(href("Companies Act, 2013", "auto", "cases")).toBe("/law?q=Companies%20Act%2C%202013");
  });

  it("sends judge names to judges and recorded cities to courts", () => {
    expect(href("Justice B.V. Nagarathna")).toBe("/judges?q=B.V.%20Nagarathna");
    expect(href("Bombay")).toBe("/courts?city=mumbai");
    expect(href("courts in Bangalore")).toBe("/courts?city=bengaluru");
    expect(href("Atlantis", "auto", "courts")).toBe("/courts?city=Atlantis");
  });

  it("keeps ambiguous queries in the current area and honours an explicit scope", () => {
    expect(href("anticipatory bail", "auto", "cases")).toBe("/cases?q=anticipatory%20bail");
    expect(href("anticipatory bail", "auto", "law")).toBe("/law?q=anticipatory%20bail");
    expect(href("anticipatory bail", "provisions")).toBe("/law?mode=sections&q=anticipatory%20bail");
    expect(href("2023 INSC 1066", "judges")).toBe("/judges?q=2023%20INSC%201066");
    expect(href("Mumbai", "cases")).toBe("/cases?q=Mumbai");
    expect(routeLawQuery("   ")).toBeNull();
  });

  it("maps paths to areas", () => {
    expect(areaOfPath("/law/IND_1")).toBe("law");
    expect(areaOfPath("/judges")).toBe("judges");
    expect(areaOfPath("/courts")).toBe("courts");
    expect(areaOfPath("/cases/sc:1")).toBe("cases");
  });

  it("marks the Sources and Practice tools tabs current on their own pages, never Case law", () => {
    expect(lawTabOfPath("/sources")).toBe("sources");
    expect(lawTabOfPath("/sources/od_abc123")).toBe("sources");
    expect(lawTabOfPath("/tools")).toBe("tools");
    expect(lawTabOfPath("/tools/x")).toBe("tools");
    expect(lawTabOfPath("/cases")).toBe("cases");
    expect(lawTabOfPath("/law/IND_1")).toBe("law");
    expect(lawTabOfPath("/sourcesx")).toBe("cases");
    expect(lawTabOfPath(null)).toBe("cases");
    // The hub search on /sources still routes as on Case law.
    expect(areaOfPath("/sources")).toBe("cases");
  });
});

describe("visual credits", () => {
  const photo: Visual = { kind: "court_building", key: "sci", url: "/api/media/abc", width: 10, height: 10, alt: "Supreme Court", credit: { author: "Jane Doe", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg", sourceName: "Wikimedia Commons" }, dominant: "#a0b0c0" };
  it("renders author, licence and source for photographs and the publisher for logos", () => {
    expect(creditLabel(photo)).toBe("Photo: Jane Doe · CC BY-SA 4.0 · Wikimedia Commons");
    expect(creditLabel({ ...photo, credit: { ...photo.credit, author: null } })).toBe("Photo: CC BY-SA 4.0 · Wikimedia Commons");
    expect(creditLabel({ kind: "regulator_logo", credit: { ...photo.credit, author: null, license: "Logo of RBI", sourceName: "Reserve Bank of India" } })).toBe("Logo: Reserve Bank of India");
  });
  it("links only http(s) and accepts only #rrggbb placeholders", () => {
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("https://example.org/x")).toBe("https://example.org/x");
    expect(placeholderColor(photo)).toBe("#a0b0c0");
    expect(placeholderColor({ dominant: "red; background:url(x)" })).toBeUndefined();
  });
});

describe("key Acts by subject", () => {
  it("groups resolved Acts by the curated subject, in group order, without inventing entries", () => {
    const groups = groupKeyActs([
      { wanted: "Companies Act, 2013", hit: { id: "a" } },
      { wanted: "Code of Civil Procedure, 1908", hit: { id: "b" } },
      { wanted: "Insolvency and Bankruptcy Code, 2016", hit: { id: "c" } },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["civil", "corporate"]);
    expect(groups[1].items.map((i) => i.hit.id)).toEqual(["a", "c"]);
  });
  it("lists every curated title once and keeps the new criminal laws with their predecessors", () => {
    const titles = KEY_ACT_GROUPS.flatMap((g) => g.acts.map((a) => a.title));
    expect(new Set(titles).size).toBe(titles.length);
    expect(NEW_CRIMINAL_LAWS.map((l) => [l.short, l.predecessor.short])).toEqual([["BNS", "IPC"], ["BNSS", "CrPC"], ["BSA", "Evidence Act"]]);
  });
});
