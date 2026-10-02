import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import { calendarParse, calendarPersist } from "./common";
import { GOV_TERMS, anchors, markRefetch, pageOf } from "./shared";

/**
 * Supreme Court calendar and holidays (https://www.sci.gov.in/calendar/).
 *
 * Three official views of the same calendar:
 * - the page's holiday table (server-rendered for the current year; its header labels are swapped: column 1 is the
 *   holiday name, column 2 the date);
 * - the year PDFs linked as "Calendar for the year YYYY (PDF)" (opaque upload paths: found by anchor text only);
 * - the holiday data the page's own script requests (wp-admin/admin-ajax.php?action=calender_get_holidays_for_this_month,
 *   documented in holiday-calendar.js): typed entries (gazetted, vacations, partial, weekend-working).
 * Parsed rows go to court_holidays (forum "sci"); courtCalendar("sci", years) merges them.
 * The page and the year's holiday data are amended in place when holidays are added or moved, so both are re-read on
 * every (daily) pass (`meta.refetch`); the year PDFs weekly.
 */

export const SCI_CALENDAR_PAGE = "https://www.sci.gov.in/calendar/";

export function sciHolidayJsonUrl(year: number): string {
  return `https://www.sci.gov.in/wp-admin/admin-ajax.php?action=calender_get_holidays_for_this_month&year=${year}&month=01&lang=en&order=asc&update_views=block,tabular,description`;
}

/** Calendar PDFs linked by anchor text "Calendar for the year YYYY (PDF)", for years >= minYear. */
export function sciCalendarPdfs(html: string, minYear: number): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const a of anchors(html, SCI_CALENDAR_PAGE)) {
    const m = /Calendar for the year (\d{4}) \(PDF\)/i.exec(a.text);
    if (!m || !/\.pdf(?:$|\?)/i.test(a.href)) continue;
    const year = Number(m[1]);
    if (year < minYear || out.some((d) => d.url === a.href)) continue;
    out.push({
      sourceId: "sci-calendar",
      kind: "calendar",
      url: a.href,
      fileUrl: a.href,
      title: `Supreme Court of India — Calendar ${year}`,
      docDate: `${year}-01-01`,
      mime: "application/pdf",
      meta: { forum: "sci", docKind: "calendar", format: "pdf", year },
    });
  }
  return out;
}

const def: SourceDef = {
  id: "sci-calendar",
  name: "Supreme Court calendar and holidays",
  publisher: "Supreme Court of India",
  kinds: ["calendar"],
  forum: "sci",
  homepage: SCI_CALENDAR_PAGE,
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "Holiday list published by the Supreme Court of India (sci.gov.in/calendar).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Id / Muharram dates are subject to moon sighting and ad-hoc holidays are notified separately: a computed last day must be checked against the Court's notices.",
    "Partial court working days are recorded but are not closures.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const year = Number(ctx.today.slice(0, 4));
    const notes: string[] = [];
    const items: DiscoveredDoc[] = [
      {
        sourceId: "sci-calendar",
        kind: "calendar",
        url: SCI_CALENDAR_PAGE,
        title: "Supreme Court of India — Holidays (calendar page)",
        docDate: `${year}-01-01`,
        mime: "text/html",
        meta: { forum: "sci", docKind: "calendar", format: "html_table", refetch: true },
      },
      {
        sourceId: "sci-calendar",
        kind: "calendar",
        url: sciHolidayJsonUrl(year),
        title: `Supreme Court of India — Holiday data ${year}`,
        docDate: `${year}-01-01`,
        mime: "application/json",
        meta: { forum: "sci", docKind: "calendar", format: "json", year, urlFromPattern: true, refetch: true },
      },
    ];
    try {
      const page = await ctx.fetchPage(SCI_CALENDAR_PAGE);
      items.push(...markRefetch(sciCalendarPdfs(page.html ?? "", year - 1), ctx.today));
    } catch (e) {
      notes.push(`calendar page unavailable: ${(e as Error).message.slice(0, 160)}`);
    }
    return pageOf(items, ctx, notes);
  },
  parse: (doc: ParseInput) => calendarParse(doc, { forum: "sci" }),
  persist: calendarPersist,
};
