import { describe, expect, it } from "vitest";
import type { PMNode } from "@/modules/office/word/doc-model";
import { docToPlainText } from "@/modules/office/word/doc-model";
import { canonicalExhibit, compareExhibitMarks, findExhibitMarks, formatExhibitMark, parseExhibitMark, parseExhibitRange, parseWitnessDesignation, resolveExhibit, segmentLabel, type IndiaEDocument } from "@/modules/ediscovery/india";
import { exhibitFieldValue, matchesQuery, parseQuery, type Searchable } from "@/modules/ediscovery/query";
import { isIndianDeposition, parseIndianDeposition } from "@/modules/ediscovery/analysis/india-deposition";
import { detectTranscriptFormat, parseTranscript } from "@/modules/ediscovery/analysis/transcript-import";
import { transcriptText } from "@/modules/ediscovery/analysis/transcript";
import { findCrossReferences } from "@/modules/ediscovery/analysis/cross-references";
import { counselRosterFromPeople, privilegeLogMarkdown } from "@/modules/ediscovery/privilege";
import { caseTitle, caseTypesFor, courtName, courtOptions, criminalCodesFor, formatCaseNumber, parseCaseNumber, resolveCourt, validateCnr } from "@/modules/matters/india";
import { INDIA_WORD_TEMPLATES } from "@/modules/office/word/templates-india";
import { allTemplates } from "@/modules/office/shared/template-registry";
import { buildTemplates, buildUsTemplates, US_ONLY_TEMPLATE_IDS, INDIA_WORKFLOW_TEMPLATE_IDS } from "@/modules/workflows/templates";
import { validateWorkflow } from "@/modules/workflows/graph";
import { resolveText } from "@/modules/workflows/template-expr";
import { chequeDishonourTimeline } from "@/lib/india/limitation";
import { parseExhibit } from "@/lib/india/procedure";

const doc = (id: string, matterId: string, exhibit?: string): Pick<IndiaEDocument, "id" | "matterId" | "india"> => ({ id, matterId, india: exhibit ? { docClass: "exhibit", exhibit } : { docClass: "document" } });

describe("exhibit marks and witness designations", () => {
  it("parses the forms courts write and formats them like the procedure registry", () => {
    expect(parseExhibitMark("Ex.P1")?.canonical).toBe("Ex.P1");
    expect(parseExhibitMark("Ex. P-12")?.canonical).toBe("Ex.P12");
    expect(parseExhibitMark("Exh.D3")?.canonical).toBe("Ex.D3");
    expect(parseExhibitMark("Exhibit P5(a)")?.canonical).toBe("Ex.P5(a)");
    expect(parseExhibitMark("Ex.P5a")?.canonical).toBe("Ex.P5(a)");
    expect(parseExhibitMark("M.O.3")?.canonical).toBe("MO-3");
    expect(parseExhibitMark("Ex.A4")?.canonical).toBe("Ex.A4"); // AP / Telangana civil courts
    expect(parseExhibitMark("Ex.B2")?.side).toBe("B");
    for (const bad of ["P1", "Exhibit", "Ex.Q1", "Ex.P0", "MFC-0041877", ""]) expect(parseExhibitMark(bad), bad).toBeNull();
    // Agrees with the registry for the series it codes.
    for (const m of ["Ex.P1", "Ex.D18", "Ex.C2", "Ex.X1", "MO-4", "Ex.P5(a)"]) expect(parseExhibitMark(m)!.canonical).toBe(parseExhibit(m)!.canonical);
    expect(formatExhibitMark("P", 7)).toBe("Ex.P7");
    expect(formatExhibitMark("MO", 2)).toBe("MO-2");
  });
  it("orders marks by series then number and parses same-series ranges only", () => {
    expect(["Ex.D2", "Ex.P10", "Ex.P2", "Ex.P2(a)", "MO-1"].sort(compareExhibitMarks)).toEqual(["Ex.P2", "Ex.P2(a)", "Ex.P10", "Ex.D2", "MO-1"]);
    expect(parseExhibitRange("Ex.P1 to P25")).toEqual({ side: "P", from: 1, to: 25 });
    expect(parseExhibitRange("Ex.D1–Ex.D18")).toEqual({ side: "D", from: 1, to: 18 });
    expect(parseExhibitRange("Ex.P1 to Ex.D4")).toBeNull();
    expect(findExhibitMarks("Ex.D1 is confronted; see also Ex. P-14 and Ex.P14 and M.O.2")).toEqual(["Ex.D1", "Ex.P14", "MO-2"]);
  });
  it("resolves a mark only to the one document of the same matter that carries it", () => {
    const docs = [doc("a", "m1", "Ex.P1"), doc("b", "m1", "Ex.P12"), doc("c", "m2", "Ex.P1"), doc("d", "m1"), doc("e", "m3", "Ex.D1"), doc("f", "m3", "Ex.D1")];
    expect(resolveExhibit("Ex. P-1", docs, "m1")).toEqual({ status: "resolved", mark: "Ex.P1", docId: "a" });
    expect(resolveExhibit("Ex.P2", docs, "m1")).toEqual({ status: "unresolved", mark: "Ex.P2", reason: "not_marked_in_matter" });
    expect(resolveExhibit("Ex.P12", docs, "m2")).toMatchObject({ status: "unresolved" });
    expect(resolveExhibit("Ex.D1", docs, "m3")).toMatchObject({ status: "unresolved", reason: "marked_twice" });
    expect(resolveExhibit("the plaint", docs, "m1")).toMatchObject({ status: "unresolved", reason: "not_a_mark" });
  });
  it("parses PW / DW / CW (registry) and RW / AW designations", () => {
    expect(parseWitnessDesignation("P.W.1")?.canonical).toBe("PW-1");
    expect(parseWitnessDesignation("DW 2")?.canonical).toBe("DW-2");
    expect(parseWitnessDesignation("RW-1")?.canonical).toBe("RW-1");
    expect(parseWitnessDesignation("PW-0")).toBeNull();
    expect(segmentLabel("re_examination")).toBe("Re-examination");
  });
});

describe("review search with exhibit marks", () => {
  const proj = (id: string, exhibit?: string): Searchable => ({ id, bates: `NCW-000${id}`, date: "2023-01-01", custodian: "", type: "email", from: "", to: "", cc: "", subject: "", haystack: `ex.p1 ex.p12 ${id}`, issues: "", tags: "", hash: "", ...(exhibit ? { exhibit: exhibit.toLowerCase() } : {}) });
  const rows = [proj("1", "Ex.P1"), proj("2", "Ex.P12"), proj("3", "Ex.P5(a)"), proj("4")];
  const run = (q: string) => rows.filter((r) => matchesQuery(r, parseQuery(q).ast)).map((r) => r.id);
  it("matches exact marks, never a prefix", () => {
    expect(run("Ex.P1")).toEqual(["1"]);
    expect(run("exhibit:P12")).toEqual(["2"]);
    expect(run("ex:\"Ex. P-5(a)\"")).toEqual(["3"]);
    expect(run('exhibit:"Ex.P1 to P12"')).toEqual(["1", "2"]);
    expect(run("-Ex.P1")).toEqual(["2", "3", "4"]);
    expect(exhibitFieldValue("Ex.P1 to P25")).toBe("ex.p1..ex.p25");
    expect(parseQuery("exhibit:Q9").warnings).toEqual(['Unrecognised exhibit mark "Q9"']);
  });
});

const SHEET = `IN THE COURT OF THE COMMERCIAL COURT AT BENGALURU
O.S. No. 12 of 2024
DEPOSITION OF PW-1
Name of the witness: Asha Rao
Date: 03.02.2025
EXAMINATION-IN-CHIEF (Affidavit in lieu of examination-in-chief under Order XVIII Rule 4 CPC, taken as read)
1. I am the plaintiff.
2. The defendant signed the receipt at Ex.P2 on 05.05.2023.
Ex.P1 to Ex.P3 are marked.
Page 2
CROSS-EXAMINATION BY SRI M. KUMAR, ADVOCATE FOR THE DEFENDANT
Q: Did you see him sign Ex.P2?
A: Yes.
It is true that I was not present when Ex.P3 was prepared.
Witness volunteers that her manager prepared it.
Page 3
It is false to suggest that Ex.P2 is fabricated.
FURTHER CROSS-EXAMINATION BY SRI M. KUMAR, ADVOCATE FOR THE DEFENDANT (10.02.2025)
Q: Is the signature on Ex.P2 the defendant's?
A: I think so, but I am not certain.
RE-EXAMINATION: Nil.
`;

describe("Indian deposition parser", () => {
  it("detects the format and anchors chief paragraphs and cross-examination rows exactly", () => {
    expect(isIndianDeposition(SHEET)).toBe(true);
    expect(detectTranscriptFormat("Q. Did you?\nA. Yes.")).not.toBe("indian");
    const p = parseTranscript(SHEET);
    expect(p.format).toBe("indian");
    const t = parseIndianDeposition(SHEET).transcript;
    expect(t.map((r) => [r.segment, r.page, r.line, r.para ?? null])).toEqual([
      ["chief", 1, 7, 1], ["chief", 1, 8, 2],
      ["cross", 2, 2, null], ["cross", 2, 4, null], ["cross", 2, 5, null],
      ["cross", 3, 1, null], ["cross", 3, 3, null],
    ]);
    expect(t[1].exhibit).toBe("Ex.P2");
    expect(t[2]).toMatchObject({ question: "Did you see him sign Ex.P2?", answer: "Yes.", by: "Sri M. Kumar, Advocate for the Defendant" });
    expect(t[3]).toMatchObject({ narrative: true, answer: "It is true that I was not present when Ex.P3 was prepared." });
    // Early answer and later qualification both survive, in order.
    expect(t[2].answer).toBe("Yes.");
    expect(t[6].answer).toBe("I think so, but I am not certain.");
    expect(p.exhibits.map((e) => e.id)).toEqual(["Ex.P1", "Ex.P2", "Ex.P3"]);
    expect(p.meta).toMatchObject({ witnessName: "Asha Rao (PW-1)", date: "2025-02-03" });
    const text = transcriptText({ witnessName: "Asha Rao", transcript: t });
    expect(text).toContain("1:07 [Chief ¶1]");
    expect(text).toContain("2:02 [Cross]");
  });
  it("finds exhibit references in testimony by exact mark and leaves unmarked ones unresolved", () => {
    const t = parseIndianDeposition(SHEET).transcript;
    const refs = findCrossReferences({ transcript: t, exhibits: [] }, [{ id: "d2", bates: "NCW-0002", subject: "Receipt", date: "2023-05-05", exhibit: "Ex.P2" }, { id: "d12", bates: "NCW-0012", subject: "Other", date: "2023-01-01", exhibit: "Ex.P12" }]).filter((r) => r.kind === "exhibit");
    expect(refs.filter((r) => r.docId).every((r) => r.docId === "d2")).toBe(true);
    expect(refs.some((r) => r.match === "Ex.P3" && !r.docId && r.confidence === 0.5)).toBe(true);
  });
});

describe("privilege under Indian law", () => {
  it("recognises advocates as counsel and uses BSA / IEA wording in the log", () => {
    const roster = counselRosterFromPeople([{ id: "1", name: "Kavya Hegde", title: "Advocate for the plaintiff", role: "other" }, { id: "2", name: "Nisha Menon", title: "CFO", role: "client" }]);
    expect(roster.has("Kavya Hegde")).toBe(true);
    expect(roster.has("Nisha Menon")).toBe(false);
    const md = privilegeLogMarkdown([], "Demo");
    expect(md).toContain("Bharatiya Sakshya Adhiniyam, 2023");
    expect(md).toContain("merely copied");
    expect(md).not.toContain("Fed. R. Civ. P.");
  });
});

describe("matter case particulars", () => {
  it("resolves courts from the registry and focus-city forums, never guessing", () => {
    expect(resolveCourt("hc-karnataka")?.kind).toBe("court");
    expect(resolveCourt("ka-blr-commercial")?.kind).toBe("forum");
    expect(resolveCourt("hc-karnatak")).toBeNull();
    expect(courtName("hc-telangana")).toBe("High Court for the State of Telangana");
    const groups = courtOptions();
    expect(groups[0].group).toBe("Karnataka");
    expect(groups[0].options[0].id).toBe("hc-karnataka");
    expect(groups.find((g) => g.group === "Telangana")!.options.map((o) => o.id)).toContain("ts-hyd-sessions");
  });
  it("offers the case types each court uses and formats / parses case numbers", () => {
    expect(caseTypesFor("hc-karnataka").map((t) => t.code)).toEqual(expect.arrayContaining(["W.P.", "Crl.P.", "R.F.A.", "R.S.A."]));
    expect(caseTypesFor("hc-telangana").map((t) => t.code)).toEqual(expect.arrayContaining(["W.P.", "Crl.P.", "S.A."]));
    expect(caseTypesFor("ka-blr-commercial")[0].code).toBe("Com.O.S.");
    expect(caseTypesFor("ka-blr-acmm").map((t) => t.code)).toContain("C.C.");
    expect(formatCaseNumber("O.S.", "4521", 2022)).toBe("O.S. No. 4521 of 2022");
    expect(formatCaseNumber("Com.O.S.", "1187", 2023)).toBe("Com.O.S. No. 1187 of 2023");
    expect(parseCaseNumber("W.P. No.18234/2024")).toMatchObject({ type: "W.P.", number: "18234", year: 2024 });
    expect(parseCaseNumber("Crl.P. 7710 of 2024")).toMatchObject({ type: "Crl.P.", number: "7710", year: 2024 });
    expect(parseCaseNumber("Com.O.S. No. 1187 of 2023")).toMatchObject({ type: "Com.O.S.", number: "1187", year: 2023 });
    expect(caseTitle({ courtId: "hc-telangana", caseType: "W.P.", caseNumber: "18234", caseYear: 2024 })).toBe("W.P. No. 18234 of 2024 · High Court for the State of Telangana");
  });
  it("validates CNRs and reports a prefix that does not match the court", () => {
    expect(validateCnr("KAHC010123452024", "hc-karnataka")).toMatchObject({ ok: true, cnr: "KAHC010123452024", year: 2024 });
    expect(validateCnr("kahc-0101-2345-2024", "hc-karnataka")).toMatchObject({ ok: true });
    expect(validateCnr("HBHC010123452024", "hc-karnataka")).toMatchObject({ ok: true, warning: expect.stringContaining("does not match") });
    expect(validateCnr("KAHC01012345", "hc-karnataka")).toMatchObject({ ok: false });
    expect(validateCnr("KAHC010123451899")).toMatchObject({ ok: false });
  });
  it("decides the substantive criminal code by the offence date (1 July 2024)", () => {
    expect(criminalCodesFor("2024-06-30")).toEqual({ substantive: "IPC" });
    expect(criminalCodesFor("2024-07-01")).toEqual({ substantive: "BNS" });
    expect(criminalCodesFor("2024-06-30", "2024-08-01")).toEqual({ substantive: "IPC", procedure: "BNSS" });
    expect(criminalCodesFor("12.08.2026")).toBeNull();
  });
});

describe("Indian drafting templates", () => {
  const text = (id: string) => docToPlainText(INDIA_WORD_TEMPLATES.find((t) => t.id === id)!.build({}) as PMNode);
  it("ships the twelve templates first in the gallery, each with a cause title and no US procedure", () => {
    expect(INDIA_WORD_TEMPLATES).toHaveLength(12);
    expect(allTemplates().slice(0, 12).map((t) => t.id)).toEqual(INDIA_WORD_TEMPLATES.map((t) => t.id));
    for (const t of INDIA_WORD_TEMPLATES) {
      const s = text(t.id);
      expect(s.length, t.id).toBeGreaterThan(400);
      expect(s, t.id).not.toMatch(/Fed\. R\. Civ\.|FRCP|U\.S\.C\.|\$\[/);
    }
  });
  it("uses the court formats of Bengaluru and Hyderabad", () => {
    expect(text("word-in-plaint")).toContain("ADDITIONAL CITY CIVIL AND SESSIONS JUDGE AT BENGALURU");
    expect(text("word-in-plaint")).toContain("PLAINT UNDER ORDER VII RULE 1");
    expect(text("word-in-written-statement")).toContain("ORDER VIII RULE 1");
    expect(text("word-in-ia-injunction")).toContain("ORDER XXXIX RULES 1 AND 2");
    const kar = text("word-in-writ-karnataka");
    expect(kar).toContain("IN THE HIGH COURT OF KARNATAKA AT BENGALURU");
    expect(kar).toContain("ARTICLES 226 AND 227");
    const ts = text("word-in-writ-telangana");
    expect(ts).toContain("IN THE HIGH COURT FOR THE STATE OF TELANGANA AT HYDERABAD");
    expect(ts).toContain("(SPECIAL ORIGINAL JURISDICTION)");
    expect(ts).toContain("Writ of Mandamus");
    expect(text("word-in-regular-bail")).toContain("SECTION 483 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023");
    expect(text("word-in-anticipatory-bail")).toContain("SECTION 482 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023");
    expect(text("word-in-ni138")).toContain("SECTION 138(b) OF THE NEGOTIABLE INSTRUMENTS ACT, 1881");
    expect(text("word-in-notice-s80")).toContain("SECTION 80 OF THE CODE OF CIVIL PROCEDURE, 1908");
    expect(text("word-in-vakalatnama")).toContain("VAKALATNAMA");
    expect(text("word-in-affidavit")).toContain("VERIFICATION");
    expect(text("word-in-memo-appearance")).toContain("MEMO OF APPEARANCE");
  });
  it("marks uncertain formats and every authority [VERIFY], formatted by the citation engine", () => {
    const bail = text("word-in-regular-bail");
    expect(bail).toContain("Satender Kumar Antil v. Central Bureau of Investigation, (2022) 10 SCC 51 [VERIFY]");
    const verifyCount = INDIA_WORD_TEMPLATES.reduce((n, t) => n + (text(t.id).match(/\[VERIFY/g) ?? []).length, 0);
    expect(verifyCount).toBeGreaterThanOrEqual(20);
  });
});

describe("Indian workflow gallery", () => {
  it("defaults to the Indian templates and keeps the US ones compiling out of the gallery", () => {
    const gallery = buildTemplates();
    for (const id of Object.values(INDIA_WORKFLOW_TEMPLATE_IDS)) expect(gallery.some((t) => t.id === id), id).toBe(true);
    for (const id of US_ONLY_TEMPLATE_IDS) expect(gallery.some((t) => t.id === id), id).toBe(false);
    const us = buildUsTemplates();
    expect(us.map((t) => t.id).sort()).toEqual([...US_ONLY_TEMPLATE_IDS].sort());
    for (const t of [...gallery, ...us]) {
      const v = validateWorkflow(t.nodes, t.edges);
      expect(v.ok, `${t.id}: ${v.issues.map((i) => i.message).join("; ")}`).toBe(true);
    }
    const gallText = JSON.stringify(gallery);
    expect(gallText).not.toMatch(/PACER|FRCP|Rule 26\(a\)|Federal Register/);
  });
  it("counts the s.138 notice deadline in code, matching the limitation engine", () => {
    const cheque = buildTemplates().find((t) => t.id === INDIA_WORKFLOW_TEMPLATE_IDS.chequePack)!;
    const node = cheque.nodes.find((n) => n.type === "action.create_event")!;
    const startsAt = resolveText(String(node.config.startsAt), { inputs: { info_date: "2026-03-14" } });
    expect(startsAt.slice(0, 10)).toBe(chequeDishonourTimeline({ dishonourInformationOn: "2026-03-14" }).noticeDeadline);
  });
});

describe("canonical marks round-trip", () => {
  it("canonicalExhibit is idempotent", () => {
    for (const m of ["Ex.P1", "Ex. D-7", "Exhibit C2", "M.O.9", "Ex.A3"]) { const c = canonicalExhibit(m)!; expect(canonicalExhibit(c)).toBe(c); }
  });
});
