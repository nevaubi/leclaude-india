import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { AdapterContext, FetchedPage } from "@/modules/official/adapter";
import { backfillCursor, parseCursor, safeUrl } from "@/modules/official/adapters/regulators/common";
import {
  RBI_BACKFILL_START_ID, RBI_MASTER_CIRCULARS_URL, RBI_MASTER_DIRECTIONS_URL, RBI_SEED_ID, adapter as rbi, parseRbiGroupedListing, parseRbiNotification,
  rbiCategory, rbiNotificationUrl,
} from "@/modules/official/adapters/regulators/rbi";
import { ITAT_SB_URL, adapter as itat, itatBench, itatDocs, parseItatSpecialBench } from "@/modules/official/adapters/regulators/itat";
import { adapter as aptel, aptelDocs, aptelPlan, aptelYearUrl, parseAptelYear } from "@/modules/official/adapters/regulators/aptel";
import { adapter as rera, delhiReatDocs, parseDelhiReat, reatNumbers } from "@/modules/official/adapters/regulators/rera-appellate";
import { cestat, cic, ncdrc } from "@/modules/official/adapters/regulators/disabled-tribunals";
import { adapter as cbic, decodeCbicPdf } from "@/modules/official/adapters/regulators/cbic";
import { cciLooksLikeTestRecord, parseCciDetail } from "@/modules/official/adapters/regulators/cci";
import { REGULATOR_ADAPTERS } from "@/modules/official/adapters/regulators";
import { BACKFILL_SOURCES } from "@/modules/official/run";
import { allowHostsFor, sourceDef, sourceEnabled } from "@/modules/official/registry";
import { SOURCE_IDS } from "@/modules/official/types";
import { extractPdf } from "@/modules/official/extract";

const FX = path.resolve(__dirname, "fixtures/official/sources");
const fx = (name: string) => readFileSync(path.join(FX, name), "utf8");
const REG = path.resolve(__dirname, "fixtures/official/regulators");

type Route = string | { status?: number; html?: string } | Error;

/** In-memory AdapterContext: routes by URL; anything unrouted answers 404 (as the core fetchers report it). */
function makeCtx(o: { pages?: (url: string) => Route | undefined; json?: (url: string) => unknown; cursor?: string | null; limit?: number; today?: string } = {}) {
  const calls: string[] = [];
  const nf = (url: string) => Object.assign(new Error(`HTTP 404 for ${url}`), { status: 404 });
  const ctx: AdapterContext = {
    limit: o.limit ?? 200,
    deadline: Date.now() + 60_000,
    cursor: o.cursor ?? null,
    today: o.today ?? "2026-10-02",
    async fetchPage(url): Promise<FetchedPage> {
      calls.push(url);
      const r = o.pages?.(url);
      if (r === undefined) throw nf(url);
      if (r instanceof Error) throw r;
      const html = typeof r === "string" ? r : (r.html ?? "");
      const status = typeof r === "string" ? 200 : (r.status ?? 200);
      return { url, finalUrl: url, status, html, markdown: null, links: [], provenance: { via: "firecrawl", status, finalUrl: url } };
    },
    async fetchFile(url) { throw nf(url); },
    async fetchJson<T>(url: string): Promise<T> {
      calls.push(url);
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

const NOT_FOUND_RBI = '<html><body><div id="NotificationUser" class="text1"><h1 class="page_title">Notifications</h1><table><tr><td>No Notification Found.</td></tr></table></div><div class="grid_1 archives alpha"></div></body></html>';

/** The live detail-page fixture re-labelled for another id (title and PDF changed so items differ). */
function rbiPage(id: number): string {
  return fx("rbi-notification-10600.html")
    .replace(/Security and Risk Mitigation Measures for Card Present and Electronic Payment Transactions – Issuance of EMV Chip and PIN Cards/g, `Circular ${id}`)
    .replace(/NOTI63B08E3EA34A8240B7A62F6ACD3C1A139F/g, `NOTI${id}`);
}

describe("RBI (live fixtures, 2026-10-02)", () => {
  it("parses a notification detail page: title, reference, date and PDF; an empty id is not published", () => {
    const url = rbiNotificationUrl(10600);
    const n = parseRbiNotification(fx("rbi-notification-10600.html"), url)!;
    expect(n).toMatchObject({
      title: "Security and Risk Mitigation Measures for Card Present and Electronic Payment Transactions – Issuance of EMV Chip and PIN Cards",
      date: "2016-09-15",
      rbiRef: "RBI/2016-17/63",
      pdfUrl: "https://rbidocs.rbi.org.in/rdocs/notification/PDFs/NOTI63B08E3EA34A8240B7A62F6ACD3C1A139F.PDF",
      fileSize: "170 KB",
    });
    expect(n.refs).toContain("DPSS.CO.PD No.812/02.14.003/2016-17");
    // The addressee lines and the letter body are not references.
    expect(n.refs.some((r) => /Banks/.test(r))).toBe(false);
    expect(parseRbiNotification(NOT_FOUND_RBI, url)).toBeNull();
    expect(parseRbiNotification("<html><body>Unauthorised Access</body></html>", url)).toBeNull();
  });

  it("classifies directions, master circulars and FEMA notifications from what is printed", () => {
    expect(rbiCategory("Master Direction on Note Sorting Machines")).toBe("master_direction");
    expect(rbiCategory("Master Circular - Credit Facilities to Scheduled Castes (SCs) & Scheduled Tribes (STs)")).toBe("master_circular");
    expect(rbiCategory("Reserve Bank of India (Payments Banks - Acquisition and Holding of Shares or Voting Rights) Amendment Directions, 2026")).toBe("directions");
    expect(rbiCategory("Foreign Exchange Management (Export and Import of Goods and Services) (Amendment) Regulations, 2026")).toBe("regulations");
    expect(rbiCategory("Cassette - Swaps in ATMs", ["RBI/2026-27/120", "DCM (Plg) No.S1234/10.27.00/2026-27"])).toBe("circular");
    expect(rbiCategory("Something", ["Notification No. FEMA 23(R)/2026-RB"])).toBe("notification");
  });

  it("reads the master-directions list with its department and date headers", () => {
    const rows = parseRbiGroupedListing(fx("rbi-master-directions.html"), RBI_MASTER_DIRECTIONS_URL, /\/BS_ViewMasDirections\.aspx\?id=\d+$/i);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toMatchObject({
      title: "Master Directions on Relief/Savings Bonds",
      pageUrl: "https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=11322",
      pdfUrl: "https://rbidocs.rbi.org.in/rdocs/notification/PDFs/61MD0825F724310142CBB351B33F9C3F80FA.PDF",
      date: "2018-07-03",
      department: "Banker and Debt Manager to Government",
    });
    expect(new Set(rows.map((r) => r.department)).size).toBeGreaterThanOrEqual(2);
    // Off-site links are never taken.
    const evil = fx("rbi-master-directions.html").replace("https://rbidocs.rbi.org.in/rdocs/notification/PDFs/61MD0825F724310142CBB351B33F9C3F80FA.PDF", "https://evil.example/x.PDF");
    expect(parseRbiGroupedListing(evil, RBI_MASTER_DIRECTIONS_URL, /\/BS_ViewMasDirections\.aspx\?id=\d+$/i)[0].pdfUrl).toBeNull();
  });

  const live = new Set([RBI_SEED_ID, RBI_SEED_ID + 1, RBI_SEED_ID + 3]);
  const routes = (url: string): Route | undefined => {
    const m = /NotificationUser\.aspx\?Id=(\d+)&Mode=0$/.exec(url);
    if (m) return live.has(Number(m[1])) ? rbiPage(Number(m[1])) : NOT_FOUND_RBI;
    if (url === RBI_MASTER_DIRECTIONS_URL) return fx("rbi-master-directions.html");
    if (url === RBI_MASTER_CIRCULARS_URL) return "<html><body><table class=\"tablebg\"></table></body></html>";
    return undefined;
  };

  it("discovers new notification ids from the seed (across a gap), then the master-direction list", async () => {
    const { ctx } = makeCtx({ pages: routes });
    const r = await rbi.discover(ctx);
    const ids = r.items.filter((d) => d.meta?.track === "notifications").map((d) => d.meta?.notificationId);
    expect(ids).toEqual([RBI_SEED_ID, RBI_SEED_ID + 1, RBI_SEED_ID + 3]);
    expect(r.items.find((d) => d.meta?.notificationId === RBI_SEED_ID)).toMatchObject({ sourceId: "rbi", kind: "circular", url: rbiNotificationUrl(RBI_SEED_ID), docDate: "2016-09-15" });
    expect(r.items.some((d) => d.meta?.track === "master-directions" && d.kind === "regulation")).toBe(true);
    expect(r.done).toBe(true);
    expect(parseCursor(r.nextCursor)!.lastSeen.notifications).toBe(String(RBI_SEED_ID + 3));
    expect(r.notes?.some((n) => /master-circulars: no rows/.test(n))).toBe(true);
  });

  it("resumes a bounded call at the next id, and the next pass starts above the marker", async () => {
    const first = await rbi.discover(makeCtx({ pages: routes, limit: 2 }).ctx);
    expect(first.items.map((d) => d.meta?.notificationId)).toEqual([RBI_SEED_ID, RBI_SEED_ID + 1]);
    expect(first.done).toBe(false);
    const second = await rbi.discover(makeCtx({ pages: routes, cursor: first.nextCursor }).ctx);
    expect(second.items.filter((d) => d.meta?.track === "notifications").map((d) => d.meta?.notificationId)).toEqual([RBI_SEED_ID + 3]);
    const { ctx, calls } = makeCtx({ pages: routes, cursor: second.nextCursor });
    const third = await rbi.discover(ctx);
    expect(third.items.filter((d) => d.meta?.track === "notifications")).toEqual([]);
    expect(calls.find((u) => /NotificationUser/.test(u))).toBe(rbiNotificationUrl(RBI_SEED_ID + 4));
  });

  it("backfills from the 10-year start id up to the known ceiling without stopping at gaps", async () => {
    const old = new Set([RBI_BACKFILL_START_ID, RBI_BACKFILL_START_ID + 40]);
    const pages = (url: string): Route | undefined => {
      const m = /NotificationUser\.aspx\?Id=(\d+)&Mode=0$/.exec(url);
      if (m) return old.has(Number(m[1])) ? rbiPage(Number(m[1])) : NOT_FOUND_RBI;
      return routes(url);
    };
    const cursor = backfillCursor({ only: ["notifications"], lastSeen: { notifications: String(RBI_BACKFILL_START_ID + 41) } });
    const r = await rbi.discover(makeCtx({ pages, cursor }).ctx);
    expect(r.items.map((d) => d.meta?.notificationId)).toEqual([RBI_BACKFILL_START_ID, RBI_BACKFILL_START_ID + 40]);
    expect(parseCursor(r.nextCursor)!.mode).toBe("incremental");
  });

  it("is limited to rbi.org.in (and its rbidocs subdomain) and fetched from India", () => {
    const hosts = allowHostsFor(rbi.def);
    expect(hosts).toContain("rbi.org.in");
    expect(safeUrl("https://rbidocs.rbi.org.in/rdocs/notification/PDFs/X.PDF", rbi.def.homepage, hosts)).not.toBeNull();
    expect(safeUrl("https://rbi.org.in.evil.example/x.pdf", rbi.def.homepage, hosts)).toBeNull();
    expect(rbi.def).toMatchObject({ fetch: "firecrawl_in", enabled: true });
    expect(BACKFILL_SOURCES).toContain("rbi");
  });
});

describe("ITAT Special Bench orders (live fixture, 2026-10-02)", () => {
  it("reads each Special Bench block: question, result and the decided appeals with their order PDF", () => {
    const rows = parseItatSpecialBench(fx("itat-special-bench.html"), ITAT_SB_URL);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      appealNo: "ITA 1413/BANG/2025",
      appellant: "M D SONS, BANGALORE",
      orderDate: "2026-07-13",
      blockDate: "2026-07-13",
      result: "Reference answered in the negative",
      pdfUrl: "https://itat.gov.in/public/files/upload/1784620858-MEXeK6-8-TO.pdf",
    });
    expect(rows[0].question).toMatch(/^Whether notices issued u\/s 143 \(2\)/);
    expect(rows[1]).toMatchObject({ appealNo: "ITA 1586/MUM/2017", result: "Allowed", orderDate: "2026-06-02" });
    expect(itatBench("ITA 1413/BANG/2025")).toBe("BANG");
  });

  it("binds only the row's own appeal number, bench-qualified", () => {
    const docs = itatDocs(parseItatSpecialBench(fx("itat-special-bench.html"), ITAT_SB_URL), ITAT_SB_URL);
    expect(docs[0].meta).toMatchObject({ forum: "itat", bench: "BANG", caseKeysScope: "caption", caseNumbers: ["ITA 1413/BANG/2025"] });
    const keys = docs[0].meta!.caseKeys as string[];
    expect(keys.every((k) => k.startsWith("ITA/1413/2025"))).toBe(true);
    expect(keys).toContain("ITA/1413/2025@BANG");
  });

  it("relists the whole page each pass and resumes a bounded call inside it", async () => {
    const pages = (url: string) => (url === ITAT_SB_URL ? fx("itat-special-bench.html") : undefined);
    const first = await itat.discover(makeCtx({ pages, limit: 1 }).ctx);
    expect(first.items).toHaveLength(1);
    expect(first.done).toBe(false);
    const second = await itat.discover(makeCtx({ pages, cursor: first.nextCursor }).ctx);
    expect(second.items.map((d) => d.meta?.appealNo)).toEqual(["ITA 1586/MUM/2017"]);
    expect(second.done).toBe(true);
    const third = await itat.discover(makeCtx({ pages, cursor: second.nextCursor }).ctx);
    expect(third.items).toHaveLength(2); // markerless: the pipeline's upsert skips what it holds
  });

  it("is limited to itat.gov.in and says why regular orders are absent", () => {
    expect(allowHostsFor(itat.def)).toEqual(["itat.gov.in"]);
    expect(parseItatSpecialBench(fx("itat-special-bench.html").replace(/https:\/\/itat\.gov\.in\/public/g, "https://evil.example/public"), ITAT_SB_URL)).toEqual([]);
    expect(itat.def.notes?.join(" ")).toMatch(/CAPTCHA/);
  });
});

describe("APTEL judgments (live fixtures, 2026-10-02)", () => {
  it("parses year pages of both layouts (2025 Drupal files, 2017 legacy paths)", () => {
    const y25 = parseAptelYear(fx("aptel-judgments-2025.html"), aptelYearUrl(2025));
    expect(y25.length).toBe(3);
    expect(y25[0]).toMatchObject({
      serial: "3207",
      caseText: "APPEAL NO.431 OF 2022",
      appellant: "M/s Korba Power Limited",
      respondent: "Haryana Electricity Regulatory Commission & Ors",
      decisionDate: "2025-12-23",
      uploadedOn: "2025-12-23",
      pdfUrl: "https://aptel.gov.in/sites/default/files/2025-12/APL%20431%20of%202022.pdf",
    });
    const y17 = parseAptelYear(fx("aptel-judgments-2017.html"), aptelYearUrl(2017));
    expect(y17[0]).toMatchObject({ caseText: "A.No. 30 of 2015", appellant: "Shendra Green Energy Ltd.", respondent: "Maharashtra Electricity Regulatory Commission & Ors.", decisionDate: "2017-12-19", bench: "NKP; SDD" });
  });

  it("binds a single printed appeal number and never a batch", () => {
    const docs = aptelDocs(parseAptelYear(fx("aptel-judgments-2025.html"), aptelYearUrl(2025)), 2025, aptelYearUrl(2025));
    expect(docs[0].meta).toMatchObject({ forum: "aptel", caseKeysScope: "caption", caseNumbers: ["APPEAL NO.431 OF 2022"] });
    expect((docs[0].meta!.caseKeys as string[]).length).toBe(1);
    const batch = docs.find((d) => /139 OF 2016 & 375 OF 2017/.test(String(d.meta?.caseText)))!;
    expect(batch.meta!.caseKeys).toEqual([]);
    expect(docs[0]).toMatchObject({ sourceId: "aptel", kind: "judgment", docDate: "2025-12-23" });
  });

  it("plans the current year incrementally and the last 10 years on a backfill", () => {
    expect(aptelPlan("2026-10-02", "incremental", null)).toEqual(["year:2026"]);
    expect(aptelPlan("2027-01-05", "incremental", null)).toEqual(["year:2027", "year:2026"]);
    const bf = aptelPlan("2026-10-02", "backfill", null);
    expect(bf[0]).toBe("year:2026");
    expect(bf[bf.length - 1]).toBe("year:2016");
    expect(bf).toHaveLength(11);
  });

  it("backfills year by year and resumes mid-year after a bounded call", async () => {
    const pages = (url: string): Route | undefined => {
      if (url === aptelYearUrl(2025)) return fx("aptel-judgments-2025.html");
      if (url === aptelYearUrl(2017)) return fx("aptel-judgments-2017.html");
      if (/old-judgement-data\?field_judge_year_value=\d{4}$/.test(url)) return "<html><body><div class=\"view-content\"></div></body></html>";
      return undefined;
    };
    const first = await aptel.discover(makeCtx({ pages, cursor: backfillCursor(), limit: 2 }).ctx);
    expect(first.items.map((d) => d.meta?.listingYear)).toEqual([2025, 2025]);
    expect(first.done).toBe(false);
    let cursor = first.nextCursor;
    const all = [...first.items];
    for (let i = 0; i < 10; i++) {
      const r = await aptel.discover(makeCtx({ pages, cursor }).ctx);
      all.push(...r.items);
      cursor = r.nextCursor;
      if (r.done) break;
    }
    expect(all.filter((d) => d.meta?.listingYear === 2025)).toHaveLength(3);
    expect(all.filter((d) => d.meta?.listingYear === 2017)).toHaveLength(3);
    expect(parseCursor(cursor)!.mode).toBe("incremental");
  });

  it("is limited to aptel.gov.in", () => {
    expect(allowHostsFor(aptel.def)).toEqual(["aptel.gov.in"]);
    expect(BACKFILL_SOURCES).toContain("aptel");
  });
});

describe("Real Estate Appellate Tribunals (Delhi live fixture, 2026-10-02)", () => {
  const URL = rera.def.homepage;

  it("reads the open latest-orders table and keeps every printed number", () => {
    const rows = parseDelhiReat(fx("delhi-reat-orders.html"), URL);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatchObject({ caseText: "Appeal No.194/REAT/2025", date: "2026-02-06" });
    expect(reatNumbers(rows[0].caseText)).toEqual(["Appeal No.198/REAT/2025", "CM No.72/2026 in Appeal No.38/REAT/2022"]);
  });

  it("binds only a row that prints exactly one appeal number", () => {
    const docs = delhiReatDocs(parseDelhiReat(fx("delhi-reat-orders.html"), URL), URL);
    expect(docs[0].meta!.caseKeys).toEqual([]);
    expect(docs[1].meta!.caseKeys).toEqual([]);
    expect(docs[3].meta!.caseKeys).toEqual([]);
    expect((docs[2].meta!.caseKeys as string[]).length).toBeGreaterThan(0);
    expect(docs[2].meta).toMatchObject({ forum: "reat-delhi", caseKeysScope: "caption" });
  });

  it("lists the page in full each pass, never backfills (older orders are behind a CAPTCHA)", async () => {
    const pages = (url: string) => (url === URL ? fx("delhi-reat-orders.html") : undefined);
    const first = await rera.discover(makeCtx({ pages, limit: 3 }).ctx);
    expect(first.items).toHaveLength(3);
    const second = await rera.discover(makeCtx({ pages, cursor: first.nextCursor }).ctx);
    expect(second.items).toHaveLength(1);
    expect(second.done).toBe(true);
    const bf = await rera.discover(makeCtx({ pages, cursor: backfillCursor() }).ctx);
    expect(bf.items).toEqual([]);
    expect(parseCursor(bf.nextCursor)!.mode).toBe("incremental");
  });

  it("is limited to the publishers' hosts", () => {
    const hosts = allowHostsFor(rera.def);
    expect(hosts).toContain("erera.co.in");
    expect(parseDelhiReat(fx("delhi-reat-orders.html").replace(/https:\/\/erera\.co\.in\/delhirera/g, "https://evil.example/x"), URL)).toEqual([]);
  });
});

describe("tribunals registered disabled (checked 2026-10-02)", () => {
  it.each([["cestat-orders", cestat], ["ncdrc", ncdrc], ["cic-decisions", cic]] as const)("%s never fetches and says why", async (id, a) => {
    expect(a.def.id).toBe(id);
    expect(a.def.enabled).toBe(false);
    expect(sourceEnabled(id)).toBe(false);
    expect(a.def.notes?.[0]).toMatch(/^Disabled: /);
    const { ctx, calls } = makeCtx();
    const r = await a.discover(ctx);
    expect(r).toMatchObject({ items: [], done: true, nextCursor: null });
    expect(calls).toEqual([]);
  });

  it("every new source id is registered with its adapter's definition", () => {
    for (const id of ["rbi", "itat-orders", "cestat-orders", "aptel", "ncdrc", "cic-decisions", "rera-appellate"] as const) {
      expect(SOURCE_IDS).toContain(id);
      expect(REGULATOR_ADAPTERS[id]?.def.id).toBe(id);
      expect(sourceDef(id)).toBe(REGULATOR_ADAPTERS[id]!.def);
      expect(allowHostsFor(sourceDef(id)!).length).toBeGreaterThan(0);
    }
    expect(BACKFILL_SOURCES).not.toContain("rera-appellate");
    expect(BACKFILL_SOURCES).not.toContain("cestat-orders");
  });
});

describe("revisited sources", () => {
  it("CBIC: a category list that answers HTML ends its stream with a note and never blocks a backfill", async () => {
    const notJson = Object.assign(new Error("official:cbic: invalid JSON (Unexpected token < in JSON)"), { code: "parse", status: 200 });
    const record = JSON.parse(readFileSync(path.join(REG, "cbic-notifications-gst-central-tax.json"), "utf8"));
    const { ctx } = makeCtx({
      cursor: backfillCursor(),
      json: (url) => {
        if (url.endsWith("/api/cbic-tax-msts")) return [{ id: 1000001, taxName: "GST", isActive: "Y" }];
        if (url.includes("fetchUpdatesByTaxId")) return [{ updateType: "Notification", updateCategory: "Compensation Cess" }];
        if (url.includes("Compensation%20Cess")) return notJson;
        if (url.includes("fetchNotificationByCategory/1000001/Central%20Tax")) return record;
        return [];
      },
    });
    const r = await cbic.discover(ctx);
    expect(r.done).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.notes?.some((n) => /Compensation Cess did not answer with JSON/.test(n))).toBe(true);
  });

  it("CBIC: transient failures are still thrown (the walker retries them)", async () => {
    const timeout = Object.assign(new Error("HTTP 503 for x"), { status: 503 });
    const { ctx } = makeCtx({ cursor: backfillCursor({ only: ["n|1000001|Central Tax"] }), json: (url) => (url.includes("fetchNotificationByCategory") ? timeout : url.endsWith("cbic-tax-msts") ? [{ id: 1000001, taxName: "GST" }] : []) });
    await expect(cbic.discover(ctx)).rejects.toThrow(/503/);
  });

  it("CBIC: a raw PDF answer is the document; the HTML app shell is never stored", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\nrest");
    expect(decodeCbicPdf(pdf).bytes).toBe(pdf);
    expect(() => decodeCbicPdf(new TextEncoder().encode("<!doctype html><html></html>"))).toThrow(/HTML page/);
  });

  it("CCI: the portal's test records (no year, type 'tezst') are not orders; real orders are", () => {
    expect(cciLooksLikeTestRecord({ caseNo: "123456789", type: "tezst" })).toBe(true);
    expect(cciLooksLikeTestRecord({ caseNo: "77 (11)/2015", type: "Anti-trust Section 19 (1) (a)" })).toBe(false);
    expect(cciLooksLikeTestRecord({ caseNo: "37/2021", type: "" })).toBe(false);
    const det = parseCciDetail(readFileSync(path.join(REG, "cci-antitrust-detail-1181.html"), "utf8"), "https://www.cci.gov.in/antitrust/orders/details/1181/0")!;
    expect(cciLooksLikeTestRecord(det)).toBe(false);
  });

  it("IBBI-style scans: a PDF with no text layer on any page is sent to OCR, not rejected", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    doc.addPage([595, 842]);
    const ex = await extractPdf(await doc.save());
    expect(ex.ocrPages).toEqual([1, 2]);
    expect(ex.method).toBeNull();
    expect(ex.warning).toMatch(/sent to OCR/);
  });
});
