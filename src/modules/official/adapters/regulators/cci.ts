import "server-only";
import { normalizeCaseNumber } from "../../case-numbers";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import {
  GOV_TERMS, attr, clean, errorStatus, hrefs, htmlText, isNotFound, isNotJsonError, isStopError, printedDate, rowCells, safeUrl, tableRows, walkStreams,
  type ListingPage, type ListingStream, type SequenceStream, type StreamSpec,
} from "./common";

/**
 * Competition Commission of India (cci.gov.in).
 *
 * Antitrust orders: the listing is a DataTables POST that needs a session CSRF token, so it is not used. Detail pages
 * https://www.cci.gov.in/antitrust/orders/details/{id}/0 are plain GET with sequential integer ids (verified 2026-10-02:
 * ids 1181, 1200 and 1250 exist; 1300 and 99999 answer HTTP 500 "Server Error" = nothing published under that id).
 * Ids follow upload order, not order date. The page prints the parties, Case No, Type, Order Date and Date of Main Order.
 * The order PDF is referenced by the page's <iframe id="iframesrc"> / viewer links; Firecrawl's capture hides it, so it
 * is read from the raw server HTML (direct fetch). When no PDF reference is present the record is kept with
 * fileUrl null and meta.pdfLinkFound = false (never a guessed file name).
 *
 * Combination orders (Section 31): GET /combination/orders-section31 with DataTables parameters and the
 * X-Requested-With header. NOT verified (the endpoint could not be called from the research environment); any answer
 * that is not DataTables JSON ends the stream with a note.
 */

const BASE = "https://www.cci.gov.in";
const HOSTS = ["cci.gov.in"];
/** Highest antitrust detail id confirmed published on 2026-10-02; the first incremental pass probes upward from here. */
export const CCI_SEED_ID = 1250;
const COMBO_PAGE = 50;

export function cciDetailUrl(id: number): string {
  return `${BASE}/antitrust/orders/details/${id}/0`;
}

export function cciCombinationsUrl(page: number): string {
  return `${BASE}/combination/orders-section31?draw=${page + 1}&start=${page * COMBO_PAGE}&length=${COMBO_PAGE}`;
}

export interface CciDetail {
  parties: string | null;
  caseNo: string | null;
  type: string | null;
  orderDate: string | null;
  mainOrderDate: string | null;
  pdfUrl: string | null;
  /** Every order PDF referenced in the page's content area (first = pdfUrl). */
  pdfUrls: string[];
  fileSize: string | null;
}

/** Parse a detail page; null when it is not an order page (error page, no "Case No" table). */
export function parseCciDetail(html: string, pageUrl: string): CciDetail | null {
  const body = (/<div class="rightBody">([\s\S]*)/i.exec(html)?.[1] ?? html).split(/<footer\b/i)[0];
  const fields: Record<string, string> = {};
  for (const row of tableRows(body)) {
    const cells = rowCells(row).map((c) => clean(htmlText(c)));
    if (cells.length >= 2 && cells[0] && cells[0].length < 40) fields[cells[0].toLowerCase()] = cells[1];
  }
  if (!("case no" in fields)) return null;
  const parties = clean(htmlText(/<div class="row content">\s*(?:<p[^>]*>\s*<\/p>)?\s*<div>([\s\S]*?)<\/div>/i.exec(body)?.[1] ?? "")) || null;
  // PDF reference: the viewer iframe's src, or any link / handler string pointing at an order PDF under /images/.
  let pdfUrl: string | null = null;
  const iframe = /<iframe\b[^>]*id="iframesrc"[^>]*>/i.exec(body)?.[0] ?? /<[a-z]+\b[^>]*id="iframesrc"[^>]*>/i.exec(body)?.[0];
  if (iframe) pdfUrl = safeUrl(attr(iframe, "src"), pageUrl, HOSTS);
  if (pdfUrl && !/\.pdf(?:$|[?#])/i.test(pdfUrl)) pdfUrl = null;
  const all = [...body.matchAll(/((?:https?:\/\/(?:www\.)?cci\.gov\.in)?\/images\/[A-Za-z0-9_\-/]+\.pdf)/gi)]
    .map((m) => safeUrl(m[1], pageUrl, HOSTS))
    .filter((u): u is string => !!u);
  const pdfUrls = [...new Set([...(pdfUrl ? [pdfUrl] : []), ...all])];
  pdfUrl = pdfUrl ?? pdfUrls[0] ?? null;
  const size = /\(([\d.]+)\s*(KB|MB)\)/i.exec(htmlText(body).replace(/\s+/g, " "));
  return {
    parties,
    caseNo: fields["case no"] || null,
    type: fields["type"] || null,
    orderDate: printedDate(fields["order date"]),
    mainOrderDate: printedDate(fields["date of main order"]),
    pdfUrl,
    pdfUrls,
    fileSize: size ? `${size[1]} ${size[2].toUpperCase()}` : null,
  };
}

/** "11/2020" printed under the "Case No" label → normalized "CASE/11/2020"; other forms ("77 (11)/2015") → null. */
export function cciCaseKey(caseNo: string | null): string | null {
  const m = caseNo ? /^(\d{1,5})\s*\/\s*((?:19|20)\d{2})$/.exec(clean(caseNo)) : null;
  return m ? normalizeCaseNumber(`Case No. ${m[1]} of ${m[2]}`)?.key ?? null : null;
}

export function cciDetailDoc(id: number, det: CciDetail): DiscoveredDoc {
  const url = cciDetailUrl(id);
  const title = det.parties ?? (det.caseNo ? `CCI Case No. ${det.caseNo}` : `CCI antitrust order ${id}`);
  return {
    sourceId: "cci-orders",
    kind: "order",
    url,
    fileUrl: det.pdfUrl,
    title,
    docDate: det.orderDate,
    mime: det.pdfUrl ? "application/pdf" : "text/html",
    meta: {
      forum: "cci",
      track: "antitrust",
      detailId: id,
      caseNumber: det.caseNo,
      caseKeys: cciCaseKey(det.caseNo) ? [cciCaseKey(det.caseNo)!] : [],
      caseType: det.type,
      orderDate: det.orderDate,
      mainOrderDate: det.mainOrderDate,
      parties: det.parties,
      fileSize: det.fileSize,
      otherPdfUrls: det.pdfUrls.filter((u) => u !== det.pdfUrl),
      pdfLinkFound: !!det.pdfUrl,
    },
  };
}

const antitrust: SequenceStream = {
  kind: "sequence",
  id: "antitrust",
  backfill: true,
  start: 1,
  incrementalStart: CCI_SEED_ID,
  maxMisses: 10,
  incrementalMax: 150,
  async fetch(id: number, ctx: AdapterContext): Promise<DiscoveredDoc | null> {
    let page;
    try {
      page = await ctx.fetchPage(cciDetailUrl(id));
    } catch (e) {
      const st = errorStatus(e);
      if (isNotFound(e) || st === 500) return null; // CCI answers 500 "Server Error" for ids with nothing published
      throw e;
    }
    if (page.status >= 400) return null;
    const det = parseCciDetail(page.html ?? "", page.finalUrl || cciDetailUrl(id));
    return det ? cciDetailDoc(id, det) : null;
  },
};

interface DataTablesAnswer {
  recordsTotal?: number;
  recordsFiltered?: number;
  data?: Record<string, unknown>[];
}

/** DataTables rows → one item per order PDF linked in the row (summary files are kept as metadata only). */
export function parseCciCombinations(ans: unknown, pageUrl: string): { items: DiscoveredDoc[]; total: number } | null {
  const a = ans as DataTablesAnswer | null;
  if (!a || typeof a !== "object" || !Array.isArray(a.data)) return null;
  const items: DiscoveredDoc[] = [];
  for (const r of a.data) {
    const s = (k: string) => clean(htmlText(String(r[k] ?? ""))) || null;
    const combo = s("combination_no");
    const orders = hrefs(String(r.order_files ?? "")).map((h) => safeUrl(h, pageUrl, HOSTS)).filter((u): u is string => !!u && /\.pdf(?:$|\?)/i.test(u));
    const summaries = hrefs(String(r.summary_files ?? "")).map((h) => safeUrl(h, pageUrl, HOSTS)).filter((u): u is string => !!u);
    for (const fileUrl of orders) {
      items.push({
        sourceId: "cci-orders",
        kind: "order",
        url: fileUrl,
        fileUrl,
        title: [combo ? `Combination ${combo}` : "Combination order", s("party_name")].filter(Boolean).join(": "),
        docDate: printedDate(s("decision_date")),
        mime: "application/pdf",
        meta: {
          forum: "cci",
          track: "combination",
          combinationNo: combo,
          parties: s("party_name"),
          formType: s("form_type"),
          notificationDate: printedDate(s("notification_date")),
          decisionDate: printedDate(s("decision_date")),
          orderStatus: s("order_status"),
          summaryFiles: summaries,
        },
      });
    }
  }
  return { items, total: Number(a.recordsFiltered ?? a.recordsTotal ?? 0) };
}

const combinations: ListingStream = {
  kind: "listing",
  id: "combinations",
  backfill: true,
  firstPage: 0,
  incrementalPages: 1,
  async fetch(page: number, ctx: AdapterContext): Promise<ListingPage> {
    const url = cciCombinationsUrl(page);
    let ans: unknown;
    try {
      ans = await ctx.fetchJson(url, { headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } });
    } catch (e) {
      // The endpoint is unverified: an answer that is not JSON or a refusal (4xx, 500: e.g. a session / CSRF
      // requirement) ends the stream with a note — a refusal does not go away by retrying, and it must not hold a
      // backfill (and with it the source's incremental passes) on this page for good. Transient failures (network,
      // timeout, 408, 429, 501-504) are thrown so the walker's rules apply: an incremental pass skips the stream and
      // keeps its marker; a backfill stops and resumes on the same page.
      const st = errorStatus(e);
      const refused = isNotJsonError(e) || (st != null && st >= 400 && st <= 500 && st !== 408 && st !== 429);
      if (refused && !isStopError(e, ctx)) {
        return { items: [], last: true, notes: [`combination listing page ${page} did not answer with JSON (${e instanceof Error ? e.message : String(e)}); skipped (endpoint unverified).`] };
      }
      throw e;
    }
    const parsed = parseCciCombinations(ans, `${BASE}/combination/orders-section31`);
    if (!parsed) return { items: [], last: true, notes: ["combination listing answer was not DataTables JSON; skipped (endpoint unverified)."] };
    return { items: parsed.items, last: (page + 1) * COMBO_PAGE >= parsed.total || !parsed.items.length };
  },
};

const STREAMS = new Map<string, StreamSpec>([["antitrust", antitrust], ["combinations", combinations]]);

export const def: SourceDef = {
  id: "cci-orders",
  name: "CCI antitrust and combination orders",
  publisher: "Competition Commission of India",
  kinds: ["order"],
  forum: "cci",
  homepage: "https://www.cci.gov.in/antitrust/orders",
  fetch: "direct",
  cadenceMinutes: 1440,
  attribution: "Orders as published by the Competition Commission of India (cci.gov.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Antitrust orders are found by probing detail-page ids (the order listing needs a session token and is not used).",
    "The order PDF is read from the detail page's server HTML; when the page carries no PDF reference the record keeps the page only (pdfLinkFound = false).",
    "Combination (Section 31) listing access is unverified; it is skipped with a note when it does not answer with DataTables JSON.",
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
