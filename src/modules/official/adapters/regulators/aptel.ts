import "server-only";
import { CAPTION_SCOPE } from "../../causelist/forums";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import {
  GOV_TERMS, attr, caseNumbersFromTitle, clean, htmlText, printedDate, rowCells, safeUrl, stripComments, walkStreams,
  type CursorMode, type ListingPage, type ListingStream,
} from "./common";

/**
 * Appellate Tribunal for Electricity (aptel.gov.in, Drupal). Verified 2026-10-02 through Firecrawl (location IN):
 *   GET https://aptel.gov.in/en/old-judgement-data?field_judge_year_value={YYYY}
 * is the site's own "Judgements/Orders" view filtered by its "Judge Year" select (2008 … current year): one page per
 * year, no pager (207 rows for 2025, 90 for 2017), no CAPTCHA or login. Each row: S. No | appeal / petition (PDF link,
 * e.g. "APPEAL NO.431 OF 2022 (PDF)") | cause title (appellant VERSUS respondent) | bench | date of decision (and
 * "Uploaded On"). PDFs live on aptel.gov.in (/sites/default/files/YYYY-MM/… and, for older years,
 * /judgements/JudgYYYY/…).
 * Backfill walks the year pages from the current year back 10 years; incremental passes re-read the current year (and
 * the previous one in January) in full, since rows are not strictly in upload order.
 */

const BASE = "https://aptel.gov.in";
const HOSTS = ["aptel.gov.in"];
/** Years walked by a backfill (current year and the 10 before it). */
export const APTEL_BACKFILL_YEARS = 10;

export function aptelYearUrl(year: number): string {
  return `${BASE}/en/old-judgement-data?field_judge_year_value=${year}`;
}

export interface AptelRow {
  serial: string | null;
  caseText: string;
  pdfUrl: string;
  appellant: string | null;
  respondent: string | null;
  causeTitle: string | null;
  bench: string | null;
  decisionDate: string | null;
  uploadedOn: string | null;
}

const DMY = /\b(\d{1,2}\.\d{1,2}\.(?:19|20)\d{2})\b/g;

/** Rows of a year page (header row and rows without a PDF link skipped). */
export function parseAptelYear(html: string, pageUrl: string): AptelRow[] {
  const out: AptelRow[] = [];
  for (const row of stripComments(html).match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = rowCells(row);
    if (cells.length < 5) continue;
    const a = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(cells[1]);
    const pdfUrl = a ? safeUrl(attr(a[0], "href"), pageUrl, HOSTS) : null;
    if (!a || !pdfUrl || !/\.pdf(?:$|[?#])/i.test(pdfUrl)) continue;
    const caseText = clean(htmlText(a[1]).replace(/\(\s*PDF\s*\)\s*$/i, ""));
    if (!caseText) continue;
    const parts = [...cells[2].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => clean(htmlText(m[1]))).filter(Boolean);
    const vs = parts.findIndex((p) => /^(?:versus|vs\.?|v\.)$/i.test(p));
    const appellant = vs > 0 ? parts.slice(0, vs).join(" ") : null;
    const respondent = vs >= 0 && vs < parts.length - 1 ? parts.slice(vs + 1).join(" ") : null;
    const causeTitle = parts.length ? parts.join(" ") : clean(htmlText(cells[2])) || null;
    const benchParts = [...cells[3].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => clean(htmlText(m[1]))).filter((p) => p && p !== "&");
    const dateText = clean(htmlText(cells[4]));
    const dates = [...dateText.matchAll(DMY)].map((m) => m[1]);
    const uploaded = /Uploaded\s+On\s*(\d{1,2}\.\d{1,2}\.(?:19|20)\d{2})/i.exec(dateText)?.[1] ?? null;
    out.push({
      serial: clean(htmlText(cells[0])) || null,
      caseText,
      pdfUrl,
      appellant,
      respondent,
      causeTitle,
      bench: benchParts.length ? benchParts.join("; ") : clean(htmlText(cells[3])) || null,
      decisionDate: printedDate(dates[0] ?? null),
      uploadedOn: printedDate(uploaded),
    });
  }
  return out;
}

export function aptelDocs(rows: AptelRow[], year: number, listingUrl: string): DiscoveredDoc[] {
  return rows.map((r) => {
    const cn = caseNumbersFromTitle(`[${r.caseText}]`);
    const parties = r.appellant && r.respondent ? `${r.appellant} v. ${r.respondent}` : r.causeTitle;
    return {
      sourceId: "aptel",
      kind: "judgment",
      url: r.pdfUrl,
      fileUrl: r.pdfUrl,
      title: parties ? `${r.caseText}: ${parties}` : r.caseText,
      docDate: r.decisionDate,
      mime: "application/pdf",
      meta: {
        forum: "aptel",
        listingYear: year,
        serial: r.serial,
        caseText: r.caseText,
        appellant: r.appellant,
        respondent: r.respondent,
        parties,
        bench: r.bench,
        decisionDate: r.decisionDate,
        uploadedOn: r.uploadedOn,
        caseNumbers: cn.printed,
        caseKeys: cn.keys,
        caseKeysScope: CAPTION_SCOPE,
        listingUrl,
      },
    };
  });
}

function yearStream(year: number): ListingStream {
  return {
    kind: "listing",
    id: `year:${year}`,
    backfill: true,
    firstPage: 1,
    incrementalPages: 1,
    markerless: true,
    async fetch(_page: number, ctx: AdapterContext): Promise<ListingPage> {
      const url = aptelYearUrl(year);
      const res = await ctx.fetchPage(url);
      const rows = parseAptelYear(res.html ?? "", res.finalUrl || url);
      return { items: aptelDocs(rows, year, url), last: true, notes: rows.length ? undefined : [`no judgment rows for ${year}`] };
    },
  };
}

/** Year streams of a pass: backfill = current year back APTEL_BACKFILL_YEARS; incremental = current (+ previous in January). */
export function aptelPlan(today: string, mode: CursorMode, only: string[] | null): string[] {
  const y = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const years: number[] = [];
  if (mode === "backfill") for (let k = 0; k <= APTEL_BACKFILL_YEARS; k++) years.push(y - k);
  else { years.push(y); if (month === 1) years.push(y - 1); }
  const ids = years.filter((v) => v >= 2008).map((v) => `year:${v}`);
  return only ? ids.filter((id) => only.includes(id)) : ids;
}

function streamFor(id: string): ListingStream | null {
  const m = /^year:((?:19|20)\d{2})$/.exec(id);
  return m && Number(m[1]) >= 2008 ? yearStream(Number(m[1])) : null;
}

export const def: SourceDef = {
  id: "aptel",
  name: "APTEL judgments and orders",
  publisher: "Appellate Tribunal for Electricity",
  kinds: ["judgment"],
  forum: "aptel",
  homepage: "https://aptel.gov.in/en/old-judgement-data",
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "Judgments and orders as published by the Appellate Tribunal for Electricity (aptel.gov.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Read from the tribunal's Judgements/Orders view, one page per year (the site's own year filter); backfill covers the current year and the 10 before it.",
    "Appeal numbers bind only when the row's link prints exactly one number (\"APPEAL NO.431 OF 2022\"); batches (\"… & 375 OF 2017\") keep their printed form only.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    return walkStreams(ctx, {
      async plan(c, mode, only) {
        return aptelPlan(c.today, mode, only);
      },
      stream: streamFor,
    });
  },
};
