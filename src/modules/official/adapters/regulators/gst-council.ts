import "server-only";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import { GOV_TERMS, attr, clean, htmlText, printedDate, rowCells, safeUrl, tableRows, walkStreams, type ListingPage, type ListingStream } from "./common";

/**
 * GST Council meetings (gstcouncil.gov.in/gst-council-meeting): one static Drupal table, newest meeting first
 * (verified 2026-10-02: 55 rows, 1st 22-Sep-2016 … 55th 21-Dec-2024). Columns: Meetings | Date | Venue | Agenda | Minutes.
 * Each linked PDF (agenda and minutes) becomes one document of kind "minutes" (meta.document says which). File names are
 * irregular, so URLs are only ever taken from the page's links. Files are large and often scanned (OCR expected).
 */

const PAGE_URL = "https://gstcouncil.gov.in/gst-council-meeting";
const HOSTS = ["gstcouncil.gov.in"];

/** "55th GST Council Meeting" → 55; "02nd GST Council Meeting" → 2. */
export function meetingNumber(label: string): number | null {
  const m = /^0*(\d{1,3})\s*(?:st|nd|rd|th)\b/i.exec(clean(label));
  return m ? Number(m[1]) : null;
}

/** "21-Dec-2024" or "22-Sep-2016 - 23-Sep-2016" → first and last day. */
export function meetingDates(printed: string): { from: string | null; to: string | null } {
  const parts = clean(printed).split(/\s+(?:-|–|to)\s+/i);
  const from = printedDate(parts[0]);
  const to = parts.length > 1 ? printedDate(parts[parts.length - 1]) : from;
  return { from, to };
}

export function parseGstCouncilMeetings(html: string, pageUrl = PAGE_URL): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const row of tableRows(html)) {
    const cells = rowCells(row);
    if (cells.length < 5) continue;
    const label = clean(htmlText(cells[0]));
    const no = meetingNumber(label);
    const printed = clean(htmlText(cells[1]));
    const { from, to } = meetingDates(printed);
    const venue = clean(htmlText(cells[2])) || null;
    const docs: [string, "minutes" | "agenda"][] = [[cells[4], "minutes"], [cells[3], "agenda"]];
    for (const [cell, document] of docs) {
      for (const a of cell.match(/<a\b[^>]*>/gi) ?? []) {
        const fileUrl = safeUrl(attr(a, "href"), pageUrl, HOSTS);
        if (!fileUrl || !/\.pdf(?:$|\?)/i.test(fileUrl)) continue;
        const size = /Size:\s*([\d.]+\s*[KMG]B)/i.exec(htmlText(cell))?.[1] ?? null;
        out.push({
          sourceId: "gst-council",
          kind: "minutes",
          url: fileUrl,
          fileUrl,
          title: `${label || "GST Council meeting"}${from ? ` (${printed}${venue ? `, ${venue}` : ""})` : ""}: ${document === "minutes" ? "Minutes" : "Agenda"}`,
          docDate: from,
          mime: "application/pdf",
          meta: { forum: "gst-council", meetingNo: no, meetingLabel: label || null, date: from, dateTo: to, datePrinted: printed || null, venue, document, fileSize: size },
        });
      }
    }
  }
  return out;
}

const meetings: ListingStream = {
  kind: "listing",
  id: "meetings",
  backfill: true,
  firstPage: 1,
  incrementalPages: 1,
  // One table ordered by meeting, not by upload: minutes added to an older meeting's row sort below the newest file, so
  // every pass lists the whole table (about 110 files; the pipeline's upsert skips URLs it already holds).
  markerless: true,
  async fetch(_page: number, ctx: AdapterContext): Promise<ListingPage> {
    const res = await ctx.fetchPage(PAGE_URL);
    const items = parseGstCouncilMeetings(res.html ?? "", res.finalUrl || PAGE_URL);
    return { items, last: true, notes: items.length ? undefined : ["no meeting rows could be read from the page"] };
  },
};

export const def: SourceDef = {
  id: "gst-council",
  name: "GST Council meeting agenda and minutes",
  publisher: "GST Council Secretariat",
  kinds: ["minutes"],
  forum: "gst-council",
  homepage: PAGE_URL,
  fetch: "direct",
  cadenceMinutes: 10080,
  attribution: "Agenda and minutes as published by the GST Council Secretariat (gstcouncil.gov.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Files are large (up to ~60 MB) and many are scanned; text usually comes from OCR.",
    "As of 2026-10-02 the page lists meetings up to the 55th (21 Dec 2024).",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    return walkStreams(ctx, { plan: async () => ["meetings"], stream: (id) => (id === "meetings" ? meetings : null) });
  },
};
