import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput, ParseResult, SourceAdapter } from "../../adapter";
import type { RemoteStore } from "@/lib/db/remote";
import type { DiscoveredDoc, SourceDef } from "../../types";
import { NCLT_BENCHES, type NcltBench } from "../../causelist/forums";
import { printedDate } from "../../causelist/text";
import { calendarParse, calendarPersist, causeListParse, causeListPersist } from "./common";
import { GOV_TERMS, addDays, anchors, drupalCell, mdy, runQueries } from "./shared";

/**
 * National Company Law Tribunal (https://nclt.gov.in).
 *
 * - Cause lists: /all-cause-list is a Drupal view with GET filters (bench id, start / end date as MM/DD/YYYY). One
 *   narrow date window per bench (yesterday .. +10 days) instead of walking ~1,800 pages whose order is unstable;
 *   documents are deduplicated by href. "No. of Entries" is kept (meta.entriesCount) to check parsed item counts.
 * - Weekly registry defect lists (/list-of-objection-list): kind defect_list (text only).
 * - Calendar (/nclt-calender): the year PDF, kind calendar (forum "nclt", applies to every bench).
 * The order-date-wise search is CAPTCHA-protected and is not used.
 */

export const NCLT_BASE = "https://nclt.gov.in/";
export const NCLT_DEFECTS = "https://nclt.gov.in/list-of-objection-list";
export const NCLT_CALENDAR = "https://nclt.gov.in/nclt-calender";

export function ncltListUrl(benchId: number, from: string, to: string): string {
  return `https://nclt.gov.in/all-cause-list?field_nclt_benches_list_target_id=${benchId}&field_cause_date_value=${mdy(from)}&field_cause_date_value_1=${mdy(to)}`;
}

const BENCH_FORUMS: [RegExp, string][] = [
  [/principal bench/i, "nclt-principal"],
  [/new delhi/i, "nclt-new-delhi"],
  [/ahmedabad/i, "nclt-ahmedabad"],
  [/allahabad|prayagraj/i, "nclt-allahabad"],
  [/amaravati/i, "nclt-amaravati"],
  [/bengaluru|bangalore/i, "nclt-bengaluru"],
  [/chandigarh/i, "nclt-chandigarh"],
  [/chennai/i, "nclt-chennai"],
  [/cuttack/i, "nclt-cuttack"],
  [/guwahati/i, "nclt-guwahati"],
  [/hyderabad/i, "nclt-hyderabad"],
  [/indore/i, "nclt-indore"],
  [/jaipur/i, "nclt-jaipur"],
  [/kochi/i, "nclt-kochi"],
  [/kolkata/i, "nclt-kolkata"],
  [/mumbai/i, "nclt-mumbai"],
];

/** Bench forum key named in a printed label ("Indore Bench Court-I" → "nclt-indore"); "nclt" when none is named. */
export function ncltForumOf(label: string): string {
  for (const [re, f] of BENCH_FORUMS) if (re.test(label)) return f;
  return "nclt";
}

/** Rows of an /all-cause-list result page → cause-list documents. */
export function ncltListingItems(html: string, bench: NcltBench | null): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const row = m[0];
    const title = drupalCell(row, "title")?.text;
    const court = drupalCell(row, "field-nclt-benches-list")?.text ?? "";
    const entries = drupalCell(row, "field-no-of-entries")?.text ?? "";
    const date = printedDate(drupalCell(row, "field-cause-date")?.text ?? "");
    const file = drupalCell(row, "field-upload-file");
    const link = file ? anchors(file.html, NCLT_BASE).find((a) => /\.pdf(?:$|\?)/i.test(a.href)) : null;
    if (!title || !date || !link || out.some((d) => d.url === link.href)) continue;
    const forum = bench?.forum ?? ncltForumOf(court || title);
    const count = /^\d+$/.test(entries.trim()) ? Number(entries.trim()) : null;
    out.push({
      sourceId: "nclt",
      kind: "cause_list",
      url: link.href,
      fileUrl: link.href,
      title,
      docDate: date,
      mime: "application/pdf",
      meta: {
        forum,
        docKind: "cause_list",
        listType: "daily",
        listDate: date,
        bench: court || null,
        benchId: bench?.id ?? null,
        court: bench?.court ?? (/court[- ]?([IVX]+|\d+)\b/i.exec(court)?.[1]?.toUpperCase() ?? null),
        entriesCount: count,
      },
    });
  }
  return out;
}

/** Weekly registry defect lists → defect_list documents (dated on or after `since`). */
export function ncltDefectItems(html: string, since: string): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 3) continue;
    const text = cells.map((c) => c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const date = text.map((t) => printedDate(t)).find(Boolean) ?? null;
    const link = cells.flatMap((c) => anchors(c, NCLT_BASE)).find((a) => /\.pdf(?:$|\?)/i.test(a.href));
    const title = text.find((t) => /defect|rule\s*28|objection/i.test(t)) ?? text[1];
    if (!date || !link || !title || date < since || out.some((d) => d.url === link.href)) continue;
    out.push({
      sourceId: "nclt",
      kind: "defect_list",
      url: link.href,
      fileUrl: link.href,
      title,
      docDate: date,
      mime: "application/pdf",
      meta: { forum: ncltForumOf(title), docKind: "defect_list", listDate: date },
    });
  }
  return out;
}

/** Calendar PDFs linked from /nclt-calender. */
export function ncltCalendarItems(html: string, minYear: number): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const a of anchors(html, NCLT_BASE)) {
    if (!/\.pdf(?:$|\?)/i.test(a.href) || !/calend/i.test(`${a.href} ${a.text}`)) continue;
    const y = /(20\d{2})/.exec(decodeURIComponent(a.href)) ?? /(20\d{2})/.exec(a.text);
    if (!y || Number(y[1]) < minYear || out.some((d) => d.url === a.href)) continue;
    out.push({
      sourceId: "nclt",
      kind: "calendar",
      url: a.href,
      fileUrl: a.href,
      title: `National Company Law Tribunal — Calendar ${y[1]}`,
      docDate: `${y[1]}-01-01`,
      mime: "application/pdf",
      meta: { forum: "nclt", docKind: "calendar", format: "pdf", year: Number(y[1]) },
    });
  }
  return out;
}

const def: SourceDef = {
  id: "nclt",
  name: "NCLT cause lists, defect lists and calendar",
  publisher: "National Company Law Tribunal",
  kinds: ["cause_list", "defect_list", "calendar"],
  forum: "nclt",
  homepage: "https://nclt.gov.in/all-cause-list",
  fetch: "firecrawl_in",
  cadenceMinutes: 120,
  attribution: "Published by the National Company Law Tribunal (nclt.gov.in). Lists are not authoritative.",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Each bench lays out its own PDF; columns are found by header name, so unfamiliar layouts may yield unparsed entries.",
    "NCLT case numbers repeat across benches: listings match a matter only with the bench forum or the bench-coded number.",
    "The order-date-wise search is CAPTCHA-protected and is not used.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const from = addDays(ctx.today, -1);
    const to = addDays(ctx.today, 10);
    const year = Number(ctx.today.slice(0, 4));
    const count = NCLT_BENCHES.length + 2;
    return runQueries(ctx, count, async (i) => {
      if (i < NCLT_BENCHES.length) {
        const bench = NCLT_BENCHES[i];
        const page = await ctx.fetchPage(ncltListUrl(bench.id, from, to));
        return ncltListingItems(page.html ?? "", bench);
      }
      if (i === NCLT_BENCHES.length) {
        const page = await ctx.fetchPage(NCLT_DEFECTS);
        return ncltDefectItems(page.html ?? "", addDays(ctx.today, -14));
      }
      const page = await ctx.fetchPage(NCLT_CALENDAR);
      return ncltCalendarItems(page.html ?? "", year - 1);
    });
  },
  parse(doc: ParseInput): ParseResult {
    const kind = doc.meta.docKind;
    if (kind === "calendar") return calendarParse(doc, { forum: "nclt", format: "pdf" });
    if (kind === "defect_list") return { records: [], unparsed: 0, notes: ["registry defect list: kept as text; no entries"] };
    return causeListParse(doc, { layout: "tribunal", listType: "daily" });
  },
  async persist(store: RemoteStore, doc: ParseInput, result: ParseResult) {
    const kind = doc.meta.docKind;
    if (kind === "calendar") return calendarPersist(store, doc, result);
    if (kind === "defect_list") return { stored: 0 };
    return causeListPersist(store, doc, result);
  },
};
