import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput, ParseResult, SourceAdapter } from "../../adapter";
import type { CauseListType, DiscoveredDoc, SourceDef } from "../../types";
import { printedDate } from "../../causelist/text";
import { causeListParse, causeListPersist } from "./common";
import { GOV_TERMS, addDays, anchors, runQueries, tableRows } from "./shared";

/**
 * Delhi High Court cause lists (https://delhihighcourt.nic.in/web/cause-lists/cause-list, ?page=N).
 *
 * Index table: Sr. No. | Cause List (title) | Date (DD-MM-YYYY) | View (PDF link). File names are free-form and the
 * folder is the upload month, so a list is classified only by its printed title. A title such as "... cases fixed for
 * Saturday, the 3rd October, 2026 shall be taken up on Monday, the 5th October, 2026" moves the hearing date: entries
 * are dated by the "taken up on" date and the listing date is kept as meta.listedFor. Deletion notes are ingested as
 * text but yield no entries (an item in a deletion note is not a listing).
 */

export const DHC_CAUSELIST_INDEX = "https://delhihighcourt.nic.in/web/cause-lists/cause-list";
const MAX_PAGES = 5;

export interface DhcClassification {
  listType: CauseListType;
  listKind: "daily" | "supplementary" | "advance" | "pronouncement" | "deletion_note" | "mediation_referral" | "lok_adalat" | "other";
}

/** Classify a Delhi HC list by its printed title (never by file name). */
export function classifyDhcTitle(title: string): DhcClassification {
  const t = title.toLowerCase();
  if (/deletion note/.test(t)) return { listType: "other", listKind: "deletion_note" };
  if (/pronouncement/.test(t)) return { listType: "other", listKind: "pronouncement" };
  if (/lok adalat/.test(t)) return { listType: "other", listKind: "lok_adalat" };
  if (/mediation/.test(t)) return { listType: "advance", listKind: "mediation_referral" };
  if (/advance/.test(t)) return { listType: "advance", listKind: "advance" };
  if (/supplementary/.test(t)) return { listType: "supplementary", listKind: "supplementary" };
  if (/cause list|regular matters|final matters|targeted matters/.test(t)) return { listType: "main", listKind: "daily" };
  return { listType: "other", listKind: "other" };
}

/** "... shall be taken up on Monday, the 5th October, 2026" → "2026-10-05". */
export function takenUpOn(title: string): string | null {
  const m = /taken up on\s+(?:[A-Za-z]+,?\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/i.exec(title);
  return m ? printedDate(`${m[1]} ${m[2]} ${m[3]}`) : null;
}

/** Index rows → documents dated on or after `since`; `oldest` is the oldest listing date seen on the page. */
export function dhcListingItems(html: string, since: string): { items: DiscoveredDoc[]; oldest: string | null; rows: number } {
  const items: DiscoveredDoc[] = [];
  let oldest: string | null = null;
  let rows = 0;
  for (const row of tableRows(html)) {
    if (row.cells.length < 4) continue;
    const title = row.cells[1].trim();
    const date = printedDate(row.cells[2].trim());
    const link = anchors(row.cellHtml[3] ?? "", DHC_CAUSELIST_INDEX).find((a) => /\.pdf(?:$|\?)/i.test(a.href));
    if (!title || !date || !link) continue;
    rows++;
    if (!oldest || date < oldest) oldest = date;
    if (date < since) continue;
    const cls = classifyDhcTitle(title);
    const moved = takenUpOn(title);
    items.push({
      sourceId: "dhc-causelist",
      kind: "cause_list",
      url: link.href,
      fileUrl: link.href,
      title,
      docDate: date,
      mime: "application/pdf",
      meta: {
        forum: "hc-delhi",
        docKind: "cause_list",
        listType: cls.listType,
        listKind: cls.listKind,
        listDate: moved ?? date,
        listedFor: date,
        ...(moved ? { takenUpOn: moved } : {}),
      },
    });
  }
  return { items, oldest, rows };
}

const def: SourceDef = {
  id: "dhc-causelist",
  name: "Delhi High Court cause lists",
  publisher: "High Court of Delhi",
  kinds: ["cause_list"],
  forum: "hc-delhi",
  homepage: DHC_CAUSELIST_INDEX,
  fetch: "firecrawl_in",
  cadenceMinutes: 60,
  attribution: "Cause list published by the High Court of Delhi (delhihighcourt.nic.in). Lists are not authoritative; check supplementary lists.",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Advocates' e-mail addresses and phone numbers ('OTHER DETAILS OF ADVOCATES') are never stored.",
    "Combined lists can exceed 15 MB; the pipeline's size cap applies.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const since = addDays(ctx.today, -2);
    let stop = false;
    return runQueries(ctx, MAX_PAGES, async (i) => {
      if (stop) return [];
      let page;
      try {
        page = await ctx.fetchPage(i === 0 ? DHC_CAUSELIST_INDEX : `${DHC_CAUSELIST_INDEX}?page=${i}`);
      } catch (e) {
        stop = true; // a missing page ends the walk; later pages are not tried
        throw e;
      }
      const { items, oldest, rows } = dhcListingItems(page.html ?? "", since);
      if (!rows || (oldest && oldest < since)) stop = true;
      return items;
    });
  },
  parse(doc: ParseInput): ParseResult {
    if (doc.meta.listKind === "deletion_note") return { records: [], unparsed: 0, notes: ["deletion note: items listed here are deletions, not hearings; no entries"] };
    return causeListParse(doc, { layout: "dhc", forum: "hc-delhi" });
  },
  persist: causeListPersist,
};
