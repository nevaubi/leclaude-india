import "server-only";
import type { RemoteStore, SqlValue } from "@/lib/db/remote";
import { DOC_COLS, toSourceDocument } from "./read";
import { boundedQuery, documentFilters, isSourceKind, SEARCH_TIMEOUT_MS } from "./search";
import type { OfficialListQuery, OfficialListResult } from "./service";
import { isSourceId, type SourceId, type SourceKind } from "./types";
import { officialStore } from "./units";

/**
 * Listing official documents, newest first (document date, then id), with keyset cursor pagination. An explicitly empty
 * filter (`sources: []`) lists nothing; a missing one does not filter on that field.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FORUM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

interface Cursor { d: string | null; id: string }

export function encodeListCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeListCursor(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof o.id !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(o.id)) throw new Error();
    if (o.d != null && (typeof o.d !== "string" || !ISO_DATE.test(o.d))) throw new Error();
    return { d: o.d ?? null, id: o.id };
  } catch {
    throw new RangeError("invalid cursor");
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listOfficialDocuments(q: OfficialListQuery, storeArg?: RemoteStore | null): Promise<OfficialListResult> {
  if (q.sources !== undefined && (!Array.isArray(q.sources) || !q.sources.every(isSourceId))) throw new RangeError("unknown source");
  if (q.kinds !== undefined && (!Array.isArray(q.kinds) || !q.kinds.every(isSourceKind))) throw new RangeError("unknown kind");
  const forum = q.forum ? String(q.forum).toLowerCase() : null;
  if (forum && !FORUM_RE.test(forum)) throw new RangeError("invalid forum");
  for (const d of [q.from, q.to]) if (d && !ISO_DATE.test(d)) throw new RangeError("dates must be YYYY-MM-DD");
  const text = (q.q ?? "").replace(/\s+/g, " ").trim();
  if (text.length > 300) throw new RangeError("q must be at most 300 characters");
  const cursor = decodeListCursor(q.cursor);
  const limit = Math.max(1, Math.min(Math.floor(Number(q.limit) || 25), 100));
  const store = await officialStore(storeArg);
  if ((q.sources && !q.sources.length) || (q.kinds && !q.kinds.length)) return { documents: [], nextCursor: null };

  const params: SqlValue[] = [];
  const where = documentFilters({ sources: (q.sources as SourceId[] | undefined) ?? null, kinds: (q.kinds as SourceKind[] | undefined) ?? null, forum, from: q.from || null, to: q.to || null }, params);
  const p = (v: SqlValue) => { params.push(v); return `$${params.length}`; };
  if (text) {
    const t = p(text);
    const like = p(`%${escapeLike(text)}%`);
    where.push(`(d.search @@ websearch_to_tsquery('english', ${t}) OR d.title ILIKE ${like})`);
  }
  if (cursor) {
    const id = p(cursor.id);
    if (cursor.d) { const d = p(cursor.d); where.push(`(d.doc_date < ${d}::date OR (d.doc_date = ${d}::date AND d.id < ${id}) OR d.doc_date IS NULL)`); }
    else where.push(`(d.doc_date IS NULL AND d.id < ${id})`);
  }
  const cols = DOC_COLS.split(", ").map((c) => `d.${c}`).join(", ");
  const rows = await boundedQuery(store,
    `SELECT ${cols} FROM official_documents d${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY d.doc_date DESC NULLS LAST, d.id DESC LIMIT ${limit + 1}`,
    params, SEARCH_TIMEOUT_MS);
  const documents = rows.slice(0, limit).map(toSourceDocument);
  const last = documents[documents.length - 1];
  return { documents, nextCursor: rows.length > limit && last ? encodeListCursor({ d: last.docDate, id: last.id }) : null };
}
