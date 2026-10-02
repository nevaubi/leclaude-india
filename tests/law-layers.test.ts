import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Principal } from "@/lib/auth/types";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { concordanceTable, concordanceTables, rowsForNew, rowsForOld, validateTable } from "@/lib/india/concordance";
import { BLOCKING_FLAGS, decodeEntities, joinBrokenRows, parseConcordanceMarkdown, parseSectionCell } from "@/lib/india/concordance/parse";
import { TRANSITION_RULES, transitionRuleFor } from "@/lib/india/concordance/transition";
import { CORRESPONDENCE, mapSection } from "@/lib/india/criminal-code-map";
import { extractStatutes } from "@/lib/india/statutes";
import { citatorActFor, linkableSectionKey } from "@/modules/law/interpreting";
import { sideBySide, subsectionAnchor, verificationLabel } from "@/modules/law/side-by-side";
import { NO_SECTION } from "@/modules/law/shared";
import { amendmentLabel, parseSectionFootnotes, wefDate } from "@/modules/india/law/amendments";
import { chooseExactAct, handleFromUrl, officialSectionRow } from "@/modules/india/law/official-sections";
import type { DspaceItem } from "@/modules/india/sources/india-code";
import { canonicalInsc, caseNumberKey, decideScrLink, parseScrCitation, scrFromSciCard, scrYearOrder } from "@/modules/india/scr/link";
import { linkScrBatch, storeScrRecords } from "@/modules/india/scr/load";
import { extractMetaSectionRefs } from "@/modules/india/statute-links/extract";
import { COMMISSION_PAGES, def as lciDef, adapter as lciAdapter, parseLawCommissionReports } from "@/modules/official/adapters/reference/lawcommission";
import { handleLawLinksCron, handleLawLinksPost, parseLawLinksBody } from "@/app/api/india/law-links/run/handler";
import { sourceDef } from "@/modules/official/registry";
import ccaFixture from "./fixtures/law/indiacode-cca-sections.json";
import sci1995 from "./fixtures/india-sci/1995_1_1010_1191.json";
import sci2024a from "./fixtures/india-sci/2024_10_108_125.json";
import sci2024b from "./fixtures/india-sci/2024_10_1313_1343.json";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------------------------------------------------
// Official concordance data
// ---------------------------------------------------------------------------------------------------------------------

describe("official concordance: data, provenance and loader", () => {
  it("every table names the government document it was parsed from, and the data matches its committed input", () => {
    for (const t of concordanceTables()) {
      expect(t.source.url).toMatch(/^https:\/\/bprd\.nic\.in\/uploads\/pdf\//);
      expect(t.source.listedAt).toBe("https://bprd.nic.in/page/documents_by_bprd");
      expect(t.source.publisher).toMatch(/Bureau of Police Research & Development/);
      expect(t.source.extraction).toMatch(/not the Gazette/);
      expect(t.source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const md = read(`scripts/law-concordance/sources/${t.id}.md`);
      // The data was generated from exactly this input (regenerate with scripts/law-concordance/build.ts after a change).
      expect(t.source.inputSha256).toBe(createHash("sha256").update(md).digest("hex"));
      expect(t.counts.rows).toBe(t.rows.length);
      expect(t.rows.length).toBeGreaterThan(150);
    }
  });

  it("never invents a row: every new and old cell appears verbatim in the extracted document, on a real page", () => {
    for (const t of concordanceTables()) {
      const md = decodeEntities(joinBrokenRows(read(`scripts/law-concordance/sources/${t.id}.md`).split(/\r?\n/)).join("\n"));
      for (const r of t.rows) {
        expect(md.includes(r.newRaw), `${r.id} new cell`).toBe(true);
        if (r.relation !== "unparsed") expect(md.includes(r.oldRaw), `${r.id} old cell`).toBe(true);
        expect(r.page).toBeGreaterThanOrEqual(1);
        expect(r.page).toBeLessThanOrEqual(t.source.pages);
      }
    }
  });

  it("blocking flags always mean requires_review; requires_review rows are never mapping candidates", () => {
    for (const t of concordanceTables()) for (const r of t.rows) expect(r.verification === "requires_review").toBe(r.flags.some((f) => BLOCKING_FLAGS.includes(f)));
    // BNSS rows misread as 344…354 (sequence breaks after 433) are flagged, shown, and not used.
    const l = rowsForOld("CrPC", "401");
    expect(l.rows).toEqual([]);
    expect(l.blocked.length).toBeGreaterThan(0);
    expect(l.blocked[0].flags).toContain("out_of_sequence");
    const r = mapSection("CrPC", "401");
    expect(r.verification).toBe("coded_unconfirmed");
    expect(r.candidates.map((c) => c.section)).toEqual(["442"]);
    expect(r.confidence).toBe("medium");
    expect(r.notes.join(" ")).toMatch(/could not be read reliably/);
  });

  it("the validator rejects malformed data instead of mapping from it", () => {
    const good = concordanceTable("iea-bsa");
    expect(() => validateTable("iea-bsa", { ...good, rows: [...good.rows, good.rows[0]] })).toThrow(/duplicate/);
    expect(() => validateTable("iea-bsa", { ...good, source: { ...good.source, url: "" } })).toThrow(/malformed/);
    expect(() => validateTable("ipc-bns", good)).toThrow(/malformed/);
  });

  it("parses the publisher's table: header, page breaks, continuation rows, broken rows, ranges, siblings, provisos", () => {
    const md = read("tests/fixtures/law/bprd-ipc-bns-excerpt.md");
    const { rows, summaries } = parseConcordanceMarkdown("ipc-bns", md);
    expect(rows[0]).toMatchObject({ id: "ipc-bns:1", newRaw: "1(1)", oldSections: [{ section: "1" }], relation: "corresponds", page: 1, verification: "official_parsed" });
    expect(rows.find((r) => r.newRaw === "1(2)")).toMatchObject({ relation: "new", oldSections: [] });
    expect(rows.find((r) => r.newRaw === "2")).toMatchObject({ relation: "not_stated" });
    // The summary of 2(1) continues on page 2 in a row with empty leading cells: appended, not a new row.
    const r21 = rows.find((r) => r.newRaw === "2(1)")!;
    expect(summaries[r21.id]).toMatch(/separately defined in sub-sections 2\(1\) and 2\(25\)/);
    expect(rows.filter((r) => r.newRaw === "").length).toBe(0);
    // Noise in the summary text only is informational; the row stays usable.
    expect(r21.flags).toContain("text_noise");
    expect(r21.verification).toBe("official_parsed");
    // A cell printed over two lines ("23" / "Clause-1") is joined and read as section 23, clause 1.
    expect(rows.find((r) => r.newRaw === "2(36)")).toMatchObject({ oldSections: [{ section: "23", part: "clause 1" }], verification: "official_parsed" });
    expect(rows.some((r) => r.page === 2)).toBe(true);
    expect(parseSectionCell("230 to 232, 246 to 249, 255, 489A")).toMatchObject({ rangeExpanded: true, residue: "" });
    expect(parseSectionCell("230 to 232, 489A").sections.map((s) => s.section)).toEqual(["230", "231", "232", "489A"]);
    expect(parseSectionCell("351(2)/(3)").sections.map((s) => s.section)).toEqual(["351(2)", "351(3)"]);
    expect(parseSectionCell("228A (1)/(2)").sections.map((s) => s.section)).toEqual(["228A(1)", "228A(2)"]);
    expect(parseSectionCell("First proviso to section 22").sections).toEqual([{ section: "22", part: "first proviso" }]);
    expect(parseSectionCell("2(c )").sections).toEqual([{ section: "2(c)" }]);
    expect(parseSectionCell("171-I").sections).toEqual([{ section: "171I" }]);
    expect(parseSectionCell("498A Explanation").sections).toEqual([{ section: "498A", part: "explanation" }]);
    expect(parseSectionCell("IEA 3 Interpretation clause", { stripPrefix: /^IEA\s+/ }).residue).toBe("Interpretation clause");
  });
});

describe("criminal-code-map backed by the official data (API unchanged)", () => {
  it("coded rows carry their source and verification; none conflicts with the official table", () => {
    for (const r of CORRESPONDENCE) {
      expect(r.source).toMatch(/Hand-coded/);
      expect(["official_cross_checked", "coded_unconfirmed", "conflicts_official"]).toContain(r.verification);
    }
    expect(CORRESPONDENCE.filter((r) => r.verification === "conflicts_official")).toEqual([]);
    expect(CORRESPONDENCE.filter((r) => r.verification === "official_cross_checked").length).toBeGreaterThan(100);
  });

  it("answers for sections only the official table covers, marked as machine-read and medium confidence", () => {
    const r = mapSection("IPC", "300");
    expect(r.status).toBe("mapped");
    expect(r.candidates.map((c) => `${c.code} ${c.section}`)).toEqual(["BNS 101"]);
    expect(r).toMatchObject({ verification: "official_parsed", confidence: "medium" });
    expect(r.official?.[0]).toMatchObject({ newRaw: "101", oldRaw: "300" });
    expect(r.officialSource?.url).toMatch(/bprd\.nic\.in/);
  });

  it("cross-checked answers keep the coded sub-section detail and say so; partial mappings are flagged", () => {
    expect(mapSection("IPC", "302")).toMatchObject({ verification: "official_cross_checked", confidence: "high", partial: false });
    const p = mapSection("CrPC", "156(3)");
    expect(p.candidates.map((c) => c.section)).toEqual(["175(3)"]);
    expect(p.verification).toBe("official_cross_checked");
    const e = mapSection("IEA", "4");
    expect(e.partial).toBe(true); // IEA 4 is split by paragraph into BSA 2(1)(b), (h) and (l)
    expect(e.candidates.map((c) => c.section).sort()).toEqual(["2(1)(b)", "2(1)(h)", "2(1)(l)"]);
    expect(e.candidates.every((c) => /para/.test(c.note ?? ""))).toBe(true);
  });

  it("a provision the official table marks as new is unmapped with that reason, never approximated", () => {
    const r = mapSection("BNS", "103(2)");
    expect(r).toMatchObject({ status: "unmapped", candidates: [], newProvision: true });
    expect(r.notes.join(" ")).toMatch(/new provision with no IPC counterpart/);
    expect(mapSection("BNSS", "86")).toMatchObject({ status: "unmapped", newProvision: true });
    expect(rowsForNew("BSA", "61").rows[0]).toMatchObject({ relation: "new" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Side-by-side view data
// ---------------------------------------------------------------------------------------------------------------------

const central = (title: string, year: number) => ({ title, year, jurisdiction: "central" });

describe("side-by-side old | new code view", () => {
  it("IPC 302 opposite BNS 103(1), with the reader anchor, the official row and the substantive transition rule", () => {
    const m = sideBySide(central("Indian Penal Code, 1860", 1860), "302")!;
    expect(m.old).toMatchObject({ code: "IPC", provisions: [{ label: "IPC s.302", current: true }] });
    expect(m.next.provisions).toEqual([expect.objectContaining({ code: "BNS", section: "103(1)", readerSection: "103", anchor: "ss-1", current: false })]);
    expect(m.verification).toBe("official_cross_checked");
    expect(verificationLabel(m.verification)).toBe("Official table, cross-checked");
    expect(m.official.map((o) => o.oldRaw)).toEqual(["302"]);
    expect(m.transition?.id).toBe("substantive");
    expect(m.transition?.basis.map((b) => b.label)).toContain("BNS s.358 (repeal and savings)");
    expect(m.headline).toBe("IPC s.302 ↔ BNS s.103(1).");
  });

  it("from the new code, the old code stays on the left; splits list every provision", () => {
    const m = sideBySide(central("Bharatiya Nyaya Sanhita, 2023", 2023), "318")!;
    expect(m.old.code).toBe("IPC");
    expect(m.old.provisions.map((p) => p.section)).toEqual(["415", "417", "418", "420"]);
    expect(m.next.provisions).toEqual([expect.objectContaining({ code: "BNS", section: "318", current: true })]);
    expect(m.status).toBe("split");
  });

  it("new provisions, procedure and evidence codes carry the right transition rule; other instruments get nothing", () => {
    expect(sideBySide(central("Bharatiya Nyaya Sanhita, 2023", 2023), "103(2)")).toMatchObject({ newProvision: true, old: { provisions: [] } });
    expect(sideBySide(central("Code of Criminal Procedure, 1973", 1973), "438")?.transition?.basis[0]).toMatchObject({ code: "BNSS", provision: "531", part: "(2)(a)" });
    expect(sideBySide(central("Indian Evidence Act, 1872", 1872), "65B")?.transition?.id).toBe("evidence");
    expect(sideBySide(central("Indian Penal Code, 1860", 1860), NO_SECTION)).toBeNull();
    expect(sideBySide(central("Indian Penal Code (Amendment) Act, 1860", 1860), "302")).toBeNull();
    expect(sideBySide({ title: "Indian Penal Code, 1860", year: 1860, jurisdiction: "state" }, "302")).toBeNull();
    expect(transitionRuleFor("CPC")).toBeNull();
    for (const r of TRANSITION_RULES) expect(r.on).toBe("2024-07-01");
    expect(subsectionAnchor("2(1)(a)")).toBe("ss-1");
    expect(subsectionAnchor("498A")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Supreme Court Reports: exact linking
// ---------------------------------------------------------------------------------------------------------------------

describe("SCR register: parsing and exact linking", () => {
  it("parses SCR citations, including supplementary volumes; rejects anything else", () => {
    expect(parseScrCitation("[2024] 10 S.C.R. 108")).toMatchObject({ year: 2024, volume: 10, page: 108, supplement: false, canonical: "[2024] 10 SCR 108" });
    expect(parseScrCitation("[1995] Supp. (1) SCR 10")).toMatchObject({ supplement: true, volume: 1, canonical: "[1995] Supp. 1 SCR 10" });
    expect(parseScrCitation("[1950] SCR 1")).toMatchObject({ volume: null, canonical: "[1950] SCR 1" });
    expect(parseScrCitation("(2024) 10 SCC 108")).toBeNull();
    expect(parseScrCitation("2024 INSC 735")).toBeNull();
    expect(canonicalInsc("2024INSC0735")).toBe("2024 INSC 735");
    expect(caseNumberKey("Civil Appeal No. 1234 of 2019")).toBe("CIVILAPPEALNO1234OF2019");
  });

  it("reads the official SCR card: SCR + INSC citations, case number, date and the full headnote", () => {
    const r = scrFromSciCard(sci2024a as never, { key: "metadata/json/year=2024/2024_10_108_125.json", sha256: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record).toMatchObject({ id: "[2024] 10 SCR 108", neutral: "2024 INSC 735", origin: "sci-open-data" });
    expect(r.record.headnote).toMatch(/Issue for Consideration/);
    expect(r.record.decisionDate).toMatch(/^2024-/);
    const old = scrFromSciCard(sci1995 as never, { key: "k", sha256: "y" });
    expect(old.ok && old.record.id).toBe("[1995] 1 SCR 1010");
    expect(scrFromSciCard({ path: "x", raw_html: "<div></div>" }, { key: "k", sha256: "z" })).toEqual({ ok: false, reason: "no SCR citation on the card" });
  });

  it("links only by exact identifiers: unique neutral citation, else unique case number + date; otherwise says why", () => {
    const rec = { neutral: "2024 INSC 735", caseNumber: "Criminal Appeal No. 1 of 2020", decisionDate: "2024-10-01" };
    expect(decideScrLink(rec, { byNeutral: ["sc:a"], byCaseAndDate: ["sc:b"] })).toEqual({ status: "linked", judgmentId: "sc:a", method: "neutral_citation" });
    expect(decideScrLink(rec, { byNeutral: ["sc:a", "sc:c"], byCaseAndDate: [] })).toMatchObject({ status: "ambiguous", candidates: ["sc:a", "sc:c"] });
    expect(decideScrLink(rec, { byNeutral: [], byCaseAndDate: ["sc:b"] })).toEqual({ status: "linked", judgmentId: "sc:b", method: "case_number_date" });
    expect(decideScrLink(rec, { byNeutral: [], byCaseAndDate: ["sc:b", "sc:d"] })).toMatchObject({ status: "ambiguous", method: "case_number_date" });
    const none = decideScrLink({ ...rec, caseNumber: null }, { byNeutral: [], byCaseAndDate: [] });
    expect(none.status).toBe("unlinked");
    expect(none.status === "unlinked" && none.reason).toMatch(/neutral citation 2024 INSC 735; no usable case number/);
    // No date → the case number alone never links, even with a candidate.
    expect(decideScrLink({ neutral: null, caseNumber: "C.A. 1/2020", decisionDate: null }, { byNeutral: [], byCaseAndDate: ["sc:x"] }).status).toBe("unlinked");
  });

  it("queries the corpus with exact keys and stores each decision with its reason", async () => {
    const cards = [sci2024a, sci2024b, sci1995].map((j, k) => scrFromSciCard(j as never, { key: `k${k}`, sha256: `s${k}` })).map((r) => (r.ok ? r.record : null)).filter((x) => x !== null);
    const queries: SqlQuery[] = [];
    const store: RemoteStore = {
      async query(q) {
        queries.push(q);
        if (/neutral_citation = ANY/.test(q.query)) return [{ id: "sc:2024_10_108_125", neutral_citation: "2024 INSC 735" }, { id: "sc:dup1", neutral_citation: "2024 INSC 755" }, { id: "sc:dup2", neutral_citation: "2024 INSC 755" }] as Row[];
        if (/case_number IS NOT NULL/.test(q.query)) return [] as Row[];
        return [] as Row[];
      },
      async transaction(qs) { return Promise.all(qs.map((q) => this.query(q))); },
    };
    const links = await linkScrBatch(store, cards);
    expect(links.get("[2024] 10 SCR 108")).toEqual({ status: "linked", judgmentId: "sc:2024_10_108_125", method: "neutral_citation" });
    expect(links.get("[2024] 10 SCR 1313")).toMatchObject({ status: "ambiguous" });
    expect(links.get("[1995] 1 SCR 1010")).toMatchObject({ status: "unlinked" });
    expect(String(queries[0].params?.[0])).toContain("2024 INSC 735");
    queries.length = 0;
    const counts = await storeScrRecords(store, cards);
    expect(counts).toEqual({ linked: 1, ambiguous: 1, unlinked: 1 });
    const upsert = queries.find((q) => /INSERT INTO scr_reports/.test(q.query))!;
    const rows = JSON.parse(String(upsert.params![0])) as { id: string; judgment_id: string | null; link_reason: string | null }[];
    expect(rows.find((r) => r.id === "[2024] 10 SCR 1313")).toMatchObject({ judgment_id: null });
    expect(rows.find((r) => r.id === "[1995] 1 SCR 1010")?.link_reason).toMatch(/No corpus Supreme Court judgment matches/);
  });

  it("processes the last ten years first, then older years", () => {
    expect(scrYearOrder([1950, 2026, 2015, 2017, 2024, 2016, 1995, 2024], 2026)).toEqual([2026, 2024, 2017, 2016, 2015, 1995, 1950]);
    expect(scrYearOrder([2027, 2026], 2026)).toEqual([2026, 2027]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Section references (Act disambiguation) and judgment links
// ---------------------------------------------------------------------------------------------------------------------

describe("section-reference extraction and judgment links", () => {
  it("disambiguates the Act: section 302 IPC and s.302 CrPC are different provisions", () => {
    const refs = extractStatutes("The accused was charged under section 302 IPC; the court relied on s.302 CrPC to permit the prosecution.");
    expect(refs.map((r) => [r.actId, r.sections])).toEqual([["ipc", ["302"]], ["crpc", ["302"]]]);
    const meta = extractMetaSectionRefs("Penal Code, 1860 – ss.302, 34 – Murder. Code of Criminal Procedure, 1973 – s.313 – statement of accused.");
    expect(meta.map((r) => `${r.actId}:${r.section}`)).toEqual(["ipc:302", "ipc:34", "crpc:313"]);
  });

  it("reads the act-first headnote forms of the official card; ambiguous or mismatched Acts yield no link", () => {
    expect(extractMetaSectionRefs("Constitution of India : Articles 129 and 142-Contempt of Court").map((r) => `${r.actId}:${r.section}`)).toEqual(["constitution:129", "constitution:142"]);
    expect(extractMetaSectionRefs("Companies Act – s.241 – oppression")).toEqual([]);
    expect(extractMetaSectionRefs("Constitution of India – s.21")).toEqual([]);
    expect(extractMetaSectionRefs(null)).toEqual([]);
    const head = scrFromSciCard(sci2024a as never, { key: "k", sha256: "s" });
    const refs = extractMetaSectionRefs(head.ok ? head.record.headnote : "");
    expect(refs.map((r) => `${r.actId}:${r.section}`)).toEqual(["ipc:302", "ipc:34", "ipc:364"]);
  });

  it("maps statutes-collection instruments to the citator's Act by exact title only", () => {
    expect(citatorActFor(central("Indian Penal Code, 1860", 1860))).toBe("ipc");
    expect(citatorActFor(central("The Code of Criminal Procedure, 1973", 1973))).toBe("crpc");
    expect(citatorActFor(central("Code of Criminal Procedure, 1898", 1898))).toBeNull();
    expect(citatorActFor(central("Companies Act, 2013", 2013))).toBe("companies-2013");
    expect(citatorActFor({ title: "Karnataka Land Revenue Act, 1964", year: 1964, jurisdiction: "state" })).toBeNull();
    expect(linkableSectionKey("498a")).toBe("498A");
    expect(linkableSectionKey("_")).toBeNull();
    expect(linkableSectionKey("O.39 R.1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// India Code: sections and amendment history
// ---------------------------------------------------------------------------------------------------------------------

const ccaItems = (ccaFixture as unknown as { _embedded: { searchResult: { _embedded: { objects: { _embedded: { indexableObject: DspaceItem } }[] } } } })._embedded.searchResult._embedded.objects.map((o) => o._embedded.indexableObject);

describe("India Code section text and amendment history", () => {
  it("parses the section footnotes into amendments, keeping every footnote verbatim", () => {
    const s1 = ccaItems.find((i) => i.metadata["dc.identifier.section_number"]?.[0]?.value === "1")!;
    const a = parseSectionFootnotes(s1.metadata["dc.identifier.section_footnote"]?.[0]?.value);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ marker: 1, action: "substituted", amendingAct: "Act 28 of 2018", amendingActYear: 2018, amendingProvision: "s. 3", withEffectFrom: "2018-05-03", actFromIbid: false });
    expect(a[1]).toMatchObject({ action: "omitted", amendingAct: "Act 34 of 2019", withEffectFrom: "2019-10-31" });
    expect(amendmentLabel(a[0])).toBe("Substituted by Act 28 of 2018, s. 3 (w.e.f. 3 May 2018)");
    const s3 = ccaItems.find((i) => i.metadata["dc.identifier.section_number"]?.[0]?.value === "3")!;
    const b = parseSectionFootnotes(s3.metadata["dc.identifier.section_footnote"]?.[0]?.value);
    expect(b[1]).toMatchObject({ amendingAct: "Act 28 of 2018", actFromIbid: true, amendingProvision: "s. 6" });
    expect(b[1].text).toMatch(/ibid/);
    expect(wefDate("(w.e.f. 31-2-2019)")).toBeNull();
  });

  it("builds stored rows from SECTION items and resolves India Code Acts only exactly", () => {
    const rows = ccaItems.map(officialSectionRow).filter((r) => r !== null);
    expect(rows.map((r) => r.section).sort()).toEqual(["1", "13", "15", "2", "3"]);
    expect(rows.find((r) => r.section === "13")?.amendments).toHaveLength(1);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.sha256))).toBe(true);
    expect(handleFromUrl("https://www.indiacode.nic.in/handle/123456789/20062?view_type=browse")).toBe("123456789/20062");
    expect(handleFromUrl("https://indiacode.gov.in/show-data?actid=1")).toBeNull();
    const act = (title: string, state: string, year: string): DspaceItem => ({ id: title, metadata: { "dc.identifier.collection": [{ value: "ACT" }], "dc.title": [{ value: title }], "dc.identifier.state_name": [{ value: state }], "dc.date.act_year": [{ value: year }] } });
    expect(chooseExactAct("Commercial Courts Act, 2015", 2015, [act("The Commercial Courts Act, 2015", "CENTRAL", "2015"), act("The Commercial Courts Act, 2015", "Chandigarh", "2015")])).toMatchObject({ ok: true, method: "title_year" });
    expect(chooseExactAct("Commercial Courts Act, 2015", 2015, [act("The Commercial Courts (Amendment) Act, 2018", "CENTRAL", "2018")])).toMatchObject({ ok: false });
    expect(chooseExactAct("Arbitration and Conciliation Act, 1996", 1996, [act("The Arbitration and Conciliation Act, 1996", "CENTRAL", "1996"), act("The Arbitration and Conciliation Act, 1996", "CENTRAL", "1996")])).toMatchObject({ ok: false, reason: expect.stringMatching(/none chosen/) });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Law Commission reports (official adapter) and the gated loader route
// ---------------------------------------------------------------------------------------------------------------------

describe("Law Commission of India adapter", () => {
  it("reads report rows from the Commission page (one document per PDF part)", () => {
    const html = read("tests/fixtures/law/lci-report-twentysecond.html");
    const { items, unparsed } = parseLawCommissionReports(html, 22, "https://lawcommissionofindia.nic.in/report_twentysecond/");
    expect(unparsed).toBe(0);
    expect(items[0]).toMatchObject({ sourceId: "lawcommission", kind: "reference_report", docDate: "2023-03-17", meta: { reportNo: 278, commission: 22, part: null } });
    expect(items[0].title).toBe("Law Commission of India, Report No. 278: Urgent Need to Amend Rule 14(4) of Order VII of the Code of Civil Procedure, 1908");
    expect(items[0].url).toMatch(/^https:\/\/cdnbbsr\.s3waas\.gov\.in\/.+\.pdf$/);
    const parts = items.filter((i) => i.meta?.reportNo === 289);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.meta?.part)).toEqual(parts.map((_, k) => k + 1));
    expect(COMMISSION_PAGES[0]).toEqual({ commission: 22, slug: "report_twentysecond" });
    expect(COMMISSION_PAGES).toHaveLength(22);
  });

  it("is registered disabled until reproduction permission is on record, with the terms recorded", async () => {
    expect(lciDef.enabled).toBe(false);
    expect(lciDef.terms).toMatch(/permission/);
    expect(sourceDef("lawcommission")).toMatchObject({ id: "lawcommission", enabled: false });
    const r = await lciAdapter.discover({ limit: 5, deadline: Date.now() + 1000, cursor: null, today: "2026-10-02" } as never);
    expect(r.items).toEqual([]);
    expect(r.done).toBe(true);
  });
});

const person: Principal = { id: "u1", name: "Associate", tenantId: "default", roles: ["associate"], matterIds: "*", source: "dev" };
const cron: Principal = { id: "svc_cron", name: "Scheduled service", tenantId: "default", roles: ["service"], matterIds: "*", source: "service" };
const post = (body: unknown, headers: Record<string, string> = {}) => new Request("http://x/api/india/law-links/run", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const fakeStore: RemoteStore = { async query() { return []; }, async transaction(qs) { return qs.map(() => []); } };

describe("law-links loader route (gated like /api/official/run)", () => {
  it("needs the ingest token for people and validates the body", async () => {
    let calls = 0;
    const runners = { scr: async () => { calls++; return { ok: 1 }; } };
    expect((await handleLawLinksPost(post({}), { principal: () => person, vars: {}, store: fakeStore, runners })).status).toBe(503);
    expect((await handleLawLinksPost(post({}), { principal: () => person, vars: { OFFICIAL_INGEST_TOKEN: "t0ken" }, store: fakeStore, runners })).status).toBe(403);
    expect((await handleLawLinksPost(post({ tasks: ["nope"] }, { "x-official-token": "t0ken" }), { principal: () => person, vars: { OFFICIAL_INGEST_TOKEN: "t0ken" }, store: fakeStore, runners })).status).toBe(400);
    expect(calls).toBe(0);
    const ok = await handleLawLinksPost(post({ tasks: ["scr"], deadlineMs: 60_000 }, { "x-official-token": "t0ken" }), { principal: () => person, vars: { OFFICIAL_INGEST_TOKEN: "t0ken" }, store: fakeStore, runners });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ tasks: ["scr"], results: { scr: { ok: 1 } } });
    expect(parseLawLinksBody({})).toMatchObject({ tasks: ["scr", "statute-meta", "indiacode-sections"], restart: false });
    expect(() => parseLawLinksBody({ limit: 0 })).toThrow(RangeError);
  });

  it("cron runs only for the service principal and only when LAW_LINKS_INGEST=1; a failing task does not stop the others", async () => {
    expect((await handleLawLinksCron({ principal: () => person, vars: { LAW_LINKS_INGEST: "1" }, store: fakeStore })).status).toBe(403);
    expect(await (await handleLawLinksCron({ principal: () => cron, vars: {}, store: fakeStore })).json()).toMatchObject({ stop: "disabled" });
    const order: string[] = [];
    const runners = {
      scr: async () => { order.push("scr"); throw new Error("archive unavailable"); },
      "statute-meta": async () => { order.push("meta"); return { scanned: 3 }; },
      "indiacode-sections": async () => { order.push("ic"); return { acts: [] }; },
    };
    const res = await handleLawLinksCron({ principal: () => cron, vars: { LAW_LINKS_INGEST: "1" }, store: fakeStore, runners });
    const body = await res.json() as { results: Record<string, { stop?: string; error?: string }> };
    expect(order).toEqual(["scr", "meta", "ic"]);
    expect(body.results.scr).toMatchObject({ stop: "error", error: "archive unavailable" });
    expect(body.results["statute-meta"]).toEqual({ scanned: 3 });
  });
});
