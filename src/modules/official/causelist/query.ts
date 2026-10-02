import "server-only";
import type { CauseListEntry, CauseListType, ListingMatch, MatterCaseIdentifier, SourceDocument, SourceId, SourceKind, DocumentStatus, ExtractionMethod } from "../types";
import type { CauseListQuery } from "../service";
import { isCaseKey, isDiaryKey, normalizeCaseNumber, normalizeDiaryNo } from "../case-numbers";
import { bool, bounded, int, isoTs, officialStore, parseJson, parsePgArray, pgTextArray, type RemoteStore, type Row, type SqlValue } from "./db";
import { caseKeyBindable, expandForum, forumFilterSql, forumMatches } from "./forums";
import { squash } from "./text";

/**
 * Exact-match queries over parsed cause lists and published orders (implementations behind the service facade:
 * causeListEntries, listingsForMatters, ordersForIdentifiers).
 *
 * Nothing here is fuzzy: case numbers match by normalized key (`case_keys && $n`), diary numbers by equality, advocates
 * by case-insensitive equality of the whole stored name. A missing filter narrows to nothing; it never widens a query.
 */

export class CauseListQueryError extends Error {
  readonly code = "bad_query";
  constructor(message: string) {
    super(message);
    this.name = "CauseListQueryError";
  }
}

export const MAX_WINDOW_DAYS = 62;
export const MAX_LISTING_WINDOW_DAYS = 92;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_IDENTIFIERS = 500;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function isIso(s: string | undefined | null): s is string {
  if (!s || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function spanDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const ENTRY_COLS = `id, document_id, forum, list_date::text AS list_date, list_type, court_no, bench, item_no, case_numbers::text AS case_numbers,
  case_keys, diary_no, parties, advocates, raw, page, ${isoTs("published_at")} AS published_at, ${isoTs("fetched_at")} AS fetched_at, parsed`;

const LIST_TYPES: CauseListType[] = ["main", "supplementary", "advance", "weekly", "daily", "other"];

export function rowToEntry(r: Row): CauseListEntry {
  const lt = String(r.list_type ?? "other") as CauseListType;
  return {
    id: String(r.id),
    documentId: String(r.document_id),
    forum: String(r.forum),
    listDate: String(r.list_date),
    listType: LIST_TYPES.includes(lt) ? lt : "other",
    courtNo: r.court_no ?? null,
    bench: r.bench ?? null,
    itemNo: r.item_no ?? null,
    caseNumbers: parseJson<{ printed: string; normalized: string | null }[]>(r.case_numbers, []).filter((c) => c && typeof c.printed === "string"),
    diaryNo: r.diary_no ?? null,
    parties: r.parties ?? null,
    advocates: parsePgArray(r.advocates),
    raw: String(r.raw ?? ""),
    page: int(r.page),
    publishedAt: r.published_at ?? null,
    fetchedAt: String(r.fetched_at ?? ""),
    parsed: bool(r.parsed),
  };
}

/** A case parameter as given (normalized key, or a printed number) → key; null when it is not one (never guessed). */
export function caseKeyOf(v: string): string | null {
  const s = squash(v);
  if (isCaseKey(s.toUpperCase())) return s.toUpperCase();
  return normalizeCaseNumber(s)?.key ?? null;
}

/** A diary parameter ("54583/2026", "Diary No. 54583-2026") → "54583/2026"; null otherwise. */
export function diaryKeyOf(v: string): string | null {
  const d = normalizeDiaryNo(v);
  return d && isDiaryKey(d) ? d : null;
}

function normAdvocate(v: string | undefined): string | null {
  if (!v) return null;
  const s = squash(v);
  if (s.length < 2 || s.length > 120 || !/[A-Za-z]{2}/.test(s)) return null;
  return s.toLowerCase();
}

/** Cause-list entries for a forum and date window and/or exact identifiers. */
export async function causeListEntries(q: CauseListQuery, storeArg?: RemoteStore | null): Promise<CauseListEntry[]> {
  let from = q.date ?? q.from ?? null;
  let to = q.date ?? q.to ?? null;
  if (from && !to) to = from;
  if (to && !from) from = to;
  if ((from && !isIso(from)) || (to && !isIso(to))) throw new CauseListQueryError("dates must be YYYY-MM-DD");
  if (from && to && (to < from || spanDays(from, to) > MAX_WINDOW_DAYS)) throw new CauseListQueryError(`the date window must be ascending and at most ${MAX_WINDOW_DAYS} days`);
  const keys = [...new Set((q.caseKeys ?? []).map((k) => squash(k).toUpperCase()).filter(isCaseKey))].slice(0, MAX_IDENTIFIERS);
  const diaries = [...new Set((q.diaryNos ?? []).map((d) => diaryKeyOf(d)).filter((d): d is string => !!d))].slice(0, MAX_IDENTIFIERS);
  const advocate = normAdvocate(q.advocate);
  if (q.advocate && !advocate) throw new CauseListQueryError("advocate must be a name");
  // Identifiers were asked for but none is valid: nothing matches (the date window alone must not answer instead).
  if ((q.caseKeys?.length || q.diaryNos?.length) && !keys.length && !diaries.length) return [];
  // A missing filter means none of that kind: without a window or an identifier nothing is listed.
  if (!from && !keys.length && !diaries.length) return [];

  const store = await officialStore(storeArg);
  const params: SqlValue[] = [];
  const where: string[] = [];
  if (q.forum) {
    const f = forumFilterSql(q.forum, "forum", params);
    if (!f) throw new CauseListQueryError("unknown forum");
    where.push(f);
  }
  if (from && to) {
    params.push(from, to);
    where.push(`list_date BETWEEN $${params.length - 1}::date AND $${params.length}::date`);
  }
  const ident: string[] = [];
  if (keys.length) { params.push(pgTextArray(keys)); ident.push(`case_keys && $${params.length}::text[]`); }
  if (diaries.length) { params.push(pgTextArray(diaries)); ident.push(`diary_no = ANY($${params.length}::text[])`); }
  if (ident.length) where.push(`parsed AND (${ident.join(" OR ")})`);
  if (advocate) {
    params.push(advocate);
    where.push(`parsed AND EXISTS (SELECT 1 FROM unnest(advocates) a WHERE lower(regexp_replace(a, '\\s*\\(AOR [0-9]+\\)$', '')) = $${params.length})`);
  }
  const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  params.push(limit);
  const sql = `SELECT ${ENTRY_COLS} FROM causelist_entries WHERE ${where.join(" AND ")}
    ORDER BY list_date ASC, forum ASC, court_no ASC NULLS LAST, page ASC NULLS LAST, (substring(item_no from '^[0-9]+'))::int ASC NULLS LAST, item_no ASC, id ASC
    LIMIT $${params.length}`;
  const rows = await bounded(store, sql, params);
  return rows.map(rowToEntry);
}

/** Exact matches of matters' identifiers against parsed cause-list entries in [from, to]. */
export async function listingsForMatters(
  matters: { matterId: string; identifiers: MatterCaseIdentifier[] }[],
  opts: { from: string; to: string },
  storeArg?: RemoteStore | null,
): Promise<ListingMatch[]> {
  if (!isIso(opts.from) || !isIso(opts.to) || opts.to < opts.from || spanDays(opts.from, opts.to) > MAX_LISTING_WINDOW_DAYS) {
    throw new CauseListQueryError(`from/to must be YYYY-MM-DD, ascending, at most ${MAX_LISTING_WINDOW_DAYS} days apart`);
  }
  const keys = new Set<string>();
  const diaries = new Set<string>();
  let n = 0;
  for (const m of matters) {
    for (const id of m.identifiers ?? []) {
      if (++n > MAX_IDENTIFIERS) break;
      if (!expandForum(String(id.forum ?? "")).length) continue;
      if (id.kind === "case_number" && isCaseKey(id.value)) keys.add(id.value);
      else if (id.kind === "diary_no" && isDiaryKey(id.value)) diaries.add(id.value);
    }
  }
  if (!keys.size && !diaries.size) return [];
  const store = await officialStore(storeArg);
  const params: SqlValue[] = [opts.from, opts.to];
  const ident: string[] = [];
  if (keys.size) { params.push(pgTextArray([...keys])); ident.push(`case_keys && $${params.length}::text[]`); }
  if (diaries.size) { params.push(pgTextArray([...diaries])); ident.push(`diary_no = ANY($${params.length}::text[])`); }
  const rows = await bounded(
    store,
    `SELECT ${ENTRY_COLS} FROM causelist_entries WHERE parsed AND list_date BETWEEN $1::date AND $2::date AND (${ident.join(" OR ")})
     ORDER BY list_date ASC, forum ASC, court_no ASC NULLS LAST, page ASC NULLS LAST, id ASC LIMIT 2000`,
    params,
  );
  const out: ListingMatch[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const entry = rowToEntry(r);
    if (!entry.parsed) continue;
    const entryKeys = new Set(parsePgArray(r.case_keys));
    for (const m of matters) {
      for (const id of m.identifiers ?? []) {
        const hit =
          id.kind === "case_number"
            ? entryKeys.has(id.value) && caseKeyBindable(id.forum, id.value, entry.forum)
            : id.kind === "diary_no"
              ? entry.diaryNo === id.value && forumMatches(id.forum, entry.forum)
              : false;
        if (!hit) continue;
        const k = `${m.matterId}\u0000${entry.id}`;
        if (seen.has(k)) break;
        seen.add(k);
        out.push({ matterId: m.matterId, entry, matchedOn: { forum: id.forum, kind: id.kind, value: id.value } });
        break;
      }
    }
  }
  return out;
}

const DOC_COLS = `id, source, kind, url, file_url, title, doc_date::text AS doc_date, forum, status, mime, sha256, bytes, pages, extraction, ocr_pages,
  language, meta::text AS meta, version, ${isoTs("fetched_at")} AS fetched_at, ${isoTs("indexed_at")} AS indexed_at, error, attempts, chunks`;

export function rowToDocument(r: Row): SourceDocument {
  return {
    id: String(r.id),
    sourceId: String(r.source) as SourceId,
    kind: String(r.kind) as SourceKind,
    url: String(r.url),
    fileUrl: r.file_url ?? null,
    title: String(r.title ?? ""),
    docDate: r.doc_date ?? null,
    status: String(r.status ?? "discovered") as DocumentStatus,
    mime: r.mime ?? null,
    sha256: r.sha256 ?? null,
    bytes: int(r.bytes),
    pages: int(r.pages),
    extraction: (r.extraction ?? null) as ExtractionMethod | null,
    ocrPages: parsePgArray(r.ocr_pages).map(Number).filter(Number.isFinite),
    language: r.language ?? null,
    meta: parseJson<Record<string, unknown>>(r.meta, {}),
    version: int(r.version) ?? 1,
    fetchedAt: r.fetched_at ?? null,
    indexedAt: r.indexed_at ?? null,
    error: r.error ?? null,
    attempts: int(r.attempts) ?? 0,
    chunks: int(r.chunks) ?? 0,
  };
}

/** Orders / judgments whose published metadata carries one of these identifiers exactly (diary no., case keys). */
export async function ordersForIdentifiers(
  identifiers: MatterCaseIdentifier[],
  opts: { since?: string; limit?: number } = {},
  storeArg?: RemoteStore | null,
): Promise<SourceDocument[]> {
  if (opts.since && !isIso(opts.since)) throw new CauseListQueryError("since must be YYYY-MM-DD");
  const ids = (identifiers ?? []).slice(0, 100).filter((i) => expandForum(String(i.forum ?? "")).length && ((i.kind === "case_number" && isCaseKey(i.value)) || (i.kind === "diary_no" && isDiaryKey(i.value))));
  if (!ids.length) return [];
  const store = await officialStore(storeArg);
  const params: SqlValue[] = [];
  const ors = ids.map((i) => {
    params.push(JSON.stringify(i.kind === "diary_no" ? { diaryNo: i.value } : { caseKeys: [i.value] }));
    return `meta @> $${params.length}::jsonb`;
  });
  const where = [`kind IN ('order', 'judgment')`, `(${ors.join(" OR ")})`];
  if (opts.since) { params.push(opts.since); where.push(`doc_date >= $${params.length}::date`); }
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 200);
  params.push(limit * 2);
  const rows = await bounded(store, `SELECT ${DOC_COLS} FROM official_documents WHERE ${where.join(" AND ")} ORDER BY doc_date DESC NULLS LAST, id ASC LIMIT $${params.length}`, params);
  const out: SourceDocument[] = [];
  for (const r of rows) {
    const doc = rowToDocument(r);
    const docForum = typeof doc.meta.forum === "string" ? doc.meta.forum : r.forum ?? "";
    if (!docForum) continue;
    const metaKeys = Array.isArray(doc.meta.caseKeys) ? (doc.meta.caseKeys as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const ok = ids.some((i) =>
      i.kind === "diary_no" ? doc.meta.diaryNo === i.value && forumMatches(i.forum, docForum) : metaKeys.includes(i.value) && caseKeyBindable(i.forum, i.value, docForum),
    );
    if (ok) out.push(doc);
    if (out.length >= limit) break;
  }
  return out;
}
