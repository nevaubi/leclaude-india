import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput, ParseResult, SourceAdapter } from "../../adapter";
import type { RemoteStore } from "@/lib/db/remote";
import type { CauseListType, DiscoveredDoc, SourceDef, SourceKind } from "../../types";
import { CAPTION_SCOPE, NCLAT_COURTS, type NclatCourt } from "../../causelist/forums";
import { parseCaseNumber } from "../../case-numbers";
import { printedDate, squash } from "../../causelist/text";
import { decodeHtml } from "@/modules/india/sources/parse-util";
import { calendarParse, calendarPersist, causeListParse, causeListPersist, docText, mergeDocumentMeta } from "./common";
import { GOV_TERMS, addDays, anchors, markRefetch, runQueries, tableRows } from "./shared";

/**
 * National Company Law Appellate Tribunal (https://nclat.nic.in).
 *
 * - Daily cause lists: /daily-cause-list is a Drupal view with GET filters (court id, final date from / to as
 *   YYYY-MM-DD; verified 2026-10-02). Table: Sr. No. | Court Name | Description | Date (DD/MM/YYYY) | View/Download.
 * - Latest judgments and daily orders: homepage links to /display-board/view_order_pdf?fid=..&&l={delhi|chennai}&&d=
 *   {date}&&order_type={J|D}; the anchor text is the parties' names only, so case numbers are read from page 1 of the
 *   PDF and merged into the document's metadata. Only the caption binds (meta.caseKeys, meta.caseKeysScope "caption"):
 *   the first appeal number, plus the numbers joined to it by "With" / "&" / brackets before the parties; appeal
 *   numbers cited further down (tagged matters, earlier orders) are kept as meta.mentionedCaseKeys, which never bind.
 * - Calendar: /calendar links the year PDF.
 * The judgment / order search screens need a session and CSRF token and are not used.
 */

export const NCLAT_HOME = "https://nclat.nic.in/";
export const NCLAT_CALENDAR = "https://nclat.nic.in/calendar";

export function nclatListUrl(courtId: number, from: string, to: string): string {
  return `https://nclat.nic.in/daily-cause-list?title=&field_court_name_target_id=${courtId}&field_final_date_value=${from}&field_final_date_value_1=${to}`;
}

/** Daily cause-list rows → documents. */
export function nclatListingItems(html: string, court: NclatCourt): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const row of tableRows(html)) {
    if (row.cells.length < 5) continue;
    const description = row.cells[2].trim();
    const date = printedDate(row.cells[3].trim());
    const link = anchors(row.cellHtml[4] ?? "", NCLAT_HOME).find((a) => /\.pdf(?:$|\?)/i.test(a.href));
    if (!description || !date || !link || out.some((d) => d.url === link.href)) continue;
    const listType: CauseListType = /supp/i.test(description) ? "supplementary" : "main";
    out.push({
      sourceId: "nclat",
      kind: "cause_list",
      url: link.href,
      fileUrl: link.href,
      title: `NCLAT — ${description}`,
      docDate: date,
      mime: "application/pdf",
      meta: { forum: court.forum, docKind: "cause_list", listType, listDate: date, court: court.court, courtName: row.cells[1].trim() || null, courtId: court.id },
    });
  }
  return out;
}

/** Homepage judgment / daily-order links → documents. Unknown locations or order types are skipped. */
export function nclatOrderItems(html: string, since: string | null): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  const re = /<a\b[^>]*href="(https:\/\/nclat\.nic\.in\/display-board\/view_order_pdf\?[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = decodeHtml(m[1]);
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    const fid = u.searchParams.get("fid") ?? "";
    const loc = u.searchParams.get("l") ?? "";
    const date = u.searchParams.get("d") ?? "";
    const type = u.searchParams.get("order_type") ?? "";
    if (!/^\d{6,20}$/.test(fid) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !printedDate(date)) continue;
    const forum = loc === "delhi" ? "nclat-delhi" : loc === "chennai" ? "nclat-chennai" : null;
    const kind: SourceKind | null = type === "J" ? "judgment" : type === "D" ? "order" : null;
    if (!forum || !kind || (since && date < since) || out.some((d) => d.url === href)) continue;
    const parties = squash(decodeHtml(m[2].replace(/<[^>]+>/g, " ")));
    out.push({
      sourceId: "nclat",
      kind,
      url: href,
      fileUrl: href,
      title: `${parties || "NCLAT"} (${kind === "judgment" ? "judgment" : "daily order"} ${date})`,
      docDate: date,
      mime: "application/pdf",
      meta: { forum, docKind: kind, fid, orderType: type, orderDate: date, parties: parties || null },
    });
  }
  return out;
}

const APPEAL_RE = /\b(?:Comp(?:any)?\.?\s*App(?:eal)?\.?|Competition\s+App(?:eal)?\.?|Insolvency\s+App(?:eal)?\.?)\s*\(\s*AT\s*\)(?:\s*\(\s*(?:CH|Ch|Ins|Insolvency|INS)\.?\s*\))*\s*No\.?\s*\d{1,6}\s*(?:of|\/)\s*(?:19|20)\d{2}/gi;

/**
 * Where the body starts: the parties block ("IN THE MATTER OF", "Versus") or the upper-case order / judgment heading
 * ("ORDER", "J U D G M E N T"; not "ORDER DATED" inside an "Arising out of" note). The caption is printed above it.
 */
const BODY_START = /\b[Ii][Nn]\s+[Tt][Hh][Ee]\s+[Mm][Aa][Tt][Tt][Ee][Rr]\s+[Oo][Ff]\b|\b(?:Versus|VERSUS)\b|\bJ\s?U\s?D\s?G\s?E?\s?M\s?E\s?N\s?T\b|\bO\s?R\s?D\s?E\s?R\b(?!\s+(?:dated|DATED|Dated|passed|PASSED))/;

/**
 * Whether the text between two appeal numbers joins them in one caption: only connectors ("With", "&", "and",
 * "Along with", "Connected with", "Tagged with"), punctuation, I.A. numbers and bracketed asides ("[Arising out of ...]",
 * "(IA No. 456/2025)"). Anything else (parties, "Present", the order's text) ends the caption.
 */
function joinsCaption(gap: string): boolean {
  let g = gap;
  for (let i = 0; i < 6 && /\([^()]*\)|\[[^[\]]*\]/.test(g); i++) g = g.replace(/\([^()]*\)|\[[^[\]]*\]/g, " ");
  g = g.replace(/\bI\.?\s*A\.?\s*(?:Nos?\.?)?\s*\d{1,6}(?:\s*(?:,|&|and)\s*\d{1,6})*\s*(?:of|\/)\s*(?:19|20)\d{2}/gi, " ");
  return /^(?:[\s,;:&.\-\u2013]|\b(?:with|and|along\s*with|alongwith|connected\s+with|tagged\s+with)\b)*$/i.test(g);
}

export interface NclatPageNumbers {
  /** Appeal numbers of the caption, as printed (bind the order to those appeals). */
  printed: string[];
  keys: string[];
  /** Other appeal numbers printed on page 1 (cited, tagged, earlier orders): kept for display, never bound. */
  mentioned: string[];
  mentionedKeys: string[];
}

/**
 * NCLAT appeal numbers on page 1 of a judgment / order. The caption is the first appeal number, provided it is printed
 * before the parties / order heading, plus the numbers joined to it (see joinsCaption); every other appeal number on
 * the page is "mentioned" only. A page whose first appeal number follows the parties block has no caption number.
 */
export function nclatAppealNumbers(text: string): NclatPageNumbers {
  const head = text.slice(0, 2500);
  const out: NclatPageNumbers = { printed: [], keys: [], mentioned: [], mentionedKeys: [] };
  const body = BODY_START.exec(head);
  const bodyAt = body ? body.index : head.length;
  let inCaption = true;
  let prevEnd = -1;
  for (const m of head.matchAll(APPEAL_RE)) {
    const p = parseCaseNumber(squash(m[0]));
    if (!p.normalized) continue;
    const at = m.index ?? 0;
    if (inCaption) inCaption = prevEnd < 0 ? at < bodyAt : joinsCaption(head.slice(prevEnd, at));
    prevEnd = at + m[0].length;
    const [printed, keys] = inCaption ? [out.printed, out.keys] : [out.mentioned, out.mentionedKeys];
    if (out.printed.includes(p.printed) || out.mentioned.includes(p.printed)) continue;
    printed.push(p.printed);
    for (const k of p.keys) if (!out.keys.includes(k) && !keys.includes(k)) keys.push(k);
  }
  return out;
}

/** Calendar PDFs linked from /calendar. */
export function nclatCalendarItems(html: string, minYear: number): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const a of anchors(html, NCLAT_HOME)) {
    if (!/\.pdf(?:$|\?)/i.test(a.href) || !/calend/i.test(`${a.href} ${a.text}`)) continue;
    const y = /(20\d{2})/.exec(decodeURIComponent(a.href)) ?? /(20\d{2})/.exec(a.text);
    if (!y || Number(y[1]) < minYear || out.some((d) => d.url === a.href)) continue;
    out.push({
      sourceId: "nclat",
      kind: "calendar",
      url: a.href,
      fileUrl: a.href,
      title: `National Company Law Appellate Tribunal — Calendar ${y[1]}`,
      docDate: `${y[1]}-01-01`,
      mime: "application/pdf",
      meta: { forum: "nclat", docKind: "calendar", format: "pdf", year: Number(y[1]) },
    });
  }
  return out;
}

const def: SourceDef = {
  id: "nclat",
  name: "NCLAT cause lists, judgments and daily orders",
  publisher: "National Company Law Appellate Tribunal",
  kinds: ["cause_list", "judgment", "order", "calendar"],
  forum: "nclat",
  homepage: NCLAT_HOME,
  fetch: "firecrawl_in",
  cadenceMinutes: 120,
  attribution: "Published by the National Company Law Appellate Tribunal (nclat.nic.in). Lists are not authoritative.",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Only the latest judgments and daily orders shown on the homepage tabs are discovered (about 20 links, Principal and Chennai benches).",
    "Judgment / order search needs a session and CSRF token and is not used.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const from = addDays(ctx.today, -1);
    const to = addDays(ctx.today, 10);
    const year = Number(ctx.today.slice(0, 4));
    return runQueries(ctx, NCLAT_COURTS.length + 2, async (i) => {
      if (i < NCLAT_COURTS.length) {
        const court = NCLAT_COURTS[i];
        const page = await ctx.fetchPage(nclatListUrl(court.id, from, to));
        return markRefetch(nclatListingItems(page.html ?? "", court), ctx.today);
      }
      if (i === NCLAT_COURTS.length) {
        const page = await ctx.fetchPage(NCLAT_HOME);
        return nclatOrderItems(page.html ?? "", addDays(ctx.today, -14));
      }
      const page = await ctx.fetchPage(NCLAT_CALENDAR);
      return markRefetch(nclatCalendarItems(page.html ?? "", year - 1), ctx.today);
    });
  },
  parse(doc: ParseInput): ParseResult {
    const kind = doc.meta.docKind;
    if (kind === "calendar") return calendarParse(doc, { forum: "nclat", format: "pdf" });
    if (kind === "judgment" || kind === "order") {
      const first = doc.pages?.find((p) => p.page === 1)?.text ?? docText(doc);
      const found = nclatAppealNumbers(first);
      // Always one record: an order with no caption number still replaces keys an earlier parse may have stored.
      return { records: [found], unparsed: found.keys.length ? 0 : 1, notes: found.keys.length ? [] : ["no NCLAT appeal number in the caption on page 1; not bound to any appeal"] };
    }
    return causeListParse(doc, { layout: "tribunal" });
  },
  async persist(store: RemoteStore, doc: ParseInput, result: ParseResult) {
    const kind = doc.meta.docKind;
    if (kind === "calendar") return calendarPersist(store, doc, result);
    if (kind === "judgment" || kind === "order") {
      const r = result.records[0] as Partial<Record<keyof NclatPageNumbers, unknown>> | undefined;
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      if (!r) return { stored: 0 };
      // caseKeys holds the caption only (scope "caption"); cited numbers go to keys that are never queried for binding.
      return mergeDocumentMeta(store, doc.id, {
        caseNumbers: strings(r.printed),
        caseKeys: strings(r.keys),
        caseKeysScope: CAPTION_SCOPE,
        mentionedCaseNumbers: strings(r.mentioned),
        mentionedCaseKeys: strings(r.mentionedKeys),
        caseNumbersFrom: "page1",
      });
    }
    return causeListPersist(store, doc, result);
  },
};
