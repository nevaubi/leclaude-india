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
 * - A year in which rows of a calendar were read but rejected (OCR / weekday mismatch, unknown entry type, a footnote
 *   that could not be validated) is partial (meta.partialYears): never covered by that document, and `notes` says so.
 *   Documents stored before partial years were recorded (no meta.partialYears) cover nothing when their last parse
 *   rejected rows (parse_result.unparsed > 0), until they are parsed again.
 * - Closures: holidays (single days, expanded) and vacations (ranges). Partial court working days and notified working
 *   days are NOT closures: they are listed in `source` so the reader sees them.
 * - weeklyOff comes from the court's own data where it is printed; otherwise Sunday only, with a note. Treating an
 *   unknown Saturday as a working day can only move a computed last day earlier, never later.
 * - Tribunal benches fall back to the tribunal-wide calendar ("nclt-indore" → "nclt") when the bench has none.
 * - Dates read from a scan are flagged wherever they surface (they feed deadline computation): a source document whose
 *   text came from OCR (official_documents.extraction "ocr_model" / ocr_pages) or a third-party PDF parser
 *   ("firecrawl_pdf", which OCRs scanned pages) is `ocr: true` with a note; the calendar's id ends in ":ocr", its
 *   `source` says so first, `notes` carries the warning, and closures known only from such text carry "(OCR-read;
 *   verify against the PDF)" in their names, so a deadline step that skips them shows it.
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
  /** How the document's text was obtained (official_documents.extraction); null when unknown. */
  extraction: string | null;
  /** True when the dates were (or may have been) transcribed by OCR from a scan: verify them against the PDF. */
  ocr: boolean;
  /** Why the dates need checking (OCR / third-party parser); null for text-layer, HTML or structured data. */
  note: string | null;
}

export const OCR_NOTE = "dates transcribed by OCR from the published scan; verify against the PDF";
export const PARSER_NOTE = "dates read by a third-party PDF parser (it OCRs scanned pages); verify against the PDF";
const OCR_NAME_SUFFIX = " (OCR-read; verify against the PDF)";

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
  /** Years the source document speaks for only partially (rows rejected). */
  partial: number[];
  docUrl: string | null;
  extraction: string | null;
  ocr: boolean;
  ocrNote: string | null;
}

/** How a source document's text was read → OCR flag + note (see the module comment). */
export function ocrOf(extraction: string | null, ocrPages: number, rowNote: string | null): { ocr: boolean; note: string | null } {
  if (extraction === "ocr_model" || ocrPages > 0 || /\bOCR\b/.test(rowNote ?? "")) return { ocr: true, note: OCR_NOTE };
  if (extraction === "firecrawl_pdf") return { ocr: true, note: PARSER_NOTE };
  return { ocr: false, note: null };
}

/**
 * Years a source document covers, as stored. A document parsed before partial years were recorded (no
 * meta.partialYears) whose last parse rejected rows covers nothing: its coverage may hide a missing closure.
 */
export function trustedCovers(covers: number[], partialRecorded: boolean, lastUnparsed: number | null): number[] {
  if (!partialRecorded && lastUnparsed != null && lastUnparsed > 0) return [];
  return covers;
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
       ${isoTs("h.fetched_at")} AS fetched_at, (d.meta->'coversYears')::text AS covers, (d.meta->'partialYears')::text AS partial,
       d.parse_result->>'unparsed' AS doc_unparsed, d.url AS doc_url,
       d.extraction AS doc_extraction, coalesce(cardinality(d.ocr_pages), 0) AS doc_ocr_pages
     FROM court_holidays h LEFT JOIN official_documents d ON d.id = h.document_id
     WHERE h.forum = ANY($1::text[]) AND h.date_from <= $3::date AND h.date_to >= $2::date
     ORDER BY h.date_from ASC, h.id ASC LIMIT 5000`,
    [pgTextArray(forums), `${ys[0] - 1}-12-01`, `${ys[ys.length - 1]}-12-31`],
  );
  const years_ = (v: string | null | undefined) => parseJson<unknown[]>(v, []).map(Number).filter((y) => Number.isInteger(y));
  const list: HolidayRow[] = rows.map((r) => {
    const o = ocrOf(r.doc_extraction ?? null, int(r.doc_ocr_pages) ?? 0, r.note ?? null);
    const partialRecorded = r.partial != null && r.partial !== "";
    return {
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
      covers: trustedCovers(years_(r.covers), partialRecorded, int(r.doc_unparsed)),
      partial: partialRecorded ? years_(r.partial) : int(r.doc_unparsed) ? years_(r.covers) : [],
      docUrl: r.doc_url ?? null,
      extraction: r.doc_extraction ?? null,
      ocr: o.ocr,
      ocrNote: o.note,
    };
  });

  // Requested years for which a calendar was loaded but rows were rejected, and no other document covers them.
  const partialNotes = (f: string | null, covered: number[]): string[] => {
    const out: string[] = [];
    for (const y of ys) {
      if (covered.includes(y)) continue;
      const docs = [...new Set(list.filter((r) => (f == null || r.forum === f) && r.partial.includes(y)).map((r) => r.docUrl ?? r.sourceUrl))];
      if (docs.length) {
        out.push(`partial: the official calendar for ${y} (${docs.join("; ")}) was loaded but some of its rows could not be read (weekday mismatch / OCR error, unknown entry type or an unvalidated note); ${y} is not answered — a notified closure may be missing`);
      }
    }
    return out;
  };

  for (const f of forums) {
    const mine = list.filter((r) => r.forum === f);
    const covered = ys.filter((y) => mine.some((r) => r.covers.includes(y)));
    if (!covered.length) continue;
    const built = buildCalendar(f, covered, mine);
    return { ...built, notes: [...built.notes, ...partialNotes(f, covered)], forum: f };
  }
  const partial = partialNotes(null, []);
  return { calendar: null, sources: [], forum: null, notes: [`no ${partial.length ? "complete " : ""}official calendar loaded for ${forum} ${ys.join(", ")}`, ...partial] };
}

export async function courtCalendar(forum: string, years: number[], store?: RemoteStore | null): Promise<CourtCalendar | null> {
  return (await courtCalendarWithSources(forum, years, store)).calendar;
}

function buildCalendar(forum: string, years: number[], rows: HolidayRow[]): Omit<CourtCalendarResult, "forum"> {
  const start = `${years[0]}-01-01`;
  const end = `${years[years.length - 1]}-12-31`;
  const inRange = rows.filter((r) => r.dateFrom <= end && r.dateTo >= start);
  const holidays = new Map<string, string[]>();
  /** Closures confirmed by at least one source that is not OCR text (date for holidays, "from|to" for vacations). */
  const confirmed = new Set<string>();
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
        if (!r.ocr) confirmed.add(d);
      }
    } else if (r.kind === "vacation") {
      const k = `${r.dateFrom}|${r.dateTo}`;
      if (!vacations.has(k)) vacations.set(k, { from: r.dateFrom, to: r.dateTo, name: r.name, ...(r.registryOpen != null ? { registryOpen: r.registryOpen } : {}) });
      if (!r.ocr) confirmed.add(k);
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
    const prev = sourcesMap.get(key);
    if (prev) {
      // Any OCR-noted row of a document flags the document.
      if (r.ocr && !prev.ocr) Object.assign(prev, { ocr: true, note: r.ocrNote });
      continue;
    }
    sourcesMap.set(key, { documentId: r.documentId ?? "", url: r.docUrl ?? r.sourceUrl, fetchedAt: r.fetchedAt, years: r.covers.filter((y) => years.includes(y)), extraction: r.extraction, ocr: r.ocr, note: r.ocrNote });
  }
  const sources = [...sourcesMap.values()].sort((a, b) => a.url.localeCompare(b.url));
  const ocrSources = sources.filter((s) => s.ocr);
  const weekly = WEEKLY_OFF[forum] ?? DEFAULT_WEEKLY;
  const flag = (name: string, key: string) => (ocrSources.length && !confirmed.has(key) ? `${name}${OCR_NAME_SUFFIX}` : name);
  const holidayList: CourtHoliday[] = [...holidays.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, names]) => ({ date, name: flag(names.join(" / "), date) }));
  const vacationList = [...vacations.values()]
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    .map((v) => ({ ...v, name: flag(v.name, `${v.from}|${v.to}`) }));
  const publisher = PUBLISHER[forum] ?? PUBLISHER[forumFamily(forum)] ?? forum;
  const from = sources.map((s) => `${s.url}${s.fetchedAt ? ` (fetched ${s.fetchedAt.slice(0, 10)})` : ""}${s.ocr ? " [OCR]" : ""}`).join("; ");
  if (ocrSources.length) {
    notes.push(`OCR: ${publisher} calendar dates for ${years.join(", ")} were transcribed by OCR (or a third-party PDF parser) from ${ocrSources.map((s) => s.url).join("; ")}; verify every closure against the PDF before relying on a computed date`);
  }
  const parts = [
    ocrSources.length
      ? `OCR-READ CALENDAR — verify against the official PDF: ${publisher} dates for ${years.join(", ")} were transcribed by OCR (or a third-party PDF parser) from the published scan; a misread or missed date changes a computed last day.`
      : "",
    `${publisher}: ${ocrSources.length ? "calendar data read" : "official calendar data"} for ${years.join(", ")} from ${from}.`,
    weekly.note,
    partial.length ? `Partial court working days (not closures): ${partial.join("; ")}.` : "",
    working.length ? `Notified working days: ${working.join("; ")}.` : "",
    "Ad-hoc holidays, shifted sitting days and moon-sighting changes are notified separately and may be missing; verify a computed last day against the court's notifications.",
  ];
  if (working.length) notes.push("notified working days cannot be represented in CourtCalendar; they are listed in source");
  return {
    calendar: {
      id: `official:${forum}:${years.join(",")}${ocrSources.length ? ":ocr" : ""}`,
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
