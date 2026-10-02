import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterContext, FetchedFile, FetchedPage } from "@/modules/official/adapter";
import { parseCursor } from "@/modules/official/adapters/regulators/common";
import {
  CBIC_TAXES, adapter as cbic, cbicContentUrl, cbicItems, cbicPlan, cbicStreamId, decodeCbicPdf, type CbicRecord,
} from "@/modules/official/adapters/regulators/cbic";
import { decodeCbicPdf as decodeFromIndex } from "@/modules/official/adapters/regulators";
import { CBDT_LISTINGS, adapter as cbdt, cbdtAct, cbdtDocs, cbdtNumber, cbdtSoNumber, parseCbdtCards } from "@/modules/official/adapters/regulators/cbdt";
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
    expect(docs[1]).toMatchObject({ kind: "notification", url: "https://www.incometaxindia.gov.in/notifications#notification-132-2026", fileUrl: null, mime: "text/plain", docDate: "2026-09-29" });
    expect(docs[1].meta).toMatchObject({ number: "132/2026", soNumber: "S.O. 5353(E)", act: "2025", pdfLinkFound: false, urlIsListing: true });
    expect(docs[1].text).toContain("Notification No. 132/2026-CBDT [F. No. 203/25/2025/ITA-II] / SO 5353(E)");
    expect(docs[1].text).toContain("Published On: 2026-09-29");
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

  it("discovers the newest sessions of both houses and the eLibrary, within the whereclause contract", async () => {
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
    expect(kinds.filter((k) => k === "parliament_question:lok_sabha")).toHaveLength(3);
    expect(kinds.filter((k) => k === "parliament_question:rajya_sabha")).toHaveLength(1);
    const reports = r.items.filter((d) => d.kind === "committee_report");
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ fileUrl: "https://elibrary.sansad.in/server/api/core/bitstreams/7dc8f230-44bd-41b1-a524-3e2da178b1e8/content", mime: "text/plain" });
    expect(reports[0].meta).toMatchObject({ originalPdfUrl: "https://elibrary.sansad.in/server/api/core/bitstreams/9b8c083b-397f-4c27-853e-0c57d4d39538/content", noFile: false });
    expect(reports[1].meta).toMatchObject({ noFile: true });
    // Only the two newest sessions of each house are walked incrementally, and every rsdoc call is the exact UI form.
    const rsCalls = calls.json.filter((u) => u.startsWith("https://rsdoc.nic.in/"));
    expect(rsCalls.length).toBeGreaterThan(0);
    for (const u of rsCalls) {
      const where = decodeURIComponent(new URL(u).search.replace(/^\?whereclause=/, ""));
      expect(where).toMatch(/^ses_no=(271|270) and qno='\d+' and qtype='(STARRED|UNSTARRED)'$/);
    }
    expect(calls.json.some((u) => u.includes("loksabhaNo=17"))).toBe(false);
    const c = parseCursor(r.nextCursor)!;
    expect(c.lastSeen["rs:271:STARRED"]).toBe("1");
    expect(c.lastSeen["ls:18:8"]).toBe("https://sansad.in/getFile/lsapps/loksabhaquestions/annex/188/AS360_7GaY3g.pdf?source=lsapps");
  });
});
