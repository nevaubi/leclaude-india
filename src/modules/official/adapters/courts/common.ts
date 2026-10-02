import "server-only";
import type { ParseInput, ParseResult } from "../../adapter";
import type { CauseListEntry, CauseListType } from "../../types";
import type { RemoteStore } from "@/lib/db/remote";
import { parseCauseList, type CauseListLayout } from "../../causelist/parse";
import { persistCauseListEntries } from "../../causelist/persist";
import { calendarJsonText, dedupeHolidays, parseCalendarNotes, parseHolidayTable, parseSciHolidayJson, truthfulCoverage, type HolidayRecord } from "../../calendars/parse";
import { persistHolidays } from "../../calendars/persist";
import { itemsOf, metaNumber, metaString } from "./shared";

/** Parse / persist glue shared by the court adapters (cause lists and calendars). */

const LIST_TYPES: CauseListType[] = ["main", "supplementary", "advance", "weekly", "daily", "other"];

export function docText(doc: ParseInput): string {
  if (doc.markdown && doc.markdown.trim()) return doc.markdown;
  return doc.pages.map((p) => p.text).join("\n\n");
}

/** Cause-list document → entries. The list date comes from the publisher's listing (meta.listDate) or docDate. */
export function causeListParse(doc: ParseInput, opts: { layout: CauseListLayout; forum?: string | null; listType?: CauseListType }): ParseResult<CauseListEntry> {
  const forum = opts.forum ?? metaString(doc.meta, "forum");
  const listDate = metaString(doc.meta, "listDate") ?? doc.docDate;
  if (!forum || !listDate || !/^\d{4}-\d{2}-\d{2}$/.test(listDate)) return { records: [], unparsed: 1, notes: ["no forum or list date in the listing metadata; not parsed"] };
  const metaType = metaString(doc.meta, "listType") as CauseListType | null;
  const listType = opts.listType ?? (metaType && LIST_TYPES.includes(metaType) ? metaType : "other");
  const r = parseCauseList(
    { id: doc.id, markdown: doc.markdown ?? "", pages: doc.pages ?? [], items: itemsOf(doc), fetchedAt: doc.fetchedAt },
    { layout: opts.layout, forum, listType, listDate, publishedAt: metaString(doc.meta, "uploadedAt"), expectedEntries: metaNumber(doc.meta, "entriesCount") },
  );
  return { records: r.records, unparsed: r.unparsed, notes: r.notes };
}

/** Store the entries parsed from this document (only records that belong to it). */
export async function causeListPersist(store: RemoteStore, doc: ParseInput, result: ParseResult): Promise<{ stored: number }> {
  const entries = (result.records as CauseListEntry[]).filter((e) => e && typeof e === "object" && e.documentId === doc.id && typeof e.raw === "string");
  return persistCauseListEntries(store, doc.id, entries);
}

export type CalendarFormat = "json" | "html_table" | "pdf";

/** A calendar document's parse: holiday records plus which years had rows that were read but rejected. */
export interface CalendarDocParse extends ParseResult<HolidayRecord> {
  notes: string[];
  rejectedYears: number[];
  rejectedUndated: number;
}

/**
 * Calendar document → holiday records (forum from meta / opts; year printed with the document or resolved).
 * The Supreme Court holiday data (format "json") arrives as the core extractor renders a JSON object: a fenced
 * ```json block; raw JSON is read too.
 */
export function calendarParse(doc: ParseInput, opts: { forum?: string | null; format?: CalendarFormat | null } = {}): CalendarDocParse {
  const forum = opts.forum ?? metaString(doc.meta, "forum");
  if (!forum) return { records: [], unparsed: 1, notes: ["no forum in the listing metadata; not parsed"], rejectedYears: [], rejectedUndated: 1 };
  const format = (opts.format ?? metaString(doc.meta, "format")) as CalendarFormat | null;
  const text = docText(doc);
  const json = calendarJsonText(text);
  if (format === "json" || (format == null && json != null)) {
    const r = parseSciHolidayJson(json ?? text.trim(), { forum });
    return { records: r.records, unparsed: r.unparsed, notes: r.notes, rejectedYears: r.rejectedYears, rejectedUndated: r.rejectedUndated };
  }
  const year = format === "pdf" ? metaNumber(doc.meta, "year") : null;
  const fetchedYear = Number((doc.fetchedAt || new Date().toISOString()).slice(0, 4));
  const table = parseHolidayTable(text, { forum, year, fetchedYear });
  const notes = [...table.notes];
  let records = table.records;
  let unparsed = table.unparsed;
  const rejectedYears = new Set(table.rejectedYears);
  if (table.year != null) {
    const n = parseCalendarNotes(text, { forum, year: table.year, ocr: /\$\s*\d/.test(text) });
    records = records.concat(n.records);
    notes.push(...n.notes);
    // A footnote that was found but could not be validated leaves its closures out of the table's year.
    if (n.unparsed > 0) {
      unparsed += n.unparsed;
      rejectedYears.add(table.year);
    }
  }
  return { records: dedupeHolidays(records), unparsed, notes, rejectedYears: [...rejectedYears].sort((a, b) => a - b), rejectedUndated: table.rejectedUndated };
}

/**
 * Store a calendar document's holidays. Coverage is truthful: a year in which any row was rejected is recorded as
 * partial (`meta.partialYears`), never as covered, so courtCalendar() reports it as unknown instead of open.
 */
export async function calendarPersist(store: RemoteStore, doc: ParseInput, result: ParseResult): Promise<{ stored: number }> {
  const records = (result.records as HolidayRecord[]).filter((r) => r && typeof r === "object" && typeof r.dateFrom === "string" && typeof r.forum === "string");
  const format = metaString(doc.meta, "format");
  const year = format === "json" || format === "pdf" ? metaNumber(doc.meta, "year") : null;
  const r = result as Partial<CalendarDocParse>;
  const verdict = truthfulCoverage(records, { year, format }, { unparsed: result.unparsed, rejectedYears: r.rejectedYears ?? null, rejectedUndated: r.rejectedUndated ?? null });
  return persistHolidays(store, { id: doc.id, url: doc.url, fetchedAt: doc.fetchedAt }, records, verdict.covers, verdict.partialYears);
}

/** Merge parsed values into the document's metadata (orders: neutral citation, case numbers read from page 1). */
export async function mergeDocumentMeta(store: RemoteStore, documentId: string, patch: Record<string, unknown>): Promise<{ stored: number }> {
  if (!Object.keys(patch).length) return { stored: 0 };
  await store.query({ query: `UPDATE official_documents SET meta = meta || $2::jsonb WHERE id = $1`, params: [documentId, JSON.stringify(patch)] });
  return { stored: 1 };
}
