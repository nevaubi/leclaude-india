import "server-only";
import { courtById } from "@/lib/india/courts";
import { remoteStore, type RemoteStore, type SqlValue } from "@/lib/db/remote";
import { ensureCorpusSchema } from "./backfill";

/**
 * Retrieval over the judgment corpus in Postgres. Identifier queries (CNR, neutral citation, case number) resolve by
 * exact match first; everything else is weighted full-text search (citations and title weigh most, then judges, then
 * the source snippet). A hit proves the judgment is in the official dataset with this metadata; it does not prove any
 * proposition — the text must be read before a judgment is characterised.
 */

export interface CorpusHit {
  id: string;
  source: string;
  title: string;
  court_id: string | null;
  court: string | null;
  court_code: string | null;
  bench_id?: string | null;
  bench_code: string | null;
  bench_strength?: number | null;
  year: number | null;
  decision_date: string | null;
  case_number: string | null;
  cnr: string | null;
  neutral_citation: string | null;
  reporter_citation: string | null;
  judges: string[];
  disposal: string | null;
  pdf_url: string | null;
  snippet: string | null;
  text_status: string;
  issues: string[] | null;
  /** exact: identifier match; text: every query word matched; partial: some query words matched. */
  match: "exact" | "text" | "partial";
  rank?: number;
}

export interface CorpusQuery {
  q: string;
  courts?: string[];
  yearFrom?: number;
  yearTo?: number;
  judge?: string;
  /** Case-insensitive substring of the disposal ("Dismissed", "Allowed"). */
  disposal?: string;
  limit?: number;
  /**
   * Skip this many merged hits (exact, then text, then partial). When set, one extra hit is probed so the result can
   * say whether more exist (`hasMore`). Bounded by MAX_SEARCH_WINDOW.
   */
  offset?: number;
  /** Order of the full-text phases: by rank (default), or by decision date. Exact identifier matches always lead. */
  order?: "relevance" | "newest" | "oldest";
}

/** The deepest merged position a paged search may reach (offset + limit). */
export const MAX_SEARCH_WINDOW = 500;

const CNR_RE = /^[A-Z]{4}\d{12}$/i;
const NEUTRAL_RE = /^\d{4}\s*(?::\s*[A-Z-]+\s*:\s*\d+|\s+INSC\s+\d+)$/i;

export function parseArray(v: string | null): string[] {
  if (!v) return [];
  // Postgres text[] in text output: {"A B",C}
  const inner = v.replace(/^\{|\}$/g, "");
  if (!inner) return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
  return out;
}

export const COLS = `id, source, title, court_id, court_code, bench_id, bench_code, bench_strength, year, decision_date::text AS decision_date, case_number, cnr, neutral_citation, reporter_citation, judges, disposal, pdf_url, snippet, text_status, issues`;

export function toHit(r: Record<string, string | null>, match: CorpusHit["match"]): CorpusHit {
  return {
    id: String(r.id), source: String(r.source), title: String(r.title), court_id: r.court_id,
    court: r.court_id ? courtById(r.court_id)?.name ?? null : null, court_code: r.court_code, bench_id: r.bench_id ?? null, bench_code: r.bench_code, bench_strength: r.bench_strength ? Number(r.bench_strength) : null,
    year: r.year ? Number(r.year) : null, decision_date: r.decision_date, case_number: r.case_number, cnr: r.cnr,
    neutral_citation: r.neutral_citation, reporter_citation: r.reporter_citation, judges: parseArray(r.judges), disposal: r.disposal,
    pdf_url: r.pdf_url, snippet: r.snippet, text_status: String(r.text_status ?? "none"), issues: r.issues ? parseArray(r.issues) : null,
    match, rank: r.rank ? Number(r.rank) : undefined,
  };
}

const arrayLiteral = (vals: string[]) => `{${vals.map((c) => `"${c.replace(/["\\{}]/g, "")}"`).join(",")}}`;

/**
 * Court filter values are registry court ids ("sci", "hc-karnataka"); `code:<dataset code>` selects records whose
 * court code is not in the registry (court_id null), so unmapped records stay reachable without being re-labelled.
 */
export function corpusFilters(o: CorpusQuery, params: SqlValue[]): string {
  const where: string[] = [];
  const ids = (o.courts ?? []).filter((c) => c && !c.startsWith("code:"));
  const codes = (o.courts ?? []).filter((c) => c.startsWith("code:")).map((c) => c.slice(5)).filter(Boolean);
  if (ids.length || codes.length) {
    const parts: string[] = [];
    if (ids.length) { params.push(arrayLiteral(ids)); parts.push(`court_id = ANY($${params.length}::text[])`); }
    // "code:unknown" is the directory's key for records with neither a registry court nor a court code.
    const named = codes.filter((c) => c !== "unknown");
    if (named.length) { params.push(arrayLiteral(named)); parts.push(`(court_id IS NULL AND court_code = ANY($${params.length}::text[]))`); }
    if (named.length < codes.length) parts.push(`(court_id IS NULL AND court_code IS NULL)`);
    where.push(parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0]);
  }
  if (o.yearFrom) { params.push(o.yearFrom); where.push(`year >= $${params.length}`); }
  if (o.yearTo) { params.push(o.yearTo); where.push(`year <= $${params.length}`); }
  if (o.judge?.trim()) { params.push(`%${o.judge.trim().replace(/[%_]/g, "")}%`); where.push(`judges_text ILIKE $${params.length}`); }
  if (o.disposal?.trim()) { params.push(`%${o.disposal.trim().replace(/[%_\\]/g, "")}%`); where.push(`disposal ILIKE $${params.length}`); }
  return where.length ? ` AND ${where.join(" AND ")}` : "";
}

export async function searchCorpus(o: CorpusQuery, store: RemoteStore | null = remoteStore()): Promise<{ hits: CorpusHit[]; total?: number; hasMore?: boolean }> {
  if (!store) throw new Error("The judgment corpus is not configured (DATABASE_URL).");
  await ensureCorpusSchema(store);
  const q = o.q.trim();
  const pageSize = Math.max(1, Math.min(o.limit ?? 10, 50));
  const paged = o.offset !== undefined;
  const offset = paged ? Math.max(0, Math.min(Math.floor(o.offset ?? 0) || 0, MAX_SEARCH_WINDOW - pageSize)) : 0;
  // A paged call collects the merged list up to the end of the requested page, plus one probe for `hasMore`.
  const limit = paged ? offset + pageSize + 1 : pageSize;
  const textOrder = o.order === "newest" ? "decision_date DESC NULLS LAST, id DESC" : o.order === "oldest" ? "decision_date ASC NULLS LAST, id ASC" : "rank DESC, decision_date DESC NULLS LAST, id";
  const hits: CorpusHit[] = [];
  const seen = new Set<string>();
  const done = () => (paged ? { hits: hits.slice(offset, offset + pageSize), hasMore: hits.length > offset + pageSize } : { hits });

  // Exact identifiers first.
  const exactParams: SqlValue[] = [];
  let exactWhere = "";
  if (CNR_RE.test(q)) { exactParams.push(q.toUpperCase()); exactWhere = `cnr = $1`; }
  else if (NEUTRAL_RE.test(q)) { exactParams.push(q.replace(/\s+/g, " ").replace(/\s*:\s*/g, ":").toUpperCase()); exactWhere = `upper(neutral_citation) = $1`; }
  else if (/\d/.test(q) && q.length <= 60 && /[/.]/.test(q)) { exactParams.push(q.toLowerCase()); exactWhere = `lower(case_number) = $1`; }
  if (exactWhere) {
    const f = corpusFilters(o, exactParams);
    const rows = await store.query({ query: `SELECT ${COLS} FROM corpus_judgments WHERE ${exactWhere}${f} ORDER BY decision_date DESC NULLS LAST LIMIT ${limit}`, params: exactParams });
    for (const r of rows) { seen.add(String(r.id)); hits.push(toHit(r, "exact")); }
  }
  if (hits.length >= limit || !q) return done();

  const params: SqlValue[] = [q];
  const f = corpusFilters(o, params);
  const rows = await store.query({
    query: `SELECT ${COLS}, ts_rank_cd(search, websearch_to_tsquery('english', $1)) + ts_rank_cd(search, websearch_to_tsquery('simple', $1)) AS rank
      FROM corpus_judgments
      WHERE (search @@ websearch_to_tsquery('english', $1) OR search @@ websearch_to_tsquery('simple', $1))${f}
      ORDER BY ${textOrder} LIMIT ${limit + hits.length}`,
    params,
  });
  for (const r of rows) {
    if (seen.has(String(r.id))) continue;
    seen.add(String(r.id));
    hits.push(toHit(r, "text"));
    if (hits.length >= limit) break;
  }
  // The index holds titles and published snippets, not full text, so requiring every word is often too strict. When
  // the strict query leaves room, add records matching any of the words, ranked by how many (and where) they match.
  const words = q.replace(/["()]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(or|and|not)$/i.test(w));
  // An identifier query that resolved exactly does not get loosely matching neighbours appended.
  const exactFound = hits.some((h) => h.match === "exact");
  if (!exactFound && hits.length < limit && words.length > 1) {
    const orParams: SqlValue[] = [words.join(" or ")];
    const fo = corpusFilters(o, orParams);
    const more = await store.query({
      query: `SELECT ${COLS}, ts_rank_cd(search, websearch_to_tsquery('english', $1)) AS rank
        FROM corpus_judgments WHERE search @@ websearch_to_tsquery('english', $1)${fo}
        ORDER BY ${textOrder} LIMIT ${limit * 2}`,
      params: orParams,
    });
    for (const r of more) {
      if (seen.has(String(r.id))) continue;
      seen.add(String(r.id));
      hits.push(toHit(r, "partial"));
      if (hits.length >= limit) break;
    }
  }
  return done();
}

export async function getCorpusJudgment(id: string, store: RemoteStore | null = remoteStore()): Promise<CorpusHit | null> {
  if (!store) throw new Error("The judgment corpus is not configured (DATABASE_URL).");
  await ensureCorpusSchema(store);
  const rows = await store.query({ query: `SELECT ${COLS} FROM corpus_judgments WHERE id = $1`, params: [id] });
  return rows[0] ? toHit(rows[0], "exact") : null;
}
