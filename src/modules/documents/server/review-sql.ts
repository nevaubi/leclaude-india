import "server-only";
import { RELEVANCE_RANK, type Coding, type ReviewCounts, type ReviewFacets, type RowQuery } from "../review-types";
import { FILE_COLS, fileFromRow, numOf, REVIEWER_VERSION, reviewRowFromRow, ROW_META_COLS, type ReviewRowItem } from "./store";
import { normalizeForMatch } from "./text";

/**
 * Review row queries shared by the SQLite and Postgres stores. Rows are one per file of the set (LEFT JOIN of the row
 * records), and whether a record is current (same review version and file stamp) is decided in SQL with the same
 * formula as `fileStamp()`. Results of rows that are not current are never exposed: doc type, importance, privilege,
 * issue ranks, search text and row hash are NULL for them, so counts, facets, filters, sort and paging all see a blank
 * row. Placeholders are numbered (`?N` in SQLite, `$N` in Postgres) so one text serves both.
 */

export type Dialect = "sqlite" | "pg";
export type SqlParam = string | number | null;
export interface Sql { text: string; params: SqlParam[] }

class Params {
  readonly values: SqlParam[] = [];
  constructor(private readonly d: Dialect) {}
  /** A text parameter (cast explicitly in Postgres so function overloads resolve). */
  t(v: string): string {
    this.values.push(v);
    return this.d === "pg" ? `CAST($${this.values.length} AS text)` : `?${this.values.length}`;
  }
}

const contains = (d: Dialect, hay: string, needle: string) => (d === "pg" ? `strpos(${hay}, ${needle}) > 0` : `instr(${hay}, ${needle}) > 0`);

/** SQL twin of `fileStamp()` (store.ts). ocr_done_pages is stored as JSON.stringify of a sorted number array. */
export function fileStampSql(alias = "f"): string {
  const c = (col: string) => `CAST(${alias}.${col} AS TEXT)`;
  return `'r${REVIEWER_VERSION}|' || ${c("chars")} || '|' || ${c("pages_received")} || '|' || ${c("pages")} || '|' || ${alias}.status || '|' || REPLACE(${alias}.ocr_done_pages, ' ', '')`;
}

/**
 * Rows of one review (or every review of the set): file columns as f_*, record bookkeeping as r_*, and the exposed
 * (current-only) values as x_*; `row_status` is the public RowStatus.
 */
function rowSource(p: Params, setId: string, reviewId: string | null): string {
  const fileCols = FILE_COLS.map((c) => `f.${c} AS f_${c}`).join(", ");
  const recCols = [...ROW_META_COLS, "cov_partial", "doc_type", "importance", "privilege_flag", "issue_ranks", "search_text", "coding", "decision_hash", "coding_note"]
    .map((c) => `r.${c} AS r_${c}`).join(", ");
  const base = `SELECT rv.id AS rv_id, ${fileCols}, ${recCols},
      CASE WHEN r.state IN ('done', 'failed') AND r.review_version = rv.version AND r.file_stamp = ${fileStampSql("f")} THEN 1 ELSE 0 END AS cur
    FROM docs_reviews rv
    JOIN docs_files f ON f.set_id = rv.set_id
    LEFT JOIN docs_review_rows r ON r.review_id = rv.id AND r.file_id = f.id
    WHERE rv.set_id = ${p.t(setId)}${reviewId ? ` AND rv.id = ${p.t(reviewId)}` : ""}`;
  const shown = `b.cur = 1 AND b.r_state = 'done'`;
  return `SELECT b.*,
      CASE WHEN b.cur = 1 AND b.r_state = 'failed' THEN 'failed' WHEN ${shown} AND b.r_cov_partial = 1 THEN 'partial' WHEN ${shown} THEN 'done' ELSE 'pending' END AS row_status,
      CASE WHEN ${shown} THEN b.r_doc_type END AS x_doc_type,
      CASE WHEN ${shown} THEN b.r_importance END AS x_importance,
      CASE WHEN ${shown} THEN b.r_privilege_flag END AS x_flag,
      CASE WHEN ${shown} THEN b.r_issue_ranks END AS x_issue_ranks,
      CASE WHEN ${shown} THEN b.r_search_text END AS x_search,
      CASE WHEN ${shown} THEN b.r_row_hash END AS x_row_hash,
      CASE WHEN b.r_state IS NOT NULL AND b.r_state <> 'pending' THEN b.r_updated_at END AS x_updated,
      CASE WHEN b.r_coding IS NOT NULL AND COALESCE(b.r_decision_hash, '') <> COALESCE(CASE WHEN ${shown} THEN b.r_row_hash END, '') THEN 1 ELSE 0 END AS x_stale
    FROM (${base}) b`;
}

const CODINGS: Coding[] = ["key", "relevant", "not_relevant", "privileged", "needs_review"];

function whereFor(d: Dialect, p: Params, q: RowQuery): string {
  const w: string[] = [];
  if (q.status) w.push(`x.row_status = ${p.t(q.status)}`);
  if (q.docType) w.push(`lower(x.x_doc_type) = lower(${p.t(q.docType)})`);
  if (q.privilege) w.push(`COALESCE(x.x_flag, 'none') = ${p.t(q.privilege)}`);
  if (q.issue) {
    const min = Math.max(1, RELEVANCE_RANK[q.minRelevance ?? "low"]);
    const ranks = [1, 2, 3].filter((k) => k >= min);
    w.push(`(${ranks.map((k) => contains(d, "x.x_issue_ranks", p.t(`|${q.issue}:${k}|`))).join(" OR ")})`);
  }
  if (q.coding === "uncoded") w.push(`x.r_coding IS NULL`);
  else if (q.coding === "stale") w.push(`x.x_stale = 1`);
  else if (q.coding && CODINGS.includes(q.coding)) w.push(`x.r_coding = ${p.t(q.coding)}`);
  const words = q.q ? normalizeForMatch(q.q).split(" ").filter(Boolean).slice(0, 12) : [];
  for (const word of words) {
    const needle = p.t(word);
    // Each word is bound once per use (Postgres numbered params may repeat; SQLite ?N too).
    w.push(`(${contains(d, "COALESCE(x.x_search, '')", needle)} OR ${contains(d, "lower(x.f_name)", needle)} OR ${contains(d, "COALESCE(x.r_coding_note, '')", needle)})`);
  }
  return w.length ? `WHERE ${w.join(" AND ")}` : "";
}

function orderFor(sort: RowQuery["sort"]): string {
  const byName = `x.f_name, x.f_id`;
  if (sort === "name") return `ORDER BY ${byName}`;
  if (sort === "updated") return `ORDER BY COALESCE(x.x_updated, '') DESC, ${byName}`;
  return `ORDER BY COALESCE(x.x_importance, 0) DESC, ${byName}`;
}

/** COUNT of filtered rows, and the page itself (file + record bookkeeping, no result). */
export function rowQuerySql(d: Dialect, setId: string, reviewId: string, q: RowQuery, page: { offset: number; limit: number }): { count: Sql; page: Sql } {
  const pc = new Params(d);
  const count = `SELECT COUNT(*) AS n FROM (${rowSource(pc, setId, reviewId)}) x ${whereFor(d, pc, q)}`;
  const pp = new Params(d);
  const limit = Math.max(1, Math.min(Math.floor(page.limit), 5000));
  const offset = Math.max(0, Math.floor(page.offset));
  const text = `SELECT x.* FROM (${rowSource(pp, setId, reviewId)}) x ${whereFor(d, pp, q)} ${orderFor(q.sort)} LIMIT ${limit} OFFSET ${offset}`;
  return { count: { text: count, params: pc.values }, page: { text, params: pp.values } };
}

/** Result JSON of the given files' rows (only called for a page). */
export function rowResultsSql(d: Dialect, reviewId: string, fileIds: string[]): Sql {
  const p = new Params(d);
  const rid = p.t(reviewId);
  const ids = d === "pg" ? `file_id IN (SELECT jsonb_array_elements_text(${p.t(JSON.stringify(fileIds))}::jsonb))` : `file_id IN (SELECT value FROM json_each(${p.t(JSON.stringify(fileIds))}))`;
  return { text: `SELECT file_id, result FROM docs_review_rows WHERE review_id = ${rid} AND ${ids}`, params: p.values };
}

/** Turn page rows (+ results by file id) into items. */
export function rowItems(rows: Record<string, unknown>[], results: Map<string, unknown>): ReviewRowItem[] {
  return rows.map((r) => {
    const f: Record<string, unknown> = {};
    for (const c of FILE_COLS) f[c] = r[`f_${c}`];
    const file = fileFromRow(f);
    if (r.r_state == null) return { file, rec: null };
    const rec: Record<string, unknown> = { partials: null, result: results.get(file.id) ?? null };
    for (const c of ROW_META_COLS) rec[c] = r[`r_${c}`];
    return { file, rec: reviewRowFromRow(rec) };
  });
}

export function countsSql(d: Dialect, setId: string, reviewId?: string): Sql {
  const p = new Params(d);
  const sum = (cond: string) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
  const text = `SELECT x.rv_id AS review_id, COUNT(*) AS files,
      ${sum(`x.row_status = 'done'`)} AS done, ${sum(`x.row_status = 'partial'`)} AS partial, ${sum(`x.row_status = 'failed'`)} AS failed,
      ${sum(`x.row_status = 'pending'`)} AS pending, ${sum(`x.r_coding IS NOT NULL AND x.x_stale = 0`)} AS coded, ${sum(`x.x_stale = 1`)} AS stale,
      ${sum(`x.x_flag IN ('possible', 'likely')`)} AS privilege_flags
    FROM (${rowSource(p, setId, reviewId ?? null)}) x GROUP BY x.rv_id`;
  return { text, params: p.values };
}

export function countsFromRows(rows: Record<string, unknown>[]): Map<string, ReviewCounts> {
  return new Map(rows.map((r) => [String(r.review_id), {
    files: numOf(r.files), done: numOf(r.done), partial: numOf(r.partial), pending: numOf(r.pending), failed: numOf(r.failed),
    coded: numOf(r.coded), stale: numOf(r.stale), privilegeFlags: numOf(r.privilege_flags),
  }]));
}

export const zeroCounts = (): ReviewCounts => ({ files: 0, done: 0, partial: 0, pending: 0, failed: 0, coded: 0, stale: 0, privilegeFlags: 0 });

/** Three statements: aggregate (privilege, stale, per-issue ranks), doc types, codings. */
export function facetsSql(d: Dialect, setId: string, reviewId: string, issueIds: string[]): { agg: Sql; docTypes: Sql; coding: Sql } {
  const sum = (cond: string) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
  const pa = new Params(d);
  const src = rowSource(pa, setId, reviewId);
  const issueCols = issueIds.flatMap((id, i) => [3, 2, 1].map((k) => `${sum(contains(d, "x.x_issue_ranks", pa.t(`|${id}:${k}|`)))} AS i${i}_${k}`));
  const agg = `SELECT ${[`${sum(`x.x_flag = 'possible'`)} AS possible`, `${sum(`x.x_flag = 'likely'`)} AS likely`, `${sum(`x.x_stale = 1`)} AS stale`, ...issueCols].join(", ")} FROM (${src}) x`;
  const pd = new Params(d);
  const docTypes = `SELECT x.x_doc_type AS v, COUNT(*) AS n FROM (${rowSource(pd, setId, reviewId)}) x WHERE x.x_doc_type IS NOT NULL GROUP BY x.x_doc_type`;
  const pc = new Params(d);
  const coding = `SELECT COALESCE(x.r_coding, 'uncoded') AS v, COUNT(*) AS n FROM (${rowSource(pc, setId, reviewId)}) x GROUP BY COALESCE(x.r_coding, 'uncoded')`;
  return { agg: { text: agg, params: pa.values }, docTypes: { text: docTypes, params: pd.values }, coding: { text: coding, params: pc.values } };
}

export function facetsFromRows(issueIds: string[], agg: Record<string, unknown> | undefined, docTypes: Record<string, unknown>[], coding: Record<string, unknown>[]): ReviewFacets {
  const a = agg ?? {};
  const out: ReviewFacets = {
    docTypes: docTypes.map((r) => ({ value: String(r.v), count: numOf(r.n) })).sort((x, y) => y.count - x.count || x.value.localeCompare(y.value)),
    issues: issueIds.map((issueId, i) => ({ issueId, high: numOf(a[`i${i}_3`]), medium: numOf(a[`i${i}_2`]), low: numOf(a[`i${i}_1`]) })),
    privilege: { possible: numOf(a.possible), likely: numOf(a.likely) },
    coding: {},
  };
  for (const r of coding) out.coding[String(r.v) as Coding | "uncoded"] = numOf(r.n);
  const stale = numOf(a.stale);
  if (stale) out.coding.stale = stale;
  return out;
}
