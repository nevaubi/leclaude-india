import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput, ParseResult, SourceAdapter } from "../../adapter";
import type { RemoteStore } from "@/lib/db/remote";
import type { DiscoveredDoc, SourceDef, SourceKind } from "../../types";
import { parseCaseNumbers } from "../../case-numbers";
import { printedDate } from "../../causelist/text";
import { decodeHtml, htmlText } from "@/modules/india/sources/parse-util";
import { mergeDocumentMeta } from "./common";
import { GOV_TERMS, addDays, pageOf } from "./shared";

/**
 * Supreme Court judgments and orders: the homepage "Judgments" / "Orders" tabs (latest 25 each) and /latest-orders/
 * (the latest 1,000 orders, about one or two days). Each entry reads
 *   "<PARTIES> - <Case No.> - Diary Number <N> / <YYYY> - <DD-Mon-YYYY> (Uploaded On <DD-MM-YYYY HH:MM:SS>)"
 * and links https://www.sci.gov.in/view-pdf/?diary_no={N}{YYYY}&type={j|o|fo}&order_date={date}&from=latest_judgements_order,
 * an HTML shell whose script loads the PDF from /sci-get-pdf/ with the same parameters (fileUrl, meta.fileUrlFromPattern).
 * The listing's printed diary number and date must agree with the link's parameters, otherwise the entry is skipped.
 * The date / diary / case-number search pages are CAPTCHA-protected and are not used.
 */

export const SCI_HOME = "https://www.sci.gov.in/";
export const SCI_LATEST_ORDERS = "https://www.sci.gov.in/latest-orders/";
const WINDOW_DAYS = 10;

const ENTRY_RE = /^(.*?)\s*-\s*Diary Number\s+(\d{1,7})\s*\/\s*(\d{4})\s*-\s*(\d{2}-[A-Za-z]{3}-\d{4})\s*\(Uploaded On (\d{2})-(\d{2})-(\d{4}) (\d{2}:\d{2}:\d{2})\)\s*$/;

/** Order / judgment entries listed on a Supreme Court page (homepage tabs or /latest-orders/). */
export function sciOrderItems(html: string, listing: "homepage" | "latest-orders", today?: string): { items: DiscoveredDoc[]; skipped: number } {
  const items: DiscoveredDoc[] = [];
  let skipped = 0;
  const re = /<a\b[^>]*href="(https:\/\/www\.sci\.gov\.in\/view-pdf\/\?[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const since = today ? addDays(today, -WINDOW_DAYS) : null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = decodeHtml(m[1]);
    let q: URL;
    try {
      q = new URL(href);
    } catch {
      skipped++;
      continue;
    }
    const diaryParam = q.searchParams.get("diary_no") ?? "";
    const type = (q.searchParams.get("type") ?? "").toLowerCase();
    const orderDate = q.searchParams.get("order_date") ?? "";
    const text = htmlText(m[2]);
    const e = ENTRY_RE.exec(text);
    if (!e || !/^[a-z]{1,3}$/.test(type)) {
      skipped++;
      continue;
    }
    const printed = printedDate(e[4]);
    if (diaryParam !== `${e[2]}${e[3]}` || !printed || printed !== orderDate) {
      skipped++;
      continue;
    }
    if (since && orderDate < since) continue;
    // "<parties> - <case no.>" (the case number may be empty: "<parties> - ").
    let head = e[1].trim();
    let caseNo: string | null = null;
    if (/\s-$/.test(head) || head.endsWith(" -")) head = head.replace(/\s*-$/, "").trim();
    else {
      const i = head.lastIndexOf(" - ");
      if (i > 0) {
        const tail = head.slice(i + 3).trim();
        if (parseCaseNumbers(tail).length) {
          caseNo = tail;
          head = head.slice(0, i).trim();
        }
      }
    }
    const cases = caseNo ? parseCaseNumbers(caseNo) : [];
    const kind: SourceKind = type === "j" ? "judgment" : "order";
    const fileUrl = `https://www.sci.gov.in/sci-get-pdf/?${q.searchParams.toString()}`;
    items.push({
      sourceId: "sci-orders",
      kind,
      url: href,
      fileUrl,
      title: `${head}${caseNo ? ` — ${caseNo}` : ""} (${kind === "judgment" ? "judgment" : "order"} ${e[4]})`,
      docDate: orderDate,
      mime: "application/pdf",
      meta: {
        forum: "sci",
        docKind: kind,
        diaryNo: `${Number(e[2])}/${e[3]}`,
        caseNumbers: cases.map((c) => c.printed),
        caseKeys: [...new Set(cases.flatMap((c) => c.keys))],
        parties: head,
        orderType: type,
        orderDate,
        uploadedAt: `${e[7]}-${e[6]}-${e[5]}T${e[8]}+05:30`,
        listing,
        fileUrlFromPattern: true,
      },
    });
  }
  return { items, skipped };
}

/** Neutral citation printed at the top of page 1 ("2026 INSC 1074"); null when absent. */
export function neutralCitationOf(doc: Pick<ParseInput, "pages" | "markdown">): string | null {
  const first = (doc.pages?.find((p) => p.page === 1)?.text ?? doc.markdown ?? "").slice(0, 600);
  const m = /(?:^|\n)\s*(?:REPORTABLE\s+)?(\d{4})\s+INSC\s+(\d{1,5})\b/i.exec(first);
  return m ? `${m[1]} INSC ${Number(m[2])}` : null;
}

const def: SourceDef = {
  id: "sci-orders",
  name: "Supreme Court judgments and daily orders",
  publisher: "Supreme Court of India",
  kinds: ["judgment", "order"],
  forum: "sci",
  homepage: SCI_LATEST_ORDERS,
  fetch: "firecrawl_in",
  cadenceMinutes: 60,
  attribution: "Judgment / order published by the Supreme Court of India (sci.gov.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "/latest-orders/ holds only the latest 1,000 orders (about one to two days): discovery must run at least daily or orders are missed.",
    "The judgment / order search pages are CAPTCHA-protected and are not used.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const notes: string[] = [];
    const all: DiscoveredDoc[] = [];
    const seen = new Set<string>();
    for (const [url, listing] of [[SCI_HOME, "homepage"], [SCI_LATEST_ORDERS, "latest-orders"]] as const) {
      try {
        const page = await ctx.fetchPage(url);
        const { items, skipped } = sciOrderItems(page.html ?? "", listing, ctx.today);
        if (skipped) notes.push(`${listing}: ${skipped} entries skipped (unreadable or link/date mismatch)`);
        for (const it of items) if (!seen.has(it.url)) { seen.add(it.url); all.push(it); }
      } catch (e) {
        notes.push(`${listing} unavailable: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    all.sort((a, b) => String(b.meta?.uploadedAt ?? "").localeCompare(String(a.meta?.uploadedAt ?? "")) || a.url.localeCompare(b.url));
    return pageOf(all, ctx, notes);
  },
  parse(doc: ParseInput): ParseResult {
    const nc = neutralCitationOf(doc);
    return { records: nc ? [{ neutralCitation: nc }] : [], unparsed: 0, notes: nc ? [] : ["no neutral citation on page 1"] };
  },
  async persist(store: RemoteStore, doc: ParseInput, result: ParseResult) {
    const nc = (result.records[0] as { neutralCitation?: unknown } | undefined)?.neutralCitation;
    return typeof nc === "string" && /^\d{4} INSC \d+$/.test(nc) ? mergeDocumentMeta(store, doc.id, { neutralCitation: nc }) : { stored: 0 };
  },
};
