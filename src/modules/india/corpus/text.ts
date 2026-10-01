import "server-only";
import { remoteStore, type RemoteStore, type Row, type SqlValue } from "@/lib/db/remote";
import { courtById } from "@/lib/india/courts";
import { parseArray } from "./search";

/**
 * Full text of Supreme Court judgments (table `corpus_texts`, loaded by scripts/law-corpus/load_sc_judgment_text.py from
 * Open India Law, CC BY 4.0, text extracted from the Court's own PDFs). Chunks carry page numbers. A chunk belongs to a
 * judgment only by exact neutral citation; nothing is linked by name.
 *
 * Read-only. When the table is absent (not loaded) every function returns an explicit "unavailable" result instead of
 * throwing, so callers can fall back to metadata.
 */

export const TEXT_ATTRIBUTION = "Text: Open India Law (Vaquill), CC BY 4.0, extracted from the Supreme Court of India's published PDF. Verify quotations against the PDF.";

export interface JudgmentTextChunk { index: number; pageStart: number | null; pageEnd: number | null; section: string | null; text: string }
export interface JudgmentText {
  judgmentId: string;
  neutralCitation: string;
  title: string;
  totalChunks: number;
  chunks: JudgmentTextChunk[];
  /** Index of the first chunk not returned (null when the text ended). */
  nextChunk: number | null;
  attribution: string;
}

export interface TextSearchHit {
  judgmentId: string | null;
  neutralCitation: string;
  title: string | null;
  court: string;
  decisionDate: string | null;
  reporterCitation: string | null;
  judges: string[];
  pdfUrl: string | null;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  passage: string;
  rank: number;
}

let tableKnown: { at: number; ok: boolean } | null = null;

/** Whether corpus_texts exists (cached for 5 minutes). */
export async function judgmentTextAvailable(store: RemoteStore | null = remoteStore()): Promise<boolean> {
  if (!store) return false;
  if (tableKnown && Date.now() - tableKnown.at < 5 * 60_000) return tableKnown.ok;
  try {
    const r = await store.query({ query: `SELECT to_regclass('public.corpus_texts') IS NOT NULL AS ok` });
    tableKnown = { at: Date.now(), ok: String(r[0]?.ok) === "true" || String(r[0]?.ok) === "t" };
  } catch {
    tableKnown = { at: Date.now(), ok: false };
  }
  return tableKnown.ok;
}

export function resetTextTableCacheForTests() { tableKnown = null; }

/** "2024 INSC 735" in canonical form, or null when the value is not a Supreme Court neutral citation. */
export function canonicalNeutral(v: string | null | undefined): string | null {
  const m = /^\s*(\d{4})\s+INSC\s+(\d+)\s*$/i.exec(v ?? "");
  return m ? `${m[1]} INSC ${Number(m[2])}` : null;
}

function toChunk(r: Row): JudgmentTextChunk {
  const n = (v: string | null) => (v == null ? null : Number(v));
  return { index: Number(r.chunk_index), pageStart: n(r.page_start), pageEnd: n(r.page_end), section: r.section_type, text: r.text ?? "" };
}

/**
 * Text of one judgment, by corpus id (`sc:…`) or neutral citation. Returns chunks from `fromChunk` until `maxChars`
 * is reached (at least one chunk). Null when the judgment is unknown or has no text.
 */
export async function readJudgmentText(
  idOrCitation: string,
  opts: { fromChunk?: number; maxChars?: number; page?: number } = {},
  store: RemoteStore | null = remoteStore(),
): Promise<JudgmentText | null> {
  if (!store || !(await judgmentTextAvailable(store))) return null;
  const key = idOrCitation.trim();
  if (!key || key.length > 400) return null;
  let neutral = canonicalNeutral(key);
  let judgmentId: string | null = null;
  let title = "";
  if (neutral) {
    const j = await store.query({ query: `SELECT id, title FROM corpus_judgments WHERE upper(neutral_citation) = $1 ORDER BY id LIMIT 1`, params: [neutral.toUpperCase()] });
    judgmentId = j[0]?.id ?? null;
    title = j[0]?.title ?? "";
  } else {
    const j = await store.query({ query: `SELECT id, title, neutral_citation FROM corpus_judgments WHERE id = $1`, params: [key] });
    if (!j[0]) return null;
    judgmentId = j[0].id;
    title = j[0].title ?? "";
    neutral = canonicalNeutral(j[0].neutral_citation);
    if (!neutral) return null;
  }
  const maxChars = Math.max(2000, Math.min(opts.maxChars ?? 60_000, 400_000));
  let from = Math.max(0, Math.floor(opts.fromChunk ?? 0));
  if (opts.page != null && Number.isFinite(opts.page)) {
    const p = await store.query({
      query: `SELECT min(chunk_index) AS i FROM corpus_texts WHERE neutral_citation = $1 AND page_start <= $2 AND coalesce(page_end, page_start) >= $2`,
      params: [neutral.toUpperCase(), Math.floor(opts.page)],
    });
    if (p[0]?.i == null) return { judgmentId: judgmentId ?? "", neutralCitation: neutral, title, totalChunks: 0, chunks: [], nextChunk: null, attribution: TEXT_ATTRIBUTION };
    from = Number(p[0].i);
  }
  const rows = await store.query({
    query: `SELECT chunk_index, total_chunks, page_start, page_end, section_type, text FROM corpus_texts
      WHERE neutral_citation = $1 AND chunk_index >= $2 ORDER BY chunk_index LIMIT 400`,
    params: [neutral.toUpperCase(), from],
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
  const nextChunk = last && rows.length > chunks.length ? rows[chunks.length].chunk_index != null ? Number(rows[chunks.length].chunk_index) : null : null;
  return { judgmentId: judgmentId ?? "", neutralCitation: neutral, title, totalChunks: total, chunks, nextChunk, attribution: TEXT_ATTRIBUTION };
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
 * Full-text search over Supreme Court judgment text: best passage per judgment, ranked. Bounded (a tsquery is always
 * required; at most 50 judgments).
 */
export async function searchJudgmentText(
  q: string,
  opts: { yearFrom?: number; yearTo?: number; limit?: number } = {},
  store: RemoteStore | null = remoteStore(),
): Promise<{ available: boolean; hits: TextSearchHit[] }> {
  const query = q.trim();
  if (!store || !query) return { available: Boolean(store), hits: [] };
  if (!(await judgmentTextAvailable(store))) return { available: false, hits: [] };
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const params: SqlValue[] = [query.slice(0, 400)];
  const where: string[] = [];
  if (opts.yearFrom) { params.push(opts.yearFrom); where.push(`substr(t.neutral_citation, 1, 4)::int >= $${params.length}`); }
  if (opts.yearTo) { params.push(opts.yearTo); where.push(`substr(t.neutral_citation, 1, 4)::int <= $${params.length}`); }
  const extra = where.length ? ` AND ${where.join(" AND ")}` : "";
  const rows = await store.query({
    query: `WITH m AS (
        SELECT t.neutral_citation, t.chunk_index, t.page_start, t.page_end, t.text,
               ts_rank_cd(t.search, websearch_to_tsquery('english', $1)) AS rank
        FROM corpus_texts t
        WHERE t.search @@ websearch_to_tsquery('english', $1)${extra}
        ORDER BY rank DESC LIMIT ${limit * 20}
      ), best AS (
        SELECT DISTINCT ON (neutral_citation) * FROM m ORDER BY neutral_citation, rank DESC
      )
      SELECT b.neutral_citation, b.chunk_index, b.page_start, b.page_end, b.rank,
             ts_headline('english', left(b.text, 20000), websearch_to_tsquery('english', $1), 'MaxFragments=2, MaxWords=40, MinWords=15, StartSel=, StopSel=') AS passage,
             j.id, j.title, j.decision_date::text AS decision_date, j.reporter_citation, j.judges, j.pdf_url
      FROM best b LEFT JOIN LATERAL (
        SELECT id, title, decision_date, reporter_citation, judges, pdf_url FROM corpus_judgments
        WHERE upper(neutral_citation) = b.neutral_citation ORDER BY id LIMIT 1
      ) j ON true
      ORDER BY b.rank DESC LIMIT ${limit}`,
    params,
  });
  const court = courtById("sci")?.name ?? "Supreme Court of India";
  return {
    available: true,
    hits: rows.map((r) => ({
      judgmentId: r.id ?? null,
      neutralCitation: r.neutral_citation ?? "",
      title: r.title ?? null,
      court,
      decisionDate: r.decision_date ?? null,
      reporterCitation: r.reporter_citation ?? null,
      judges: parseArray(r.judges),
      pdfUrl: r.pdf_url ?? null,
      chunkIndex: Number(r.chunk_index),
      pageStart: r.page_start == null ? null : Number(r.page_start),
      pageEnd: r.page_end == null ? null : Number(r.page_end),
      passage: (r.passage ?? "").replace(/\s+/g, " ").trim(),
      rank: Number(r.rank ?? 0),
    })),
  };
}
