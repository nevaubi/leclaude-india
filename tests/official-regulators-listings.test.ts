import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterContext, FetchedFile, FetchedPage, ParseInput } from "@/modules/official/adapter";
import { backfillCursor, isTooLargeError, parseCursor } from "@/modules/official/adapters/regulators/common";
import { SafeFetchError } from "@/lib/net/safe-fetch";
import { adapter as ibbi, corporateDebtorFromTitle, ibbiAnnouncementsUrl, ibbiLastPage, ibbiOrdersUrl, parseIbbiAnnouncements, parseIbbiOrders } from "@/modules/official/adapters/regulators/ibbi";
import {
  SEBI_PAGER_URL, SEBI_RSS_URL, adapter as sebi, parseSebiDetail, parseSebiListing, parseSebiOrderText, parseSebiRss, sebiListingUrl, sebiPagerFields, sebiPagerRange,
} from "@/modules/official/adapters/regulators/sebi";
import { orderBindingKeys } from "@/modules/official/causelist/query";
import { CCI_SEED_ID, adapter as cci, cciCaseKey, cciDetailUrl, parseCciCombinations, parseCciDetail } from "@/modules/official/adapters/regulators/cci";
import { adapter as egazette, egazettePdfUrl, parseEgazetteHome, parseGazetteText, parseUgid } from "@/modules/official/adapters/regulators/egazette";
import { adapter as gst, meetingDates, meetingNumber, parseGstCouncilMeetings } from "@/modules/official/adapters/regulators/gst-council";

const FX = path.resolve(__dirname, "fixtures/official/regulators");
const fx = (name: string) => readFileSync(path.join(FX, name), "utf8");

type PageRoute = string | { status?: number; html?: string } | Error;
interface FakeOpts {
  pages?: (url: string) => PageRoute | undefined;
  json?: (url: string) => unknown;
  files?: (url: string) => { status?: number; bytes: Uint8Array } | Error | undefined;
  post?: (url: string, fields: Record<string, string>) => { status: number; text: string } | undefined;
  cursor?: string | null;
  limit?: number;
}

/** In-memory AdapterContext: routes by URL; anything unrouted answers 404 (as the core fetchers report it). */
function makeCtx(o: FakeOpts = {}) {
  const calls = { pages: [] as { url: string; opts?: unknown }[], json: [] as string[], files: [] as { url: string; opts?: { maxBytes?: number; headers?: Record<string, string> } }[], posts: [] as { url: string; fields: Record<string, string> }[] };
  const nf = (url: string) => Object.assign(new Error(`HTTP 404 for ${url}`), { status: 404 });
  const ctx: AdapterContext = {
    limit: o.limit ?? 200,
    deadline: Date.now() + 60_000,
    cursor: o.cursor ?? null,
    today: "2026-10-02",
    async fetchPage(url, opts): Promise<FetchedPage> {
      calls.pages.push({ url, opts });
      const r = o.pages?.(url);
      if (r === undefined) throw nf(url);
      if (r instanceof Error) throw r;
      const html = typeof r === "string" ? r : (r.html ?? "");
      const status = typeof r === "string" ? 200 : (r.status ?? 200);
      return { url, finalUrl: url, status, html, markdown: null, links: [], provenance: { via: "direct", status, finalUrl: url } };
    },
    async fetchFile(url, opts): Promise<FetchedFile> {
      calls.files.push({ url, opts });
      const r = o.files?.(url);
      if (r === undefined) throw nf(url);
      if (r instanceof Error) throw r;
      const status = r.status ?? 200;
      return { url, finalUrl: url, status, mime: "application/pdf", bytes: r.bytes, provenance: { via: "direct", status, finalUrl: url } };
    },
    async fetchJson<T>(url: string): Promise<T> {
      calls.json.push(url);
      const v = o.json?.(url);
      if (v === undefined) throw nf(url);
      if (v instanceof Error) throw v;
      return v as T;
    },
    async postForm(url, fields) {
      calls.posts.push({ url, fields });
      const r = o.post?.(url, fields);
      if (!r) throw nf(url);
      return { ...r, finalUrl: url };
    },
    log() {},
  };
  return { ctx, calls };
}

const pdfBytes = () => new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n");
/** The core's fetchJson error for a body that is not JSON (ProviderError code "parse"). */
const notJson = () => Object.assign(new Error("official:cci-orders: invalid JSON (Unexpected token < in JSON)"), { code: "parse", status: 200 });

function parseInput(markdown: string, over: Partial<ParseInput> = {}): ParseInput {
  return { id: "doc1", url: "https://example.gov.in/x.pdf", title: "x", docDate: null, meta: {}, markdown, pages: [{ page: 1, text: markdown }], fetchedAt: "2026-10-02T00:00:00Z", ...over };
}

// ---------------------------------------------------------------------------------------------------------------------

describe("IBBI (live listing fixtures)", () => {
  const nclt = { path: "nclt", forum: "nclt", label: "NCLT" };
  const nclat = { path: "nclat", forum: "nclat", label: "NCLAT" };

  it("parses NCLT order rows: PDF, date, subject, case numbers, corporate debtor, remarks", () => {
    const rows = parseIbbiOrders(fx("ibbi-nclt-page1.html"), nclt, ibbiOrdersUrl("nclt", 1));
    expect(rows).toHaveLength(6);
    const [first, , raninga, zicom, spright, magic] = rows;
    expect(first).toMatchObject({
      sourceId: "ibbi", kind: "order", docDate: "2026-09-25", mime: "application/pdf",
      title: "In the matter of TAKSHASHILA CORPORATION LLP [CP(IB) 188 of 2026]",
      fileUrl: "https://ibbi.gov.in/uploads/order/2026-09-29-115640-houbm-a240fa27925a635b08dc28c9e4f9216d.pdf",
    });
    expect(first.url).toBe(first.fileUrl);
    expect(first.meta).toMatchObject({ forum: "nclt", caseKeys: ["CPIB/188/2026"], corporateDebtor: "TAKSHASHILA CORPORATION LLP", remarks: "Admission - Final Order", fileSize: "548.55 KB", orderDatePrinted: "25 Sep, 2026" });
    expect(raninga.meta?.caseNumbers).toEqual(["IA/1037(AHM) 2026", "IA (Plan)/9(AHM) 2026", "CP (IB)/271(AHM)2025"]);
    expect(raninga.meta?.caseKeys).toEqual(["IA/1037/2026", "IA/1037/2026@AHM", "IAPLAN/9/2026", "IAPLAN/9/2026@AHM", "CPIB/271/2025", "CPIB/271/2025@AHM"]);
    expect(zicom.meta).toMatchObject({ corporateDebtor: "Zicom Electronic Security Systems Limited", caseKeys: ["IAIBCPLAN/32/2026", "IAIBCPLAN/32/2026@MB", "IAIBC/1566/2026", "IAIBC/1566/2026@MB", "CPIB/610/2021"] });
    // An unreadable prefix stays printed only (never guessed into a key).
    expect(spright.meta).toMatchObject({ caseNumbers: ["?? (IB)86(AHM)2026"], caseKeys: [] });
    expect(magic.meta).toMatchObject({ caseKeys: ["CPIB/507/2021", "CPIB/507/2021@MB"], remarks: "Appointment - Appointment of Liquidator" });
    expect(ibbiLastPage(fx("ibbi-nclt-page1.html"))).toBe(1590);
  });

  it("parses NCLAT rows with parties instead of a corporate debtor and expands number lists", () => {
    const rows = parseIbbiOrders(fx("ibbi-nclat-page1.html"), nclat, ibbiOrdersUrl("nclat", 1));
    expect(rows.map((r) => r.meta?.caseKeys)).toEqual([
      ["CAATINS/347/2026"],
      ["CAATINS/1462/2026", "CAATINS/1475/2026"],
      ["CAATINS/1699/2025", "CAATINS/1700/2025", "CAATINS/1701/2025", "CAATINS/1702/2025"],
      ["IA/5813/2026", "CAATINS/124/2026"],
    ]);
    expect(rows[0].meta).toMatchObject({ corporateDebtor: null, parties: "Eastern Power Distribution Company of Andhra Pradesh Limited vs. Daulat Resolution Services Pvt. Ltd." });
    expect(rows[1].title).toContain("Duke Fashions (India) Ltd. & Ors. vs. Pramod Kumar Misra & Ors.");
    expect(corporateDebtorFromTitle("In the matter of V S Enterprises Limited [CP(IB) 1 of 2026]")).toBe("V S Enterprises Limited");
  });

  it("parses CIRP public announcements and drops the commented-out IP addresses", () => {
    const rows = parseIbbiAnnouncements(fx("ibbi-pa-cirp-page1.html"), ibbiAnnouncementsUrl("Public Announcement of Corporate Insolvency Resolution Process", 1));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      kind: "notification", docDate: "2026-09-29",
      title: "Public Announcement of Corporate Insolvency Resolution Process: TAKSHASHILA RESICOM PRIVATE LIMITED",
      fileUrl: "https://ibbi.gov.in//uploads/announcement/2026-09-29-123607-uc9g6-5c06ce6c0111806ecfd4fbad7e27f559.pdf",
    });
    expect(rows[0].meta).toMatchObject({ lastDateOfSubmission: "2026-10-09", applicant: "SHETH FINCAP SERVICES PRIVATE LIMITED", insolvencyProfessional: "Chetan Patel" });
    expect(rows[1].meta?.corporateDebtor).toBe("SHREESATYA SPONGE & POWER PRIVATE LIMITED");
    expect(JSON.stringify(rows)).not.toMatch(/TITANIUM SQUARE|Sarat Bose Road/);
    expect(ibbiLastPage(fx("ibbi-pa-cirp-page1.html"))).toBe(459);
  });

  it("discovers newest-first across listings, then only new rows on the next pass", async () => {
    const pa = ibbiAnnouncementsUrl("Public Announcement of Corporate Insolvency Resolution Process", 1);
    const routes = (url: string): PageRoute | undefined => {
      if (url === ibbiOrdersUrl("nclt", 1)) return fx("ibbi-nclt-page1.html");
      if (url === ibbiOrdersUrl("nclat", 1)) return fx("ibbi-nclat-page1.html");
      if (url === pa) return fx("ibbi-pa-cirp-page1.html");
      return "<html><body>No records</body></html>";
    };
    const { ctx, calls } = makeCtx({ pages: routes });
    const r1 = await ibbi.discover(ctx);
    expect(r1.done).toBe(true);
    expect(r1.items).toHaveLength(13);
    expect(r1.items[0].meta?.forum).toBe("nclt");
    expect(calls.pages.map((c) => c.url)).toContain("https://ibbi.gov.in/orders/nclt?page=2");
    const c1 = parseCursor(r1.nextCursor)!;
    expect(c1.lastSeen["orders:nclt"]).toBe(r1.items[0].url);

    // Next pass: one new NCLT order on top of page 1.
    const newRow = `<tr><td>1</td><td>01 Oct, 2026</td><td><a href="https://ibbi.gov.in/uploads/order/new.pdf" download="">In the matter of NEW CO LIMITED [CP(IB) 200 of 2026]&nbsp;<span class="file-type-label">PDF</span>(1 KB)</a></td><td>Admission - Final Order</td></tr>`;
    const page1 = fx("ibbi-nclt-page1.html").replace("<tbody>", `<tbody>${newRow}`);
    const r2 = await ibbi.discover(makeCtx({ cursor: r1.nextCursor, pages: (u) => (u === ibbiOrdersUrl("nclt", 1) ? page1 : routes(u)) }).ctx);
    expect(r2.items.map((d) => d.title)).toEqual(["In the matter of NEW CO LIMITED [CP(IB) 200 of 2026]"]);
    expect(r2.items[0].meta?.caseKeys).toEqual(["CPIB/200/2026"]);
  });

  it("backfills one listing page by page until the publisher's last page", async () => {
    const { ctx, calls } = makeCtx({ cursor: backfillCursor({ only: ["orders:nclat"] }), pages: (u) => (u === ibbiOrdersUrl("nclat", 1) ? fx("ibbi-nclat-page1.html") : u.startsWith("https://ibbi.gov.in/orders/nclat?page=") ? "<html></html>" : undefined) });
    const r = await ibbi.discover(ctx);
    expect(r.items).toHaveLength(4);
    expect(calls.pages.map((c) => c.url)).toEqual([ibbiOrdersUrl("nclat", 1), ibbiOrdersUrl("nclat", 2)]);
    expect(parseCursor(r.nextCursor)!.mode).toBe("incremental");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("SEBI orders (live fixtures)", () => {
  const detail = fx("sebi-order-detail.html");
  const detailFor = (category: string, pdf: string) => detail.replace("<span>Orders of AO</span>", `<span>${category}</span>`).replace(/ORDER_1790836989\.pdf/g, pdf);

  it("parses the listing rows and the pager line", () => {
    const html = fx("sebi-orders-ao-page1.html");
    const rows = parseSebiListing(html, 6, sebiListingUrl(6));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      url: "https://www.sebi.gov.in/enforcement/orders/oct-2026/adjudication-order-in-the-matter-of-smc-global-securities-ltd_104883.html",
      title: "Adjudication Order in the matter of SMC Global Securities Ltd", docDate: "2026-10-01", fileUrl: null,
    });
    expect(rows[0].meta).toMatchObject({ smid: 6, category: "Orders of AO", forum: "sebi" });
    expect(rows[2].title).toBe("Adjudication Order in the matter of Shares Bazaar Pvt. Ltd. - Research Analyst");
    expect(sebiPagerRange(html)).toEqual({ from: 1, to: 25, total: 12008 });
  });

  it("keeps only enforcement-order items from the RSS feed", () => {
    const items = parseSebiRss(fx("sebi-rss.xml"));
    expect(items.map((d) => d.url.split("/").pop())).toEqual([
      "adjudication-order-in-the-matter-of-smc-global-securities-ltd_104883.html",
      "appeal-no-7073-of-2026-filed-by-ramesh-b_104878.html",
      "final-order-in-the-matter-of-eqwires-research-analyst_104841.html",
      "adjudication-order-in-the-matter-of-bao-ltd-group_104819.html",
      "adjudication-order-in-the-matter-of-shares-bazaar-pvt-ltd-research-analyst_104810.html",
    ]);
    expect(items[0].docDate).toBe("2026-10-01");
  });

  it("reads the PDF, order number, category and date from a detail page (Firecrawl and direct HTML shapes)", () => {
    const pageUrl = "https://www.sebi.gov.in/enforcement/orders/oct-2026/adjudication-order-in-the-matter-of-smc-global-securities-ltd_104883.html";
    const want = { pdfUrl: "https://www.sebi.gov.in/sebi_data/attachdocs/oct-2026/ORDER_1790836989.pdf", orderNumber: "Order/AK/GN/2026-27/32758", category: "Orders of AO", date: "2026-10-01" };
    expect(parseSebiDetail(detail, pageUrl)).toEqual(want);
    // Direct server HTML carries a real <iframe src=…> instead of Firecrawl's rewritten <div data-original-tag>.
    const direct = detail.replace(/<div src="([^"]+)"([^>]*) data-original-tag="iframe"><\/div>/, '<iframe src="$1"$2></iframe>');
    expect(direct).toContain("<iframe src=");
    expect(parseSebiDetail(direct, pageUrl)).toEqual(want);
    expect(parseSebiDetail("<html><h1>x</h1></html>", pageUrl)).toEqual({ pdfUrl: null, orderNumber: null, category: null, date: null });
  });

  it("discovers from RSS and listings, resolves PDFs and excludes RTI appeals", async () => {
    const pages = (url: string): PageRoute | undefined => {
      if (url === SEBI_RSS_URL) return fx("sebi-rss.xml");
      if (url === sebiListingUrl(6)) return fx("sebi-orders-ao-page1.html");
      if (url.startsWith("https://www.sebi.gov.in/sebiweb/home/HomeAction.do")) return "<html><body>no rows</body></html>";
      if (url.includes("appeal-no-7073")) return detailFor("Orders of AA under the RTI Act", "APPEAL_1.pdf");
      if (url.includes("eqwires")) return detailFor("Orders of Chairperson/Members", "ORDER_2.pdf");
      if (url.includes("/enforcement/orders/")) return detail;
      return undefined;
    };
    // Page 2 of the AO list (incremental passes look 2 pages deep) answers with an empty page.
    const post = () => ({ status: 200, text: '<div class="pagination_inner"><p>26 to 50 of 12008 records</p></div><table><tbody></tbody></table>#@#x' });
    const { ctx, calls } = makeCtx({ pages, post });
    const r = await sebi.discover(ctx);
    expect(r.done).toBe(true);
    const urls = r.items.map((d) => d.url);
    expect(urls.some((u) => u.includes("appeal-no-7073"))).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
    const smc = r.items.find((d) => d.url.includes("smc-global"))!;
    expect(smc).toMatchObject({ fileUrl: "https://www.sebi.gov.in/sebi_data/attachdocs/oct-2026/ORDER_1790836989.pdf", mime: "application/pdf" });
    expect(smc.meta).toMatchObject({ orderNumber: "Order/AK/GN/2026-27/32758", category: "Orders of AO", smid: 6, forum: "sebi", pdfLinkFound: true });
    expect(r.items.find((d) => d.url.includes("eqwires"))!.meta).toMatchObject({ smid: 2, category: "Orders of Chairperson/Members" });
    // RSS (4 orders kept) + AO listing (2 more not in RSS) = 6; one POST for page 2 of the AO list.
    expect(r.items).toHaveLength(6);
    expect(calls.posts.map((p) => p.fields.doDirect)).toEqual(["1"]);
  });

  it("pages older listings with SEBI's own form fields and fails closed on a mismatched answer", async () => {
    const listing = fx("sebi-orders-ao-page1.html");
    const page2 = listing.replace("1 to 25 of 12008 records", "26 to 50 of 12008 records").replace(/_104883\.html/g, "_900001.html").replace(/_104819\.html/g, "_900002.html").replace(/_104810\.html/g, "_900003.html").replace(/_104766\.html/g, "_900004.html").replace(/_104768\.html/g, "_900005.html");
    let answer = page2;
    const { ctx, calls } = makeCtx({
      cursor: backfillCursor({ only: ["smid:6"] }),
      limit: 8,
      pages: (u) => (u === sebiListingUrl(6) ? listing : u.includes("/enforcement/orders/") ? detail : undefined),
      post: () => ({ status: 200, text: `${answer}#@#<li>breadcrumb</li>` }),
    });
    const r = await sebi.discover(ctx);
    expect(r.items).toHaveLength(8);
    expect(calls.posts[0].url).toBe(SEBI_PAGER_URL);
    expect(calls.posts[0].fields).toEqual(sebiPagerFields(6, 2));
    expect(calls.posts[0].fields).toMatchObject({ sid: "2", ssid: "9", smid: "6", doDirect: "1", smText: "Orders of AO", next: "n" });
    // The publisher answers page 2 with page 1 again: the backfill stops instead of guessing.
    answer = listing;
    const r2 = await sebi.discover(makeCtx({ cursor: r.nextCursor, pages: (u) => (u.includes("/enforcement/orders/") ? detail : undefined), post: () => ({ status: 200, text: `${answer}#@#x` }) }).ctx);
    expect(r2.notes?.join(" ")).toMatch(/did not match/);
  });

  it("reads order and SAT appeal numbers from order text", () => {
    const text = "BEFORE THE ADJUDICATING OFFICER SECURITIES AND EXCHANGE BOARD OF INDIA [ADJUDICATION ORDER NO.: Order/AK/GN/2026-27/32758] UNDER SECTION 15-I OF SECURITIES AND EXCHANGE BOARD OF INDIA ACT, 1992";
    expect(parseSebiOrderText(parseInput(text)).records).toEqual([{
      meta: { orderNumbers: ["Order/AK/GN/2026-27/32758"], appealNumbers: [], caseKeys: [], caseKeysScope: "caption", mentionedAppealNumbers: [], mentionedCaseKeys: [], caseNumbersFrom: "caption" },
    }]);
    const sat = parseSebiOrderText(parseInput("BEFORE THE SECURITIES APPELLATE TRIBUNAL MUMBAI ... Appeal No. 123 of 2025 ... Misc. Application No. 4 of 2025", { meta: { forum: "sat" } }));
    expect(sat.records[0].meta).toMatchObject({ appealNumbers: ["Appeal No. 123 of 2025"], caseKeys: ["APPEAL/123/2025"], caseKeysScope: "caption" });
    // Always one record (a re-parse replaces keys stored by an earlier parse), counted unparsed when nothing was read.
    const none = parseSebiOrderText(parseInput("nothing here"));
    expect(none.unparsed).toBe(1);
    expect(none.records[0].meta).toMatchObject({ caseKeys: [], mentionedCaseKeys: [] });
  });

  const satOrder = (caption: string, body: string) =>
    `BEFORE THE SECURITIES APPELLATE TRIBUNAL\nMUMBAI\nOrder Reserved On : 18.08.2026\nDate of Decision : 25.09.2026\n${caption}\nMr. A. Shah, Advocate for the Appellant.\nMr. B. Rao, Advocate for the Respondent.\nCORAM : Justice P.S. Dinesh Kumar, Presiding Officer\nPer : Justice P.S. Dinesh Kumar\n${body}`;
  const sat = (text: string) => parseSebiOrderText(parseInput(text, { meta: { forum: "sat", smid: 1 } })).records[0].meta;

  it("binds a SAT order only to its caption's appeal numbers; cited precedents and other courts' appeals never bind", () => {
    // Review finding: every "Appeal No. N of YYYY" on the first pages became a binding key, incl. cited precedents and
    // the tail of "Civil Appeal No." (Supreme Court).
    const text = satOrder(
      "Appeal No. 123 of 2025\nXYZ Securities Ltd.\n...Appellant\nVersus\nSecurities and Exchange Board of India\n...Respondent",
      "1. The appeal is against the order of the WTM. As held in Appeal No. 456 of 2019, and by the Supreme Court in Civil Appeal No. 7890 of 2020, the noticee ...",
    );
    expect(sat(text)).toMatchObject({
      appealNumbers: ["Appeal No. 123 of 2025"], caseKeys: ["APPEAL/123/2025"], caseKeysScope: "caption",
      mentionedAppealNumbers: ["Appeal No. 456 of 2019", "Civil Appeal No. 7890 of 2020"], mentionedCaseKeys: ["APPEAL/456/2019", "CA/7890/2020"],
    });
    // The order-binding query reads meta.caseKeys only: the caption.
    expect(orderBindingKeys({ sourceId: "sebi-orders", meta: sat(text) })).toEqual(["APPEAL/123/2025"]);
    // A cited appeal never binds even when it is the only number: the caption has none (body starts first).
    expect(sat(satOrder("XYZ Securities Ltd. ...Appellant Versus SEBI ...Respondent", "As held in Appeal No. 456 of 2019 ..."))).toMatchObject({ caseKeys: [], mentionedCaseKeys: ["APPEAL/456/2019"] });
  });

  it("binds every appeal of a combined SAT caption (each with its parties) and an appeal named after a Misc. Application", () => {
    const combined = satOrder(
      "Appeal No. 100 of 2025\nABC Ltd. ...Appellant\nVersus\nSEBI ...Respondent\nWith\nAppeal No. 101 of 2025\nDEF Ltd. ...Appellant\nVersus\nSEBI ...Respondent\nAnd\nMisc. Application No. 5 of 2026 in Appeal No. 102 of 2025\nGHI Ltd. ...Appellant\nVersus\nSEBI ...Respondent",
      "1. These appeals arise from a common order; see also Appeal No. 77 of 2018.",
    );
    expect(sat(combined)).toMatchObject({
      caseKeys: ["APPEAL/100/2025", "APPEAL/101/2025", "APPEAL/102/2025"],
      mentionedCaseKeys: ["APPEAL/77/2018"],
    });
    expect(sat(satOrder("Misc. Application No. 5 of 2026\nIN\nAppeal No. 456 of 2025\nXYZ ...Appellant\nVersus\nSEBI ...Respondent", "1. ...")).caseKeys).toEqual(["APPEAL/456/2025"]);
  });

  it("never binds appeal numbers printed in orders that are not SAT orders", () => {
    const r = parseSebiOrderText(parseInput("WHOLE TIME MEMBER ... Appeal No. 123 of 2025 ... ORDER NO.: WTM/AN/MIRSD/12345/2026-27", { meta: { forum: "sebi", smid: 2 } }));
    expect(r.records[0].meta).toMatchObject({ caseKeys: [], appealNumbers: [], mentionedAppealNumbers: ["Appeal No. 123 of 2025"], mentionedCaseKeys: ["APPEAL/123/2025"] });
    expect(r.unparsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("CCI orders", () => {
  const html = fx("cci-antitrust-detail-1181.html");
  const pageUrl = cciDetailUrl(1181);

  it("parses the detail page fields from the live capture (PDF hidden by Firecrawl → null, never guessed)", () => {
    expect(parseCciDetail(html, pageUrl)).toEqual({
      parties: "PF Digital Media Services Ltd & Anr. And UFO Moviez India Ltd. & Others",
      caseNo: "11/2020",
      type: "Anti-trust Section 19 (1) (a)",
      orderDate: "2025-04-16",
      mainOrderDate: "2025-04-16",
      pdfUrl: null,
      pdfUrls: [],
      fileSize: "694.59 KB",
    });
    expect(cciCaseKey("11/2020")).toBe("CASE/11/2020");
    expect(cciCaseKey("77 (11)/2015")).toBeNull();
    expect(parseCciDetail("<html><head><title>Server Error</title></head><body>500</body></html>", pageUrl)).toBeNull();
  });

  it("reads the PDF from the viewer iframe of the direct server HTML (assumed shape; unverified live)", () => {
    const direct = html.replace(/<div src="cid:[^"]*" id="iframesrc"([^>]*) data-original-tag="iframe">[\s\S]*?<\/div>/, '<iframe src="https://www.cci.gov.in/images/antitrustorder/en/order1744886424.pdf" id="iframesrc"$1></iframe>');
    expect(parseCciDetail(direct, pageUrl)?.pdfUrl).toBe("https://www.cci.gov.in/images/antitrustorder/en/order1744886424.pdf");
    // A handler-only link (onclick) is found too, and every referenced order PDF is kept.
    const onclick = html.replace('<a class="blue">', `<a class="blue" href="javascript:void(0)" onclick="openPdf('/images/antitrustorder/en/order1744886424.pdf')">`).replace('<a class=" marginRight">', `<a class=" marginRight" onclick="view('/images/antitrustorder/en/order1744886999.pdf')">`);
    expect(parseCciDetail(onclick, pageUrl)).toMatchObject({ pdfUrl: "https://www.cci.gov.in/images/antitrustorder/en/order1744886424.pdf", pdfUrls: ["https://www.cci.gov.in/images/antitrustorder/en/order1744886424.pdf", "https://www.cci.gov.in/images/antitrustorder/en/order1744886999.pdf"] });
    const offsite = html.replace(/<div src="cid:[^"]*" id="iframesrc"/, '<iframe src="https://evil.example/x.pdf" id="iframesrc"');
    expect(parseCciDetail(offsite, pageUrl)?.pdfUrl).toBeNull();
  });

  it("probes detail ids upward from the seed, treats HTTP 500 as unpublished and resumes above the marker", async () => {
    const serverError = (url: string) => Object.assign(new Error(`HTTP 500 for ${url}`), { status: 500 });
    const live = new Set([CCI_SEED_ID, CCI_SEED_ID + 1, CCI_SEED_ID + 3]);
    const pages = (url: string): PageRoute | undefined => {
      const m = /details\/(\d+)\/0$/.exec(url);
      if (!m) return undefined;
      return live.has(Number(m[1])) ? html : serverError(url);
    };
    const { ctx, calls } = makeCtx({ pages, json: () => notJson() });
    const r = await cci.discover(ctx);
    expect(r.items.map((d) => d.meta?.detailId)).toEqual([1250, 1251, 1253]);
    expect(r.items[0]).toMatchObject({ url: cciDetailUrl(1250), fileUrl: null, mime: "text/html", docDate: "2025-04-16" });
    expect(r.items[0].meta).toMatchObject({ caseKeys: ["CASE/11/2020"], pdfLinkFound: false, track: "antitrust" });
    expect(calls.pages).toHaveLength(14); // 1250..1263: 3 found + 10 consecutive misses after 1253 + one gap
    expect(r.notes?.join(" ")).toMatch(/combination listing page 0 did not answer with JSON/);
    expect(parseCursor(r.nextCursor)!.lastSeen.antitrust).toBe("1253");
    const again = makeCtx({ cursor: r.nextCursor, pages, json: () => ({ data: [] }) });
    await cci.discover(again.ctx);
    expect(again.calls.pages[0].url).toBe(cciDetailUrl(1254));
  });

  it("skips the unverified combinations listing only when it refuses or does not answer JSON; transient failures are not swallowed", async () => {
    // Review finding: every error (timeouts, 503s) ended the combinations walk silently, also in a backfill.
    const pages = (url: string): PageRoute | undefined => (/details\/(\d+)\/0$/.test(url) ? Object.assign(new Error(`HTTP 500 for ${url}`), { status: 500 }) : undefined);
    const unavailable = Object.assign(new Error("HTTP 503 Service Unavailable"), { status: 503 });
    const r = await cci.discover(makeCtx({ pages, json: () => unavailable }).ctx);
    expect(r.notes?.join(" ")).toMatch(/combinations: HTTP 503 Service Unavailable; skipped for this pass/);
    expect(r.notes?.join(" ")).not.toMatch(/endpoint unverified/);
    // A backfill stops at the failing page and resumes there.
    const rb = cci.discover(makeCtx({ cursor: backfillCursor({ only: ["combinations"] }), pages, json: () => unavailable }).ctx);
    await expect(rb).rejects.toThrow(/503/);
    // A later page that times out: the backfill keeps its place on that page.
    const page0 = { recordsFiltered: 120, data: [{ combination_no: "C-1", order_files: '<a href="/images/combinationorders/en/c1.pdf">Order</a>' }] };
    const timeout = Object.assign(new Error("request timed out"), { code: "timeout" });
    const rb2 = await cci.discover(makeCtx({ cursor: backfillCursor({ only: ["combinations"] }), pages, json: (u) => (u.includes("start=0&") ? page0 : timeout) }).ctx);
    expect(rb2.done).toBe(false);
    expect(rb2.items).toHaveLength(1);
    expect(parseCursor(rb2.nextCursor)!.page).toBe(1);
    // A later page refused for good (not JSON): the stream ends with a note instead of holding the backfill forever.
    const rb3 = await cci.discover(makeCtx({ cursor: rb2.nextCursor, pages, json: () => notJson() }).ctx);
    expect(rb3.done).toBe(true);
    expect(rb3.notes?.join(" ")).toMatch(/combination listing page 1 did not answer with JSON/);
    // First page refused (session / CSRF) or not JSON: skipped with a note.
    for (const refusal of [notJson(), Object.assign(new Error("HTTP 419"), { status: 419 })]) {
      const rr = await cci.discover(makeCtx({ cursor: backfillCursor({ only: ["combinations"] }), pages, json: () => refusal }).ctx);
      expect(rr.done).toBe(true);
      expect(rr.notes?.join(" ")).toMatch(/combination listing page 0 did not answer with JSON/);
    }
  });

  it("maps DataTables combination rows to one item per order PDF (endpoint unverified; fails closed)", () => {
    // SYNTHETIC answer in yajra DataTables shape with the column names read from the page's DataTables config.
    const ans = { draw: 1, recordsTotal: 1, recordsFiltered: 1, data: [{ combination_no: "C-2026/01/1234", party_name: "A Ltd / B Ltd", form_type: "Form I", notification_date: "05/01/2026", order_status: "Approved", decision_date: "10/02/2026", summary_files: '<a href="/images/summaryfiles/s1.pdf">Summary</a>', order_files: '<a href="https://www.cci.gov.in/images/combinationorders/en/c1.pdf">Order</a><a href="https://evil.example/x.pdf">x</a>' }] };
    const parsed = parseCciCombinations(ans, "https://www.cci.gov.in/combination/orders-section31")!;
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ fileUrl: "https://www.cci.gov.in/images/combinationorders/en/c1.pdf", docDate: "2026-02-10", title: "Combination C-2026/01/1234: A Ltd / B Ltd" });
    expect(parsed.items[0].meta).toMatchObject({ track: "combination", summaryFiles: ["https://www.cci.gov.in/images/summaryfiles/s1.pdf"] });
    expect(parseCciCombinations("<html>", "https://www.cci.gov.in/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("e-Gazette", () => {
  const home = fx("egazette-home.html");

  it("parses the recent extraordinary and weekly gazettes from the home page", () => {
    const rows = parseEgazetteHome(home);
    expect(rows.map((r) => r.id)).toEqual([276731, 276730, 276729, 276728, 276675, 276544, 276543]);
    expect(rows[0]).toEqual({
      id: 276731, ugid: "CG-DL-E-02102026-276731", year: 2026, date: "2026-10-02", ministry: "Ministry of Road Transport and Highways",
      subject: "Publication of notification under Section 3D...", fileSize: "0.73 MB", gazetteType: "extraordinary", series: "CG",
    });
    expect(rows[6]).toMatchObject({ ugid: "SG-DL-W-28092026-276543", gazetteType: "weekly", series: "SG", date: "2026-09-28" });
    expect(parseUgid("CG-DL-E-02102026-276731")).toMatchObject({ id: 276731, year: 2026, date: "2026-10-02", type: "extraordinary" });
    expect(parseUgid("CG-DL-E-1-2")).toBeNull();
  });

  it("walks ids down from the newest listed gazette with ranged probes, across gaps, and ends after a run of misses", async () => {
    const published = new Set([276731, 276730, 276729, 276728, 276710]);
    const files = (url: string) => {
      const m = /WriteReadData\/(\d{4})\/(\d+)\.pdf$/.exec(url);
      if (!m) return undefined;
      return m[1] === "2026" && published.has(Number(m[2])) ? { bytes: pdfBytes() } : undefined;
    };
    const { ctx, calls } = makeCtx({ pages: (u) => (u === "https://egazette.gov.in/" ? home : undefined), files });
    const r = await egazette.discover(ctx);
    expect(r.items.map((d) => d.meta?.gazetteId)).toEqual([276731, 276730, 276729, 276728, 276710]);
    expect(r.items[0]).toMatchObject({ url: egazettePdfUrl(2026, 276731), fileUrl: egazettePdfUrl(2026, 276731), kind: "gazette", docDate: "2026-10-02", title: "Ministry of Road Transport and Highways: Publication of notification under Section 3D... (CG-DL-E-02102026-276731)" });
    expect(r.items[0].meta).toMatchObject({ urlFromPattern: true, yearInferred: false, ugid: "CG-DL-E-02102026-276731" });
    expect(r.items[4].meta).toMatchObject({ yearInferred: true, ugid: null });
    expect(calls.files[0].opts).toMatchObject({ maxBytes: 65536, headers: { Range: "bytes=0-1023" } });
    // Every probe is the documented pattern for an id in the walked range; the previous year's folder is tried once.
    for (const f of calls.files) expect(f.url).toMatch(/^https:\/\/egazette\.gov\.in\/WriteReadData\/(2026|2025)\/27\d{4}\.pdf$/);
    expect(calls.files.some((f) => f.url.includes("/2025/"))).toBe(true);
    expect(r.notes?.join(" ")).toMatch(/trying \/2025\//);
    expect(r.done).toBe(true);
    const c = parseCursor(r.nextCursor)!;
    expect(c.lastSeen.ids).toBe("276731");

    // Next pass: two new gazettes above the marker, nothing else probed.
    const home2 = home.replace("CG-DL-E-02102026-276731", "CG-DL-E-03102026-276733");
    published.add(276733).add(276732);
    const next = makeCtx({ cursor: r.nextCursor, pages: (u) => (u === "https://egazette.gov.in/" ? home2 : undefined), files });
    const r2 = await egazette.discover(next.ctx);
    expect(r2.items.map((d) => d.meta?.gazetteId)).toEqual([276733, 276732]);
    expect(next.calls.files).toHaveLength(2);
  });

  it("treats an HTML answer to a pattern URL as not published", async () => {
    const { ctx } = makeCtx({
      pages: (u) => (u === "https://egazette.gov.in/" ? home : undefined),
      files: (u) => (u.endsWith("/276731.pdf") ? { bytes: new TextEncoder().encode("<html>Error</html>") } : u.endsWith("/276730.pdf") ? { bytes: pdfBytes() } : undefined),
      limit: 1,
    });
    const r = await egazette.discover(ctx);
    expect(r.items.map((d) => d.meta?.gazetteId)).toEqual([276730]);
    expect(r.done).toBe(false);
  });

  it("a probe the server answers in full (Range ignored, body over the probe limit) means published; error statuses do not", async () => {
    const tooLarge = [
      new SafeFetchError("body_too_large", "Response declares 2104768 bytes, above the 65536-byte limit", { url: egazettePdfUrl(2026, 276731) }),
      new SafeFetchError("body_too_large", "Response is larger than the 65536-byte limit", { url: egazettePdfUrl(2026, 276730) }),
      Object.assign(new Error("official:egazette: file larger than 65536 bytes"), { status: 200 }),
    ];
    for (const err of tooLarge) expect(isTooLargeError(err)).toBe(true);
    const files = (url: string) => (url.endsWith("/276731.pdf") ? tooLarge[0] : url.endsWith("/276730.pdf") ? tooLarge[1] : url.endsWith("/276729.pdf") ? tooLarge[2] : undefined);
    const { ctx } = makeCtx({ pages: (u) => (u === "https://egazette.gov.in/" ? home : undefined), files, limit: 3 });
    const r = await egazette.discover(ctx);
    expect(r.items.map((d) => d.meta?.gazetteId)).toEqual([276731, 276730, 276729]);
    // A rate-limit or server error is not "too large": the probe fails instead of inventing a gazette.
    const limited = Object.assign(new Error("HTTP 429 rate limit exceeded"), { status: 429 });
    expect(isTooLargeError(limited)).toBe(false);
    const { ctx: c2 } = makeCtx({ pages: (u) => (u === "https://egazette.gov.in/" ? home : undefined), files: () => limited, limit: 3 });
    await expect(egazette.discover(c2)).rejects.toThrow(/429/);
  });

  const homeRoute = (u: string) => (u === "https://egazette.gov.in/" ? home : undefined);
  const incremental = (lastSeen: Record<string, string>) => JSON.stringify({ v: 1, mode: "incremental", plan: ["ids"], i: 0, page: null, skip: 0, misses: 0, walked: 0, lastSeen, newest: {}, only: null });
  const gazetteFiles = (published: (id: number) => boolean, broken: (id: number) => Error | null = () => null) => (url: string) => {
    const m = /WriteReadData\/(\d{4})\/(\d+)\.pdf$/.exec(url);
    if (!m) return undefined;
    const err = broken(Number(m[2]));
    if (err) return err;
    return m[1] === "2026" && published(Number(m[2])) ? { bytes: pdfBytes() } : undefined;
  };

  it("walks every id down to the previous pass's marker across a gap longer than the miss limit (never skips ids)", async () => {
    // Review finding: an incremental walk that ended on a run of misses still moved the marker to the top id, so every
    // id between the stop and the old marker was lost for good.
    const published = (id: number) => (id >= 276700 && id <= 276731) || (id >= 276501 && id <= 276659);
    const { ctx, calls } = makeCtx({ pages: homeRoute, files: gazetteFiles(published), cursor: incremental({ ids: "276500", floor: "276432", floorYear: "2026" }), limit: 500 });
    const r = await egazette.discover(ctx);
    expect(r.done).toBe(true);
    const ids = r.items.map((d) => d.meta?.gazetteId as number);
    expect(ids).toHaveLength(32 + 159);
    expect(ids).toContain(276659);
    expect(ids).toContain(276501);
    expect(r.notes?.join(" ")).toMatch(/ids 276699\.\.276675 were not published in \/2026\/ or \/2025\/; the walk continues down to 276501/);
    const probedIds = new Set(calls.files.map((f) => Number(/(\d+)\.pdf$/.exec(f.url)![1])));
    for (let id = 276501; id <= 276731; id++) expect(probedIds.has(id)).toBe(true);
    expect(probedIds.has(276500)).toBe(false);
    expect(parseCursor(r.nextCursor)!.lastSeen).toMatchObject({ ids: "276731", floor: "276432" });
  });

  it("moves the marker only to the highest id found published, never to a listed id whose file is not up yet", async () => {
    let published = (id: number): boolean => id === 276730;
    const r1 = await egazette.discover(makeCtx({ pages: homeRoute, files: (u) => gazetteFiles(published)(u), cursor: incremental({ ids: "276729" }) }).ctx);
    expect(r1.items.map((d) => d.meta?.gazetteId)).toEqual([276730]);
    expect(parseCursor(r1.nextCursor)!.lastSeen.ids).toBe("276730");
    published = (id: number) => id === 276730 || id === 276731;
    const r2 = await egazette.discover(makeCtx({ pages: homeRoute, files: (u) => gazetteFiles(published)(u), cursor: r1.nextCursor }).ctx);
    expect(r2.items.map((d) => d.meta?.gazetteId)).toEqual([276731]);
  });

  it("bounds an incremental walk to MAX_SPAN ids above the marker when the home page lists an id far above it", async () => {
    const { ctx, calls } = makeCtx({ pages: homeRoute, files: gazetteFiles((id) => id === 275731), cursor: incremental({ ids: "270731" }), limit: 1 });
    const r = await egazette.discover(ctx);
    expect(calls.files[0].url).toBe(egazettePdfUrl(2026, 275731));
    expect(r.items.map((d) => d.meta?.gazetteId)).toEqual([275731]);
    expect(r.notes?.join(" ")).toMatch(/lists gazette 276731, more than 5000 ids above the previous pass's newest \(270731\)/);
  });

  it("steps over one gazette whose probe keeps failing, retries it on later passes and never counts it as published", async () => {
    // Review finding: a persistent non-404 error on one id parked the cursor there and failed every later pass.
    let down = true;
    const broken = (id: number) => (id === 276729 && down ? Object.assign(new Error(`HTTP 500 for ${id}`), { status: 500 }) : null);
    const files = gazetteFiles((id) => id >= 276726, broken);
    const r1 = await egazette.discover(makeCtx({ pages: homeRoute, files, cursor: incremental({ ids: "276725" }) }).ctx);
    expect(r1.done).toBe(true);
    expect(r1.items.map((d) => d.meta?.gazetteId)).toEqual([276731, 276730, 276728, 276727, 276726]);
    expect(r1.notes?.join(" ")).toMatch(/gazette 276729: probe failed while lower ids answered; skipped for now and recorded for retry/);
    const c1 = parseCursor(r1.nextCursor)!;
    expect(c1.lastSeen.ids).toBe("276731");
    expect(c1.lastSeen["#retry:ids"]).toBe("276729@2026:0");
    // Still failing: counted, kept.
    const r2 = await egazette.discover(makeCtx({ pages: homeRoute, files, cursor: r1.nextCursor }).ctx);
    expect(r2.items).toEqual([]);
    expect(parseCursor(r2.nextCursor)!.lastSeen["#retry:ids"]).toBe("276729@2026:1");
    // Answers again: ingested with its listing metadata, and the retry list is empty.
    down = false;
    const r3 = await egazette.discover(makeCtx({ pages: homeRoute, files, cursor: r2.nextCursor }).ctx);
    expect(r3.items.map((d) => d.meta?.gazetteId)).toEqual([276729]);
    expect(r3.items[0].meta).toMatchObject({ ugid: "CG-DL-E-02102026-276729", urlFromPattern: true });
    expect(parseCursor(r3.nextCursor)!.lastSeen["#retry:ids"]).toBeUndefined();
  });

  it("stops at the first of FAIL_RUN consecutive failing ids when the id above them fails too (the host is failing)", async () => {
    // An outage: from the first failure on, every request fails (also the check of the id above the run).
    let down = false;
    const outage = (id: number) => {
      if (id <= 276729) down = true;
      return down ? Object.assign(new Error("HTTP 503"), { status: 503 }) : null;
    };
    const r = await egazette.discover(makeCtx({ pages: homeRoute, files: gazetteFiles(() => true, outage), cursor: incremental({ ids: "276720" }) }).ctx);
    expect(r.done).toBe(false);
    expect(r.items.map((d) => d.meta?.gazetteId)).toEqual([276731, 276730]);
    expect(r.notes?.join(" ")).toMatch(/3 consecutive ids failed and so did gazette 276730 \(the host is failing\); the walk resumes at 276729/);
    const c = parseCursor(r.nextCursor)!;
    expect(c.page).toBe(276729);
    expect(c.lastSeen["#retry:ids"]).toBeUndefined();
    // Nothing answers at all: the call fails (the stored cursor is kept by the runner).
    await expect(egazette.discover(makeCtx({ pages: homeRoute, files: gazetteFiles(() => true, outage), cursor: r.nextCursor }).ctx)).rejects.toThrow(/503/);
  });

  it("steps over a run of failing ids while the host still answers, even when the walk starts at the run", async () => {
    const broken = (id: number) => (id >= 276727 && id <= 276729 ? Object.assign(new Error("HTTP 403 Forbidden"), { status: 403 }) : null);
    // The stored cursor is parked at the first failing id (as an older call left it): the walk must still get past.
    const parked = JSON.stringify({ v: 1, mode: "incremental", plan: ["ids"], i: 0, page: 276729, skip: 0, misses: 0, walked: 2, lastSeen: { ids: "276720" }, newest: { ids: "276731", _year: "2026" }, only: null });
    const r = await egazette.discover(makeCtx({ pages: homeRoute, files: gazetteFiles((id) => id > 276720, broken), cursor: parked }).ctx);
    expect(r.done).toBe(true);
    expect(r.items.map((d) => d.meta?.gazetteId)).toEqual([276726, 276725, 276724, 276723, 276722, 276721]);
    expect(r.notes?.join(" ")).toMatch(/gazette 276729\.\.276727: probes failed while the host answered for gazette 276730; skipped for now and recorded for retry/);
    expect(parseCursor(r.nextCursor)!.lastSeen).toMatchObject({ ids: "276731", "#retry:ids": "276729@2026:0,276728@2026:0,276727@2026:0" });
  });

  it("extracts page-1 metadata from the English half of a gazette (live PDF text)", () => {
    const md = fx("egazette-276728.md");
    const r = parseGazetteText(parseInput(md, { pages: [] }));
    expect(r.unparsed).toBe(0);
    expect(r.records[0].meta).toEqual({
      ugid: "CG-DL-E-02102026-276728", gazetteId: 276728, gazetteType: "extraordinary", series: "CG",
      part: "Part II, Section 3, Sub-section (ii)", gazetteNo: "5064", publicationDate: "2026-09-24",
      ministries: ["MINISTRY OF ROAD TRANSPORT AND HIGHWAYS"], notificationNumbers: ["S.O. 5271(E)"], notificationDate: "2026-09-24",
      fileNumbers: ["NHAI/PIU/MOTIHARI/BHARATMALA/139W/Areraj-Bettiah/3D"],
    });
    expect(parseGazetteText(parseInput("no gazette here")).unparsed).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("GST Council meetings (live fixture)", () => {
  it("turns each agenda and minutes link into a document with meeting metadata", () => {
    const items = parseGstCouncilMeetings(fx("gst-council-meetings.html"));
    expect(items).toHaveLength(8);
    expect(items[0]).toMatchObject({
      kind: "minutes", docDate: "2024-12-21",
      fileUrl: "https://gstcouncil.gov.in/sites/default/files/Minutes/minutes_of_55th_gst_council_for_upload_ocred_compressed_0.pdf",
      title: "55th GST Council Meeting (21-Dec-2024, Jaisalmer): Minutes",
    });
    expect(items[0].meta).toMatchObject({ meetingNo: 55, venue: "Jaisalmer", document: "minutes", fileSize: "27.04 MB" });
    expect(items[1].meta).toMatchObject({ meetingNo: 55, document: "agenda", fileSize: "22.1 MB" });
    const first = items.filter((d) => d.meta?.meetingNo === 1);
    expect(first[0].meta).toMatchObject({ date: "2016-09-22", dateTo: "2016-09-23", datePrinted: "22-Sep-2016 - 23-Sep-2016" });
    expect(meetingNumber("02nd GST Council Meeting")).toBe(2);
    expect(meetingNumber("Special meeting")).toBeNull();
    expect(meetingDates("21-Dec-2024")).toEqual({ from: "2024-12-21", to: "2024-12-21" });
  });

  it("lists the whole table on every pass, so minutes added to an older meeting are found", async () => {
    // Review finding: the table is ordered by meeting, so a file added to an older row sorted below the stop marker.
    const html = fx("gst-council-meetings.html");
    let page = html;
    const pages = (u: string) => (u === "https://gstcouncil.gov.in/gst-council-meeting" ? page : undefined);
    const r1 = await gst.discover(makeCtx({ pages }).ctx);
    expect(r1.items).toHaveLength(8);
    const r2 = await gst.discover(makeCtx({ pages, cursor: r1.nextCursor }).ctx);
    expect(r2.done).toBe(true);
    // The same URLs again (the pipeline's upsert skips those it holds).
    expect(r2.items.map((d) => d.url)).toEqual(r1.items.map((d) => d.url));
    // A supplementary agenda added to the 2nd meeting's row (far below the newest file).
    const agenda2 = '<a href="https://gstcouncil.gov.in/sites/default/files/Agenda/2.pdf">';
    page = html.replace(agenda2, `<a href="https://gstcouncil.gov.in/sites/default/files/Agenda/2-supplementary.pdf">View</a> ${agenda2}`);
    expect(page).not.toBe(html);
    const r3 = await gst.discover(makeCtx({ pages, cursor: r2.nextCursor }).ctx);
    const late = r3.items.find((d) => d.url === "https://gstcouncil.gov.in/sites/default/files/Agenda/2-supplementary.pdf");
    expect(late?.meta).toMatchObject({ meetingNo: 2, document: "agenda" });
  });
});
