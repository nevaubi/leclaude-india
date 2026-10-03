import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterContext, FetchedFile, FetchedPage } from "@/modules/official/adapter";
import { parseCursor } from "@/modules/official/adapters/regulators/common";
import {
  CBIC_TAXES, adapter as cbic, cbicContentUrl, cbicItems, cbicPlan, cbicStreamId, decodeCbicPdf, type CbicRecord,
} from "@/modules/official/adapters/regulators/cbic";
import { decodeCbicPdf as decodeFromIndex } from "@/modules/official/adapters/regulators";
import { CBDT_LISTINGS, adapter as cbdt, cbdtAct, cbdtCardUrl, cbdtDocs, cbdtNumber, cbdtPrintedNumber, cbdtSoNumber, parseCbdtCards } from "@/modules/official/adapters/regulators/cbdt";
import {
  ELIB_COLLECTIONS, adapter as sansad, elibFiles, elibSearchUrl, lsQuestionsUrl, lsSessionPairs, parseElibSearch, parseLsQuestions, parseRsQuestion, rsQuestionUrl, rsWhereClause,
} from "@/modules/official/adapters/regulators/sansad";

const FX = path.resolve(__dirname, "fixtures/official/regulators");
const fx = (name: string) => readFileSync(path.join(FX, name), "utf8");
const fxJson = <T = unknown>(name: string): T => JSON.parse(fx(name)) as T;

/** In-memory AdapterContext: JSON and page routes by URL; unrouted URLs answer 404. */
function makeCtx(o: { json?: (url: string) => unknown; pages?: (url: string) => string | undefined; cursor?: string | null; limit?: number } = {}) {
  const calls = { json: [] as string[], pages: [] as { url: string; opts?: unknown }[] };
  const nf = (url: string) => Object.assign(new Error(`HTTP 404 for ${url}`), { status: 404 });
  const ctx: AdapterContext = {
    limit: o.limit ?? 500,
    deadline: Date.now() + 60_000,
    cursor: o.cursor ?? null,
    today: "2026-10-02",
    async fetchPage(url, opts): Promise<FetchedPage> {
      calls.pages.push({ url, opts });
      const html = o.pages?.(url);
      if (html === undefined) throw nf(url);
      return { url, finalUrl: url, status: 200, html, markdown: null, links: [], provenance: { via: "firecrawl", status: 200, finalUrl: url } };
    },
    async fetchFile(url): Promise<FetchedFile> { throw nf(url); },
    async fetchJson<T>(url: string): Promise<T> {
      calls.json.push(url);
      const v = o.json?.(url);
      if (v === undefined) throw nf(url);
      if (v instanceof Error) throw v;
      return v as T;
    },
    async postForm(url) { throw nf(url); },
    log() {},
  };
  return { ctx, calls };
}

// ---------------------------------------------------------------------------------------------------------------------

describe("CBIC (live JSON fixtures)", () => {
  const GST = CBIC_TAXES[0];

  it("builds the verified /content/pdf URL from a backslash path and refuses traversal", () => {
    expect(cbicContentUrl("tax_repository\\gst\\circulars\\Circular-No-255-01-2026.pdf")).toBe("https://taxinformation.cbic.gov.in/content/pdf/tax_repository/gst/circulars/Circular-No-255-01-2026.pdf");
    expect(cbicContentUrl("tax_repository\\customs\\notifications\\notfns-2026\\cs-nt2026\\csnt80-2026.pdf")).toBe("https://taxinformation.cbic.gov.in/content/pdf/tax_repository/customs/notifications/notfns-2026/cs-nt2026/csnt80-2026.pdf");
    expect(cbicContentUrl("tax_repository\\..\\etc\\passwd.pdf")).toBeNull();
    expect(cbicContentUrl("tax_repository\\gst\\x.doc")).toBeNull();
    expect(cbicContentUrl(null)).toBeNull();
  });

  it("decodes the base64 JSON answer into PDF bytes (and refuses anything that is not a PDF)", () => {
    const answer = fx("cbic-content-pdf-prefix.json");
    const out = decodeCbicPdf(answer);
    expect(new TextDecoder("latin1").decode(out.bytes.slice(0, 8))).toBe("%PDF-1.7");
    expect(out.fileName).toBe("gst/circulars/Circular-No-255-01-2026.pdf");
    expect(decodeCbicPdf(JSON.parse(answer)).bytes).toEqual(out.bytes);
    expect(decodeCbicPdf(new TextEncoder().encode(answer)).bytes).toEqual(out.bytes);
    expect(decodeFromIndex).toBe(decodeCbicPdf);
    expect(() => decodeCbicPdf({ data: Buffer.from("<html>Request Rejected</html>").toString("base64") })).toThrow(/not a PDF/);
    expect(() => decodeCbicPdf({ fileName: "x.pdf" })).toThrow(/no base64 data/);
    expect(() => decodeCbicPdf("Request Rejected")).toThrow(/not JSON/);
  });

  it("turns category lists into notification and circular documents, newest first", () => {
    const notes = cbicItems(fxJson<CbicRecord[]>("cbic-notifications-gst-central-tax.json"), GST, "notification");
    expect(notes.map((d) => d.meta?.number)).toEqual(["02/2026-Central Tax", "01/2026-Central Tax", "Corrigendum"]);
    expect(notes[0]).toMatchObject({
      kind: "notification", docDate: "2026-05-07", mime: "application/pdf",
      url: "https://taxinformation.cbic.gov.in/view-pdf/1010680/ENG/Notifications",
      fileUrl: "https://taxinformation.cbic.gov.in/content/pdf/tax_repository/gst/notifications/central-tax-02-gst-10062026.pdf",
    });
    expect(notes[0].title).toMatch(/^GST Notification No\. 02\/2026-Central Tax: Seeks to empower the Principal Bench/);
    expect(notes[0].meta).toMatchObject({ base64Json: true, category: "Central Tax", tax: "GST", taxId: 1000001, amended: false, omitted: false, fileUrlHindi: "https://taxinformation.cbic.gov.in/content/pdf/tax_repository/gst/notifications/central-tax-02h-gst-10062026.pdf" });
    const circs = cbicItems(fxJson<CbicRecord[]>("cbic-circulars-gst-cgst.json"), GST, "circular");
    expect(circs.map((d) => [d.meta?.number, d.docDate])).toEqual([["256/02/2026-GST", "2026-07-25"], ["255/01/2026-GST", "2026-06-25"]]);
    expect(circs[0].url).toBe("https://taxinformation.cbic.gov.in/view-pdf/1003335/ENG/Circulars");
  });

  it("plans streams from the verified seed plus categories named in the update feeds", async () => {
    const { ctx } = makeCtx({
      json: (u) => {
        if (u.endsWith("/api/cbic-tax-msts")) return fxJson("cbic-taxes.json");
        if (u.endsWith("/fetchUpdatesByTaxId/1000001")) return fxJson("cbic-updates-gst.json");
        if (u.includes("/fetchUpdatesByTaxId/1000002")) return [{ updateType: "Notification", updateCategory: "Safeguard Duty" }, { updateType: "Circular", updateCategory: null }];
        if (u.includes("/fetchUpdatesByTaxId/")) return [];
        return undefined;
      },
    });
    const { ids } = await cbicPlan(ctx);
    expect(ids).toEqual(expect.arrayContaining([
      cbicStreamId("n", 1000001, "Central Tax"), cbicStreamId("n", 1000001, "Central Tax (Rate)"), cbicStreamId("n", 1000001, "Integrated Tax"),
      cbicStreamId("c", 1000001, "Circulars CGST"), cbicStreamId("n", 1000002, "Tariff"), cbicStreamId("n", 1000002, "Safeguard Duty"),
      cbicStreamId("c", 1000002, "*"), cbicStreamId("c", 1000003, "*"),
    ]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("discovers from category lists and returns only new records on the next pass", async () => {
    const json = (u: string): unknown => {
      if (u.endsWith("/api/cbic-tax-msts")) return fxJson("cbic-taxes.json");
      if (u.endsWith("/fetchUpdatesByTaxId/1000001")) return fxJson("cbic-updates-gst.json");
      if (u.includes("/fetchUpdatesByTaxId/")) return [];
      if (u.endsWith("/fetchNotificationByCategory/1000001/Central%20Tax")) return fxJson("cbic-notifications-gst-central-tax.json");
      if (u.endsWith("/fetchCategoryRelatedCirculars/1000001/Circulars%20CGST")) return fxJson("cbic-circulars-gst-cgst.json");
      if (u.includes("/api/cbic-")) return [];
      return undefined;
    };
    const r1 = await cbic.discover(makeCtx({ json }).ctx);
    expect(r1.done).toBe(true);
    expect(r1.items).toHaveLength(5);
    expect(r1.items.every((d) => d.meta?.base64Json === true)).toBe(true);
    const fresh = [{ ...fxJson<CbicRecord[]>("cbic-circulars-gst-cgst.json")[0], id: 1003400, circularNo: "257/03/2026-GST", circularDt: "2026-09-30T05:30:00+05:30", docFilePath: "tax_repository\\gst\\circulars\\Circular-No-257-03-2026.pdf" }, ...fxJson<CbicRecord[]>("cbic-circulars-gst-cgst.json")];
    const r2 = await cbic.discover(makeCtx({ cursor: r1.nextCursor, json: (u) => (u.endsWith("/Circulars%20CGST") ? fresh : json(u)) }).ctx);
    expect(r2.items.map((d) => d.meta?.number)).toEqual(["257/03/2026-GST"]);
  });

  const cbicJson = (circulars: () => CbicRecord[]) => (u: string): unknown => {
    if (u.endsWith("/api/cbic-tax-msts")) return [{ id: 1000001, taxName: "GST", isActive: "Y" }];
    if (u.includes("/fetchUpdatesByTaxId/")) return [];
    if (u.endsWith("/fetchCategoryRelatedCirculars/1000001/Circulars%20CGST")) return circulars();
    if (u.includes("/api/cbic-")) return [];
    return undefined;
  };
  const CGST = cbicStreamId("c", 1000001, "Circulars CGST");

  it("finds a backdated or late-uploaded record on the next pass (lists are walked in upload order, marker = highest id)", async () => {
    // Review finding: lists were sorted by printed date and the walk stopped at the previous pass's first item, so a
    // record uploaded later with an earlier date sorted below the marker and was never discovered.
    const base = fxJson<CbicRecord[]>("cbic-circulars-gst-cgst.json");
    let list = base;
    const r1 = await cbic.discover(makeCtx({ json: cbicJson(() => list) }).ctx);
    expect(r1.items.map((d) => d.meta?.number)).toEqual(["256/02/2026-GST", "255/01/2026-GST"]);
    expect(parseCursor(r1.nextCursor)!.lastSeen[CGST]).toBe("c:1003335");
    const late = { ...base[1], id: 1003340, circularNo: "254A/2026-GST", circularDt: "2026-05-01T05:30:00+05:30", docFilePath: "tax_repository\\gst\\circulars\\Circular-No-254A-2026.pdf" };
    list = [...base, late];
    const r2 = await cbic.discover(makeCtx({ cursor: r1.nextCursor, json: cbicJson(() => list) }).ctx);
    expect(r2.items.map((d) => d.meta?.number)).toEqual(["254A/2026-GST"]);
    expect(r2.items[0].docDate).toBe("2026-05-01");
    expect(parseCursor(r2.nextCursor)!.lastSeen[CGST]).toBe("c:1003340");
    // The marker record (1003340) withdrawn from the list: the walk still stops at the first id at or below the marker.
    const r3 = await cbic.discover(makeCtx({ cursor: r2.nextCursor, json: cbicJson(() => base) }).ctx);
    expect(r3.items).toEqual([]);
  });

  it("walks a list in full once when its stored marker predates id ordering (a file URL)", async () => {
    const base = fxJson<CbicRecord[]>("cbic-circulars-gst-cgst.json");
    const legacy = JSON.stringify({ v: 1, mode: "incremental", plan: [], i: 0, page: null, skip: 0, misses: 0, walked: 0, lastSeen: { [CGST]: "https://taxinformation.cbic.gov.in/content/pdf/tax_repository/gst/circulars/Circular-No-256-02-2026.pdf" }, newest: {}, only: null });
    const r = await cbic.discover(makeCtx({ cursor: legacy, json: cbicJson(() => base) }).ctx);
    expect(r.items.map((d) => d.meta?.number)).toEqual(["256/02/2026-GST", "255/01/2026-GST"]);
    expect(parseCursor(r.nextCursor)!.lastSeen[CGST]).toBe("c:1003335");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("CBDT circulars and notifications (rendered fixtures)", () => {
  it("reads rendered cards: title, published date, no PDF link", () => {
    const cards = parseCbdtCards(fx("cbdt-circulars-rendered.html"), CBDT_LISTINGS[0].url);
    expect(cards.map((c) => [cbdtNumber(c.title), c.published])).toEqual([
      ["7/2026", "2026-09-28"], ["6/2026", "2026-07-02"], ["5/2026", "2026-05-12"], ["15/2025", "2025-10-29"], ["13/2025", "2025-09-19"],
    ]);
    expect(cards.every((c) => c.href === null && c.tags.length === 0)).toBe(true);
    expect(cbdtAct(cards[1].title)).toBe("1961");
    expect(cbdtAct(cards[0].title)).toBeNull();
  });

  it("records notification numbers, S.O. numbers and the Act named in the title", () => {
    const cards = parseCbdtCards(fx("cbdt-notifications-rendered.html"), CBDT_LISTINGS[1].url);
    expect(cards.map((c) => cbdtNumber(c.title))).toEqual(["133/2026", "132/2026", "8/2026", "130/2026"]);
    expect(cbdtSoNumber(cards[0].title)).toBe("S.O. 5368(E)");
    expect(cbdtSoNumber(cards[2].title)).toBeNull();
    expect(cbdtAct(cards[1].title)).toBe("2025");
    const docs = cbdtDocs(cards, CBDT_LISTINGS[1]);
    expect(docs[1]).toMatchObject({ kind: "notification", fileUrl: null, mime: "text/plain", docDate: "2026-09-29" });
    expect(docs[1].url).toMatch(/^https:\/\/www\.incometaxindia\.gov\.in\/notifications#notification-132-2026-cbdt-[0-9a-f]{12}$/);
    expect(docs[1].meta).toMatchObject({ number: "132/2026", printedNumber: "132/2026-CBDT", soNumber: "S.O. 5353(E)", act: "2025", pdfLinkFound: false, urlIsListing: true });
    expect(docs.map((d) => d.meta?.printedNumber)).toEqual(["133/2026", "132/2026-CBDT", "08/2026", "130/2026-CBDT"]);
    expect(docs[1].text).toContain("Notification No. 132/2026-CBDT [F. No. 203/25/2025/ITA-II] / SO 5353(E)");
    expect(docs[1].text).toContain("Published On: 2026-09-29");
  });

  it("never gives two different cards the same record identity (series suffix, leading zeros, card hash)", () => {
    // Review finding: "Notification No. 8/2026-CBDT" and "Notification No. 08/2026 : Order under section 45(3)(b)" (two
    // series) both became …/notifications#notification-8-2026, so one instrument's record replaced the other's.
    const listing = CBDT_LISTINGS[1];
    const a = { title: "Notification No. 8/2026-CBDT [F. No. 370142/1/2026-TPL] / SO 120(E) : Income-tax (First Amendment) Rules, 2026", published: "2026-01-14", tags: [], href: null };
    const b = { title: "Notification No. 08/2026 : Order under section 45(3)(b) of the Income Tax Act, 2025 read with Rule 35 of the Income Tax Rules, 2026", published: "2026-09-26", tags: [], href: null };
    const c = { ...a, title: "Notification No. 8/2026 : Another instrument printed without its series", published: "2026-03-02" };
    const urls = cbdtDocs([a, b, c], listing).map((d) => d.url);
    expect(new Set(urls).size).toBe(3);
    expect(urls[0]).toMatch(/#notification-8-2026-cbdt-[0-9a-f]{12}$/);
    expect(urls[1]).toMatch(/#notification-08-2026-[0-9a-f]{12}$/);
    expect(cbdtDocs([a, b, c], listing).map((d) => d.meta?.number)).toEqual(["8/2026", "8/2026", "8/2026"]);
    // Stable: the same card always gets the same URL, so a re-listing upserts the same record.
    expect(cbdtCardUrl(a, listing)).toBe(urls[0]);
    expect(cbdtCardUrl({ ...a }, listing)).toBe(cbdtCardUrl(a, listing));
    expect(cbdtPrintedNumber("Circular No. 13 /2025 : Order under section 119")).toBe("13/2025");
  });

  it("lists every card on every pass (no stop marker on a ten-card page)", async () => {
    const pages = (u: string) => (u === CBDT_LISTINGS[0].url ? fx("cbdt-circulars-rendered.html") : undefined);
    const r1 = await cbdt.discover(makeCtx({ pages }).ctx);
    const r2 = await cbdt.discover(makeCtx({ pages, cursor: r1.nextCursor }).ctx);
    expect(r2.items.map((d) => d.url)).toEqual(r1.items.map((d) => d.url));
  });

  it("uses a card's own document link when it has one, and never guesses a slug", () => {
    const html = fx("cbdt-circulars-rendered.html").replace('<p class="" title=""></p>', '<p class="" title=""><a href="/documents/d/guest/circular-7-2026">PDF</a></p>');
    const docs = cbdtDocs(parseCbdtCards(html, CBDT_LISTINGS[0].url), CBDT_LISTINGS[0]);
    expect(docs[0]).toMatchObject({ fileUrl: "https://www.incometaxindia.gov.in/documents/d/guest/circular-7-2026", url: "https://www.incometaxindia.gov.in/documents/d/guest/circular-7-2026", text: null });
    expect(docs[1].fileUrl).toBeNull();
  });

  it("asks for the rendered page (Firecrawl, 4 s wait) and reports an unrendered answer instead of guessing", async () => {
    const { ctx, calls } = makeCtx({ pages: (u) => (u === CBDT_LISTINGS[0].url ? fx("cbdt-circulars-rendered.html") : u === CBDT_LISTINGS[1].url ? "<html><etds-circular-notification></etds-circular-notification></html>" : undefined) });
    const r = await cbdt.discover(ctx);
    expect(calls.pages.map((c) => c.opts)).toEqual([{ firecrawl: true, waitForMs: 4000 }, { firecrawl: true, waitForMs: 4000 }]);
    expect(r.items).toHaveLength(5);
    expect(r.notes?.join(" ")).toMatch(/notifications: no rendered cards/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("Sansad (live JSON fixtures)", () => {
  it("sends rsdoc.nic.in only the official equality whereclause, built from validated values", () => {
    expect(rsWhereClause(268, 1, "STARRED")).toBe("ses_no=268 and qno='1' and qtype='STARRED'");
    expect(rsQuestionUrl(268, 1, "UNSTARRED")).toBe("https://rsdoc.nic.in/Question/Search_Questions?whereclause=ses_no%3D268%20and%20qno%3D'1'%20and%20qtype%3D'UNSTARRED'");
    expect(() => rsWhereClause(268.5, 1, "STARRED")).toThrow();
    expect(() => rsWhereClause(268, 0, "STARRED")).toThrow();
    expect(() => rsWhereClause(268, 1, "STARRED' or '1'='1" as "STARRED")).toThrow();
  });

  it("parses a Rajya Sabha answer for exactly the requested question (never another one)", () => {
    const ans = fxJson("sansad-rs-question.json");
    const d = parseRsQuestion(ans, 268, 1, "STARRED")!;
    expect(d).toMatchObject({
      kind: "parliament_question", url: "https://sansad.in/getFile/annex/268/AS1_PUVYUQ.pdf?source=pqars", docDate: "2025-07-21",
      title: "Rajya Sabha Starred Question No. 1: Direct international flights from Patna airport",
    });
    expect(d.meta).toMatchObject({ house: "rajya_sabha", session: 268, questionNo: 1, ministry: "CIVIL AVIATION", members: ["Dr. Bhim Singh"], status: "Answered", fileUrlHindi: "https://sansad.in/getFile/qhindi/268/AS1_PUVYUQ.pdf?source=pqars" });
    expect(parseRsQuestion(ans, 268, 2, "STARRED")).toBeNull();
    expect(parseRsQuestion(ans, 268, 1, "UNSTARRED")).toBeNull();
    expect(parseRsQuestion([], 268, 1, "STARRED")).toBeNull();
  });

  it("parses Lok Sabha questions and the session list", () => {
    const p = parseLsQuestions(fxJson("sansad-ls-questions.json"))!;
    expect(p.total).toBe(4500);
    expect(p.items).toHaveLength(3);
    expect(p.items[0]).toMatchObject({
      url: "https://sansad.in/getFile/lsapps/loksabhaquestions/annex/188/AS360_7GaY3g.pdf?source=lsapps", docDate: "2026-08-12",
      title: "Lok Sabha Starred Question No. 360: Nuclear Power Generation under Atomic Energy Programme",
    });
    expect(p.items[0].meta).toMatchObject({ house: "lok_sabha", lokSabha: 18, session: 8, questionNo: 360, ministry: "ATOMIC ENERGY", members: ["Dr. Prabha Mallikarjun"] });
    expect(p.items[2].title).toBe("Lok Sabha Starred Question No. 358: Review of Capacity Enhancement on Mangaluru Rail Corridors");
    expect(lsSessionPairs(fxJson("sansad-ls-sessions.json"))).toEqual([{ ls: 18, session: 8 }, { ls: 18, session: 7 }, { ls: 17, session: 15 }]);
    expect(parseLsQuestions({})).toBeNull();
  });

  it("parses eLibrary search results and prefers the TEXT bundle", () => {
    const p = parseElibSearch(fxJson("sansad-elibrary-committee-search.json"), "committee")!;
    expect(p.totalPages).toBe(6701);
    expect(p.items[0]).toMatchObject({ kind: "committee_report", url: "https://elibrary.sansad.in/handle/123456789/1541625", docDate: "2026-08-04", fileUrl: null });
    expect(p.items[0].title).toMatch(/^Tenth Report of the Standing Committee on Housing and Urban Affairs/);
    expect(p.items[0].meta).toMatchObject({ committee: "Committee on Housing and Urban Affairs", reportNumber: "10", lokSabha: 18, category: "Departmentally Related Standing Committees", itemUuid: "693be825-568c-4285-9c90-6580f88285da" });
    expect(elibFiles(fxJson("sansad-elibrary-bundles.json"))).toEqual({
      textUrl: "https://elibrary.sansad.in/server/api/core/bitstreams/7dc8f230-44bd-41b1-a524-3e2da178b1e8/content",
      pdfUrl: "https://elibrary.sansad.in/server/api/core/bitstreams/9b8c083b-397f-4c27-853e-0c57d4d39538/content",
      textBytes: 216446,
    });
  });

  it("discovers retained eLibrary material without requesting retired parliamentary questions", async () => {
    const rsAnswer = fxJson<Record<string, unknown>[]>("sansad-rs-question.json").map((q) => ({ ...q, ses_no: 271 }));
    const json = (u: string): unknown => {
      if (u.endsWith("/api_ls/business/AllLoksabhaAndSessionDates")) return fxJson("sansad-ls-sessions.json");
      if (u.endsWith("/api_rs/business/getSessionsList?docType=SQ")) return fxJson("sansad-rs-sessions.json");
      if (u === lsQuestionsUrl(18, 8, 1)) return fxJson("sansad-ls-questions.json");
      if (u.startsWith("https://sansad.in/api_ls/question/")) return [{ listOfQuestions: [], totalRecordSize: 4500 }];
      if (u === rsQuestionUrl(271, 1, "STARRED")) return rsAnswer;
      if (u.startsWith("https://rsdoc.nic.in/")) return [];
      if (u === elibSearchUrl(ELIB_COLLECTIONS.committee.uuid, 0)) return fxJson("sansad-elibrary-committee-search.json");
      if (u.startsWith("https://elibrary.sansad.in/server/api/discover/")) return { _embedded: { searchResult: { _embedded: { objects: [] }, page: { totalPages: 0 } } } };
      if (u.includes("/items/693be825-568c-4285-9c90-6580f88285da/bundles")) return fxJson("sansad-elibrary-bundles.json");
      if (u.includes("/bundles?embed=bitstreams")) return { _embedded: { bundles: [] } };
      return undefined;
    };
    const { ctx, calls } = makeCtx({ json });
    const r = await sansad.discover(ctx);
    expect(r.done).toBe(true);
    const kinds = r.items.map((d) => `${d.kind}:${d.meta?.house}`);
    expect(kinds.filter((k) => k === "parliament_question:lok_sabha")).toHaveLength(0);
    expect(kinds.filter((k) => k === "parliament_question:rajya_sabha")).toHaveLength(0);
    const reports = r.items.filter((d) => d.kind === "committee_report");
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ fileUrl: "https://elibrary.sansad.in/server/api/core/bitstreams/7dc8f230-44bd-41b1-a524-3e2da178b1e8/content", mime: "text/plain" });
    expect(reports[0].meta).toMatchObject({ originalPdfUrl: "https://elibrary.sansad.in/server/api/core/bitstreams/9b8c083b-397f-4c27-853e-0c57d4d39538/content", noFile: false });
    expect(reports[1].meta).toMatchObject({ noFile: true });
    expect(calls.json.some((u) => ['rsdoc', 'api_ls/question', 'api_rs/business', 'AllLoksabhaAndSessionDates'].some((part) => u.includes(part)))).toBe(false);
    expect(parseCursor(r.nextCursor)!.lastSeen['ls:18:8']).toBeUndefined();
  });

  /** A Lok Sabha session of `total` questions, newest first, 50 per page; `hasFile(q)` decides whether a file is up. */
  const lsSession = (total: number, hasFile: (q: number) => boolean = () => true) => (u: string): unknown => {
    if (u.endsWith("/api_ls/business/AllLoksabhaAndSessionDates")) return [{ loksabha: 18, sessions: [{ sessionNo: 8 }] }];
    if (u.endsWith("/api_rs/business/getSessionsList?docType=SQ")) return [];
    const m = /qetFilteredQuestionsAns\?loksabhaNo=18&sessionNumber=8&pageNo=(\d+)&pageSize=50/.exec(u);
    if (m) {
      const page = Number(m[1]);
      const list = Array.from({ length: 50 }, (_, i) => total - (page - 1) * 50 - i).filter((q) => q >= 1).map((q) => ({
        quesNo: q, subjects: `Subject ${q}`, lokNo: "18", member: ["A Member"], ministry: "FINANCE", type: "UNSTARRED", date: "12.08.2026", sessionNo: "8",
        questionsFilePath: hasFile(q) ? `https://sansad.in/getFile/loksabhaquestions/annex/188/AU${q}.pdf?source=pqals` : null,
      }));
      return [{ listOfQuestions: list, totalRecordSize: total }];
    }
    if (u.startsWith("https://elibrary.sansad.in/server/api/discover/")) return { _embedded: { searchResult: { _embedded: { objects: [] }, page: { totalPages: 0 } } } };
    return undefined;
  };
  const lsUrl = (q: number) => `https://sansad.in/getFile/loksabhaquestions/annex/188/AU${q}.pdf?source=pqals`;

  it("retires old question cursors instead of spending calls walking them", async () => {
    const cursor = JSON.stringify({ v: 1, mode: "incremental", plan: ['ls:18:8'], i: 0, page: 1, skip: 0, misses: 0, walked: 0, lastSeen: { "ls:18:8": lsUrl(150) }, newest: {}, only: null });
    const { ctx, calls } = makeCtx({ cursor, json: lsSession(500), limit: 1000 });
    const r = await sansad.discover(ctx);
    expect(r.items.filter((d) => d.kind === 'parliament_question')).toHaveLength(0);
    expect(calls.json.filter((u) => u.includes('qetFilteredQuestionsAns'))).toHaveLength(0);
  });
  it("does not discover questions even when the question API offers downloadable PDFs", async () => {
    const { ctx, calls } = makeCtx({ json: lsSession(100) });
    const r = await sansad.discover(ctx);
    expect(r.items.filter((d) => d.kind === 'parliament_question')).toHaveLength(0);
    expect(calls.json.some((u) => u.includes('qetFilteredQuestionsAns'))).toBe(false);
  });
});
