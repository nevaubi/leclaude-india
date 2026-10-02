import "server-only";
import type { CauseListEntry, CauseListType, ListingMatch, MatterCaseIdentifier, SourceDocument, SourceId, SourceKind, DocumentStatus, ExtractionMethod } from "../types";
import type { CauseListQuery } from "../service";
import { findDiaryNos, isCaseKey, isDiaryKey, normalizeCaseNumber, normalizeDiaryNo, qualifiedCaseKey } from "../case-numbers";
import { bool, bounded, int, isoTs, officialStore, parseJson, parsePgArray, pgTextArray, type RemoteStore, type Row, type SqlValue } from "./db";
import { CAPTION_SCOPE, caseKeyBindable, caseKeyListable, expandForum, forumFilterSql, forumMatches, identifierCanBind, unqualifiedNcltListable } from "./forums";
import { squash } from "./text";

/**
 * Exact-match queries over parsed cause lists and published orders (implementations behind the service facade:
 * causeListEntries, listingsForMatters, ordersForIdentifiers).
 *
 * Nothing here is fuzzy: case numbers match by normalized key (`case_keys && $n`), diary numbers by equality, advocates
 * by case-insensitive equality of the whole stored name. A missing filter narrows to nothing; it never widens a query.
 * Bench rules (./forums.ts) are applied in SQL, so LIMIT counts only rows that may bind, and re-checked in code.
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

/**
 * A case parameter as given (normalized key, or a printed number) → key; null when it is not one (never guessed).
 * A printed bench code is kept ("CP(IB)/29(MP)2022" → "CPIB/29/2022@MP"): NCLT numbers repeat at every bench.
 */
export function caseKeyOf(v: string): string | null {
  const s = squash(v);
  if (isCaseKey(s.toUpperCase())) return s.toUpperCase();
  const n = normalizeCaseNumber(s);
  return n ? (qualifiedCaseKey(n) ?? n.key) : null;
}

/** SQL: some key in `keysParam` is in case_keys and case_keys holds no bench-qualified form of that key. */
function unqualifiedKeySql(keysParam: string): string {
  return `EXISTS (SELECT 1 FROM unnest(case_keys) ck WHERE ck = ANY(${keysParam}::text[])
      AND NOT EXISTS (SELECT 1 FROM unnest(case_keys) cq WHERE cq <> ck AND split_part(cq, '@', 1) = ck))`;
}

const NOT_NCLT_FORUM = (column: string) => `(${column} <> 'nclt' AND ${column} NOT LIKE 'nclt-%')`;

/**
 * A diary parameter → "54583/2026": either a bare number ("54583/2026", "54583-2026") or text naming exactly one
 * labelled diary number ("SLP(C) 1234/2026 (Diary No. 54583/2026)"). Never the first N/YYYY of free text (that is
 * usually a case number); null otherwise.
 */
export function diaryKeyOf(v: string): string | null {
  const s = v.replace(/\s+/g, " ").trim();
  if (/^\d{1,7}\s*[-/]\s*(?:19|20)\d{2}$/.test(s)) {
    const d = normalizeDiaryNo(s);
    return d && isDiaryKey(d) ? d : null;
  }
  const labelled = findDiaryNos(s);
  return labelled.length === 1 && isDiaryKey(labelled[0]) ? labelled[0] : null;
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
  // Bench-qualified keys match exactly. An unqualified key never lists an entry whose printed number carries a bench
  // code, nor NCLT entries unless the forum is exactly one bench (the same number exists at every bench).
  const qualified = keys.filter((k) => k.includes("@"));
  const unqualified = keys.filter((k) => !k.includes("@"));
  if (qualified.length) { params.push(pgTextArray(qualified)); ident.push(`case_keys && $${params.length}::text[]`); }
  if (unqualified.length) {
    params.push(pgTextArray(unqualified));
    const p = `$${params.length}`;
    const parts = [`case_keys && ${p}::text[]`, unqualifiedKeySql(p)];
    if (!unqualifiedNcltListable(q.forum)) parts.push(NOT_NCLT_FORUM("forum"));
    ident.push(`(${parts.join(" AND ")})`);
  }
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
  const out: CauseListEntry[] = [];
  for (const r of rows) {
    const entry = rowToEntry(r);
    // Re-check the identifier rules in code (the SQL above already applies them).
    if (keys.length || diaries.length) {
      const entryKeys = parsePgArray(r.case_keys);
      const byKey = keys.some((k) => entryKeys.includes(k) && caseKeyListable(q.forum, k, entry.forum, entryKeys));
      const byDiary = !!entry.diaryNo && diaries.includes(entry.diaryNo);
      if (!byKey && !byDiary) continue;
    }
    out.push(entry);
  }
  return out;
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
      // Identifiers that can never bind (ambiguous forum, unqualified NCLT key without one bench) are not queried.
      if (!expandForum(String(id.forum ?? "")).length || !identifierCanBind(id.forum, id.kind, String(id.value ?? ""))) continue;
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
            ? entryKeys.has(id.value) && caseKeyBindable(id.forum, id.value, entry.forum, entryKeys)
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

/** Order forum as matched: meta.forum when it is a string (the publisher's forum), else the document's column. */
const DOC_FORUM_SQL = `coalesce(CASE WHEN jsonb_typeof(meta->'forum') = 'string' THEN meta->>'forum' END, forum)`;
/** meta.caseKeys as a jsonb array ('[]' when absent or not an array, so element functions never fail). */
const META_KEYS_SQL = `(CASE WHEN jsonb_typeof(meta->'caseKeys') = 'array' THEN meta->'caseKeys' ELSE '[]'::jsonb END)`;
const ORDER_PAGES = 5;

/**
 * Keys of an order that may bind a matter: meta.caseKeys, except for NCLAT orders read before page-1 captions were told
 * apart from appeal numbers cited in the body (no meta.caseKeysScope): there only the first number printed — the
 * caption's — binds, until the document is parsed again.
 */
export function orderBindingKeys(doc: Pick<SourceDocument, "sourceId" | "meta">): string[] {
  const keys = Array.isArray(doc.meta.caseKeys) ? (doc.meta.caseKeys as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (doc.sourceId === "nclat" && doc.meta.caseKeysScope !== CAPTION_SCOPE) return keys.slice(0, 1);
  return keys;
}

/**
 * Orders / judgments whose published metadata carries one of these identifiers exactly (diary no., case keys). The
 * forum, bench and caption rules are part of the SQL, so `limit` counts orders that bind; rows are re-checked in code
 * and further pages are read (bounded) if a check ever disagrees.
 */
export async function ordersForIdentifiers(
  identifiers: MatterCaseIdentifier[],
  opts: { since?: string; limit?: number } = {},
  storeArg?: RemoteStore | null,
): Promise<SourceDocument[]> {
  if (opts.since && !isIso(opts.since)) throw new CauseListQueryError("since must be YYYY-MM-DD");
  const ids = (identifiers ?? [])
    .slice(0, 100)
    .filter((i) => expandForum(String(i.forum ?? "")).length && ((i.kind === "case_number" && isCaseKey(i.value)) || (i.kind === "diary_no" && isDiaryKey(i.value))))
    .filter((i) => identifierCanBind(i.forum, i.kind, i.value));
  if (!ids.length) return [];
  const store = await officialStore(storeArg);
  const params: SqlValue[] = [];
  const ors: string[] = [];
  for (const i of ids) {
    const parts: string[] = [];
    if (i.kind === "diary_no") {
      params.push(JSON.stringify({ diaryNo: i.value }));
      parts.push(`meta @> $${params.length}::jsonb`);
    } else {
      params.push(JSON.stringify({ caseKeys: [i.value] }));
      parts.push(`meta @> $${params.length}::jsonb`);
      params.push(i.value);
      const v = `$${params.length}`;
      parts.push(`(source <> 'nclat' OR meta->>'caseKeysScope' = '${CAPTION_SCOPE}' OR meta->'caseKeys'->>0 = ${v})`);
      if (!i.value.includes("@")) {
        parts.push(`NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${META_KEYS_SQL}) ck WHERE ck <> ${v} AND split_part(ck, '@', 1) = ${v})`);
        if (!unqualifiedNcltListable(i.forum)) parts.push(NOT_NCLT_FORUM(DOC_FORUM_SQL));
      }
    }
    const f = forumFilterSql(i.forum, DOC_FORUM_SQL, params);
    if (!f) continue;
    parts.push(f);
    ors.push(`(${parts.join(" AND ")})`);
  }
  if (!ors.length) return [];
  const where = [`kind IN ('order', 'judgment')`, `(${ors.join(" OR ")})`];
  if (opts.since) { params.push(opts.since); where.push(`doc_date >= $${params.length}::date`); }
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 200);
  const pageSize = Math.min(limit * 2, 400);
  const sql = `SELECT ${DOC_COLS} FROM official_documents WHERE ${where.join(" AND ")} ORDER BY doc_date DESC NULLS LAST, id ASC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const out: SourceDocument[] = [];
  for (let page = 0; page < ORDER_PAGES && out.length < limit; page++) {
    const rows = await bounded(store, sql, [...params, pageSize, page * pageSize]);
    for (const r of rows) {
      const doc = rowToDocument(r);
      const docForum = typeof doc.meta.forum === "string" ? doc.meta.forum : r.forum ?? "";
      if (!docForum) continue;
      const metaKeys = Array.isArray(doc.meta.caseKeys) ? (doc.meta.caseKeys as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const binding = orderBindingKeys(doc);
      const ok = ids.some((i) =>
        i.kind === "diary_no"
          ? doc.meta.diaryNo === i.value && forumMatches(i.forum, docForum)
          : binding.includes(i.value) && caseKeyBindable(i.forum, i.value, docForum, metaKeys),
      );
      if (ok) out.push(doc);
      if (out.length >= limit) break;
    }
    if (rows.length < pageSize) break;
  }
  return out;
}
