import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import { calendarParse, calendarPersist } from "./common";
import { GOV_TERMS, anchors, pageOf, tableRows } from "./shared";

/**
 * High Court holiday calendars.
 *
 * - Delhi: https://delhihighcourt.nic.in/web/calender-list (table: Title | Year | View → calendar_YYYY.pdf). The 2026
 *   PDF is a scan: the pipeline OCRs it; only the holiday table and the notes (vacations, second Saturdays, local
 *   holidays) are parsed, never the OCR'd month grid. Ad-hoc holidays and shifted sitting days come by separate
 *   notifications and are not in the calendar.
 * - Karnataka: https://judiciary.karnataka.gov.in/calendar.php lists pdfs/Calender-YYYY.pdf in its year selector; when
 *   the page cannot be read the documented file name for the current year is used (meta.urlFromPattern).
 * - Bombay (signed, expiring download links) and Madras (holidays only through an AJAX POST) are not ingested.
 */

export const DELHI_CALENDAR_LIST = "https://delhihighcourt.nic.in/web/calender-list";
export const KARNATAKA_CALENDAR_PAGE = "https://judiciary.karnataka.gov.in/calendar.php";

/** Delhi High Court calendar PDFs from the listing table, for years >= minYear. */
export function delhiCalendarItems(html: string, minYear: number): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const row of tableRows(html)) {
    const yearCell = row.cells.find((c) => /^\d{4}$/.test(c.trim()));
    if (!yearCell) continue;
    const year = Number(yearCell);
    const link = row.cellHtml.flatMap((h) => anchors(h, DELHI_CALENDAR_LIST)).find((a) => /\.pdf(?:$|\?)/i.test(a.href));
    if (!link || year < minYear || out.some((d) => d.url === link.href)) continue;
    out.push({
      sourceId: "hc-calendars",
      kind: "calendar",
      url: link.href,
      fileUrl: link.href,
      title: `High Court of Delhi — Calendar ${year}`,
      docDate: `${year}-01-01`,
      mime: "application/pdf",
      meta: { forum: "hc-delhi", docKind: "calendar", format: "pdf", year, court: "High Court of Delhi" },
    });
  }
  return out;
}

/** Karnataka High Court calendar PDFs from the page's year selector (value="pdfs/Calender-YYYY.pdf"). */
export function karnatakaCalendarItems(html: string, minYear: number): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  const re = /value\s*=\s*["']([^"']*Calender-(\d{4})\.pdf)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const year = Number(m[2]);
    if (year < minYear) continue;
    let url: string;
    try {
      url = new URL(m[1], KARNATAKA_CALENDAR_PAGE).toString();
    } catch {
      continue;
    }
    if (out.some((d) => d.url === url)) continue;
    out.push(karnatakaItem(url, year, false));
  }
  return out;
}

function karnatakaItem(url: string, year: number, fromPattern: boolean): DiscoveredDoc {
  return {
    sourceId: "hc-calendars",
    kind: "calendar",
    url,
    fileUrl: url,
    title: `High Court of Karnataka — Calendar ${year}`,
    docDate: `${year}-01-01`,
    mime: "application/pdf",
    meta: { forum: "hc-karnataka", docKind: "calendar", format: "pdf", year, court: "High Court of Karnataka", ...(fromPattern ? { urlFromPattern: true } : {}) },
  };
}

const def: SourceDef = {
  id: "hc-calendars",
  name: "High Court holiday calendars",
  publisher: "High Courts of Delhi and Karnataka",
  kinds: ["calendar"],
  forum: null,
  homepage: DELHI_CALENDAR_LIST,
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "Holiday calendar published by the High Court (delhihighcourt.nic.in, judiciary.karnataka.gov.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Delhi's calendar PDF is scanned: holidays are read from OCR text; verify a date against the PDF before relying on it.",
    "Ad-hoc holidays and shifted sitting days are notified separately (High Court 'Updates') and are not in the calendar.",
    "Bombay High Court is not ingested: its calendar downloads use signed links that expire.",
    "Madras High Court is not ingested: holidays are served only through an AJAX POST from its calendar page.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const year = Number(ctx.today.slice(0, 4));
    const notes: string[] = [];
    const items: DiscoveredDoc[] = [];
    try {
      const page = await ctx.fetchPage(DELHI_CALENDAR_LIST);
      items.push(...delhiCalendarItems(page.html ?? "", year - 1));
    } catch (e) {
      notes.push(`Delhi calendar list unavailable: ${(e as Error).message.slice(0, 160)}`);
    }
    try {
      const page = await ctx.fetchPage(KARNATAKA_CALENDAR_PAGE);
      const k = karnatakaCalendarItems(page.html ?? "", year - 1);
      if (k.length) items.push(...k);
      else notes.push("Karnataka calendar page listed no calendar files");
    } catch (e) {
      notes.push(`Karnataka calendar page unavailable (${(e as Error).message.slice(0, 120)}); using the documented file name for ${year}`);
      items.push(karnatakaItem(`https://judiciary.karnataka.gov.in/pdfs/Calender-${year}.pdf`, year, true));
    }
    return pageOf(items, ctx, notes);
  },
  parse: (doc: ParseInput) => calendarParse(doc, { format: "pdf" }),
  persist: calendarPersist,
};
