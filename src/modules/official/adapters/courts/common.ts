import "server-only";
import type { ParseInput, ParseResult } from "../../adapter";
import type { CauseListEntry, CauseListType } from "../../types";
import type { RemoteStore } from "@/lib/db/remote";
import { parseCauseList, type CauseListLayout } from "../../causelist/parse";
import { persistCauseListEntries } from "../../causelist/persist";
import { calendarCoverage, dedupeHolidays, parseCalendarNotes, parseHolidayTable, parseSciHolidayJson, type HolidayRecord } from "../../calendars/parse";
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

/** Calendar document → holiday records (forum from meta / opts; year printed with the document or resolved). */
export function calendarParse(doc: ParseInput, opts: { forum?: string | null; format?: CalendarFormat | null } = {}): ParseResult<HolidayRecord> {
  const forum = opts.forum ?? metaString(doc.meta, "forum");
  if (!forum) return { records: [], unparsed: 1, notes: ["no forum in the listing metadata; not parsed"] };
  const format = (opts.format ?? metaString(doc.meta, "format")) as CalendarFormat | null;
  const text = docText(doc);
  if (format === "json" || /^\s*\{/.test(text)) {
    const r = parseSciHolidayJson(text.trim(), { forum });
    return { records: r.records, unparsed: r.unparsed, notes: r.notes };
  }
  const year = format === "pdf" ? metaNumber(doc.meta, "year") : null;
  const fetchedYear = Number((doc.fetchedAt || new Date().toISOString()).slice(0, 4));
  const table = parseHolidayTable(text, { forum, year, fetchedYear });
  const notes = [...table.notes];
  let records = table.records;
  if (table.year != null) {
    const n = parseCalendarNotes(text, { forum, year: table.year, ocr: /\$\s*\d/.test(text) });
    records = records.concat(n.records);
    notes.push(...n.notes);
  }
  return { records: dedupeHolidays(records), unparsed: table.unparsed, notes };
}

export async function calendarPersist(store: RemoteStore, doc: ParseInput, result: ParseResult): Promise<{ stored: number }> {
  const records = (result.records as HolidayRecord[]).filter((r) => r && typeof r === "object" && typeof r.dateFrom === "string" && typeof r.forum === "string");
  const format = metaString(doc.meta, "format");
  const year = format === "json" || format === "pdf" ? metaNumber(doc.meta, "year") : null;
  const covers = calendarCoverage(records, { year, format });
  return persistHolidays(store, { id: doc.id, url: doc.url, fetchedAt: doc.fetchedAt }, records, covers);
}

/** Merge parsed values into the document's metadata (orders: neutral citation, case numbers read from page 1). */
export async function mergeDocumentMeta(store: RemoteStore, documentId: string, patch: Record<string, unknown>): Promise<{ stored: number }> {
  if (!Object.keys(patch).length) return { stored: 0 };
  await store.query({ query: `UPDATE official_documents SET meta = meta || $2::jsonb WHERE id = $1`, params: [documentId, JSON.stringify(patch)] });
  return { stored: 1 };
}
