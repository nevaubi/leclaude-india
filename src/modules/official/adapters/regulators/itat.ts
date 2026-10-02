import "server-only";
import { CAPTION_SCOPE } from "../../causelist/forums";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import {
  GOV_TERMS, attr, caseNumbersFromTitle, clean, htmlText, limitText, printedDate, rowCells, safeUrl, stripComments, walkStreams,
  type ListingPage, type ListingStream,
} from "./common";

/**
 * Income Tax Appellate Tribunal (itat.gov.in). Verified 2026-10-02 through Firecrawl (location IN):
 *
 * - Tribunal orders (/judicial/tribunalorders: search by appeal number or by bench + order date) require a CAPTCHA
 *   (checked server-side via /Ajax/checkCaptcha before the form is submitted). Never automated: regular ITAT orders are
 *   NOT ingested.
 * - Special Bench orders (/judicial/sborders) are an open page (no form, no CAPTCHA, no pagination): one block per
 *   question referred to a Special Bench (date, the question(s), result) with a table of the appeals decided (appeal
 *   number, appellant, respondent, order date, order PDF under /public/files/upload/). 24 orders from 2023 onwards were
 *   listed on 2026-10-02. The whole page is read on every pass (it is not in publication order).
 * Appeal numbers are printed per bench ("ITA 1413/BANG/2025"): only the caption's number binds, bench-qualified.
 */

const BASE = "https://itat.gov.in";
const HOSTS = ["itat.gov.in"];
export const ITAT_SB_URL = `${BASE}/judicial/sborders`;

export interface ItatSpecialBenchOrder {
  appealNo: string;
  appellant: string | null;
  respondent: string | null;
  orderDate: string | null;
  pdfUrl: string;
  /** Date printed on the Special Bench block (hearing / decision date as published). */
  blockDate: string | null;
  question: string | null;
  result: string | null;
}

/** "ITA 1413/BANG/2025" → bench "BANG"; null when the number does not print one. */
export function itatBench(appealNo: string): string | null {
  return /^[A-Z().\s]{2,20}?\s*\d{1,6}\s*\/\s*([A-Za-z]{2,10})\s*\/\s*(?:19|20)\d{2}$/.exec(clean(appealNo))?.[1]?.toUpperCase() ?? null;
}

/** Special Bench blocks → one record per decided appeal with an order PDF. */
export function parseItatSpecialBench(html: string, pageUrl: string): ItatSpecialBenchOrder[] {
  const out: ItatSpecialBenchOrder[] = [];
  const blocks = stripComments(html).split(/<div class="special-bench-case\b[^"]*">/i).slice(1);
  for (const b of blocks) {
    const issue = /<div class="special-bench-issue\b[^"]*"[\s\S]*?<div class="special-bench-issue-text">([\s\S]*?)<\/div>/i.exec(b);
    const head = /<div class="special-bench-issue\b[^"]*"[^>]*>\s*<div[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i.exec(b)?.[1] ?? "";
    const blockDate = printedDate(htmlText(head));
    const issueHtml = issue?.[1] ?? "";
    const result = clean(htmlText(/<p[^>]*class="[^"]*mandatory[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(issueHtml)?.[1] ?? "")) || null;
    const question = clean(htmlText(issueHtml.replace(/<p[^>]*class="[^"]*mandatory[^"]*"[^>]*>[\s\S]*?<\/p>/i, " "))) || null;
    for (const row of b.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = rowCells(row);
      if (cells.length < 5) continue;
      const a = /<a\b[^>]*>/i.exec(cells[4])?.[0];
      const pdfUrl = a ? safeUrl(attr(a, "href"), pageUrl, HOSTS) : null;
      if (!pdfUrl || !/\.pdf(?:$|[?#])/i.test(pdfUrl)) continue;
      const appealNo = clean(htmlText(cells[0]));
      if (!appealNo) continue;
      out.push({
        appealNo,
        appellant: clean(htmlText(cells[1])) || null,
        respondent: clean(htmlText(cells[2])) || null,
        orderDate: printedDate(htmlText(cells[3])),
        pdfUrl,
        blockDate,
        question: question ? limitText(question, 2000) : null,
        result,
      });
    }
  }
  return out;
}

export function itatDocs(rows: ItatSpecialBenchOrder[], listingUrl: string): DiscoveredDoc[] {
  return rows.map((r) => {
    // "ITA 1413/BANG/2025" is printed like "TYPE/123/BENCH/YEAR" once the type is joined with a slash, which the
    // shared normalizer keys bench-qualified ("ITA/1413/2025@BANG"), the same way NCLT bench numbers are keyed.
    const cn = caseNumbersFromTitle(`[${r.appealNo.replace(/^([A-Za-z().]{2,20})\s+(\d{1,6})\s*\//, "$1/$2/")}]`);
    const parties = [r.appellant, r.respondent].filter(Boolean).join(" v. ") || null;
    return {
      sourceId: "itat-orders",
      kind: "order",
      url: r.pdfUrl,
      fileUrl: r.pdfUrl,
      title: `ITAT Special Bench: ${r.appealNo}${parties ? ` (${parties})` : ""}`,
      docDate: r.orderDate,
      mime: "application/pdf",
      meta: {
        forum: "itat",
        track: "special-bench",
        bench: itatBench(r.appealNo),
        appealNo: r.appealNo,
        appellant: r.appellant,
        respondent: r.respondent,
        parties,
        orderDate: r.orderDate,
        specialBenchDate: r.blockDate,
        questionReferred: r.question,
        result: r.result,
        caseNumbers: [r.appealNo],
        caseKeys: cn.keys,
        caseKeysScope: CAPTION_SCOPE,
        listingUrl,
      },
    };
  });
}

const specialBench: ListingStream = {
  kind: "listing",
  id: "special-bench",
  backfill: true,
  firstPage: 1,
  incrementalPages: 1,
  markerless: true,
  async fetch(_page: number, ctx: AdapterContext): Promise<ListingPage> {
    const res = await ctx.fetchPage(ITAT_SB_URL);
    const rows = parseItatSpecialBench(res.html ?? "", res.finalUrl || ITAT_SB_URL);
    const notes = rows.length ? undefined : ["no Special Bench order rows could be read"];
    return { items: itatDocs(rows, ITAT_SB_URL), last: true, notes };
  },
};

export const def: SourceDef = {
  id: "itat-orders",
  name: "ITAT Special Bench orders",
  publisher: "Income Tax Appellate Tribunal",
  kinds: ["order"],
  forum: "itat",
  homepage: ITAT_SB_URL,
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "Special Bench orders as published by the Income Tax Appellate Tribunal (itat.gov.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Only Special Bench orders are ingested: the regular order search (by appeal number or bench and date) requires a CAPTCHA (checked 2026-10-02); CAPTCHAs are never bypassed.",
    "Appeal numbers bind only as printed in the order's own row, qualified by the bench code (\"ITA 1413/BANG/2025\").",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    return walkStreams(ctx, {
      async plan(_ctx, _mode, only) {
        return !only || only.includes("special-bench") ? ["special-bench"] : [];
      },
      stream: (id) => (id === "special-bench" ? specialBench : null),
    });
  },
};
