import "server-only";
import type { CauseListEntry } from "../types";
import { caseNumberKeys } from "../case-numbers";
import { batchRows, jsonParam, type RemoteStore, type SqlQuery } from "./db";
import { hasContact, scrubContact } from "./text";

/**
 * Store a document's parsed cause-list entries (replaces that document's previous entries).
 *
 * One transaction when the payload fits one request; otherwise the batches are upserted by stable id and the
 * document's leftover rows are removed last, so readers never see the document without entries in between.
 * `case_keys` holds every exact key of the printed numbers (ranges expanded, NCLT bench-qualified keys added) and is
 * empty for entries with `parsed: false`, so an unparsed entry can never be matched to a matter.
 */

const COLS = `id, document_id, forum, list_date, list_type, court_no, bench, item_no, case_numbers, case_keys, diary_no, parties, advocates, raw, page, published_at, fetched_at, parsed`;
const RECORDSET = `x(id text, document_id text, forum text, list_date text, list_type text, court_no text, bench text, item_no text, case_numbers jsonb, case_keys jsonb, diary_no text, parties text, advocates jsonb, raw text, page int, published_at text, fetched_at text, parsed boolean)`;
const SELECT = `SELECT x.id, x.document_id, x.forum, x.list_date::date, x.list_type, x.court_no, x.bench, x.item_no, x.case_numbers,
  ARRAY(SELECT jsonb_array_elements_text(x.case_keys)), x.diary_no, x.parties, ARRAY(SELECT jsonb_array_elements_text(x.advocates)),
  x.raw, x.page, x.published_at::timestamptz, x.fetched_at::timestamptz, x.parsed FROM jsonb_to_recordset($1::jsonb) AS ${RECORDSET}`;
const UPSERT = `ON CONFLICT (id) DO UPDATE SET document_id = EXCLUDED.document_id, forum = EXCLUDED.forum, list_date = EXCLUDED.list_date,
  list_type = EXCLUDED.list_type, court_no = EXCLUDED.court_no, bench = EXCLUDED.bench, item_no = EXCLUDED.item_no,
  case_numbers = EXCLUDED.case_numbers, case_keys = EXCLUDED.case_keys, diary_no = EXCLUDED.diary_no, parties = EXCLUDED.parties,
  advocates = EXCLUDED.advocates, raw = EXCLUDED.raw, page = EXCLUDED.page, published_at = EXCLUDED.published_at,
  fetched_at = EXCLUDED.fetched_at, parsed = EXCLUDED.parsed`;

const clean = (s: string | null) => (s == null ? null : (hasContact(s) ? scrubContact(s) : s).replace(/\u0000/g, ""));

/** Exact keys stored for an entry (empty when unparsed). */
export function entryCaseKeys(e: CauseListEntry): string[] {
  if (!e.parsed) return [];
  return [...new Set(e.caseNumbers.flatMap((c) => caseNumberKeys(c.printed)))];
}

function toRow(e: CauseListEntry) {
  return {
    id: e.id,
    document_id: e.documentId,
    forum: e.forum,
    list_date: e.listDate,
    list_type: e.listType,
    court_no: e.courtNo,
    bench: clean(e.bench),
    item_no: e.itemNo,
    case_numbers: e.caseNumbers,
    case_keys: entryCaseKeys(e),
    diary_no: e.parsed ? e.diaryNo : null,
    parties: clean(e.parties),
    advocates: e.advocates.map((a) => clean(a) ?? "").filter(Boolean),
    raw: clean(e.raw) ?? "",
    page: e.page,
    published_at: e.publishedAt,
    fetched_at: e.fetchedAt,
    parsed: e.parsed,
  };
}

export async function persistCauseListEntries(store: RemoteStore, documentId: string, entries: CauseListEntry[]): Promise<{ stored: number }> {
  const rows = entries.filter((e) => e.documentId === documentId).map(toRow);
  const batches = batchRows(rows);
  if (batches.length <= 1) {
    const qs: SqlQuery[] = [{ query: `DELETE FROM causelist_entries WHERE document_id = $1`, params: [documentId] }];
    if (rows.length) qs.push({ query: `INSERT INTO causelist_entries (${COLS}) ${SELECT} ${UPSERT}`, params: [jsonParam(rows)] });
    await store.transaction(qs);
    return { stored: rows.length };
  }
  for (const b of batches) await store.transaction([{ query: `INSERT INTO causelist_entries (${COLS}) ${SELECT} ${UPSERT}`, params: [jsonParam(b)] }]);
  await store.transaction([
    { query: `DELETE FROM causelist_entries WHERE document_id = $1 AND NOT (id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))))`, params: [documentId, jsonParam(rows.map((r) => r.id))] },
  ]);
  return { stored: rows.length };
}
