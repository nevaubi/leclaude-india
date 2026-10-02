import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { parseQuery, parseBates, parseBatesRange, batesInRange, matchesQuery, compareBates, highlightRegex, makeSnippet, formatBates } from "@/modules/ediscovery/query";
import { buildSeedDocuments, VALSARA_ISSUE_CODES, EDISCOVERY_SEED_IDS } from "@/modules/ediscovery/seed";
import { searchDocuments, computeFacets, applyFilters, matterStats, updateCoding, bulkCode, toSearchable, listIssueCodes, createIssueCode, updateIssueCode, deleteIssueCode, viewCounts, recordView, getDocument, similarDocuments, generatePrivilegeLogTemplate, listPrivilegeLog, production, productionCsv, sortDocs, getCodingRules, setCodingRules } from "@/modules/ediscovery/service";
import { templatePrivilegeDescription, privilegeLogCsv, privilegeLogMarkdown, batesRanges, productionLoadFileCsv } from "@/modules/ediscovery/privilege";
import { indexStats, hybridSearch } from "@/lib/ai/vector-store";
import { VECTOR_COLLECTIONS } from "@/lib/ai/toolkit/internal";

const VALSARA = MATTERS.valsara;

beforeAll(() => { resetSqlite(); });

// ---------------------------------------------------------------------------
describe("Bates parsing", () => {
  it("parses single Bates numbers", () => {
    expect(parseBates("MFC-0041877")).toMatchObject({ prefix: "MFC", number: 41877, width: 7 });
    expect(parseBates("mfc 0041877")?.prefix).toBe("MFC");
    expect(parseBates("hello")).toBeNull();
    expect(formatBates("MFC", 41877)).toBe("MFC-0041877");
  });
  it("parses ranges with en dash, hyphen, 'to' and abbreviated end", () => {
    for (const s of ["MFC-0041877–MFC-0041999", "MFC-0041877 - MFC-0041999", "MFC-0041877 to MFC-0041999", "MFC-0041877-0041999", "MFC-0041877..MFC-0041999"]) {
      const r = parseBatesRange(s);
      expect(r, s).not.toBeNull();
      expect(r!.start.number).toBe(41877);
      expect(r!.end.number).toBe(41999);
    }
    expect(parseBatesRange("MFC-0041999–MFC-0041877")!.start.number).toBe(41877);
    expect(parseBatesRange("MFC-0041877–NGL-0000101")).toBeNull();
  });
  it("range membership accounts for multi-page documents", () => {
    const r = parseBatesRange("MFC-0041880–MFC-0041890")!;
    expect(batesInRange("MFC-0041877", r, "MFC-0041879")).toBe(false);
    expect(batesInRange("MFC-0041877", r, "MFC-0041882")).toBe(true);
    expect(batesInRange("MFC-0041886", r, "MFC-0041897")).toBe(true);
    expect(batesInRange("NGL-0041886", r)).toBe(false);
  });
  it("compares Bates numbers numerically within a prefix", () => {
    expect(compareBates("MFC-0041877", "MFC-0041999")).toBeLessThan(0);
    expect(compareBates("MFC-0052210", "MFC-0043105")).toBeGreaterThan(0);
    expect(compareBates("MFC-0000001", "NGL-0000001")).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("query parser", () => {
  const doc = toSearchable({
    id: "x", matterId: VALSARA, bates: "MFC-0041880", date: "2001-03-14", custodianId: PEOPLE.hemaVasudevan, custodianName: "Hema Vasudevan", type: "Email", subject: "Sundaram final — 90-day rat study",
    from: "Hema Vasudevan", to: ["Girish Hegde"], cc: ["Anil Prasad"], text: "The liver effects are real. Serum concentration in the recovery group.", coding: { issues: ["TOX-01"] }, hash: "abc123", tags: ["key-doc"],
  });
  it("handles boolean operators with precedence NOT > AND > OR", () => {
    const q = parseQuery("liver AND (serum OR marketing) NOT budget");
    expect(q.ast.kind).toBe("and");
    expect(matchesQuery(doc, q.ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("liver NOT serum").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("marketing OR liver").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("marketing budget").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("-marketing liver").ast)).toBe(true);
  });
  it("handles quoted phrases and collects highlight terms", () => {
    const q = parseQuery('"recovery group" liver');
    expect(q.terms).toEqual(["recovery group", "liver"]);
    expect(matchesQuery(doc, q.ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery('"group recovery"').ast)).toBe(false);
    expect(highlightRegex(q.terms)!.test("the Recovery   group")).toBe(true);
  });
  it("handles field prefixes", () => {
    expect(matchesQuery(doc, parseQuery("custodian:vasudevan").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("custodian:hegde").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("type:email from:vasudevan to:hegde cc:prasad").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("type:memo").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery('subject:"rat study"').ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("issue:tox-01").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("tag:key-doc hash:abc").ast)).toBe(true);
    expect(parseQuery("custodian:hegde").fields).toEqual([{ field: "custodian", value: "hegde" }]);
  });
  it("handles date expressions", () => {
    expect(matchesQuery(doc, parseQuery("date:2001").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("date:2001-03").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("date:2001-04").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("date:2001-03-01..2001-03-31").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("date:>2001-03-14").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("date:>=2001-03-14").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("date:<2002").ast)).toBe(true);
    expect(parseQuery("date:yesterday").warnings.length).toBe(1);
  });
  it("handles Bates ranges and bare Bates numbers inline", () => {
    const q = parseQuery("MFC-0041877–MFC-0041999 liver");
    expect(q.bates).toHaveLength(1);
    expect(q.terms).toEqual(["liver"]);
    expect(matchesQuery(doc, q.ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("bates:MFC-0041890-0041999").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("MFC-0041880").ast)).toBe(true);
  });
  it("accepts a spaced range after the bates: prefix instead of treating 'to' as a term", () => {
    for (const s of ["bates:MFC-0041877 to 0041880", "bates: MFC-0041877 – MFC-0041880", "bates:MFC-0041877 - 0041880 liver"]) {
      const q = parseQuery(s);
      expect(q.bates, s).toHaveLength(1);
      expect(q.bates[0].end.number, s).toBe(41880);
      expect(q.terms, s).not.toContain("to");
      expect(matchesQuery(doc, q.ast), s).toBe(true);
    }
    // a bare single Bates after the prefix followed by an exclusion is not a range
    const q = parseQuery("bates:MFC-0041880 -draft");
    expect(q.bates).toHaveLength(1);
    expect(q.bates[0].start.number).toBe(q.bates[0].end.number);
    expect(q.ast.kind).toBe("and");
  });
  it("treats a bare Bates number followed by a negated numeric term as an exclusion, not a range", () => {
    // "MFC-0041877 -2001" used to parse as the range MFC-0002001–MFC-0041877 (55 hits instead of 1).
    const q = parseQuery("MFC-0041877 -2001");
    expect(q.bates).toHaveLength(1);
    expect(q.bates[0].start.number).toBe(41877);
    expect(q.bates[0].end.number).toBe(41877);
    expect(q.ast).toMatchObject({ kind: "and", children: [{ kind: "bates" }, { kind: "not", child: { kind: "term", value: "2001" } }] });
    // spaced hyphen still joins a range when the end carries its own prefix, and an unspaced abbreviated end still works
    expect(parseQuery("MFC-0041877 - MFC-0041880").bates[0].end.number).toBe(41880);
    expect(parseQuery("MFC-0041877-0041880").bates[0].end.number).toBe(41880);
    expect(parseQuery("MFC-0041877 to 0041880").bates[0].end.number).toBe(41880);
  });
  it("tolerates malformed input", () => {
    const q = parseQuery('liver AND (serum "recovery group');
    expect(q.warnings.length).toBeGreaterThan(0);
    expect(matchesQuery(doc, q.ast)).toBe(true);
    expect(parseQuery("").ast.kind).toBe("empty");
    expect(parseQuery("AND OR NOT").ast.kind).toBe("empty");
  });
  it("makes snippets around the first hit", () => {
    const s = makeSnippet("aaaa ".repeat(50) + "the liver effects are real " + "bbbb ".repeat(50), ["liver"], 20);
    expect(s).toContain("liver");
    expect(s.startsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("seed integrity", () => {
  const docs = buildSeedDocuments();
  const valsara = docs.filter((d) => d.matterId === VALSARA);
  const ng = docs.filter((d) => d.matterId === MATTERS.northgate);
  const byId = new Map(docs.map((d) => [d.id, d]));

  it("has the required volume and unique ids / Bates", () => {
    expect(valsara.length).toBeGreaterThanOrEqual(70);
    expect(ng.length).toBeGreaterThanOrEqual(15);
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
    expect(new Set(docs.map((d) => d.bates)).size).toBe(docs.length);
  });
  it("assigns the Bates numbers other modules cite", () => {
    expect(byId.get("ed_vls_0001")).toMatchObject({ bates: "MFC-0041877", batesEnd: "MFC-0041879", date: "2001-03-14", custodianName: "Hema Vasudevan", type: "Report" });
    expect(byId.get("ed_vls_0011")).toMatchObject({ bates: "MFC-0041912", custodianName: "Girish Hegde", type: "Memo" });
    expect(byId.get("ed_vls_0016")).toMatchObject({ bates: "MFC-0041921", date: "2001-03-19", custodianName: "Rohit Kapur" });
    expect(byId.get("ed_vls_0018")).toMatchObject({ bates: "MFC-0041930", date: "2001-03-22", custodianName: "Manish Sood", type: "Memo" });
    expect(byId.get("ed_vls_0057")).toMatchObject({ bates: "MFC-0052210", date: "2002-07-08", custodianName: "Girish Hegde" });
    expect(byId.get("ed_vls_43105")?.bates).toBe("MFC-0043105");
    expect(byId.get("ed_vls_kaine_0001")?.bates).toBe("MFC-0043877");
    expect(byId.get("ed_vls_kaine_0006")?.bates).toBe("MFC-0043951");
    expect(byId.get(EDISCOVERY_SEED_IDS.northgateKeyDocs.mtsa)?.bates).toBe("NGL-0000101");
  });
  it("Bates numbers do not overlap across multi-page documents", () => {
    const ranges = valsara.map((d) => ({ s: parseBates(d.bates)!.number, e: parseBates(d.batesEnd ?? d.bates)!.number })).sort((a, b) => a.s - b.s);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].s).toBeGreaterThan(ranges[i - 1].e);
    for (const d of valsara) if (d.pages && d.pages > 1) expect(parseBates(d.batesEnd!)!.number - parseBates(d.bates)!.number + 1).toBe(d.pages);
  });
  it("families, threads, duplicates and near-duplicates reference existing documents", () => {
    for (const d of docs) {
      if (d.family?.parentId) { expect(byId.has(d.family.parentId), `${d.id} parent`).toBe(true); expect(byId.get(d.family.parentId)!.family?.attachmentIds).toContain(d.id); }
      for (const a of d.family?.attachmentIds ?? []) { expect(byId.has(a), `${d.id} attachment ${a}`).toBe(true); expect(byId.get(a)!.family?.parentId).toBe(d.id); }
      if (d.isDuplicateOf) { expect(byId.has(d.isDuplicateOf)).toBe(true); expect(byId.get(d.isDuplicateOf)!.hash).toBe(d.hash); expect(byId.get(d.isDuplicateOf)!.text).toBe(d.text); }
      for (const n of d.nearDuplicateIds ?? []) expect(byId.has(n), `${d.id} near-dup ${n}`).toBe(true);
      if (d.family?.threadId) expect(docs.filter((x) => x.family?.threadId === d.family?.threadId).length).toBeGreaterThan(1);
    }
    expect(docs.filter((d) => d.isDuplicateOf).length).toBeGreaterThanOrEqual(2);
    expect(docs.filter((d) => d.nearDuplicateIds?.length).length).toBeGreaterThanOrEqual(2);
  });
  it("uses the shared custodian ids and only known issue codes", () => {
    const custodians = new Set<string>([PEOPLE.girishHegde, PEOPLE.hemaVasudevan, PEOPLE.nandiniBose, PEOPLE.anilPrasad, PEOPLE.rohitKapur, PEOPLE.manishSood]);
    for (const d of valsara) expect(custodians.has(d.custodianId), d.id).toBe(true);
    expect(new Set(valsara.map((d) => d.custodianId)).size).toBe(6);
    const codes = new Set(VALSARA_ISSUE_CODES.map((c) => c.code));
    for (const d of valsara) for (const c of [...(d.coding.issues ?? []), ...(d.aiIssues ?? [])]) expect(codes.has(c), `${d.id} ${c}`).toBe(true);
  });
  it("has a realistic coding mix", () => {
    expect(valsara.filter((d) => d.coding.hot).length).toBeGreaterThanOrEqual(5);
    expect(valsara.filter((d) => d.coding.privileged === true).length).toBeGreaterThanOrEqual(4);
    expect(valsara.filter((d) => d.coding.responsive == null).length).toBeGreaterThanOrEqual(3);
    expect(valsara.filter((d) => d.coding.responsive === false).length).toBeGreaterThanOrEqual(3);
    expect(valsara.filter((d) => d.aiScore != null).length).toBe(valsara.length);
    expect(valsara.some((d) => d.date >= "2012-01-01")).toBe(true);
    for (const d of docs) { expect(d.text.length, d.id).toBeGreaterThan(300); expect(d.text.toLowerCase()).not.toContain("lorem"); }
    const emails = valsara.filter((d) => d.type === "Email");
    for (const e of emails) expect(e.text.startsWith("From:") || e.text.startsWith("Instant message"), e.id).toBe(true);
  });
  it("seeds into the database with issue codes, privilege log, rules and a keyword index", async () => {
    const d = db();
    expect(d.edocs.count((x) => x.matterId === VALSARA)).toBe(valsara.length);
    expect(d.issueCodes.count((x) => x.matterId === VALSARA)).toBe(VALSARA_ISSUE_CODES.length);
    expect(d.privilegeLog.count((x) => x.matterId === VALSARA)).toBeGreaterThanOrEqual(8);
    expect(getCodingRules(VALSARA)).toContain("Responsive");
    const stats = indexStats(VECTOR_COLLECTIONS.edocs);
    expect(stats.docs).toBeGreaterThanOrEqual(docs.length);
    const hits = await hybridSearch(VECTOR_COLLECTIONS.edocs, "monitoring well MW-7 groundwater", { k: 5, filter: (m) => m.matterId === VALSARA });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.docId === "ed_vls_0057" || h.docId === "ed_vls_0064" || h.docId === "ed_vls_0058")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("search service", () => {
  it("returns everything for an empty query with facets and workspace totals", async () => {
    const res = await searchDocuments({ matterId: VALSARA });
    expect(res.total).toBe(res.totalWorkspace);
    expect(res.hits.length).toBe(Math.min(100, res.total));
    expect(res.facets.custodian.length).toBe(6);
    expect(res.facets.custodian.reduce((n, f) => n + f.count, 0)).toBe(res.total);
    expect(res.facets.years.map((y) => y.year)).toContain("2001");
    expect(res.facets.status.find((s) => s.value === "needs_review")!.count).toBeGreaterThan(0);
    expect(res.hits[0].bates).toBe("MFC-0041877");
    expect(res.hits[0].family2.attachmentCount).toBe(0);
    expect(res.hits[0].family2.isAttachment).toBe(true);
  });
  it("applies boolean queries, Bates ranges and field prefixes server-side", async () => {
    const a = await searchDocuments({ matterId: VALSARA, q: "MFC-0041877–MFC-0041999" });
    expect(a.total).toBeGreaterThan(50);
    expect(a.hits.every((h) => parseBates(h.bates)!.number <= 41999)).toBe(true);
    const b = await searchDocuments({ matterId: VALSARA, q: 'custodian:kapur "timing of any submission"' });
    expect(b.hits.map((h) => h.id)).toContain("ed_vls_0016");
    expect(b.hits.every((h) => h.custodianName === "Rohit Kapur")).toBe(true);
    expect(b.hits[0].snippet).toMatch(/timing of any submission/i);
    const c = await searchDocuments({ matterId: VALSARA, q: "type:memo date:2001-03 NOT draft" });
    expect(c.hits.every((h) => h.type === "Memo" && h.date.startsWith("2001-03"))).toBe(true);
    expect(c.hits.map((h) => h.id)).not.toContain("ed_vls_0034");
    const d = await searchDocuments({ matterId: VALSARA, q: "bioassay AND (adenoma OR carcinoma)" });
    expect(d.hits.map((h) => h.id)).toContain("ed_vls_0066");
  });
  it("facet counts respect the other active facets and views", async () => {
    const res = await searchDocuments({ matterId: VALSARA, filters: { custodians: [PEOPLE.rohitKapur] } });
    expect(res.hits.every((h) => h.custodianId === PEOPLE.rohitKapur)).toBe(true);
    // custodian facet is counted without the custodian filter → other custodians still show counts
    expect(res.facets.custodian.length).toBe(6);
    // type facet is counted with the custodian filter → only Kapur's types
    expect(res.facets.type.reduce((n, f) => n + f.count, 0)).toBe(res.total);
    const hot = await searchDocuments({ matterId: VALSARA, view: "hot" });
    expect(hot.total).toBeGreaterThanOrEqual(5);
    expect(hot.hits.every((h) => h.coding.hot)).toBe(true);
    const nr = await searchDocuments({ matterId: VALSARA, view: "needs_review", filters: { scores: ["90+"] } });
    expect(nr.hits.every((h) => h.coding.responsive == null && (h.aiScore ?? 0) >= 90)).toBe(true);
  });
  it("sorts and pages", async () => {
    const desc = await searchDocuments({ matterId: VALSARA, sort: "date", dir: "desc", limit: 5 });
    expect(desc.hits.length).toBe(5);
    expect(desc.hits[0].date >= desc.hits[4].date).toBe(true);
    const p2 = await searchDocuments({ matterId: VALSARA, sort: "date", dir: "desc", limit: 5, offset: 5 });
    expect(p2.hits[0].id).not.toBe(desc.hits[0].id);
    const score = await searchDocuments({ matterId: VALSARA, sort: "aiScore", limit: 3 });
    expect(score.hits[0].aiScore!).toBeGreaterThanOrEqual(score.hits[1].aiScore!);
    const sorted = sortDocs([{ doc: db().edocs.get("ed_vls_0001")! }, { doc: db().edocs.get("ed_vls_0057")! }], "custodian", "asc");
    expect(sorted[0].doc.custodianName).toBe("Girish Hegde");
  });
  it("pages beyond 500 rows and lets a refresh reload everything already loaded", async () => {
    const all = await searchDocuments({ matterId: VALSARA, limit: 5000 });
    expect(all.hits.length).toBe(all.total);
    expect(all.limit).toBe(all.total > 5000 ? 5000 : 5000);
    const page = await searchDocuments({ matterId: VALSARA, limit: 10, offset: all.total - 3 });
    expect(page.hits.map((h) => h.id)).toEqual(all.hits.slice(-3).map((h) => h.id));
    const past = await searchDocuments({ matterId: VALSARA, limit: 10, offset: all.total + 10 });
    expect(past.hits).toEqual([]);
    expect(past.total).toBe(all.total);
  });
  it("semantic mode uses the hybrid index and keeps structural filters", async () => {
    const res = await searchDocuments({ matterId: VALSARA, q: "groundwater plume Park wellfield", semantic: true });
    expect(res.semantic).toBe(true);
    expect(res.total).toBeGreaterThan(0);
    expect(res.hits[0].score).toBeGreaterThan(0);
    const filtered = await searchDocuments({ matterId: VALSARA, q: "groundwater plume custodian:prasad", semantic: true });
    expect(filtered.hits.every((h) => h.custodianId === PEOPLE.anilPrasad)).toBe(true);
  });
  it("computes facets and filters directly", () => {
    const docs = db().edocs.find((d) => d.matterId === VALSARA);
    const f = computeFacets(docs, undefined, VALSARA);
    expect(f.issues.find((i) => i.value === "TOX-01")!.count).toBeGreaterThan(5);
    expect(f.score.map((s) => s.value)).toEqual(["90+", "70-89", "50-69", "<50", "unscored"]);
    expect(applyFilters(docs, { types: ["Email"], statuses: ["privileged"] }).every((d) => d.type === "Email" && d.coding.privileged === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("stats, views and document detail", () => {
  it("reports review progress and the production deadline", () => {
    const s = matterStats(VALSARA);
    expect(s.total).toBeGreaterThanOrEqual(70);
    expect(s.pctReviewed).toBeGreaterThan(50);
    expect(s.hot).toBeGreaterThanOrEqual(5);
    expect(s.privileged).toBeGreaterThanOrEqual(4);
    expect(s.productionDeadline?.label).toMatch(/production/i);
    expect(s.views.find((v) => v.view === "all")!.count).toBe(s.total);
  });
  it("tracks recently viewed documents", async () => {
    expect(viewCounts(VALSARA).find((v) => v.view === "recent")!.count).toBe(0);
    recordView(VALSARA, "ed_vls_0001");
    getDocument("ed_vls_0057", { recordView: true });
    expect(viewCounts(VALSARA).find((v) => v.view === "recent")!.count).toBe(2);
    const res = await searchDocuments({ matterId: VALSARA, view: "recent" });
    expect(res.hits.map((h) => h.id).sort()).toEqual(["ed_vls_0001", "ed_vls_0057"]);
  });
  it("resolves families, threads and duplicates in document detail", () => {
    const d = getDocument("ed_vls_0002")!;
    expect(d.family.attachments.map((a) => a.id)).toEqual(["ed_vls_0001", "ed_vls_0007"]);
    expect(d.family.thread.length).toBeGreaterThanOrEqual(4);
    expect(d.family.duplicates.map((x) => x.id)).toContain("ed_vls_0024");
    const dup = getDocument("MFC-0041943")!;
    expect(dup.doc.id).toBe("ed_vls_0024");
    expect(dup.family.duplicateOf?.id).toBe("ed_vls_0002");
    const near = getDocument("ed_vls_0011")!;
    expect(near.family.nearDuplicates.map((x) => x.id)).toContain("ed_vls_0034");
    expect(near.reviewerName).toBe("Arjun Mehra");
    expect(getDocument("nope")).toBeNull();
  });
  it("finds similar documents through family relations and the keyword index", async () => {
    const sim = await similarDocuments("ed_vls_0057", 8);
    expect(sim.find((s) => s.id === "ed_vls_0064")?.reason).toBe("duplicate");
    expect(sim.find((s) => s.id === "ed_vls_0058")?.reason).toBe("family");
    expect(sim.some((s) => s.reason === "keyword")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("coding", () => {
  it("updates a single document and stamps the reviewer", () => {
    const before = db().edocs.get("ed_vls_0015")!;
    expect(before.coding.responsive).toBeNull();
    const after = updateCoding("ed_vls_0015", { responsive: true, hot: true, issues: ["REG-01", "MKT-01", "MKT-01"], privileged: false, notes: "Commercial pressure on the 8(e) decision." }, PEOPLE.eshaMathur)!;
    expect(after.coding.responsive).toBe(true);
    expect(after.coding.issues).toEqual(["REG-01", "MKT-01"]);
    expect(after.coding.reviewerId).toBe(PEOPLE.eshaMathur);
    expect(after.coding.reviewedAt).toBeTruthy();
    expect(after.coding.privilegeBasis).toBeUndefined();
    expect(db().edocs.get("ed_vls_0015")!.coding.hot).toBe(true);
    expect(updateCoding("missing", { hot: true })).toBeNull();
  });
  it("drops the privilege basis when privilege is removed", () => {
    const after = updateCoding("ed_vls_0036", { privileged: false })!;
    expect(after.coding.privilegeBasis).toBeUndefined();
    updateCoding("ed_vls_0036", { privileged: true, privilegeBasis: "attorney-client" });
    expect(db().edocs.get("ed_vls_0036")!.coding.privilegeBasis).toBe("attorney-client");
  });
  it("bulk codes with issue add/remove", () => {
    const res = bulkCode({ ids: ["ed_vls_0050", "ed_vls_0051", "ed_vls_0050"], patch: { responsive: true }, addIssues: ["CUS-01"], removeIssues: ["TOX-01"] });
    expect(res.updated).toBe(2);
    for (const id of ["ed_vls_0050", "ed_vls_0051"]) {
      const d = db().edocs.get(id)!;
      expect(d.coding.responsive).toBe(true);
      expect(d.coding.issues).toContain("CUS-01");
    }
    bulkCode({ ids: ["ed_vls_0050", "ed_vls_0051"], patch: { responsive: false }, removeIssues: ["CUS-01"] });
    expect(db().edocs.get("ed_vls_0050")!.coding.issues).not.toContain("CUS-01");
  });
});

// ---------------------------------------------------------------------------
describe("issue codes and rules", () => {
  it("lists codes with live document counts", () => {
    const codes = listIssueCodes(VALSARA);
    expect(codes.find((c) => c.code === "TOX-01")!.count).toBeGreaterThan(5);
    expect(codes.find((c) => c.code === "TOX-02")!.parentId).toBe("ic_vls_tox01");
  });
  it("creates, renames (propagating to documents) and deletes codes", () => {
    const created = createIssueCode(VALSARA, { code: "exp-01", label: "Expert reliance", color: "chart-2" });
    expect(created.code).toBe("EXP-01");
    expect(() => createIssueCode(VALSARA, { code: "EXP-01", label: "dup" })).toThrow(/exists/);
    bulkCode({ ids: ["ed_vls_0001"], patch: {}, addIssues: ["EXP-01"] });
    updateIssueCode(created.id, { code: "EXP-02", label: "Expert reliance (renamed)" });
    expect(db().edocs.get("ed_vls_0001")!.coding.issues).toContain("EXP-02");
    expect(listIssueCodes(VALSARA).find((c) => c.code === "EXP-02")!.count).toBe(1);
    expect(deleteIssueCode(created.id)).toBe(true);
    expect(db().edocs.get("ed_vls_0001")!.coding.issues).not.toContain("EXP-02");
    expect(deleteIssueCode(created.id)).toBe(false);
  });
  it("stores coding rules per matter", () => {
    setCodingRules(VALSARA, "# Test rules");
    expect(getCodingRules(VALSARA)).toBe("# Test rules");
    expect(getCodingRules(MATTERS.northgate)).toContain("Northgate");
  });
});

// ---------------------------------------------------------------------------
describe("privilege log and production", () => {
  it("writes privilege-safe template descriptions", () => {
    const d = db().edocs.get("ed_vls_0016")!;
    const desc = templatePrivilegeDescription(d);
    expect(desc).toMatch(/^Email from Rohit Kapur \(Associate General Counsel\)/);
    expect(desc).toMatch(/legal advice/);
    expect(desc).not.toMatch(/bioassay|board minutes|\$/);
    const wp = templatePrivilegeDescription(db().edocs.get("ed_vls_0018")!);
    expect(wp).toMatch(/anticipation of litigation/);
    const toCounsel = templatePrivilegeDescription(db().edocs.get("ed_vls_0014")!);
    expect(toCounsel).toMatch(/requesting legal advice/);
  });
  it("generates entries for privileged documents and removes stale ones", () => {
    const before = listPrivilegeLog(VALSARA).length;
    const res = generatePrivilegeLogTemplate(VALSARA);
    expect(res.created).toBeGreaterThan(0);
    const after = listPrivilegeLog(VALSARA);
    expect(after.length).toBe(before + res.created);
    expect(after.every((e) => e.description.length > 20 && e.subject)).toBe(true);
    // un-privilege one doc → its entry is removed on the next generation
    updateCoding("ed_vls_0080", { privileged: false });
    const res2 = generatePrivilegeLogTemplate(VALSARA);
    expect(res2.removed).toBe(1);
    expect(listPrivilegeLog(VALSARA).some((e) => e.docId === "ed_vls_0080")).toBe(false);
    updateCoding("ed_vls_0080", { privileged: true, privilegeBasis: "attorney-client" });
  });
  it("exports CSV and markdown", () => {
    const rows = listPrivilegeLog(VALSARA);
    const csv = privilegeLogCsv(rows);
    expect(csv.split("\r\n").length).toBe(rows.length + 1);
    expect(csv.startsWith("Log No.,Beg Bates,End Bates")).toBe(true);
    expect(csv).toContain("MFC-0041921");
    const md = privilegeLogMarkdown(rows, "Valsara v. Meridian", "Arb. Ref. 14/2024");
    expect(md).toContain("| No. | Bates |");
    expect(md).toContain("Arb. Ref. 14/2024");
  });
  it("summarises the production set and writes a load file", () => {
    const p = production(VALSARA);
    expect(p.produced).toBeGreaterThan(30);
    expect(p.privilegedWithheld).toBeGreaterThanOrEqual(4);
    expect(p.produced + p.privilegedWithheld).toBeLessThanOrEqual(p.responsive + 5);
    expect(p.batesRanges.length).toBeGreaterThan(1);
    expect(p.batesRanges[0].start).toBe("MFC-0041877");
    expect(p.byCustodian[0].count).toBeGreaterThan(0);
    const csv = productionCsv(VALSARA);
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("BegBates,EndBates,BegAttach,EndAttach");
    expect(lines.length).toBe(p.produced + 1);
    expect(csv).not.toContain("MFC-0041921"); // privileged withheld
    expect(csv).not.toContain("MFC-0041943"); // duplicate suppressed
    const family = lines.find((l) => l.startsWith("MFC-0041880"))!;
    expect(family.split(",")[2]).toBe("MFC-0041877"); // BegAttach for the Vasudevan transmittal family
    const ranges = batesRanges([db().edocs.get("ed_vls_0001")!, db().edocs.get("ed_vls_0002")!, db().edocs.get("ed_vls_0057")!]);
    expect(ranges).toEqual([{ start: "MFC-0041877", end: "MFC-0041880", count: 2 }, { start: "MFC-0052210", end: "MFC-0052211", count: 1 }]);
    expect(productionLoadFileCsv([]).split("\r\n").length).toBe(1);
  });
});
