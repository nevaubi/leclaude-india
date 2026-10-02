import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import type { Deposition, EDocument, Matter, Person } from "@/lib/types/domain";
import { EDISCOVERY_SEED_IDS } from "@/modules/ediscovery/seed";
import { resolveBatesInMatter, resolveCiteSourceId, resolveWitnessInMatter } from "@/modules/ediscovery/analysis/ai";
import { resolvePersonName } from "@/modules/ediscovery/analysis/graph";
import { matterPeople } from "@/modules/ediscovery/analysis/service";
import { importTranscript } from "@/modules/ediscovery/analysis/transcript-import-server";
import { counselRoster, privilegeLogMarkdown, templatePrivilegeDescription } from "@/modules/ediscovery/privilege";

/**
 * Evidence contract regressions (constitution §23 / §44): unresolved sources stay unresolved, Bates numbers resolve
 * only as whole tokens inside the matter, and names never bind across matters or to the closest candidate.
 */
const X = "m_evidence_test_x";
const VALSARA = MATTERS.valsara;

const person = (id: string, name: string): Person => ({ id, name, role: "custodian" });
const qa = (page: number, line: number, q: string, a: string) => ({ page, line, question: q, answer: a });

beforeAll(() => {
  resetSqlite();
  const d = db();
  const m: Matter = { id: X, slug: X, name: "Park Industries v. Harbor Co.", shortName: "Park v. Harbor", client: "Park Industries", clientSide: "plaintiff", practiceArea: "Commercial", status: "active", openedAt: "2026-05-01", teamIds: [] };
  d.matters.put(m);
  d.people.putMany([person("p_ev_ann_park", "Ann Park"), person("p_ev_tom_park", "Tom Park"), person("p_ev_mary_smith", "Mary Smith")]);
  const doc: EDocument = { id: "ed_ev_x_1", matterId: X, bates: "PKH-0000001", date: "2025-01-02", custodianId: "p_ev_mary_smith", custodianName: "Mary Smith", type: "Email", subject: "Status", from: "Girish Hegde", to: ["Ann Park"], text: "Status update from a namesake.", coding: {} };
  d.edocs.put(doc);
  const dep = (id: string, witnessId: string, witnessName: string, pages: number[]): Deposition => ({ id, matterId: X, witnessId, witnessName, date: "2026-02-01", takenBy: "Counsel", pages: pages[pages.length - 1], transcript: pages.map((p) => qa(p, 1, "Q?", "A.")), status: "transcribed" });
  d.depositions.putMany([dep("dep_ev_ann", "p_ev_ann_park", "Ann Park", [1, 2, 3]), dep("dep_ev_tom", "p_ev_tom_park", "Tom Park", [2, 10, 11])]);
});

describe("source resolution never substitutes evidence", () => {
  it("has no first-document fallback in the analysis module", () => {
    const src = fs.readFileSync(path.resolve("src/modules/ediscovery/analysis/ai.ts"), "utf8");
    expect(src).not.toMatch(/\?\?\s*docs\[0\]/);
    expect(src).not.toMatch(/\?\?\s*\w+\[0\]\?\.id/);
  });

  it("resolves Bates numbers as whole tokens inside the matter only", () => {
    const sundaram = EDISCOVERY_SEED_IDS.valsaraKeyDocs.sundaramReport;
    expect(resolveBatesInMatter(VALSARA, "MFC-0041877")?.id).toBe(sundaram);
    expect(resolveBatesInMatter(VALSARA, "see MFC-0041877 at 3")?.id).toBe(sundaram);
    // A longer number that merely starts with a real Bates is a different (unknown) document.
    expect(resolveBatesInMatter(VALSARA, "MFC-00418770")).toBeNull();
    // Another matter's Bates is not in this matter's record.
    expect(resolveBatesInMatter(VALSARA, "NGL-0000101")).toBeNull();
    expect(resolveBatesInMatter(X, "MFC-0041877")).toBeNull();
    expect(resolveCiteSourceId(VALSARA, { sourceKind: "document", cite: "MFC-9999999" })).toBeUndefined();
    expect(resolveCiteSourceId(X, { sourceKind: "document", cite: "PKH-0000001" })).toBe("ed_ev_x_1");
  });

  it("leaves an ambiguous witness cite unresolved unless the cited page selects one transcript", () => {
    expect(resolveWitnessInMatter(X, "Park 2:1")).toBeNull();
    expect(resolveWitnessInMatter(X, "Park 10:1")?.id).toBe("dep_ev_tom");
    expect(resolveWitnessInMatter(X, "Park 3:1")?.id).toBe("dep_ev_ann");
    expect(resolveWitnessInMatter(X, "Nobody 1:1")).toBeNull();
    // A witness deposed only in another matter is not resolved here.
    expect(resolveWitnessInMatter(X, "Hegde 12:3")).toBeNull();
    expect(resolveCiteSourceId(X, { sourceKind: "deposition", cite: "Park 2:1" })).toBeUndefined();
  });
});

describe("person resolution is matter-scoped and unambiguous", () => {
  it("does not pull a same-named person anchored to another matter into this one", () => {
    const people = matterPeople(X);
    const ids = people.map((p) => p.id);
    expect(ids).toContain("p_ev_mary_smith");
    expect(ids).toContain("p_ev_ann_park");
    // "Girish Hegde" in a header of matter X is not the Valsara custodian of the same name.
    expect(ids).not.toContain(PEOPLE.girishHegde);
    expect(resolvePersonName("Hegde", people)).toBeUndefined();
    expect(resolvePersonName("Girish Hegde", people)).toBeUndefined();
  });

  it("binds exact or unambiguous names only", () => {
    const people = matterPeople(X);
    expect(resolvePersonName("Ann Park", people)?.id).toBe("p_ev_ann_park");
    expect(resolvePersonName("Park", people)).toBeUndefined();
    expect(resolvePersonName("A. Park", people)?.id).toBe("p_ev_ann_park");
    expect(resolvePersonName("Bob Park", people)).toBeUndefined();
    expect(resolvePersonName("Smith", people)?.id).toBe("p_ev_mary_smith");
  });

  it("transcript import ignores a witness id from another matter and cannot replace another matter's deposition", () => {
    const text = "1:1 Q. Did you see the report?\n1:2 A. Yes.\n1:3 Q. When?\n1:4 A. In March.";
    const r = importTranscript({ matterId: X, text, witnessName: "Girish Hegde", witnessId: PEOPLE.girishHegde, sourceKind: "paste" });
    expect(r.deposition.witnessId).not.toBe(PEOPLE.girishHegde);
    const valsaraDep = db().depositions.findOne((x) => x.matterId === VALSARA)!;
    expect(() => importTranscript({ matterId: X, text, witnessName: "Ann Park", depositionId: valsaraDep.id, sourceKind: "paste" })).toThrow(/No deposition/);
    expect(db().depositions.get(valsaraDep.id)!.matterId).toBe(VALSARA);
  });
});

describe("privilege descriptions use the matter's own counsel", () => {
  it("does not give another matter's lawyer a title in this matter", () => {
    const doc: EDocument = { id: "ed_ev_x_priv", matterId: X, bates: "PKH-0000002", date: "2025-01-03", custodianId: "p_ev_mary_smith", custodianName: "Mary Smith", type: "Email", subject: "Question", from: "Mary Smith", to: ["Rohit Kapur"], text: "Can you advise?", coding: { privileged: true, privilegeBasis: "attorney-client" } };
    db().edocs.put(doc);
    expect(counselRoster(X).has("Rohit Kapur")).toBe(false);
    const desc = templatePrivilegeDescription(doc);
    expect(desc).not.toMatch(/General Counsel/);
    expect(desc).toMatch(/^Email from Mary Smith to Rohit Kapur/);
    const md = privilegeLogMarkdown([], "Park v. Harbor");
    expect(md).not.toMatch(/Persons identified as counsel/);
    // The sample matter still resolves its own counsel from its people records.
    expect(counselRoster(VALSARA).get("Rohit Kapur")).toBe("Associate General Counsel");
  });
});
