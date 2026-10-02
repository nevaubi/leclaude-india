/**
 * PDF agent: mode-scoped toolsets, stale proposals, redaction preview/apply,
 * code-verified quotes and page cites, deterministic bookmarks and privilege
 * log entries, needs-OCR exclusion; and the service paths behind them (true
 * redaction with verification on burn-in, Bates across a document set).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { blobs, resetSqlite } from "@/lib/db";
import type { EditProposal } from "@/modules/office/shared/types";
import type { OfficeAgentContext } from "@/modules/office/shared/route-factory";
import { PDF_ANNOTATION_TOOLS, PDF_READ_TOOLS, pdfAgentTools, privilegeLogEntry } from "@/modules/office/pdf/agent-tools";
import { pdfInstructions } from "@/modules/office/pdf/agent";
import { extractPdf } from "@/modules/office/pdf/extract";
import { activePages, buildModel, normalizeModel, type PdfModel } from "@/modules/office/pdf/model";
import { StaleProposalError, applyOp } from "@/modules/office/pdf/proposals";
import { parseSnapshot, renderSnapshot, type PdfSnapshot } from "@/modules/office/pdf/snapshot";
import { applyRedactionsToSource, batesStampDocuments, burnIn, createFromBlob, exportPdf, loadPdf, verifyRedaction } from "@/modules/office/pdf/service";
import { saveOfficeDoc } from "@/modules/office/shared/docs-service";

beforeAll(() => { resetSqlite(); });

const NOW = "2026-09-28T10:00:00.000Z";

async function memoPdf(opts: { imagePage?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setAuthor("Girish Hegde");
  doc.setTitle("MW-7 results");
  const p1 = doc.addPage([612, 792]);
  const lines = [
    "From: Girish Hegde <g.hegde@meridianfinechem.example>",
    "To: Nandini Bose <n.bose@meridianfinechem.example>",
    "Cc: Rohit Kapur, Esq. <r.kapur@kapurlegal.example>",
    "Date: April 11, 2006",
    "Subject: MW-7 quarterly results",
    "",
    "The MW-7 result is the third consecutive quarter above the action level.",
    "Contractor SSN 412-55-8367, DOB: 03/14/1971, phone (843) 555-0192.",
    "Please send the lab invoice to billing@konkanenv.example today.",
  ];
  lines.forEach((t, i) => { if (t) p1.drawText(t, { x: 72, y: 720 - i * 16, size: 11, font: helv }); });
  const p2 = doc.addPage([612, 792]);
  p2.drawText("1. Background", { x: 72, y: 720, size: 16, font: bold });
  p2.drawText("The facility has operated since 1994 under permit SC0001234.", { x: 72, y: 696, size: 11, font: helv });
  p2.drawText("1.1 Sampling History", { x: 72, y: 660, size: 13, font: bold });
  p2.drawText("Quarterly sampling began in 2004 at twelve monitoring wells.", { x: 72, y: 640, size: 11, font: helv });
  p2.drawText("2. Next Steps", { x: 72, y: 600, size: 16, font: bold });
  p2.drawText("Respond to DHEC by May 1, 2006.", { x: 72, y: 580, size: 11, font: helv });
  if (opts.imagePage) {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));
    doc.addPage([612, 792]).drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 612, height: 792 });
  }
  return doc.save();
}

async function setup(mode: "draft" | "review" | "ask" = "draft", opts: { imagePage?: boolean; deps?: Parameters<typeof pdfAgentTools>[1] } = {}) {
  const bytes = await memoPdf(opts);
  const ex = await extractPdf(bytes);
  const model: PdfModel = buildModel({ sourceBlobId: "blob_src_1", pageSizes: ex.pages, textIndex: ex.pages.map((p) => (p.needsOcr ? { page: p.page, text: p.text, needsOcr: true } : { page: p.page, text: p.text })), meta: { docInfo: { author: "Girish Hegde", title: "MW-7 results" } } });
  const proposals: EditProposal[] = [];
  const snapshot: PdfSnapshot = { model, title: "MW-7 results", docId: "doc_t", comments: [] };
  const ctx: OfficeAgentContext<PdfSnapshot> = {
    mode, scope: null, research: false, snapshot, matter: null, docTitle: "MW-7 results", context: {}, proposals, findings: [],
    emit: () => {},
    propose: (p) => { const full: EditProposal = { id: `p${proposals.length + 1}`, status: "pending", ...p }; proposals.push(full); return full; },
    finding: (f) => ({ id: "f", ...f }),
  };
  const tools = pdfAgentTools(ctx, { extraction: async () => ex, ...(opts.deps ?? {}) });
  const run = (name: string) => (args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return (t.execute as (a: unknown, c: unknown) => unknown)(args, { emit: () => {}, state: {} });
  };
  return { bytes, ex, model, ctx, tools, proposals, run };
}

describe("mode-scoped toolsets", () => {
  it("Ask offers only read tools; Review adds annotation tools; Draft has production tools", async () => {
    const ask = (await setup("ask")).tools.map((t) => t.name);
    expect(ask.every((n) => PDF_READ_TOOLS.has(n))).toBe(true);
    expect(ask).toEqual(expect.arrayContaining(["search_text", "verify_quote", "summarize_with_page_cites", "extract_table", "privilege_log_entry", "list_form_fields"]));
    expect(ask).not.toContain("add_highlight");
    expect(ask).not.toContain("redact_pattern");
    const review = (await setup("review")).tools.map((t) => t.name);
    expect(review.filter((n) => !PDF_READ_TOOLS.has(n)).sort()).toEqual(Array.from(PDF_ANNOTATION_TOOLS).sort());
    const draft = (await setup("draft")).tools.map((t) => t.name);
    expect(draft).toEqual(expect.arrayContaining(["redact_pattern", "redact_region", "bates_stamp", "split_pdf", "merge_pdfs", "extract_pages", "rotate_pages", "reorder_pages", "delete_pages", "fill_form", "flatten_form", "add_bookmarks", "set_metadata", "highlight_matches", "add_note"]));
    expect(pdfInstructions((await setup("ask")).ctx)).toContain("read-only");
  });
});

describe("search, quotes and cites", () => {
  it("search_text returns pages, exact text, rects and QuadPoints", async () => {
    const { run } = await setup();
    const r = (await run("search_text")({ query: "\\b\\d{3}-\\d{2}-\\d{4}\\b", regex: true })) as { total: number; hits: { page: number; text: string; quads: number[][] }[] };
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ page: 1, text: "412-55-8367" });
    expect(r.hits[0].quads[0]).toHaveLength(8);
  });

  it("verify_quote checks quotes by code and catches wrong pages", async () => {
    const { run } = await setup();
    expect(await run("verify_quote")({ page: 2, quote: "Respond to DHEC by May 1, 2006." })).toMatchObject({ found: true, status: "verified" });
    expect(await run("verify_quote")({ page: 1, quote: "Respond to DHEC by May 1, 2006" })).toMatchObject({ found: false, status: "wrong_page", foundOnPages: [2] });
    expect(await run("verify_quote")({ page: 2, quote: "Respond to EPA by June 1" })).toMatchObject({ status: "not_found" });
  });

  it("summarize_with_page_cites verifies every quote against its page", async () => {
    const { run } = await setup("ask", { deps: { summarizeCited: async () => ({ bullets: [
      { text: "DHEC response deadline", page: 2, quote: "Respond to DHEC by May 1, 2006" },
      { text: "Exceedance", page: 2, quote: "third consecutive quarter above the action level" },
      { text: "Invented", page: 1, quote: "the facility will close in 2007" },
    ] }) } });
    const r = (await run("summarize_with_page_cites")({})) as { bullets: { status: string; foundOnPages?: number[] }[]; verified: number };
    expect(r.bullets.map((b) => b.status)).toEqual(["verified", "wrong_page", "unsupported"]);
    expect(r.bullets[1].foundOnPages).toEqual([1]);
    expect(r.verified).toBe(1);
  });

  it("excludes needs-OCR pages from text claims and labels them in the snapshot", async () => {
    const { run, ctx } = await setup("ask", { imagePage: true });
    const pages = (await run("get_pages_text")({ from: 3, to: 3 })) as { pages: { needs_ocr?: boolean; text: string }[]; note?: string };
    expect(pages.pages[0]).toMatchObject({ needs_ocr: true, text: "" });
    const s = (await run("search_text")({ query: "DHEC" })) as { note?: string };
    expect(s.note).toMatch(/Pages 3 are image-only/);
    const snap = renderSnapshot(parseSnapshot({ model: ctx.snapshot.model, title: "x" }), null);
    expect(snap).toContain("NEEDS OCR: pages 3");
    expect(snap).toContain("=== Page 3 ===\n(NEEDS OCR");
    expect(await run("verify_quote")({ page: 3, quote: "anything at all" })).toMatchObject({ status: "unverifiable_needs_ocr" });
  });
});

describe("redaction and production tools", () => {
  it("redact_pattern previews matches, then applies only the chosen ones as high-risk proposals", async () => {
    const { run, ctx, proposals } = await setup();
    const prev = (await run("redact_pattern")({ presets: ["ssn", "dob", "email", "phone"] })) as { action: string; total: number; matches: { id: string; kind: string; text: string }[] };
    expect(prev.action).toBe("preview");
    expect(prev.matches.map((m) => m.text)).toEqual(expect.arrayContaining(["412-55-8367", "DOB: 03/14/1971", "(843) 555-0192", "billing@konkanenv.example"]));
    expect(proposals).toHaveLength(0); // preview proposes nothing
    const ids = prev.matches.filter((m) => m.kind !== "Email addresses").map((m) => m.id);
    const applied = (await run("redact_pattern")({ action: "apply", match_ids: ids, reason: "PII" })) as { added: number; note: string };
    expect(applied.added).toBe(ids.length);
    expect(applied.note).toMatch(/REMOVED/);
    expect(proposals[0].risk).toBe("high");
    expect(ctx.snapshot.model.annotations.filter((a) => a.type === "redaction").map((a) => a.quote)).not.toContain("billing@konkanenv.example");
    // custom regex
    const custom = (await run("redact_pattern")({ regex: "SC\\d{7}" })) as { matches: { text: string }[] };
    expect(custom.matches.map((m) => m.text)).toEqual(["SC0001234"]);
    await expect(run("redact_pattern")({ regex: "(" }) as Promise<unknown>).rejects.toThrow(/Invalid regex/);
  });

  it("redact_region converts top-left coordinates to PDF space", async () => {
    const { run, ctx } = await setup();
    await run("redact_region")({ page: 1, x: 72, y: 60, width: 200, height: 20, reason: "Signature" });
    const r = ctx.snapshot.model.annotations.find((a) => a.type === "redaction")!;
    expect(r.rects[0]).toEqual({ x: 72, y: 792 - 60 - 20, w: 200, h: 20 });
  });

  it("add_bookmarks detects headings deterministically with levels", async () => {
    const { run, ctx } = await setup();
    const r = (await run("add_bookmarks")({})) as { bookmarks: { page: number; title: string; level: number }[] };
    expect(r.bookmarks).toEqual([{ page: 2, title: "1. Background", level: 1 }, { page: 2, title: "1.1 Sampling History", level: 2 }, { page: 2, title: "2. Next Steps", level: 1 }]);
    expect(ctx.snapshot.model.bookmarks).toHaveLength(3);
  });

  it("bates_stamp adds an endorsement only when given and honours page ranges and fonts", async () => {
    const { run, ctx } = await setup();
    const r = (await run("bates_stamp")({ prefix: "MFC-", start: 60000, pages: "2", font: "Times-Roman" })) as { first: string; last: string; pages: number };
    expect(r).toMatchObject({ first: "MFC-0060000", last: "MFC-0060000", pages: 1 });
    expect(ctx.snapshot.model.bates).toMatchObject({ font: "Times-Roman", pages: [2] });
    expect(ctx.snapshot.model.bates?.legend).toBeUndefined();
  });

  it("set_metadata, fill_form validation and flatten_form produce proposals", async () => {
    const { run, ctx } = await setup();
    await run("set_metadata")({ title: "MW-7 (produced)" });
    expect(ctx.snapshot.model.metadata).toEqual({ title: "MW-7 (produced)" });
    expect(() => run("flatten_form")({})).toThrow(/no form/);
  });
});

describe("stale proposals", () => {
  it("rejects proposals made against another source version or for deleted annotations", async () => {
    const { run, model, proposals } = await setup();
    await run("add_highlight")({ query: "MW-7 result" });
    const p = proposals[0];
    expect((p.payload as { base?: { sourceBlobId?: string } }).base?.sourceBlobId).toBe("blob_src_1");
    // applies on the version it was made for
    expect(() => applyOp(model, p.payload)).not.toThrow();
    // the source changed (e.g. redactions applied / Bates set stamped) → stale
    const changed = { ...model, sourceBlobId: "blob_src_2" };
    expect(() => applyOp(changed, p.payload)).toThrow(StaleProposalError);
    // removing an annotation that no longer exists → stale
    const withAnn = applyOp(model, { op: "add_annotations", annotations: [{ id: "an_x", page: 1, type: "note", rects: [{ x: 1, y: 1, w: 20, h: 20 }], color: "#FACC15", opacity: 1, author: "t", createdAt: NOW }] });
    const { run: run2, proposals: props2, ctx } = await setup();
    ctx.snapshot.model = withAnn;
    await run2("remove_annotations")({ ids: ["an_x"] });
    expect(() => applyOp(model, props2[0].payload)).toThrow(/no longer exist/);
  });
});

describe("privilege log entry", () => {
  it("does not claim privilege when an attorney is only copied and there is no marker", async () => {
    const { model } = await setup();
    const r = privilegeLogEntry(model, "MW-7 results");
    expect(r.entry.docType).toBe("Email");
    expect(r.entry.author).toContain("Girish Hegde");
    expect(r.entry.cc).toContain("Kapur");
    expect(r.entry.basis).toBeNull();
    expect(r.status).toBe("requires_review");
    expect(r.warnings.join(" ")).toMatch(/only in CC/);
    // the description never repeats the subject line or body
    expect(r.entry.description).not.toMatch(/MW-7|quarterly|action level/);
  });

  it("states a basis when a privilege marker is present, still requiring review", async () => {
    const { model } = await setup();
    const m = { ...model, textIndex: model.textIndex!.map((t) => (t.page === 1 ? { ...t, text: `${t.text}\nPrivileged and confidential — attorney-client communication.` } : t)) };
    const r = privilegeLogEntry(m, "MW-7 results");
    expect(r.entry.basis).toBe("Attorney-Client Privilege");
    expect(r.status).toBe("requires_review");
  });
});

// ---------------------------------------------------------------------------
describe("service: true redaction with verification, Bates sets", () => {
  it("burn-in removes the redacted text, verifies it, and keeps other annotations as native ones", async () => {
    const bytes = await memoPdf();
    const rec = blobs.put(bytes, "application/pdf", { name: "memo.pdf" });
    const { doc } = await createFromBlob(rec.id, { title: "Memo" });
    const ex = await extractPdf(bytes);
    const { searchRuns } = await import("@/modules/office/pdf/text-search");
    const ssn = searchRuns(ex.pages[0].runs, "412-55-8367")[0];
    let m = loadPdf(doc.id)!.model;
    m = applyOp(m, { op: "add_annotations", annotations: [
      { id: "an_red1", page: 1, type: "redaction", rects: ssn.rects, color: "#111111", opacity: 1, author: "t", createdAt: NOW, reason: "SSN", quote: "412-55-8367" },
      { id: "an_note1", page: 2, type: "note", rects: [{ x: 500, y: 700, w: 20, h: 20 }], color: "#FACC15", opacity: 1, author: "Reviewer", createdAt: NOW, text: "check permit" },
    ] });
    saveOfficeDoc(doc.id, { content: m });
    const r = await applyRedactionsToSource(doc.id);
    expect(r!.report.redaction!.verification).toMatchObject({ status: "verified", glyphsInsideBoxes: 0, leaks: [] });
    expect(r!.report.redaction!.pages).toEqual([expect.objectContaining({ page: 1, method: "content-stream", removedGlyphs: 11 })]);
    const next = normalizeModel(loadPdf(doc.id)!.model);
    expect(next.textIndex![0].text).not.toContain("412-55-8367");
    expect(next.textIndex![0].text).toContain("DOB: 03/14/1971");
    expect(next.annotations.find((a) => a.id === "an_note1")).toMatchObject({ type: "note", text: "check permit", native: expect.any(Object) });
    expect(next.annotations.some((a) => a.type === "redaction")).toBe(false);
    // export of the new source: nothing pending, text still gone
    const out = await exportPdf({ docId: doc.id });
    expect((await extractPdf(out.bytes)).pages[0].text).not.toContain("8367");
  }, 60_000);

  it("verification fails when the text is still there (a box alone is not a redaction)", async () => {
    const bytes = await memoPdf();
    const ex = await extractPdf(bytes);
    const { searchRuns } = await import("@/modules/office/pdf/text-search");
    const hit = searchRuns(ex.pages[0].runs, "412-55-8367")[0];
    const model = applyOp(buildModel({ sourceBlobId: "v", pageSizes: ex.pages }), { op: "add_annotations", annotations: [{ id: "an_v", page: 1, type: "redaction", rects: hit.rects, color: "#111111", opacity: 1, author: "t", createdAt: NOW }] });
    const v = await verifyRedaction(bytes, model, ex, { redaction: null, pageMap: { 1: 1, 2: 2 }, removedNativeAnnotations: 0, writtenAnnotations: 0, prunedObjects: 0 });
    expect(v.status).toBe("failed");
    expect(v.glyphsInsideBoxes).toBe(11);
    expect(v.leaks).toEqual([{ page: 1, text: "412-55-8367" }]);
  }, 30_000);

  it("export applies and verifies redactions; a rasterized page is reported (server rasterizer)", async () => {
    const bytes = await memoPdf();
    const rec = blobs.put(bytes, "application/pdf", { name: "memo2.pdf" });
    const { doc } = await createFromBlob(rec.id, { title: "Memo 2" });
    let m = loadPdf(doc.id)!.model;
    m = applyOp(m, { op: "add_annotations", annotations: [{ id: "an_red2", page: 2, type: "redaction", rects: [{ x: 70, y: 690, w: 400, h: 20 }], color: "#111111", opacity: 1, author: "t", createdAt: NOW, reason: "PII" }] });
    const out = await exportPdf({ docId: doc.id, content: m, options: { forceRasterize: true } });
    expect(out.report.redaction!.pages[0]).toMatchObject({ page: 2, method: "rasterized" });
    expect(out.report.redaction!.verification!.status).toBe("verified");
    const ex = await extractPdf(out.bytes);
    expect(ex.pages[1].text).not.toContain("SC0001234");
    expect(ex.pages[1].needsOcr).toBe(true); // a rasterized page is an image now
    expect(ex.pages[0].text).toContain("412-55-8367"); // other pages untouched
  }, 60_000);

  it("Bates-stamps a set of documents with one continuous sequence and refuses to double-stamp", async () => {
    const ids: string[] = [];
    for (const name of ["a.pdf", "b.pdf"]) { const rec = blobs.put(await memoPdf(), "application/pdf", { name }); ids.push((await createFromBlob(rec.id, { title: name })).doc.id); }
    const r = await batesStampDocuments({ docIds: ids, prefix: "HALE-", start: 1, digits: 5, legend: "CONFIDENTIAL", ranges: { [ids[1]]: "2" } });
    expect(r.results.map((x) => [x.status, x.first, x.last])).toEqual([["stamped", "HALE-00001", "HALE-00002"], ["stamped", "HALE-00003", "HALE-00003"]]);
    expect(r.next).toBe(4);
    const m1 = loadPdf(ids[0])!.model;
    expect(m1.bates).toMatchObject({ applied: true, first: "HALE-00001", last: "HALE-00002" });
    expect(m1.textIndex![1].text).toContain("HALE-00002");
    expect(activePages(m1).length).toBe(2);
    const again = await batesStampDocuments({ docIds: [ids[0]], prefix: "HALE-", start: 10 });
    expect(again.results[0]).toMatchObject({ status: "skipped" });
    // burn-in of a Bates-applied doc does not stamp twice
    const b = await burnIn(ids[0], { applyRedactions: true });
    expect((await extractPdf(Uint8Array.from(blobs.get(b!.model.sourceBlobId)!.bytes))).pages[0].text.match(/HALE-00001/g)).toHaveLength(1);
  }, 60_000);
});
