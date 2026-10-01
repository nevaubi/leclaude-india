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
  /** The judgment record's own neutral citation when the text is keyed by CNR (High Courts: "2024:KHC-D:7336"). */
  recordNeutralCitation?: string | null;
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

/** Matching chunks considered for ranking per search. */
const CANDIDATES = 3000;

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

/** Remove the dataset's structural markers ("[SECTION] ## ", "[TITLE] # ") without changing any words. */
export function cleanJudgmentText(text: string): string {
  return text.replace(/\[(SECTION|TITLE|SUBSECTION|HEADER)\]\s*#*\s*/g, "").replace(/^#{1,6}\s+/gm, "");
}

/** Plain text of chunks with page markers ("[p. 4]"), for readers and models. */
export function chunksToText(chunks: JudgmentTextChunk[]): string {
  let page: number | null = null;
  const out: string[] = [];
  for (const c of chunks) {
    if (c.pageStart != null && c.pageStart !== page) { out.push(`[p. ${c.pageStart}]`); page = c.pageStart; }
    out.push(cleanJudgmentText(c.text));
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
    // Bounded: at most CANDIDATES matching chunks are ranked (common phrases match hundreds of thousands); the text is
    // read only for the ranked page.
    query: `WITH c AS (
        SELECT t.id FROM corpus_texts t
        WHERE t.search @@ websearch_to_tsquery('english', $1)${extra}
        LIMIT ${CANDIDATES}
      ), m AS (
        SELECT t.neutral_citation, ${hcCols}, t.chunk_index, t.page_start, t.page_end, t.text,
               ts_rank_cd(t.search, websearch_to_tsquery('english', $1)) AS rank
        FROM corpus_texts t JOIN c ON c.id = t.id
        ORDER BY rank DESC LIMIT ${limit * 20}
      ), best AS (
        SELECT DISTINCT ON (${groupKey}) * FROM m ORDER BY ${groupKey}, rank DESC
      )
      SELECT b.neutral_citation, b.cnr, b.t_date, b.court_id, b.t_title, b.t_case_number, b.chunk_index, b.page_start, b.page_end, b.rank,
             ts_headline('english', left(b.text, 20000), websearch_to_tsquery('english', $1), 'MaxFragments=2, MaxWords=40, MinWords=15, StartSel="", StopSel="", FragmentDelimiter=" … "') AS passage,
             j.id, j.title, j.decision_date::text AS decision_date, j.reporter_citation, j.case_number, j.judges, j.pdf_url, j.neutral_citation AS j_neutral
      FROM best b LEFT JOIN LATERAL (
        SELECT id, title, decision_date, reporter_citation, case_number, judges, pdf_url, neutral_citation FROM corpus_judgments cj
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
        recordNeutralCitation: !neutral && r.j_neutral ? r.j_neutral : null,
        chunkIndex: Number(r.chunk_index),
        pageStart: r.page_start == null ? null : Number(r.page_start),
        pageEnd: r.page_end == null ? null : Number(r.page_end),
        passage: cleanJudgmentText(r.passage ?? "").replace(/\s+/g, " ").trim(),
        rank: Number(r.rank ?? 0),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Mentions of a judgment's citation in later judgments' text (citing references for corpus records)
// ---------------------------------------------------------------------------

/** A judgment in the corpus index, resolved exactly (never by name). */
export interface CorpusJudgmentRef {
  id: string;
  title: string;
  courtId: string | null;
  neutralCitation: string | null;
  reporterCitation: string | null;
  cnr: string | null;
  decisionDate: string | null;
  /** The key read_judgment_text accepts for it. */
  textKey: string;
}

/** High Court neutral citation ("2024:KHC-D:7336", "2025:TSHC:12"). */
const HC_NEUTRAL_RE = /^\s*(\d{4})\s*:\s*([A-Z][A-Z-]*)\s*:\s*(\d+)\s*$/i;

/**
 * Resolve a corpus id (sc:… / hc:…), a neutral citation (Supreme Court or High Court) or "CNR@YYYY-MM-DD" to the
 * judgment record in corpus_judgments. Null when nothing matches exactly; several matches for one citation are
 * refused (null) rather than one being chosen.
 */
export async function resolveCorpusJudgment(idOrCitation: string, store: RemoteStore | null = remoteStore()): Promise<CorpusJudgmentRef | null> {
  if (!store) return null;
  const key = idOrCitation.trim().replace(/^corpus:/, "");
  if (!key || key.length > 200) return null;
  const cols = `id, title, court_id, neutral_citation, reporter_citation, cnr, decision_date::text AS decision_date`;
  let rows: Row[] = [];
  const sc = canonicalNeutral(key);
  const hc = HC_NEUTRAL_RE.exec(key);
  const at = /^([A-Za-z]{4}\d{12})@(\d{4}-\d{2}-\d{2})$/.exec(key);
  if (sc) rows = await store.query({ query: `SELECT ${cols} FROM corpus_judgments WHERE upper(neutral_citation) = $1 ORDER BY id LIMIT 2`, params: [sc.toUpperCase()] });
  else if (hc) rows = await store.query({ query: `SELECT ${cols} FROM corpus_judgments WHERE upper(replace(neutral_citation, ' ', '')) = $1 ORDER BY id LIMIT 2`, params: [`${hc[1]}:${hc[2]}:${Number(hc[3])}`.toUpperCase()] });
  else if (at) rows = await store.query({ query: `SELECT ${cols} FROM corpus_judgments WHERE cnr = $1 AND decision_date = $2::date ORDER BY id LIMIT 2`, params: [at[1].toUpperCase(), at[2]] });
  else if (/^(sc|hc):\S+$/.test(key)) rows = await store.query({ query: `SELECT ${cols} FROM corpus_judgments WHERE id = $1`, params: [key] });
  else return null;
  if (rows.length !== 1) return null;
  const r = rows[0];
  const neutral = r.neutral_citation ? canonicalNeutral(r.neutral_citation) ?? r.neutral_citation : null;
  const textKey = r.court_id === "sci" && neutral ? neutral : r.cnr && r.decision_date ? `${r.cnr}@${r.decision_date}` : r.id ?? key;
  return { id: r.id ?? key, title: r.title ?? "", courtId: r.court_id, neutralCitation: neutral, reporterCitation: r.reporter_citation ?? null, cnr: r.cnr ?? null, decisionDate: r.decision_date ?? null, textKey };
}

/** A regex that finds a citation string in text with flexible spacing and punctuation ("(2024) 10 SCC 1" ≈ "[2024] 10 S.C.C. 1"). */
export function citationPattern(citation: string): RegExp | null {
  const tokens = citation.match(/[A-Za-z]+|\d+/g);
  if (!tokens || tokens.length < 2) return null;
  const sep = "[\\s.,:()\\[\\]-]*";
  return new RegExp(`(?<![A-Za-z0-9])${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(sep)}(?![0-9])`, "i");
}

export interface CitationMention {
  /** read_judgment_text key of the mentioning judgment. */
  key: string;
  judgmentId: string | null;
  citation: string;
  title: string | null;
  courtId: string;
  court: string;
  decisionDate: string | null;
  page: number | null;
  chunkIndex: number;
  /** Which citation string matched. */
  matched: string;
  passage: string;
}

/** Candidate chunks examined per citation string (bounded). */
const MENTION_CANDIDATES = 200;

/**
 * Judgments in corpus_texts whose text contains one of `citations` (exact phrase search, confirmed by a pattern match
 * on the chunk text), excluding the judgment whose text key is `excludeKey`. One row per mentioning judgment (the first
 * matching chunk), newest first. This is a text match: it says the citation is mentioned, not how it was treated.
 */
export async function findCitationMentions(
  citations: string[],
  opts: { excludeKey?: string; limit?: number } = {},
  store: RemoteStore | null = remoteStore(),
): Promise<{ available: boolean; mentions: CitationMention[]; checked: number }> {
  if (!store) return { available: false, mentions: [], checked: 0 };
  const info = await tableInfo(store);
  if (!info.ok) return { available: false, mentions: [], checked: 0 };
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 25));
  const phrases = Array.from(new Set(citations.map((c) => c.replace(/\s+/g, " ").trim()).filter((c) => c.length >= 6))).slice(0, 3);
  const hcCols = info.hc ? `t.cnr, t.decision_date::text AS t_date, t.court_id, t.title AS t_title` : `NULL::text AS cnr, NULL::text AS t_date, 'sci' AS court_id, NULL::text AS t_title`;
  const join = info.hc
    ? `CASE WHEN t.neutral_citation IS NOT NULL THEN upper(cj.neutral_citation) = upper(t.neutral_citation) ELSE cj.cnr = t.cnr AND cj.decision_date = t.decision_date END`
    : `upper(cj.neutral_citation) = upper(t.neutral_citation)`;
  const perPhrase = await Promise.all(phrases.map(async (phrase) => {
    const rows = await store.query({
      query: `WITH c AS (
          SELECT id FROM corpus_texts WHERE search @@ phraseto_tsquery('english', $1) LIMIT ${MENTION_CANDIDATES}
        )
        SELECT t.neutral_citation, ${hcCols}, t.chunk_index, t.page_start, left(t.text, 20000) AS text,
               j.id, j.title, j.decision_date::text AS decision_date
        FROM corpus_texts t JOIN c ON c.id = t.id
        LEFT JOIN LATERAL (SELECT id, title, decision_date FROM corpus_judgments cj WHERE ${join} ORDER BY id LIMIT 1) j ON true`,
      params: [phrase],
    });
    return { phrase, rows };
  }));
  const byKey = new Map<string, CitationMention>();
  let checked = 0;
  for (const { phrase, rows } of perPhrase) {
    const re = citationPattern(phrase);
    for (const r of rows) {
      checked++;
      const neutral = r.neutral_citation ? canonicalNeutral(r.neutral_citation) ?? r.neutral_citation : null;
      const date = r.decision_date ?? r.t_date ?? null;
      const key = neutral ?? (r.cnr && r.t_date ? `${r.cnr}@${r.t_date}` : null);
      if (!key || key === opts.excludeKey || byKey.has(key)) continue;
      const text = cleanJudgmentText(r.text ?? "");
      const m = re ? re.exec(text) : null;
      if (!m) continue;
      const s = Math.max(0, m.index - 350), e = Math.min(text.length, m.index + m[0].length + 350);
      const courtId = r.court_id ?? "sci";
      byKey.set(key, {
        key, judgmentId: r.id ?? null, citation: citeOf(neutral, r.cnr ?? null, date), title: r.title ?? r.t_title ?? null, courtId, court: courtName(courtId),
        decisionDate: date, page: r.page_start == null ? null : Number(r.page_start), chunkIndex: Number(r.chunk_index), matched: phrase,
        passage: `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ").trim()}${e < text.length ? "…" : ""}`,
      });
    }
  }
  const mentions = [...byKey.values()].sort((a, b) => (b.decisionDate ?? "").localeCompare(a.decisionDate ?? "") || a.key.localeCompare(b.key)).slice(0, limit);
  return { available: true, mentions, checked };
}

/**
 * Which of `citations` the judgment index carries as a judgment's own neutral or reporter citation (exact match after
 * whitespace/case normalisation). Returns the input strings that match. Found is not read: callers keep such
 * citations at "requires review".
 */
export async function corpusCitationsKnown(citations: string[], store: RemoteStore | null = remoteStore()): Promise<Set<string>> {
  const out = new Set<string>();
  if (!store || !citations.length) return out;
  const key = (c: string) => (canonicalNeutral(c) ?? c).replace(/\s+/g, " ").trim().toUpperCase();
  const want = new Map<string, string[]>();
  for (const c of citations.slice(0, 40)) { const k = key(c); want.set(k, [...(want.get(k) ?? []), c]); }
  const keys = [...want.keys()];
  const arr = `{${keys.map((k) => `"${k.replace(/["\\{}]/g, "")}"`).join(",")}}`;
  const rows = await store.query({
    query: `SELECT upper(neutral_citation) AS n, upper(reporter_citation) AS r FROM corpus_judgments
      WHERE upper(neutral_citation) = ANY($1::text[]) OR upper(reporter_citation) = ANY($1::text[]) LIMIT 200`,
    params: [arr],
  });
  for (const r of rows) for (const v of [r.n, r.r]) for (const c of (v ? want.get(v.replace(/\s+/g, " ").trim()) ?? [] : [])) out.add(c);
  return out;
}
