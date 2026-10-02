import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import type { EDocument, Redaction, ReviewBatch } from "@/lib/types/domain";
import { matchesQuery, parseQuery, termPositions, withinDistance, wordsOf } from "@/modules/ediscovery/query";
import { detectNearDuplicates, estimateSimilarity, groupPairs, minhash, normalizeForShingles, shingles } from "@/modules/ediscovery/near-dup";
import { batchProgress, codingDifferences, deriveBatchStatus, disagreementReport, makeQcDecision, nextUncoded, sampleIds } from "@/modules/ediscovery/batch-pure";
import { assignBates, canTransition, findUnredactedPii, generateDat, generateOpt, nextBatesNumber, parseOpt, productionOrder, qcProduction, DAT_SEP, DAT_QUOTE } from "@/modules/ediscovery/production-pure";
import { applyTextRedactions, mergeRanges, segmentText, validateRedaction } from "@/modules/ediscovery/redaction-pure";
import { fillTemplate, privilegeLogWorkbook, DESCRIPTION_TEMPLATES } from "@/modules/ediscovery/privilege-xlsx";
import { searchDocuments, toSearchable, updateCoding } from "@/modules/ediscovery/service";
import { createBatches, createProduction, createRedaction, createSavedSearch, deleteRedaction, docHistory, getBatch, listBatches, listProductions, listSavedSearches, nextInBatch, recordQcDecision, refreshNearDuplicates, runProductionQc, saveLayout, listLayouts, searchTermReport, searchTermReportCsv, updateProduction, redactedText, updateBatch } from "@/modules/ediscovery/review-service";
import { productionLoadFiles, buildProductionZip, renderProductionPdf } from "@/modules/ediscovery/production-export";
import { REVIEW_SEED_IDS } from "@/modules/ediscovery/seed-review";
import { GET as batchesGET, POST as batchesPOST } from "@/app/api/ediscovery/batches/route";
import { GET as batchGET, PATCH as batchPATCH } from "@/app/api/ediscovery/batches/[id]/route";
import { GET as nextGET } from "@/app/api/ediscovery/batches/[id]/next/route";
import { GET as savedGET, POST as savedPOST } from "@/app/api/ediscovery/saved-searches/route";
import { GET as redGET, POST as redPOST, DELETE as redDELETE } from "@/app/api/ediscovery/redactions/route";
import { GET as prodGET, POST as prodPOST } from "@/app/api/ediscovery/productions/route";
import { GET as prodOneGET, PATCH as prodPATCH } from "@/app/api/ediscovery/productions/[id]/route";
import { GET as prodExportGET } from "@/app/api/ediscovery/productions/[id]/export/route";
import { POST as termsPOST } from "@/app/api/ediscovery/search-terms/route";
import { GET as historyGET } from "@/app/api/ediscovery/docs/[id]/history/route";
import { PATCH as docPATCH } from "@/app/api/ediscovery/docs/[id]/route";
import { POST as searchPOST } from "@/app/api/ediscovery/search/route";
import { GET as privExportGET } from "@/app/api/ediscovery/privilege-log/export/route";

const VALSARA = MATTERS.valsara;
const req = (url: string, init?: { method?: string; json?: unknown }) => new NextRequest(`http://localhost${url}`, { method: init?.method ?? "GET", ...(init?.json !== undefined ? { body: JSON.stringify(init.json), headers: { "Content-Type": "application/json" } } : {}) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(() => { resetSqlite(); db(); });

// ---------------------------------------------------------------------------
describe("query extensions: proximity and fielded lists", () => {
  const doc = toSearchable({
    id: "x", matterId: VALSARA, bates: "MFC-0041880", date: "2001-03-14", custodianId: PEOPLE.hemaVasudevan, custodianName: "Hema Vasudevan", type: "Email", subject: "Sundaram final — 90-day rat study",
    from: "Hema Vasudevan", to: ["Girish Hegde"], cc: ["Anil Prasad"], text: "The liver effects are real and the rat study confirms serum concentration in the recovery group.", pages: 3,
    coding: { responsive: true, privileged: true, privilegeBasis: "work-product", hot: true, issues: ["TOX-01"], reviewerId: PEOPLE.eshaMathur }, hash: "abc123", tags: ["key-doc"],
    family: { parentId: "parent1", threadId: "t_rat" }, nearDuplicateIds: ["y"],
  } as EDocument);
  it("finds terms within N words in either order (w/N) and ordered (pre/N)", () => {
    expect(matchesQuery(doc, parseQuery("liver w/3 real").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("liver w/2 confirms").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("real w/3 liver").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("real pre/3 liver").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("liver pre/3 real").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery('"rat study" w/2 confirms').ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("(liver w/3 real) AND serum").ast)).toBe(true);
    const q = parseQuery("liver w/5 study NOT marketing");
    expect(q.ast).toMatchObject({ kind: "and", children: [{ kind: "prox", distance: 5, ordered: false }, { kind: "not" }] });
    expect(q.terms).toEqual(["liver", "study"]);
    expect(parseQuery("w/5 liver").warnings.length).toBe(1);
    expect(parseQuery("liver w/5").warnings.length).toBe(1);
  });
  it("exposes word positions for highlighting helpers", () => {
    const words = wordsOf(doc);
    expect(termPositions(words, "rat study").length).toBe(2);
    expect(withinDistance([3], [5], 2, true)).toBe(true);
    expect(withinDistance([5], [3], 2, true)).toBe(false);
  });
  it("supports hot/priv/responsive/hasattachment/dupes/pages/reviewer fields", () => {
    expect(matchesQuery(doc, parseQuery("hot:yes").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("hot:no").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("priv:yes").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("priv:wp").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("priv:ac").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("responsive:yes").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("responsive:none").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("hasattachment:no").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("dupes:near").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("dupes:exact").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery("pages:>2").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("pages:2..2").ast)).toBe(false);
    expect(matchesQuery(doc, parseQuery(`reviewer:${PEOPLE.eshaMathur}`).ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("thread:t_rat").ast)).toBe(true);
    expect(matchesQuery(doc, parseQuery("family:parent1").ast)).toBe(true);
  });
  it("resolves family: and thread: by Bates server-side", async () => {
    const fam = await searchDocuments({ matterId: VALSARA, q: "family:MFC-0041877" });
    expect(fam.hits.map((h) => h.id).sort()).toEqual(["ed_vls_0001", "ed_vls_0002", "ed_vls_0007"]);
    const th = await searchDocuments({ matterId: VALSARA, q: "thread:MFC-0041880" });
    expect(th.total).toBeGreaterThanOrEqual(4);
    const uncoded = await searchDocuments({ matterId: VALSARA, q: "responsive:none" });
    expect(uncoded.hits.every((h) => h.coding.responsive == null)).toBe(true);
    const prox = await searchDocuments({ matterId: VALSARA, q: "liver w/8 serum" });
    expect(prox.total).toBeGreaterThan(0);
  });
  it("pages, groups by family and reports months", async () => {
    const p2 = await searchDocuments({ matterId: VALSARA, page: 2, limit: 10 });
    expect(p2.offset).toBe(10);
    expect(p2.page).toBe(2);
    expect(p2.pages).toBeGreaterThan(5);
    expect(p2.facets.months.length).toBeGreaterThan(3);
    const grouped = await searchDocuments({ matterId: VALSARA, groupBy: "family", limit: 5000 });
    const head = grouped.hits.find((h) => h.id === "ed_vls_0002")!;
    expect(head.groupKey).toBe("ed_vls_0002");
    expect(head.groupIndex).toBe(0);
    expect(head.groupSize).toBe(3);
    const idx = grouped.hits.indexOf(head);
    expect(grouped.hits.slice(idx, idx + 3).map((h) => h.id).sort()).toEqual(["ed_vls_0001", "ed_vls_0002", "ed_vls_0007"]);
    const threads = await searchDocuments({ matterId: VALSARA, groupBy: "thread", limit: 5000 });
    expect(threads.hits.some((h) => h.groupSize && h.groupSize > 1)).toBe(true);
    const byBatch = await searchDocuments({ matterId: VALSARA, batchId: REVIEW_SEED_IDS.batches.kaineSecondPass });
    expect(byBatch.hits.every((h) => h.custodianId === PEOPLE.rohitKapur)).toBe(true);
    expect(byBatch.hits[0].aiRationale ?? byBatch.hits[0].aiScore).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe("near-duplicate detection", () => {
  const base = "From: a@b.com\nTo: c@d.com\nSubject: Interim results\n\nThe two-year bioassay interim results show hepatocellular adenoma incidence at the high dose group exceeding controls; the study director recommends continuing to the scheduled termination and adding a serum persistence analysis for the recovery group.";
  const draft = base.replace("recommends continuing", "recommends that we continue").replace("Interim results", "Interim results (draft 2)") + "\nPlease treat as confidential.";
  const other = "Meeting minutes for the quarterly sales review: distributor pricing for the Gulf Coast refineries, trade-show budget and the new brochure copy were discussed; no action items.";
  it("normalises, shingles and estimates similarity with MinHash", () => {
    expect(normalizeForShingles(base)).not.toContain("subject:");
    const a = shingles(base), b = shingles(draft), c = shingles(other);
    expect(a.size).toBeGreaterThan(20);
    const sa = minhash(a), sb = minhash(b), sc = minhash(c);
    expect(estimateSimilarity(sa, sb)).toBeGreaterThan(0.5);
    expect(estimateSimilarity(sa, sc)).toBeLessThan(0.1);
    expect(estimateSimilarity(sa, sa)).toBe(1);
  });
  it("detects pairs above the threshold and groups them", () => {
    const res = detectNearDuplicates([{ id: "a", text: base }, { id: "b", text: draft }, { id: "c", text: other }], { threshold: 0.5 });
    expect(res.pairs.map((p) => [p.a, p.b])).toEqual([["a", "b"]]);
    expect(res.pairs[0].score).toBeGreaterThan(0.5);
    expect(res.groups).toEqual([["a", "b"]]);
    expect(groupPairs([{ a: "x", b: "y", score: 1 }, { a: "y", b: "z", score: 1 }, { a: "p", b: "q", score: 1 }])).toEqual([["p", "q"], ["x", "y", "z"]]);
    // LSH path (large corpus) agrees with the exhaustive path on the same pair
    const many = Array.from({ length: 450 }, (_, i) => ({ id: `n${i}`, text: `${other} variant ${i} ${i * 7} ${i % 13}` }));
    const big = detectNearDuplicates([...many, { id: "a", text: base }, { id: "b", text: draft }], { threshold: 0.5 });
    expect(big.pairs.some((p) => (p.a === "a" && p.b === "b") || (p.a === "b" && p.b === "a"))).toBe(true);
  });
  it("populates nearDuplicateIds and scores on seeded documents and keeps hand links", () => {
    const seeded = db().edocs.get("ed_vls_0011")!;
    expect(seeded.nearDuplicateIds).toContain("ed_vls_0034");
    expect(seeded.nearDuplicateScores?.["ed_vls_0034"]).toBeGreaterThan(0);
    const r = refreshNearDuplicates(VALSARA, { threshold: 0.5 });
    expect(r.pairs).toBeGreaterThanOrEqual(1);
    const dup = db().edocs.get("ed_vls_0024")!; // exact duplicate is not a near-dup
    expect(dup.nearDuplicateIds ?? []).not.toContain("ed_vls_0002");
  });
});

// ---------------------------------------------------------------------------
describe("batch logic", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `d${i}`);
  it("samples deterministically", () => {
    const s1 = sampleIds(ids, 25, "seed");
    expect(s1.length).toBe(10);
    expect(sampleIds(ids, 25, "seed")).toEqual(s1);
    expect(sampleIds(ids, 25, "other")).not.toEqual(s1);
    expect(sampleIds(ids, 1, "seed").length).toBe(1);
    expect(sampleIds(ids, 0, "seed")).toEqual([]);
    expect(ids.indexOf(s1[0])).toBeLessThan(ids.indexOf(s1[1]));
  });
  it("finds the next uncoded document with wrap-around", () => {
    const coded = new Set(["d0", "d1", "d3"]);
    const c = (id: string) => (coded.has(id) ? { responsive: true } : { responsive: null });
    expect(nextUncoded(["d0", "d1", "d2", "d3"], "d2", c)).toBe(null === null ? nextUncoded(["d0", "d1", "d2", "d3"], "d2", c) : null);
    expect(nextUncoded(["d0", "d1", "d2", "d3"], null, c)).toBe("d2");
    expect(nextUncoded(["d0", "d1", "d2", "d3"], "d3", c)).toBe("d2");
    expect(nextUncoded(["d0", "d1"], "d0", c)).toBeNull();
  });
  it("computes progress, status and disagreement reports", () => {
    const batch: ReviewBatch = { id: "b", matterId: VALSARA, name: "b", docIds: ["d0", "d1", "d2"], source: { kind: "all" }, priority: "normal", status: "open", qcSamplePercent: 50, qcSampleIds: ["d0", "d1"], secondPass: false, qcDecisions: {}, createdBy: "p", createdAt: "t", updatedAt: "t" };
    const coding: Record<string, { responsive: boolean | null; privileged?: boolean; hot?: boolean; issues?: string[]; reviewerId?: string }> = { d0: { responsive: true, hot: true, issues: ["A"], reviewerId: "r1" }, d1: { responsive: false, reviewerId: "r2" }, d2: { responsive: null } };
    let p = batchProgress(batch, (id) => coding[id]);
    expect(p).toMatchObject({ total: 3, coded: 2, remaining: 1, pct: 67, responsive: 1, hot: 1, qcSampled: 2, qcDone: 0 });
    expect(deriveBatchStatus(batch, p)).toBe("in_progress");
    coding.d2 = { responsive: true };
    p = batchProgress(batch, (id) => coding[id]);
    expect(deriveBatchStatus(batch, p)).toBe("qc");
    batch.qcDecisions.d0 = makeQcDecision(coding.d0, { responsive: true, hot: false, issues: ["A", "B"] }, "qc1", "t2");
    batch.qcDecisions.d1 = makeQcDecision(coding.d1, { responsive: false }, "qc1", "t2");
    expect(batch.qcDecisions.d0.agree).toBe(false);
    expect(batch.qcDecisions.d1.agree).toBe(true);
    expect(codingDifferences(batch.qcDecisions.d0.firstPass, batch.qcDecisions.d0.qc)).toEqual(["hot", "issues"]);
    const rep = disagreementReport(batch);
    expect(rep).toMatchObject({ sampled: 2, reviewed: 2, agree: 1, disagree: 1, rate: 0.5, byField: { responsive: 0, privileged: 0, hot: 1, issues: 1 } });
    expect(rep.byReviewer[0]).toMatchObject({ reviewerId: "r1", reviewed: 1, disagree: 1 });
    expect(deriveBatchStatus(batch, batchProgress(batch, (id) => coding[id]))).toBe("complete");
  });
  it("creates batches from a search, splits by size, walks them and records QC decisions", async () => {
    const seeded = listBatches(VALSARA);
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    const hot = getBatch(REVIEW_SEED_IDS.batches.hotQc)!;
    expect(hot.progress.qcDone).toBeGreaterThan(0);
    expect(hot.disagreements.disagree).toBe(1);
    const created = await createBatches({ matterId: VALSARA, name: "Kapur chunks", q: "custodian:kapur", uncodedOnly: false, size: 3, assigneeId: PEOPLE.eshaMathur, qcSamplePercent: 34, priority: "high" });
    expect(created.length).toBeGreaterThan(1);
    expect(created[0].name).toBe("Kapur chunks 01");
    expect(created.every((b) => b.docIds.length <= 3)).toBe(true);
    expect(created[0].qcSampleIds.length).toBe(1);
    const [u1, u2] = db().edocs.find((d) => d.matterId === VALSARA && d.coding.responsive == null).map((d) => d.id);
    const sel = await createBatches({ matterId: VALSARA, name: "Selection", ids: [u1, u2] });
    expect(sel[0].source.kind).toBe("selection");
    expect(sel[0].docIds).toEqual([u1, u2]);
    const first = nextInBatch(sel[0].id, null);
    expect(first.id).toBe(u1);
    updateCoding(u1, { responsive: true });
    expect(nextInBatch(sel[0].id, u1).id).toBe(u2);
    updateBatch(sel[0].id, { qcSamplePercent: 100 });
    const qc = recordQcDecision(sel[0].id, u1, { responsive: false }, PEOPLE.priyaRaman);
    expect(qc.qcDecisions[u1].agree).toBe(false);
    expect(nextInBatch(sel[0].id, null, true).id).toBe(u2);
    await expect(createBatches({ matterId: VALSARA, name: "empty", q: "zzzz-never" })).rejects.toThrow(/No documents/);
  });
});

// ---------------------------------------------------------------------------
describe("Bates assignment and load files", () => {
  it("assigns sequential production numbers across page counts", () => {
    const { bates, next } = assignBates([{ id: "a", pages: 3 }, { id: "b" }, { id: "c", pages: 2 }], { prefix: "meridian", padding: 7, startNumber: 1 });
    expect(bates.a).toEqual({ begin: "MERIDIAN-0000001", end: "MERIDIAN-0000003", pages: 3 });
    expect(bates.b).toEqual({ begin: "MERIDIAN-0000004", end: "MERIDIAN-0000004", pages: 1 });
    expect(bates.c.end).toBe("MERIDIAN-0000006");
    expect(next).toBe(7);
    expect(nextBatesNumber([{ prefix: "MERIDIAN", bates }], "meridian")).toBe(7);
    expect(nextBatesNumber([], "X", 100)).toBe(100);
  });
  it("orders families together and writes DAT/OPT load files", () => {
    const docs = db().edocs.find((d) => ["ed_vls_0001", "ed_vls_0002", "ed_vls_0007", "ed_vls_0057"].includes(d.id));
    const ordered = productionOrder(docs);
    expect(ordered.map((d) => d.id)).toEqual(["ed_vls_0002", "ed_vls_0001", "ed_vls_0007", "ed_vls_0057"]);
    const { bates } = assignBates(ordered, { prefix: "MER", padding: 6, startNumber: 10 });
    const production = { volume: "VOL001", bates, docIds: ordered.map((d) => d.id), stampText: "CONFIDENTIAL" };
    const dat = generateDat({ production, docs, redactedIds: new Set(["ed_vls_0057"]) });
    const lines = dat.trim().split("\r\n");
    expect(lines.length).toBe(5);
    expect(lines[0].startsWith(`${DAT_QUOTE}BEGBATES${DAT_QUOTE}${DAT_SEP}${DAT_QUOTE}ENDBATES${DAT_QUOTE}`)).toBe(true);
    const cols = lines[1].split(DAT_SEP).map((c) => c.replace(new RegExp(DAT_QUOTE, "g"), ""));
    expect(cols[0]).toBe("MER-000010");
    expect(cols[2]).toBe("MER-000010"); // BEGATTACH = family begin
    expect(cols[3]).toBe(bates.ed_vls_0007.end); // ENDATTACH = last attachment end
    expect(cols[4]).toBe("VOL001");
    const last = lines[4].split(DAT_SEP).map((c) => c.replace(new RegExp(DAT_QUOTE, "g"), ""));
    expect(last[14]).toBe("Y"); // REDACTED
    expect(last[15]).toMatch(/^MFC-0052210/); // ORIGBATES
    const opt = generateOpt({ production });
    const parsed = parseOpt(opt);
    expect(parsed.length).toBe(4);
    expect(parsed[0]).toEqual({ bates: "MER-000010", volume: "VOL001", pages: 1 });
    expect(opt.split("\r\n").filter(Boolean).length).toBe(Object.values(bates).reduce((n, b) => n + b.pages, 0));
    const p3 = parsed.find((x) => x.bates === bates.ed_vls_0001.begin)!;
    expect(p3.pages).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe("redactions", () => {
  it("merges ranges and applies text redactions keeping line breaks", () => {
    expect(mergeRanges([{ start: 5, end: 10, label: "A" }, { start: 8, end: 12, label: "B" }, { start: 20, end: 22, label: "C" }, { start: 30, end: 30, label: "D" }], 25)).toEqual([{ start: 5, end: 12, label: "A" }, { start: 20, end: 22, label: "C" }]);
    const text = "Call 555-0100 for Jane\nDoe at once.";
    const r = (start: number, end: number, label = "REDACTED — PII"): Redaction => ({ id: "r", matterId: VALSARA, docId: "d", kind: "text", start, end, reason: "pii", label, createdBy: "p", createdAt: "t" });
    const out = applyTextRedactions(text, [r(5, 13), r(18, 26)]);
    expect(out.applied).toBe(2);
    expect(out.text).toBe("Call [REDACTED — PII] for [REDACTED — PII]\n at once.");
    const segs = segmentText(text, [r(5, 13)]);
    expect(segs.map((s) => s.text)).toEqual(["Call ", "555-0100", " for Jane\nDoe at once."]);
    expect(segs[1].redaction).toBeDefined();
    expect(validateRedaction({ kind: "text", start: 2, end: 1 }, 100, 1)).toMatch(/non-empty/);
    expect(validateRedaction({ kind: "page", page: 1, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 } }, 100, 1)).toBeNull();
    expect(validateRedaction({ kind: "page", page: 3, rect: { x: 0, y: 0, w: 1, h: 1 } }, 100, 2)).toMatch(/Page/);
  });
  it("creates, lists and removes redactions through the service and reflects them in the redacted text", () => {
    const doc = db().edocs.get("ed_vls_0057")!;
    const i = doc.text.indexOf("Valsara");
    const red = createRedaction({ docId: doc.id, kind: "text", start: i, end: i + 7, reason: "confidential" });
    expect(red.label).toBe("REDACTED — CONFIDENTIAL");
    expect(red.quote).toBe("Valsara");
    expect(redactedText(doc).text).toContain("[REDACTED — CONFIDENTIAL]");
    expect(() => createRedaction({ docId: doc.id, kind: "text", start: -1, end: 4, reason: "pii" })).toThrow();
    expect(deleteRedaction(red.id)).toBe(true);
    expect(redactedText(doc).text).not.toContain("[REDACTED — CONFIDENTIAL]");
    expect(redactedText(doc).applied).toBeGreaterThanOrEqual(1); // seeded PII redaction remains
  });
});

// ---------------------------------------------------------------------------
describe("production QC and status workflow", () => {
  it("flags privileged documents, missing family members, PII and uncoded documents", () => {
    const docs = db().edocs.find((d) => d.matterId === VALSARA);
    const priv = docs.find((d) => d.coding.privileged === true)!;
    const parentWithKids = docs.find((d) => (d.family?.attachmentIds?.length ?? 0) > 0)!;
    const uncoded = docs.find((d) => d.coding.responsive == null)!;
    const pii = { ...docs[5], id: "pii_doc", text: "Employee SSN 123-45-6789 and card 4111 1111 1111 1111 on file." };
    const set = [priv, parentWithKids, uncoded, pii];
    const { bates } = assignBates(set, { prefix: "T", padding: 5, startNumber: 1 });
    const report = qcProduction({ production: { docIds: set.map((d) => d.id), bates }, docs: [...docs, pii], redactions: [] });
    expect(report.ok).toBe(false);
    expect(report.privilegedInSet.map((x) => x.docId)).toContain(priv.id);
    expect(report.missingFamily.some((m) => m.docId === parentWithKids.id)).toBe(true);
    expect(report.uncoded.map((x) => x.docId)).toContain(uncoded.id);
    expect(report.unredactedPii.filter((x) => x.docId === "pii_doc").map((x) => x.pattern)).toEqual(expect.arrayContaining(["Social Security number", "Payment card number"]));
    expect(report.unredactedPii[0].sample).not.toContain("6789");
    const redactedPii = qcProduction({ production: { docIds: ["pii_doc"], bates }, docs: [pii], redactions: [{ id: "r", matterId: VALSARA, docId: "pii_doc", kind: "text", start: 13, end: 24, reason: "pii", label: "REDACTED", createdBy: "p", createdAt: "t" }, { id: "r2", matterId: VALSARA, docId: "pii_doc", kind: "text", start: 34, end: 53, reason: "pii", label: "REDACTED", createdBy: "p", createdAt: "t" }] });
    expect(redactedPii.unredactedPii).toEqual([]);
    expect(findUnredactedPii("DOB: 04/12/1971 MRN 0012345")).toHaveLength(2);
    expect(canTransition("draft", "final")).toMatchObject({ ok: false });
    expect(canTransition("qc", "final", report)).toMatchObject({ ok: false });
    expect(canTransition("qc", "final", { ...report, ok: true })).toMatchObject({ ok: true });
    expect(canTransition("final", "draft").ok).toBe(false);
  });
  it("creates a production, runs QC, moves through the workflow and exports load files and a zip", async () => {
    const seeded = listProductions(VALSARA);
    expect(seeded.length).toBeGreaterThanOrEqual(1);
    expect(seeded[0].bates[seeded[0].docIds[0]].begin).toBe("MERIDIAN-0000001");
    const p = await createProduction({ matterId: VALSARA, name: "Test vol", prefix: "MERIDIAN", ids: ["ed_vls_0002", "ed_vls_0001", "ed_vls_0007", "ed_vls_0003"] });
    expect(p.docIds[0]).toBe("ed_vls_0002");
    expect(p.startNumber).toBeGreaterThan(1); // continues the seeded MERIDIAN sequence
    expect(p.status).toBe("draft");
    const qc = runProductionQc(p.id);
    expect(qc.qc?.ok).toBe(true);
    const inQc = updateProduction(p.id, { status: "qc" });
    expect(inQc.status).toBe("qc");
    const fin = updateProduction(p.id, { status: "final" });
    expect(fin.status).toBe("final");
    expect(fin.finalizedAt).toBeTruthy();
    expect(() => updateProduction(p.id, { status: "draft" })).toThrow(/cannot be reopened/);
    const { dat, opt } = productionLoadFiles(p.id);
    expect(dat.split("\r\n").filter(Boolean).length).toBe(5);
    expect(parseOpt(opt).length).toBe(4);
    const pdf = await renderProductionPdf(db().edocs.get("ed_vls_0001")!, p.bates.ed_vls_0001, [{ id: "r", matterId: VALSARA, docId: "ed_vls_0001", kind: "page", page: 1, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.1 }, reason: "privilege", label: "REDACTED", createdBy: "p", createdAt: "t" }], "CONFIDENTIAL");
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    const zip = await buildProductionZip(p.id, { maxPdfDocs: 2 });
    expect(zip.files).toBeGreaterThanOrEqual(2 + 4 + 2 + 2);
    expect(zip.filename).toMatch(/\.zip$/);
    const JSZip = (await import("jszip")).default;
    const z = await JSZip.loadAsync(zip.bytes);
    const names = Object.keys(z.files);
    expect(names.some((n) => n.endsWith(".dat"))).toBe(true);
    expect(names.some((n) => n.endsWith(".opt"))).toBe(true);
    expect(names.filter((n) => /IMAGES\/.*\.pdf$/.test(n)).length).toBe(2);
    expect(names.filter((n) => /TEXT\/.*\.txt$/.test(n)).length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe("saved searches, search-term reports, layouts, history, privilege export", () => {
  it("stores saved searches with sharing and validates the query", () => {
    const mine = listSavedSearches(VALSARA, PEOPLE.arjunMehra);
    expect(mine.map((s) => s.id)).toContain(REVIEW_SEED_IDS.savedSearches.eightE);
    expect(mine.map((s) => s.id)).not.toContain(REVIEW_SEED_IDS.savedSearches.privReview); // private to Raman
    expect(listSavedSearches(VALSARA, PEOPLE.priyaRaman).map((s) => s.id)).toContain(REVIEW_SEED_IDS.savedSearches.privReview);
    const s = createSavedSearch({ matterId: VALSARA, name: "Wells", q: '"monitoring well" w/5 plume', shared: false });
    expect(s.ownerId).toBe(PEOPLE.arjunMehra);
    expect(() => createSavedSearch({ matterId: VALSARA, name: "bad", q: 'liver AND ("serum' })).toThrow(/Query problems/);
  });
  it("counts hits, unique documents and families per term and exports CSV", () => {
    const r = searchTermReport({ matterId: VALSARA, terms: ["bioassay", '"monitoring well"', "liver w/5 study", "zzzz-nothing"] });
    expect(r.rows.length).toBe(4);
    expect(r.rows[0].uniqueDocs).toBeGreaterThan(0);
    expect(r.rows[0].hits).toBeGreaterThanOrEqual(r.rows[0].uniqueDocs);
    expect(r.rows[0].withFamilies).toBeGreaterThanOrEqual(r.rows[0].uniqueDocs);
    expect(r.rows[3].uniqueDocs).toBe(0);
    expect(r.totalUnique).toBeGreaterThan(0);
    expect(r.totalUnique).toBeLessThanOrEqual(r.corpus);
    const csv = searchTermReportCsv(r);
    expect(csv.split("\r\n")[0]).toBe("Term,Hits,Unique documents,Families,Documents with families,Warnings");
    expect(csv).toContain("TOTAL (unique)");
  });
  it("saves grid layouts per user (upsert by name)", () => {
    saveLayout({ name: "Privilege pass", hiddenColumns: ["score"], columnWidths: { subject: 300 }, density: "comfortable" });
    saveLayout({ name: "privilege pass", hiddenColumns: ["score", "type"], columnWidths: {}, density: "compact" });
    const list = listLayouts();
    expect(list.filter((l) => l.name.toLowerCase() === "privilege pass").length).toBe(1);
    expect(list[0].hiddenColumns).toEqual(["score", "type"]);
    expect(listLayouts(PEOPLE.eshaMathur)).toEqual([]);
  });
  it("reads per-document audit history from the audit log", () => {
    updateCoding("ed_vls_0050", { hot: true, issues: ["CUS-01"] }, PEOPLE.eshaMathur);
    const h = docHistory("ed_vls_0050");
    expect(h.length).toBeGreaterThan(0);
    expect(h[0].summary).toMatch(/Coded: /);
    expect(h[0].actorName).toBe("Esha Mathur");
    expect(h[0].fields).toEqual(expect.arrayContaining(["hot"]));
  });
  it("fills description templates and builds the xlsx workbook", () => {
    const t = DESCRIPTION_TEMPLATES.find((x) => x.id === "wp-anticipation")!;
    expect(fillTemplate(t, { type: "Memorandum", author: "Manish Sood (counsel)", recipients: "", topic: "regulatory reporting obligations" })).toMatch(/^Memorandum prepared by or at the direction of Manish Sood/);
    const wb = privilegeLogWorkbook([{ id: "pl", matterId: VALSARA, docId: "d", bates: "MFC-0041921 – MFC-0041922", date: "2001-03-19", author: "Rohit Kapur", recipients: ["Anil Prasad"], docType: "Email", basis: "Attorney-client", description: "Email providing legal advice.", status: "review", subject: "s", custodianName: "Rohit Kapur" }], { matterName: "Valsara v. Meridian" });
    expect(wb.SheetNames).toEqual(["Privilege log", "Legend"]);
    const sheet = wb.Sheets["Privilege log"];
    expect(sheet.B2.v).toBe("MFC-0041921");
    expect(sheet.C2.v).toBe("MFC-0041922");
    expect(sheet.K2.v).toBe("In review");
  });
});

// ---------------------------------------------------------------------------
describe("route handlers", () => {
  it("lists and creates batches, walks them and patches", async () => {
    const list = await batchesGET(req(`/api/ediscovery/batches?matter=${VALSARA}`));
    expect(list.status).toBe(200);
    const j = (await list.json()) as { batches: { id: string; progress: { total: number } }[] };
    expect(j.batches.length).toBeGreaterThanOrEqual(3);
    const created = await batchesPOST(req("/api/ediscovery/batches", { method: "POST", json: { matterId: VALSARA, name: "Route batch", ids: ["ed_vls_0051", "ed_vls_0052"], qcSamplePercent: 50 } }));
    expect(created.status).toBe(201);
    const { batches } = (await created.json()) as { batches: { id: string }[] };
    const one = await batchGET(req("/x"), params(batches[0].id));
    expect(((await one.json()) as { batch: { progress: { total: number } } }).batch.progress.total).toBe(2);
    const next = await nextGET(req(`/x?current=`), params(batches[0].id));
    expect(((await next.json()) as { id: string | null }).id).toBeTruthy();
    const patched = await batchPATCH(req("/x", { method: "PATCH", json: { priority: "low", assigneeId: PEOPLE.meeraLobo } }), params(batches[0].id));
    expect(((await patched.json()) as { batch: { priority: string; assigneeName: string } }).batch).toMatchObject({ priority: "low", assigneeName: "Meera Lobo" });
    expect((await batchGET(req("/x"), params("nope"))).status).toBe(404);
    // QC decision through the document PATCH
    const b = (await ((await batchGET(req("/x"), params(batches[0].id))).json() as Promise<{ batch: { qcSampleIds: string[] } }>)).batch;
    const qcDoc = b.qcSampleIds[0];
    const res = await docPATCH(req("/x", { method: "PATCH", json: { coding: { responsive: false }, batchId: batches[0].id, qc: true } }), params(qcDoc));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { qc: { agree: boolean } }).qc).toBeDefined();
  });
  it("serves saved searches, redactions, productions, term reports, history and search paging", async () => {
    expect((await savedGET(req(`/api/ediscovery/saved-searches?matter=${VALSARA}`))).status).toBe(200);
    const bad = await savedPOST(req("/x", { method: "POST", json: { matterId: VALSARA, name: "x", q: "(unbalanced" } }));
    expect(bad.status).toBe(422);
    const red = await redPOST(req("/x", { method: "POST", json: { docId: "ed_vls_0003", kind: "page", page: 1, rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, reason: "phi" } }));
    expect(red.status).toBe(201);
    const { redaction } = (await red.json()) as { redaction: { id: string; label: string } };
    expect(redaction.label).toBe("REDACTED — PHI");
    const listed = (await (await redGET(req("/x?doc=ed_vls_0003"))).json()) as { redactions: unknown[] };
    expect(listed.redactions.length).toBe(1);
    expect((await redDELETE(req(`/x?id=${redaction.id}`))).status).toBe(200);
    const prods = (await (await prodGET(req(`/x?matter=${VALSARA}`))).json()) as { productions: { id: string; docCount: number; batesRange: { begin: string } }[] };
    expect(prods.productions.find((p) => p.id === REVIEW_SEED_IDS.production)!.docCount).toBeGreaterThan(20);
    const made = await prodPOST(req("/x", { method: "POST", json: { matterId: VALSARA, name: "Route prod", prefix: "RT", ids: ["ed_vls_0003", "ed_vls_0004"] } }));
    expect(made.status).toBe(201);
    const { production } = (await made.json()) as { production: { id: string } };
    const detail = (await (await prodOneGET(req("/x"), params(production.id))).json()) as { rows: { begin: string }[] };
    expect(detail.rows[0].begin).toBe("RT-0000001");
    const toQc = await prodPATCH(req("/x", { method: "PATCH", json: { status: "qc" } }), params(production.id));
    expect(((await toQc.json()) as { production: { status: string; qc: { ok: boolean } } }).production.status).toBe("qc");
    const dat = await prodExportGET(req("/x?format=dat"), params(production.id));
    expect(dat.headers.get("Content-Disposition")).toContain(".dat");
    expect(await dat.text()).toContain("RT-0000001");
    const terms = await termsPOST(req("/x?format=csv", { method: "POST", json: { matterId: VALSARA, terms: ["bioassay", "liver"] } }));
    expect(terms.headers.get("Content-Type")).toContain("text/csv");
    const hist = (await (await historyGET(req("/x"), params("ed_vls_0050"))).json()) as { history: unknown[]; batches: unknown[] };
    expect(hist.history.length).toBeGreaterThan(0);
    const page = (await (await searchPOST(req("/x", { method: "POST", json: { matterId: VALSARA, page: 3, limit: 5, groupBy: "thread" } }))).json()) as { page: number; offset: number; groupBy: string };
    expect(page).toMatchObject({ page: 3, offset: 10, groupBy: "thread" });
    const xlsx = await privExportGET(req(`/x?matter=${VALSARA}&format=xlsx`));
    expect(xlsx.headers.get("Content-Type")).toContain("spreadsheetml");
    expect(Number(xlsx.headers.get("Content-Length"))).toBeGreaterThan(2000);
  });
});
