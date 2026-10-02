import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/matters-desk-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUST_HEADER;
  delete process.env.LECLAUDE_USER_ID;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { setWorkspaceUser } from "@/lib/current-user";
import { AUTH_HEADER_USER } from "@/lib/auth/types";
import { setupWorkspace } from "@/modules/workspace/service";
import { createMatter } from "@/modules/matters/service";
import { registerOfficialImpl, OfficialNotConfiguredError, OfficialNotImplementedError } from "@/modules/official/service";
import type { CauseListEntry, ListingMatch, MatterCaseIdentifier, SourceDocument } from "@/modules/official/types";
import { advocateMatches, normalizeIdentifier, suggestIdentifiers, validateTrackingInput, forumHasParsedLists } from "@/modules/matters/desk/tracking";
import { buildActionItems, checkQuote, computeDeadline, parsePeriod, parseStatedDate, type OrderTextChunk } from "@/modules/matters/desk/order-actions";
import { resolveRange } from "@/modules/matters/desk/dates";
import { collectToolSources, expandNumberedRefs, resolveClaims } from "@/modules/matters/desk/brief-format";
import { extractOrderActions, getTracking, listActionSets, matterListings, putTracking, reviewActionSet } from "@/modules/matters/desk/server";
import { generateHearingBrief, listBriefs } from "@/modules/matters/desk/brief";
import type { BriefStreamEvent } from "@/modules/matters/desk/types";
import * as trackingRoute from "@/app/api/matters/[id]/tracking/route";
import * as listingsRoute from "@/app/api/matters/[id]/listings/route";
import * as hearingsRoute from "@/app/api/matters/[id]/hearings/route";
import * as hearingRoute from "@/app/api/matters/[id]/hearings/[hearingId]/route";
import * as ordersRoute from "@/app/api/matters/[id]/orders/route";
import * as actionsRoute from "@/app/api/matters/[id]/orders/actions/route";
import * as reviewRoute from "@/app/api/matters/[id]/orders/actions/[setId]/review/route";
import * as briefRoute from "@/app/api/matters/[id]/brief/route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const nreq = (path: string, init?: RequestInit) => new NextRequest(`http://localhost${path}`, init as ConstructorParameters<typeof NextRequest>[1]);
const send = (path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) => nreq(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Body });
const call = (h: unknown, ...args: unknown[]) => (h as (...a: unknown[]) => Promise<Response>)(...args);
const p = (o: Record<string, string>) => ({ params: Promise.resolve(o) });
const asHeader = (principal: Body) => {
  process.env.AUTH_MODE = "header";
  process.env.AUTH_TRUST_HEADER = "true";
  return { [AUTH_HEADER_USER]: JSON.stringify(principal) };
};

function entry(over: Partial<CauseListEntry> = {}): CauseListEntry {
  return {
    id: "cle_1", documentId: "doc_list_1", forum: "sci", listDate: "2026-10-05", listType: "main", courtNo: "5", bench: "HON'BLE MR. JUSTICE ALOK ARADHE", itemNo: "54",
    caseNumbers: [{ printed: "SLP(Crl) No. 13176/2026", normalized: "SLPCRL/13176/2026" }], diaryNo: null, parties: "HARDIK CHAWDA Versus STATE OF HIMACHAL PRADESH",
    advocates: ["AJAY MARWAH"], raw: "54 SLP(Crl) No. 13176/2026 II-C HARDIK CHAWDA AJAY MARWAH Versus STATE OF HIMACHAL PRADESH", page: 12, publishedAt: "2026-10-04T13:50:00Z", fetchedAt: "2026-10-04T14:10:00Z", parsed: true,
    ...over,
  };
}

function doc(over: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: "doc_order_1", sourceId: "sci-orders", kind: "order", url: "https://www.sci.gov.in/view-pdf/?diary_no=131762026&type=o&order_date=2026-10-01", fileUrl: "https://www.sci.gov.in/sci-get-pdf/?diary_no=131762026&type=o&order_date=2026-10-01",
    title: "HARDIK CHAWDA vs. STATE OF HIMACHAL PRADESH - SLP(Crl) No. 13176/2026", docDate: "2026-10-01", status: "indexed", mime: "application/pdf", sha256: "a".repeat(64), bytes: 1000, pages: 2,
    extraction: "text_layer", ocrPages: [], language: "en", meta: {}, version: 1, fetchedAt: "2026-10-01T12:00:00Z", indexedAt: "2026-10-01T12:05:00Z", error: null, attempts: 1, chunks: 2,
    ...over,
  };
}

const ORDER_CHUNKS = [
  { pageStart: 1, pageEnd: 1, text: "UPON hearing the counsel the Court made the following O R D E R\nIssue notice, returnable in four weeks.\nThe respondent-State shall file its counter affidavit within four weeks from today." },
  { pageStart: 2, pageEnd: 2, text: "The petitioner shall deposit Rs. 50,000 within 30 days from the date of receipt of a copy of this order.\nList on 15.10.2026." },
];

describe("tracked identifiers (pure)", () => {
  it("normalizes case numbers, diary numbers and CNRs and keeps the printed form", () => {
    expect(normalizeIdentifier({ forum: "sci", kind: "case_number", printed: "SLP(C) No. 1234/2026" })).toEqual({ ok: true, identifier: { forum: "sci", kind: "case_number", value: "SLPC/1234/2026", printed: "SLP(C) No. 1234/2026" } });
    expect(normalizeIdentifier({ forum: "hc-delhi", kind: "case_number", printed: "W.P.(C)-5812/2016" })).toMatchObject({ ok: true, identifier: { value: "WPC/5812/2016" } });
    expect(normalizeIdentifier({ forum: "sci", kind: "diary_no", printed: "Diary No. 54583-2026" })).toMatchObject({ ok: true, identifier: { value: "54583/2026" } });
    expect(normalizeIdentifier({ forum: "hc-karnataka", kind: "cnr", printed: "kahc 0101 2345 2024" })).toMatchObject({ ok: true, identifier: { value: "KAHC010123452024" } });
  });

  it("rejects what does not normalize, with the reason (never guesses)", () => {
    const bad = normalizeIdentifier({ forum: "sci", kind: "case_number", printed: "the bail matter" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/not a single recognisable case number/);
    expect(normalizeIdentifier({ forum: "hc-delhi", kind: "diary_no", printed: "54583/2026" })).toMatchObject({ ok: false, error: expect.stringMatching(/Supreme Court/) });
    expect(normalizeIdentifier({ forum: "sci", kind: "diary_no", printed: "SLP 54583/2026" }).ok).toBe(false);
    expect(normalizeIdentifier({ forum: "hc-delhi", kind: "cnr", printed: "DLHC01" }).ok).toBe(false);
    expect(normalizeIdentifier({ forum: "", kind: "case_number", printed: "SLP(C) No. 1/2026" }).ok).toBe(false);
    expect(normalizeIdentifier({ forum: "sci", kind: "party", printed: "x" }).ok).toBe(false);
  });

  it("validates a whole set: duplicates collapse, limits hold, advocate names are checked", () => {
    const v = validateTrackingInput({ identifiers: [{ forum: "sci", kind: "case_number", printed: "SLP(C) No. 1234/2026" }, { forum: "sci", kind: "case_number", printed: "SLP (C) No.1234 of 2026" }], advocateNames: ["Siddharth Panda", "siddharth  panda", " "] });
    expect(v).toMatchObject({ ok: true, identifiers: [{ value: "SLPC/1234/2026" }], advocateNames: ["Siddharth Panda"] });
    expect(validateTrackingInput({ identifiers: Array.from({ length: 13 }, (_, i) => ({ forum: "sci", kind: "case_number", printed: `SLP(C) No. ${i + 1}/2026` })) })).toMatchObject({ ok: false, field: "identifiers" });
    expect(validateTrackingInput({ identifiers: [{ forum: "sci", kind: "case_number", printed: "nonsense" }] })).toMatchObject({ ok: false, field: "identifiers.0" });
    expect(validateTrackingInput({ identifiers: [], advocateNames: ["X"] })).toMatchObject({ ok: false, field: "advocateNames" });
    expect(validateTrackingInput({ identifiers: "SLP" })).toMatchObject({ ok: false, field: "identifiers" });
  });

  it("matches advocate names by exact contiguous tokens only", () => {
    expect(advocateMatches("Panda", "SIDDHARTH PANDA")).toBe(true);
    expect(advocateMatches("Siddharth Panda", "Siddharth Panda(RESPONDENT)")).toBe(true);
    expect(advocateMatches("Pand", "SIDDHARTH PANDA")).toBe(false);
    expect(advocateMatches("Rohit BS", "ROHIT B.S")).toBe(false);
    expect(advocateMatches("Panda Siddharth", "SIDDHARTH PANDA")).toBe(false);
  });

  it("offers identifiers from the case particulars only when they normalize, and knows which forums have parsed lists", () => {
    const s = suggestIdentifiers({ courtId: "hc-delhi", caseType: "W.P.(C)", caseNumber: "5812", caseYear: 2016, cnr: "DLHC010012342016" });
    expect(s.map((i) => i.kind)).toEqual(["case_number", "cnr"]);
    expect(s[0].value).toMatch(/\/5812\/2016$/);
    expect(suggestIdentifiers({ courtId: "hc-delhi" })).toEqual([]);
    expect(suggestIdentifiers(undefined)).toEqual([]);
    expect(forumHasParsedLists("nclt-mumbai")).toBe(true);
    expect(forumHasParsedLists("hc-karnataka")).toBe(false);
    expect(forumHasParsedLists("ncltx")).toBe(false);
  });

  it("validates date ranges without widening them", () => {
    const now = new Date("2026-10-02T20:00:00Z"); // 03 Oct in India
    expect(resolveRange(null, null, 14, now)).toEqual({ ok: true, from: "2026-10-03", to: "2026-10-16" });
    expect(resolveRange("2026-10-10", "2026-10-01", 14, now).ok).toBe(false);
    expect(resolveRange("2026-01-01", "2026-12-31", 14, now).ok).toBe(false);
    expect(resolveRange("2026-02-30", null, 14, now).ok).toBe(false);
  });
});

describe("order action items (pure)", () => {
  const chunks: OrderTextChunk[] = ORDER_CHUNKS;

  it("checks quotes verbatim (whitespace and quote marks normalized) and reports the real page", () => {
    expect(checkQuote(chunks, "The respondent-State shall file its counter affidavit within four weeks from today.", 1)).toEqual({ quoteFound: true, pageVerified: true, foundPages: { start: 1, end: 1 } });
    expect(checkQuote(chunks, "The  respondent–State shall file its counter\naffidavit", 1).quoteFound).toBe(true);
    expect(checkQuote(chunks, "List on 15.10.2026.", 1)).toEqual({ quoteFound: true, pageVerified: false, foundPages: { start: 2, end: 2 } });
    expect(checkQuote(chunks, "The petition is dismissed with costs.", 1)).toEqual({ quoteFound: false, pageVerified: false, foundPages: null });
    expect(checkQuote(chunks, "today.", 1).quoteFound).toBe(false); // too short to verify anything
    expect(checkQuote(chunks, "within four weeks from today. The petitioner shall deposit", 1)).toMatchObject({ quoteFound: true, foundPages: { start: 1, end: 2 } });
  });

  it("parses a stated period only when it runs from the order", () => {
    expect(parsePeriod("within four weeks from today")).toEqual({ ok: true, n: 4, unit: "weeks", anchor: "order" });
    expect(parsePeriod("within four (4) weeks")).toMatchObject({ ok: true, n: 4, unit: "weeks" });
    expect(parsePeriod("within 30 days from the date of this order")).toMatchObject({ ok: true, n: 30, unit: "days" });
    expect(parsePeriod("within 30 days from the date of receipt of a copy of this order")).toEqual({ ok: false, reason: "runs_from_event" });
    expect(parsePeriod("within two weeks from the next date of hearing")).toEqual({ ok: false, reason: "unparsed_period" });
    expect(parsePeriod("2 to 4 weeks")).toEqual({ ok: false, reason: "unparsed_period" });
    expect(parsePeriod("forthwith")).toEqual({ ok: false, reason: "unparsed_period" });
  });

  it("computes deadlines deterministically from the order date, or explains why not", () => {
    expect(computeDeadline({ period: "within four weeks from today", statedDate: null, orderDate: "2026-10-01", chunks }).deadline).toMatchObject({ date: "2026-10-29", basis: "period", from: "2026-10-01" });
    expect(computeDeadline({ period: "within 30 days from the date of receipt of a copy of this order", statedDate: null, orderDate: "2026-10-01", chunks })).toEqual({ deadline: null, gap: "runs_from_event" });
    expect(computeDeadline({ period: "within six weeks", statedDate: null, orderDate: "2026-10-01", chunks })).toEqual({ deadline: null, gap: "period_not_in_text" });
    expect(computeDeadline({ period: "within four weeks from today", statedDate: null, orderDate: null, chunks })).toEqual({ deadline: null, gap: "no_order_date" });
    expect(computeDeadline({ period: null, statedDate: "15.10.2026", orderDate: "2026-10-01", chunks }).deadline).toMatchObject({ date: "2026-10-15", basis: "stated_date" });
    expect(computeDeadline({ period: null, statedDate: null, orderDate: "2026-10-01", chunks })).toEqual({ deadline: null, gap: "no_period" });
    const monthly: OrderTextChunk[] = [{ pageStart: 1, pageEnd: 1, text: "Reply within one month." }];
    expect(computeDeadline({ period: "within one month", statedDate: null, orderDate: "2026-01-31", chunks: monthly }).deadline?.date).toBe("2026-02-28");
    expect(parseStatedDate("on or before 5th November, 2026")).toBe("2026-11-05");
    expect(parseStatedDate("31.02.2026")).toBeNull();
  });

  it("builds checked items: flags unverifiable quotes and never computes from them", () => {
    const items = buildActionItems({
      directions: [{ text: "Notice issued", quote: "Issue notice, returnable in four weeks.", page: 1 }],
      nextDate: { text: "Listed on 15 October 2026", quote: "List on 15.10.2026.", page: 2 },
      complianceTasks: [
        { task: "File counter affidavit", party: "Respondent-State", quote: "The respondent-State shall file its counter affidavit within four weeks from today.", page: 1, period: "within four weeks from today", statedDate: null },
        { task: "Deposit Rs. 50,000", party: "Petitioner", quote: "The petitioner shall deposit Rs. 50,000 within 30 days from the date of receipt of a copy of this order.", page: 2, period: "within 30 days from the date of receipt of a copy of this order", statedDate: null },
        { task: "Pay costs", party: "Petitioner", quote: "The petitioner shall pay costs of Rs. 10,000 within two weeks.", page: 2, period: "within two weeks", statedDate: null },
      ],
    }, chunks, "2026-10-01");
    expect(items.map((i) => i.kind)).toEqual(["direction", "next_date", "compliance", "compliance", "compliance"]);
    const [dir, nd, affidavit, deposit, costs] = items;
    expect(dir.flagged).toBe(false);
    expect(nd.deadline).toMatchObject({ date: "2026-10-15", basis: "stated_date" });
    expect(affidavit).toMatchObject({ flagged: false, deadline: { date: "2026-10-29" }, deadlineGap: null });
    expect(deposit).toMatchObject({ flagged: false, deadline: null, deadlineGap: "runs_from_event" });
    expect(costs).toMatchObject({ flagged: true, deadline: null, deadlineGap: "quote_not_found", check: { quoteFound: false } });
  });
});

describe("brief references (pure)", () => {
  it("registers tool refs as read or found and resolves claims without substituting", () => {
    const reg = collectToolSources([
      { name: "search_judgments", result: { results: [{ source: "judgment://sci/2024-1", title: "A v. B", url: "https://example.org/a" }, { source: "judgment://sci/2023-9", title: "C v. D" }] } },
      { name: "read_judgment", result: JSON.stringify({ source: "judgment://sci/2024-1", title: "A v. B" }) },
    ]);
    expect(reg.get("judgment://sci/2024-1")?.state).toBe("read");
    expect(reg.get("judgment://sci/2023-9")?.state).toBe("found");
    reg.set("src://doc_order_1#p1", { ref: "src://doc_order_1#p1", title: "Order", url: null, state: "supplied" });
    const { claims, sources } = resolveClaims([{ section: "points", claims: [
      { text: "Counter is due", sources: ["src://doc_order_1#p1"] },
      { text: "Authority", sources: ["judgment://sci/2024-1", "judgment://sci/2023-9"] },
      { text: "Invented", sources: ["judgment://sci/9999-1"] },
      { text: "Bare", sources: [] },
    ] }], reg);
    expect(claims.map((c) => c.status)).toEqual(["source_linked", "partial", "unsupported", "unsupported"]);
    expect(sources.find((s) => s.ref === "judgment://sci/9999-1")?.state).toBe("unresolved");
  });

  it("maps numbered citations to exactly the evidence they number, and nothing else", () => {
    const out = expandNumberedRefs([{ text: "x", sources: ["[1]", "2", "[7]", "src://doc_order_1#p1", "[ 2 ]"] }], ["src://a#p1", "src://a#p2"]);
    expect(out[0].sources).toEqual(["src://a#p1", "src://a#p2", "[7]", "src://doc_order_1#p1", "src://a#p2"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

let matterA = "";
let matterB = "";
const calls: { listings: { matterId: string; identifiers: MatterCaseIdentifier[] }[][]; orders: MatterCaseIdentifier[][] } = { listings: [], orders: [] };

beforeAll(() => {
  resetSqlite();
  setWorkspaceUser(null);
  db();
  setupWorkspace({ firmName: "Rao & Iyer Advocates", name: "Meera Rao", email: "mrao@raoiyer.in", role: "Partner" });
  matterA = createMatter({ name: "Hardik Chawda v. State of H.P.", practiceArea: "Litigation", india: { courtId: "sci" } }).id;
  matterB = createMatter({ name: "Unitech Holdings v. Entertainment City", practiceArea: "Corporate / M&A" }).id;
});
afterEach(() => {
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUST_HEADER;
  registerOfficialImpl({ listingsForMatters: undefined, ordersForIdentifiers: undefined, readOfficialDocument: undefined, causeListEntries: undefined });
});

describe("tracking API", () => {
  it("rejects an identifier that does not normalize with a 400 and the reason", async () => {
    const r = await json(await call(trackingRoute.PUT, send(`/api/matters/${matterA}/tracking`, { identifiers: [{ forum: "sci", kind: "case_number", printed: "bail matter" }] }, "PUT"), p({ id: matterA })));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_identifier", error: expect.stringMatching(/not a single recognisable case number/), fields: { "identifiers.0": expect.any(String) } });
    expect(getTracking(matterA)).toBeNull();
  });

  it("stores normalized identifiers in matter_tracking (not inside matter.india) and returns them", async () => {
    const r = await json(await call(trackingRoute.PUT, send(`/api/matters/${matterA}/tracking`, { identifiers: [{ forum: "sci", kind: "case_number", printed: "SLP(Crl) No. 13176/2026" }, { forum: "sci", kind: "diary_no", printed: "Diary No. 54583-2026" }], advocateNames: ["Ajay Marwah"] }, "PUT"), p({ id: matterA })));
    expect(r.status).toBe(200);
    expect(r.body.tracking.identifiers).toEqual([
      { forum: "sci", kind: "case_number", value: "SLPCRL/13176/2026", printed: "SLP(Crl) No. 13176/2026" },
      { forum: "sci", kind: "diary_no", value: "54583/2026", printed: "Diary No. 54583-2026" },
    ]);
    expect(db().collection("matter_tracking").get(matterA)).toBeTruthy();
    expect((db().matters.get(matterA) as Body).india).toEqual({ courtId: "sci" });
    const g = await json(await call(trackingRoute.GET, nreq(`/api/matters/${matterA}/tracking`), p({ id: matterA })));
    expect(g.body.tracking.advocateNames).toEqual(["Ajay Marwah"]);
    expect(g.body.forums.some((f: Body) => f.id === "sci" && f.parsed)).toBe(true);
  });

  it("denies a guest and a member scoped to another matter", async () => {
    const guest = asHeader({ id: "u_guest", name: "Client", roles: ["client_guest"], matterIds: [matterB] });
    for (const [h, req] of [
      [trackingRoute.GET, nreq(`/api/matters/${matterA}/tracking`, { headers: guest })],
      [trackingRoute.PUT, send(`/api/matters/${matterA}/tracking`, { identifiers: [] }, "PUT", guest)],
      [listingsRoute.GET, nreq(`/api/matters/${matterA}/listings`, { headers: guest })],
      [ordersRoute.GET, nreq(`/api/matters/${matterA}/orders`, { headers: guest })],
      [hearingsRoute.POST, send(`/api/matters/${matterA}/hearings`, { date: "2026-10-09" }, "POST", guest)],
      [briefRoute.GET, nreq(`/api/matters/${matterA}/brief`, { headers: guest })],
      [briefRoute.POST, send(`/api/matters/${matterA}/brief`, {}, "POST", guest)],
    ] as const) expect((await call(h, req, p({ id: matterA }))).status).toBe(403);
    const scoped = asHeader({ id: "u_assoc", name: "Associate", roles: ["associate"], matterIds: [matterB] });
    expect((await call(listingsRoute.GET, nreq(`/api/matters/${matterA}/listings`, { headers: scoped }), p({ id: matterA }))).status).toBe(403);
    expect((await call(listingsRoute.GET, nreq(`/api/matters/${matterB}/listings`, { headers: scoped }), p({ id: matterB }))).status).toBe(200);
  });
});

describe("listings", () => {
  it("reports not available when the facade is not wired, and not configured without Postgres", async () => {
    // The facade wires the real implementation lazily; simulate an implementation that is not wired on this deployment.
    registerOfficialImpl({ listingsForMatters: async () => { throw new OfficialNotImplementedError("listingsForMatters"); } });
    const r = await json(await call(listingsRoute.GET, nreq(`/api/matters/${matterA}/listings?from=2026-10-01&to=2026-10-14`), p({ id: matterA })));
    expect(r.body).toMatchObject({ state: "not_available", listings: [] });
    registerOfficialImpl({ listingsForMatters: async () => { throw new OfficialNotConfiguredError(); } });
    const c = await json(await call(listingsRoute.GET, nreq(`/api/matters/${matterA}/listings`), p({ id: matterA })));
    expect(c.body).toMatchObject({ state: "not_configured", listings: [] });
  });

  it("passes only this matter's identifiers and keeps only its parsed, in-range matches with their source list", async () => {
    calls.listings = [];
    registerOfficialImpl({
      listingsForMatters: async (ms) => {
        calls.listings.push(ms);
        const on: MatterCaseIdentifier = { forum: "sci", kind: "case_number", value: "SLPCRL/13176/2026" };
        return [
          { matterId: matterA, entry: entry(), matchedOn: on },
          { matterId: matterA, entry: entry({ id: "cle_dup" , documentId: "doc_list_2", itemNo: "3", courtNo: "2" }), matchedOn: on },
          { matterId: matterA, entry: entry({ id: "cle_unparsed", parsed: false }), matchedOn: on },
          { matterId: matterA, entry: entry({ id: "cle_late", listDate: "2026-12-01" }), matchedOn: on },
          { matterId: matterB, entry: entry({ id: "cle_other" }), matchedOn: on },
        ] satisfies ListingMatch[];
      },
      readOfficialDocument: async (id) => { if (id === "doc_list_2") throw new Error("gone"); return { document: doc({ id, kind: "cause_list", sourceId: "sci-causelist", url: "https://www.sci.gov.in/cause-list/", fileUrl: `https://api.sci.gov.in/jonew/cl/2026-10-05/M_J_1.pdf`, title: "Daily cause list 05-10-2026" }), chunks: [], hasMore: false, nextChunk: null, attribution: "Supreme Court of India" }; },
    });
    const r = await json(await call(listingsRoute.GET, nreq(`/api/matters/${matterA}/listings?from=2026-10-01&to=2026-10-14`), p({ id: matterA })));
    expect(r.status).toBe(200);
    expect(calls.listings).toHaveLength(1);
    expect(calls.listings[0].map((m) => m.matterId)).toEqual([matterA]);
    expect(calls.listings[0][0].identifiers).toEqual([{ forum: "sci", kind: "case_number", value: "SLPCRL/13176/2026" }, { forum: "sci", kind: "diary_no", value: "54583/2026" }]);
    expect(r.body.listings.map((l: Body) => l.id)).toEqual(["cle_dup", "cle_1"]);
    expect(r.body.listings[1].source).toEqual({ url: "https://api.sci.gov.in/jonew/cl/2026-10-05/M_J_1.pdf", title: "Daily cause list 05-10-2026" });
    expect(r.body.listings[0].source).toBeNull(); // unreadable list: no link, never another list's link
    expect(r.body.listings[1].entry.fetchedAt).toBe("2026-10-04T14:10:00Z");
  });

  it("does not call the facade for an untracked matter and rejects bad ranges", async () => {
    calls.listings = [];
    registerOfficialImpl({ listingsForMatters: async (ms) => { calls.listings.push(ms); return []; } });
    const r = await json(await call(listingsRoute.GET, nreq(`/api/matters/${matterB}/listings`), p({ id: matterB })));
    expect(r.body).toMatchObject({ state: "ok", untracked: true, listings: [] });
    expect(calls.listings).toHaveLength(0);
    expect((await call(listingsRoute.GET, nreq(`/api/matters/${matterA}/listings?from=2026-10-10&to=2026-10-01`), p({ id: matterA }))).status).toBe(400);
    expect((await call(listingsRoute.GET, nreq(`/api/matters/${matterA}/listings?from=2026-01-01&to=2026-06-01`), p({ id: matterA }))).status).toBe(400);
  });

  it("names tracked forums whose lists are not parsed", async () => {
    putTracking(matterB, { identifiers: [{ forum: "hc-karnataka", kind: "case_number", printed: "W.P. No. 1234/2026" }] });
    const r = await matterListings(matterB, "2026-10-01", "2026-10-14", { listings: async () => [] });
    expect(r.uncoveredForums).toEqual(["hc-karnataka"]);
    putTracking(matterB, { identifiers: [] });
  });
});

describe("manual hearings", () => {
  it("validates, stores, lists and deletes only within the matter", async () => {
    expect((await call(hearingsRoute.POST, send(`/api/matters/${matterA}/hearings`, { date: "09-10-2026" }), p({ id: matterA }))).status).toBe(422);
    expect((await call(hearingsRoute.POST, send(`/api/matters/${matterA}/hearings`, { date: "2026-10-09", time: "25:00" }), p({ id: matterA }))).status).toBe(422);
    const ok = await json(await call(hearingsRoute.POST, send(`/api/matters/${matterA}/hearings`, { date: "2026-10-09", time: "10:30", courtNo: "12", itemNo: "7", purpose: "Arguments on I.A. 2/2026" }), p({ id: matterA })));
    expect(ok.status).toBe(201);
    expect(ok.body.hearing).toMatchObject({ matterId: matterA, date: "2026-10-09", time: "10:30", courtNo: "12", itemNo: "7" });
    const list = await json(await call(hearingsRoute.GET, nreq(`/api/matters/${matterA}/hearings`), p({ id: matterA })));
    expect(list.body.hearings).toHaveLength(1);
    // Deleting through another matter is not found (the route authorized that other matter only).
    expect((await call(hearingRoute.DELETE, nreq(`/api/matters/${matterB}/hearings/${ok.body.hearing.id}`, { method: "DELETE" }), p({ id: matterB, hearingId: ok.body.hearing.id }))).status).toBe(404);
    expect((await call(hearingRoute.DELETE, nreq(`/api/matters/${matterA}/hearings/${ok.body.hearing.id}`, { method: "DELETE" }), p({ id: matterA, hearingId: ok.body.hearing.id }))).status).toBe(200);
  });
});

describe("orders and action items", () => {
  const orders = async (ids: MatterCaseIdentifier[]) => { calls.orders.push(ids); return [doc(), doc({ id: "doc_order_0", docDate: "2026-09-01", title: "Earlier order", sha256: "b".repeat(64) })]; };
  const read = (sha = "a".repeat(64)) => async (id: string, opts?: { fromChunk?: number }) => {
    if (id !== "doc_order_1") return null;
    const from = opts?.fromChunk ?? 0;
    return { document: doc({ sha256: sha }), chunks: ORDER_CHUNKS.slice(from, from + 1).map((c, i) => ({ documentId: id, index: from + i, heading: null, ...c })), hasMore: from + 1 < ORDER_CHUNKS.length, nextChunk: from + 1 < ORDER_CHUNKS.length ? from + 1 : null, attribution: "Supreme Court of India" };
  };

  it("lists the orders for the tracked identifiers, newest first", async () => {
    calls.orders = [];
    registerOfficialImpl({ ordersForIdentifiers: orders });
    const r = await json(await call(ordersRoute.GET, nreq(`/api/matters/${matterA}/orders`), p({ id: matterA })));
    expect(r.body.state).toBe("ok");
    expect(r.body.orders.map((o: Body) => o.document.id)).toEqual(["doc_order_1", "doc_order_0"]);
    expect(calls.orders[0].map((i) => i.value)).toEqual(["SLPCRL/13176/2026", "54583/2026"]);
  });

  it("refuses an order that is not linked to the matter and requires a documentId", async () => {
    await expect(extractOrderActions(matterA, "doc_someone_else", { orders, read: read(), extract: async () => ({ directions: [], nextDate: null, complianceTasks: [] }) })).rejects.toMatchObject({ status: 404, code: "order_not_linked" });
    expect((await call(actionsRoute.POST, send(`/api/matters/${matterA}/orders/actions`, {}), p({ id: matterA }))).status).toBe(400);
  });

  let setId = "";
  it("extracts from the whole order text, checks quotes in code and binds the set to the order hash", async () => {
    let seen = "";
    const set = await extractOrderActions(matterA, "doc_order_1", {
      orders, read: read(),
      extract: async ({ text }) => {
        seen = text;
        return {
          directions: [{ text: "Notice issued", quote: "Issue notice, returnable in four weeks.", page: 1 }],
          nextDate: { text: "List on 15 October", quote: "List on 15.10.2026.", page: 2 },
          complianceTasks: [
            { task: "File counter affidavit", party: "Respondent-State", quote: "The respondent-State shall file its counter affidavit within four weeks from today.", page: 1, period: "within four weeks from today", statedDate: null },
            { task: "Pay costs", party: null, quote: "shall pay costs of Rs. 10,000 within two weeks", page: 2, period: "within two weeks", statedDate: null },
          ],
        };
      },
    });
    setId = set.id;
    expect(seen).toContain("[Page 1]");
    expect(seen).toContain("[Page 2]");
    expect(set).toMatchObject({ matterId: matterA, documentSha256: "a".repeat(64), coverage: "complete", status: "pending_review", orderDate: "2026-10-01" });
    const comp = set.items.filter((i) => i.kind === "compliance");
    expect(comp[0].deadline?.date).toBe("2026-10-29");
    expect(comp[1]).toMatchObject({ flagged: true, deadline: null, deadlineGap: "quote_not_found" });
    expect(db().tasks.find((t) => t.matterId === matterA)).toHaveLength(0); // nothing becomes a task before review
    registerOfficialImpl({ ordersForIdentifiers: orders });
    const r = await json(await call(ordersRoute.GET, nreq(`/api/matters/${matterA}/orders`), p({ id: matterA })));
    expect(r.body.orders[0].actions).toMatchObject({ id: set.id, status: "pending_review", items: 4, flagged: 1, stale: false });
  });

  it("rejects a review when the order changed (stale) and only lets approvers confirm", async () => {
    const decisions = { decisions: [] as Body[] };
    await expect(reviewActionSet(matterA, setId, { decisions: [{ itemId: listActionSets(matterA)[0].items[2].id, create: true, dueAt: "2026-10-29" }] }, { read: read("c".repeat(64)) })).rejects.toMatchObject({ status: 409, code: "stale" });
    const para = asHeader({ id: "u_para", name: "Paralegal", roles: ["paralegal"], matterIds: "*" });
    expect((await call(reviewRoute.POST, send(`/api/matters/${matterA}/orders/actions/${setId}/review`, decisions, "POST", para), p({ id: matterA, setId }))).status).toBe(403);
  });

  it("creates tasks only for confirmed items, with the reviewer's due date, and records the review", async () => {
    const set = listActionSets(matterA)[0];
    const [affidavit, costs] = set.items.filter((i) => i.kind === "compliance");
    const r = await reviewActionSet(matterA, set.id, { decisions: [{ itemId: affidavit.id, create: true, dueAt: "2026-10-28" }, { itemId: costs.id, create: false, dueAt: null }] }, { read: read() });
    expect(r.created).toHaveLength(1);
    const task = db().tasks.get(r.created[0])!;
    expect(task).toMatchObject({ matterId: matterA, dueAt: "2026-10-28", source: "docket", tags: ["order-action"] });
    expect(task.description).toContain("Computed: 2026-10-29");
    expect(task.description).toContain("Due date confirmed by reviewer: 2026-10-28");
    expect(task.links?.[0]).toEqual({ label: "Official order", href: doc().fileUrl });
    expect(r.set).toMatchObject({ status: "reviewed", review: { decisions: [{ itemId: affidavit.id, create: true, dueAt: "2026-10-28", taskId: task.id }, { itemId: costs.id, create: false, dueAt: null }] } });
    await expect(reviewActionSet(matterA, set.id, { decisions: [{ itemId: affidavit.id, create: true, dueAt: null }] }, { read: read() })).rejects.toMatchObject({ status: 409, code: "already_reviewed" });
    await expect(reviewActionSet(matterB, set.id, { decisions: [{ itemId: affidavit.id, create: true, dueAt: null }] }, { read: read() })).rejects.toMatchObject({ status: 404 });
  });

  it("marks the extraction stale in the orders list when the order hash changes", async () => {
    registerOfficialImpl({ ordersForIdentifiers: async () => [doc({ sha256: "d".repeat(64) })] });
    const r = await json(await call(ordersRoute.GET, nreq(`/api/matters/${matterA}/orders`), p({ id: matterA })));
    expect(r.body.orders[0].actions).toMatchObject({ stale: true, status: "reviewed" });
  });
});

describe("hearing brief", () => {
  const orders = async () => [doc()];
  const read = async (id: string, opts?: { fromChunk?: number }) => {
    if (id === "doc_list_1") return { document: doc({ id, kind: "cause_list", fileUrl: "https://api.sci.gov.in/jonew/cl/2026-10-05/M_J_1.pdf" }), chunks: [], hasMore: false, nextChunk: null, attribution: "" };
    if (id !== "doc_order_1") return null;
    const from = opts?.fromChunk ?? 0;
    return { document: doc(), chunks: ORDER_CHUNKS.slice(from).map((c, i) => ({ documentId: id, index: from + i, heading: null, ...c })), hasMore: false, nextChunk: null, attribution: "" };
  };
  const listings = async () => [{ matterId: matterA, entry: entry({ listDate: "2026-10-05" }), matchedOn: { forum: "sci", kind: "case_number" as const, value: "SLPCRL/13176/2026" } }];

  it("refuses a listing that is not this matter's (no substitution)", async () => {
    await expect(generateHearingBrief(matterA, { listingId: "cle_unknown" }, () => {}, undefined, { listings, orders, read, now: new Date("2026-10-02T06:00:00Z"), agent: async () => ({ json: null, text: "", toolCalls: [] }) })).rejects.toMatchObject({ status: 404, code: "listing_not_found" });
  });

  it("builds the brief from records plus a research run, resolving every reference and hashing the markdown", async () => {
    const events: BriefStreamEvent[] = [];
    let evidenceSources: string[] = [];
    const brief = await generateHearingBrief(matterA, { listingId: "cle_1" }, (e) => events.push(e), undefined, {
      listings, orders, read, now: new Date("2026-10-02T06:00:00Z"),
      agent: async (opts) => {
        evidenceSources = (opts.evidence ?? []).map((e) => e.source);
        opts.onEvent({ type: "tool.call", id: "t1", name: "search_judgments", label: "Searching judgments", args: {} });
        return {
          text: "",
          toolCalls: [{ name: "read_judgment", args: {}, result: { source: "judgment://sci/2024-1", title: "Satender Kumar Antil v. CBI", url: "https://example.org/antil" } }],
          json: {
            summary: "Notice was issued on 1 October 2026; the State's counter is due.",
            points: [{ text: "The State's counter affidavit is due within four weeks of 1 October 2026.", sources: ["src://doc_order_1#p1"] }, { text: "Bail is the rule.", sources: ["judgment://sci/2099-1"] }],
            authorities: [{ text: "Satender Kumar Antil v. CBI: guidelines on bail.", sources: ["judgment://sci/2024-1"] }],
            questions: [{ text: "Has the deposit been made?", sources: [] }],
          },
        };
      },
    });
    expect(evidenceSources).toEqual(["src://doc_order_1#p1", "src://doc_order_1#p2"]);
    expect(events.filter((e) => e.type === "stage").map((e) => (e as { stage: string }).stage)).toEqual(["context", "orders", "research", "verify", "saved"]);
    expect(events.some((e) => e.type === "tool")).toBe(true);
    expect(brief).toMatchObject({ matterId: matterA, version: 1, listingId: "cle_1", listingDate: "2026-10-05", status: "succeeded" });
    expect(brief.hash).toBe(createHash("sha256").update(brief.markdown).digest("hex"));
    expect(brief.claims.map((c) => [c.section, c.status])).toEqual([["points", "source_linked"], ["points", "unsupported"], ["authorities", "source_linked"], ["questions", "unsupported"]]);
    expect(brief.sources.find((s) => s.ref === "judgment://sci/2099-1")?.state).toBe("unresolved");
    expect(brief.markdown).toContain("Cause lists are published by the courts");
    expect(brief.markdown).toContain("Court 5 · Item 54");
    expect(brief.markdown).toContain("[cause list](https://api.sci.gov.in/jonew/cl/2026-10-05/M_J_1.pdf)");
    expect(brief.markdown).toContain("File counter affidavit (due 28-10-2026)");
    expect(brief.markdown).toContain("- Date: 05-10-2026 · Court 5 · Item 54 · main list");
    expect(brief.markdown).toContain("As published at 04-10-2026 19:20 IST; fetched 04-10-2026 19:40 IST");
    expect(brief.markdown).toMatch(/Bail is the rule\. \[\d\] _\(not source-linked/);
    const again = await generateHearingBrief(matterA, {}, () => {}, undefined, { listings, orders, read, now: new Date("2026-10-02T06:00:00Z"), agent: async () => { throw new Error("provider down"); } });
    expect(again).toMatchObject({ version: 2, status: "partial", listingId: "cle_1" });
    expect(again.notes.join(" ")).toMatch(/research step failed/);
    expect(listBriefs(matterA).map((b) => b.version)).toEqual([2, 1]);
    const r = await json(await call(briefRoute.GET, nreq(`/api/matters/${matterA}/brief`), p({ id: matterA })));
    expect(r.body.briefs.map((b: Body) => b.version)).toEqual([2, 1]);
    expect((await call(briefRoute.POST, send(`/api/matters/${matterA}/brief`, { listingId: 5 }), p({ id: matterA }))).status).toBe(400);
  });
});
