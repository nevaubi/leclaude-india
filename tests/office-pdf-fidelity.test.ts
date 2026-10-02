/**
 * PDF fidelity suite: true redaction, native annotations round trip, forms,
 * outlines, page ops, Bates. Fixtures are built in-test with pdf-lib.
 */
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from "pdf-lib";
import { applyModel, applyModelWithReport, extractPages, mergePdfs, stampBatesBytes } from "@/modules/office/pdf/apply";
import { parseContent, redactPageContent } from "@/modules/office/pdf/content-stream";
import { extractPdf } from "@/modules/office/pdf/extract";
import { buildModel, type PdfAnnotation, type PdfModel } from "@/modules/office/pdf/model";
import { applyOp } from "@/modules/office/pdf/proposals";
import { readNativeAnnotations } from "@/modules/office/pdf/annotations";
import { readOutlineTree } from "@/modules/office/pdf/outline";
import { searchRuns } from "@/modules/office/pdf/text-search";
import { setOutline } from "@/modules/office/pdf/pdf-lib-utils";

const NOW = "2026-09-28T10:00:00.000Z";

/** Three-page letter fixture: PII on page 1, a form on page 2, a heading on page 3, an outline and an existing highlight. */
async function fixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle("Custodian interview notes");
  doc.setAuthor("Nandini Bose");
  doc.setSubject("Interview of Marcus Delgado, SSN 412-55-8367");
  doc.setKeywords(["interview", "custodian"]);
  const p1 = doc.addPage([612, 792]);
  p1.drawText("1. Custodian Background", { x: 72, y: 720, size: 16, font: bold });
  p1.drawText("Name: Marcus Delgado    SSN: 412-55-8367    Phone: (843) 555-0192", { x: 72, y: 690, size: 11, font: helv });
  p1.drawText("Email: marcus.delgado@konkanenv.example    DOB: 03/14/1971", { x: 72, y: 672, size: 11, font: helv });
  p1.drawText("The custodian confirmed that MW-7 samples were collected on June 2, 2024.", { x: 72, y: 654, size: 11, font: helv });
  p1.drawText("Account No. 4471029835 was used for the lab invoices.", { x: 72, y: 636, size: 11, font: helv });
  p1.drawRectangle({ x: 60, y: 600, width: 480, height: 1, color: rgb(0.5, 0.5, 0.5) });
  const p2 = doc.addPage([612, 792]);
  p2.drawText("2. Acknowledgment", { x: 72, y: 720, size: 16, font: bold });
  p2.drawText("Signed by the custodian below.", { x: 72, y: 700, size: 11, font: helv });
  const form = doc.getForm();
  const name = form.createTextField("ack_name"); name.addToPage(p2, { x: 72, y: 640, width: 220, height: 20 });
  const role = form.createDropdown("ack_role"); role.addOptions(["Custodian", "Expert witness"]); role.addToPage(p2, { x: 72, y: 600, width: 220, height: 20 });
  const aeo = form.createCheckBox("ack_aeo"); aeo.addToPage(p2, { x: 72, y: 560, width: 14, height: 14 });
  const p3 = doc.addPage([612, 792]);
  p3.drawText("3. Sampling Chronology", { x: 72, y: 720, size: 16, font: bold });
  p3.drawText("Well     Date        MC-7 (ng/L)", { x: 72, y: 690, size: 11, font: helv });
  p3.drawText("MW-7     06/02/2024  1,140", { x: 72, y: 672, size: 11, font: helv });
  p3.drawText("MW-9     06/03/2024  88", { x: 72, y: 654, size: 11, font: helv });
  setOutline(doc, [{ title: "Custodian Background", page: 1 }, { title: "Acknowledgment", page: 2 }, { title: "Sampling Chronology", page: 3, children: [{ title: "Results table", page: 3 }] }]);
  // An existing highlight made by "another reviewer" in Acrobat.
  const hl = doc.context.obj({ Type: "Annot", Subtype: "Highlight", Rect: [72, 650, 300, 666], QuadPoints: [72, 666, 300, 666, 72, 650, 300, 650], C: [1, 1, 0], CA: 0.5, T: PDFString.of("Acrobat Reviewer"), Contents: PDFString.of("key date"), M: PDFString.of("D:20260901120000Z"), F: 4 });
  p1.node.addAnnot(doc.context.register(hl));
  // page labels i, ii, iii
  doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({ Nums: [0, doc.context.obj({ S: PDFName.of("r") })] }));
  return doc.save();
}

async function modelFor(bytes: Uint8Array): Promise<PdfModel> {
  const ex = await extractPdf(bytes);
  const doc = await PDFDocument.load(bytes);
  const m = buildModel({ sourceBlobId: "fx", pageSizes: ex.pages, textIndex: ex.pages.map((p) => ({ page: p.page, text: p.text })), meta: { outline: ex.outline, fields: ex.fields, nativeAnnotations: true } });
  m.annotations = readNativeAnnotations(doc);
  return m;
}

function redaction(page: number, rects: PdfAnnotation["rects"], quote?: string): PdfAnnotation {
  return { id: `r_${Math.random().toString(36).slice(2, 7)}`, page, type: "redaction", rects, color: "#111111", opacity: 1, author: "t", createdAt: NOW, reason: "PII", quote };
}

describe("content stream parser", () => {
  it("tokenizes operators, strings, arrays, dicts and inline images", () => {
    const src = new TextEncoder().encode("q 1 0 0 1 10 20 cm BT /F1 12 Tf (a\\(b\\)) Tj [(x) -250 <4142>] TJ ET /P <</MCID 3 /ActualText (hi)>> BDC EMC BI /W 1 /H 1 /BPC 8 /CS /G ID \x00 EI Q");
    const ops = parseContent(src);
    expect(ops.map((o) => o.op)).toEqual(["q", "cm", "BT", "Tf", "Tj", "TJ", "ET", "BDC", "EMC", "BI", "Q"]);
    const tj = ops[4].args[0];
    expect(tj.t === "str" && new TextDecoder().decode(tj.v)).toBe("a(b)");
    const arr = ops[5].args[0];
    expect(arr.t === "arr" && arr.v.length).toBe(3);
  });
});

describe("true redaction", () => {
  it("removes the glyphs under the box, keeps the rest of the line in place, and scrubs metadata", async () => {
    const bytes = await fixture();
    const ex = await extractPdf(bytes);
    const ssn = searchRuns(ex.pages[0].runs, "412-55-8367")[0];
    expect(ssn).toBeDefined();
    const before = searchRuns(ex.pages[0].runs, "Phone: (843) 555-0192")[0].rects[0];
    const m0 = await modelFor(bytes);
    const m = applyOp(m0, { op: "add_annotations", annotations: [redaction(1, ssn.rects, "412-55-8367")] });
    const { bytes: out, report } = await applyModelWithReport(bytes, m);
    expect(report.redaction?.pages[0]).toMatchObject({ page: 1, method: "content-stream" });
    expect(report.redaction!.pages[0].removedGlyphs).toBe(11);
    const ex2 = await extractPdf(out);
    const text = ex2.pages[0].text;
    expect(text).not.toContain("412-55-8367");
    expect(text).not.toMatch(/8367/);
    expect(text).toContain("Marcus Delgado");
    expect(text).toContain("Phone: (843) 555-0192");
    expect(text).toContain("MW-7 samples");
    // text after the redaction did not move
    const after = searchRuns(ex2.pages[0].runs, "Phone: (843) 555-0192")[0].rects[0];
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.5);
    // the raw bytes contain no trace of the digits (old streams pruned)
    const doc = await PDFDocument.load(out);
    expect(doc.getSubject()).not.toContain("412-55-8367");
    expect(report.redaction!.scrubbed.metadataKeys).toContain("Subject");
    // untouched pages keep their content
    expect(ex2.pages[2].text).toContain("MW-9");
  }, 30_000);

  it("removes every byte of the redacted text from the saved file", async () => {
    const bytes = await fixture();
    const ex = await extractPdf(bytes);
    const hit = searchRuns(ex.pages[0].runs, "4471029835")[0];
    const m = applyOp(await modelFor(bytes), { op: "add_annotations", annotations: [redaction(1, hit.rects, "4471029835")] });
    const out = await applyModel(bytes, m);
    // decode every stream of the output and search for the hex/literal glyph codes
    const doc = await PDFDocument.load(out);
    const { decodePDFRawStream, PDFRawStream } = await import("pdf-lib");
    let found = false;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      let s = "";
      try { s = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"); } catch { continue; }
      if (s.includes("4471029835") || s.includes(Buffer.from("4471029835").toString("hex"))) found = true;
    }
    expect(found).toBe(false);
  }, 30_000);

  it("removes annotations and form fields under the region", async () => {
    const bytes = await fixture();
    const m0 = await modelFor(bytes);
    // redact the existing highlight's region (line 4 on page 1) and the ack_name field on page 2
    const m = applyOp(m0, { op: "add_annotations", annotations: [redaction(1, [{ x: 72, y: 650, w: 230, h: 16 }]), redaction(2, [{ x: 70, y: 638, w: 226, h: 24 }])] });
    const { bytes: out, report } = await applyModelWithReport(bytes, m);
    const doc = await PDFDocument.load(out);
    expect(readNativeAnnotations(doc).filter((a) => a.type === "highlight")).toEqual([]);
    expect(doc.getForm().getFields().map((f) => f.getName())).not.toContain("ack_name");
    expect(doc.getForm().getFields().map((f) => f.getName())).toContain("ack_role");
    expect(report.redaction!.pages.find((p) => p.page === 2)!.removedFields).toContain("ack_name");
  }, 30_000);

  it("falls back to rasterization when an image lies under the box, and fails closed without a rasterizer", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));
    page.drawImage(await doc.embedPng(png), { x: 20, y: 100, width: 100, height: 50 });
    page.drawText("Secret account 998877", { x: 20, y: 60, size: 12, font: helv });
    const bytes = await doc.save();
    const ex = await extractPdf(bytes);
    const m = applyOp(buildModel({ sourceBlobId: "x", pageSizes: ex.pages }), { op: "add_annotations", annotations: [redaction(1, [{ x: 30, y: 110, w: 40, h: 20 }])] });
    await expect(applyModel(bytes, m)).rejects.toThrow(/rasteriz/);
    const calls: number[] = [];
    const { bytes: out, report } = await applyModelWithReport(bytes, m, { rasterize: async (req) => { calls.push(req.sourcePage); return png; } });
    expect(calls).toEqual([1]);
    expect(report.redaction!.pages[0]).toMatchObject({ method: "rasterized" });
    expect(report.redaction!.pages[0].reason).toMatch(/image/);
    const ex2 = await extractPdf(out);
    expect(ex2.pages[0].text).not.toContain("998877");
  }, 30_000);

  it("redacts text inside a form XObject (copying the shared form)", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.context.flateStream("BT /F1 12 Tf 10 10 Td (Inner secret 123) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 40], Resources: doc.context.obj({ Font: doc.context.obj({ F1: helv.ref }) }) });
    const formRef = doc.context.register(form);
    page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: doc.context.obj({ Fm0: formRef }), Font: doc.context.obj({ F1: helv.ref }) }));
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream("q 1 0 0 1 20 100 cm /Fm0 Do Q BT /F1 12 Tf 20 40 Td (Outside text) Tj ET")));
    const bytes = await doc.save();
    const ex = await extractPdf(bytes);
    const hit = searchRuns(ex.pages[0].runs, "secret 123")[0];
    expect(hit).toBeDefined();
    const d2 = await PDFDocument.load(bytes);
    const r = redactPageContent(d2, d2.getPage(0), hit.rects);
    expect(r.unsafe).toBeNull();
    expect(r.removedGlyphs).toBe(10);
    const ex2 = await extractPdf(await d2.save());
    expect(ex2.pages[0].text).toContain("Inner");
    expect(ex2.pages[0].text).not.toContain("secret");
    expect(ex2.pages[0].text).toContain("Outside text");
  }, 30_000);
});

/** True when `needle` appears in any decoded stream, string or the raw bytes (literal or hex-encoded). */
async function containsAnywhere(bytes: Uint8Array, needle: string): Promise<boolean> {
  const { decodePDFRawStream, PDFRawStream } = await import("pdf-lib");
  const hex = Buffer.from(needle, "latin1").toString("hex");
  const hay = [Buffer.from(bytes).toString("latin1")];
  const doc = await PDFDocument.load(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try { hay.push(Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1")); } catch { /* images */ }
  }
  return hay.some((h) => h.includes(needle) || h.toLowerCase().includes(hex));
}

// ---------------------------------------------------------------------------
async function pdfjsAnnotations(bytes: Uint8Array, pageNo: number) {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  const anns = (await (await doc.getPage(pageNo)).getAnnotations()) as { subtype: string; rect: number[]; quadPoints?: Float32Array | number[]; titleObj?: { str: string }; contentsObj?: { str: string }; modificationDate?: string; hasAppearance?: boolean }[];
  await task.destroy();
  return anns;
}

describe("native annotations", () => {
  const mk = (id: string, type: PdfAnnotation["type"], rects: PdfAnnotation["rects"], extra: Partial<PdfAnnotation> = {}): PdfAnnotation => ({ id, page: 1, type, rects, color: "#FACC15", opacity: 1, author: "Nandini Bose", createdAt: NOW, ...extra });

  it("writes real annotations (QuadPoints, author, dates, appearance) that pdf-lib and pdf.js read back", async () => {
    const bytes = await fixture();
    const ex = await extractPdf(bytes);
    const hit = searchRuns(ex.pages[0].runs, "MW-7 samples")[0];
    const m = applyOp(await modelFor(bytes), { op: "add_annotations", annotations: [
      mk("an_h1", "highlight", hit.rects, { opacity: 0.4, text: "key sample", quote: "MW-7 samples" }),
      mk("an_u1", "underline", hit.rects, { color: "#EF4444" }),
      mk("an_s1", "strikeout", hit.rects, { color: "#EF4444" }),
      mk("an_n1", "note", [{ x: 500, y: 700, w: 20, h: 20 }], { text: "Confirm date" }),
      mk("an_t1", "text", [{ x: 300, y: 500, w: 200, h: 40 }], { text: "Reviewed 9/28", fontSize: 11, color: "#111111" }),
      mk("an_r1", "rect", [{ x: 60, y: 620, w: 200, h: 30 }], { color: "#2563EB" }),
      mk("an_e1", "ellipse", [{ x: 300, y: 620, w: 100, h: 30 }], { color: "#2563EB" }),
      mk("an_i1", "freehand", [{ x: 100, y: 400, w: 50, h: 50 }], { paths: [[{ x: 100, y: 400 }, { x: 150, y: 450 }]], color: "#2563EB" }),
      mk("an_st", "stamp", [{ x: 400, y: 740, w: 150, h: 36 }], { text: "CONFIDENTIAL", color: "#B91C1C", opacity: 0.9 }),
    ] });
    const out = await applyModel(bytes, m); // default: native annotations
    const doc = await PDFDocument.load(out);
    const read = readNativeAnnotations(doc).filter((a) => a.page === 1);
    const byId = new Map(read.map((a) => [a.id, a]));
    for (const id of ["an_h1", "an_u1", "an_s1", "an_n1", "an_t1", "an_r1", "an_e1", "an_i1", "an_st"]) expect(byId.has(id), id).toBe(true);
    expect(byId.get("an_h1")).toMatchObject({ type: "highlight", author: "Nandini Bose", text: "key sample", native: { subtype: "Highlight", hasAppearance: true } });
    expect(byId.get("an_h1")!.rects[0].x).toBeCloseTo(hit.rects[0].x, 1);
    expect(byId.get("an_s1")!.native.subtype).toBe("StrikeOut");
    expect(byId.get("an_n1")).toMatchObject({ type: "note", text: "Confirm date" });
    expect(byId.get("an_t1")).toMatchObject({ type: "text", text: "Reviewed 9/28", fontSize: 11 });
    expect(byId.get("an_i1")!.paths![0].length).toBe(2);
    expect(byId.get("an_h1")!.createdAt).toBe(NOW);
    // the Acrobat highlight that was already in the file round-trips untouched
    expect(read.some((a) => a.author === "Acrobat Reviewer" && a.text === "key date")).toBe(true);
    // pdf.js sees the same objects with the right subtypes, QuadPoints and authors
    const js = await pdfjsAnnotations(out, 1);
    const hl = js.find((a) => a.subtype === "Highlight" && a.contentsObj?.str === "key sample")!;
    expect(hl).toBeDefined();
    expect(hl.titleObj?.str).toBe("Nandini Bose");
    expect(Array.from(hl.quadPoints ?? []).length).toBe(8);
    expect(js.map((a) => a.subtype)).toEqual(expect.arrayContaining(["Highlight", "Underline", "StrikeOut", "Text", "FreeText", "Square", "Circle", "Ink", "Stamp"]));
    // the page text is untouched by native annotations
    expect((await extractPdf(out)).pages[0].text).toContain("MW-7 samples");
  }, 30_000);

  it("reads existing annotations on import; deleting or editing one changes the file, keeping others", async () => {
    const bytes = await fixture();
    const m0 = await modelFor(bytes);
    const existing = m0.annotations.find((a) => a.author === "Acrobat Reviewer")!;
    expect(existing).toMatchObject({ type: "highlight", text: "key date", createdAt: "2026-09-01T12:00:00.000Z", native: { subtype: "Highlight" } });
    expect(existing.rects[0]).toMatchObject({ x: 72, y: 650, w: 228, h: 16 });
    // unchanged → byte-identical annotation object stays
    const same = await applyModel(bytes, m0);
    expect(readNativeAnnotations(await PDFDocument.load(same)).filter((a) => a.author === "Acrobat Reviewer").length).toBe(1);
    // deleted in the editor → removed from the file
    const del = await applyModel(bytes, applyOp(m0, { op: "remove_annotations", ids: [existing.id] }));
    expect(readNativeAnnotations(await PDFDocument.load(del)).filter((a) => a.author === "Acrobat Reviewer")).toEqual([]);
    // edited (new comment) → rewritten once with the new text
    const edited = await applyModel(bytes, applyOp(m0, { op: "update_annotation", id: existing.id, patch: { text: "key date — verify" } }));
    const after = readNativeAnnotations(await PDFDocument.load(edited)).filter((a) => a.author === "Acrobat Reviewer");
    expect(after.map((a) => a.text)).toEqual(["key date — verify"]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe("forms, outline, metadata, labels", () => {
  it("lists, fills and flattens AcroForm fields through the model", async () => {
    const bytes = await fixture();
    const ex = await extractPdf(bytes);
    expect(ex.fields.map((f) => f.name).sort()).toEqual(["ack_aeo", "ack_name", "ack_role"]);
    let m = await modelFor(bytes);
    m = applyOp(m, { op: "fill_form", values: { ack_name: "Dr. Leela Sundaram", ack_role: "Expert witness", ack_aeo: true } });
    const filled = await applyModel(bytes, m);
    const f2 = (await extractPdf(filled)).fields;
    expect(f2.find((f) => f.name === "ack_name")?.value).toBe("Dr. Leela Sundaram");
    expect(f2.find((f) => f.name === "ack_aeo")?.value).toBe(true);
    const flat = await applyModel(bytes, applyOp(m, { op: "flatten_form", flatten: true }));
    const ex3 = await extractPdf(flat);
    expect(ex3.fields).toEqual([]);
    expect(ex3.pages[1].text).toContain("Dr. Leela Sundaram");
  }, 30_000);

  it("keeps the outline, page labels and properties, appends bookmarks and applies metadata edits", async () => {
    const bytes = await fixture();
    const ex = await extractPdf(bytes);
    expect(ex.pageLabels).toEqual(["i", "ii", "iii"]);
    expect(ex.outline.map((o) => o.title)).toEqual(["Custodian Background", "Acknowledgment", "Sampling Chronology"]);
    let m = await modelFor(bytes);
    m = applyOp(m, { op: "add_bookmarks", bookmarks: [{ id: "b1", page: 2, title: "Signature block", level: 1 }] });
    m = applyOp(m, { op: "set_metadata", metadata: { title: "Delgado interview (redacted)", keywords: "interview, MC-8" } });
    const out = await applyModel(bytes, m);
    const ex2 = await extractPdf(out);
    expect(ex2.outline.map((o) => o.title)).toEqual(["Custodian Background", "Acknowledgment", "Sampling Chronology", "Signature block"]);
    expect(ex2.outline[2].children?.[0]).toMatchObject({ title: "Results table", page: 3 });
    expect(ex2.outline[3].page).toBe(2);
    expect(ex2.pageLabels).toEqual(["i", "ii", "iii"]);
    expect(ex2.meta.title).toBe("Delgado interview (redacted)");
    expect(ex2.meta.author).toBe("Nandini Bose"); // untouched source property
    expect(ex2.meta.keywords).toContain("MC-8");
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe("page operations keep bookmarks and annotations consistent", () => {
  it("reorder, rotate, delete and insert blank: outline follows pages, deleted page content is gone from the file", async () => {
    const bytes = await fixture();
    let m = await modelFor(bytes);
    m = applyOp(m, { op: "add_annotations", annotations: [{ id: "an_p3", page: 3, type: "highlight", rects: [{ x: 72, y: 668, w: 120, h: 14 }], color: "#FACC15", opacity: 0.4, author: "t", createdAt: NOW }] });
    m = applyOp(m, { op: "reorder_pages", order: [3, 1, 2] });
    m = applyOp(m, { op: "rotate_pages", sourcePages: [3], delta: 90 });
    m = applyOp(m, { op: "delete_pages", sourcePages: [2] });
    m = applyOp(m, { op: "insert_blank_page", afterDisplay: 2 });
    const { bytes: out, report } = await applyModelWithReport(bytes, m);
    expect(report.pageMap).toEqual({ 3: 1, 1: 2 });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    const ex = await extractPdf(out);
    expect(ex.pages[0].text).toContain("Sampling Chronology");
    expect(ex.pages[1].text).toContain("Custodian Background");
    expect(ex.pages[2].text).toBe("");
    // outline: targets follow their pages; the deleted page's bookmark lost its target (never retargeted)
    const tree = readOutlineTree(doc);
    expect(tree.find((t) => t.title === "Sampling Chronology")!.pageIndex).toBe(0);
    expect(tree.find((t) => t.title === "Custodian Background")!.pageIndex).toBe(1);
    expect(tree.find((t) => t.title === "Acknowledgment")).toBeUndefined();
    // the annotation stayed on its (moved, rotated) page
    expect(readNativeAnnotations(doc).filter((a) => a.id === "an_p3").map((a) => a.page)).toEqual([1]);
    // nothing of the deleted page survives: its text and its form fields are gone from the bytes
    expect(await containsAnywhere(out, "Signed by the custodian")).toBe(false);
    expect(await containsAnywhere(bytes, "Signed by the custodian")).toBe(true); // the probe works on the source
    expect(doc.getForm().getFields()).toEqual([]);
  }, 30_000);

  it("split carries bookmarks and annotations of the extracted pages; merge nests the other outline", async () => {
    const bytes = await fixture();
    const split = await extractPages(bytes, [3, 1], "Split");
    const sdoc = await PDFDocument.load(split);
    const tree = readOutlineTree(sdoc);
    expect(tree.map((t) => [t.title, t.pageIndex])).toEqual([["Custodian Background", 1], ["Sampling Chronology", 0]]);
    expect(tree[1].children.map((c) => c.title)).toEqual(["Results table"]);
    expect(readNativeAnnotations(sdoc).map((a) => [a.author, a.page])).toEqual([["Acrobat Reviewer", 2]]);
    const merged = await mergePdfs(split, [bytes], ["Interview notes"]);
    const mdoc = await PDFDocument.load(merged.bytes);
    expect(mdoc.getPageCount()).toBe(5);
    const mt = readOutlineTree(mdoc);
    expect(mt.map((t) => t.title)).toEqual(["Custodian Background", "Sampling Chronology", "Interview notes"]);
    expect(mt[2].pageIndex).toBe(2);
    expect(mt[2].children.map((c) => [c.title, c.pageIndex])).toEqual([["Custodian Background", 2], ["Acknowledgment", 3], ["Sampling Chronology", 4]]);
    expect(readNativeAnnotations(mdoc).map((a) => a.page).sort()).toEqual([2, 3]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe("Bates", () => {
  it("stamps every page in order with the chosen font, position and endorsement; a page range limits it", async () => {
    const bytes = await fixture();
    let m = await modelFor(bytes);
    m = applyOp(m, { op: "set_bates", bates: { prefix: "MFC-", start: 60010, digits: 7, position: "bottom-right", font: "Courier-Bold", legend: "CONFIDENTIAL" } });
    const out = await applyModel(bytes, m);
    const ex = await extractPdf(out);
    ex.pages.forEach((p, i) => { expect(p.text).toContain(`MFC-00600${10 + i}`); expect(p.text).toContain("CONFIDENTIAL"); });
    const doc = await PDFDocument.load(out);
    const fonts = doc.getPage(0).node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    expect(fonts.entries().map(([, v]) => doc.context.lookup(v, PDFDict).lookup(PDFName.of("BaseFont"))?.toString())).toContain("/Courier-Bold");
    // no endorsement unless chosen; page subset numbers consecutively
    const m2 = applyOp(await modelFor(bytes), { op: "set_bates", bates: { prefix: "ABC", start: 1, digits: 4, position: "top-left", pages: [2, 3] } });
    const ex2 = await extractPdf(await applyModel(bytes, m2));
    expect(ex2.pages[0].text).not.toMatch(/ABC\d{4}/);
    expect(ex2.pages[1].text).toContain("ABC0001");
    expect(ex2.pages[2].text).toContain("ABC0002");
    expect(ex2.pages.map((p) => p.text).join(" ")).not.toContain("CONFIDENTIAL");
  }, 30_000);

  it("continues one sequence across a set of documents on the original bytes", async () => {
    const a = await fixture();
    const b = await extractPages(a, [1, 2]);
    const r1 = await stampBatesBytes(a, [1, 2, 3], { prefix: "PROD", start: 100, digits: 6, position: "bottom-center" });
    const r2 = await stampBatesBytes(b, [1, 2], { prefix: "PROD", start: 100 + r1.labels.length, digits: 6, position: "bottom-center" });
    expect(r1.labels.map((l) => l.label)).toEqual(["PROD000100", "PROD000101", "PROD000102"]);
    expect(r2.labels.map((l) => l.label)).toEqual(["PROD000103", "PROD000104"]);
    const ex = await extractPdf(r2.bytes);
    expect(ex.pages[1].text).toContain("PROD000104");
    // original content, fields and outline survive
    expect(ex.pages[0].text).toContain("Marcus Delgado");
    expect((await extractPdf(r1.bytes)).fields.length).toBe(3);
    expect((await extractPdf(r1.bytes)).outline.length).toBe(3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe("OCR detection", () => {
  it("flags image-only pages as needing OCR and does not invent text", async () => {
    const doc = await PDFDocument.create();
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));
    const img = await doc.embedPng(png);
    doc.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
    const p2 = doc.addPage([612, 792]);
    p2.drawText("Typed page", { x: 72, y: 700, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    doc.addPage([612, 792]); // empty, no image: not "needs OCR"
    const ex = await extractPdf(await doc.save());
    expect(ex.pages.map((p) => Boolean(p.needsOcr))).toEqual([true, false, false]);
    expect(ex.pages[0].text).toBe("");
    const { getOcrProvider } = await import("@/modules/office/pdf/ocr");
    expect(getOcrProvider()).toBeNull();
  }, 30_000);
});

void PDFArray; void PDFNumber; void rgb;
