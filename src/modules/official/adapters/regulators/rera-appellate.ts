import "server-only";
import { CAPTION_SCOPE } from "../../causelist/forums";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import {
  GOV_TERMS, attr, caseNumbersFromTitle, clean, htmlText, printedDate, rowCells, safeUrl, stripComments, walkStreams,
  type ListingPage, type ListingStream,
} from "./common";

/**
 * Real Estate Appellate Tribunals that publish an open listing. Verified 2026-10-02 through Firecrawl (location IN):
 *
 * - Delhi REAT (orders of the Real Estate Appellate Tribunal, Delhi, published on RERA Delhi's portal erera.co.in):
 *   GET /reradelhiindex/courtREAT/REATcourtOrderJudgementsAppellateTribunalInfo shows the latest orders openly (10
 *   rows: S.No | appeal / application numbers | date | PDF under /delhirera/readwriteReatOrder/). Searching older
 *   orders needs the page's CAPTCHA form, so only the latest rows are read (every pass, in full); no backfill.
 * - Maharashtra REAT (mahareat.maharashtra.gov.in/online/judgements/tribunal, Angular): the list comes from a JSON POST
 *   to https://mahareat.maharashtra.gov.in:8085/api/Public/Getjudgment_orderBySubjectDate with
 *   {"_subject":null,"_fromdate":null,"_todate":null} (read from the app bundle; no CAPTCHA). The core fetchers send
 *   GET and form POSTs only, the endpoint is on a non-standard port and its answer could not be verified from the
 *   research environment, so it is NOT ingested yet (see notes; pending a JSON-POST fetcher and live verification).
 * Several numbers per row are common ("(CM No.73/2026 in Appeal No.108/REAT/2022) (Appeal No.197/REAT/2025)"): a row
 * binds only when it prints exactly one appeal number.
 */

const DELHI_URL = "https://erera.co.in/reradelhiindex/courtREAT/REATcourtOrderJudgementsAppellateTribunalInfo";
const DELHI_HOSTS = ["erera.co.in"];

export interface ReatRow {
  serial: string | null;
  caseText: string;
  date: string | null;
  pdfUrl: string;
}

export function parseDelhiReat(html: string, pageUrl: string): ReatRow[] {
  const out: ReatRow[] = [];
  for (const row of stripComments(html).match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = rowCells(row);
    if (cells.length < 4) continue;
    const a = /<a\b[^>]*>/i.exec(cells[3])?.[0];
    const pdfUrl = a ? safeUrl(attr(a, "href"), pageUrl, DELHI_HOSTS) : null;
    if (!pdfUrl || !/\.pdf(?:$|[?#])/i.test(pdfUrl)) continue;
    const caseText = clean(htmlText(cells[1]));
    if (!caseText) continue;
    out.push({ serial: clean(htmlText(cells[0])) || null, caseText, date: printedDate(htmlText(cells[2])), pdfUrl });
  }
  return out;
}

/** The printed numbers of a row: each parenthesised group, or the whole text when it has none. */
export function reatNumbers(caseText: string): string[] {
  const groups = [...caseText.matchAll(/\(([^()]{3,200})\)/g)].map((m) => clean(m[1]));
  return groups.length ? groups : [clean(caseText)];
}

export function delhiReatDocs(rows: ReatRow[], listingUrl: string): DiscoveredDoc[] {
  return rows.map((r) => {
    const printed = reatNumbers(r.caseText);
    // Exactly one printed number that is a single appeal ("Appeal No.194/REAT/2025") binds; anything else is printed only.
    const single = printed.length === 1 && !/\bin\b/i.test(printed[0]) ? caseNumbersFromTitle(`[${printed[0].replace(/^(.+?)\s*No\.?\s*(\d{1,7})\s*\/\s*([A-Za-z]{1,6})\s*\/\s*((?:19|20)\d{2})$/i, "$1/$2/$3/$4")}]`) : { printed: [], keys: [] };
    return {
      sourceId: "rera-appellate",
      kind: "order",
      url: r.pdfUrl,
      fileUrl: r.pdfUrl,
      title: `Delhi REAT: ${r.caseText}`,
      docDate: r.date,
      mime: "application/pdf",
      meta: {
        forum: "reat-delhi",
        tribunal: "Real Estate Appellate Tribunal, Delhi",
        state: "Delhi",
        serial: r.serial,
        caseText: r.caseText,
        caseNumbers: printed,
        caseKeys: single.keys,
        caseKeysScope: CAPTION_SCOPE,
        orderDate: r.date,
        listingUrl,
      },
    };
  });
}

const delhi: ListingStream = {
  kind: "listing",
  id: "delhi",
  // Older orders are behind the CAPTCHA search form: no way to page back.
  backfill: false,
  firstPage: 1,
  incrementalPages: 1,
  markerless: true,
  async fetch(_page: number, ctx: AdapterContext): Promise<ListingPage> {
    const res = await ctx.fetchPage(DELHI_URL);
    const rows = parseDelhiReat(res.html ?? "", res.finalUrl || DELHI_URL);
    return { items: delhiReatDocs(rows, DELHI_URL), last: true, notes: rows.length ? undefined : ["no Delhi REAT order rows could be read"] };
  },
};

export const def: SourceDef = {
  id: "rera-appellate",
  name: "Real Estate Appellate Tribunal orders",
  publisher: "Real Estate Appellate Tribunals (Delhi, via RERA Delhi)",
  kinds: ["order"],
  forum: "reat",
  homepage: DELHI_URL,
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "Orders of the Real Estate Appellate Tribunal, Delhi, as published on RERA Delhi's portal (erera.co.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Delhi REAT: only the latest orders shown openly are read; older orders are behind a CAPTCHA search form and are not ingested.",
    "Maharashtra REAT (MahaREAT) is not ingested yet: its list is a JSON POST API on port 8085 that the official fetchers do not send and that could not be verified (checked 2026-10-02).",
    "A row binds to a matter only when it prints exactly one appeal number.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    return walkStreams(ctx, {
      async plan(_ctx, mode, only) {
        if (mode === "backfill") return [];
        return !only || only.includes("delhi") ? ["delhi"] : [];
      },
      stream: (id) => (id === "delhi" ? delhi : null),
    });
  },
};
