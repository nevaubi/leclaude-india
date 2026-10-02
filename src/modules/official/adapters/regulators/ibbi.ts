import "server-only";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import {
  GOV_TERMS, attr, caseNumbersFromTitle, clean, htmlText, printedDate, rowCells, safeUrl, tableRows, walkStreams,
  type ListingPage, type ListingStream, type StreamSpec,
} from "./common";

/**
 * IBBI (ibbi.gov.in): orders of NCLT / NCLAT / Supreme Court / High Courts / DRT / DRAT / IBBI mirrored by the Board,
 * plus CIRP public announcements. Plain GET HTML, 20 rows per page, newest first (verified 2026-10-02):
 *   https://ibbi.gov.in/orders/{forum}?page=N
 *   https://ibbi.gov.in/public-announcement?ann=<type>&page=N&sort=FLD_PA_ANNOUNCE_DATE&direction=desc
 * The court's own copy of an order is the text of record; IBBI's mirror is what is fetched here.
 */

const BASE = "https://ibbi.gov.in";
const HOSTS = ["ibbi.gov.in"];

/** Order listings: IBBI path segment → forum registry key. */
export const IBBI_ORDER_FORUMS: { path: string; forum: string; label: string }[] = [
  { path: "nclt", forum: "nclt", label: "NCLT" },
  { path: "nclat", forum: "nclat", label: "NCLAT" },
  { path: "supreme-court", forum: "sci", label: "Supreme Court" },
  { path: "high-courts", forum: "hc", label: "High Courts" },
  { path: "ibbi", forum: "ibbi", label: "IBBI" },
  { path: "drat", forum: "drat", label: "DRAT" },
  { path: "drts", forum: "drt", label: "DRTs" },
  { path: "other-courts", forum: "other", label: "Other courts" },
  { path: "ipa-rvo", forum: "ipa-rvo", label: "IPAs / RVOs" },
];

/** Public announcements are lower priority than orders and can be switched off here. Only the CIRP list is verified. */
export const IBBI_PUBLIC_ANNOUNCEMENTS = true;
const PA_TYPES = ["Public Announcement of Corporate Insolvency Resolution Process"];

export function ibbiOrdersUrl(path: string, page: number): string {
  return `${BASE}/orders/${path}?page=${page}`;
}

export function ibbiAnnouncementsUrl(type: string, page: number): string {
  return `${BASE}/public-announcement?ann=${encodeURIComponent(type)}&page=${page}&sort=FLD_PA_ANNOUNCE_DATE&direction=desc`;
}

/** Last page number from the pager ("li.last" link), when printed. */
export function ibbiLastPage(html: string): number | null {
  const m = /<li[^>]*class="[^"]*\blast\b[^"]*"[^>]*>\s*<a[^>]*href="[^"]*[?&](?:amp;)?page=(\d+)/i.exec(html);
  return m ? Number(m[1]) : null;
}

/** "A vs. B", "A vs, B", "A v. B", "A versus B" (a bare "v" is not a separator: it starts names such as "V S Ltd"). */
const PARTY_SEP = /\s(?:vs[.,]?|v\.|versus)\s/i;

/** "In the matter of X [..]" → X; "<Subject> - X Limited [..]" → X; parties "A vs. B" are not a corporate debtor. */
export function corporateDebtorFromTitle(title: string): string | null {
  const t = clean(title).replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  if (PARTY_SEP.test(t)) return null;
  let m = /^In the matter of\s+(.+)$/i.exec(t);
  if (m) return clean(m[1]).replace(/[,;]+$/, "") || null;
  m = /^[^-]{3,80}\s+-\s+(.+?(?:Limited|Ltd\.?|LLP|Private Limited|Pvt\.? Ltd\.?))$/i.exec(t);
  return m ? clean(m[1]) : null;
}

/** "A vs. B" in an order title → parties as printed; null when not two-sided. */
function partiesFromTitle(title: string): string | null {
  const t = clean(title).replace(/\s*\[[^\]]*\]\s*$/, "").replace(/^In the matter of\s+/i, "");
  return PARTY_SEP.test(t) ? t.replace(/[,;]+$/, "") : null;
}

/** Rows of an IBBI orders listing page (Sr. No | date | subject+PDF | remarks). */
export function parseIbbiOrders(html: string, forum: { path: string; forum: string; label: string }, pageUrl: string): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const row of tableRows(html)) {
    const cells = rowCells(row);
    if (cells.length < 4) continue;
    const a = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(cells[2]);
    if (!a) continue;
    const fileUrl = safeUrl(attr(a[0], "href"), pageUrl, HOSTS);
    if (!fileUrl || !/\.pdf(?:$|\?)/i.test(fileUrl)) continue;
    const size = /\(([\d.]+\s*[KMG]B)\)/i.exec(htmlText(a[1]))?.[1] ?? null;
    const title = clean(htmlText(a[1].replace(/<span[\s\S]*?<\/span>/gi, " ")).replace(/\(([\d.]+\s*[KMG]B)\)\s*$/i, ""));
    if (!title) continue;
    const printed = clean(htmlText(cells[1]));
    const orderDate = printedDate(printed);
    const cn = caseNumbersFromTitle(title);
    out.push({
      sourceId: "ibbi",
      kind: "order",
      url: fileUrl,
      fileUrl,
      title,
      docDate: orderDate,
      mime: "application/pdf",
      meta: {
        forum: forum.forum,
        listing: forum.path,
        orderDate,
        orderDatePrinted: printed || null,
        subject: title,
        caseNumbers: cn.printed,
        caseKeys: cn.keys,
        corporateDebtor: corporateDebtorFromTitle(title),
        parties: partiesFromTitle(title),
        remarks: clean(htmlText(cells[3])) || null,
        fileSize: size,
        listingUrl: pageUrl,
      },
    });
  }
  return out;
}

/** Rows of a public-announcement listing (type | date | last date | corporate debtor | applicant | IP | PDF | remarks). */
export function parseIbbiAnnouncements(html: string, pageUrl: string): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const row of tableRows(html)) {
    const cells = rowCells(row);
    if (cells.length < 7) continue;
    const href = /<a\b[^>]*>/i.exec(cells[6])?.[0];
    const fileUrl = href ? safeUrl(attr(href, "href"), pageUrl, HOSTS) : null;
    if (!fileUrl || !/\.pdf(?:$|\?)/i.test(fileUrl)) continue;
    const type = clean(htmlText(cells[0]));
    const debtor = clean(htmlText(cells[3]));
    const announced = printedDate(htmlText(cells[1]));
    out.push({
      sourceId: "ibbi",
      kind: "notification",
      url: fileUrl,
      fileUrl,
      title: debtor ? `${type}: ${debtor}` : type,
      docDate: announced,
      mime: "application/pdf",
      meta: {
        forum: "ibbi",
        listing: "public-announcement",
        announcementType: type || null,
        announcementDate: announced,
        lastDateOfSubmission: printedDate(htmlText(cells[2])),
        corporateDebtor: debtor || null,
        applicant: clean(htmlText(cells[4])) || null,
        insolvencyProfessional: clean(htmlText(cells[5])) || null,
        remarks: clean(htmlText(cells[7] ?? "")) || null,
        listingUrl: pageUrl,
      },
    });
  }
  return out;
}

function ordersStream(f: (typeof IBBI_ORDER_FORUMS)[number]): ListingStream {
  return {
    kind: "listing",
    id: `orders:${f.path}`,
    backfill: true,
    firstPage: 1,
    incrementalPages: 5,
    async fetch(page: number, ctx: AdapterContext): Promise<ListingPage> {
      const url = ibbiOrdersUrl(f.path, page);
      const res = await ctx.fetchPage(url);
      const html = res.html ?? "";
      const items = parseIbbiOrders(html, f, url);
      const lastPage = ibbiLastPage(html);
      const notes = !items.length && /<table/i.test(html) && page === 1 ? ["listing had a table but no order rows could be read"] : undefined;
      return { items, last: !items.length || (lastPage != null && page >= lastPage), notes };
    },
  };
}

function announcementsStream(type: string, i: number): ListingStream {
  return {
    kind: "listing",
    id: `pa:${i}`,
    backfill: true,
    firstPage: 1,
    incrementalPages: 3,
    async fetch(page: number, ctx: AdapterContext): Promise<ListingPage> {
      const url = ibbiAnnouncementsUrl(type, page);
      const res = await ctx.fetchPage(url);
      const html = res.html ?? "";
      const items = parseIbbiAnnouncements(html, url);
      const lastPage = ibbiLastPage(html);
      return { items, last: !items.length || (lastPage != null && page >= lastPage) };
    },
  };
}

const STREAMS = new Map<string, StreamSpec>([
  ...IBBI_ORDER_FORUMS.map((f) => [`orders:${f.path}`, ordersStream(f)] as const),
  ...(IBBI_PUBLIC_ANNOUNCEMENTS ? PA_TYPES.map((t, i) => [`pa:${i}`, announcementsStream(t, i)] as const) : []),
]);

export const def: SourceDef = {
  id: "ibbi",
  name: "IBBI: IBC orders and public announcements",
  publisher: "Insolvency and Bankruptcy Board of India",
  kinds: ["order", "notification"],
  forum: "ibbi",
  homepage: "https://ibbi.gov.in/orders/nclt",
  fetch: "direct",
  cadenceMinutes: 720,
  attribution: "Orders and announcements as published by the Insolvency and Bankruptcy Board of India (ibbi.gov.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "IBBI mirrors NCLT, NCLAT, Supreme Court, High Court, DRT/DRAT and IBBI orders under the IBC; the court's own copy remains the text of record.",
    "Case numbers are read from the bracketed numbers in the listing title; forms that are not a single recognisable number keep their printed form only.",
    "Public announcements: the CIRP list only (other announcement types are not yet verified).",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    return walkStreams(ctx, {
      async plan(_ctx, _mode, only) {
        const ids = [...STREAMS.keys()];
        return only ? ids.filter((id) => only.includes(id)) : ids;
      },
      stream: (id) => STREAMS.get(id) ?? null,
    });
  },
};
