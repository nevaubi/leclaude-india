import "server-only";
import type { CourtCalendar, CourtHoliday, CourtVacation } from "@/lib/india/holidays";
import { bool, bounded, int, isoTs, officialStore, parseJson, pgTextArray, type RemoteStore } from "../causelist/db";
import { expandForum, FAMILY_ROOTS, forumFamily, isForumKey } from "../causelist/forums";
import { addDaysIso } from "../causelist/text";

/**
 * courtCalendar(forum, years): the court's notified calendar built from official holiday lists (court_holidays).
 *
 * - Only years that a loaded official calendar covers completely (official_documents.meta.coversYears) are answered;
 *   other years stay outside `years`, so isCourtOpen() reports "unknown" for them. No holidays loaded → null.
 * - Closures: holidays (single days, expanded) and vacations (ranges). Partial court working days and notified working
 *   days are NOT closures: they are listed in `source` so the reader sees them.
 * - weeklyOff comes from the court's own data where it is printed; otherwise Sunday only, with a note. Treating an
 *   unknown Saturday as a working day can only move a computed last day earlier, never later.
 * - Tribunal benches fall back to the tribunal-wide calendar ("nclt-indore" → "nclt") when the bench has none.
 */

export class CalendarQueryError extends Error {
  readonly code = "bad_query";
  constructor(message: string) {
    super(message);
    this.name = "CalendarQueryError";
  }
}

export interface CalendarSource {
  documentId: string;
  url: string;
  fetchedAt: string | null;
  years: number[];
}

export interface CourtCalendarResult {
  calendar: CourtCalendar | null;
  sources: CalendarSource[];
  /** Forum whose data answered (may be the tribunal-wide family root). */
  forum: string | null;
  notes: string[];
}

const WEEKLY_OFF: Record<string, { weeklyOff: number[]; note: string }> = {
  sci: {
    weeklyOff: [0],
    note: "Weekly off: Sunday. The Supreme Court's list notifies Saturday holidays individually (e.g. Independence Day 2026, a Saturday), so Saturdays are not treated as closed; benches ordinarily sit Monday to Friday and the Registry's Saturday hours vary by notification.",
  },
  "hc-delhi": {
    weeklyOff: [0],
    note: "Weekly off: Sunday. Second Saturdays are closures as printed in the official calendar (loaded as holidays); other Saturdays are treated as working days.",
  },
};
const DEFAULT_WEEKLY = { weeklyOff: [0], note: "Weekly off: Sunday only; Saturday practice is not encoded from this court's notification." };

const PUBLISHER: Record<string, string> = {
  sci: "Supreme Court of India",
  "hc-delhi": "High Court of Delhi",
  "hc-karnataka": "High Court of Karnataka",
  nclt: "National Company Law Tribunal",
  nclat: "National Company Law Appellate Tribunal",
};

const MAX_YEARS = 6;
const MAX_HOLIDAY_SPAN_DAYS = 60;

function validYears(years: number[]): number[] {
  const ys = [...new Set((years ?? []).map((y) => Math.trunc(Number(y))))].filter((y) => y >= 1990 && y <= 2100).sort((a, b) => a - b);
  if (!ys.length || ys.length > MAX_YEARS) throw new CalendarQueryError(`years must be 1 to ${MAX_YEARS} years between 1990 and 2100`);
  return ys;
}

/** Candidate forums in priority order: the forum (aliases resolved), then its tribunal family root. */
function candidateForums(forum: string): string[] {
  const out: string[] = [];
  for (const f of expandForum(forum)) {
    if (!out.includes(f)) out.push(f);
    const fam = forumFamily(f);
    if (fam !== f && FAMILY_ROOTS.has(fam) && !out.includes(fam)) out.push(fam);
  }
  return out;
}

interface HolidayRow {
  forum: string;
  dateFrom: string;
  dateTo: string;
  name: string;
  kind: string;
  registryOpen: boolean | null;
  documentId: string | null;
  sourceUrl: string;
  year: number | null;
  note: string | null;
  fetchedAt: string | null;
  covers: number[];
  docUrl: string | null;
}

export async function courtCalendarWithSources(forum: string, years: number[], storeArg?: RemoteStore | null): Promise<CourtCalendarResult> {
  if (!isForumKey(String(forum ?? "").toLowerCase())) throw new CalendarQueryError("unknown forum");
  const ys = validYears(years);
  const forums = candidateForums(forum);
  if (!forums.length) throw new CalendarQueryError("unknown forum");
  const store = await officialStore(storeArg);
  const rows = await bounded(
    store,
    `SELECT h.forum, h.date_from::text AS date_from, h.date_to::text AS date_to, h.name, h.kind, h.registry_open, h.document_id, h.source_url, h.year, h.note,
       ${isoTs("h.fetched_at")} AS fetched_at, (d.meta->'coversYears')::text AS covers, d.url AS doc_url
     FROM court_holidays h LEFT JOIN official_documents d ON d.id = h.document_id
     WHERE h.forum = ANY($1::text[]) AND h.date_from <= $3::date AND h.date_to >= $2::date
     ORDER BY h.date_from ASC, h.id ASC LIMIT 5000`,
    [pgTextArray(forums), `${ys[0] - 1}-12-01`, `${ys[ys.length - 1]}-12-31`],
  );
  const list: HolidayRow[] = rows.map((r) => ({
    forum: String(r.forum),
    dateFrom: String(r.date_from),
    dateTo: String(r.date_to),
    name: String(r.name ?? ""),
    kind: String(r.kind ?? "holiday"),
    registryOpen: r.registry_open == null ? null : bool(r.registry_open),
    documentId: r.document_id ?? null,
    sourceUrl: String(r.source_url ?? ""),
    year: int(r.year),
    note: r.note ?? null,
    fetchedAt: r.fetched_at ?? null,
    covers: parseJson<unknown[]>(r.covers, []).map(Number).filter((y) => Number.isInteger(y)),
    docUrl: r.doc_url ?? null,
  }));

  for (const f of forums) {
    const mine = list.filter((r) => r.forum === f);
    const covered = ys.filter((y) => mine.some((r) => r.covers.includes(y)));
    if (!covered.length) continue;
    return { ...buildCalendar(f, covered, mine), forum: f };
  }
  return { calendar: null, sources: [], forum: null, notes: [`no official calendar loaded for ${forum} ${ys.join(", ")}`] };
}

export async function courtCalendar(forum: string, years: number[], store?: RemoteStore | null): Promise<CourtCalendar | null> {
  return (await courtCalendarWithSources(forum, years, store)).calendar;
}

function buildCalendar(forum: string, years: number[], rows: HolidayRow[]): Omit<CourtCalendarResult, "forum"> {
  const start = `${years[0]}-01-01`;
  const end = `${years[years.length - 1]}-12-31`;
  const inRange = rows.filter((r) => r.dateFrom <= end && r.dateTo >= start);
  const holidays = new Map<string, string[]>();
  const vacations = new Map<string, CourtVacation>();
  const partial: string[] = [];
  const working: string[] = [];
  const notes: string[] = [];
  for (const r of inRange) {
    if (r.kind === "holiday" || r.kind === "ad_hoc") {
      let d = r.dateFrom;
      for (let i = 0; d <= r.dateTo && i <= MAX_HOLIDAY_SPAN_DAYS; i++, d = addDaysIso(d, 1)) {
        const names = holidays.get(d) ?? [];
        if (!names.some((n) => n.toLowerCase() === r.name.toLowerCase())) names.push(r.name);
        holidays.set(d, names);
      }
    } else if (r.kind === "vacation") {
      const k = `${r.dateFrom}|${r.dateTo}`;
      if (!vacations.has(k)) vacations.set(k, { from: r.dateFrom, to: r.dateTo, name: r.name, ...(r.registryOpen != null ? { registryOpen: r.registryOpen } : {}) });
    } else if (r.kind === "partial_working") {
      const s = `${r.dateFrom} to ${r.dateTo}`;
      if (!partial.includes(s)) partial.push(s);
    } else if (r.kind === "working_day") {
      const s = r.dateFrom === r.dateTo ? r.dateFrom : `${r.dateFrom} to ${r.dateTo}`;
      if (!working.includes(s)) working.push(s);
    }
  }
  const sourcesMap = new Map<string, CalendarSource>();
  for (const r of inRange) {
    const key = r.documentId ?? r.sourceUrl;
    if (!sourcesMap.has(key)) sourcesMap.set(key, { documentId: r.documentId ?? "", url: r.docUrl ?? r.sourceUrl, fetchedAt: r.fetchedAt, years: r.covers.filter((y) => years.includes(y)) });
  }
  const sources = [...sourcesMap.values()].sort((a, b) => a.url.localeCompare(b.url));
  const weekly = WEEKLY_OFF[forum] ?? DEFAULT_WEEKLY;
  const holidayList: CourtHoliday[] = [...holidays.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, names]) => ({ date, name: names.join(" / ") }));
  const vacationList = [...vacations.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const parts = [
    `${PUBLISHER[forum] ?? PUBLISHER[forumFamily(forum)] ?? forum}: official calendar data for ${years.join(", ")} from ${sources.map((s) => `${s.url}${s.fetchedAt ? ` (fetched ${s.fetchedAt.slice(0, 10)})` : ""}`).join("; ")}.`,
    weekly.note,
    partial.length ? `Partial court working days (not closures): ${partial.join("; ")}.` : "",
    working.length ? `Notified working days: ${working.join("; ")}.` : "",
    "Ad-hoc holidays, shifted sitting days and moon-sighting changes are notified separately and may be missing; verify a computed last day against the court's notifications.",
  ];
  if (working.length) notes.push("notified working days cannot be represented in CourtCalendar; they are listed in source");
  return {
    calendar: {
      id: `official:${forum}:${years.join(",")}`,
      courtId: forum,
      years,
      weeklyOff: weekly.weeklyOff,
      holidays: holidayList,
      vacations: vacationList,
      sample: false,
      source: parts.filter(Boolean).join(" "),
    },
    sources,
    notes,
  };
}
