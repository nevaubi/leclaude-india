import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/documents-drafting-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

/** Scripted model runtime: no network, every call recorded. */
const ai = vi.hoisted(() => ({ json: [] as Array<Record<string, unknown>>, text: [] as Array<Record<string, unknown>>, synopsis: "", fail: false }));

vi.mock("@/lib/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/agent")>();
  return {
    ...actual,
    generateJSON: async (opts: { input: string; name?: string } & Record<string, unknown>) => {
      ai.json.push(opts);
      const input = String(opts.input);
      if (opts.name === "document_facts") {
        if (input.includes("LOAN AGREEMENT")) return { facts: [], events: [
          { dateText: "12.01.2020", description: "Loan agreement executed between the parties", parties: [], quote: "This loan agreement is executed on 12.01.2020", page: 1 },
          { dateText: "5th June 2021", description: "Borrower defaulted on instalment", parties: [], quote: "words that are not in the document", page: 1 },
        ] };
        return { facts: [], events: [] };
      }
      if (opts.name === "parawise_replies") {
        if (ai.fail) throw new Error("model down");
        // Paragraph numbers in this batch, with the passage numbers offered for each.
        const paras = [...input.matchAll(/PARAGRAPH (\d+)[^\n]*\n[\s\S]*?Passages for this paragraph: ([^\n]*)/g)].map((m) => ({ n: m[1], passages: [...m[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1])) }));
        return { replies: paras.map((p) => (p.n === "2"
          ? { n: "2", stance: "admitted", reply: "It is admitted that the loan agreement was executed on 12.01.2020.", reasoning: "The agreement records the date.", evidence: [{ passage: p.passages[0] ?? 1, quote: "This loan agreement is executed on 12.01.2020" }, { passage: 99, quote: "anything" }] }
          : p.n === "3"
            ? { n: "3", stance: "denied", reply: "It is denied that any notice was received.", reasoning: "No passage shows a notice.", evidence: [{ passage: p.passages[0] ?? 1, quote: "a quote the passage does not contain" }] }
            : { n: p.n, stance: "no_reply", reply: "", reasoning: "Formal paragraph.", evidence: [] })) };
      }
      if (opts.name === "registry_defects") {
        return { defects: [{ n: "1", category: "fees", task: "Pay the deficit court fee", fix: "Affix court fee stamps for the shortfall and file a memo." }, { n: "2", category: "signatures", task: "Sign the vakalatnama", fix: "Have the advocate sign and the client attest." }] };
      }
      return {};
    },
    generateText: async (opts: { input: string; metadata?: Record<string, string> } & Record<string, unknown>) => {
      ai.text.push(opts);
      if (opts.metadata?.surface === "documents.synopsis") return { text: ai.synopsis, responseId: "r" };
      if (opts.metadata?.surface === "documents.translate") return { text: `[hi] ${String(opts.input).slice(0, 40)}`, responseId: "r" };
      return { text: "", responseId: "r" };
    },
  };
});

import { PDFDocument, StandardFonts } from "pdf-lib";
import { createHash } from "node:crypto";
import { db, resetSqlite } from "@/lib/db";
import type { Principal } from "@/lib/auth/types";
import {
  annexureLabels, buildDateRows, checkSynopsis, computePaperbookIndex, courtDate, datesMarkdown, detectParagraphs, exportBlockers, glossaryHints, newReply, rowVerification,
  ruleCategory, splitDefects, synopsisForExport, TRANSLATION_LABEL, writtenStatementMarkdown,
} from "@/modules/documents/drafting";
import type { DocEvent } from "@/modules/documents/types";
import { setDocStoreForTests } from "@/modules/documents/server/store";
import { DocsError } from "@/modules/documents/server/access";
import { createSet, deleteFile, deleteSet, resetStorageCacheForTests } from "@/modules/documents/server/sets";
import { uploadBrowserPdf, uploadServerFile } from "@/modules/documents/server/ingest";
import { runExtraction } from "@/modules/documents/server/extract";
import { createDefectNotice, draftSynopsis, getDates, getParawise, listDefectNotices, listTranslations, proposeReplies, saveDates, startParawise, translatePages, updateDefect, updateReply } from "@/modules/documents/server/drafting";
import { buildPaperbook, unprintableChars } from "@/modules/documents/server/paperbook";
import { workStore } from "@/modules/documents/server/work-store";
import { extractPdf } from "@/modules/office/pdf/extract";
import { NextRequest } from "next/server";
import * as paperbookRoute from "@/app/api/documents/sets/[id]/paperbook/route";
import * as datesRoute from "@/app/api/documents/sets/[id]/dates/route";

const MATTER = "m_drafting_test";
const person = (id: string, over: Partial<Principal> = {}): Principal => ({ id, name: id, tenantId: "default", roles: ["associate"], matterIds: [MATTER], source: "dev", ...over });
const alice = person("u_alice");
const bob = person("u_bob", { matterIds: [] });
const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function expectStatus(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toBeInstanceOf(DocsError);
  await p.catch((e: DocsError) => expect(e.status).toBe(status));
}

beforeAll(() => {
  resetSqlite();
  db();
  db().matters.put({ id: MATTER, name: "Lender v Borrower", tenantId: "default" } as never);
  setDocStoreForTests("sqlite");
  resetStorageCacheForTests();
});
beforeEach(() => { ai.json = []; ai.text = []; ai.fail = false; });

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

const ev = (id: string, date: string, description: string, over: Partial<DocEvent> = {}): DocEvent => ({ id, setId: "s", fileId: "f1", fileName: "a.pdf", page: 1, date, datePrecision: "day", dateText: date, description, parties: [], quote: "q", quoteFound: true, ...over });

describe("list of dates (pure)", () => {
  const events = [ev("devent_aaaaaaaa1", "2021-03-03", "Agreement executed"), ev("devent_bbbbbbbb2", "2020-01", "Negotiations began", { datePrecision: "month", quoteFound: false }), ev("devent_cccccccc3", "2022-04-03", "Notice served", { page: 3 })];
  it("merges overrides and hand-added rows, sorts by date and marks edited / manual / unverified rows", () => {
    const rows = buildDateRows(events, { overrides: { devent_cccccccc3: { particulars: "Termination notice served" }, devent_aaaaaaaa1: { selected: false } }, manual: [{ id: "manual_x1x1", date: "2019", datePrecision: "year", particulars: "Company incorporated", selected: true }] });
    expect(rows.map((r) => r.id)).toEqual(["manual_x1x1", "devent_bbbbbbbb2", "devent_aaaaaaaa1", "devent_cccccccc3"]);
    expect(rows.map(rowVerification)).toEqual(["manual", "unverified", "quote found", "edited"]);
    expect(rows[2].selected).toBe(false);
    expect(buildDateRows(events, { overrides: { devent_aaaaaaaa1: { removed: true } }, manual: [] })).toHaveLength(2);
  });
  it("prints Indian court dates and the SC / HC layouts with source and verification columns", () => {
    expect(courtDate("2021-03-03", "day")).toBe("03.03.2021");
    expect(courtDate("2021-03", "month")).toBe("March 2021");
    expect(courtDate("2021", "year")).toBe("2021");
    const rows = buildDateRows(events, { overrides: {}, manual: [] });
    const sc = datesMarkdown(rows, { format: "sc", synopsis: "The parties contracted. [R1]" });
    expect(sc.indexOf("## SYNOPSIS")).toBeLessThan(sc.indexOf("## LIST OF DATES"));
    expect(sc).toContain("| 03.03.2021 | Agreement executed | a.pdf, p. 1 |");
    expect(sc).toContain("a.pdf, p. 1 (unverified)");
    expect(sc).toMatch(/1 row is not backed by a quote/);
    const hc = datesMarkdown(rows, { format: "hc", synopsis: "x" });
    expect(hc.indexOf("## LIST OF DATES")).toBeLessThan(hc.indexOf("## SYNOPSIS"));
  });
  it("checks a synopsis against its rows: unknown [Rn], dates not in the rows, uncited sentences", () => {
    const rows = buildDateRows(events, { overrides: {}, manual: [] });
    const text = "Negotiations began in January 2020 and the agreement followed on 03.03.2021. [R1][R2] The respondent then paid Rs. 10 lakh on 15.08.2021 without any written record. A notice was served. [R3][R7]";
    const c = checkSynopsis(text, rows);
    expect(c.unresolved).toEqual([7]);
    expect(c.unknownDates).toEqual(["15.08.2021"]);
    expect(c.uncited).toBe(1);
    expect(synopsisForExport("Agreement made. [R2] Unknown. [R9]", rows)).toBe("Agreement made. [03.03.2021] Unknown. [unresolved R9]");
  });
});

describe("paperbook index (pure)", () => {
  it("labels annexures in order and computes continuous page ranges after the index", () => {
    const entries = [{ title: "Synopsis", annexure: false }, { title: "Agreement", annexure: true }, { title: "Notice", annexure: true }];
    expect(annexureLabels(entries, "R")).toEqual([null, "ANNEXURE R-1", "ANNEXURE R-2"]);
    const idx = computePaperbookIndex(entries, [3, 10, 1], { prefix: "P", startPage: 1, indexPage: true });
    expect(idx.indexPages).toBe(1);
    expect(idx.rows.map((r) => [r.annexure, r.from, r.to])).toEqual([[null, 2, 4], ["ANNEXURE P-1", 5, 14], ["ANNEXURE P-2", 15, 15]]);
    expect(idx.totalPages).toBe(15);
    const noIndex = computePaperbookIndex(entries, [3, 10, 1], { prefix: "P", startPage: 21, indexPage: false });
    expect(noIndex.rows[0]).toMatchObject({ from: 21, to: 23 });
  });
});

describe("para-wise reply (pure)", () => {
  it("detects numbered paragraphs in sequence; nested numbering and dates stay inside their paragraph", () => {
    const pages = [
      { page: 1, text: "IN THE COURT OF THE CITY CIVIL JUDGE\nO.S. No. 12/2024\n\nPLAINT\n1. The plaintiff is a bank.\n2. The defendant borrowed Rs. 5,00,000\nunder an agreement dated 12.01.2020." },
      { page: 2, text: "3. The defendant failed to pay:\n1. the instalment of June;\n2. interest.\n4. A notice was issued.\n7. Stray numbering is not a paragraph." },
    ];
    const paras = detectParagraphs(pages);
    expect(paras.map((p) => [p.n, p.page])).toEqual([["1", 1], ["2", 1], ["3", 2], ["4", 2]]);
    expect(paras[1].text).toBe("The defendant borrowed Rs. 5,00,000 under an agreement dated 12.01.2020.");
    expect(paras[2].text).toContain("1. the instalment of June; 2. interest.");
    expect(paras[3].text).toContain("Stray numbering");
  });
  it("blocks export until every admission is approved", () => {
    const paras = detectParagraphs([{ page: 1, text: "1. A.\n2. B." }]).map(newReply);
    paras[0] = { ...paras[0], stance: "admitted", reply: "Admitted." };
    expect(exportBlockers(paras)).toEqual({ unapprovedAdmissions: ["1"] });
    expect(() => writtenStatementMarkdown({ fileName: "plaint.pdf", paras })).toThrow(/paragraph 1 need approval/);
    paras[0] = { ...paras[0], approved: true };
    const md = writtenStatementMarkdown({ fileName: "plaint.pdf", paras });
    expect(md).toContain("1. The contents of paragraph 1 of the plaint are admitted. Admitted.");
    expect(md).toContain("2. Paragraph 2 of the plaint calls for no reply.");
  });
});

describe("defects and glossary (pure)", () => {
  it("splits numbered, bracketed, roman and bulleted defect notices", () => {
    const notice = "OFFICE OF THE REGISTRAR\nDefects noticed in Diary No. 1234/2026:\n1. Deficit court fee of Rs. 250.\n2) Vakalatnama not signed by the advocate\n   on record.\n(3) Annexure P-4 is illegible; file a typed copy.\n(iv) Vernacular documents filed without translation.\n• Margins less than 4 cm on the left.";
    const d = splitDefects(notice);
    expect(d.map((x) => x.n)).toEqual(["1", "2", "3", "iv", "5"]);
    expect(d[1].text).toBe("Vakalatnama not signed by the advocate on record.");
    expect(d.map((x) => ruleCategory(x.text))).toEqual(["fees", "signatures", "formatting", "translation", "formatting"]);
    expect(ruleCategory("Certified copy of the impugned order not filed.")).toBe("missing_documents");
    expect(splitDefects("Please cure the pagination.\nIndex missing.")).toEqual([{ n: "1", text: "Please cure the pagination." }, { n: "2", text: "Index missing." }]);
  });
  it("gives glossary hints only for English ↔ Indian language pairs", () => {
    expect(glossaryHints("en", "hi")).toContain("plaintiff → वादी");
    expect(glossaryHints("hi", "en")).toContain("वादी → plaintiff");
    expect(glossaryHints("hi", "kn")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Server (SQLite)
// ---------------------------------------------------------------------------------------------------------------------

const LOAN = "LOAN AGREEMENT\n\nThis loan agreement is executed on 12.01.2020 between Lender Bank Ltd. and Mr. R. Kumar.\n\nThe borrower shall repay in 24 instalments.";
const PLAINT = "IN THE COURT OF THE PRINCIPAL CITY CIVIL JUDGE AT BENGALURU\nO.S. No. 12/2024\n\n1. The plaintiff is a scheduled bank.\n2. The defendant executed a loan agreement on 12.01.2020.\n3. A legal notice dated 01.02.2023 was received by the defendant.";

describe("drafting services on SQLite", () => {
  let setId = "";
  let loanId = "";
  let plaintId = "";

  it("sets up a matter set with a loan agreement and a plaint, and extracts the timeline", async () => {
    const set = await createSet(alice, { name: "Recovery suit", matterId: MATTER });
    setId = set.id;
    const a = await uploadServerFile(alice, setId, { name: "loan.txt", mime: "text/plain", bytes: bytes(LOAN) });
    const b = await uploadServerFile(alice, setId, { name: "plaint.txt", mime: "text/plain", bytes: bytes(PLAINT) });
    if (a.status !== "created" || b.status !== "created") throw new Error("upload failed");
    loanId = a.file.id; plaintId = b.file.id;
    await runExtraction(alice, setId, {});
  });

  it("lists dates from the timeline, saves edits with compare-and-set, and never lets an unauthorised user read them", async () => {
    const v = await getDates(alice, setId);
    expect(v.rows.map((r) => [r.date, r.quoteFound])).toEqual([["2020-01-12", true], ["2021-06-05", false]]);
    const id = v.rows[0].id;
    const saved = await saveDates(alice, setId, { version: v.state.version, format: "hc", overrides: { [id]: { particulars: "Loan agreement executed (Rs. 5 lakh)" } }, manual: [{ date: "01.02.2023", particulars: "Legal notice issued" }] });
    expect(saved.state.format).toBe("hc");
    expect(saved.rows.find((r) => r.id === id)).toMatchObject({ edited: true, particulars: "Loan agreement executed (Rs. 5 lakh)" });
    expect(saved.rows.at(-1)).toMatchObject({ manual: true, date: "2023-02-01" });
    await expectStatus(saveDates(alice, setId, { version: v.state.version, format: "sc" }), 409);
    await expectStatus(saveDates(alice, setId, { version: saved.state.version, manual: [{ date: "someday", particulars: "x" }] }), 422);
    await expectStatus(getDates(bob, setId), 404);
    await expectStatus(saveDates(bob, setId, { version: saved.state.version }), 404);
  });

  it("drafts a synopsis from the selected rows only and records what does not check out", async () => {
    const v = await getDates(alice, setId);
    ai.synopsis = "The defendant executed a loan agreement on 12.01.2020. [R1] He defaulted thereafter. [R2] A decree was passed on 09.09.2024. [R5]";
    const out = await draftSynopsis(alice, setId, { rowIds: v.rows.slice(0, 2).map((r) => r.id), version: v.state.version });
    expect(ai.text[0].input).toContain("[R1] 12.01.2020");
    expect(String(ai.text[0].input)).not.toContain("Legal notice issued");
    expect(out.state.synopsis).toMatchObject({ unresolved: [5], unknownDates: ["09.09.2024"], edited: false, rowIds: v.rows.slice(0, 2).map((r) => r.id) });
    const edited = await saveDates(alice, setId, { version: out.state.version, synopsisText: "Edited synopsis. [R1]" });
    expect(edited.state.synopsis).toMatchObject({ text: "Edited synopsis. [R1]", edited: true });
    await expectStatus(draftSynopsis(alice, setId, { rowIds: [] }), 422);
  });

  it("detects the plaint's paragraphs, proposes replies with code-checked quotes, and requires approval of admissions", async () => {
    await expectStatus(startParawise(alice, setId, loanId), 422); // no numbered paragraphs
    const started = await startParawise(alice, setId, plaintId);
    expect(started.state?.paras.map((p) => p.n)).toEqual(["1", "2", "3"]);
    const r = await proposeReplies(alice, setId, plaintId, { version: started.state!.version });
    const [, p2, p3] = r.state!.paras;
    expect(p2.proposed?.stance).toBe("admitted");
    expect(p2.proposed?.evidence).toEqual([expect.objectContaining({ fileId: loanId, quoteFound: true })]);
    expect(p2.proposed?.droppedRefs).toBe(1); // passage 99 was never supplied: dropped, not re-bound
    expect(p3.proposed?.evidence[0].quoteFound).toBe(false);
    expect(p2.approved).toBe(false);
    // Passages offered come only from the other files of the set (never the plaint itself).
    expect(String(ai.json.at(-1)?.input)).not.toMatch(/plaint\.txt, page|\] plaint\.txt/);
    expect(() => writtenStatementMarkdown(r.state!)).toThrow(/need approval/);
    const approved = await updateReply(alice, setId, plaintId, { version: r.state!.version, n: "2", approve: true });
    expect(approved.state!.paras[1]).toMatchObject({ approved: true, approvedBy: "u_alice" });
    expect(writtenStatementMarkdown(approved.state!)).toContain("paragraph 2 of the plaint are admitted");
    const edited = await updateReply(alice, setId, plaintId, { version: approved.state!.version, n: "2", reply: "Admitted, save that the amount is disputed." });
    expect(edited.state!.paras[1]).toMatchObject({ approved: false, edited: true });
    await expectStatus(updateReply(alice, setId, plaintId, { version: approved.state!.version, n: "2", approve: true }), 409);
    expect((await getParawise(alice, setId, plaintId)).stale).toBe(false);
  });

  it("marks failed proposals as failed instead of inventing replies", async () => {
    const v = await getParawise(alice, setId, plaintId);
    ai.fail = true;
    const r = await proposeReplies(alice, setId, plaintId, { version: v.state!.version, ns: ["1"] });
    expect(r.failed).toBe(1);
    expect(r.state!.paras[0]).toMatchObject({ status: "failed" });
  });

  it("stores page translations with the source hash and the working-translation label; reuses current ones", async () => {
    const out = await translatePages(alice, setId, { fileId: loanId, from: "en", to: "hi" });
    expect(out.translated).toBe(1);
    expect(out.records[0]).toMatchObject({ to: "hi", label: TRANSLATION_LABEL, stale: false });
    expect(String(ai.text[0].instructions)).toContain("plaintiff → वादी");
    const again = await translatePages(alice, setId, { fileId: loanId, from: "en", to: "hi" });
    expect(again).toMatchObject({ translated: 0, skipped: 1 });
    expect((await listTranslations(alice, setId, loanId, "hi")).records).toHaveLength(1);
    await expectStatus(translatePages(alice, setId, { fileId: loanId, from: "hi", to: "kn" }), 422);
    await expectStatus(listTranslations(bob, setId, loanId), 404);
  });

  it("splits a defect notice, classifies it (AI, or rules when off) and tracks done items without filing anything", async () => {
    const text = "1. Deficit court fee.\n2. Vakalatnama not signed.\n3. Pages not numbered.";
    const ruled = await createDefectNotice(alice, setId, { forum: "sc", text, useAi: false });
    expect(ruled.defects.map((d) => [d.category, d.classifiedBy])).toEqual([["fees", "rule"], ["signatures", "rule"], ["formatting", "rule"]]);
    expect(ruled.aiClassified).toBe(false);
    const n = await createDefectNotice(alice, setId, { forum: "hc", text });
    expect(n.aiClassified).toBe(true);
    expect(n.defects[0]).toMatchObject({ category: "fees", classifiedBy: "ai", task: "Pay the deficit court fee" });
    expect(n.defects[2]).toMatchObject({ category: "formatting", classifiedBy: "rule" });
    const done = await updateDefect(alice, setId, n.id, { version: n.version, defectId: n.defects[0].id, done: true });
    expect(done.defects[0]).toMatchObject({ done: true, doneBy: "u_alice" });
    await expectStatus(updateDefect(alice, setId, n.id, { version: n.version, defectId: n.defects[1].id, done: true }), 409);
    expect(await listDefectNotices(alice, setId)).toHaveLength(2);
  });

  it("deletes a file's work items with the file, and every item with the set", async () => {
    const ws = await workStore();
    expect(await ws.list(setId, "translation", { prefix: `${loanId}:` })).toHaveLength(1);
    await deleteFile(alice, setId, loanId);
    expect(await ws.list(setId, "translation")).toHaveLength(0);
    await deleteSet(alice, setId);
    expect(await ws.list(setId, "defects")).toHaveLength(0);
    expect(await ws.get(setId, "parawise", plaintId)).toBeNull();
  });
});

describe("paperbook builder", () => {
  let setId = "";
  let textId = "";
  let hindiId = "";
  let pdfId = "";
  let original: Uint8Array;

  beforeAll(async () => {
    const set = await createSet(alice, { name: "Appeal paperbook", matterId: MATTER });
    setId = set.id;
    const t = await uploadServerFile(alice, setId, { name: "order.txt", mime: "text/plain", bytes: bytes(`ORDER\n\n${"The appeal is admitted. ".repeat(400)}`) });
    const h = await uploadServerFile(alice, setId, { name: "fir.txt", mime: "text/plain", bytes: bytes("प्रथम सूचना रिपोर्ट — FIR No. 12/2024") });
    const doc = await PDFDocument.create();
    const f = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) doc.addPage([400, 500]).drawText(`Original page ${i + 1}`, { x: 40, y: 400, size: 12, font: f });
    original = await doc.save();
    const p = await uploadBrowserPdf(alice, setId, { kind: "pdf-text", name: "agreement.pdf", size: original.length, sha256: sha(original), pages: ["Original page 1", "Original page 2"] });
    if (t.status !== "created" || h.status !== "created" || p.status !== "created") throw new Error("upload failed");
    textId = t.file.id; hindiId = h.file.id; pdfId = p.file.id;
  });

  it("previews the index deterministically and builds a PDF with index, page numbers, annexure markers and bookmarks", async () => {
    const spec = { title: "Civil Appeal paperbook", court: "IN THE SUPREME COURT OF INDIA", prefix: "P", startPage: 1, indexPage: true, trueCopy: true,
      entries: [{ fileId: textId, title: "Impugned order", annexure: false }, { fileId: pdfId, uploadKey: "orig1", title: "Loan agreement", annexure: true }] };
    const uploads = [{ key: "orig1", name: "agreement.pdf", mime: "application/pdf", bytes: original }];
    const preview = await buildPaperbook(alice, setId, spec, uploads, { preview: true });
    expect(preview.pdf.byteLength).toBe(0);
    const typed = preview.index[0].pages;
    expect(typed).toBeGreaterThan(1); // long page continues on further pages
    expect(preview.index.map((r) => [r.annexure, r.from, r.to])).toEqual([[null, 2, 1 + typed], ["ANNEXURE P-1", 2 + typed, 3 + typed]]);
    const built = await buildPaperbook(alice, setId, spec, uploads);
    const pdf = await PDFDocument.load(built.pdf);
    expect(pdf.getPageCount()).toBe(1 + typed + 2);
    expect(pdf.getTitle()).toBe("Civil Appeal paperbook");
    const ex = await extractPdf(built.pdf);
    expect(ex.pages[0].text).toMatch(/INDEX/);
    expect(ex.pages[0].text).toMatch(/Impugned order/);
    expect(ex.pages[1].text).toMatch(/Typed from the extracted text of order\.txt\. Not a facsimile/);
    const annexPage = ex.pages[1 + typed].text;
    expect(annexPage).toMatch(/ANNEXURE P-1/);
    expect(annexPage).toMatch(/TRUE COPY/);
    expect(annexPage).toMatch(/Original page 1/);
    expect(ex.pages.at(-1)!.text).toMatch(new RegExp(`\\b${3 + typed}\\b`));
    expect(ex.outline?.map((o: { title: string }) => o.title)).toEqual(["Index", "Impugned order", "ANNEXURE P-1 — Loan agreement"]);
  });

  it("refuses an attached original whose SHA-256 differs, and text the PDF fonts cannot print (never '?')", async () => {
    expect(unprintableChars("प्रथम ? FIR")).toBe(5);
    const other = await PDFDocument.create(); other.addPage();
    await expectStatus(buildPaperbook(alice, setId, { title: "x", entries: [{ fileId: pdfId, uploadKey: "o", title: "Agreement", annexure: true }] }, [{ key: "o", name: "other.pdf", mime: "application/pdf", bytes: await other.save() }]), 422);
    await buildPaperbook(alice, setId, { title: "x", entries: [{ fileId: hindiId, title: "FIR", annexure: true }] }).catch((e: DocsError) => {
      expect(e.status).toBe(422);
      expect(e.message).toMatch(/attach the original PDF/);
    });
    await expectStatus(buildPaperbook(alice, setId, { title: "x", entries: [] }), 422);
    await expectStatus(buildPaperbook(bob, setId, { title: "x", entries: [{ fileId: textId, title: "t", annexure: false }] }), 404);
  });

  it("embeds image attachments as pages and serves the PDF from the route (multipart)", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const fd = new FormData();
    fd.set("spec", JSON.stringify({ title: "With photo", prefix: "R", indexPage: false, entries: [{ uploadKey: "photo", title: "Site photograph", annexure: true }] }));
    fd.set("upload:photo", new File([png], "photo.png", { type: "image/png" }));
    const res = await paperbookRoute.POST(new NextRequest(`http://localhost/api/documents/sets/${setId}/paperbook`, { method: "POST", body: fd }), { params: Promise.resolve({ id: setId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(pdf.getPageCount()).toBe(1);
    const prev = await paperbookRoute.POST(new NextRequest(`http://localhost/api/documents/sets/${setId}/paperbook?preview=1`, { method: "POST", body: JSON.stringify({ title: "t", entries: [{ fileId: textId, title: "Order", annexure: false }] }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: setId }) });
    expect((await prev.json()).index[0]).toMatchObject({ sl: 1, from: 2 });
    const denied = await datesRoute.GET(new NextRequest("http://localhost/api/documents/sets/dset_nope/dates"), { params: Promise.resolve({ id: "dset_nope" }) });
    expect(denied.status).toBe(404);
  });
});
