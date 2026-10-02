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

vi.mock("@/modules/documents/server/http", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/modules/documents/server/http")>()), aiAvailable: () => true }));

import { PDFDocument, StandardFonts } from "pdf-lib";
import { createHash } from "node:crypto";
import { db, resetSqlite } from "@/lib/db";
import type { Principal } from "@/lib/auth/types";
import {
  amountsInText, annexureLabels, buildDateRows, checkSynopsis, computePaperbookIndex, courtDate, datesInText, datesMarkdown, detectParagraphs, exportBlockers, glossaryHints, newReply, rowVerification,
  ruleCategory, splitDefects, synopsisForExport, synopsisSentences, TRANSLATION_LABEL, writtenStatementMarkdown, type ParaReply,
} from "@/modules/documents/drafting";
import type { DocEvent } from "@/modules/documents/types";
import { setDocStoreForTests } from "@/modules/documents/server/store";
import { DocsError } from "@/modules/documents/server/access";
import { createSet, deleteFile, deleteSet, resetStorageCacheForTests } from "@/modules/documents/server/sets";
import { uploadBrowserPdf, uploadServerFile } from "@/modules/documents/server/ingest";
import { runExtraction } from "@/modules/documents/server/extract";
import { createDefectNotice, draftSynopsis, getDates, getParawise, listDefectNotices, listTranslations, proposeReplies, saveDates, startParawise, translatePages, updateDefect, updateReply } from "@/modules/documents/server/drafting";
import { buildPaperbook, describeUnprintable, pngSize, unprintableChars } from "@/modules/documents/server/paperbook";
import { workStore } from "@/modules/documents/server/work-store";
import { extractPdf } from "@/modules/office/pdf/extract";
import { NextRequest } from "next/server";
import * as paperbookRoute from "@/app/api/documents/sets/[id]/paperbook/route";
import * as datesRoute from "@/app/api/documents/sets/[id]/dates/route";
import * as parawiseRoute from "@/app/api/documents/sets/[id]/parawise/route";
import * as translationsRoute from "@/app/api/documents/sets/[id]/translations/route";
import * as defectsRoute from "@/app/api/documents/sets/[id]/defects/route";

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
    expect(c.unknownAmounts).toEqual(["Rs. 10 lakh"]);
    expect(c.uncited).toBe(1); // "The respondent then paid Rs. 10 lakh …" (not split after "Rs.")
    expect(synopsisForExport("Agreement made. [R2] Unknown. [R9]", rows)).toBe("Agreement made. [03.03.2021] Unknown. [unresolved R9]");
  });
  it("flags an invented sentence that follows a cited one (\". [R1] Next\"), ISO and 'day of' dates, and amounts not in the rows", () => {
    const rows = buildDateRows([...events, ev("devent_dddddddd4", "2021-05-07", "Respondent paid Rs. 5,00,000 to the petitioner")], { overrides: {}, manual: [] });
    // Before the fix the split never happened at ". [R1] The", so the invented middle sentence rode on [R1].
    const invented = "The agreement was executed on 03.03.2021. [R2] The respondent then admitted the whole debt in writing to the bank. The notice was served on 03.04.2022. [R4]";
    expect(synopsisSentences(invented)).toEqual(["The agreement was executed on 03.03.2021 [R2].", "The respondent then admitted the whole debt in writing to the bank.", "The notice was served on 03.04.2022 [R4]."]);
    expect(checkSynopsis(invented, rows).uncited).toBe(1);
    expect(datesInText("on 2021-05-07, on the 12th day of March, 2021 and in March 2021").map((d) => d.iso)).toEqual(["2021-05-07", "2021-03-12", "2021-03"]);
    const c = checkSynopsis("Payment of ₹5,00,000 was made on 2021-05-07. [R3] A further sum of Rs. 2 lakh was paid on 2021-06-01. [R3] The deed was signed on the 12th day of March, 2021. [R2] Talks began in January 2020. [R1]", rows);
    expect(c.unknownDates).toEqual(["2021-06-01", "12th day of March, 2021"]);
    expect(c.unknownAmounts).toEqual(["Rs. 2 lakh"]);
    expect(c.uncited).toBe(0);
    expect(amountsInText("Rs.5,00,000/- and ₹ 1.5 crore and INR 10 lakhs").map((a) => a.value)).toEqual([500000, 15000000, 1000000]);
    // A row that no longer exists makes its marker unresolved rather than binding it to another row.
    expect(checkSynopsis("Agreement executed. [R1]", [null, rows[0]]).unresolved).toEqual([1]);
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
    // The builder passes the measured number of index pages; page ranges start after them.
    const measured = computePaperbookIndex(entries, [3, 10, 1], { prefix: "P", startPage: 1, indexPage: true, indexPages: 3 });
    expect(measured.indexPages).toBe(3);
    expect(measured.rows[0]).toMatchObject({ from: 4, to: 6 });
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
  it("starts after a cause title with numbered parties, and keeps a numbering gap as a gap", () => {
    const text = [
      "IN THE HIGH COURT OF KARNATAKA AT BENGALURU", "WRIT PETITION No. 1234 of 2025", "BETWEEN:",
      "1. Ramesh Kumar, aged 45 years, residing at Bengaluru", "2. Suresh Kumar, aged 40 years, residing at Mysuru", "...PETITIONERS", "AND:",
      "1. State of Karnataka, by its Chief Secretary", "2. The Commissioner, BBMP", "3. The Assistant Engineer, BBMP", "...RESPONDENTS",
      "WRIT PETITION UNDER ARTICLES 226 AND 227 OF THE CONSTITUTION OF INDIA", "MOST RESPECTFULLY SHEWETH:",
      "1. The petitioners own the property bearing No. 12.", "2. The respondents issued a demolition notice dated 01.02.2025.", "3. The notice was issued without hearing the petitioners.",
      "5. The petitioners replied on 10.02.2025.", "6. No order was passed on the reply.", "7. The petitioners have no other remedy.",
      "PRAYER", "1. Quash the notice dated 01.02.2025.", "2. Grant such other relief.",
    ].join("\n");
    const paras = detectParagraphs([{ page: 1, text }]);
    expect(paras.map((p) => p.n)).toEqual(["1", "2", "3", "5", "6", "7"]);
    expect(paras[0].text).toBe("The petitioners own the property bearing No. 12.");
    expect(paras[2].text).toBe("The notice was issued without hearing the petitioners."); // 5–7 are not merged into 3
    expect(paras[3].gapBefore).toBe(1);
    expect(paras.filter((p) => p.gapBefore).length).toBe(1);
    expect(paras[5].text).toBe("The petitioners have no other remedy."); // the prayer is not appended
    // A plaint with only "VERSUS" between numbered party lists.
    const plaint = detectParagraphs([{ page: 1, text: "1. ABC Bank Ltd.\nVERSUS\n1. R. Kumar\n2. S. Kumar\nPLAINT UNDER ORDER VII RULE 1 CPC\n1. The plaintiff is a bank.\n2. The defendants borrowed money.\n3. They did not repay it." }]);
    expect(plaint.map((p) => [p.n, p.text])).toEqual([["1", "The plaintiff is a bank."], ["2", "The defendants borrowed money."], ["3", "They did not repay it."]]);
  });
  it("blocks export while any paragraph is unreviewed, until admissions and non-denials are approved, and while stale", () => {
    let paras: ParaReply[] = detectParagraphs([{ page: 1, text: "1. A is true.\n2. B is true.\n3. C is true." }]).map(newReply);
    // Nothing proposed or edited yet: every paragraph starts "unreviewed" and none can be exported as a reply stance.
    expect(paras.map((p) => p.stance)).toEqual(["unreviewed", "unreviewed", "unreviewed"]);
    expect(exportBlockers(paras)).toEqual({ stale: false, unreviewed: ["1", "2", "3"], unapproved: [] });
    expect(() => writtenStatementMarkdown({ fileName: "plaint.pdf", paras })).toThrow(/paragraphs 1, 2, 3 have no reviewed response/);
    const proposed = (p: ParaReply, stance: ParaReply["stance"]): ParaReply => ({ ...p, stance, status: "proposed", proposed: { stance, reply: "", reasoning: "", evidence: [], droppedRefs: 0 } });
    paras = [proposed(paras[0], "admitted"), { ...paras[1], stance: "no_reply", edited: true }, { ...paras[2], status: "failed", error: "model down" }];
    // A failed proposal nobody edited is still unreviewed; "no reply" needs approval like an admission (O.VIII R.5 CPC).
    expect(exportBlockers(paras)).toEqual({ stale: false, unreviewed: ["3"], unapproved: ["1", "2"] });
    paras[2] = { ...paras[2], stance: "denied", edited: true };
    expect(exportBlockers(paras)?.unapproved).toEqual(["1", "2"]);
    paras = paras.map((p, i) => (i < 2 ? { ...p, approved: true } : p));
    expect(exportBlockers(paras)).toBeNull();
    expect(exportBlockers(paras, { stale: true })).toEqual({ stale: true, unreviewed: [], unapproved: [] });
    expect(() => writtenStatementMarkdown({ fileName: "plaint.pdf", paras }, { stale: true })).toThrow(/text changed/);
    const md = writtenStatementMarkdown({ fileName: "plaint.pdf", paras });
    expect(md).toContain("1. The contents of paragraph 1 of the plaint are admitted.");
    expect(md).toContain("2. Paragraph 2 of the plaint calls for no reply.");
    expect(md).toContain("3. The contents of paragraph 3 of the plaint are denied.");
    expect(md).toContain("responses to paragraph 1 are as proposed by AI and were not edited");
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

  it("compare-and-set is atomic: two saves from the same version cannot both land", async () => {
    const v = await getDates(alice, setId);
    const results = await Promise.allSettled([saveDates(alice, setId, { version: v.state.version, format: "sc" }), saveDates(alice, setId, { version: v.state.version, format: "hc" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409 });
    expect((await getDates(alice, setId)).state.version).toBe(v.state.version + 1);
    // The store itself refuses a write from a stale version, and a create over an existing row.
    const ws = await workStore();
    const item = (await ws.get<{ version: number }>(setId, "dates", "list"))!;
    expect(item.version).toBe(v.state.version + 1);
    expect(await ws.putIfVersion({ ...item, data: { ...item.data, version: item.version! + 1 } }, item.version! - 1)).toBe(false);
    expect(await ws.putIfVersion({ ...item, key: "other", data: { version: 1 } }, 0)).toBe(true);
    expect(await ws.putIfVersion({ ...item, key: "other", data: { version: 1 } }, 0)).toBe(false);
    await ws.delete(setId, "dates", "other");
  });

  it("drafts a synopsis from the selected rows only and records what does not check out", async () => {
    const v = await getDates(alice, setId);
    ai.synopsis = "The defendant executed a loan agreement on 12.01.2020. [R1] He defaulted thereafter. [R2] A decree was passed on 09.09.2024. [R5]";
    const out = await draftSynopsis(alice, setId, { rowIds: v.rows.slice(0, 2).map((r) => r.id), version: v.state.version });
    expect(ai.text[0].input).toContain("[R1] 12.01.2020");
    expect(String(ai.text[0].input)).not.toContain("Legal notice issued");
    expect(out.state.synopsis).toMatchObject({ unresolved: [5], unknownDates: ["09.09.2024"], unknownAmounts: [], uncited: 0, edited: false, rowIds: v.rows.slice(0, 2).map((r) => r.id) });
    ai.synopsis = "The defendant executed a loan agreement on 12.01.2020. [R1] The defendant also paid Rs. 50,000 in cash on that day. He defaulted thereafter. [R2]";
    const again = await draftSynopsis(alice, setId, { rowIds: v.rows.slice(0, 2).map((r) => r.id), version: out.state.version });
    expect(again.state.synopsis).toMatchObject({ uncited: 1, unknownAmounts: ["Rs. 50,000"] });
    const edited = await saveDates(alice, setId, { version: again.state.version, synopsisText: "Edited synopsis. [R1]" });
    expect(edited.state.synopsis).toMatchObject({ text: "Edited synopsis. [R1]", edited: true });
    await expectStatus(draftSynopsis(alice, setId, { rowIds: [] }), 422);
  });

  it("detects the plaint's paragraphs, proposes replies with code-checked quotes, and requires approval of admissions", async () => {
    await expectStatus(startParawise(alice, setId, loanId), 422); // no numbered paragraphs
    const started = await startParawise(alice, setId, plaintId);
    expect(started.state?.paras.map((p) => p.n)).toEqual(["1", "2", "3"]);
    expect(started.state?.paras.map((p) => p.stance)).toEqual(["unreviewed", "unreviewed", "unreviewed"]);
    expect(() => writtenStatementMarkdown(started.state!)).toThrow(/no reviewed response/);
    await expectStatus(updateReply(alice, setId, plaintId, { version: started.state!.version, n: "1", approve: true }), 422); // nothing to approve yet
    const r = await proposeReplies(alice, setId, plaintId, { version: started.state!.version });
    const [p1, p2, p3] = r.state!.paras;
    expect(p1.stance).toBe("no_reply");
    expect(p2.proposed?.stance).toBe("admitted");
    expect(p2.proposed?.evidence).toEqual([expect.objectContaining({ fileId: loanId, quoteFound: true })]);
    expect(p2.proposed?.droppedRefs).toBe(1); // passage 99 was never supplied: dropped, not re-bound
    expect(p3.proposed?.evidence[0].quoteFound).toBe(false);
    expect(p2.approved).toBe(false);
    // Passages offered come only from the other files of the set (never the plaint itself).
    expect(String(ai.json.at(-1)?.input)).not.toMatch(/plaint\.txt, page|\] plaint\.txt/);
    expect(() => writtenStatementMarkdown(r.state!)).toThrow(/paragraphs 1, 2 need approval/);
    const approved = await updateReply(alice, setId, plaintId, { version: r.state!.version, n: "2", approve: true });
    expect(approved.state!.paras[1]).toMatchObject({ approved: true, approvedBy: "u_alice" });
    // "No reply needed" does not traverse the allegation: it needs approval too before anything exports.
    expect(() => writtenStatementMarkdown(approved.state!)).toThrow(/paragraph 1 needs approval/);
    const both = await updateReply(alice, setId, plaintId, { version: approved.state!.version, n: "1", approve: true });
    expect(writtenStatementMarkdown(both.state!)).toContain("paragraph 2 of the plaint are admitted");
    const edited = await updateReply(alice, setId, plaintId, { version: both.state!.version, n: "2", reply: "Admitted, save that the amount is disputed." });
    expect(edited.state!.paras[1]).toMatchObject({ approved: false, edited: true });
    await expectStatus(updateReply(alice, setId, plaintId, { version: approved.state!.version, n: "2", approve: true }), 409);
    expect((await getParawise(alice, setId, plaintId)).stale).toBe(false);
  });

  it("refuses approvals while the pleading's text differs from the detected paragraphs", async () => {
    const ws = await workStore();
    const item = (await ws.get<import("@/modules/documents/drafting").ParawiseState>(setId, "parawise", plaintId))!;
    // Simulate a pleading whose stored text changed after detection (the stored hash no longer matches).
    const staleState = { ...item.data, textHash: "0".repeat(64), version: item.data.version + 1 };
    await ws.put({ ...item, data: staleState, textHash: staleState.textHash });
    const view = await getParawise(alice, setId, plaintId);
    expect(view.stale).toBe(true);
    await expect(updateReply(alice, setId, plaintId, { version: staleState.version, n: "2", approve: true })).rejects.toMatchObject({ status: 409, code: "stale" });
    expect(() => writtenStatementMarkdown(view.state!, { stale: view.stale })).toThrow(/text changed/);
    await startParawise(alice, setId, plaintId, { restart: true });
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
    // Default title: today's date in India (court calendar), not the UTC date.
    expect(ruled.title).toMatch(/^Defect notice \d{2}\.\d{2}\.\d{4}$/);
    const ist = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date()).replace(/\//g, ".");
    expect(ruled.title).toBe(`Defect notice ${ist}`);
    // The model answered, but for no defect of this notice ("1", "2" vs "a", "b"): not "classified by AI".
    const unmatched = await createDefectNotice(alice, setId, { forum: "hc", text: "(a) Deficit court fee.\n(b) Index not paginated." });
    expect(unmatched.aiClassified).toBe(false);
    expect(unmatched.defects.every((d) => d.classifiedBy === "rule")).toBe(true);
    await (await workStore()).delete(setId, "defects", unmatched.id);
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

describe("a file id from another set", () => {
  let setA = "";
  let setB = "";
  let fileB = "";
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = (url: string, method: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  beforeAll(async () => {
    setA = (await createSet(alice, { name: "Set A", matterId: MATTER })).id;
    setB = (await createSet(alice, { name: "Set B", matterId: MATTER })).id;
    await uploadServerFile(alice, setA, { name: "own.txt", mime: "text/plain", bytes: bytes(PLAINT) });
    const b = await uploadServerFile(alice, setB, { name: "other-plaint.txt", mime: "text/plain", bytes: bytes(PLAINT) });
    if (b.status !== "created") throw new Error("upload failed");
    fileB = b.file.id;
  });

  it("is refused by the services (never read through set A)", async () => {
    await expectStatus(startParawise(alice, setA, fileB), 404);
    await expectStatus(getParawise(alice, setA, fileB), 404);
    await expectStatus(translatePages(alice, setA, { fileId: fileB, from: "en", to: "hi" }), 404);
    await expectStatus(listTranslations(alice, setA, fileB), 404);
    await expectStatus(createDefectNotice(alice, setA, { forum: "sc", fileId: fileB }), 404);
    expect(ai.text).toHaveLength(0); // nothing reached the model
  });

  it("is refused by the para-wise, translation and defect routes", async () => {
    const url = (path: string) => `/api/documents/sets/${setA}${path}`;
    expect((await parawiseRoute.POST(json(url("/parawise"), "POST", { fileId: fileB, action: "start" }), params(setA))).status).toBe(404);
    expect((await parawiseRoute.POST(json(url("/parawise"), "POST", { fileId: fileB, action: "propose", version: 1 }), params(setA))).status).toBe(404);
    expect((await parawiseRoute.GET(new NextRequest(`http://localhost${url(`/parawise?file=${fileB}`)}`), params(setA))).status).toBe(404);
    expect((await parawiseRoute.PATCH(json(url("/parawise"), "PATCH", { fileId: fileB, version: 1, n: "1", approve: true }), params(setA))).status).toBe(404);
    expect((await translationsRoute.POST(json(url("/translations"), "POST", { fileId: fileB, from: "en", to: "hi" }), params(setA))).status).toBe(404);
    expect((await translationsRoute.GET(new NextRequest(`http://localhost${url(`/translations?file=${fileB}&to=hi`)}`), params(setA))).status).toBe(404);
    expect((await defectsRoute.POST(json(url("/defects"), "POST", { forum: "sc", fileId: fileB }), params(setA))).status).toBe(404);
    expect(ai.text).toHaveLength(0);
    expect(ai.json).toHaveLength(0);
    // The same file id is fine in its own set.
    expect((await parawiseRoute.POST(json(`/api/documents/sets/${setB}/parawise`, "POST", { fileId: fileB, action: "start" }), params(setB))).status).toBe(200);
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
    await expect(buildPaperbook(alice, setId, { title: "x", entries: [{ fileId: hindiId, title: "FIR", annexure: true }] })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Indian-language script such as “.”.*attach the original PDF/) });
    expect(describeUnprintable("price ✍ here")).toBe("characters such as “✍” (U+270D)");
    // An index title the fonts cannot print is refused too (never printed as "?").
    await expect(buildPaperbook(alice, setId, { title: "x", entries: [{ fileId: textId, title: "आदेश", annexure: false }] }, [], { preview: true })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Entry 1's title contains Indian-language script/) });
    await expectStatus(buildPaperbook(alice, setId, { title: "x", entries: [] }), 422);
    await expectStatus(buildPaperbook(bob, setId, { title: "x", entries: [{ fileId: textId, title: "t", annexure: false }] }), 404);
  });

  it("prints the rupee sign as Rs. (and says so on the page) instead of refusing the pleading", async () => {
    const r = await uploadServerFile(alice, setId, { name: "plaint-amount.txt", mime: "text/plain", bytes: bytes("The plaintiff claims ₹5,00,000 with interest.") });
    if (r.status !== "created") throw new Error("upload failed");
    expect(unprintableChars("₹5,00,000")).toBe(0);
    const built = await buildPaperbook(alice, setId, { title: "Rupee", indexPage: false, entries: [{ fileId: r.file.id, title: "Plaint", annexure: false }] });
    const ex = await extractPdf(built.pdf);
    expect(ex.pages[0].text).toMatch(/Rs\.5,00,000/);
    expect(ex.pages[0].text).toMatch(/The rupee sign is printed as Rs\./);
  });

  it("lays the index out by measured height: long titles wrap in full and the page ranges count every index page", async () => {
    const r = await uploadServerFile(alice, setId, { name: "short.txt", mime: "text/plain", bytes: bytes("A short document.") });
    if (r.status !== "created") throw new Error("upload failed");
    const long = (i: number) => `Copy of the reply dated ${i}.01.2024 sent by the respondent to the legal notice issued by the petitioner together with its enclosures and the postal receipts thereof, marked as document ${i} END${i}`;
    const entries = Array.from({ length: 40 }, (_, i) => ({ fileId: r.file.id, title: long(i + 1), annexure: true }));
    const spec = { title: "Long index", court: "IN THE HIGH COURT OF DELHI AT NEW DELHI", indexPage: true, entries };
    const preview = await buildPaperbook(alice, setId, spec, [], { preview: true });
    const indexPages = preview.index[0].from - 1;
    expect(indexPages).toBeGreaterThan(2); // the old fixed 24 rows per page said 2: rows ran off the page
    expect(preview.index.at(-1)).toMatchObject({ from: indexPages + 40, to: indexPages + 40 });
    expect(preview.totalPages).toBe(indexPages + 40);
    const built = await buildPaperbook(alice, setId, spec);
    const pdf = await PDFDocument.load(built.pdf);
    expect(pdf.getPageCount()).toBe(indexPages + 40);
    const ex = await extractPdf(built.pdf);
    const indexText = ex.pages.slice(0, indexPages).map((p) => p.text).join(" ");
    for (let i = 1; i <= 40; i++) expect(indexText).toContain(`END${i}`); // every title printed to its last word
    expect(indexText).not.toContain("...");
    expect(ex.pages[indexPages].text).toMatch(/ANNEXURE P-1/);
  });

  it("bounds memory: PNG dimensions are checked before decoding, an attachment is parsed once and reused at most 3 times", async () => {
    // A tiny PNG whose IHDR claims 10000 × 10000 pixels (100 MP): refused from the header, never decoded.
    const bomb = new Uint8Array(33);
    bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(bomb.buffer).setUint32(16, 10_000);
    new DataView(bomb.buffer).setUint32(20, 10_000);
    bomb.set([8, 2, 0, 0, 0], 24);
    expect(pngSize(bomb)).toEqual({ width: 10_000, height: 10_000 });
    await expect(buildPaperbook(alice, setId, { title: "x", entries: [{ uploadKey: "bomb", title: "Photo", annexure: true }] }, [{ key: "bomb", name: "bomb.png", mime: "image/png", bytes: bomb }], { preview: true }))
      .rejects.toMatchObject({ status: 422, message: expect.stringMatching(/10,000 × 10,000 pixels; images over 40 megapixels are not embedded/) });
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const reuse = (n: number) => ({ title: "x", indexPage: false, entries: Array.from({ length: n }, () => ({ uploadKey: "p", title: "Photo", annexure: true })) });
    const ok = await buildPaperbook(alice, setId, reuse(3), [{ key: "p", name: "p.png", mime: "image/png", bytes: png }]);
    expect((await PDFDocument.load(ok.pdf)).getPageCount()).toBe(3);
    await expect(buildPaperbook(alice, setId, reuse(4), [{ key: "p", name: "p.png", mime: "image/png", bytes: png }], { preview: true })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/used by more than 3 entries/) });
  });

  it("says whether an attached original matched a server-computed or a browser-declared hash", async () => {
    const spec = { title: "Sources", entries: [{ fileId: textId, title: "Order", annexure: false }, { fileId: pdfId, uploadKey: "o", title: "Agreement", annexure: true }, { uploadKey: "x", title: "Extra", annexure: true }] };
    const extra = await PDFDocument.create(); extra.addPage();
    const preview = await buildPaperbook(alice, setId, spec, [{ key: "o", name: "agreement.pdf", mime: "application/pdf", bytes: original }, { key: "x", name: "extra.pdf", mime: "application/pdf", bytes: await extra.save() }], { preview: true });
    // agreement.pdf was uploaded as browser-extracted page text: its SHA-256 was declared by the browser, not computed here.
    expect(preview.index.map((r) => r.source)).toEqual([{ kind: "typed" }, { kind: "original", hash: "browser_declared" }, { kind: "attachment" }]);
  });

  it("refuses a body over the limit even without a Content-Length header", async () => {
    const chunk = new Uint8Array(512 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent >= 12) { c.close(); return; } sent++; c.enqueue(chunk); } });
    const req = new NextRequest(`http://localhost/api/documents/sets/${setId}/paperbook`, { method: "POST", body: stream, headers: { "content-type": "application/json" }, duplex: "half" } as unknown as ConstructorParameters<typeof NextRequest>[1]);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await paperbookRoute.POST(req, { params: Promise.resolve({ id: setId }) });
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(12); // stopped reading once over the limit
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
