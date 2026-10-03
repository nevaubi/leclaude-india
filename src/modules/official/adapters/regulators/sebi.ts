import "server-only";
import { normalizeCaseNumber } from "../../case-numbers";
import { CAPTION_SCOPE } from "../../causelist/forums";
import type { AdapterContext, ParseInput, ParseResult, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import {
  GOV_TERMS, attr, clean, decodeHtml, htmlText, printedDate, rowCells, safeUrl, stripComments, tableRows, walkStreams,
  type ListingPage, type ListingStream, type StreamSpec,
} from "./common";

/**
 * SEBI enforcement orders (sebi.gov.in), including SAT orders mirrored by SEBI under "Orders of SAT" (smid=1).
 *
 * Verified 2026-10-02:
 * - Listing page 1 (GET, server HTML, 25 rows): /sebiweb/home/HomeAction.do?doListing=yes&sid=2&ssid=9&smid={N}
 * - Older pages: POST /sebiweb/ajax/home/getnewslistinfo.jsp (application/x-www-form-urlencoded). The field names and
 *   order are those of SEBI's own `searchFormNewsList(v, v1)` in https://www.sebi.gov.in/js/entry.js; the response is
 *   "<listing html>#@#<breadcrumb html>". The pager's page argument (v1 → doDirect) is taken as the 0-based page index;
 *   every answer is checked against its "X to Y of N records" line and a mismatch stops the backfill (fail closed).
 * - RSS https://www.sebi.gov.in/sebirss.xml (~30 latest items across sections); only /enforcement/orders/ links are used.
 * - Detail page → PDF at /sebi_data/attachdocs/{mon-yyyy}/{NAME}_{ts}.pdf (iframe / viewer link), order number in the
 *   second <meta name="keywords">, category in the "Orders : <label>" line.
 */

const BASE = "https://www.sebi.gov.in";
const HOSTS = ["sebi.gov.in"];
export const SEBI_RSS_URL = `${BASE}/sebirss.xml`;
export const SEBI_PAGER_URL = `${BASE}/sebiweb/ajax/home/getnewslistinfo.jsp`;
const PAGE_SIZE = 25;

/** Enforcement order sub-sections ingested (smid → label as printed in SEBI's menu). smid 4 (RTI appeals) is excluded. */
export const SEBI_SMIDS: { smid: number; label: string; forum: "sebi" | "sat" }[] = [
  { smid: 1, label: "Orders of SAT", forum: "sat" },
  { smid: 2, label: "Orders of Chairperson/Members", forum: "sebi" },
  { smid: 3, label: "Settlement Order", forum: "sebi" },
  { smid: 5, label: "Orders of Corporatisation / Demutualisation Scheme", forum: "sebi" },
  { smid: 6, label: "Orders of AO", forum: "sebi" },
  { smid: 7, label: "Orders of Courts", forum: "sebi" },
  { smid: 77, label: "Orders Of Special Courts", forum: "sebi" },
  { smid: 133, label: "Orders of ED / CGM (Quasi-Judicial Authorities)", forum: "sebi" },
  { smid: 138, label: "Orders under Regulation 30A of the SEBI (Intermediaries) Regulations, 2008", forum: "sebi" },
];
/** Sub-sections seen under /enforcement/orders/ that are not ingested. */
const EXCLUDED_LABELS = ["Orders of AA under the RTI Act"];

const labelKey = (s: string) => clean(s).toLowerCase().replace(/\s*\/\s*/g, "/");

export function sebiListingUrl(smid: number): string {
  return `${BASE}/sebiweb/home/HomeAction.do?doListing=yes&sid=2&ssid=9&smid=${smid}`;
}

/** The exact field set SEBI's own pager sends (entry.js searchFormNewsList), for a 1-based page > 1. */
export function sebiPagerFields(smid: number, page: number): Record<string, string> {
  const label = SEBI_SMIDS.find((s) => s.smid === smid)?.label ?? "";
  return {
    nextValue: "1",
    next: "n",
    search: "",
    fromDate: "",
    toDate: "",
    fromYear: "",
    toYear: "",
    deptId: "-1",
    sid: "2",
    ssid: "9",
    smid: String(smid),
    ssidhidden: "9",
    intmid: "-1",
    sText: "Enforcement",
    ssText: "Orders",
    smText: label,
    doDirect: String(page - 1),
  };
}

/** "1 to 25 of 12008 records" → numbers; null when absent. */
export function sebiPagerRange(html: string): { from: number; to: number; total: number } | null {
  const m = /(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+records/i.exec(htmlText(html));
  return m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) } : null;
}

/** Listing rows (date | linked title) → detail-page items (PDF resolved later from the detail page). */
export function parseSebiListing(html: string, smid: number | null, pageUrl: string): DiscoveredDoc[] {
  const sub = smid != null ? SEBI_SMIDS.find((s) => s.smid === smid) : undefined;
  const out: DiscoveredDoc[] = [];
  for (const row of tableRows(html)) {
    const cells = rowCells(row);
    if (cells.length < 2) continue;
    const a = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(cells[1]);
    if (!a) continue;
    const url = safeUrl(attr(a[0], "href"), pageUrl, HOSTS);
    if (!url || !/\/enforcement\/orders\//.test(url)) continue;
    const title = clean(htmlText(a[1])) || clean(attr(a[0], "title"));
    const docDate = printedDate(htmlText(cells[0]));
    if (!title) continue;
    out.push({
      sourceId: "sebi-orders",
      kind: "order",
      url,
      fileUrl: null,
      title,
      docDate,
      meta: { forum: sub?.forum ?? "sebi", smid: sub?.smid ?? null, category: sub?.label ?? null, listingUrl: pageUrl },
    });
  }
  return out;
}

/** RSS items that are enforcement orders. */
export function parseSebiRss(xml: string): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = m[1];
    const tag = (t: string) => {
      const v = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(body)?.[1] ?? "";
      return clean(decodeHtml(v.replace(/^<!\[CDATA\[|\]\]>$/g, "")));
    };
    const url = safeUrl(tag("link"), BASE, HOSTS);
    if (!url || !/\/enforcement\/orders\//.test(url)) continue;
    const title = tag("title");
    if (!title) continue;
    out.push({
      sourceId: "sebi-orders",
      kind: "order",
      url,
      fileUrl: null,
      title,
      docDate: printedDate(tag("pubDate")),
      meta: { forum: "sebi", smid: null, category: null, via: "rss" },
    });
  }
  return out;
}

export interface SebiDetail {
  pdfUrl: string | null;
  orderNumber: string | null;
  category: string | null;
  date: string | null;
}

/** Detail page → PDF URL (attachdocs), order number (meta keywords), category label, date. */
export function parseSebiDetail(raw: string, pageUrl: string): SebiDetail {
  const html = stripComments(raw);
  const main = html.split(/<div[^>]+data-original-tag="iframe"/i)[0] ?? html;
  let pdfUrl: string | null = null;
  const viewer = /web\/\?file=(https?:\/\/[^"'#\s<>]+?\.pdf)/i.exec(html)?.[1] ?? null;
  const direct = /(https?:\/\/(?:www\.)?sebi\.gov\.in)?(\/sebi_data\/attachdocs\/[^"'#?\s<>]+?\.pdf)/i.exec(main);
  pdfUrl = safeUrl(viewer, pageUrl, HOSTS) ?? (direct ? safeUrl(direct[2], pageUrl, HOSTS) : null);
  if (pdfUrl && !/\/sebi_data\//.test(pdfUrl)) pdfUrl = null;
  const keywords = [...html.matchAll(/<meta\s+name="keywords"\s+content="([^"]*)"/gi)].map((m) => clean(decodeHtml(m[1])));
  const orderNumber = keywords.find((k) => k && !/^Securities and Exchange Board of India/i.test(k) && /\d/.test(k)) ?? null;
  const idArea = /<div class="id_area">([\s\S]*?)<\/div>/i.exec(main)?.[1] ?? "";
  const spans = [...idArea.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => clean(htmlText(m[1])));
  const category = spans.length >= 2 ? spans[spans.length - 1] : null;
  const date = printedDate(htmlText(/<div class="date_value">\s*<h5>([\s\S]*?)<\/h5>/i.exec(main)?.[1] ?? ""));
  return { pdfUrl, orderNumber, category, date };
}

/** Fill a listing / RSS item from its detail page; null when the page says it belongs to an excluded sub-section. */
export async function resolveSebiItem(d: DiscoveredDoc, ctx: AdapterContext): Promise<DiscoveredDoc | null> {
  const page = await ctx.fetchPage(d.url);
  const det = parseSebiDetail(page.html ?? "", page.finalUrl || d.url);
  const cat = det.category ? labelKey(det.category) : null;
  if (cat && EXCLUDED_LABELS.some((l) => labelKey(l) === cat)) return null;
  const sub = cat ? SEBI_SMIDS.find((s) => labelKey(s.label) === cat) : undefined;
  const meta = { ...(d.meta ?? {}) };
  if (sub) Object.assign(meta, { smid: sub.smid, category: sub.label, forum: sub.forum });
  else if (det.category) meta.category = det.category;
  Object.assign(meta, { orderNumber: det.orderNumber, pdfLinkFound: !!det.pdfUrl });
  return {
    ...d,
    fileUrl: det.pdfUrl,
    mime: det.pdfUrl ? "application/pdf" : "text/html",
    docDate: d.docDate ?? det.date,
    meta,
  };
}

function rssStream(): ListingStream {
  return {
    kind: "listing",
    id: "rss",
    backfill: false,
    firstPage: 1,
    incrementalPages: 1,
    async fetch(_page: number, ctx: AdapterContext): Promise<ListingPage> {
      const res = await ctx.fetchPage(SEBI_RSS_URL);
      return { items: parseSebiRss(res.html ?? ""), last: true };
    },
  };
}

function smidStream(smid: number): ListingStream {
  return {
    kind: "listing",
    id: `smid:${smid}`,
    backfill: true,
    firstPage: 1,
    incrementalPages: 2,
    async fetch(page: number, ctx: AdapterContext): Promise<ListingPage> {
      const listingUrl = sebiListingUrl(smid);
      if (page === 1) {
        const res = await ctx.fetchPage(listingUrl);
        const html = res.html ?? "";
        const range = sebiPagerRange(html);
        return { items: parseSebiListing(html, smid, listingUrl), last: !range || range.to >= range.total };
      }
      const res = await ctx.postForm(SEBI_PAGER_URL, sebiPagerFields(smid, page), { headers: { Referer: listingUrl } });
      const listing = res.text.split("#@#")[0] ?? "";
      const range = sebiPagerRange(listing);
      const expected = (page - 1) * PAGE_SIZE + 1;
      if (res.status >= 400 || !range || range.from !== expected) {
        return {
          items: [],
          last: true,
          notes: [`pager answer for page ${page} did not match (expected rows from ${expected}, got ${range ? range.from : "no range"}, HTTP ${res.status}); backfill stopped here.`],
        };
      }
      return { items: parseSebiListing(listing, smid, listingUrl), last: range.to >= range.total };
    },
  };
}

/** Publisher-maintained legal editions, not Gazette backfill. Dates and amendment labels remain distinct. */
export function parseSebiLegalListing(html:string, collection:'regulations'|'master-circulars', pageUrl:string):DiscoveredDoc[] {
  const items:DiscoveredDoc[]=[];
  for(const row of tableRows(html)) {
    const cells=[...row.matchAll(/<td\b[^>]*>([\s\S]*?)(?:<\/td>|(?=<td\b|<\/tr>))/gi)].map(m=>m[1]); if(cells.length<2)continue;
    const anchor=/<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(cells[1]); if(!anchor)continue;
    const url=safeUrl(attr(anchor[0],'href'),pageUrl,HOSTS);
    if(!url || !new URL(url).pathname.startsWith('/legal/'+collection+'/'))continue;
    const title=clean(htmlText(anchor[1]));if(!title)continue;
    const datePrinted=clean(htmlText(cells[0]));
    const editionLabel=/\[([^\]]*(?:amend|updated)[^\]]*)\]/i.exec(title)?.[1]??null;
    items.push({sourceId:'sebi-orders',kind:collection==='regulations'?'regulation':'circular',url,fileUrl:null,title,
      docDate:/^\d{4}$/.test(datePrinted)?null:printedDate(datePrinted),
      meta:{forum:'sebi',collection,listingUrl:pageUrl,datePrinted,editionLabel,versionBasis:editionLabel?'publisher_title':'publication_date',legalStatus:'not_independently_verified',publisherListing:'updated',observedAt:new Date().toISOString()}});
  }
  return items;
}
function legalStream(collection:'regulations'|'master-circulars'):ListingStream {
  const ssid=collection==='regulations'?3:6;
  const url=BASE+'/sebiweb/home/HomeAction.do?doListing=yes&sid=1&smid=0&ssid='+ssid;
  return {kind:'listing',id:'legal:'+collection,backfill:true,firstPage:1,incrementalPages:1,
    async fetch(page,ctx) {
      if(collection==='regulations' && page>1)return {items:[],last:true};
      const html=page===1?(await ctx.fetchPage(url)).html??'':(await ctx.postForm(SEBI_PAGER_URL,{...sebiPagerFields(0,page),sid:'1',ssid:String(ssid),ssidhidden:String(ssid),sText:'Legal',ssText:'Master Circulars',smText:''},{headers:{Referer:url}})).text.split('#@#')[0];
      const range=sebiPagerRange(html);
      if(page>1 && (!range||range.from!==(page-1)*PAGE_SIZE+1)) throw new Error('SEBI legal pagination did not match requested page');
      const items=parseSebiLegalListing(html,collection,url);
      if(page===1&&!items.length)throw new Error('SEBI legal listing returned no readable records; coverage unknown');
      return {items,last:collection==='regulations'||!range||range.to>=range.total};
    }};
}

const STREAMS = new Map<string, StreamSpec>([["legal:regulations", legalStream("regulations")], ["legal:master-circulars", legalStream("master-circulars")], ["rss", rssStream()], ...SEBI_SMIDS.map((s) => [`smid:${s.smid}`, smidStream(s.smid)] as const)]);

/**
 * Appeal numbers as printed: SAT's own form ("Appeal No. 123 of 2025", "Misc. Appeal No. …") and, as `qualifier`,
 * the forms of other courts that end in "Appeal No." ("Civil Appeal No. 7890 of 2020" of the Supreme Court).
 */
const APPEAL_RE = /\b((?:Civil|Criminal|Crl\.?|Second|First|Regular|Special\s+Leave|Letters\s+Patent|Company|Comp\.?|Competition|Insolvency|Income[\s-]?Tax|Tax|Writ|Execution|Arbitration)\s+)?((?:Misc\.?\s+)?Appeal\s+No\.?\s*\d{1,6}\s*(?:of|\/)\s*(?:19|20)\d{2})/gi;

/**
 * Where the body of a SAT order starts: "CORAM" (always printed above the order on SAT orders), the parties' "Versus",
 * or an upper-case ORDER / JUDGMENT heading ("ORDER RESERVED ON …", "ORDER DATED …" are dates, not the heading).
 */
const SAT_BODY_START = /\b(?:CORAM|Coram)\b|\b(?:Versus|VERSUS)\b|\bJ\s?U\s?D\s?G\s?E?\s?M\s?E\s?N\s?T\b|\bO\s?R\s?D\s?E\s?R\b(?!\s+(?:dated|DATED|Dated|passed|PASSED|reserved|RESERVED|Reserved|pronounced|PRONOUNCED|Pronounced|on|ON))/;

/** Case numbers that may sit between caption appeal numbers: Misc. Applications, I.A.s, other appeals of the caption. */
const CAPTION_NUMBER_RE = /\b(?:(?:Misc(?:ellaneous)?\.?\s+)?(?:Application|Appeal)s?|M\.?\s?A\.?|I\.?\s?A\.?)\s*(?:Nos?\.?)?\s*\d{1,6}(?:\s*(?:,|&|and)\s*\d{1,6})*\s*(?:of|\/)\s*(?:19|20)\d{2}/gi;

/** Whether the text between two caption parts joins them: connectors, punctuation, bracketed asides and case numbers only. */
function joinsCaption(gap: string): boolean {
  let g = gap;
  for (let i = 0; i < 6 && /\([^()]*\)|\[[^[\]]*\]/.test(g); i++) g = g.replace(/\([^()]*\)|\[[^[\]]*\]/g, " ");
  g = g.replace(CAPTION_NUMBER_RE, " ");
  return /^(?:[\s,;:&.\-–]|\b(?:with|and|in|along\s*with|alongwith|connected\s+with|tagged\s+with)\b)*$/i.test(g);
}

export interface SatCaptionNumbers {
  /** Appeal numbers of the order's own caption, as printed (they bind the order to those appeals). */
  printed: string[];
  keys: string[];
  /** Every other appeal number on the first pages (cited precedents, other courts' appeals): never bound. */
  mentioned: string[];
  mentionedKeys: string[];
}

/**
 * The caption appeal numbers of a SAT order (text of its first pages). Caption: the first SAT-form appeal number
 * printed before the body starts (CORAM / Versus / ORDER heading); then every further SAT-form number that is joined to
 * the previous caption number only by connectors and case numbers, or — above CORAM, where SAT prints nothing but the
 * caption, parties and counsel — that starts its own line (after any "With" / "And" / "In"). Numbers qualified by
 * another court's type ("Civil Appeal No.") and every number in the body are mentioned only.
 */
export function satCaptionAppeals(text: string): SatCaptionNumbers {
  const head = text.slice(0, 12_000);
  const out: SatCaptionNumbers = { printed: [], keys: [], mentioned: [], mentionedKeys: [] };
  const body = SAT_BODY_START.exec(head);
  const bodyAt = body ? body.index : head.length;
  const coram = /\b(?:CORAM|Coram)\b/.exec(head);
  const coramAt = coram ? coram.index : -1;
  let inCaption = true;
  let prevEnd = -1;
  for (const m of head.matchAll(APPEAL_RE)) {
    const printed = clean(m[0]);
    const at = (m.index ?? 0) + (m[1]?.length ?? 0);
    let caption = false;
    if (!m[1] && inCaption) {
      if (prevEnd < 0) {
        // The caption's first number is printed above the body; a page whose first number follows it has no caption number.
        caption = at < bodyAt;
        inCaption = caption;
      } else {
        const lineStart = head.lastIndexOf("\n", at - 1) + 1;
        const ownLineAboveCoram = at < coramAt && lineStart >= prevEnd && joinsCaption(head.slice(lineStart, at));
        caption = ownLineAboveCoram || joinsCaption(head.slice(prevEnd, at));
        // Above CORAM a number that is not part of the caption (rare) does not end it; below, the caption is over.
        if (!caption && !(at < coramAt)) inCaption = false;
      }
    }
    if (caption) prevEnd = at + m[2].length;
    if (out.printed.includes(printed) || out.mentioned.includes(printed)) continue;
    const n = normalizeCaseNumber(printed);
    if (caption) {
      out.printed.push(printed);
      if (n && !out.keys.includes(n.key)) out.keys.push(n.key);
    } else {
      out.mentioned.push(printed);
      if (n && !out.keys.includes(n.key) && !out.mentionedKeys.includes(n.key)) out.mentionedKeys.push(n.key);
    }
  }
  return out;
}

/**
 * Order numbers ("Order/AK/GN/2026-27/32758", "WTM/AN/MIRSD/...") and, for SAT orders (forum "sat"), the caption's
 * appeal numbers. Only the caption binds (meta.caseKeys, meta.caseKeysScope "caption"); appeal numbers cited further
 * down, and every appeal number of a non-SAT order, are kept as meta.mentionedCaseKeys, which never bind. Always one
 * record, so a re-parse replaces keys an earlier parse stored.
 */
export function parseSebiOrderText(doc: ParseInput): ParseResult<{ meta: Record<string, unknown> }> {
  const text = doc.pages.slice(0, 2).map((p) => p.text).join("\n") || doc.markdown.slice(0, 20000);
  const orderNumbers = [...new Set([...text.matchAll(/ORDER\s+NO\.?\s*[:.-]?\s*([A-Z][A-Za-z]{1,10}(?:\/[A-Za-z0-9-]{1,20}){2,8})/gi)].map((m) => m[1]))];
  const sat = doc.meta?.forum === "sat";
  const found = satCaptionAppeals(text);
  const caption = sat ? found : { printed: [], keys: [], mentioned: [...found.printed, ...found.mentioned], mentionedKeys: [...found.keys, ...found.mentionedKeys] };
  const meta = {
    orderNumbers,
    appealNumbers: caption.printed,
    caseKeys: caption.keys,
    caseKeysScope: CAPTION_SCOPE,
    mentionedAppealNumbers: caption.mentioned,
    mentionedCaseKeys: caption.mentionedKeys,
    caseNumbersFrom: "caption",
  };
  const notes = sat && !caption.keys.length ? ["no SAT appeal number in the caption; not bound to any appeal"] : [];
  return { records: [{ meta }], unparsed: orderNumbers.length || caption.printed.length ? 0 : 1, notes };
}

export const def: SourceDef = {
  id: "sebi-orders",
  name: "SEBI regulations, circulars & orders",
  publisher: "Securities and Exchange Board of India",
  kinds: ["order", "regulation", "circular"],
  forum: "sebi",
  homepage: "https://www.sebi.gov.in/legal.html",
  fetch: "direct",
  cadenceMinutes: 360,
  attribution: "Orders as published by the Securities and Exchange Board of India (sebi.gov.in); SAT orders as mirrored by SEBI under \"Orders of SAT\".",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Incremental: SEBI RSS plus page 1 of each order sub-section; older pages use SEBI's own listing form (POST) and stop at the first answer that does not match the requested page.",
    "SAT orders come from SEBI's mirror (forum \"sat\"); the SAT portal itself is CAPTCHA-gated and is not automated.",
    "Orders of the Appellate Authority under the RTI Act are excluded.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    return walkStreams(ctx, {
      async plan(_ctx, mode, only) {
        const ids = [...STREAMS.keys()].filter((id) => mode === "incremental" || id !== "rss");
        return only ? ids.filter((id) => only.includes(id)) : ids;
      },
      stream: (id) => STREAMS.get(id) ?? null,
      key: (d) => d.url,
      resolve: resolveSebiItem,
    });
  },
  parse: parseSebiOrderText,
};
