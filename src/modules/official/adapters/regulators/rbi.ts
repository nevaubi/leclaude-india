import "server-only";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef, SourceKind } from "../../types";
import {
  GOV_TERMS, attr, clean, htmlText, limitText, printedDate, safeUrl, stripComments, walkStreams,
  type ListingPage, type ListingStream, type SequenceStream, type StreamSpec,
} from "./common";

/**
 * Reserve Bank of India (rbi.org.in). Verified 2026-10-02 through Firecrawl (location IN; a US-located request to
 * rbi.org.in answered HTTP 418 "Unauthorised Access", so the source fetches via firecrawl_in):
 *
 * - Every notification / circular (master directions and master circulars included) has a detail page
 *   /Scripts/NotificationUser.aspx?Id={n}&Mode=0 with a sequential integer id. Id 10600 is the circular dated
 *   September 15, 2016 (the 10-year backfill starts there); id 13725 was the newest on 2026-10-02. An id with nothing
 *   published answers HTTP 200 with "No Notification Found." (= not published, never guessed around).
 *   The page prints the title (h2.dop_header), the RBI reference ("RBI/2016-17/63"), the department reference
 *   ("DPSS.CO.PD No.812/02.14.003/2016-17"), the date (right-aligned paragraph) and links the PDF on
 *   rbidocs.rbi.org.in; the HTML body is the circular's own text.
 * - The month listing /Scripts/NotificationUser.aspx (current month, no paging without an ASP.NET postback) is not
 *   needed: the id sequence covers it.
 * - /Scripts/BS_ViewMasterDirections.aspx lists every Master Direction in force (about 380, grouped by department) with
 *   its detail page (BS_ViewMasDirections.aspx?id=) and PDF; the PDF there is the CURRENT consolidated version
 *   (updated in place), so it is kept as its own record next to the as-issued notification.
 * - /scripts/BS_ViewMasterCirculardetails.aspx lists the current year's Master Circulars (older years need a postback;
 *   they are covered by the id sequence, which holds every master circular as issued).
 * No CAPTCHA or login on any of these pages; robots.txt could not be read (the WAF answered 418 to the US probe).
 */

const BASE = "https://www.rbi.org.in";
const HOSTS = ["rbi.org.in"];
/** First notification id of the 10-year backfill window (dated September 15, 2016; verified 2026-10-02). */
export const RBI_BACKFILL_START_ID = 10600;
/** Newest notification id seen on 2026-10-02; the first incremental pass probes upward from here. */
export const RBI_SEED_ID = 13725;
export const RBI_MASTER_DIRECTIONS_URL = `${BASE}/Scripts/BS_ViewMasterDirections.aspx`;
export const RBI_MASTER_CIRCULARS_URL = `${BASE}/scripts/BS_ViewMasterCirculardetails.aspx`;

/** rbi.org.in refuses requests from outside India (HTTP 418) and serves a different page to our servers: Firecrawl (IN) only. */
const RBI_FETCH = { firecrawlOnly: true } as const;

export function rbiNotificationUrl(id: number): string {
  return `${BASE}/Scripts/NotificationUser.aspx?Id=${id}&Mode=0`;
}

export type RbiCategory = "master_direction" | "master_circular" | "directions" | "regulations" | "notification" | "circular";

/** Category from the printed title / reference (deterministic; "circular" when nothing more specific is printed). */
export function rbiCategory(title: string, refs: string[] = []): RbiCategory {
  const t = clean(title);
  if (/^Master\s+Directions?\b/i.test(t)) return "master_direction";
  if (/^Master\s+Circular\b/i.test(t)) return "master_circular";
  if (/\bDirections?,?\s*(?:19|20)\d{2}\b/i.test(t)) return "directions";
  if (/\bRegulations?,?\s*(?:19|20)\d{2}\b/i.test(t)) return "regulations";
  if (refs.some((r) => /\bNotification\b|\bFEMA\b|\bG\.?S\.?R\.?\b/i.test(r))) return "notification";
  return "circular";
}

export function rbiKind(category: RbiCategory): SourceKind {
  if (category === "master_direction" || category === "directions" || category === "regulations") return "regulation";
  if (category === "notification") return "notification";
  return "circular";
}

export interface RbiNotification {
  title: string;
  date: string | null;
  datePrinted: string | null;
  /** "RBI/2016-17/63" when printed. */
  rbiRef: string | null;
  /** Reference lines as printed above the date (department reference, notification number). */
  refs: string[];
  pdfUrl: string | null;
  fileSize: string | null;
}

/** Parse a NotificationUser.aspx detail page; null when nothing is published under the id ("No Notification Found."). */
export function parseRbiNotification(html: string, pageUrl: string): RbiNotification | null {
  const start = html.search(/<div[^>]*id="NotificationUser"/i);
  if (start < 0) return null;
  let body = stripComments(html.slice(start));
  const end = body.search(/<div class="grid_1 archives/i);
  if (end > 0) body = body.slice(0, end);
  if (/No Notification Found/i.test(htmlText(body))) return null;
  const title = clean(htmlText(/<h2[^>]*class="dop_header"[^>]*>([\s\S]*?)<\/h2>/i.exec(body)?.[1] ?? ""));
  if (!title) return null;
  let pdfUrl: string | null = null;
  for (const m of body.matchAll(/<a\b[^>]*>/gi)) {
    const u = safeUrl(attr(m[0], "href"), pageUrl, HOSTS);
    if (u && /\.pdf(?:$|[?#])/i.test(u)) { pdfUrl = u; break; }
  }
  const size = /aria-hidden="true">\s*([\d.,]+\s*[kKmM][bB])\s*</.exec(body)?.[1] ?? null;
  // The letter starts in the first <table class="td">: reference paragraph(s), then the date (right-aligned).
  const letter = /<table[^>]*class="td"[^>]*>([\s\S]*)/i.exec(body)?.[1] ?? "";
  const paras = [...letter.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)].slice(0, 6);
  const refs: string[] = [];
  let datePrinted: string | null = null;
  for (const p of paras) {
    const lines = p[2].split(/<br\b[^>]*>/i).map((l) => clean(htmlText(l))).filter(Boolean);
    const right = /align\s*=\s*"right"/i.test(p[1]);
    if (right && lines.length && printedDate(lines[0])) { datePrinted = lines[0]; break; }
    for (const l of lines) if (l.length <= 160 && /\d/.test(l) && /[\/.]/.test(l)) refs.push(l);
    if (refs.length >= 4) break;
  }
  const rbiRef = refs.map((r) => /\bRBI\/\d{4}-\d{2,4}\/\d{1,5}\b/.exec(r)?.[0]).find(Boolean) ?? null;
  return { title, date: printedDate(datePrinted), datePrinted, rbiRef, refs, pdfUrl, fileSize: size ? size.replace(/\s+/g, " ").toUpperCase() : null };
}

export function rbiNotificationDoc(id: number, n: RbiNotification): DiscoveredDoc {
  const category = rbiCategory(n.title, n.refs);
  return {
    sourceId: "rbi",
    kind: rbiKind(category),
    url: rbiNotificationUrl(id),
    fileUrl: n.pdfUrl,
    title: n.title,
    docDate: n.date,
    mime: n.pdfUrl ? "application/pdf" : "text/html",
    meta: {
      forum: "rbi",
      track: "notifications",
      notificationId: id,
      category,
      rbiRef: n.rbiRef,
      refs: n.refs,
      datePrinted: n.datePrinted,
      fileSize: n.fileSize,
      pdfLinkFound: !!n.pdfUrl,
    },
  };
}

export interface RbiListingRow {
  title: string;
  pageUrl: string;
  pdfUrl: string | null;
  date: string | null;
  department: string | null;
  fileSize: string | null;
}

/**
 * Rows of a grouped RBI listing table (Master Directions / Master Circulars): header rows carry either the department
 * ("Banker and Debt Manager to Government") or a date ("Jul 03, 2018"); item rows carry a link2 anchor and the PDF.
 */
export function parseRbiGroupedListing(html: string, pageUrl: string, detailPath: RegExp): RbiListingRow[] {
  const out: RbiListingRow[] = [];
  let department: string | null = null;
  let date: string | null = null;
  for (const row of stripComments(html).match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const head = /<h2[^>]*class="dop_header"[^>]*>([\s\S]*?)<\/h2>/i.exec(row)?.[1];
    if (head != null) {
      const text = clean(htmlText(head));
      const d = printedDate(text);
      if (d) date = d;
      else { department = text || null; date = null; }
      continue;
    }
    const a = /<a\b[^>]*class="link2"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!a) continue;
    const link = safeUrl(attr(a[0], "href"), pageUrl, HOSTS);
    const title = clean(htmlText(a[1]));
    if (!link || !title || !detailPath.test(link)) continue;
    let pdfUrl: string | null = null;
    for (const m of row.matchAll(/<a\b[^>]*>/gi)) {
      const u = safeUrl(attr(m[0], "href"), pageUrl, HOSTS);
      if (u && /\.pdf(?:$|[?#])/i.test(u)) { pdfUrl = u.replace(/^http:/i, "https:"); break; }
    }
    const size = /aria-hidden="true"[^>]*>\s*([\d.,]+\s*[kKmM][bB])/.exec(row)?.[1] ?? null;
    out.push({ title, pageUrl: link, pdfUrl, date, department, fileSize: size ? size.replace(/\s+/g, " ").toUpperCase() : null });
  }
  return out;
}

const MD_DETAIL = /\/BS_ViewMasDirections\.aspx\?id=\d+$/i;
const MC_DETAIL = /\/BS_ViewMasCirculardetails\.aspx\?id=\d+$/i;

export function rbiListingDocs(rows: RbiListingRow[], track: "master-directions" | "master-circulars", listingUrl: string): DiscoveredDoc[] {
  return rows.map((r) => {
    const category: RbiCategory = track === "master-directions" ? "master_direction" : "master_circular";
    return {
      sourceId: "rbi",
      kind: rbiKind(category),
      url: r.pageUrl,
      fileUrl: r.pdfUrl,
      title: r.title,
      docDate: r.date,
      mime: r.pdfUrl ? "application/pdf" : "text/html",
      meta: {
        forum: "rbi",
        track,
        category,
        department: r.department,
        listedDate: r.date,
        fileSize: r.fileSize,
        listingUrl,
        // The listing links the version in force (RBI updates master directions in place); the as-issued text is the
        // notification-id record.
        currentVersion: true,
        pdfLinkFound: !!r.pdfUrl,
      },
    };
  });
}

const notifications: SequenceStream = {
  kind: "sequence",
  id: "notifications",
  backfill: true,
  start: RBI_BACKFILL_START_ID,
  incrementalStart: RBI_SEED_ID,
  maxMisses: 15,
  incrementalMax: 120,
  async fetch(id: number, ctx: AdapterContext): Promise<DiscoveredDoc | null> {
    const url = rbiNotificationUrl(id);
    const page = await ctx.fetchPage(url, RBI_FETCH);
    if (page.status >= 400) return null;
    const html = page.html ?? "";
    // A page without the notification container is not "nothing published" (that page says so inside the container):
    // it is an unexpected answer (a block or error page), reported as a failure so a walk never ends on it.
    if (!/id="NotificationUser"/i.test(html)) throw new Error(`rbi: unexpected page for id ${id} (no notification container)`);
    const n = parseRbiNotification(html, page.finalUrl || url);
    if (!n) {
      ctx.log("rbi: nothing published under id", { id });
      return null;
    }
    return rbiNotificationDoc(id, n);
  },
};

function groupedStream(id: "master-directions" | "master-circulars", url: string, detail: RegExp): ListingStream {
  return {
    kind: "listing",
    id,
    backfill: true,
    firstPage: 1,
    incrementalPages: 1,
    // One page listing everything in force, grouped by department (not in publication order): relisted in full.
    markerless: true,
    async fetch(_page: number, ctx: AdapterContext): Promise<ListingPage> {
      const res = await ctx.fetchPage(url, RBI_FETCH);
      const rows = parseRbiGroupedListing(res.html ?? "", res.finalUrl || url, detail);
      const notes = rows.length ? undefined : [`no rows could be read from ${limitText(url, 120)}`];
      return { items: rbiListingDocs(rows, id, url), last: true, notes };
    },
  };
}

const STREAMS = new Map<string, StreamSpec>([
  ["notifications", notifications],
  ["master-directions", groupedStream("master-directions", RBI_MASTER_DIRECTIONS_URL, MD_DETAIL)],
  ["master-circulars", groupedStream("master-circulars", RBI_MASTER_CIRCULARS_URL, MC_DETAIL)],
]);

export const def: SourceDef = {
  id: "rbi",
  name: "RBI notifications, master directions and master circulars",
  publisher: "Reserve Bank of India",
  kinds: ["circular", "notification", "regulation"],
  forum: "rbi",
  homepage: "https://www.rbi.org.in/Scripts/NotificationUser.aspx",
  fetch: "firecrawl_in",
  cadenceMinutes: 720,
  attribution: "Notifications, circulars, master directions and master circulars as published by the Reserve Bank of India (rbi.org.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Notifications are found by probing the sequential detail-page ids (NotificationUser.aspx?Id=); backfill starts at id 10600 (September 15, 2016).",
    "Master Directions are also listed from the page of directions in force; that PDF is the current consolidated version (RBI updates it in place), the notification record is the text as issued.",
    "Master Circulars: the current year's list is read directly; earlier ones come through the notification ids.",
    "rbi.org.in refuses requests from outside India (HTTP 418); fetched through Firecrawl (location IN) when the direct request fails.",
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
      key: (d) => d.url,
    });
  },
};
