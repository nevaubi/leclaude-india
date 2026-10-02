import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { blobs, db, resetSqlite } from "@/lib/db";
import type { EditProposal } from "@/modules/office/shared/types";
import type { OfficeAgentContext } from "@/modules/office/shared/route-factory";
import { applyModel, compressPdf, extractPages, fillFormFields, mergePdfs } from "@/modules/office/pdf/apply";
import { extractPdf, readFormFields, readPageSizes } from "@/modules/office/pdf/extract";
import { blankPdf, generatePdf, parseRuns } from "@/modules/office/pdf/generate";
import { activePages, buildModel, displayToSource, formatBates, normalizeModel, parsePageRange, sourceToDisplay, textOfModel, type PdfModel } from "@/modules/office/pdf/model";
import { applyOp, opTitle, resolvePages } from "@/modules/office/pdf/proposals";
import { parseSnapshot, renderSnapshot, type PdfSnapshot } from "@/modules/office/pdf/snapshot";
import { pdfAgentTools, isPdfEditingTool } from "@/modules/office/pdf/agent-tools";
import { PDF_SUGGESTIONS, pdfInstructions } from "@/modules/office/pdf/agent";
import { joinRuns, mergeLineRects, PII_PATTERNS, runsToText, searchRuns } from "@/modules/office/pdf/text-search";
import { SPEC_BUILDERS, cmoSpec, custodialExcerptSpec, protectiveOrderSpec } from "@/modules/office/pdf/template-specs";
import { PDF_TEMPLATES } from "@/modules/office/pdf/templates";
import { importDocument } from "@/modules/office/pdf/import";
import { seedPdf, SEEDED_PDF_DOC_IDS } from "@/modules/office/pdf/seed";
import { burnIn, compressDocument, convertToWord, ensureExtracted, loadPdf, materialize, mergeInto, modelFromBytes, resolveQuotedAnnotations, splitToNewDocument, textToMarkdown } from "@/modules/office/pdf/service";

beforeAll(() => { resetSqlite(); });

const NOW = "2026-09-24T10:00:00.000Z";
let cmoBytes: Uint8Array;
let formBytes: Uint8Array;
let cmoModel: PdfModel;

async function generated() {
  if (!cmoBytes) cmoBytes = await generatePdf(cmoSpec());
  if (!formBytes) formBytes = await generatePdf(protectiveOrderSpec());
  if (!cmoModel) { const ex = await extractPdf(cmoBytes); cmoModel = buildModel({ sourceBlobId: "test", pageSizes: ex.pages, textIndex: ex.pages.map((p) => ({ page: p.page, text: p.text })), meta: { outline: ex.outline, fields: ex.fields } }); }
  return { cmoBytes, formBytes, model: structuredClone(cmoModel) };
}

function makeCtx(model: PdfModel, overrides: Partial<OfficeAgentContext<PdfSnapshot>> = {}) {
  const proposals: EditProposal[] = [];
  const snapshot: PdfSnapshot = { model, title: "Test PDF", docId: "doc_test", comments: [] };
  const ctx: OfficeAgentContext<PdfSnapshot> = {
    mode: "draft", scope: null, research: false, snapshot, matter: null, docTitle: "Test PDF", context: {}, proposals, findings: [],
    emit: () => {},
    propose: (p) => { const full: EditProposal = { id: `p${proposals.length + 1}`, status: "pending", ...p }; proposals.push(full); return full; },
    finding: (f) => ({ id: "f", ...f }),
    ...overrides,
  };
  return { ctx, proposals, snapshot };
}

function tool(tools: ReturnType<typeof pdfAgentTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return (args: Record<string, unknown>) => (t.execute as (a: unknown, c: unknown) => unknown)(args, { emit: () => {}, state: {} });
}

function applyAll(model: PdfModel, proposals: EditProposal[]) { return proposals.reduce((m, p) => applyOp(m, p.payload), model); }

// ---------------------------------------------------------------------------
describe("generation and extraction", () => {
  it("typesets a multi-page order with caption, outline, table and Bates numbers", async () => {
    const { cmoBytes } = await generated();
    expect(new TextDecoder("latin1").decode(cmoBytes.subarray(0, 5))).toBe("%PDF-");
    const ex = await extractPdf(cmoBytes);
    expect(ex.pageCount).toBeGreaterThanOrEqual(3);
    expect(ex.pages[0].text).toContain("PROCEDURAL ORDER NO. 5");
    expect(ex.pages[0].text).toContain("Girish Hegde");
    expect(ex.pages[0].text).toMatch(/Page 1 of \d/);
    expect(ex.outline.length).toBeGreaterThanOrEqual(4);
    expect(ex.outline.map((o) => o.title)).toEqual(expect.arrayContaining([expect.stringContaining("Tier 2 Custodians"), expect.stringContaining("Search Methodology")]));
    expect(ex.meta.producer).toContain("pdf-lib");
    const sizes = await readPageSizes(cmoBytes);
    expect(sizes[0]).toEqual({ width: 612, height: 792, rotation: 0 });
    // every page has text and the runs carry positions
    for (const p of ex.pages) { expect(p.text.length).toBeGreaterThan(100); expect(p.runs.every((r) => Number.isFinite(r.x) && Number.isFinite(r.y))).toBe(true); }
  }, 30_000);

  it("parses inline markdown runs and supports newlines in paragraphs", async () => {
    expect(parseRuns("a **b** *c* ***d***")).toEqual([{ text: "a " }, { text: "b", bold: true }, { text: " " }, { text: "c", italic: true }, { text: " " }, { text: "d", bold: true, italic: true }]);
    const bytes = await generatePdf({ title: "t", blocks: [{ type: "paragraph", text: "From: Girish Hegde\nTo: Nandini Bose\nSubject: MW-7" }] });
    const ex = await extractPdf(bytes);
    expect(ex.pages[0].text).toMatch(/From: Girish Hegde\s*\n\s*To: Nandini Bose/);
  });

  it("detects AcroForm fields with values, options and pages", async () => {
    const { formBytes } = await generated();
    const fields = await readFormFields(formBytes);
    const names = fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["ack_name", "ack_role", "ack_aeo"]));
    expect(fields.find((f) => f.name === "ack_role")).toMatchObject({ type: "dropdown", options: expect.arrayContaining(["Expert witness"]) });
    expect(fields.find((f) => f.name === "ack_aeo")).toMatchObject({ type: "checkbox", value: false });
    expect(fields.every((f) => typeof f.page === "number" && f.rect)).toBe(true);
    const ex = await extractPdf(formBytes);
    expect(ex.meta.hasForm).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe("text search", () => {
  it("joins runs into lines and maps matches back to rectangles", () => {
    const runs = [{ s: "Meet and confer by", x: 72, y: 700, w: 100, h: 11 }, { s: " October 14, 2026.", x: 172, y: 700, w: 90, h: 11, eol: true }, { s: "Second line", x: 72, y: 685, w: 60, h: 11 }];
    const { text } = joinRuns(runs);
    expect(text).toBe("Meet and confer by October 14, 2026.\nSecond line");
    expect(runsToText(runs)).toBe(text);
    const hits = searchRuns(runs, "october 14, 2026");
    expect(hits.length).toBe(1);
    expect(hits[0].rects.length).toBe(1);
    expect(hits[0].rects[0].x).toBeGreaterThan(172);
    expect(hits[0].snippet).toContain("«October 14, 2026»");
    expect(searchRuns(runs, "\\d{4}", { regex: true }).map((h) => h.text)).toEqual(["2026"]);
    expect(searchRuns(runs, "line", { wholeWord: true }).length).toBe(1);
    expect(searchRuns(runs, "(", { regex: true })).toEqual([]);
  });
  it("merges rects on the same baseline", () => {
    const merged = mergeLineRects([{ x: 10, y: 100, w: 20, h: 10 }, { x: 31, y: 100, w: 20, h: 10 }, { x: 10, y: 80, w: 20, h: 10 }]);
    expect(merged.length).toBe(2);
    expect(merged[0]).toMatchObject({ x: 10, w: 41 });
  });
  it("PII presets find SSNs, accounts, phones and e-mails in the custodial excerpt", async () => {
    const bytes = await generatePdf(custodialExcerptSpec());
    const ex = await extractPdf(bytes);
    const runs = ex.pages[0].runs;
    const find = (id: string) => searchRuns(runs, PII_PATTERNS.find((p) => p.id === id)!.pattern, { regex: true }).map((h) => h.text);
    expect(find("ssn")).toContain("412-55-8367");
    expect(find("phone")).toEqual(expect.arrayContaining(["(843) 555-0192"]));
    expect(find("email")).toEqual(expect.arrayContaining(["marcus.delgado@konkanenv.example"]));
    expect(find("account").join(" ")).toContain("4471029835");
    expect(find("dob").join(" ")).toContain("03/14/1971");
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe("model and proposals", () => {
  it("normalizes, translates page numbers and round-trips through JSON", async () => {
    const { model } = await generated();
    const json = JSON.parse(JSON.stringify(model));
    const back = normalizeModel(json);
    expect(back).toEqual(model);
    expect(normalizeModel({ pages: [{ index: 2, order: 1 }, { index: 1, order: 0 }], annotations: [{ type: "highlight", page: 1 }] }).pages.map((p) => p.index)).toEqual([1, 2]);
    expect(normalizeModel(null).pages).toEqual([]);
    expect(displayToSource(model, 1)).toBe(1);
    expect(sourceToDisplay(model, 2)).toBe(2);
    expect(parsePageRange("1-2, 4, 9-12", 5)).toEqual([1, 2, 4]);
    expect(parsePageRange("3-9", 5)).toEqual([3, 4, 5]);
    expect(formatBates({ prefix: "MFC-", start: 60000, digits: 7 }, 3)).toBe("MFC-0060003");
    expect(textOfModel(model)).toContain("--- Page 2 ---");
  });

  it("applies page ops (rotate, delete, restore, reorder, insert blank) and keeps source numbers stable", async () => {
    const { model } = await generated();
    const n = activePages(model).length;
    let m = applyOp(model, { op: "rotate_pages", sourcePages: [1], delta: 90 });
    expect(m.pages[0].rotation).toBe(90);
    m = applyOp(m, { op: "rotate_pages", sourcePages: [1], delta: -90 });
    expect(m.pages[0].rotation).toBe(0);
    m = applyOp(m, { op: "delete_pages", sourcePages: [2] });
    expect(activePages(m).length).toBe(n - 1);
    expect(sourceToDisplay(m, 3)).toBe(2);
    expect(sourceToDisplay(m, 2)).toBeNull();
    m = applyOp(m, { op: "restore_pages", sourcePages: [2] });
    expect(activePages(m).map((p) => p.index)).toEqual(model.pages.map((p) => p.index));
    m = applyOp(m, { op: "reorder_pages", order: [3, 1] });
    expect(activePages(m).map((p) => p.index).slice(0, 2)).toEqual([3, 1]);
    m = applyOp(m, { op: "insert_blank_page", afterDisplay: 1, id: "pg_blank" });
    expect(activePages(m)[1]).toMatchObject({ id: "pg_blank", blank: true, width: 612, height: 792 });
    expect(activePages(m).every((p, i) => p.order === i)).toBe(true);
    expect(() => applyOp(m, { op: "delete_pages", sourcePages: activePages(m).map((p) => p.index) })).toThrow(/every page/);
    expect(() => applyOp(m, { op: "reorder_pages", order: [99] })).toThrow();
    expect(resolvePages(m, "all").length).toBe(activePages(m).length);
    expect(() => resolvePages(m, [99])).toThrow(/No page 99/);
    expect(opTitle({ op: "delete_pages", sourcePages: [1, 2] })).toBe("Delete 2 pages");
  });

  it("applies annotation, form, bookmark, Bates and decoration ops", async () => {
    const { model } = await generated();
    let m = applyOp(model, { op: "add_annotations", annotations: [{ id: "a1", page: 1, type: "highlight", rects: [{ x: 1, y: 1, w: 5, h: 5 }], color: "#FACC15", opacity: 0.4, author: "t", createdAt: NOW }] });
    m = applyOp(m, { op: "update_annotation", id: "a1", patch: { text: "note" } });
    m = applyOp(m, { op: "resolve_annotations", ids: ["a1"], resolved: true });
    expect(m.annotations[0]).toMatchObject({ text: "note", resolved: true });
    m = applyOp(m, { op: "remove_annotations", ids: ["a1"] });
    expect(m.annotations).toEqual([]);
    expect(() => applyOp(m, { op: "add_annotations", annotations: [{ id: "x", page: 99, type: "note", rects: [], color: "#000", opacity: 1, author: "t", createdAt: NOW }] })).toThrow(/unknown page/);
    m = applyOp(m, { op: "fill_form", values: { signer: "JW" } });
    m = applyOp(m, { op: "fill_form", values: { agree: true } });
    expect(m.formValues).toEqual({ signer: "JW", agree: true });
    m = applyOp(m, { op: "add_bookmark", bookmark: { id: "b1", page: 2, title: "Schedule" } });
    m = applyOp(m, { op: "set_bates", bates: { prefix: "MFC-", start: 1, digits: 4, position: "bottom-right", applied: true } });
    expect(m.bates?.applied).toBe(false);
    m = applyOp(m, { op: "set_decorations", decorations: { watermark: { text: "DRAFT" } } });
    expect(m.bookmarks?.[0].title).toBe("Schedule");
    expect(m.decorations?.watermark?.text).toBe("DRAFT");
    expect(model.annotations).toEqual([]); // input untouched
  });
});

// ---------------------------------------------------------------------------
describe("apply pipeline (pdf-lib)", () => {
  it("Bates-stamps every active page in display order and skips deleted pages", async () => {
    const { cmoBytes, model } = await generated();
    let m = applyOp(model, { op: "delete_pages", sourcePages: [2] });
    m = applyOp(m, { op: "set_bates", bates: { prefix: "MFC-", start: 60000, digits: 7, position: "bottom-right", legend: "CONFIDENTIAL — SUBJECT TO PROTECTIVE ORDER" } });
    const out = await applyModel(cmoBytes, m);
    const ex = await extractPdf(out);
    expect(ex.pageCount).toBe(activePages(m).length);
    ex.pages.forEach((p, i) => { expect(p.text).toContain(`MFC-00600${String(i).padStart(2, "0")}`); expect(p.text).toContain("SUBJECT TO PROTECTIVE ORDER"); });
    expect(ex.pages[1].text).toContain("Any dispute arising under this Order"); // page 3 of the source is now page 2
  }, 40_000);

  it("draws highlights and redactions (page count unchanged, bytes differ), and rasterized redaction removes the text", async () => {
    const { cmoBytes, model } = await generated();
    const ex = await extractPdf(cmoBytes);
    const hit = searchRuns(ex.pages[0].runs, "Girish Hegde")[0];
    expect(hit).toBeDefined();
    const m = applyOp(model, { op: "add_annotations", annotations: [
      { id: "h", page: 1, type: "highlight", rects: hit.rects, color: "#FACC15", opacity: 0.4, author: "t", createdAt: NOW },
      { id: "r", page: 1, type: "redaction", rects: hit.rects, color: "#111111", opacity: 1, author: "t", createdAt: NOW, reason: "PII" },
      { id: "n", page: 1, type: "note", rects: [{ x: 500, y: 700, w: 20, h: 20 }], color: "#FACC15", opacity: 1, author: "t", createdAt: NOW, text: "Check custodian list" },
      { id: "s", page: 1, type: "stamp", rects: [{ x: 380, y: 720, w: 190, h: 40 }], color: "#B91C1C", opacity: 0.9, author: "t", createdAt: NOW, text: "CONFIDENTIAL" },
    ] });
    const flat = await applyModel(cmoBytes, m, { flattenAnnotations: true });
    expect(flat.length).not.toBe(cmoBytes.length);
    const ex2 = await extractPdf(flat);
    expect(ex2.pageCount).toBe(ex.pageCount);
    expect(ex2.pages[0].text).toContain("CONFIDENTIAL");
    // True redaction: the redacted occurrence is removed from the content stream (other occurrences stay).
    const count = (t: string) => (t.match(/Girish\s+Hegde/g) ?? []).length;
    expect(count(ex2.pages[0].text)).toBe(count(ex.pages[0].text) - 1);
    const native = await applyModel(cmoBytes, m, { flattenAnnotations: false });
    const doc = await PDFDocument.load(native);
    const annots = doc.getPage(0).node.Annots();
    expect(annots && annots.size()).toBeGreaterThanOrEqual(2); // highlight + note as native annotations
    // rasterized page: content replaced by an image, so the text is really gone
    const raster = await applyModel(cmoBytes, m, { rasterizedPages: { 1: TINY_PNG } });
    const ex3 = await extractPdf(raster);
    expect(ex3.pageCount).toBe(ex.pageCount);
    expect(ex3.pages[0].text).not.toContain("Girish Hegde");
    expect(ex3.pages[1].text).toContain("Production Schedule");
  }, 60_000);

  it("reorders, deletes, inserts blank pages and merges another PDF", async () => {
    const { cmoBytes, model } = await generated();
    let m = applyOp(model, { op: "reorder_pages", order: [2, 1] });
    m = applyOp(m, { op: "delete_pages", sourcePages: [3] });
    m = applyOp(m, { op: "insert_blank_page", afterDisplay: 0 });
    const out = await applyModel(cmoBytes, m);
    const ex = await extractPdf(out);
    expect(ex.pageCount).toBe(activePages(m).length);
    expect(ex.pages[0].text).toBe("");
    expect(ex.pages[1].text).toContain("Milestone"); // source page 2 (schedule table) first
    expect(ex.pages[2].text).toContain("PROCEDURAL ORDER NO. 5");
    expect(ex.pages[3].text).toContain("Appendix A"); // source page 4; source page 3 deleted
    const blank = await blankPdf(2, [500, 400]);
    const merged = await mergePdfs(cmoBytes, [blank]);
    expect(merged.added).toEqual([{ width: 500, height: 400, rotation: 0 }, { width: 500, height: 400, rotation: 0 }]);
    expect((await readPageSizes(merged.bytes)).length).toBe(model.pageCount + 2);
    const split = await extractPages(cmoBytes, [3, 1], "Split");
    const exs = await extractPdf(split);
    expect(exs.pageCount).toBe(2);
    expect(exs.pages[1].text).toContain("PROCEDURAL ORDER NO. 5");
    const compressed = await compressPdf(cmoBytes);
    expect((await readPageSizes(compressed)).length).toBe(model.pageCount);
  }, 60_000);

  it("fills and flattens a generated form", async () => {
    const { formBytes } = await generated();
    const filled = await fillFormFields(formBytes, { ack_name: "Dr. Leela Sundaram", ack_role: "Expert witness", ack_aeo: true, ack_date: "September 24, 2026" });
    const fields = await readFormFields(filled);
    expect(fields.find((f) => f.name === "ack_name")?.value).toBe("Dr. Leela Sundaram");
    expect(fields.find((f) => f.name === "ack_role")?.value).toBe("Expert witness");
    expect(fields.find((f) => f.name === "ack_aeo")?.value).toBe(true);
    const flat = await fillFormFields(formBytes, { ack_name: "Dr. Leela Sundaram" }, true);
    expect(await readFormFields(flat)).toEqual([]);
    const ex = await extractPdf(flat);
    expect(ex.pages.map((p) => p.text).join(" ")).toContain("Dr. Leela Sundaram");
    // via the model
    const ex0 = await extractPdf(formBytes);
    const m = buildModel({ sourceBlobId: "f", pageSizes: ex0.pages, meta: { fields: ex0.fields, hasForm: true } });
    const out = await applyModel(formBytes, applyOp(m, { op: "fill_form", values: { ack_employer: "Sundaram Laboratories" } }), { flattenForms: true });
    expect((await extractPdf(out)).pages.map((p) => p.text).join(" ")).toContain("Sundaram Laboratories");
  }, 60_000);

  it("writes headers, footers, page numbers, watermark and bookmarks", async () => {
    const { cmoBytes, model } = await generated();
    let m = applyOp(model, { op: "set_decorations", decorations: { header: { text: "PRIVILEGED & CONFIDENTIAL" }, pageNumbers: { format: "Page {page} of {pages}", position: "bottom-left" }, watermark: { text: "DRAFT" } } });
    m = applyOp(m, { op: "add_bookmark", bookmark: { id: "b", page: 2, title: "Schedule table" } });
    m = applyOp(m, { op: "add_bookmark", bookmark: { id: "c", page: 2, title: "Nested", level: 2 } });
    const out = await applyModel(cmoBytes, m);
    const ex = await extractPdf(out);
    expect(ex.pages[0].text).toContain("PRIVILEGED & CONFIDENTIAL");
    expect(ex.pages[0].text).toContain("DRAFT");
    expect(ex.pages[1].text).toContain(`Page 2 of ${ex.pageCount}`);
    // Bookmarks are appended after the document's own outline, which is preserved.
    const original = (await extractPdf(cmoBytes)).outline;
    expect(ex.outline.slice(0, original.length)).toEqual(original);
    expect(ex.outline.slice(original.length)).toEqual([{ title: "Schedule table", page: 2, children: [{ title: "Nested", page: 2, children: undefined }] }]);
  }, 40_000);
});

const TINY_PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));

// ---------------------------------------------------------------------------
describe("snapshot", () => {
  it("renders page-marked text within the budget and scopes to a page", async () => {
    const { model } = await generated();
    const snap = parseSnapshot({ model, title: "CMO 26", currentPage: 2, selection: { page: 2, text: "quoted" } });
    const text = renderSnapshot(snap, null);
    expect(text).toContain("=== Page 1 ===");
    expect(text).toContain(`=== Page ${activePages(model).length} ===`);
    expect(text).toContain("OUTLINE:");
    expect(text).toContain("VIEWER: user is looking at page 2");
    expect(text.length).toBeLessThan(40_000);
    const scoped = renderSnapshot(snap, { id: "page:2", label: "Page 2", kind: "page" });
    expect(scoped).toContain("=== Page 2 ===");
    expect(scoped).not.toContain("=== Page 1 ===");
    expect(() => parseSnapshot(null)).toThrow();
    const big = { ...model, textIndex: model.textIndex!.map((t) => ({ ...t, text: t.text.repeat(40) })) };
    expect(renderSnapshot(parseSnapshot({ model: big, title: "x" }), null)).toContain("[truncated");
  });
});

// ---------------------------------------------------------------------------
describe("agent tools", () => {
  it("reads text, finds matches with rectangles and lists outline/form fields", async () => {
    const { cmoBytes, model } = await generated();
    const { ctx } = makeCtx(model);
    const tools = pdfAgentTools(ctx, { extraction: () => extractPdf(cmoBytes) });
    const pages = tool(tools, "get_pages_text")({ from: 1, to: 2 }) as { pages: { page: number; text: string }[] };
    expect(pages.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages.pages[0].text).toContain("Tier 2 Custodians");
    const found = (await tool(tools, "find_text")({ query: "October 14, 2026" })) as { total: number; hits: { page: number; rects: unknown[] }[] };
    expect(found.total).toBeGreaterThanOrEqual(2);
    expect(found.hits[0].rects.length).toBeGreaterThan(0);
    const outline = tool(tools, "get_outline")({}) as { outline: { title: string }[]; pages: { display: number }[] };
    expect(outline.outline.length).toBeGreaterThan(0);
    expect(outline.pages[0].display).toBe(1);
    expect((tool(tools, "get_form_fields")({}) as { fields: unknown[] }).fields).toEqual([]);
    const img = (await tool(tools, "describe_page_image")({ page: 1 })) as { source: string };
    expect(img.source).toBe("text");
  }, 30_000);

  it("edit tools mutate the snapshot and produce proposals the client can apply identically", async () => {
    const { cmoBytes, model } = await generated();
    const { ctx, proposals } = makeCtx(model);
    const tools = pdfAgentTools(ctx, { extraction: () => extractPdf(cmoBytes) });
    const h = (await tool(tools, "add_highlight")({ query: "October 14, 2026", note: "deadline" })) as { added: number };
    expect(h.added).toBeGreaterThanOrEqual(2);
    await tool(tools, "add_note")({ page: 1, text: "Confirm numbering", near: "MFC-0060000" });
    tool(tools, "add_stamp")({ text: "Confidential", pages: "1" });
    const r = (await tool(tools, "add_redaction")({ query: "Girish Hegde", reason: "PII" })) as { added: number; note: string };
    expect(r.added).toBeGreaterThanOrEqual(1);
    expect(r.note).toMatch(/apply/i);
    const b = tool(tools, "bates_stamp")({ prefix: "MFC-", start: 60000, digits: 7, position: "bottom-right", legend: "CONFIDENTIAL" }) as { first: string; last: string };
    expect(b.first).toBe("MFC-0060000");
    tool(tools, "rotate_pages")({ pages: "1", degrees: 90 });
    tool(tools, "insert_blank_page")({ after_page: 1 });
    tool(tools, "add_bookmark")({ page: 2, title: "Search terms" });
    tool(tools, "set_header_footer")({ header: "PRIVILEGED", watermark: "DRAFT" });
    tool(tools, "delete_pages")({ pages: `${activePages(ctx.snapshot.model).length}` });
    const snap = ctx.snapshot.model;
    expect(snap.annotations.filter((a) => a.type === "highlight").every((a) => a.text === "deadline" && a.author === "Drafting assistant")).toBe(true);
    expect(snap.annotations.some((a) => a.type === "note" && a.rects.length === 1)).toBe(true);
    expect(snap.annotations.find((a) => a.type === "stamp")?.text).toBe("CONFIDENTIAL");
    expect(snap.annotations.find((a) => a.type === "redaction")?.reason).toBe("PII");
    expect(snap.bates?.legend).toBe("CONFIDENTIAL");
    expect(snap.pages[0].rotation).toBe(90);
    expect(activePages(snap)[1].blank).toBe(true);
    expect(snap.decorations?.watermark?.text).toBe("DRAFT");
    expect(activePages(snap).length).toBe(model.pageCount); // +1 blank −1 deleted
    const applied = applyAll(model, proposals);
    expect(applied.annotations.map((a) => a.id)).toEqual(snap.annotations.map((a) => a.id));
    expect(activePages(applied).map((p) => p.index)).toEqual(activePages(snap).map((p) => p.index));
    expect(proposals.every((p) => p.status === "pending" && typeof p.payload.op === "string")).toBe(true);
    expect(proposals.find((p) => p.kind === "set_bates")!.title).toContain("MFC-0060000");
    expect(proposals.find((p) => p.kind === "add_annotations")!.target).toMatch(/^page:\d+/);
    expect(isPdfEditingTool("add_highlight")).toBe(true);
    expect(isPdfEditingTool("find_text")).toBe(false);
  }, 40_000);

  it("PII presets, PII/privilege check and injected model deps", async () => {
    const bytes = await generatePdf(custodialExcerptSpec());
    const ex = await extractPdf(bytes);
    const model = buildModel({ sourceBlobId: "h", pageSizes: ex.pages, textIndex: ex.pages.map((p) => ({ page: p.page, text: p.text })) });
    const { ctx } = makeCtx(model);
    const tools = pdfAgentTools(ctx, {
      extraction: async () => ex,
      summarize: async (text, focus) => `SUMMARY(${focus ?? "none"}) ${text.length}`,
      extractTable: async () => ({ columns: ["Well", "MC-7"], rows: [["MW-7", "1,140"]] }),
      createWordDocument: async (title) => ({ id: "w1", url: `/office/word/w1?${title}` }),
      otherDocumentText: async () => ({ title: "Other", text: "totally different text" }),
      diffTexts: (a, b) => ({ added: b.split("\n").length, removed: a.split("\n").length, changes: [{ kind: "added", text: b }] }),
    });
    const check = (await tool(tools, "check_pii_and_privilege")({})) as { total: number; byKind: Record<string, number>; unredacted: number };
    expect(check.byKind.ssn).toBe(1);
    expect(check.byKind.privilege).toBeGreaterThanOrEqual(1);
    expect(check.unredacted).toBe(check.total);
    const red = (await tool(tools, "add_redaction")({ preset: "ssn" })) as { added: number };
    expect(red.added).toBe(1);
    const after = (await tool(tools, "check_pii_and_privilege")({})) as { unredacted: number; total: number };
    expect(after.unredacted).toBe(after.total - 1);
    await expect(tool(tools, "add_redaction")({ preset: "nope" }) as Promise<unknown>).rejects.toThrow(/Unknown preset/);
    expect((await tool(tools, "summarize_document")({ focus: "deadlines" })) as object).toMatchObject({ summary: expect.stringContaining("SUMMARY(deadlines)") });
    // Deterministic, position-based: the lab table's columns and every row (the wrapped "(dup)" cell joins its row).
    const table = (await tool(tools, "extract_table")({ page: 3 })) as { method: string; columns: string[]; rowCount: number; markdown: string };
    expect(table.method).toBe("layout");
    expect(table.columns).toEqual(["Well", "Sample ID", "MC-7", "MC-8", "MC-6", "Qualifier", "Analyst"]);
    expect(table.rowCount).toBe(14); // MW-1…MW-12, the MW-7 duplicate and the trip blank
    expect(table.markdown).toContain("| MW-7 | KET-060228-07 | 1,140 | 2,360 | 412 |  | K. Oza |");
    expect(table.markdown).toContain("| MW-7 (dup) | KET-060228-07D | 1,102 |");
    expect((await tool(tools, "create_word_document")({ title: "Memo", from_text: true })) as object).toMatchObject({ url: expect.stringContaining("/office/word/w1") });
    const cmp = (await tool(tools, "compare_to_document")({ other_doc_id: "x" })) as { identical: boolean; addedLines: number };
    expect(cmp.identical).toBe(false);
    expect(cmp.addedLines).toBe(1);
    expect(pdfInstructions(ctx)).toContain("DISPLAY numbers");
    expect(PDF_SUGGESTIONS.draft.length).toBeGreaterThanOrEqual(5);
  }, 40_000);
});

// ---------------------------------------------------------------------------
describe("templates, import and service", () => {
  it("ships six templates that materialize into multi-page PDFs", async () => {
    expect(PDF_TEMPLATES.length).toBe(6);
    expect(Object.keys(SPEC_BUILDERS).length).toBeGreaterThanOrEqual(8);
    for (const t of PDF_TEMPLATES) {
      const m = normalizeModel(t.build({ title: t.name }));
      expect(m.meta.pending).toBe(true);
      expect(SPEC_BUILDERS[String(m.meta.specId)]).toBeDefined();
    }
    const bytes = await generatePdf(SPEC_BUILDERS["subpoena-duces-tecum"]({ demo: true }));
    const ex = await extractPdf(bytes);
    expect(ex.pageCount).toBeGreaterThanOrEqual(3);
    expect(ex.fields.map((f) => f.name)).toContain("svc_method");
    expect(ex.pages[0].text).toContain("Konkan Environmental Testing");
  }, 40_000);

  it("imports bytes into a model with text index and stored source blob", async () => {
    const { cmoBytes } = await generated();
    const r = await importDocument(cmoBytes, "Hegde_production_vol_2.pdf");
    const m = normalizeModel(r.content);
    expect(r.title).toBe("Hegde production vol 2");
    expect(m.pageCount).toBeGreaterThanOrEqual(3);
    expect(m.textIndex?.length).toBe(m.pageCount);
    expect(blobs.meta(m.sourceBlobId)?.mime).toBe("application/pdf");
    expect(m.meta.outline?.length).toBeGreaterThan(0);
    await expect(importDocument(new TextEncoder().encode("not a pdf"), "x.pdf")).rejects.toThrow(/not a PDF/);
  }, 30_000);

  it("seeds documents, versions, comments and library items idempotently and materializes them", async () => {
    const d = db();
    seedPdf(d);
    expect(SEEDED_PDF_DOC_IDS.length).toBeGreaterThanOrEqual(4);
    for (const id of SEEDED_PDF_DOC_IDS) {
      expect(d.officeDocs.get(id)?.kind).toBe("pdf");
      expect(d.officeVersions.find((v) => v.docId === id).length).toBeGreaterThanOrEqual(2);
      expect(d.library.find((l) => l.officeDocId === id && l.type === "pdf").length).toBe(1);
    }
    const comments = d.officeComments.find((c) => c.docId === "odoc_pdf_cmo26");
    expect(comments.length).toBe(3);
    expect(comments.every((c) => /^page:\d+$/.test(c.anchor))).toBe(true);
    const before = { docs: d.officeDocs.count(), versions: d.officeVersions.count(), comments: d.officeComments.count(), lib: d.library.count() };
    seedPdf(d);
    expect({ docs: d.officeDocs.count(), versions: d.officeVersions.count(), comments: d.officeComments.count(), lib: d.library.count() }).toEqual(before);
    const loaded = await materialize("odoc_pdf_hale_production");
    expect(loaded?.model.meta.pending).toBeUndefined();
    expect(loaded?.model.sourceBlobId).toBe("blob_pdf_hale_production");
    expect(loaded?.model.textIndex?.length).toBe(loaded?.model.pageCount);
    const redactions = loaded!.model.annotations.filter((a) => a.type === "redaction");
    expect(redactions.length).toBe(2);
    expect(redactions.every((a) => a.rects.length > 0)).toBe(true);
    expect(loaded!.model.annotations.find((a) => a.type === "stamp")!.rects[0].y).toBeGreaterThan(700);
    // idempotent: a second materialize keeps the same bytes
    const again = await materialize("odoc_pdf_hale_production");
    expect(again?.model.sourceBlobId).toBe(loaded?.model.sourceBlobId);
    seedPdf(d); // re-seeding keeps the materialized model
    expect(normalizeModel(d.officeDocs.get("odoc_pdf_hale_production")!.content).meta.pending).toBeUndefined();
  }, 60_000);

  it("burn-in, merge, split, compress and Word conversion update the document", async () => {
    const r0 = await ensureExtracted("odoc_pdf_hale_production");
    expect(r0?.extraction.pageCount).toBe(3);
    const beforeBlob = r0!.loaded.model.sourceBlobId;
    const burned = await burnIn("odoc_pdf_hale_production", { applyRedactions: true, rasterizedPages: { 1: `data:image/png;base64,${Buffer.from(TINY_PNG).toString("base64")}` } });
    expect(burned!.model.sourceBlobId).not.toBe(beforeBlob);
    expect(burned!.model.annotations.every((a) => a.type === "note")).toBe(true);
    expect(burned!.model.textIndex![0].text).not.toContain("412-55-8367"); // page 1 rasterized
    expect(burned!.model.textIndex![2].text).toContain("KET-060228-07"); // lab table intact
    expect(burned!.model.bates).toBeUndefined(); // seeded Bates numbers were generated into the source
    const merged = await mergeInto("odoc_pdf_hale_production", [{ bytes: await blankPdf(1), name: "blank.pdf" }]);
    expect(merged!.model.pageCount).toBe(4);
    expect(activePages(merged!.model).length).toBe(4);
    const split = await splitToNewDocument("odoc_pdf_hale_production", [3, 4], "Lab table only");
    expect(split!.doc.title).toBe("Lab table only");
    expect(loadPdf(split!.doc.id)!.model.pageCount).toBe(2);
    const comp = await compressDocument("odoc_pdf_hale_production");
    expect(comp!.after).toBeLessThanOrEqual(comp!.before);
    const word = await convertToWord("odoc_pdf_hale_production");
    expect(word!.doc.kind).toBe("word");
    expect(JSON.stringify(word!.doc.content)).toContain("Page 3");
    expect(textToMarkdown(loadPdf("odoc_pdf_hale_production")!.model, "T")).toContain("## Page 1");
    const fresh = await modelFromBytes(await blankPdf(1), { name: "b.pdf" });
    expect(fresh.model.textIndex).toEqual([{ page: 1, text: "" }]);
    expect(resolveQuotedAnnotations(fresh.model, fresh.extraction).annotations).toEqual([]);
  }, 90_000);
});
