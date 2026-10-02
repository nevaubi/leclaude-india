import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import type { EDocument } from "@/lib/types/domain";
import { findQuote, foldText, quoteConfidenceCap, verifyQuotes } from "@/modules/ediscovery/quotes";
import { applyCodingKey, batchDueTone, codingKeyAction, cssToPageRect, custodianBars, dateBars, dateGranularity, dragRect, groupMemberIds, nextUncodedRow, pageOfOffset, pageRectToCss, pageSpans, parsePageMap, splitRanges, suggestionAgrees, suggestionCall } from "@/modules/ediscovery/components/review-helpers";
import { splitPages } from "@/modules/ediscovery/production-export";
import { DESCRIPTION_TEMPLATES, nextPrivilegeStatuses, templatesForBasis } from "@/modules/ediscovery/privilege-templates";
import { bulkPreview, bulkCode, expandFamilies, searchDocuments } from "@/modules/ediscovery/service";
import { inconsistentNearDuplicates, unlinkedNearDuplicatePairs } from "@/modules/ediscovery/scans";
import { renderProductionPdfWithMap } from "@/modules/ediscovery/production-export";
import { POST as bulkPOST } from "@/app/api/ediscovery/docs/bulk/route";
import { GET as pdfGET } from "@/app/api/ediscovery/docs/[id]/pdf/route";
import { PATCH as privPATCH, GET as privGET } from "@/app/api/ediscovery/privilege-log/route";

const VALSARA = MATTERS.valsara;
const req = (url: string, init?: { method?: string; json?: unknown }) => new NextRequest(`http://localhost${url}`, { method: init?.method ?? "GET", ...(init?.json !== undefined ? { body: JSON.stringify(init.json), headers: { "Content-Type": "application/json" } } : {}) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(() => { resetSqlite(); db(); });

// ---------------------------------------------------------------------------
describe("verified quotes", () => {
  const text = "The liver effects are real — the “rat study” confirms serum\n\npersistence in the recovery group.";
  it("folds quotes, dashes and whitespace and returns offsets into the original text", () => {
    expect(foldText("A  b\tC").folded).toBe("a b c");
    const hit = findQuote(text, '"rat study" confirms serum persistence');
    expect(hit).not.toBeNull();
    // wrapping quote marks the model added around the excerpt are stripped before matching
    expect(text.slice(hit!.start, hit!.end)).toBe("rat study” confirms serum\n\npersistence");
    expect(findQuote(text, "liver effects are fictional")).toBeNull();
    expect(findQuote(text, "short")).toBeNull();
  });
  it("marks excerpts verified only when found and caps confidence per miss", () => {
    const quotes = verifyQuotes(text, ["the liver effects are real", "the liver effects are real", "management approved the cover-up", ""]);
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toMatchObject({ verified: true, start: 0 });
    expect(quotes[1]).toMatchObject({ verified: false, text: "management approved the cover-up" });
    expect(quoteConfidenceCap(quotes)).toBeCloseTo(0.7);
    expect(quoteConfidenceCap([quotes[0]])).toBe(1);
    expect(quoteConfidenceCap([quotes[1], quotes[1], quotes[1], quotes[1]])).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
describe("viewer helpers", () => {
  it("page spans match the production renderer's page split", () => {
    const doc = db().edocs.get("ed_vls_0001")!;
    const spans = pageSpans(doc.text, doc.pages ?? 1);
    const pages = splitPages(doc.text, doc.pages ?? 1);
    expect(spans.length).toBe(pages.length);
    spans.forEach((s, i) => expect(doc.text.slice(s.start, s.end)).toBe(pages[i]));
    expect(pageOfOffset(spans, spans[spans.length - 1].start + 1)).toBe(spans.length);
    const ff = pageSpans("a\n\nb\fc\n\nd", 2);
    expect(ff).toEqual([{ start: 0, end: 4 }, { start: 5, end: 9 }]);
    expect(pageSpans("only", 3)).toEqual([{ start: 0, end: 4 }]);
  });
  it("splits text into plain / marked pieces and drops overlapping later ranges", () => {
    const pieces = splitRanges("hello brave new world", [{ start: 6, end: 11, kind: "redaction", id: "r1" }, { start: 8, end: 14, kind: "jump" }, { start: 16, end: 99, kind: "jump" }]);
    expect(pieces.map((p) => [p.kind, p.text])).toEqual([["plain", "hello "], ["redaction", "brave"], ["plain", " new "], ["jump", "world"]]);
  });
  it("maps normalised page rects to css and back", () => {
    const css = pageRectToCss({ x: 0.1, y: 0.2, w: 0.5, h: 0.1 }, 612, 792);
    expect(css.left).toBeCloseTo(54 + 0.1 * 504, 3);
    expect(css.top).toBeCloseTo(54 + 0.2 * 684, 3);
    const back = cssToPageRect(css, 612, 792)!;
    expect(back).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.1 });
    expect(cssToPageRect({ left: 0, top: 0, width: 3, height: 3 }, 612, 792)).toBeNull();
    // a drag entirely outside the printable area is nothing; one that crosses the margin is clamped to it
    expect(cssToPageRect(dragRect(700, 10, 650, 60), 612, 792)).toBeNull();
    const clamped = cssToPageRect(dragRect(500, 100, 700, 160), 612, 792)!;
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(1);
    expect(clamped.w).toBeGreaterThan(0.1);
    expect(parsePageMap("1,1,2", 3)).toEqual([1, 1, 2]);
    expect(parsePageMap("1,1", 3)).toEqual([1, 2, 3]);
  });
  it("derives the suggested call and coding key actions", () => {
    expect(suggestionCall(84)).toBe("R");
    expect(suggestionCall(12)).toBe("NR");
    expect(suggestionCall(55)).toBe("?");
    expect(suggestionCall(null)).toBeNull();
    expect(suggestionAgrees({ responsive: false }, 84)).toBe(false);
    expect(suggestionAgrees({ responsive: true }, 84)).toBe(true);
    expect(suggestionAgrees({}, 84)).toBeNull();
    expect(codingKeyAction("r")).toEqual({ kind: "responsive", value: true });
    expect(codingKeyAction("N")).toEqual({ kind: "responsive", value: false });
    expect(codingKeyAction("3")).toEqual({ kind: "issue", index: 2 });
    expect(codingKeyAction("x")).toEqual({ kind: "next-uncoded" });
    expect(codingKeyAction("q")).toBeNull();
    const codes = ["A", "B", "C"];
    expect(applyCodingKey({ responsive: true }, { kind: "responsive", value: true }, codes)).toEqual({ responsive: null });
    expect(applyCodingKey({}, { kind: "privileged" }, codes)).toEqual({ privileged: true, privilegeBasis: "attorney-client" });
    expect(applyCodingKey({ privileged: true, privilegeBasis: "work-product" }, { kind: "privileged" }, codes)).toEqual({ privileged: false, privilegeBasis: undefined });
    expect(applyCodingKey({ issues: ["A"] }, { kind: "issue", index: 0 }, codes)).toEqual({ issues: [] });
    expect(applyCodingKey({ issues: ["A"] }, { kind: "issue", index: 2 }, codes)).toEqual({ issues: ["A", "C"] });
    expect(applyCodingKey({}, { kind: "issue", index: 8 }, codes)).toBeNull();
    const rows = [{ id: "a", coding: { responsive: true } }, { id: "b", coding: {} }, { id: "c", coding: { responsive: false } }, { id: "d", coding: {} }];
    expect(nextUncodedRow(rows, "b")).toBe("d");
    expect(nextUncodedRow(rows, "d")).toBe("b");
    expect(nextUncodedRow(rows.slice(0, 1), "a")).toBeNull();
    expect(groupMemberIds([{ id: "a", groupKey: "g" }, { id: "b", groupKey: "g" }, { id: "c" }], "b")).toEqual(["a", "b"]);
    expect(groupMemberIds([{ id: "c" }], "c")).toEqual(["c"]);
  });
  it("buckets custodians and dates for the histograms", () => {
    const bars = custodianBars(Array.from({ length: 11 }, (_, i) => ({ value: `p${i}`, label: `Person ${i}`, count: 20 - i })), ["p1"], 8);
    expect(bars.length).toBe(9);
    expect(bars[1]).toMatchObject({ key: "p1", selected: true });
    expect(bars[8]).toMatchObject({ others: true, count: 12 + 11 + 10 });
    const months = [{ year: "2001-01", count: 2 }, { year: "2001-04", count: 1 }];
    expect(dateGranularity(months)).toBe("month");
    expect(dateGranularity([{ year: "1999-01", count: 1 }, { year: "2012-01", count: 1 }])).toBe("year");
    const bars2 = dateBars(months, [], ["2001-04"], [], "month");
    expect(bars2.map((b) => b.key)).toEqual(["2001-01", "2001-02", "2001-03", "2001-04"]);
    expect(bars2[3]).toMatchObject({ selected: true, count: 1, label: "Apr 01" });
    const years = dateBars([], [{ year: "1999", count: 1 }, { year: "2001", count: 3 }], [], ["2001"], "year");
    expect(years.map((b) => [b.key, b.count, b.selected])).toEqual([["1999", 1, false], ["2000", 0, false], ["2001", 3, true]]);
    expect(batchDueTone("2026-01-01", "open", "2026-02-01")).toBe("destructive");
    expect(batchDueTone("2026-02-03", "open", "2026-02-01")).toBe("warning");
    expect(batchDueTone("2026-03-01", "open", "2026-02-01")).toBe("muted");
    expect(batchDueTone("2026-01-01", "complete", "2026-02-01")).toBe("muted");
  });
  it("offers description templates per basis and a status ladder", () => {
    expect(templatesForBasis("Attorney-client; Work product").map((t) => t.basis)).toEqual(expect.arrayContaining(["Attorney-client", "Work product"]));
    expect(templatesForBasis("Unknown")).toEqual(DESCRIPTION_TEMPLATES);
    expect(nextPrivilegeStatuses("draft")).toEqual(["review"]);
    expect(nextPrivilegeStatuses("review")).toEqual(["final", "draft"]);
    expect(nextPrivilegeStatuses("final")).toEqual(["review"]);
  });
});

// ---------------------------------------------------------------------------
describe("bulk coding preview and families", () => {
  it("expands families and reports what would change before anything is written", () => {
    const fam = expandFamilies(["ed_vls_0001"]);
    expect(fam.ids.sort()).toEqual(["ed_vls_0001", "ed_vls_0002", "ed_vls_0007"]);
    expect(fam.added).toBe(2);
    const before = db().edocs.get("ed_vls_0001")!.coding.responsive;
    const preview = bulkPreview({ ids: ["ed_vls_0001"], patch: { responsive: true, hot: true }, addIssues: ["TOX-01"], includeFamilies: true, dryRun: true });
    expect(preview.total).toBe(3);
    expect(preview.addedFamily).toBe(2);
    expect(preview.fields.map((f) => f.label)).toEqual(["Responsive", "Hot", "Add issue codes"]);
    expect(preview.fields[0].changed + preview.unchanged).toBeGreaterThanOrEqual(0);
    expect(db().edocs.get("ed_vls_0001")!.coding.responsive).toBe(before); // dry run wrote nothing
    const r = bulkCode({ ids: ["ed_vls_0051"], patch: { hot: true }, includeFamilies: true });
    expect(r.updated).toBeGreaterThanOrEqual(1);
    expect(db().edocs.get("ed_vls_0051")!.coding.hot).toBe(true);
  });
  it("filters by month facet and reports month buckets against the other filters", async () => {
    const all = await searchDocuments({ matterId: VALSARA, limit: 5000 });
    const month = all.facets.months[0].year;
    const res = await searchDocuments({ matterId: VALSARA, filters: { months: [month] }, limit: 5000 });
    expect(res.total).toBe(all.facets.months[0].count);
    expect(res.hits.every((h) => h.date.startsWith(month))).toBe(true);
    // the month facet is counted with every *other* filter applied, so it still lists the whole distribution while filtered
    expect(res.facets.months.length).toBe(all.facets.months.length);
  });
});

// ---------------------------------------------------------------------------
describe("near-duplicate scan helpers", () => {
  it("finds unlinked pairs and inconsistent coding without changing anything", () => {
    const base = db().edocs.get("ed_vls_0011")!;
    const docs: EDocument[] = [
      { ...base, id: "nd_a", bates: "ND-0000001", nearDuplicateIds: undefined, nearDuplicateScores: undefined, hash: "h1", isDuplicateOf: undefined, coding: { responsive: true } },
      { ...base, id: "nd_b", bates: "ND-0000002", text: base.text + "\nDraft 2 — please treat as confidential.", nearDuplicateIds: undefined, nearDuplicateScores: undefined, hash: "h2", isDuplicateOf: undefined, coding: { responsive: false } },
    ];
    const unlinked = unlinkedNearDuplicatePairs(docs);
    expect(unlinked.length).toBe(1);
    expect(unlinked[0].score).toBeGreaterThan(0.5);
    const linked = docs.map((d) => ({ ...d, nearDuplicateIds: [d.id === "nd_a" ? "nd_b" : "nd_a"] }));
    expect(unlinkedNearDuplicatePairs(linked)).toEqual([]);
    const inconsistent = inconsistentNearDuplicates(linked);
    expect(inconsistent.length).toBe(1);
    expect(inconsistent[0].fields).toEqual(["responsive"]);
    expect(db().edocs.get("nd_a")).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
describe("routes: bulk dry run, image surrogate, privilege-log bulk status", () => {
  it("returns the preview for dryRun and applies otherwise", async () => {
    const dry = await bulkPOST(req("/x", { method: "POST", json: { ids: ["ed_vls_0003"], patch: { responsive: false }, dryRun: true } }));
    expect(dry.status).toBe(200);
    const { preview } = (await dry.json()) as { preview: { total: number; fields: { label: string }[] } };
    expect(preview.total).toBe(1);
    expect(preview.fields[0].label).toBe("Responsive");
    const applied = await bulkPOST(req("/x", { method: "POST", json: { ids: ["ed_vls_0003"], patch: { hot: false } } }));
    expect(((await applied.json()) as { updated: number }).updated).toBe(1);
  });
  it("renders the image surrogate with a page map header", async () => {
    const doc = db().edocs.get("ed_vls_0001")!;
    const { bytes, pageMap } = await renderProductionPdfWithMap(doc, { begin: doc.bates, pages: doc.pages ?? 1 }, [], "");
    expect(pageMap.length).toBeGreaterThanOrEqual(doc.pages ?? 1);
    expect(pageMap[0]).toBe(1);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const res = await pdfGET(req("/x"), params(doc.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("X-Page-Map")).toBe(pageMap.join(","));
    expect((await pdfGET(req("/x"), params("nope"))).status).toBe(404);
  });
  it("moves several privilege-log entries through the status workflow", async () => {
    const list = (await (await privGET(req(`/x?matter=${VALSARA}`))).json()) as { entries: { id: string; status: string }[] };
    const ids = list.entries.slice(0, 2).map((e) => e.id);
    expect(ids.length).toBe(2);
    const res = await privPATCH(req("/x", { method: "PATCH", json: { ids, patch: { status: "review" } } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: number }).updated).toBe(2);
    expect(db().privilegeLog.get(ids[0])!.status).toBe("review");
    expect((await privPATCH(req("/x", { method: "PATCH", json: { ids, patch: { status: "served" } } }))).status).toBe(422);
    const one = await privPATCH(req("/x", { method: "PATCH", json: { id: ids[0], patch: { status: "final", templateId: "ac-advice" } } }));
    expect(((await one.json()) as { entry: { status: string; templateId: string } }).entry).toMatchObject({ status: "final", templateId: "ac-advice" });
    expect(PEOPLE.arjunMehra).toBeTruthy();
  });
});
