import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/documents-discovery-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

/** The model is scripted per window (by the page markers in the excerpt); every call is recorded. */
const ai = vi.hoisted(() => ({ calls: [] as Array<{ name?: string; input: string; instructions: string; schema: unknown }>, answer: "", agentFailures: 0, failReview: "" }));

vi.mock("@/lib/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/agent")>();
  return {
    ...actual,
    runAgent: async (opts: { onEvent: (e: unknown) => void }) => {
      if (ai.agentFailures > 0) { ai.agentFailures--; throw new Error("model overloaded"); }
      opts.onEvent({ type: "start", model: "test-model" });
      opts.onEvent({ type: "text.delta", delta: ai.answer });
      return { text: ai.answer, responseId: null, steps: 1, toolCalls: [], usage: { input: 0, output: 0, total: 0 } };
    },
    generateJSON: async (opts: { name?: string; input: string; instructions: string; schema: unknown }) => {
      ai.calls.push(opts);
      const input = String(opts.input);
      const none = { flag: "none", basis: "", quote: "", page: null };
      if (ai.failReview && input.includes(ai.failReview)) throw new Error("provider error");
      // Hardening fixtures (custom review: seat text, claim/fee amount, signed date, counterparty party, clause yes_no).
      if (input.includes("CONFLICT DEED")) {
        return {
          docType: "Agreement", summary: "Deed fixing the seat at Mumbai. It also records the claim.", importance: 4,
          issues: [{ issueId: "payment", relevance: "high", reason: "Claim stated.", quote: "claim", page: 1 }],
          privilege: { flag: "possible", basis: "Mentions advice.", quote: "advice", page: 1 },
          cells: [
            { column: "seat", value: "Mumbai", quote: "The seat of arbitration shall be Mumbai", page: 1 },
            { column: "claim", value: "Rs. 50,00,000", quote: "The total claim is Rs. 50,00,000", page: 1 },
            { column: "fee", value: "Rs. 2,00,000", quote: "The total claim is Rs. 50,00,000", page: 1 }, // found, but the amount is not in it
            { column: "signed", value: "03.04.2022", quote: "signed on 3rd April 2022", page: 1 },
            { column: "counterparty", value: "Zenith Corp", quote: "made between Acme Traders and Bharat Logistics", page: 1 },
            { column: "clause", value: "Yes", quote: "arbitration", page: 1 }, // one word: proves nothing
          ],
        };
      }
      if (input.includes("ADDENDUM")) {
        return {
          docType: "Agreement", summary: "Addendum moving the seat to Delhi. Payment terms unchanged.", importance: 3, issues: [], privilege: none,
          cells: [
            { column: "seat", value: "Delhi", quote: "The seat of arbitration shall be Delhi", page: 3 },
            { column: "claim", value: "₹50 lakh", quote: "Amount payable is ₹50 lakh in full", page: 3 }, // same amount: no conflict
            { column: "counterparty", value: "Bharat Logistics LLP", quote: "made between Acme Traders and Bharat Logistics LLP", page: 3 },
          ],
        };
      }
      if (input.includes("SCANNED BUNDLE")) {
        return {
          docType: "Agreement", summary: "Partly scanned bundle naming Pune as the seat.", importance: 2, issues: [], privilege: none,
          cells: [{ column: "seat", value: "Pune", quote: "The seat of arbitration shall be Pune", page: 1 }, { column: "claim", value: null, quote: "", page: null }],
        };
      }
      if (input.includes("[Page 1]") && input.includes("SUPPLY AGREEMENT")) {
        return {
          docType: "agreement / contract",
          summary: "Supply agreement between Acme and Bharat with a Mumbai-seated arbitration clause.",
          importance: 7,
          issues: [
            { issueId: "arbitration_agreement", relevance: "high", reason: "Contains the arbitration clause.", quote: "seat of arbitration shall be Mumbai", page: 1 },
            { issueId: "breach", relevance: "low", reason: "Sets delivery obligations.", quote: "", page: null },
          ],
          privilege: none,
          cells: [
            { column: "seat", value: "Mumbai", quote: "The seat of arbitration shall be Mumbai", page: 1 },
            // The quote is real text, but on page 3 (another window): it must stay unverified on page 1, never re-bound.
            { column: "claim_amount", value: "Rs. 10,00,000", quote: "Rs. 10,00,000 remains unpaid", page: 1 },
            { column: "arbitration_clause", value: "yes", quote: "Any dispute shall be referred to arbitration", page: 1 },
            { column: "institution_rules", value: "mcia", quote: "", page: null },
            { column: "governing_law", value: null, quote: "", page: null },
          ],
        };
      }
      if (input.includes("[Page 3]")) {
        return {
          docType: "Termination notice",
          summary: "",
          importance: 3,
          issues: [
            { issueId: "breach", relevance: "high", reason: "Records non-payment.", quote: "Rs. 10,00,000 remains unpaid", page: 3 },
            { issueId: "termination", relevance: "medium", reason: "Termination notice.", quote: "terminated with effect from 03.04.2022", page: 3 },
          ],
          privilege: { flag: "possible", basis: "Copy marked for the company's advocate seeking advice on termination.", quote: "for legal advice", page: 3 },
          cells: [
            { column: "seat", value: "Delhi", quote: "seat at Delhi", page: 3 },
            { column: "termination_date", value: "03.04.2022", quote: "terminated with effect from 03.04.2022", page: 3 },
            { column: "custom_note", value: "Payment default", quote: "remains unpaid", page: 3 },
          ],
        };
      }
      if (input.includes("cc: Adv. Mehta")) {
        return {
          docType: "Lunch menu",
          summary: "Business email on delivery dates; an advocate is copied.",
          importance: 2,
          issues: [],
          privilege: { flag: "likely", basis: "", quote: "", page: null }, // a flag without basis is dropped
          cells: [{ column: "contract_parties", value: "Acme; Bharat", quote: "Acme and Bharat", page: null }],
        };
      }
      return { docType: "Other", summary: "", importance: 1, issues: [], privilege: none, cells: [] };
    },
  };
});

import { db, resetSqlite } from "@/lib/db";
import type { Principal } from "@/lib/auth/types";
import { NextRequest } from "next/server";
import { readSSE } from "@/lib/ai/sse";
import { isColumnId, REVIEW_LIMITS, type ReportEvent } from "@/modules/documents/review-types";
import { DocsError } from "@/modules/documents/server/access";
import { docStore, setDocStoreForTests } from "@/modules/documents/server/store";
import { createSet, deleteFile, deleteSet, resetStorageCacheForTests } from "@/modules/documents/server/sets";
import { uploadBrowserPdf, uploadServerFile } from "@/modules/documents/server/ingest";
import { PLAYBOOKS, getPlaybook } from "@/modules/documents/server/playbooks";
import { codeRow, createReview, deleteReview, getReview, listReviews, listRows, parseRowQuery, reviewRowsForChat, updateReview } from "@/modules/documents/server/review";
import { amountNumbers, blankRecord, limitPages, mergeSummaries, runReview, substantiveQuote, valueInQuote } from "@/modules/documents/server/review-run";
import { exportReview, toCsv, toXlsx } from "@/modules/documents/server/review-export";
import { migrateReviewRows } from "@/modules/documents/server/store-sqlite";
import { DatabaseSync } from "node:sqlite";
import * as XLSX from "xlsx";
import * as reviewsRoute from "@/app/api/documents/sets/[id]/reviews/route";
import * as reportRoute from "@/app/api/documents/sets/[id]/reviews/[rid]/report/route";
import * as exportRoute from "@/app/api/documents/sets/[id]/reviews/[rid]/export/route";
import * as rowsRoute from "@/app/api/documents/sets/[id]/reviews/[rid]/rows/route";
import * as playbooksRoute from "@/app/api/documents/playbooks/route";

const MATTER = "m_review_test";
const person = (id: string, over: Partial<Principal> = {}): Principal => ({ id, name: id, tenantId: "default", roles: ["associate"], matterIds: [MATTER], source: "dev", ...over });
const alice = person("u_alice", { name: "Alice Rao" });
const guest = person("u_guest", { roles: ["client_guest"] });
const bob = person("u_bob", { matterIds: [] });
const mallory = person("u_mallory", { tenantId: "other", roles: ["partner"], matterIds: "*" });

const PAGE1 = "SUPPLY AGREEMENT\n\nThis Agreement is made between Acme Traders Pvt. Ltd. and Bharat Logistics LLP. Any dispute shall be referred to arbitration. The seat of arbitration shall be Mumbai.";
const PAGE2 = "Schedule of deliveries. ".repeat(1100); // ~25,000 characters: pushes page 3 into a second window
const PAGE3 = "NOTICE. The agreement stands terminated with effect from 03.04.2022 because Rs. 10,00,000 remains unpaid. Copy for legal advice.";
const EMAIL = "From: cfo@acme.example\nTo: ops@bharat.example\ncc: Adv. Mehta\nSubject: delivery dates\n\nAcme and Bharat agree the revised dates.";

async function expectStatus(p: Promise<unknown>, status: number) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(DocsError);
  expect((e as DocsError).status).toBe(status);
}

let setId = "";
let reviewId = "";
let fileA = "";
let fileB = "";

beforeAll(async () => {
  resetSqlite();
  db();
  db().matters.put({ id: MATTER, name: "Acme v Bharat", tenantId: "default" } as never);
  setDocStoreForTests("sqlite");
  resetStorageCacheForTests();
  const set = await createSet(alice, { name: "Discovery bundle", matterId: MATTER });
  setId = set.id;
  const a = await uploadBrowserPdf(alice, setId, { kind: "pdf-text", name: "agreement.pdf", size: 1000, sha256: "a".repeat(64), pages: [PAGE1, PAGE2, PAGE3] });
  if (a.status !== "created") throw new Error("upload failed");
  fileA = a.file.id;
  const b = await uploadServerFile(alice, setId, { name: "email.txt", mime: "text/plain", bytes: new TextEncoder().encode(EMAIL) });
  if (b.status !== "created") throw new Error("upload failed");
  fileB = b.file.id;
});

beforeEach(() => { ai.calls = []; });

describe("playbook catalogue", () => {
  it("has one general playbook and one per practice area, all within the limits", () => {
    expect(PLAYBOOKS).toHaveLength(13);
    expect(new Set(PLAYBOOKS.map((p) => p.id)).size).toBe(13);
    expect(new Set(PLAYBOOKS.map((p) => p.area)).size).toBe(13);
    expect(getPlaybook("general")?.area).toBe("general");
    expect(getPlaybook("nope")).toBeNull();
    for (const p of PLAYBOOKS) {
      expect(p.columns.length, p.id).toBeGreaterThanOrEqual(8);
      expect(p.columns.length, p.id).toBeLessThanOrEqual(Math.min(18, REVIEW_LIMITS.maxColumns));
      expect(p.issues.length, p.id).toBeGreaterThanOrEqual(4);
      expect(p.issues.length, p.id).toBeLessThanOrEqual(8);
      expect(p.questions.length, p.id).toBeGreaterThanOrEqual(5);
      expect(p.questions.length, p.id).toBeLessThanOrEqual(Math.min(10, REVIEW_LIMITS.maxQuestions));
      expect(p.docTypes.length, p.id).toBeLessThanOrEqual(REVIEW_LIMITS.maxDocTypes);
      expect(p.docTypes.map((d) => d.toLowerCase())).not.toContain("other");
      expect(p.statutes.length, p.id).toBeGreaterThan(2);
      expect(p.statutes.every((s) => /\d{4}/.test(s) || /^(State |Constitution of India)/.test(s)), p.id).toBe(true);
      expect(p.columns.every((c) => isColumnId(c.id)), p.id).toBe(true);
      expect(p.issues.every((c) => isColumnId(c.id)), p.id).toBe(true);
      expect(new Set(p.columns.map((c) => c.id)).size, p.id).toBe(p.columns.length);
      expect(new Set(p.issues.map((c) => c.id)).size, p.id).toBe(p.issues.length);
      for (const c of p.columns) if (c.kind === "choice") expect(c.choices?.length, `${p.id}.${c.id}`).toBeGreaterThan(1);
    }
  });

  it("serves the catalogue over the API", async () => {
    const res = await playbooksRoute.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).playbooks).toHaveLength(13);
  });

  it("caps review pages at maxCharsPerFile and reports coverage", () => {
    const big = limitPages([{ page: 1, text: "x".repeat(200_000) }, { page: 2, text: "y".repeat(100_000) }]);
    expect(big.read).toBe(REVIEW_LIMITS.maxCharsPerFile);
    expect(big.total).toBe(300_000);
    expect(big.pages[1].text.length).toBe(40_000);
  });
});

describe("document review", () => {
  it("creates a review from a playbook with overrides and additions", async () => {
    await expectStatus(createReview(alice, setId, { playbookId: "nope" }), 422);
    await expectStatus(createReview(alice, setId, { columns: [{ id: "Bad Id", label: "x", prompt: "x", kind: "text" }] }), 422);
    await expectStatus(createReview(alice, setId, {}), 422); // no playbook, no columns or issues
    const review = await createReview(alice, setId, {
      playbookId: "commercial-arbitration",
      columns: [
        { id: "seat", label: "Seat", prompt: "Seat of arbitration as stated in the clause (not the venue).", kind: "text" },
        { id: "custom_note", label: "Note", prompt: "Anything about payment default.", kind: "text" },
      ],
    });
    reviewId = review.id;
    const pb = getPlaybook("commercial-arbitration")!;
    expect(review).toMatchObject({ setId, playbookId: pb.id, area: "commercial-arbitration", name: pb.name, version: 1, createdBy: "u_alice" });
    expect(review.columns).toHaveLength(pb.columns.length + 1);
    expect(review.columns.find((c) => c.id === "seat")?.prompt).toMatch(/not the venue/);
    expect(review.columns.at(-1)?.id).toBe("custom_note");
    expect(review.counts).toMatchObject({ files: 2, done: 0, pending: 2, coded: 0 });
    expect((await listReviews(alice, setId)).map((r) => r.id)).toContain(reviewId);
  });

  it("enforces set authorization (404 outside, 403 for a read-only member)", async () => {
    await expectStatus(getReview(bob, setId, reviewId), 404);
    await expectStatus(getReview(mallory, setId, reviewId), 404);
    await expectStatus(listRows(mallory, setId, reviewId, {}), 404);
    await expectStatus(getReview(alice, setId, "drev_unknown"), 404);
    // A review id from another set is not found through this set.
    const other = await createSet(alice, { name: "Other" });
    await expectStatus(getReview(alice, other.id, reviewId), 404);
    expect((await getReview(guest, setId, reviewId)).id).toBe(reviewId);
    await expectStatus(createReview(guest, setId, { playbookId: "general" }), 403);
    await expectStatus(runReview(guest, setId, reviewId), 403);
    await expectStatus(codeRow(guest, setId, reviewId, fileA, { coding: "key", rowHash: "" }), 403);
    expect(await reviewRowsForChat(bob, [setId], {})).toMatchObject({ review: null, rows: [] });
  });

  it("runs per window, merges, checks quotes without re-binding, and clamps doc type / importance", async () => {
    const progress = await runReview(alice, setId, reviewId);
    expect(progress).toMatchObject({ processed: 2, failed: 0, remaining: 0 });
    // agreement.pdf has two windows, email.txt one: one structured call each.
    expect(ai.calls).toHaveLength(3);
    expect(ai.calls.every((c) => c.name === "document_review")).toBe(true);
    expect(ai.calls[0].instructions).toMatch(/merely copied/);
    expect(ai.calls[0].instructions).toMatch(/Arbitration and Conciliation Act, 1996/);

    const { rows, total } = await listRows(alice, setId, reviewId, { sort: "name" });
    expect(total).toBe(2);
    const a = rows.find((r) => r.fileId === fileA)!;
    expect(a).toMatchObject({ status: "done", docType: "Agreement / contract", importance: 5, pages: 3 });
    expect(a.summary).toMatch(/Supply agreement/);
    // cells: the first found value wins over a later window's unverified value.
    expect(a.cells.seat).toMatchObject({ value: "Mumbai", status: "found", page: 1, quoteFound: true });
    // the quote exists only on page 3 (other window): stays unverified with the model's page, never re-bound.
    expect(a.cells.claim_amount).toMatchObject({ value: "Rs. 10,00,000", status: "unverified", page: 1, quoteFound: false });
    expect(a.cells.arbitration_clause).toMatchObject({ value: "Yes", status: "found" });
    expect(a.cells.institution_rules).toMatchObject({ value: "MCIA", status: "unverified", quote: "", quoteFound: false });
    expect(a.cells.governing_law).toMatchObject({ value: null, status: "not_stated" });
    expect(a.cells.termination_date).toMatchObject({ value: "03.04.2022", status: "found", page: 3 });
    expect(a.cells.custom_note).toMatchObject({ value: "Payment default", status: "found", page: 3 });
    // issues: highest relevance across windows.
    expect(a.issues.find((i) => i.issueId === "breach")).toMatchObject({ relevance: "high", page: 3, quoteFound: true });
    expect(a.issues.find((i) => i.issueId === "arbitration_agreement")).toMatchObject({ relevance: "high", page: 1, quoteFound: true });
    expect(a.issues.find((i) => i.issueId === "bank_guarantee")).toMatchObject({ relevance: "none" });
    expect(a.privilege).toMatchObject({ flag: "possible", page: 3, quoteFound: true });
    expect(a.coverage.read).toBe(a.coverage.total);
    expect(a.rowHash).toMatch(/^[0-9a-f]{64}$/);

    const b = rows.find((r) => r.fileId === fileB)!;
    expect(b).toMatchObject({ status: "done", docType: "Other", importance: 2 });
    expect(b.privilege).toMatchObject({ flag: "none" }); // "likely" without a basis is not kept
    expect(b.cells.contract_parties).toMatchObject({ status: "found", page: null });

    // A second run has nothing to do.
    expect(await runReview(alice, setId, reviewId)).toMatchObject({ processed: 0, remaining: 0 });
    expect(ai.calls).toHaveLength(3);
    expect((await getReview(alice, setId, reviewId)).counts).toMatchObject({ files: 2, done: 2, pending: 0, failed: 0, privilegeFlags: 1 });
  });

  it("filters rows and computes facets", async () => {
    const all = await listRows(alice, setId, reviewId, {});
    expect(all.facets.docTypes).toEqual(expect.arrayContaining([{ value: "Agreement / contract", count: 1 }, { value: "Other", count: 1 }]));
    expect(all.facets.issues.find((i) => i.issueId === "breach")).toMatchObject({ high: 1, medium: 0, low: 0 });
    expect(all.facets.privilege).toEqual({ possible: 1, likely: 0 });
    expect(all.facets.coding).toMatchObject({ uncoded: 2 });
    expect(all.rows[0].fileId).toBe(fileA); // importance sort

    const q = (o: Record<string, unknown>) => listRows(alice, setId, reviewId, parseRowQuery(o));
    expect((await q({ issue: "breach" })).rows.map((r) => r.fileId)).toEqual([fileA]);
    expect((await q({ issue: "termination", minRelevance: "high" })).total).toBe(0);
    expect((await q({ docType: "other" })).rows.map((r) => r.fileId)).toEqual([fileB]);
    expect((await q({ privilege: "possible" })).rows.map((r) => r.fileId)).toEqual([fileA]);
    expect((await q({ q: "mumbai" })).rows.map((r) => r.fileId)).toEqual([fileA]);
    expect((await q({ status: "pending" })).total).toBe(0);
    expect((await q({ limit: "1", offset: "1", sort: "name" })).rows.map((r) => r.fileName)).toEqual(["email.txt"]);
    // Unknown filter values are ignored, never an error.
    expect((await q({ privilege: "bogus", sort: "weird" })).total).toBe(2);

    // Over the route.
    const res = await rowsRoute.GET(new NextRequest(`http://localhost/api/documents/sets/${setId}/reviews/${reviewId}/rows?issue=breach`), { params: Promise.resolve({ id: setId, rid: reviewId }) });
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(1);
  });

  it("binds coding to the row hash: 409 on mismatch, stale after a re-run, pending after a version bump", async () => {
    const [a] = (await listRows(alice, setId, reviewId, { q: "agreement.pdf" })).rows;
    await expectStatus(codeRow(alice, setId, reviewId, fileA, { coding: "key", rowHash: "0".repeat(64) }), 409);
    await expectStatus(codeRow(alice, setId, reviewId, fileA, { coding: "bogus" as never, rowHash: a.rowHash! }), 422);
    await expectStatus(codeRow(alice, setId, reviewId, "dfile_nope", { coding: "key", rowHash: "" }), 404);
    const coded = await codeRow(alice, setId, reviewId, fileA, { coding: "key", issues: ["breach", "not_an_issue"], note: "Core contract", rowHash: a.rowHash! });
    expect(coded.decision).toMatchObject({ coding: "key", issues: ["breach"], note: "Core contract", reviewer: "u_alice", reviewerName: "Alice Rao", rowHash: a.rowHash });
    expect(coded.decisionStale).toBe(false);
    expect((await getReview(alice, setId, reviewId)).counts).toMatchObject({ coded: 1, stale: 0 });

    // Changing the columns bumps the version: rows are pending again and blank (no old cells, no old hash), so the
    // decision no longer matches what the row shows and is stale at once.
    const review = await getReview(alice, setId, reviewId);
    const renamed = await updateReview(alice, setId, reviewId, { name: "Renamed" });
    expect(renamed.version).toBe(review.version);
    const bumped = await updateReview(alice, setId, reviewId, { columns: review.columns.filter((c) => c.id !== "custom_note") });
    expect(bumped.version).toBe(review.version + 1);
    expect(bumped.counts).toMatchObject({ pending: 2, done: 0, partial: 0, coded: 0, stale: 1, privilegeFlags: 0 });
    const pendingRow = (await listRows(alice, setId, reviewId, { q: "agreement.pdf" })).rows[0];
    expect(pendingRow).toMatchObject({ status: "pending", rowHash: null, docType: null, importance: null, privilege: null, issues: [], cells: {}, summary: "" });
    expect(pendingRow.decisionStale).toBe(true);
    // Coding a pending row binds to "" (what is shown), not to the old stored hash.
    await expectStatus(codeRow(alice, setId, reviewId, fileA, { coding: "key", rowHash: a.rowHash! }), 409);

    // Re-run under the new version: the row hash changes, the decision becomes stale.
    expect(await runReview(alice, setId, reviewId)).toMatchObject({ processed: 2, remaining: 0 });
    const after = (await listRows(alice, setId, reviewId, { q: "agreement.pdf" })).rows[0];
    expect(after.status).toBe("done");
    expect(after.rowHash).not.toBe(a.rowHash);
    expect(after.decision?.coding).toBe("key");
    expect(after.decisionStale).toBe(true);
    expect((await listRows(alice, setId, reviewId, { coding: "stale" })).rows.map((r) => r.fileId)).toEqual([fileA]);
    expect((await getReview(alice, setId, reviewId)).counts).toMatchObject({ coded: 0, stale: 1 });
    await expectStatus(codeRow(alice, setId, reviewId, fileA, { coding: "relevant", rowHash: a.rowHash! }), 409);
    const recoded = await codeRow(alice, setId, reviewId, fileA, { coding: "relevant", rowHash: after.rowHash! });
    expect(recoded).toMatchObject({ decisionStale: false, decision: { coding: "relevant" } });
    // Clearing a decision.
    expect((await codeRow(alice, setId, reviewId, fileB, { coding: null, rowHash: (await listRows(alice, setId, reviewId, { q: "email" })).rows[0].rowHash! })).decision).toBeNull();
  });

  it("exports CSV with verified flags and pages, and gates export by matter permission", async () => {
    const out = await exportReview(alice, setId, reviewId, "csv");
    expect(out.contentType).toMatch(/text\/csv/);
    expect(out.filename).toMatch(/^renamed-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = String(out.body);
    expect(csv).toContain("Amount claimed — quote found");
    expect(csv).not.toContain("— verified");
    expect(csv).toContain("Seat — page");
    expect(csv).toMatch(/Mumbai,1,found,yes,The seat of arbitration shall be Mumbai/);
    expect(csv).toMatch(/Rs\. 10,00,000",1,unverified,no,/);
    expect(csv).toContain("Relevant");
    expect(csv).toContain("Alice Rao");
    expect(toCsv([["=SUM(A1)", "a,b"]])).toContain(`'=SUM(A1),"a,b"`);
    const xlsx = await exportReview(alice, setId, reviewId, "xlsx");
    expect((xlsx.body as Uint8Array).byteLength).toBeGreaterThan(1000);
    await expectStatus(exportReview(person("u_para", { roles: ["paralegal"] }), setId, reviewId, "csv"), 403);
    await expectStatus(exportReview(bob, setId, reviewId, "csv"), 404);

    const res = await exportRoute.GET(new NextRequest(`http://localhost/api/documents/sets/${setId}/reviews/${reviewId}/export?format=xlsx`), { params: Promise.resolve({ id: setId, rid: reviewId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="renamed-.*\.xlsx"/);
    const bad = await exportRoute.GET(new NextRequest(`http://localhost/api/documents/sets/${setId}/reviews/${reviewId}/export?format=pdf`), { params: Promise.resolve({ id: setId, rid: reviewId }) });
    expect(bad.status).toBe(422);
  });

  it("streams and stores a cited report", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      ai.answer = "The seat is Mumbai [1]. The unpaid sum is stated [99].";
      const { runReport } = await import("@/modules/documents/server/review-report");
      const events: ReportEvent[] = [];
      const report = await runReport(alice, setId, reviewId, ["Where is the seat?", "What is unpaid?"], (e) => events.push(e));
      expect(events[0]).toEqual({ type: "report.started", total: 2 });
      expect(events.filter((e) => e.type === "question.completed")).toHaveLength(2);
      expect(events.at(-1)?.type).toBe("report.completed");
      expect(report?.answers[0]).toMatchObject({ question: "Where is the seat?", noEvidence: false, unresolved: [99] });
      expect(report?.answers[0].citations[0]).toMatchObject({ n: 1 });
      expect(report).toMatchObject({ reviewId, status: "complete", failed: [], generatedBy: "Alice Rao", fileCount: 2 });
      const { getReport } = await import("@/modules/documents/server/review-report");
      expect((await getReport(guest, setId, reviewId))?.answers).toHaveLength(2);
      await expectStatus(getReport(bob, setId, reviewId), 404);
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("streams the report over SSE for a set the dev principal owns", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const { devPrincipal } = await import("@/lib/auth/principal");
      const me = devPrincipal();
      const own = await createSet(me, { name: "Mine" });
      await uploadServerFile(me, own.id, { name: "note.txt", mime: "text/plain", bytes: new TextEncoder().encode("The seat of arbitration shall be Mumbai.") });
      const created = await reviewsRoute.POST(new NextRequest(`http://localhost/api/documents/sets/${own.id}/reviews`, { method: "POST", body: JSON.stringify({ playbookId: "general", questions: ["Where is the seat?"] }), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id: own.id }) });
      expect(created.status).toBe(201);
      const { review } = await created.json();
      ai.answer = "Mumbai [1].";
      const params = { params: Promise.resolve({ id: own.id, rid: review.id }) };
      const res = await reportRoute.POST(new NextRequest(`http://localhost/x`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), params);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const events: ReportEvent[] = [];
      await readSSE(res, (e) => events.push(e as ReportEvent));
      expect(events.map((e) => e.type)).toEqual(["report.started", "question.started", "question.completed", "report.completed"]);
      const got = await (await reportRoute.GET(new NextRequest("http://localhost/x"), params)).json();
      expect(got.report.answers[0].answer).toBe("Mumbai [1].");
      const bad = await reportRoute.POST(new NextRequest(`http://localhost/x`, { method: "POST", body: JSON.stringify({ questions: [] }), headers: { "Content-Type": "application/json" } }), params);
      expect(bad.status).toBe(422);
      const missing = await reportRoute.POST(new NextRequest(`http://localhost/x`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id: own.id, rid: "drev_nope" }) });
      expect(missing.status).toBe(404);
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("gives Chat compact, page-cited rows for authorized sets only", async () => {
    const out = await reviewRowsForChat(alice, [setId], { issue: "breach" });
    expect(out.review?.id).toBe(reviewId);
    expect(out.total).toBe(1);
    const row = out.rows[0];
    expect(row.file).toBe("agreement.pdf");
    expect(row.values.find((v) => v.column === "Seat")).toMatchObject({ value: "Mumbai", page: 1, quoteFound: true });
    expect(row.values.find((v) => v.column === "Amount claimed")).toMatchObject({ quoteFound: false });
    expect((await reviewRowsForChat(mallory, [setId], {})).review).toBeNull();
    expect((await reviewRowsForChat(alice, [], {})).review).toBeNull();
  });

  it("deletes a file's rows with the file, and reviews with the set", async () => {
    const store = await docStore();
    expect((await store.listReviewRows(reviewId)).map((r) => r.fileId).sort()).toEqual([fileA, fileB].sort());
    await deleteFile(alice, setId, fileB);
    expect((await store.listReviewRows(reviewId)).map((r) => r.fileId)).toEqual([fileA]);
    expect((await getReview(alice, setId, reviewId)).counts.files).toBe(1);

    // Deleting a review needs delete permission and removes its rows.
    const extra = await createReview(alice, setId, { playbookId: "general" });
    await runReview(alice, setId, extra.id);
    expect((await store.listReviewRows(extra.id)).length).toBe(1);
    await expectStatus(deleteReview(person("u_para", { roles: ["paralegal"] }), setId, extra.id), 403);
    await deleteReview(alice, setId, extra.id);
    expect(await store.listReviewRows(extra.id)).toEqual([]);
    await expectStatus(getReview(alice, setId, extra.id), 404);

    await deleteSet(alice, setId);
    expect(await store.listReviewRows(reviewId)).toEqual([]);
    expect(await store.getReview(setId, reviewId)).toBeNull();
  });
});

describe("review hardening", () => {
  const FILLER = "Schedule of deliveries. ".repeat(1100); // pushes page 3 into a second window
  const DEED1 = "CONFLICT DEED made between Acme Traders and Bharat Logistics LLP, signed on 3rd April 2022. The seat of arbitration shall be Mumbai. The total claim is Rs. 50,00,000 as per the invoice; any arbitration shall follow.";
  const DEED3 = "ADDENDUM made between Acme Traders and Bharat Logistics LLP. The seat of arbitration shall be Delhi. Amount payable is ₹50 lakh in full.";
  const SCANNED = "SCANNED BUNDLE. The seat of arbitration shall be Pune.";
  const columns = [
    { id: "seat", label: "Seat", prompt: "Seat of arbitration.", kind: "text" as const },
    { id: "claim", label: "Claim", prompt: "Amount claimed.", kind: "amount" as const },
    { id: "fee", label: "Fee", prompt: "Arbitrator's fee.", kind: "amount" as const },
    { id: "signed", label: "Signed on", prompt: "Date of signing.", kind: "date" as const },
    { id: "counterparty", label: "Counterparty", prompt: "The other party.", kind: "party" as const },
    { id: "clause", label: "Arbitration clause", prompt: "Is there an arbitration clause?", kind: "yes_no" as const },
  ];
  let hSet = "";
  let hReview = "";
  let deed = "";
  let scanned = "";

  beforeAll(async () => {
    const set = await createSet(alice, { name: "Hardening bundle", matterId: MATTER });
    hSet = set.id;
    const d = await uploadBrowserPdf(alice, hSet, { kind: "pdf-text", name: "deed.pdf", size: 1000, sha256: "c".repeat(64), pages: [DEED1, FILLER, DEED3] });
    const sc = await uploadBrowserPdf(alice, hSet, { kind: "pdf-text", name: "scanned.pdf", size: 1000, sha256: "d".repeat(64), pages: [SCANNED, ""] });
    if (d.status !== "created" || sc.status !== "created") throw new Error("upload failed");
    deed = d.file.id;
    scanned = sc.file.id;
    expect(sc.file).toMatchObject({ status: "partial", ocrPages: [2] });
    hReview = (await createReview(alice, hSet, { name: "Hardening", columns, issues: [{ id: "payment", label: "Payment", description: "Payment default." }] })).id;
  });

  it("checks quotes for substance and for the value (amounts in Indian forms, dates, names)", () => {
    expect(substantiveQuote("arbitration")).toBe(false);
    expect(substantiveQuote("Mumbai", "Mumbai")).toBe(true); // the quote is the value itself
    expect(substantiveQuote("seat … at … Mumbai shall")).toBe(false); // an ellipsis part shorter than 4 characters
    expect(substantiveQuote("The seat shall be Mumbai")).toBe(true);
    expect(amountNumbers("₹50 lakh")).toEqual([5_000_000]);
    expect(amountNumbers("Rs. 50,00,000/-")).toEqual([5_000_000]);
    expect(amountNumbers("Rs 1.5 crore")).toEqual([15_000_000]);
    expect(valueInQuote("amount", "Rs. 50,00,000", "a sum of ₹50 lakh is due")).toBe(true);
    expect(valueInQuote("amount", "Rs. 2,00,000", "The total claim is Rs. 50,00,000")).toBe(false);
    expect(valueInQuote("date", "03.04.2022", "signed on 3rd April 2022")).toBe(true);
    expect(valueInQuote("date", "03.05.2022", "signed on 3rd April 2022")).toBe(false);
    expect(valueInQuote("party", "M/s Acme Traders Pvt. Ltd.", "between Acme Traders and Bharat")).toBe(true);
    expect(valueInQuote("party", "Zenith Corp", "between Acme Traders and Bharat")).toBe(false);
    expect(mergeSummaries(["Deed fixing the seat at Mumbai. More.", "", "Addendum moving the seat to Delhi. Payment terms unchanged."])).toBe("Deed fixing the seat at Mumbai. Addendum moving the seat to Delhi.");
  });

  it("marks unread scanned pages, conflicts across windows and unsupported quotes", async () => {
    const progress = await runReview(alice, hSet, hReview);
    expect(progress).toMatchObject({ processed: 2, failed: 0, remaining: 0 });
    expect(ai.calls.some((c) => c.input.includes("SCANNED BUNDLE") && /1 scanned page\(s\) have no text yet/.test(c.input))).toBe(true);
    const { rows } = await listRows(alice, hSet, hReview, { sort: "name" });
    const d = rows.find((r) => r.fileId === deed)!;
    expect(d.status).toBe("done");
    // Two supported, different seats: conflict, first value kept, the other as an alternative.
    expect(d.cells.seat).toMatchObject({ value: "Mumbai", status: "conflict", page: 1, alternatives: [{ value: "Delhi", page: 3, quoteFound: true }] });
    // Same amount in two Indian forms: one supported value, no conflict.
    expect(d.cells.claim).toMatchObject({ value: "Rs. 50,00,000", status: "found", page: 1 });
    expect(d.cells.claim.alternatives).toBeUndefined();
    // The quote is real but does not contain the fee: unverified.
    expect(d.cells.fee).toMatchObject({ value: "Rs. 2,00,000", status: "unverified", quoteFound: true });
    expect(d.cells.signed).toMatchObject({ value: "03.04.2022", status: "found" });
    // The counterparty's name is not in its quote; a later window gives a supported name.
    expect(d.cells.counterparty).toMatchObject({ value: "Bharat Logistics LLP", status: "found", page: 3 });
    // One word ("arbitration") proves nothing.
    expect(d.cells.clause).toMatchObject({ value: "Yes", status: "unverified", quoteFound: false });
    expect(d.issues[0]).toMatchObject({ issueId: "payment", relevance: "high", quoteFound: false });
    expect(d.privilege).toMatchObject({ flag: "possible", quoteFound: false }); // "advice": one word
    expect(d.summary).toMatch(/Mumbai/);
    expect(d.summary).toMatch(/Delhi/); // built from every window, not only the first

    const sc = rows.find((r) => r.fileId === scanned)!;
    expect(sc.status).toBe("partial");
    expect(sc.coverage.unreadPages).toEqual([2]);
    expect(sc.coverage.read).toBeLessThan(sc.coverage.total);
    expect(sc.cells.seat).toMatchObject({ value: "Pune", status: "found" });
    expect(sc.cells.claim).toMatchObject({ value: null, status: "not_read" }); // never "not_stated" when a page was not read
    expect(sc.cells.fee).toMatchObject({ status: "not_read" });

    const counts = (await getReview(alice, hSet, hReview)).counts;
    expect(counts).toMatchObject({ files: 2, done: 1, partial: 1, pending: 0, failed: 0, privilegeFlags: 1 });
    expect((await listRows(alice, hSet, hReview, parseRowQuery({ status: "partial" }))).rows.map((r) => r.fileId)).toEqual([scanned]);
    expect((await listRows(alice, hSet, hReview, parseRowQuery({ q: "delhi" }))).rows.map((r) => r.fileId)).toEqual([deed]); // alternatives are searchable

    const csv = String((await exportReview(alice, hSet, hReview, "csv")).body);
    expect(csv).toContain("Mumbai | conflicts with: Delhi (p. 3)");
    expect(csv).toMatch(/scanned\.pdf,2,partial,\d+%,2,/);
    const chat = await reviewRowsForChat(alice, [hSet], { reviewId: hReview, limit: Number.NaN });
    expect(chat.rows).toHaveLength(2); // NaN limit falls back to the default
    expect(chat.rows.find((r) => r.fileId === deed)?.values.find((v) => v.column === "Seat")).toMatchObject({ status: "conflict", alternatives: [{ value: "Delhi", page: 3 }] });
  });

  it("never exposes old results for rows that are not current (rows, facets, export, chat)", async () => {
    const before = await getReview(alice, hSet, hReview);
    const bumped = await updateReview(alice, hSet, hReview, { columns: columns.filter((c) => c.id !== "fee"), version: before.version });
    expect(bumped.counts).toMatchObject({ files: 2, done: 0, partial: 0, pending: 2, privilegeFlags: 0 });
    const page = await listRows(alice, hSet, hReview, {});
    for (const r of page.rows) expect(r).toMatchObject({ status: "pending", cells: {}, issues: [], privilege: null, docType: null, rowHash: null, summary: "" });
    expect(page.facets).toMatchObject({ docTypes: [], privilege: { possible: 0, likely: 0 }, issues: [{ issueId: "payment", high: 0, medium: 0, low: 0 }] });
    expect((await listRows(alice, hSet, hReview, parseRowQuery({ q: "mumbai" }))).total).toBe(0);
    expect((await listRows(alice, hSet, hReview, parseRowQuery({ privilege: "possible" }))).total).toBe(0);
    const csv = String((await exportReview(alice, hSet, hReview, "csv")).body);
    expect(csv).not.toMatch(/Mumbai|Pune|50,00,000/);
    const chat = await reviewRowsForChat(alice, [hSet], { reviewId: hReview });
    expect(chat.rows.every((r) => r.docType === null && r.values.length === 0 && r.privilege === null)).toBe(true);

    // A failed run under the new basis stores no old result either.
    ai.failReview = "SCANNED BUNDLE";
    try {
      const progress = await runReview(alice, hSet, hReview);
      expect(progress).toMatchObject({ processed: 1, failed: 1 });
      expect(progress.errors[0]).toMatchObject({ fileId: scanned, error: "provider error" });
    } finally { ai.failReview = ""; }
    const store = await docStore();
    const rec = await store.getReviewRow(hReview, scanned);
    expect(rec).toMatchObject({ state: "failed", result: null, rowHash: null, attempts: 1 });
    const failedRow = (await listRows(alice, hSet, hReview, parseRowQuery({ status: "failed" }))).rows[0];
    expect(failedRow).toMatchObject({ fileId: scanned, cells: {}, privilege: null, error: "provider error" });
    // The retry (attempt 2 of 2) completes it.
    expect(await runReview(alice, hSet, hReview)).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
  });

  it("carries a previous result forward only under the same review version and file text", async () => {
    const store = await docStore();
    const review = (await store.getReview(hSet, hReview))!;
    const [file] = await store.getFiles(hSet, [deed]);
    const prev = (await store.getReviewRow(hReview, deed))!;
    expect(prev.result).not.toBeNull();
    const fresh = blankRecord(review, file, { ...prev, reviewVersion: review.version - 1, attempts: 1 }, false);
    expect(fresh).toMatchObject({ result: null, rowHash: null, attempts: 0 });
    const same = blankRecord(review, file, { ...prev, attempts: 1 }, true);
    expect(same).toMatchObject({ rowHash: prev.rowHash, attempts: 1 });
    expect(same.result).toEqual(prev.result);
  });

  it("rejects a definition change made against an older version (409 review_changed)", async () => {
    const current = await getReview(alice, hSet, hReview);
    const e = await updateReview(alice, hSet, hReview, { name: "Late edit", version: current.version - 1 }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(DocsError);
    expect(e).toMatchObject({ status: 409, code: "review_changed" });
    // The store's compare-and-set loses a race the same way.
    const store = await docStore();
    const stored = (await store.getReview(hSet, hReview))!;
    expect(await store.updateReview({ ...stored, name: "Raced" }, stored.version + 7)).toBe(false);
    expect((await store.getReview(hSet, hReview))!.name).toBe(stored.name);
    expect(await store.updateReview({ ...stored, name: "Won" }, stored.version)).toBe(true);
    await expectStatus(updateReview(alice, hSet, hReview, { version: "2" }), 422);
  });

  it("stores a partial report that lists its failed questions", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const { runReport, getReport } = await import("@/modules/documents/server/review-report");
      ai.answer = "Mumbai [1].";
      ai.agentFailures = 1;
      const events: ReportEvent[] = [];
      const report = await runReport(alice, hSet, hReview, ["Where is the seat?", "What is claimed?"], (e) => events.push(e));
      expect(report?.status).toBe("partial");
      expect(report?.answers).toHaveLength(1);
      expect(report?.failed).toHaveLength(1);
      expect(report?.failed[0]).toMatchObject({ error: "model overloaded" });
      expect(["Where is the seat?", "What is claimed?"]).toContain(report?.failed[0].question);
      expect(events.filter((e) => e.type === "question.failed")).toHaveLength(1);
      expect((await getReport(alice, hSet, hReview))?.status).toBe("partial");
    } finally {
      ai.agentFailures = 0;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("writes XLSX string cells without apostrophes and keeps the CSV guard", async () => {
    const review = (await (await docStore()).getReview(hSet, hReview))!;
    const wb = XLSX.read(toXlsx([["Header"], ["=SUM(A1)"], ["+91 98200 00000"]], review), { type: "array" });
    const ws = wb.Sheets.Review;
    expect(ws.A2).toMatchObject({ t: "s", v: "=SUM(A1)" });
    expect(ws.A2.f).toBeUndefined();
    expect(ws.A3.v).toBe("+91 98200 00000");
    expect(toCsv([["=SUM(A1)"]])).toContain("'=SUM(A1)");
  });

  it("migrates and backfills review rows created before the derived columns", () => {
    const mem = new DatabaseSync(":memory:");
    mem.exec(`CREATE TABLE docs_review_rows (review_id TEXT NOT NULL, file_id TEXT NOT NULL, set_id TEXT NOT NULL, state TEXT NOT NULL, review_version INTEGER, text_hash TEXT,
      file_stamp TEXT, windows_done INTEGER NOT NULL DEFAULT 0, result TEXT, partials TEXT NOT NULL DEFAULT '[]', row_hash TEXT, decision TEXT, error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (review_id, file_id))`);
    const result = { docType: "Notice", summary: "s", importance: 4, issues: [{ issueId: "breach", relevance: "medium", reason: "r", quote: "", page: null, quoteFound: false }], privilege: { flag: "likely", basis: "b", quote: "", page: null, quoteFound: false }, cells: { seat: { value: "Mumbai", status: "found", quote: "q", page: 1, quoteFound: true } }, coverage: { read: 5, total: 10 } };
    mem.prepare(`INSERT INTO docs_review_rows (review_id, file_id, set_id, state, result, decision, updated_at) VALUES ('r1', 'f1', 's1', 'done', ?, ?, 'x')`)
      .run(JSON.stringify(result), JSON.stringify({ coding: "key", issues: [], note: "Core Note", reviewer: "u", reviewerName: null, at: "x", rowHash: "h1" }));
    migrateReviewRows(mem);
    migrateReviewRows(mem); // idempotent
    expect(mem.prepare(`SELECT cov_partial, doc_type, importance, privilege_flag, issue_ranks, coding, decision_hash, coding_note, derived_v, instr(search_text, 'mumbai') > 0 AS hit FROM docs_review_rows`).get())
      .toMatchObject({ cov_partial: 1, doc_type: "Notice", importance: 4, privilege_flag: "likely", issue_ranks: "|breach:2|", coding: "key", decision_hash: "h1", coding_note: "core note", derived_v: 1, hit: 1 });
  });
});
