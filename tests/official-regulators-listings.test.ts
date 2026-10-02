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
    expect(parseSebiOrderText(parseInput(text)).records).toEqual([{ meta: { orderNumbers: ["Order/AK/GN/2026-27/32758"], appealNumbers: [], caseKeys: [] } }]);
    const sat = parseSebiOrderText(parseInput("BEFORE THE SECURITIES APPELLATE TRIBUNAL MUMBAI ... Appeal No. 123 of 2025 ... Misc. Application No. 4 of 2025"));
    expect(sat.records[0].meta).toMatchObject({ appealNumbers: ["Appeal No. 123 of 2025"], caseKeys: ["APPEAL/123/2025"] });
    expect(parseSebiOrderText(parseInput("nothing here")).unparsed).toBe(1);
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
    const { ctx, calls } = makeCtx({ pages, json: () => new Error("Unexpected token < in JSON") });
    const r = await cci.discover(ctx);
    expect(r.items.map((d) => d.meta?.detailId)).toEqual([1250, 1251, 1253]);
    expect(r.items[0]).toMatchObject({ url: cciDetailUrl(1250), fileUrl: null, mime: "text/html", docDate: "2025-04-16" });
    expect(r.items[0].meta).toMatchObject({ caseKeys: ["CASE/11/2020"], pdfLinkFound: false, track: "antitrust" });
    expect(calls.pages).toHaveLength(14); // 1250..1263: 3 found + 10 consecutive misses after 1253 + one gap
    expect(r.notes?.join(" ")).toMatch(/combination listing did not answer with JSON/);
    expect(parseCursor(r.nextCursor)!.lastSeen.antitrust).toBe("1253");
    const again = makeCtx({ cursor: r.nextCursor, pages, json: () => ({ data: [] }) });
    await cci.discover(again.ctx);
    expect(again.calls.pages[0].url).toBe(cciDetailUrl(1254));
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

  it("returns nothing new on the second pass", async () => {
    const pages = (u: string) => (u === "https://gstcouncil.gov.in/gst-council-meeting" ? fx("gst-council-meetings.html") : undefined);
    const r1 = await gst.discover(makeCtx({ pages }).ctx);
    expect(r1.items).toHaveLength(8);
    const r2 = await gst.discover(makeCtx({ pages, cursor: r1.nextCursor }).ctx);
    expect(r2.items).toEqual([]);
    expect(r2.done).toBe(true);
  });
});
