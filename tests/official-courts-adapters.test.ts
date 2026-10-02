import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterContext, FetchedPage, ParseInput } from "@/modules/official/adapter";
import type { CauseListEntry, DiscoveredDoc } from "@/modules/official/types";
import { SOURCE_IDS } from "@/modules/official/types";
import { COURT_ADAPTERS } from "@/modules/official/adapters/courts";
import { sciCauseListLinks, SCI_CAUSELIST_PAGE } from "@/modules/official/adapters/courts/sci-causelist";
import { neutralCitationOf, sciOrderItems, SCI_HOME, SCI_LATEST_ORDERS } from "@/modules/official/adapters/courts/sci-orders";
import { SCI_CALENDAR_PAGE, sciHolidayJsonUrl } from "@/modules/official/adapters/courts/sci-calendar";
import { DELHI_CALENDAR_LIST, KARNATAKA_CALENDAR_PAGE, karnatakaCalendarItems } from "@/modules/official/adapters/courts/hc-calendars";
import { classifyDhcTitle, DHC_CAUSELIST_INDEX, dhcListingItems, takenUpOn } from "@/modules/official/adapters/courts/dhc-causelist";
import { ncltForumOf, ncltListingItems, ncltListUrl } from "@/modules/official/adapters/courts/nclt";
import { nclatAppealNumbers, nclatListingItems, nclatListUrl, nclatOrderItems } from "@/modules/official/adapters/courts/nclat";
import { NCLAT_COURTS, NCLT_BENCHES } from "@/modules/official/causelist/forums";

/** Listing fixtures are verbatim excerpts of the live pages captured 2026-10-02 (Firecrawl, location IN). */
const FIX = path.resolve(__dirname, "fixtures/official/courts");
const read = (f: string) => readFileSync(path.join(FIX, f), "utf8");

type PageMap = Record<string, string | Error>;

function fakeCtx(pages: PageMap, over: Partial<AdapterContext> = {}): AdapterContext & { fetched: string[] } {
  const fetched: string[] = [];
  const ctx = {
    limit: 100,
    deadline: Date.now() + 60_000,
    cursor: null,
    today: "2026-10-02",
    fetched,
    async fetchPage(url: string): Promise<FetchedPage> {
      fetched.push(url);
      const v = pages[url];
      if (v === undefined) throw new Error(`HTTP 404 ${url}`);
      if (v instanceof Error) throw v;
      return { url, finalUrl: url, status: 200, html: v, markdown: null, links: [], provenance: { via: "direct", status: 200, finalUrl: url } };
    },
    async fetchFile(): Promise<never> {
      throw new Error("not used");
    },
    async fetchJson<T>(): Promise<T> {
      throw new Error("not used");
    },
    async postForm(): Promise<never> {
      throw new Error("not used");
    },
    log() {},
    ...over,
  };
  return ctx as AdapterContext & { fetched: string[] };
}

function parseInput(over: Partial<ParseInput>): ParseInput {
  return { id: "doc_1", url: "https://example.invalid/x.pdf", title: "t", docDate: null, meta: {}, markdown: "", pages: [], fetchedAt: "2026-10-02T10:00:00.000Z", ...over };
}

describe("registry and source definitions", () => {
  it("registers the eight court and tribunal sources with complete definitions", () => {
    expect(Object.keys(COURT_ADAPTERS).sort()).toEqual(["dhc-causelist", "hc-calendars", "nclat", "nclt", "ngt-orders", "sci-calendar", "sci-causelist", "sci-orders"]);
    for (const [id, a] of Object.entries(COURT_ADAPTERS)) {
      const d = a!.def;
      expect(d.id).toBe(id);
      expect(SOURCE_IDS).toContain(d.id);
      expect(d.name && d.publisher && d.homepage.startsWith("https://") && d.attribution && d.terms).toBeTruthy();
      expect(d.kinds.length).toBeGreaterThan(0);
      expect(["direct", "firecrawl_in", "dataset_push"]).toContain(d.fetch);
      expect(d.cadenceMinutes).toBeGreaterThanOrEqual(60);
      expect(typeof d.enabled).toBe("boolean");
      if (!d.enabled) expect(d.notes?.length).toBeGreaterThan(0);
    }
    expect(COURT_ADAPTERS["ngt-orders"]!.def.enabled).toBe(false);
    expect(COURT_ADAPTERS["ngt-orders"]!.def.notes!.join(" ")).toMatch(/CAPTCHA/);
  });

  it("ngt-orders discovers nothing (CAPTCHA-gated listings are never automated)", async () => {
    const ctx = fakeCtx({});
    const r = await COURT_ADAPTERS["ngt-orders"]!.discover(ctx);
    expect(r).toMatchObject({ items: [], done: true, nextCursor: null });
    expect(ctx.fetched).toEqual([]);
  });
});

describe("sci-causelist", () => {
  it("reads the 'at a glance' links inside the window with list type, category and mirror", () => {
    const items = sciCauseListLinks(read("sci-causelist-glance.html"), "2026-10-02");
    expect(items).toHaveLength(27);
    const main = items.find((d) => d.url === "https://api.sci.gov.in/jonew/cl/2026-10-05/M_J_1.pdf")!;
    expect(main).toMatchObject({ kind: "cause_list", docDate: "2026-10-05", meta: { forum: "sci", listType: "main", category: "M_J_1", listDate: "2026-10-05", mirrorUrl: "https://webapi.sci.gov.in/jonew/cl/2026-10-05/M_J_1.pdf" } });
    expect(items.find((d) => d.url.endsWith("2026-10-01/M_C_2.pdf"))?.meta).toMatchObject({ listType: "supplementary" });
    expect(items.find((d) => d.url.endsWith("advance/2026-10-07/M_J.pdf"))?.meta).toMatchObject({ listType: "advance", listDate: "2026-10-07" });
    expect(items.find((d) => d.url.endsWith("weekly.pdf"))?.meta).toMatchObject({ listType: "weekly", weekFrom: "2026-10-06", weekTo: "2026-10-08", large: true });
    expect(items.every((d) => !d.meta?.urlFromPattern)).toBe(true);
    // Mirror links (webapi) dedupe onto the same documents.
    expect(sciCauseListLinks(read("sci-causelist-glance.html") + read("sci-causelist-index.html"), "2026-10-02")).toHaveLength(27);
    // Window: lists before today - 2 are not discovered.
    expect(sciCauseListLinks(read("sci-causelist-glance.html"), "2026-10-09").every((d) => d.docDate! >= "2026-10-07" || d.meta?.listType === "weekly")).toBe(true);
  });

  it("pages through the items with a cursor and falls back to documented names only when the page fails", async () => {
    const pages = { [SCI_CAUSELIST_PAGE]: read("sci-causelist-glance.html") };
    const a = COURT_ADAPTERS["sci-causelist"]!;
    const first = await a.discover(fakeCtx(pages, { limit: 20 }));
    expect(first.items).toHaveLength(20);
    expect(first.done).toBe(false);
    const second = await a.discover(fakeCtx(pages, { limit: 20, cursor: first.nextCursor }));
    expect(second.items).toHaveLength(7);
    expect(second.done).toBe(true);
    expect(new Set([...first.items, ...second.items].map((d) => d.url)).size).toBe(27);

    const failed = await a.discover(fakeCtx({ [SCI_CAUSELIST_PAGE]: new Error("timeout") }));
    expect(failed.items.length).toBeGreaterThan(0);
    expect(failed.items.every((d) => d.meta?.urlFromPattern === true)).toBe(true);
    expect(failed.items.map((d) => d.docDate)).not.toContain("2026-10-03"); // Saturday
    expect(failed.notes?.[0]).toMatch(/unavailable/);
  });

  it("parses advance lists as tables and refuses daily lists without positional text", () => {
    const a = COURT_ADAPTERS["sci-causelist"]!;
    const md = read("sci-advance-07.10.2026.md");
    const adv = a.parse!(parseInput({ meta: { forum: "sci", listType: "advance", listDate: "2026-10-07" }, markdown: md, pages: [{ page: 1, text: md }] }));
    expect((adv.records as CauseListEntry[]).map((e) => e.itemNo)).toEqual(["1", "2"]);
    const daily = a.parse!(parseInput({ meta: { forum: "sci", listType: "main", listDate: "2026-10-05" }, markdown: "54 SLP(Crl) No.", pages: [{ page: 1, text: "54 SLP(Crl) No." }] }));
    expect(daily.records).toEqual([]);
    const noDate = a.parse!(parseInput({ meta: { listType: "advance" }, markdown: md }));
    expect(noDate.records).toEqual([]);
  });
});

describe("sci-orders", () => {
  it("reads homepage judgments and orders; link parameters must agree with the printed entry", () => {
    const { items, skipped } = sciOrderItems(read("sci-home-latest.html"), "homepage");
    expect(skipped).toBe(0);
    expect(items).toHaveLength(10);
    const j = items[0];
    expect(j).toMatchObject({
      sourceId: "sci-orders",
      kind: "judgment",
      url: "https://www.sci.gov.in/view-pdf/?diary_no=42402015&type=j&order_date=2026-10-01&from=latest_judgements_order",
      fileUrl: "https://www.sci.gov.in/sci-get-pdf/?diary_no=42402015&type=j&order_date=2026-10-01&from=latest_judgements_order",
      docDate: "2026-10-01",
      meta: {
        forum: "sci",
        diaryNo: "4240/2015",
        caseNumbers: ["Crl.A. No. 166/2019"],
        caseKeys: ["CRLA/166/2019"],
        parties: "THE STATE OF HIMACHAL PRADESH VS. ANCHLA @ CHANCHLA",
        orderType: "j",
        uploadedAt: "2026-10-01T17:22:12+05:30",
        fileUrlFromPattern: true,
      },
    });
    expect(items.filter((d) => d.kind === "order")).toHaveLength(4);
  });

  it("handles empty case numbers, compound numbers, ranges and the 'fo' order type", () => {
    const { items } = sciOrderItems(read("sci-latest-orders.html"), "latest-orders");
    const fo = items.find((d) => d.meta?.orderType === "fo")!;
    expect(fo).toMatchObject({ kind: "order", meta: { diaryNo: "45813/2026", caseKeys: ["CA/13294/2026"], parties: "M/S. ANNAPURNA PROPERTIES VS. M/S. STATE TRADING CORPORATION OF INDIA LTD.," } });
    const empty = items.find((d) => d.meta?.diaryNo === "57470/2024")!;
    expect(empty.meta).toMatchObject({ caseNumbers: [], caseKeys: [], parties: "SANJAY SONI VS. BAJAJ ALLIANZ GENERAL INSURANCE COMPANY LIMITED" });
    const compound = items.find((d) => d.meta?.diaryNo === "61027/2026")!;
    expect(compound.meta?.caseKeys).toEqual(["MA/2911/2026", "SLPC/16609/2026"]);
    const range = items.find((d) => (d.meta?.caseNumbers as string[]).some((c) => /\d-\d/.test(c)))!;
    expect((range.meta?.caseKeys as string[]).length).toBeGreaterThan(1);
  });

  it("skips an entry whose link does not carry the printed diary number or date (never re-keyed)", () => {
    const html = `<li><a href="https://www.sci.gov.in/view-pdf/?diary_no=99992015&amp;type=j&amp;order_date=2026-10-01&amp;from=latest_judgements_order">A VS. B - Crl.A. No. 1/2019 - Diary Number 4240 / 2015 - <span>01-Oct-2026</span><div> (Uploaded On 01-10-2026 17:22:12)</div></a></li>
      <li><a href="https://www.sci.gov.in/view-pdf/?diary_no=42402015&amp;type=j&amp;order_date=2026-09-30&amp;from=latest_judgements_order">A VS. B - Crl.A. No. 1/2019 - Diary Number 4240 / 2015 - <span>01-Oct-2026</span><div> (Uploaded On 01-10-2026 17:22:12)</div></a></li>`;
    expect(sciOrderItems(html, "homepage")).toEqual({ items: [], skipped: 2 });
  });

  it("discovers from both pages, deduplicates and orders newest upload first", async () => {
    const ctx = fakeCtx({ [SCI_HOME]: read("sci-home-latest.html"), [SCI_LATEST_ORDERS]: read("sci-latest-orders.html") });
    const r = await COURT_ADAPTERS["sci-orders"]!.discover(ctx);
    const urls = r.items.map((d) => d.url);
    expect(new Set(urls).size).toBe(urls.length);
    const ups = r.items.map((d) => String(d.meta?.uploadedAt));
    expect([...ups].sort().reverse()).toEqual(ups);
  });

  it("reads the neutral citation from page 1 only", () => {
    expect(neutralCitationOf({ markdown: "", pages: [{ page: 1, text: "2026 INSC 1074\nIN THE SUPREME COURT OF INDIA\nCRIMINAL APPELLATE JURISDICTION" }] })).toBe("2026 INSC 1074");
    expect(neutralCitationOf({ markdown: "", pages: [{ page: 1, text: "REPORTABLE\n2026 INSC 0995\nIN THE SUPREME COURT" }] })).toBe("2026 INSC 995");
    expect(neutralCitationOf({ markdown: "", pages: [{ page: 1, text: "IN THE SUPREME COURT ... relying on 2024 INSC 735 (para 9)" }] })).toBeNull();
    const parsed = COURT_ADAPTERS["sci-orders"]!.parse!(parseInput({ pages: [{ page: 1, text: "2026 INSC 1074 IN THE SUPREME COURT" }] }));
    expect(parsed.records).toEqual([{ neutralCitation: "2026 INSC 1074" }]);
  });
});

describe("sci-calendar and hc-calendars", () => {
  it("sci-calendar lists the page, its holiday data and the year PDFs found by anchor text", async () => {
    const r = await COURT_ADAPTERS["sci-calendar"]!.discover(fakeCtx({ [SCI_CALENDAR_PAGE]: read("sci-calendar-page.html") }));
    expect(r.items.map((d) => [d.url, d.meta?.format, d.meta?.year ?? null])).toEqual([
      [SCI_CALENDAR_PAGE, "html_table", null],
      [sciHolidayJsonUrl(2026), "json", 2026],
      ["https://cdn.s3waas.gov.in/s3ec0490f1f4972d133619a60c30f3559e/uploads/2026/01/2026010620.pdf", "pdf", 2026],
      ["https://cdnbbsr.s3waas.gov.in/s3ec0490f1f4972d133619a60c30f3559e/uploads/2026/09/2026090138.pdf", "pdf", 2027],
    ]);
    const parsed = COURT_ADAPTERS["sci-calendar"]!.parse!(parseInput({ url: sciHolidayJsonUrl(2026), meta: { forum: "sci", format: "json", year: 2026 }, markdown: read("sci-calendar-ajax.json") }));
    expect(parsed.records).toHaveLength(28);
    const pdf = COURT_ADAPTERS["sci-calendar"]!.parse!(parseInput({ meta: { forum: "sci", format: "pdf", year: 2027 }, markdown: read("sci-calendar-2027.md") }));
    expect(pdf.records).toHaveLength(21); // 20 table rows + partial court working days note
  });

  it("hc-calendars lists Delhi PDFs from the table and Karnataka PDFs from the year selector", async () => {
    const karnatakaHtml = `<select id="Calendar"><option value="pdfs/Calender-2026.pdf">2026</option><option value="pdfs/Calender-2025.pdf">2025</option><option value="pdfs/Calender-2017.pdf">2017</option></select>`;
    const r = await COURT_ADAPTERS["hc-calendars"]!.discover(fakeCtx({ [DELHI_CALENDAR_LIST]: read("dhc-calendar-list.html"), [KARNATAKA_CALENDAR_PAGE]: karnatakaHtml }));
    expect(r.items.map((d) => [d.url, d.meta?.forum, d.meta?.year])).toEqual([
      ["https://delhihighcourt.nic.in/files/2025-12/calender/calendar_2026.pdf", "hc-delhi", 2026],
      ["https://delhihighcourt.nic.in/files/2025-04/calender/calendar_2025.pdf", "hc-delhi", 2025],
      ["https://judiciary.karnataka.gov.in/pdfs/Calender-2026.pdf", "hc-karnataka", 2026],
      ["https://judiciary.karnataka.gov.in/pdfs/Calender-2025.pdf", "hc-karnataka", 2025],
    ]);
    expect(r.items.every((d) => !d.meta?.urlFromPattern)).toBe(true);
    expect(karnatakaCalendarItems(karnatakaHtml, 2026)).toHaveLength(1);
  });

  it("hc-calendars uses the documented Karnataka file name only when its page fails, and says so", async () => {
    const r = await COURT_ADAPTERS["hc-calendars"]!.discover(fakeCtx({ [DELHI_CALENDAR_LIST]: read("dhc-calendar-list.html"), [KARNATAKA_CALENDAR_PAGE]: new Error("ECONNRESET") }));
    const k = r.items.filter((d) => d.meta?.forum === "hc-karnataka");
    expect(k).toEqual([expect.objectContaining({ url: "https://judiciary.karnataka.gov.in/pdfs/Calender-2026.pdf", meta: expect.objectContaining({ urlFromPattern: true }) })]);
    expect(r.notes?.join(" ")).toMatch(/Karnataka calendar page unavailable/);
  });

  it("parses the Delhi calendar (OCR text) with the table year and notes", () => {
    const p = COURT_ADAPTERS["hc-calendars"]!.parse!(parseInput({ meta: { forum: "hc-delhi", format: "pdf", year: 2026 }, markdown: read("dhc-calendar-2026.md") }));
    expect(p.records.length).toBe(24 + 2 + 12 + 10);
  });
});

describe("dhc-causelist", () => {
  it("classifies lists by printed title and dates moved lists by the 'taken up on' date", () => {
    expect(classifyDhcTitle("Supplementary Cause List-16 of Sitting of Benches for 01.10.2026")).toEqual({ listType: "supplementary", listKind: "supplementary" });
    expect(classifyDhcTitle("Supplementary Pronouncement-2 of Judgement on 01.10.2026").listKind).toBe("pronouncement");
    expect(classifyDhcTitle("ADVANCE CAUSE LIST OF CASES OF ORIGINAL SIDE FOR 07.10.2026 FOR REFERRAL TO MEDIATION")).toEqual({ listType: "advance", listKind: "mediation_referral" });
    expect(classifyDhcTitle("DELETION NOTE").listKind).toBe("deletion_note");
    expect(takenUpOn("Cause List (Appellate Side) of Sitting of Benches for the cases fixed for Saturday, the 3rd October, 2026 shall be taken up on Monday, the 5th October, 2026")).toBe("2026-10-05");
  });

  it("reads the index table inside the window", () => {
    const { items, oldest } = dhcListingItems(read("dhc-causelist-index.html"), "2026-09-30");
    expect(items.length).toBeGreaterThanOrEqual(7);
    expect(oldest).not.toBeNull();
    const moved = items.find((d) => d.url.endsWith("cause_list_03.10.2026.pdf"))!;
    expect(moved).toMatchObject({ docDate: "2026-10-03", meta: { forum: "hc-delhi", listType: "main", listDate: "2026-10-05", listedFor: "2026-10-03", takenUpOn: "2026-10-05" } });
    expect(items.find((d) => d.url.endsWith("sup_saurbh_b_01.10.2026.pdf"))?.meta).toMatchObject({ listType: "supplementary", listDate: "2026-10-01" });
    expect(items.every((d) => d.kind === "cause_list" && d.mime === "application/pdf")).toBe(true);
  });

  it("pages while listings are inside the window and stops at older listings or a missing page", async () => {
    const pages = { [DHC_CAUSELIST_INDEX]: read("dhc-causelist-index.html") };
    const older = fakeCtx(pages, { today: "2026-10-05" }); // window starts 2026-10-03: page 0 already reaches older lists
    const r1 = await COURT_ADAPTERS["dhc-causelist"]!.discover(older);
    expect(r1.done).toBe(true);
    expect(older.fetched).toEqual([DHC_CAUSELIST_INDEX]);
    expect(r1.items.every((d) => d.docDate! >= "2026-10-03")).toBe(true);
    const inWindow = fakeCtx(pages); // every row on page 0 is inside the window: page 1 is read (404 here) and paging stops
    const r2 = await COURT_ADAPTERS["dhc-causelist"]!.discover(inWindow);
    expect(inWindow.fetched).toEqual([DHC_CAUSELIST_INDEX, `${DHC_CAUSELIST_INDEX}?page=1`]);
    expect(r2.items.length).toBeGreaterThan(0);
    expect(r2.notes?.join(" ")).toMatch(/404/);
  });

  it("parses lists into entries and never parses deletion notes", () => {
    const a = COURT_ADAPTERS["dhc-causelist"]!;
    const md = read("dhc-causelist-03.10.2026.md");
    const p = a.parse!(parseInput({ meta: { forum: "hc-delhi", listType: "main", listDate: "2026-10-05" }, markdown: md, pages: [{ page: 1, text: md }] }));
    expect(p.records).toHaveLength(5);
    expect(a.parse!(parseInput({ meta: { listKind: "deletion_note", listDate: "2026-10-05" }, markdown: md })).records).toEqual([]);
  });
});

describe("nclt and nclat", () => {
  it("builds the bench query with NCLT's MM/DD/YYYY filters", () => {
    expect(ncltListUrl(105, "2026-10-01", "2026-10-12")).toBe("https://nclt.gov.in/all-cause-list?field_nclt_benches_list_target_id=105&field_cause_date_value=10/01/2026&field_cause_date_value_1=10/12/2026");
    expect(nclatListUrl(44, "2026-10-01", "2026-10-09")).toBe("https://nclat.nic.in/daily-cause-list?title=&field_court_name_target_id=44&field_final_date_value=2026-10-01&field_final_date_value_1=2026-10-09");
  });

  it("reads NCLT listing rows with bench, list date and the publisher's entry count", () => {
    const bench = NCLT_BENCHES.find((b) => b.id === 100)!;
    const items = ncltListingItems(read("nclt-all-cause-list.html"), bench);
    expect(items.map((d) => [d.url, d.docDate, d.meta?.forum, d.meta?.entriesCount, d.meta?.bench])).toEqual([
      ["https://nclt.gov.in/sites/default/files/pdf_cause_list/Cause%20List%20-%20Indore%20Bench%20-%2005%20Oct%202026.pdf", "2026-10-05", "nclt-indore", 36, "Indore Bench Court-I"],
      ["https://nclt.gov.in/sites/default/files/pdf_cause_list/Cause%20List%20-%20Indore%20Bench%20-%2001%20Oct%202026_0.pdf", "2026-10-01", "nclt-indore", 34, "Indore Bench Court-I"],
    ]);
    expect(ncltForumOf("Cause List - New Delhi Bench - Court No III - 05 Oct 2026")).toBe("nclt-new-delhi");
    expect(ncltForumOf("Registrar")).toBe("nclt");
  });

  it("walks every NCLT bench under the call limit and resumes from the cursor", async () => {
    const html = read("nclt-all-cause-list.html");
    const pages: PageMap = {};
    for (const b of NCLT_BENCHES) pages[ncltListUrl(b.id, "2026-10-01", "2026-10-12")] = b.id === 100 ? html : "<table></table>";
    pages["https://nclt.gov.in/list-of-objection-list"] = "<table></table>";
    pages["https://nclt.gov.in/nclt-calender"] = `<a href="/sites/default/files/Ncltcalender/Calendar%202026.pdf">Calendar 2026</a>`;
    const a = COURT_ADAPTERS.nclt!;
    const first = await a.discover(fakeCtx(pages, { limit: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.done).toBe(false);
    const second = await a.discover(fakeCtx(pages, { limit: 5, cursor: first.nextCursor }));
    expect(second.items.map((d) => d.kind)).toEqual(["cause_list", "calendar"]);
    expect(second.items[1]).toMatchObject({ url: "https://nclt.gov.in/sites/default/files/Ncltcalender/Calendar%202026.pdf", meta: { forum: "nclt", year: 2026 } });
    expect(second.done).toBe(true);
  });

  it("reads NCLAT listing rows and homepage judgment / daily-order links", () => {
    const court = NCLAT_COURTS.find((c) => c.id === 44)!;
    const items = nclatListingItems(read("nclat-daily-cause-list.html"), court);
    expect(items[0]).toMatchObject({ url: "https://nclat.nic.in/sites/default/files/2026-10/Causelist_II_07.10.2026.pdf", docDate: "2026-10-07", meta: { forum: "nclat-delhi", court: "II", listType: "main", listDate: "2026-10-07" } });
    const orders = nclatOrderItems(read("nclat-home-orders.html"), null);
    expect(orders).toHaveLength(20);
    expect(orders.filter((d) => d.kind === "judgment")).toHaveLength(10);
    expect(orders.filter((d) => d.meta?.forum === "nclat-chennai")).toHaveLength(10);
    expect(orders[0]).toMatchObject({ url: "https://nclat.nic.in/display-board/view_order_pdf?fid=9910105089552026&&l=delhi&&d=2026-09-30&&order_type=J", docDate: "2026-09-30", meta: { fid: "9910105089552026", orderType: "J", parties: "ET INFRA DEVELOPERS PVT. LTD. VS ELECTROTHERM (INDIA) LIMITED" } });
  });

  it("reads only NCLAT appeal numbers from page 1 of a judgment", () => {
    const page1 = "NATIONAL COMPANY LAW APPELLATE TRIBUNAL PRINCIPAL BENCH, NEW DELHI 30.09.2026 Present: JUSTICE SHARAD KUMAR SHARMA COMP. APP. (AT) NO. 8 OF 2023 (Arising out of order in CP(IB)/123(MB)2022) J U D G M E N T";
    expect(nclatAppealNumbers(page1)).toEqual({ printed: ["COMP. APP. (AT) NO. 8 OF 2023"], keys: ["COMPAPPAT/8/2023"] });
    const p = COURT_ADAPTERS.nclat!.parse!(parseInput({ meta: { docKind: "judgment", forum: "nclat-delhi" }, pages: [{ page: 1, text: page1 }] }));
    expect(p.records).toEqual([{ printed: ["COMP. APP. (AT) NO. 8 OF 2023"], keys: ["COMPAPPAT/8/2023"] }]);
  });

  it("parses NCLT / NCLAT cause lists through the adapters", () => {
    const md = read("nclt-indore-05.10.2026.md");
    const p = COURT_ADAPTERS.nclt!.parse!(parseInput({ meta: { docKind: "cause_list", forum: "nclt-indore", listDate: "2026-10-05", entriesCount: 36 }, markdown: md, pages: [{ page: 1, text: md }] }));
    expect((p.records as CauseListEntry[]).every((e) => e.forum === "nclt-indore" && e.listType === "daily")).toBe(true);
    expect(p.notes?.join(" ")).toMatch(/36 entries/);
    const md2 = read("nclat-causelist-II-05.10.2026.md");
    const q = COURT_ADAPTERS.nclat!.parse!(parseInput({ meta: { docKind: "cause_list", forum: "nclat-delhi", listDate: "2026-10-05", listType: "main" }, markdown: md2, pages: [{ page: 1, text: md2 }] }));
    expect(q.records).toHaveLength(7);
  });
});

describe("discovered documents are well formed", () => {
  it("every discovered item has an absolute https URL, a kind the source declares and the source id", async () => {
    const all: [string, DiscoveredDoc[]][] = [
      ["sci-causelist", sciCauseListLinks(read("sci-causelist-glance.html"), "2026-10-02")],
      ["sci-orders", sciOrderItems(read("sci-home-latest.html"), "homepage").items],
      ["dhc-causelist", dhcListingItems(read("dhc-causelist-index.html"), "2026-09-30").items],
      ["nclt", ncltListingItems(read("nclt-all-cause-list.html"), null)],
      ["nclat", nclatOrderItems(read("nclat-home-orders.html"), null)],
    ];
    for (const [id, docs] of all) {
      const def = COURT_ADAPTERS[id as keyof typeof COURT_ADAPTERS]!.def;
      for (const d of docs) {
        expect(d.sourceId).toBe(id);
        expect(d.url).toMatch(/^https:\/\//);
        expect(def.kinds).toContain(d.kind);
        expect(d.title.length).toBeGreaterThan(3);
      }
    }
  });
});
