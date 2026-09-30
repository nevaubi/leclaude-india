import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/documents-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

/** The model runtime is scripted: no network, every call recorded. */
const ai = vi.hoisted(() => ({
  runAgent: [] as Array<Record<string, unknown>>,
  generateJSON: [] as Array<Record<string, unknown>>,
  describeImage: [] as Array<{ url: string; prompt?: string; opts?: unknown }>,
  answer: "",
  ocrText: "",
}));

vi.mock("@/lib/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/agent")>();
  return {
    ...actual,
    runAgent: async (opts: { onEvent: (e: unknown) => void } & Record<string, unknown>) => {
      ai.runAgent.push(opts);
      opts.onEvent({ type: "start", model: "test-model" });
      for (const part of ai.answer.match(/.{1,12}/gs) ?? []) opts.onEvent({ type: "text.delta", delta: part });
      return { text: ai.answer, responseId: null, steps: 1, toolCalls: [], usage: { input: 0, output: 0, total: 0 } };
    },
    generateJSON: async (opts: { input: string } & Record<string, unknown>) => {
      ai.generateJSON.push(opts);
      const input = String(opts.input);
      if (input.includes("SERVICES AGREEMENT")) {
        return {
          facts: [
            { statement: "The Client must pay a fee of Rs. 5,00,000 within 30 days of invoice.", parties: ["Acme Traders Pvt. Ltd."], category: "amount", quote: "The Client shall pay a fee of Rs. 5,00,000 within 30 days of invoice.", page: 1, date: null },
            { statement: "The Contractor admitted liability.", parties: ["Bharat Logistics LLP"], category: "admission", quote: "The Contractor admits all liability", page: 3, date: null },
            { statement: "The Contractor must indemnify the Client for delay losses.", parties: ["Bharat Logistics LLP", "Acme Traders Pvt. Ltd."], category: "obligation", quote: "The Contractor shall  indemnify the Client against all losses", page: 3, date: "3rd March, 2021" },
          ],
          events: [
            { dateText: "3rd March, 2021", description: "Services agreement made", parties: ["Acme Traders Pvt. Ltd.", "Bharat Logistics LLP"], quote: "This Agreement is made on 3rd March, 2021", page: 1 },
            // Stated on the wrong page: relocated to the page where the quote actually is.
            { dateText: "03.04.2022", description: "Notice of termination served", parties: [], quote: "Notice of termination was served on 03.04.2022.", page: 1 },
            { dateText: "sometime later", description: "Unresolvable date", parties: [], quote: "", page: null },
          ],
        };
      }
      if (input.includes("Meeting notes")) {
        return { facts: [], events: [{ dateText: "March 2021", description: "Parties met on the delivery schedule", parties: [], quote: "The parties met in March 2021", page: null }] };
      }
      return { facts: [], events: [] };
    },
    describeImage: async (url: string, prompt?: string, opts?: unknown) => {
      ai.describeImage.push({ url, prompt, opts });
      return { text: ai.ocrText, responseId: "r" };
    },
  };
});

import { db, resetSqlite } from "@/lib/db";
import type { Principal } from "@/lib/auth/types";
import { parseDocSourceId, type BrowserPdfUpload } from "@/modules/documents/types";
import { chunkPage, joinChunks, normalizeDate, quoteFound, normalizePageText } from "@/modules/documents/server/text";
import { setDocStoreForTests, docStore } from "@/modules/documents/server/store";
import { DocsError } from "@/modules/documents/server/access";
import { createSet, deleteFile, deleteSet, getFilePages, listFiles, listSets, resetStorageCacheForTests, updateSet } from "@/modules/documents/server/sets";
import { appendPages, decodePageImage, ocrPage, uploadBrowserPdf, uploadServerFile } from "@/modules/documents/server/ingest";
import { askDocSet, mapMarkers, NO_EVIDENCE_ANSWER, type AskEvent } from "@/modules/documents/server/ask";
import { buildWindows, listFacts, listTimeline, runExtraction } from "@/modules/documents/server/extract";
import { listDocSets, readDocPassage, searchDocSets } from "@/modules/documents/server";
import { retrievePassages } from "@/modules/documents/server/search";
import { NextRequest } from "next/server";
import { readSSE } from "@/lib/ai/sse";
import * as setsRoute from "@/app/api/documents/sets/route";
import * as setRoute from "@/app/api/documents/sets/[id]/route";
import * as filesRoute from "@/app/api/documents/sets/[id]/files/route";
import * as askRoute from "@/app/api/documents/sets/[id]/ask/route";
import * as statusRoute from "@/app/api/documents/status/route";

const MATTER = "m_docs_test";
const person = (id: string, over: Partial<Principal> = {}): Principal => ({ id, name: id, tenantId: "default", roles: ["associate"], matterIds: [MATTER], source: "dev", ...over });
const alice = person("u_alice");
const carol = person("u_carol", { roles: ["paralegal"] });
const bob = person("u_bob", { matterIds: [] });
const mallory = person("u_mallory", { tenantId: "other", roles: ["partner"], matterIds: "*" });

const sha = (c: string) => c.repeat(64);
const PAGE1 = "SERVICES AGREEMENT\n\nThis Agreement is made on 3rd March, 2021 between Acme Traders Pvt. Ltd. (the Client) and Bharat Logistics LLP (the Contractor).\n\nThe Client shall pay a fee of Rs. 5,00,000 within 30 days of invoice.";
const PAGE3 = "The Contractor shall indemnify the Client against all losses arising from delay. Notice of termination was served on 03.04.2022.";
const pdf = (over: Partial<BrowserPdfUpload & { totalPages: number }> = {}) => ({ kind: "pdf-text" as const, name: "agreement.pdf", size: 120_000, sha256: sha("a"), pages: [PAGE1, "   ", PAGE3], docDate: "2021-03-03T00:00:00Z", ...over });
const bytes = (s: string) => new TextEncoder().encode(s);
const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString("base64")}`;

async function expectDocsError(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toBeInstanceOf(DocsError);
  await p.catch((e: DocsError) => expect(e.status).toBe(status));
}

beforeAll(() => {
  resetSqlite();
  db();
  db().matters.put({ id: MATTER, name: "Acme v Bharat", tenantId: "default" } as never);
  setDocStoreForTests("sqlite");
  resetStorageCacheForTests();
});

beforeEach(() => {
  ai.runAgent = [];
  ai.generateJSON = [];
  ai.describeImage = [];
});

describe("chunking", () => {
  it("splits a page on paragraph/sentence boundaries with overlap and rebuilds it exactly", () => {
    const para = (i: number) => `Paragraph ${i}. ${"The respondent failed to deliver the goods on time and the claimant suffered loss. ".repeat(6)}`;
    const text = normalizePageText(Array.from({ length: 8 }, (_, i) => para(i)).join("\n\n"));
    const chunks = chunkPage(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].lead).toBe(0);
    for (const [i, c] of chunks.entries()) {
      expect(c.text.length - c.lead).toBeLessThanOrEqual(1500);
      if (i > 0) {
        expect(c.lead).toBeGreaterThan(50);
        expect(c.lead).toBeLessThanOrEqual(150);
        const prevBody = chunks[i - 1].text.slice(chunks[i - 1].lead);
        expect(prevBody.endsWith(c.text.slice(0, c.lead))).toBe(true);
      }
    }
    // Bodies end on a boundary (paragraph or sentence), not mid-word.
    expect(chunks.slice(0, -1).every((c) => /[.\n ]$/.test(c.text))).toBe(true);
    expect(joinChunks(chunks)).toBe(text);
    expect(chunkPage("")).toEqual([]);
    expect(chunkPage("short")).toEqual([{ text: "short", lead: 0 }]);
  });

  it("hard-cuts text with no boundaries", () => {
    const text = "x".repeat(4000);
    const chunks = chunkPage(text);
    expect(joinChunks(chunks)).toBe(text);
    expect(chunks.every((c) => c.text.length - c.lead <= 1500)).toBe(true);
  });
});

describe("date normalisation", () => {
  it.each([
    ["3rd March, 2021", "2021-03-03", "day"],
    ["3 March 2021", "2021-03-03", "day"],
    ["the 21st day of June, 2019", "2019-06-21", "day"],
    ["March 3, 2021", "2021-03-03", "day"],
    ["03.03.2021", "2021-03-03", "day"],
    ["03.04.2021", "2021-04-03", "day"], // DD.MM.YYYY, never MM.DD
    ["3/4/2021", "2021-04-03", "day"],
    ["31-12-21", "2021-12-31", "day"],
    ["12-Jan-2020", "2020-01-12", "day"],
    ["2021-03-03", "2021-03-03", "day"],
    ["2021-03-03T10:00:00Z", "2021-03-03", "day"],
    ["March 2021", "2021-03", "month"],
    ["Sept, 2020", "2020-09", "month"],
    ["2021-03", "2021-03", "month"],
    ["2021", "2021", "year"],
  ])("%s → %s (%s)", (input, date, precision) => {
    expect(normalizeDate(input)).toEqual({ date, precision });
  });

  it.each(["31.02.2021", "13/25/2021", "sometime later", "", "March", "3rd March", "99999"])("rejects %s", (input) => {
    expect(normalizeDate(input)).toBeNull();
  });
});

describe("quote check", () => {
  const text = "The Contractor shall indemnify the Client against all losses arising from “delay”.\nNotice was served.";
  it("ignores whitespace, case and quote style", () => {
    expect(quoteFound("the contractor shall   INDEMNIFY the client", text)).toBe(true);
    expect(quoteFound('arising from "delay"', text)).toBe(true);
    expect(quoteFound("losses arising from “delay”. Notice was served", text)).toBe(true);
  });
  it("checks ellipsis parts in order and rejects paraphrase or empty quotes", () => {
    expect(quoteFound("The Contractor shall … all losses", text)).toBe(true);
    expect(quoteFound("all losses ... The Contractor shall", text)).toBe(false);
    expect(quoteFound("The Contractor admits all liability", text)).toBe(false);
    expect(quoteFound("", text)).toBe(false);
  });
});

describe("document sets on SQLite", () => {
  let setId = "";
  let pdfId = "";
  let txtId = "";

  it("creates a personal set and uploads a browser-read PDF with a scanned page", async () => {
    const set = await createSet(alice, { name: "  Acme contract bundle ", description: "Contracts" });
    setId = set.id;
    expect(set).toMatchObject({ name: "Acme contract bundle", ownerId: "u_alice", matterId: null, fileCount: 0 });
    const res = await uploadBrowserPdf(alice, setId, pdf());
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    pdfId = res.file.id;
    expect(res.file).toMatchObject({ method: "browser-pdfjs", hashOrigin: "browser", status: "partial", pages: 3, ocrPages: [2], pagesReceived: 3, docDate: "2021-03-03T00:00:00.000Z", extraction: "pending" });
    expect(res.file.chars).toBe(PAGE1.length + PAGE3.length);
    const dup = await uploadBrowserPdf(alice, setId, pdf({ name: "copy.pdf" }));
    expect(dup).toMatchObject({ status: "duplicate", file: { id: pdfId } });
  });

  it("rejects malformed browser uploads with a reason", async () => {
    expect(await uploadBrowserPdf(alice, setId, pdf({ sha256: "nope" }))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/SHA-256/) });
    expect(await uploadBrowserPdf(alice, setId, pdf({ name: "a.docx", sha256: sha("b") }))).toMatchObject({ status: "rejected" });
    expect(await uploadBrowserPdf(alice, setId, pdf({ sha256: sha("b"), totalPages: 99_999 }))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/3000 pages/) });
  });

  it("extracts multipart text and email files on the server", async () => {
    const txt = await uploadServerFile(alice, setId, { name: "notes.txt", mime: "text/plain", bytes: bytes("Meeting notes.\n\nThe parties met in March 2021 to discuss the delivery schedule.") });
    expect(txt).toMatchObject({ status: "created", file: { method: "server-text", hashOrigin: "server", status: "ready", pages: 1, docDate: null } });
    if (txt.status === "created") txtId = txt.file.id;
    const eml = await uploadServerFile(alice, setId, { name: "termination.eml", mime: "message/rfc822", bytes: bytes("From: a@acme.in\r\nTo: b@bharat.in\r\nDate: Tue, 05 Apr 2022 10:00:00 +0530\r\nSubject: Termination\r\nContent-Type: text/plain\r\n\r\nPlease find attached the termination notice.\r\n") });
    expect(eml).toMatchObject({ status: "created", file: { method: "server-eml", docDate: "2022-04-05T04:30:00.000Z", status: "ready" } });
    const again = await uploadServerFile(alice, setId, { name: "notes-copy.txt", mime: "text/plain", bytes: bytes("Meeting notes.\n\nThe parties met in March 2021 to discuss the delivery schedule.") });
    expect(again).toMatchObject({ status: "duplicate", file: { id: txtId } });
    expect(await uploadServerFile(alice, setId, { name: "tool.exe", mime: "application/octet-stream", bytes: bytes("MZ") })).toMatchObject({ status: "rejected" });
    expect(await uploadServerFile(alice, setId, { name: "fake.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: bytes("plain text pretending") })).toMatchObject({ status: "rejected" });
    const { files, total } = await listFiles(alice, setId, {});
    expect(total).toBe(3);
    expect(files.map((f) => f.name).sort()).toEqual(["agreement.pdf", "notes.txt", "termination.eml"]);
    expect((await listFiles(alice, setId, { status: "partial" })).total).toBe(1);
    expect((await listFiles(alice, setId, { q: "NOTES" })).files[0]?.id).toBe(txtId);
    const set = (await listSets(alice)).find((s) => s.id === setId)!;
    expect(set).toMatchObject({ fileCount: 3, pageCount: 5 });
  });

  it("returns stored pages and ranked search hits that cite exact pages", async () => {
    const { pages } = await getFilePages(alice, setId, pdfId);
    expect(pages).toEqual([{ page: 1, text: PAGE1 }, { page: 3, text: PAGE3 }]);
    const hits = await searchDocSets(alice, [setId], "Which party must indemnify against losses?");
    expect(hits[0]).toMatchObject({ fileId: pdfId, page: 3, fileName: "agreement.pdf" });
    expect(parseDocSourceId(hits[0].source)).toMatchObject({ setId, fileId: pdfId, page: 3 });
    // OR fallback: not every word matches, still ranked results.
    const loose = await searchDocSets(alice, [setId], "indemnify zebra");
    expect(loose.some((h) => h.page === 3)).toBe(true);
    expect(await searchDocSets(alice, [], "indemnify")).toEqual([]);
    expect(await searchDocSets(alice, [setId], "   ")).toEqual([]);
    const passage = await readDocPassage(alice, hits[0].source);
    expect(passage?.context).toBe(PAGE3);
    expect(await readDocPassage(alice, hits[0].source.replace("/p/3#", "/p/1#"))).toBeNull(); // page must match exactly
  });

  it("appends batches of a large PDF in order and treats a resent batch as a no-op", async () => {
    const res = await uploadBrowserPdf(alice, setId, pdf({ name: "big.pdf", sha256: sha("c"), pages: ["Batch one page one.", "Batch one page two."], totalPages: 4 }));
    expect(res).toMatchObject({ status: "created", file: { status: "partial", pages: 4, pagesReceived: 2 } });
    if (res.status !== "created") return;
    const fileId = res.file.id;
    await expectDocsError(appendPages(alice, setId, fileId, { appendPages: ["x"], fromPage: 4 }), 409);
    const done = await appendPages(alice, setId, fileId, { appendPages: ["Batch two page three.", "Batch two page four."], fromPage: 3 });
    expect(done.file).toMatchObject({ status: "ready", pagesReceived: 4, chars: "Batch one page one.Batch one page two.Batch two page three.Batch two page four.".length });
    const again = await appendPages(alice, setId, fileId, { appendPages: ["Batch two page three.", "Batch two page four."], fromPage: 3 });
    expect(again.file.chars).toBe(done.file.chars);
    expect((await getFilePages(alice, setId, fileId)).pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
    await deleteFile(alice, setId, fileId);
    expect((await listFiles(alice, setId, {})).total).toBe(3);
  });

  it("OCRs a scanned page with the vision model and makes it searchable", async () => {
    await expectDocsError(ocrPage(alice, setId, pdfId, { page: 1, image: PNG }), 409); // has a text layer
    await expectDocsError(ocrPage(alice, setId, pdfId, { page: 2, image: "data:image/png;base64,aGVsbG8=" }), 422); // not a PNG
    expect(() => decodePageImage("data:image/gif;base64,R0lGOD")).toThrow(DocsError);
    ai.ocrText = "SCHEDULE A\n\nThe seat of arbitration shall be Mumbai.";
    const res = await ocrPage(alice, setId, pdfId, { page: 2, image: PNG });
    expect(ai.describeImage).toHaveLength(1);
    expect(ai.describeImage[0].opts).toEqual({ fast: true });
    expect(res).toMatchObject({ page: 2, chars: ai.ocrText.length, file: { status: "ready", ocrPages: [], ocrDonePages: [2], method: "browser-pdfjs" } });
    const hits = await searchDocSets(alice, [setId], "arbitration seat Mumbai");
    expect(hits[0]).toMatchObject({ fileId: pdfId, page: 2, ocr: true });
  });

  it("extracts facts and events once per file, checks quotes and dates in code, and skips current files", async () => {
    const first = await runExtraction(alice, setId, {});
    expect(first).toMatchObject({ processed: 3, failed: 0, remaining: 0, errors: [] });
    expect(ai.generateJSON).toHaveLength(3);
    expect(ai.generateJSON.every((c) => c.fast === true)).toBe(true);
    const agreementCall = ai.generateJSON.find((c) => String(c.input).includes("SERVICES AGREEMENT"))!;
    expect(String(agreementCall.input)).toMatch(/\[Page 1\][\s\S]*\[Page 2\][\s\S]*\[Page 3\]/);

    const { facts, extracted, total } = await listFacts(alice, setId, {});
    expect({ extracted, total }).toEqual({ extracted: 3, total: 3 });
    expect(facts).toHaveLength(3);
    const fee = facts.find((f) => f.category === "amount")!;
    expect(fee).toMatchObject({ page: 1, quoteFound: true, fileName: "agreement.pdf" });
    expect(facts.find((f) => f.category === "admission")).toMatchObject({ quoteFound: false, page: 3 });
    expect(facts.find((f) => f.category === "obligation")).toMatchObject({ quoteFound: true, date: "2021-03-03", datePrecision: "day" });
    expect((await listFacts(alice, setId, { category: "amount" })).facts).toHaveLength(1);
    expect((await listFacts(alice, setId, { q: "indemnify client" })).facts).toHaveLength(1);
    expect((await listFacts(alice, setId, { file: txtId })).facts).toHaveLength(0);

    const { events } = await listTimeline(alice, setId, {});
    expect(events.map((e) => [e.date, e.datePrecision])).toEqual([["2021-03", "month"], ["2021-03-03", "day"], ["2022-04-03", "day"]]);
    expect(events.find((e) => e.dateText === "03.04.2022")).toMatchObject({ page: 3, quoteFound: true }); // relocated from the wrong stated page
    expect(events.find((e) => e.dateText === "March 2021")).toMatchObject({ page: null, fileId: txtId, quoteFound: true });
    expect(events.some((e) => e.dateText === "sometime later")).toBe(false);
    expect((await listTimeline(alice, setId, { q: "termination" })).events).toHaveLength(1);

    ai.generateJSON = [];
    expect(await runExtraction(alice, setId, {})).toMatchObject({ processed: 0, remaining: 0 });
    expect(ai.generateJSON).toHaveLength(0);

    // New text on a page invalidates that file's extraction only.
    ai.ocrText = "SCHEDULE A\n\nThe seat of arbitration shall be Delhi.";
    const re = await ocrPage(alice, setId, pdfId, { page: 2, image: PNG });
    expect(re.file.extraction).toBe("pending");
    expect((await listFacts(alice, setId, {})).facts).toHaveLength(0);
    const again = await runExtraction(alice, setId, {});
    expect(again).toMatchObject({ processed: 1, remaining: 0 });
    expect(ai.generateJSON).toHaveLength(1);
  });

  it("records a failing file and stops retrying after the attempt limit", async () => {
    const res = await uploadServerFile(alice, setId, { name: "broken.md", mime: "text/markdown", bytes: bytes("# Broken\n\nThis file makes the model fail.") });
    expect(res.status).toBe("created");
    const orig = ai.generateJSON;
    const agent = await import("@/lib/ai/agent");
    const spy = vi.spyOn(agent, "generateJSON").mockRejectedValue(new Error("model overloaded"));
    try {
      const a = await runExtraction(alice, setId, {});
      expect(a).toMatchObject({ processed: 0, failed: 1, remaining: 1, errors: [{ name: "broken.md", error: "model overloaded" }] });
      const b = await runExtraction(alice, setId, {});
      expect(b).toMatchObject({ failed: 1, remaining: 0 });
    } finally {
      spy.mockRestore();
      ai.generateJSON = orig;
    }
  });

  it("answers with mapped citations, lists unresolved markers, and streams deltas", async () => {
    ai.answer = "The Contractor must indemnify the Client against losses from delay [2]. The seat is Delhi [1][42].";
    const events: AskEvent[] = [];
    const answer = await askDocSet(alice, setId, { question: "Who indemnifies whom?" }, (e) => events.push(e));
    expect(ai.runAgent).toHaveLength(1);
    const call = ai.runAgent[0] as { evidence: { source: string; title: string; citationsEnabled: boolean }[]; tools?: unknown; instructions: string; input: string };
    expect(call.tools).toBeUndefined();
    expect(call.evidence.length).toBe(answer.passagesSearched);
    expect(call.evidence[0].title).toMatch(/^\[1\] /);
    expect(call.evidence.every((b) => b.citationsEnabled && b.source.startsWith(`docs://${setId}/`))).toBe(true);
    expect(call.instructions).toMatch(/Cite every factual sentence/);
    expect(answer.noEvidence).toBe(false);
    expect(answer.unresolved).toEqual([42]);
    expect(answer.citations.map((c) => c.n)).toEqual([1, 2]);
    expect(answer.citations[1].source).toBe(call.evidence[1].source);
    expect(answer.model).toBe("test-model");
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe(ai.answer);
    expect(events.find((e) => e.type === "passages")).toMatchObject({ mode: "whole" });
  });

  it("says the documents do not establish it, without a model call, when nothing is retrieved", async () => {
    const empty = await createSet(alice, { name: "Empty" });
    const answer = await askDocSet(alice, empty.id, { question: "What is the fee?" }, () => {});
    expect(answer).toMatchObject({ answer: NO_EVIDENCE_ANSWER, noEvidence: true, citations: [], passagesSearched: 0 });
    expect(ai.runAgent).toHaveLength(0);
  });

  it("maps markers in code (pure)", () => {
    const hits = [{ source: "docs://s/f/p/1#0", setId: "s", fileId: "f", fileName: "a.pdf", page: 1, idx: 0, text: "alpha", score: 0 }];
    expect(mapMarkers("A [1]. B [2]. C [1 ¶3].", hits)).toEqual({ citations: [{ n: 1, source: "docs://s/f/p/1#0", fileId: "f", fileName: "a.pdf", page: 1, snippet: "alpha" }], unresolved: [2] });
  });

  it("switches from the whole set to ranked search above the whole-set size", async () => {
    const store = await docStore();
    const whole = await retrievePassages(store, [setId], "zebra", { wholeSetMax: 1000 });
    expect(whole.mode).toBe("whole");
    const ranked = await retrievePassages(store, [setId], "zebra", { wholeSetMax: 1 });
    expect(ranked).toMatchObject({ mode: "search", hits: [] });
  });

  it("builds extraction windows with page markers and splits long pages", () => {
    const wins = buildWindows([{ page: 1, text: "a".repeat(20_000) }, { page: 2, text: "b".repeat(100) }], 14_000);
    expect(wins.length).toBe(2);
    expect(wins[0].text.startsWith("[Page 1]\n")).toBe(true);
    expect(wins[1].text).toMatch(/^\[Page 1 continued\]\n/);
    expect(wins[1].pages).toEqual([1, 2]);
  });

  it("renames and deletes sets", async () => {
    const s = await createSet(alice, { name: "Temp" });
    expect((await updateSet(alice, s.id, { name: "Temp 2", description: "" })).name).toBe("Temp 2");
    await expectDocsError(updateSet(alice, s.id, { name: "   " }), 422);
    await deleteSet(alice, s.id);
    await expectDocsError(updateSet(alice, s.id, { name: "x" }), 404);
  });

  describe("authorization", () => {
    let matterSetId = "";

    it("hides a personal set from everyone but its owner", async () => {
      expect((await listDocSets(bob)).some((s) => s.id === setId)).toBe(false);
      expect((await listDocSets(carol)).some((s) => s.id === setId)).toBe(false);
      await expectDocsError(listFiles(bob, setId, {}), 404);
      await expectDocsError(uploadBrowserPdf(bob, setId, pdf({ sha256: sha("d") })), 404);
      expect(await searchDocSets(bob, [setId], "indemnify")).toEqual([]);
      const [hit] = await searchDocSets(alice, [setId], "indemnify");
      expect(await readDocPassage(bob, hit.source)).toBeNull();
      await expectDocsError(askDocSet(bob, setId, { question: "fee?" }, () => {}), 404);
      await expectDocsError(listFacts(bob, setId, {}), 404);
    });

    it("lets a matter set follow matter access, within the tenant", async () => {
      const s = await createSet(alice, { name: "Matter bundle", matterId: MATTER });
      matterSetId = s.id;
      expect(s.matterId).toBe(MATTER);
      await uploadServerFile(alice, matterSetId, { name: "brief.txt", mime: "text/plain", bytes: bytes("The limitation period expired on 3rd March, 2021.") });
      expect((await listDocSets(carol)).some((x) => x.id === matterSetId)).toBe(true);
      expect((await searchDocSets(carol, [matterSetId], "limitation period"))[0]?.fileName).toBe("brief.txt");
      expect((await listDocSets(bob)).some((x) => x.id === matterSetId)).toBe(false);
      expect(await searchDocSets(bob, [matterSetId, setId], "limitation")).toEqual([]);
      expect((await listDocSets(mallory)).some((x) => x.id === matterSetId)).toBe(false);
      await expectDocsError(listFiles(mallory, matterSetId, {}), 404);
      // Paralegals may add files but not delete the set (matter policy).
      await expectDocsError(deleteSet(carol, matterSetId), 403);
      // Mixed request: only the readable set is searched.
      const mixed = await searchDocSets(carol, [matterSetId, setId], "limitation indemnify");
      expect(mixed.every((h) => h.setId === matterSetId)).toBe(true);
    });

    it("requires matter write access to create a set on a matter, and hides unknown matters", async () => {
      await expectDocsError(createSet(bob, { name: "x", matterId: MATTER }), 404);
      await expectDocsError(createSet(alice, { name: "x", matterId: "m_does_not_exist" }), 404);
      await expectDocsError(createSet(person("u_guest", { roles: ["client_guest"] }), { name: "x", matterId: MATTER }), 403);
    });
  });
});

describe("API routes", () => {
  const BASE = "http://localhost";
  const req = (path: string, init: { method?: string; json?: unknown; body?: BodyInit } = {}) =>
    new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", ...(init.json !== undefined ? { body: JSON.stringify(init.json), headers: { "Content-Type": "application/json" } } : init.body ? { body: init.body } : {}) } as ConstructorParameters<typeof NextRequest>[1]);
  const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

  it("creates, uploads, lists, asks and 404s through the real handlers (dev principal)", async () => {
    const status = await statusRoute.GET();
    expect(status.status).toBe(200);
    expect((await status.json()).storage).toMatchObject({ backend: "sqlite", full: false, limitMb: null });

    expect((await setsRoute.POST(req("/api/documents/sets", { method: "POST", json: { name: "" } }))).status).toBe(422);
    const created = await setsRoute.POST(req("/api/documents/sets", { method: "POST", json: { name: "Route set" } }));
    expect(created.status).toBe(201);
    const { set } = await created.json();
    const list = await (await setsRoute.GET()).json();
    expect(list.sets.some((s: { id: string }) => s.id === set.id)).toBe(true);

    const fd = new FormData();
    fd.append("file", new File(["The arbitration clause names Mumbai as the seat."], "clause.txt", { type: "text/plain" }));
    const up = await filesRoute.POST(req(`/api/documents/sets/${set.id}/files`, { method: "POST", body: fd }), params({ id: set.id }));
    expect(await up.json()).toMatchObject({ status: "created", file: { name: "clause.txt" } });
    const pdfRes = await filesRoute.POST(req(`/api/documents/sets/${set.id}/files`, { method: "POST", json: pdf({ sha256: sha("f") }) }), params({ id: set.id }));
    expect(await pdfRes.json()).toMatchObject({ status: "created", file: { method: "browser-pdfjs" } });
    const files = await (await filesRoute.GET(req(`/api/documents/sets/${set.id}/files?limit=1`), params({ id: set.id }))).json();
    expect(files).toMatchObject({ total: 2 });
    expect(files.files).toHaveLength(1);

    ai.answer = "Mumbai is the seat [1].";
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const res = await askRoute.POST(req(`/api/documents/sets/${set.id}/ask`, { method: "POST", json: { question: "Where is the seat of arbitration?" } }), params({ id: set.id }));
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const events: { type: string; answer?: { citations: unknown[] } }[] = [];
      await readSSE(res, (e) => events.push(e as { type: string }));
      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["status", "passages", "delta", "done"]));
      expect(events.at(-1)?.answer?.citations).toHaveLength(1);
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    }

    // Unknown sets are 404 on every route, and the stream never opens.
    expect((await setRoute.GET(req("/api/documents/sets/dset_nope"), params({ id: "dset_nope" }))).status).toBe(404);
    expect((await askRoute.POST(req("/api/documents/sets/dset_nope/ask", { method: "POST", json: { question: "x" } }), params({ id: "dset_nope" }))).status).toBe(404);
    expect((await setRoute.DELETE(req(`/api/documents/sets/${set.id}`, { method: "DELETE" }), params({ id: set.id }))).status).toBe(200);
    expect((await setRoute.GET(req(`/api/documents/sets/${set.id}`), params({ id: set.id }))).status).toBe(404);
  });
});
