import "server-only";
import type { RemoteStore, SqlValue } from "@/lib/db/remote";
import { cleanLawText, NO_SECTION, type LawListResponse, type LawProvisionHit, type LawSearchResponse, type LawSort } from "@/modules/law/shared";
import { boundedQuery, bool, instrumentCols, instrumentFilters, int, lawStore, num, sectionKey, toInstrument, type InstrumentFilterInput } from "./common";

/**
 * Retrieval over the Indian law corpus (Postgres): instruments by title (and State / regulator / publisher), and
 * provisions by full text (`websearch_to_tsquery('english')`, ranked with `ts_rank_cd`), grouped to sections. Every
 * statement is bounded: a LIMIT on the candidate set, statement-level filters with bound parameters, and a statement
 * timeout on the full-text search. Provisions are never scanned without a tsquery or an act id.
 *
 * A hit proves the dataset holds a provision with these words; it does not prove the provision is the current
 * official text — the section must be read, and checked against the publisher's page, before it is relied on.
 */

/** Matching provision chunks considered before grouping into sections (bounds ranking cost). */
export const PROVISION_CANDIDATES = 400;
/** The deepest section position a paged provision search may reach (offset + limit). */
export const MAX_PROVISION_WINDOW = 200;
/** The deepest instrument position a paged listing may reach. */
export const MAX_INSTRUMENT_OFFSET = 25_000;
export const SEARCH_TIMEOUT_MS = 8_000;

const HEADLINE_OPTS = "MaxFragments=2, MaxWords=32, MinWords=12, StartSel=«, StopSel=», FragmentDelimiter=\" … \"";

const clampLimit = (n: number | undefined, max: number, dflt: number) => Math.max(1, Math.min(Math.trunc(Number(n) || dflt), max));

/** Escape a string for LIKE … ESCAPE '\'. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export interface InstrumentQuery extends InstrumentFilterInput {
  q?: string;
  sort?: LawSort;
  /** Opaque cursor from a previous page ("o:<offset>"). */
  cursor?: string | null;
  limit?: number;
}

export function decodeOffsetCursor(c: string | null | undefined, max: number): number {
  if (!c || !c.startsWith("o:")) return 0;
  const n = Number(c.slice(2));
  return Number.isInteger(n) && n >= 0 && n <= max ? n : 0;
}

/**
 * Browse order puts what a litigator reaches for first: Central Acts, then State Acts, then regulator instruments and
 * reports; within each, titles that start with a letter (ignoring a leading "The") before file-name-like titles
 * (digits, hashes, brackets) that some regulator sources publish.
 */
const GROUP = `CASE i.jurisdiction WHEN 'central' THEN 0 WHEN 'state' THEN 1 ELSE 2 END, CASE WHEN i.kind = 'report' THEN 1 ELSE 0 END, CASE WHEN i.title ~* '^(the\\s+)?[a-z\\u0900-\\u0dff]' AND i.title !~* '^[0-9a-f]{16,}' THEN 0 ELSE 1 END`;
const TITLE_KEY = `regexp_replace(lower(i.title), '^the\\s+', '')`;

function instrumentOrder(sort: LawSort, hasQ: boolean): string {
  switch (sort) {
    case "newest": return `${GROUP}, i.year DESC NULLS LAST, ${TITLE_KEY}, i.id`;
    case "oldest": return `${GROUP}, i.year ASC NULLS LAST, ${TITLE_KEY}, i.id`;
    case "title": return `${GROUP}, ${TITLE_KEY}, i.id`;
    default: return hasQ ? "exact DESC, rank DESC, i.year DESC NULLS LAST, i.id" : `${GROUP}, ${TITLE_KEY}, i.id`;
  }
}

/**
 * One page of instruments. With `q`: title full-text match (plus a title substring match for abbreviations and
 * partial words), the exact title first. Without: a browse in title or year order. `hasMore` comes from a probe row.
 */
export async function searchInstruments(input: InstrumentQuery, storeArg?: RemoteStore | null): Promise<LawListResponse> {
  const store = await lawStore(storeArg);
  const started = Date.now();
  const limit = clampLimit(input.limit, 50, 50);
  const offset = decodeOffsetCursor(input.cursor, MAX_INSTRUMENT_OFFSET);
  const q = (input.q ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  const sort: LawSort = input.sort ?? (q ? "relevance" : "title");
  const params: SqlValue[] = [];
  let select = instrumentCols("i");
  let from = "law_instruments i";
  let where = "TRUE";
  if (q) {
    params.push(q, `%${likeEscape(q.toLowerCase())}%`);
    select += `, ts_rank_cd(i.search, tsq)::float8 AS rank, (lower(i.title) = lower($1) OR lower(regexp_replace(i.title, '^the\\s+', '', 'i')) = lower($1))::int AS exact`;
    from += `, websearch_to_tsquery('english', $1) AS tsq`;
    where = `(i.search @@ tsq OR lower(i.title) LIKE $2 ESCAPE '\\')`;
  }
  where += instrumentFilters(input, params, "i");
  const rows = await boundedQuery(store, `SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${instrumentOrder(sort, Boolean(q))} LIMIT ${limit + 1} OFFSET ${offset}`, params, SEARCH_TIMEOUT_MS);
  const hits = rows.slice(0, limit).map((r) => ({ ...toInstrument(r), ...(q ? { rank: num(r.rank) } : {}) }));
  const hasMore = rows.length > limit && offset + limit < MAX_INSTRUMENT_OFFSET;
  return { mode: q ? "search" : "browse", sort, hits, hasMore, nextCursor: hasMore ? `o:${offset + limit}` : null, tookMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Provisions (section-level hits)
// ---------------------------------------------------------------------------

export interface ProvisionQuery extends InstrumentFilterInput {
  q: string;
  limit?: number;
  offset?: number;
}

/** The provision search statement (exported for tests): candidates by rank, one best chunk per section, then a page. */
export function provisionSearchSql(input: ProvisionQuery): { query: string; params: SqlValue[]; limit: number; offset: number } {
  const limit = clampLimit(input.limit, 50, 20);
  const offset = Math.max(0, Math.min(Math.trunc(Number(input.offset) || 0), MAX_PROVISION_WINDOW - limit));
  const params: SqlValue[] = [input.q.trim().slice(0, 300)];
  const filters = instrumentFilters(input, params, "i");
  const inForce = input.inForceOnly || input.status === "in_force" ? " AND p.in_force IS NOT FALSE" : "";
  params.push(HEADLINE_OPTS);
  const opts = `$${params.length}`;
  const key = `coalesce(nullif(section_number, ''), '${NO_SECTION}')`;
  const query = `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
cand AS (
  SELECT p.id, p.act_id, p.section_number, p.variant, p.ord, p.heading, p.chapter_title, p.in_force, p.source_url, ts_rank_cd(p.search, q.tsq) AS rank
  FROM q, law_provisions p JOIN law_instruments i ON i.id = p.act_id
  WHERE p.search @@ q.tsq${filters}${inForce}
  ORDER BY rank DESC
  LIMIT ${PROVISION_CANDIDATES}
),
best AS (
  SELECT DISTINCT ON (act_id, ${key}, variant) * FROM cand ORDER BY act_id, ${key}, variant, rank DESC, ord
),
page AS (SELECT * FROM best ORDER BY rank DESC, act_id, ord LIMIT ${limit + 1} OFFSET ${offset})
SELECT page.act_id, page.section_number, page.variant, page.ord, page.chapter_title, page.in_force, page.source_url, page.rank::float8 AS rank,
  coalesce(page.heading, (SELECT h.heading FROM law_provisions h WHERE h.act_id = page.act_id AND lower(h.section_number) = lower(page.section_number) AND h.variant = page.variant AND h.heading IS NOT NULL ORDER BY h.ord LIMIT 1)) AS heading,
  ts_headline('english', left(pp.text, 20000), q.tsq, ${opts}) AS snippet,
  i.title AS act_title, i.kind, i.jurisdiction, i.state, i.state_code, i.regulator, i.year, i.status AS instrument_status, i.dataset_version, i.source_url AS act_source_url
FROM page JOIN law_provisions pp ON pp.id = page.id JOIN law_instruments i ON i.id = page.act_id, q
ORDER BY page.rank DESC, page.act_id, page.ord`;
  return { query, params, limit, offset };
}

/** Clean a « »-marked headline without touching the marks. */
function cleanSnippet(s: string | null): string {
  return cleanLawText(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Full-text search over provisions, returning section-level hits (one per act, section number and variant) with a
 * highlighted snippet. Requires a query; an empty query returns nothing (provisions are never browsed unfiltered).
 */
export async function searchProvisions(input: ProvisionQuery, storeArg?: RemoteStore | null): Promise<LawSearchResponse> {
  const started = Date.now();
  if (!input.q || !input.q.trim()) {
    await lawStore(storeArg);
    return { hits: [], hasMore: false, nextOffset: null, tookMs: 0 };
  }
  const store = await lawStore(storeArg);
  const { query, params, limit, offset } = provisionSearchSql(input);
  const rows = await boundedQuery(store, query, params, SEARCH_TIMEOUT_MS);
  const hits: LawProvisionHit[] = rows.slice(0, limit).map((r) => ({
    actId: String(r.act_id),
    actTitle: r.act_title ?? String(r.act_id),
    kind: r.kind ?? "act",
    jurisdiction: r.jurisdiction ?? "central",
    state: r.state ?? null,
    state_code: r.state_code ?? null,
    regulator: r.regulator ?? null,
    year: int(r.year),
    instrumentStatus: r.instrument_status ?? null,
    section: sectionKey(r.section_number),
    variant: int(r.variant) ?? 0,
    heading: r.heading ? cleanLawText(r.heading) : null,
    chapter_title: r.chapter_title ?? null,
    in_force: bool(r.in_force),
    snippet: cleanSnippet(r.snippet),
    rank: num(r.rank),
    source_url: r.source_url ?? r.act_source_url ?? null,
    dataset_version: r.dataset_version ?? "",
  }));
  const hasMore = rows.length > limit && offset + limit < MAX_PROVISION_WINDOW;
  return { hits, hasMore, nextOffset: hasMore ? offset + limit : null, tookMs: Date.now() - started };
}
