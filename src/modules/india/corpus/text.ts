import "server-only";
import { remoteStore, type RemoteStore, type Row, type SqlValue } from "@/lib/db/remote";
import { courtById } from "@/lib/india/courts";
import { parseArray } from "./search";

/**
 * Full text of judgments (table `corpus_texts`, loaded from Open India Law, CC BY 4.0, text extracted from the courts'
 * own published PDFs; scripts/law-corpus/load_sc_judgment_text.py and load_hc_judgment_text.py). Chunks carry page
 * numbers.
 *
 * Identity, never by name:
 * - Supreme Court text belongs to a judgment by exact neutral citation ("2024 INSC 735").
 * - High Court text belongs to a judgment by CNR *and* decision date (a CNR can carry several orders; one order's text
 *   is never shown for another).
 *
 * Read-only. When the table is absent (not loaded) every function returns an explicit "unavailable" result instead of
 * throwing, so callers can fall back to metadata.
 */

export const TEXT_ATTRIBUTION = "Text: Open India Law (Vaquill), CC BY 4.0, extracted from the court's published PDF. Verify quotations against the PDF.";

export interface JudgmentTextChunk { index: number; pageStart: number | null; pageEnd: number | null; section: string | null; text: string }
export interface JudgmentText {
  judgmentId: string;
  /** Neutral citation (Supreme Court) or null. */
  neutralCitation: string | null;
  /** CNR (High Courts) or null. */
  cnr: string | null;
  decisionDate: string | null;
  courtId: string;
  /** How to cite the text: the neutral citation, or the CNR with the decision date. */
  citation: string;
  title: string;
  totalChunks: number;
  chunks: JudgmentTextChunk[];
  /** Index of the first chunk not returned (null when the text ended). */
  nextChunk: number | null;
  attribution: string;
}

export interface TextSearchHit {
  judgmentId: string | null;
  neutralCitation: string | null;
  cnr: string | null;
  courtId: string;
  citation: string;
  title: string | null;
  court: string;
  decisionDate: string | null;
  reporterCitation: string | null;
  caseNumber: string | null;
  judges: string[];
  pdfUrl: string | null;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  passage: string;
  rank: number;
}

let tableKnown: { at: number; ok: boolean; hc: boolean } | null = null;

async function tableInfo(store: RemoteStore): Promise<{ ok: boolean; hc: boolean }> {
  if (tableKnown && Date.now() - tableKnown.at < 5 * 60_000) return tableKnown;
  try {
    const r = await store.query({
      query: `SELECT to_regclass('public.corpus_texts') IS NOT NULL AS ok,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'corpus_texts' AND column_name = 'cnr') AS hc`,
    });
    const t = (v: unknown) => String(v) === "true" || String(v) === "t";
    tableKnown = { at: Date.now(), ok: t(r[0]?.ok), hc: t(r[0]?.hc) };
  } catch {
    tableKnown = { at: Date.now(), ok: false, hc: false };
  }
  return tableKnown;
}

/** Whether corpus_texts exists (cached for 5 minutes). */
export async function judgmentTextAvailable(store: RemoteStore | null = remoteStore()): Promise<boolean> {
  return store ? (await tableInfo(store)).ok : false;
}

export function resetTextTableCacheForTests() { tableKnown = null; }

/** "2024 INSC 735" in canonical form, or null when the value is not a Supreme Court neutral citation. */
export function canonicalNeutral(v: string | null | undefined): string | null {
  const m = /^\s*(\d{4})\s+INSC\s+(\d+)\s*$/i.exec(v ?? "");
  return m ? `${m[1]} INSC ${Number(m[2])}` : null;
}

const CNR_RE = /^[A-Z]{4}\d{12}$/;

function toChunk(r: Row): JudgmentTextChunk {
  const n = (v: string | null) => (v == null ? null : Number(v));
  return { index: Number(r.chunk_index), pageStart: n(r.page_start), pageEnd: n(r.page_end), section: r.section_type, text: r.text ?? "" };
}

const courtName = (id: string) => courtById(id)?.name ?? id;
const citeOf = (neutral: string | null, cnr: string | null, date: string | null) => neutral ?? `CNR ${cnr}${date ? `, decided ${date}` : ""}`;

interface TextKey { courtId: string; neutral: string | null; cnr: string | null; date: string | null; judgmentId: string; title: string }

/** Resolve a corpus id, a neutral citation or (High Courts) "CNR@YYYY-MM-DD" to the key its text is stored under. */
async function resolveKey(store: RemoteStore, key: string, hc: boolean): Promise<TextKey | null> {
  const neutral = canonicalNeutral(key);
  if (neutral) {
    const j = await store.query({ query: `SELECT id, title FROM corpus_judgments WHERE upper(neutral_citation) = $1 ORDER BY id LIMIT 1`, params: [neutral.toUpperCase()] });
    return { courtId: "sci", neutral, cnr: null, date: null, judgmentId: j[0]?.id ?? "", title: j[0]?.title ?? "" };
  }
  const at = /^([A-Za-z]{4}\d{12})@(\d{4}-\d{2}-\d{2})$/.exec(key);
  if (at) {
    if (!hc) return null;
    const cnr = at[1].toUpperCase();
    const j = await store.query({ query: `SELECT id, title, court_id FROM corpus_judgments WHERE cnr = $1 AND decision_date = $2::date ORDER BY id LIMIT 1`, params: [cnr, at[2]] });
    return { courtId: j[0]?.court_id ?? "", neutral: null, cnr, date: at[2], judgmentId: j[0]?.id ?? "", title: j[0]?.title ?? "" };
  }
  const j = await store.query({ query: `SELECT id, title, court_id, neutral_citation, cnr, decision_date::text AS decision_date FROM corpus_judgments WHERE id = $1`, params: [key] });
  const r = j[0];
  if (!r) return null;
  if (r.court_id === "sci") {
    const n = canonicalNeutral(r.neutral_citation);
    return n ? { courtId: "sci", neutral: n, cnr: null, date: null, judgmentId: r.id ?? key, title: r.title ?? "" } : null;
  }
  if (!hc || !r.cnr || !CNR_RE.test(r.cnr) || !r.decision_date) return null;
  return { courtId: r.court_id ?? "", neutral: null, cnr: r.cnr, date: r.decision_date, judgmentId: r.id ?? key, title: r.title ?? "" };
}

/**
 * Text of one judgment, by corpus id (`sc:…`, `hc:…`), Supreme Court neutral citation, or "CNR@YYYY-MM-DD". Returns
 * chunks from `fromChunk` (or the chunk holding `page`) until `maxChars` is reached (at least one chunk). Null when the
 * judgment is unknown or has no text.
 */
export async function readJudgmentText(
  idOrCitation: string,
  opts: { fromChunk?: number; maxChars?: number; page?: number } = {},
  store: RemoteStore | null = remoteStore(),
): Promise<JudgmentText | null> {
  if (!store) return null;
  const info = await tableInfo(store);
  if (!info.ok) return null;
  const key = idOrCitation.trim();
  if (!key || key.length > 400) return null;
  const k = await resolveKey(store, key, info.hc);
  if (!k) return null;
  const where = k.neutral ? `neutral_citation = $1` : `cnr = $1 AND decision_date = $2::date`;
  const keyParams: SqlValue[] = k.neutral ? [k.neutral.toUpperCase()] : [k.cnr, k.date];
  const base = {
    judgmentId: k.judgmentId, neutralCitation: k.neutral, cnr: k.cnr, decisionDate: k.date, courtId: k.courtId,
    citation: citeOf(k.neutral, k.cnr, k.date), title: k.title, attribution: TEXT_ATTRIBUTION,
  };
  const maxChars = Math.max(2000, Math.min(opts.maxChars ?? 60_000, 400_000));
  let from = Math.max(0, Math.floor(opts.fromChunk ?? 0));
  if (opts.page != null && Number.isFinite(opts.page)) {
    const p = await store.query({
      query: `SELECT min(chunk_index) AS i FROM corpus_texts WHERE ${where} AND page_start <= $${keyParams.length + 1} AND coalesce(page_end, page_start) >= $${keyParams.length + 1}`,
      params: [...keyParams, Math.floor(opts.page)],
    });
    if (p[0]?.i == null) return { ...base, totalChunks: 0, chunks: [], nextChunk: null };
    from = Number(p[0].i);
  }
  const rows = await store.query({
    query: `SELECT chunk_index, total_chunks, page_start, page_end, section_type, text FROM corpus_texts
      WHERE ${where} AND chunk_index >= $${keyParams.length + 1} ORDER BY chunk_index LIMIT 400`,
    params: [...keyParams, from],
  });
  if (!rows.length && from === 0) return null;
  const chunks: JudgmentTextChunk[] = [];
  let used = 0;
  for (const r of rows) {
    const c = toChunk(r);
    if (chunks.length && used + c.text.length > maxChars) break;
    chunks.push(c);
    used += c.text.length;
  }
  const last = chunks[chunks.length - 1];
  const total = Number(rows[0]?.total_chunks ?? 0) || (last ? last.index + 1 : 0);
  const nextChunk = rows.length > chunks.length ? Number(rows[chunks.length].chunk_index) : null;
  return { ...base, totalChunks: total, chunks, nextChunk };
}

/** Plain text of chunks with page markers ("[p. 4]"), for readers and models. */
export function chunksToText(chunks: JudgmentTextChunk[]): string {
  let page: number | null = null;
  const out: string[] = [];
  for (const c of chunks) {
    if (c.pageStart != null && c.pageStart !== page) { out.push(`[p. ${c.pageStart}]`); page = c.pageStart; }
    out.push(c.text);
  }
  return out.join("\n\n");
}

/**
 * Full-text search over judgment text: best passage per judgment, ranked. Bounded (a tsquery is always required; at
 * most 50 judgments). `courts` restricts by registry court id ("sci", "hc-karnataka", …).
 */
export async function searchJudgmentText(
  q: string,
  opts: { yearFrom?: number; yearTo?: number; limit?: number; courts?: string[] } = {},
  store: RemoteStore | null = remoteStore(),
): Promise<{ available: boolean; hits: TextSearchHit[] }> {
  const query = q.trim();
  if (!store || !query) return { available: Boolean(store), hits: [] };
  const info = await tableInfo(store);
  if (!info.ok) return { available: false, hits: [] };
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const params: SqlValue[] = [query.slice(0, 400)];
  const where: string[] = [];
  const yearExpr = info.hc ? `coalesce(extract(year FROM t.decision_date)::int, substr(t.neutral_citation, 1, 4)::int)` : `substr(t.neutral_citation, 1, 4)::int`;
  if (opts.yearFrom) { params.push(opts.yearFrom); where.push(`${yearExpr} >= $${params.length}`); }
  if (opts.yearTo) { params.push(opts.yearTo); where.push(`${yearExpr} <= $${params.length}`); }
  const courts = (opts.courts ?? []).filter((c) => /^(sci|hc-[a-z-]+)$/.test(c));
  if (courts.length) {
    if (info.hc) { params.push(`{${courts.join(",")}}`); where.push(`t.court_id = ANY($${params.length}::text[])`); }
    else if (!courts.includes("sci")) return { available: true, hits: [] };
  }
  const extra = where.length ? ` AND ${where.join(" AND ")}` : "";
  const hcCols = info.hc ? `t.cnr, t.decision_date::text AS t_date, t.court_id, t.title AS t_title, t.case_number AS t_case_number` : `NULL::text AS cnr, NULL::text AS t_date, 'sci' AS court_id, NULL::text AS t_title, NULL::text AS t_case_number`;
  const groupKey = info.hc ? `coalesce(neutral_citation, cnr || '@' || t_date)` : `neutral_citation`;
  const join = info.hc
    ? `CASE WHEN b.neutral_citation IS NOT NULL THEN upper(cj.neutral_citation) = b.neutral_citation ELSE cj.cnr = b.cnr AND cj.decision_date = b.t_date::date END`
    : `upper(cj.neutral_citation) = b.neutral_citation`;
  const rows = await store.query({
    query: `WITH m AS (
        SELECT t.neutral_citation, ${hcCols}, t.chunk_index, t.page_start, t.page_end, t.text,
               ts_rank_cd(t.search, websearch_to_tsquery('english', $1)) AS rank
        FROM corpus_texts t
        WHERE t.search @@ websearch_to_tsquery('english', $1)${extra}
        ORDER BY rank DESC LIMIT ${limit * 20}
      ), best AS (
        SELECT DISTINCT ON (${groupKey}) * FROM m ORDER BY ${groupKey}, rank DESC
      )
      SELECT b.neutral_citation, b.cnr, b.t_date, b.court_id, b.t_title, b.t_case_number, b.chunk_index, b.page_start, b.page_end, b.rank,
             ts_headline('english', left(b.text, 20000), websearch_to_tsquery('english', $1), 'MaxFragments=2, MaxWords=40, MinWords=15, StartSel=, StopSel=') AS passage,
             j.id, j.title, j.decision_date::text AS decision_date, j.reporter_citation, j.case_number, j.judges, j.pdf_url
      FROM best b LEFT JOIN LATERAL (
        SELECT id, title, decision_date, reporter_citation, case_number, judges, pdf_url FROM corpus_judgments cj
        WHERE ${join} ORDER BY id LIMIT 1
      ) j ON true
      ORDER BY b.rank DESC LIMIT ${limit}`,
    params,
  });
  return {
    available: true,
    hits: rows.map((r) => {
      const courtId = r.court_id ?? "sci";
      const neutral = r.neutral_citation ? canonicalNeutral(r.neutral_citation) ?? r.neutral_citation : null;
      const date = r.decision_date ?? r.t_date ?? null;
      return {
        judgmentId: r.id ?? null,
        neutralCitation: neutral,
        cnr: r.cnr ?? null,
        courtId,
        citation: citeOf(neutral, r.cnr ?? null, date),
        title: r.title ?? r.t_title ?? null,
        court: courtName(courtId),
        decisionDate: date,
        reporterCitation: r.reporter_citation ?? null,
        caseNumber: r.case_number ?? r.t_case_number ?? null,
        judges: parseArray(r.judges),
        pdfUrl: r.pdf_url ?? null,
        chunkIndex: Number(r.chunk_index),
        pageStart: r.page_start == null ? null : Number(r.page_start),
        pageEnd: r.page_end == null ? null : Number(r.page_end),
        passage: (r.passage ?? "").replace(/\s+/g, " ").trim(),
        rank: Number(r.rank ?? 0),
      };
    }),
  };
}
