import "server-only";
import { courtById } from "@/lib/india/courts";
import { remoteStore, type RemoteStore, type Row, type SqlValue } from "@/lib/db/remote";
import { defaultEmbed, EMBED_DIMS, embeddingModel, vectorLiteral, type EmbedFn } from "@/modules/official/embed";
import { rrfFuse } from "@/modules/official/search";
import { ensureJudgmentEmbedSchema, TEXT_SHA_SQL, type EmbedSupport } from "./embeddings";
import { parseArray } from "./search";
import { canonicalNeutral, cleanJudgmentText, searchJudgmentText, type TextSearchHit } from "./text";

/**
 * Hybrid retrieval over judgment full text (roadmap P3.1): Postgres full text (searchJudgmentText, best passage per
 * judgment) fused by reciprocal rank fusion (k = 60, the official-sources convention) with a pgvector ANN search over
 * judgment chunk embeddings (corpus_text_embeddings).
 *
 * Honesty rules:
 * - Semantic results exist only where judgments were embedded with the configured model and the vector still matches the
 *   chunk's current text (text_sha256). Otherwise the search is keyword-only and says why in `note` (never presented as
 *   hybrid).
 * - An ANN neighbour is a match only within the cosine-distance cutoff (JUDGMENT_SEMANTIC_MAX_DISTANCE, default 0.55).
 * - Filters (courts, years, bench strength, judge, disposal, statute sections) apply to both lists; a metadata filter
 *   drops text that is not linked to a judgment record (its bench / judges / disposal cannot be established).
 */

export const SEMANTIC_CANDIDATES = 100;
export const DEFAULT_JUDGMENT_MAX_DISTANCE = 0.55;

export function judgmentMaxDistance(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.JUDGMENT_SEMANTIC_MAX_DISTANCE;
  const n = Number(raw);
  return raw != null && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.min(n, 2) : DEFAULT_JUDGMENT_MAX_DISTANCE;
}

export interface JudgmentFilters {
  courts?: string[];
  yearFrom?: number;
  yearTo?: number;
  /** Minimum bench strength (corpus_judgments.bench_strength). */
  benchMin?: number;
  /** Case-insensitive substring of a judge's name (corpus_judgments.judges_text). */
  judge?: string;
  /** Case-insensitive substring of the disposal ("Allowed", "Dismissed"). */
  disposal?: string;
  /** Citator statute keys ("BNSS 2023 s.482", "CrPC 1973 s.438"): judgments whose text cites any of them. */
  sectionKeys?: string[];
}

export type MatchKind = "keyword" | "semantic" | "both";
export interface HybridHit extends TextSearchHit { match: MatchKind; similarity?: number; fusedScore: number }

export interface HybridResult {
  available: boolean;
  mode: "hybrid" | "keyword";
  hits: HybridHit[];
  /** Why semantic retrieval did not contribute (absent when it did). */
  note?: string;
  /** Filters that could not be applied (and how the search degraded). */
  filterNotes: string[];
}

export interface HybridDeps { embed?: EmbedFn; model?: string | null; maxDistance?: number }

/** Text key of a hit: neutral citation, else CNR@date. */
export const hitKey = (h: Pick<TextSearchHit, "neutralCitation" | "cnr" | "decisionDate" | "judgmentId">): string => h.neutralCitation ?? (h.cnr && h.decisionDate ? `${h.cnr}@${h.decisionDate}` : `id:${h.judgmentId ?? ""}`);

const hasMetaFilter = (f: JudgmentFilters) => Boolean(f.benchMin || f.judge?.trim() || f.disposal?.trim() || f.sectionKeys?.length);

let citatorKnown: { at: number; ok: boolean } | null = null;
async function citatorAvailable(store: RemoteStore): Promise<boolean> {
  if (citatorKnown && Date.now() - citatorKnown.at < 5 * 60_000) return citatorKnown.ok;
  try {
    const r = await store.query({ query: `SELECT to_regclass('public.corpus_citations') IS NOT NULL AS ok` });
    citatorKnown = { at: Date.now(), ok: String(r[0]?.ok) === "true" || String(r[0]?.ok) === "t" };
  } catch { citatorKnown = { at: Date.now(), ok: false }; }
  return citatorKnown.ok;
}
export function resetHybridCachesForTests() { citatorKnown = null; }

/** SQL conditions on corpus_judgments (alias j) for the metadata filters. Parameters are appended to `params`. */
export function judgmentMetaWhere(f: JudgmentFilters, params: SqlValue[], o: { citator: boolean }): { where: string[]; notes: string[] } {
  const where: string[] = [];
  const notes: string[] = [];
  const p = (v: SqlValue) => { params.push(v); return `$${params.length}`; };
  if (f.benchMin && f.benchMin > 1) where.push(`coalesce(j.bench_strength, 0) >= ${p(Math.floor(f.benchMin))}`);
  if (f.judge?.trim()) where.push(`j.judges_text ILIKE ${p(`%${f.judge.trim().replace(/[%_\\]/g, "")}%`)}`);
  if (f.disposal?.trim()) where.push(`j.disposal ILIKE ${p(`%${f.disposal.trim().replace(/[%_\\]/g, "")}%`)}`);
  if (f.sectionKeys?.length) {
    if (o.citator) where.push(`EXISTS (SELECT 1 FROM corpus_citations cc WHERE cc.citing_id = j.id AND cc.kind = 'statute' AND cc.key = ANY(${p(`{${f.sectionKeys.map((k) => `"${k.replace(/["\\{}]/g, "")}"`).join(",")}}`)}::text[]))`);
    else notes.push("Statute-section filter not applied: the citator (corpus_citations) is not built on this database; the section was added to the search terms instead.");
  }
  return { where, notes };
}

/** Ids among `ids` whose judgment record passes the metadata filters. */
async function passingIds(store: RemoteStore, ids: string[], f: JudgmentFilters, citator: boolean): Promise<{ ok: Set<string>; notes: string[] }> {
  if (!ids.length) return { ok: new Set(), notes: [] };
  const params: SqlValue[] = [`{${ids.map((i) => `"${i.replace(/["\\{}]/g, "")}"`).join(",")}}`];
  const { where, notes } = judgmentMetaWhere(f, params, { citator });
  const rows = await store.query({ query: `SELECT j.id FROM corpus_judgments j WHERE j.id = ANY($1::text[])${where.length ? ` AND ${where.join(" AND ")}` : ""}`, params });
  return { ok: new Set(rows.map((r) => String(r.id))), notes };
}

/** Best semantic chunk per judgment within the cutoff, ordered by distance. */
async function semanticCandidates(store: RemoteStore, vec: Float32Array, model: string, type: "halfvec" | "vector", f: JudgmentFilters, maxDistance: number): Promise<{ key: string; chunkId: string; dist: number }[] | null> {
  const params: SqlValue[] = [vectorLiteral(vec), model];
  const where: string[] = [`e.embedding_v IS NOT NULL`, `e.embedding_model = $2`];
  const courts = (f.courts ?? []).filter((c) => /^(sci|hc-[a-z-]+)$/.test(c));
  if (courts.length) { params.push(`{${courts.join(",")}}`); where.push(`e.court_id = ANY($${params.length}::text[])`); }
  if (f.yearFrom) { params.push(f.yearFrom); where.push(`e.decision_year >= $${params.length}`); }
  if (f.yearTo) { params.push(f.yearTo); where.push(`e.decision_year <= $${params.length}`); }
  const res = await store.transaction([
    { query: `SELECT set_config('statement_timeout', '8000', true) AS t` },
    { query: `SELECT set_config('hnsw.ef_search', '${SEMANTIC_CANDIDATES}', true) AS e, set_config('hnsw.iterative_scan', 'strict_order', true) AS scan` },
    { query: `SELECT e.chunk_id, e.text_key, (e.embedding_v <=> $1::${type})::float8 AS dist FROM corpus_text_embeddings e WHERE ${where.join(" AND ")} ORDER BY e.embedding_v <=> $1::${type} LIMIT ${SEMANTIC_CANDIDATES}`, params },
  ]);
  const rows = res[res.length - 1] ?? [];
  if (!rows.length) return null; // nothing embedded in scope
  const best = new Map<string, { key: string; chunkId: string; dist: number }>();
  for (const r of rows) {
    const dist = Number(r.dist);
    if (!Number.isFinite(dist) || dist > maxDistance) continue;
    const key = String(r.text_key);
    if (!best.has(key)) best.set(key, { key, chunkId: String(r.chunk_id), dist });
  }
  return [...best.values()].sort((a, b) => a.dist - b.dist || a.key.localeCompare(b.key));
}

/** Hit rows for semantic-only chunks (the chunk text must still match the vector's text hash). */
async function semanticHitRows(store: RemoteStore, chunkIds: string[], hc: boolean): Promise<Row[]> {
  if (!chunkIds.length) return [];
  const join = hc
    ? `CASE WHEN t.neutral_citation IS NOT NULL THEN upper(cj.neutral_citation) = upper(t.neutral_citation) ELSE cj.cnr = t.cnr AND cj.decision_date = t.decision_date END`
    : `upper(cj.neutral_citation) = upper(t.neutral_citation)`;
  const hcCols = hc ? `t.cnr, t.decision_date::text AS t_date, t.court_id AS t_court, t.title AS t_title, t.case_number AS t_case_number` : `NULL::text AS cnr, NULL::text AS t_date, 'sci' AS t_court, NULL::text AS t_title, NULL::text AS t_case_number`;
  return store.query({
    query: `SELECT t.id AS chunk_id, t.neutral_citation, ${hcCols}, t.chunk_index, t.page_start, t.page_end, left(t.text, 1200) AS passage,
        j.id, j.title, j.decision_date::text AS decision_date, j.reporter_citation, j.case_number, j.judges, j.pdf_url, j.neutral_citation AS j_neutral
      FROM corpus_texts t JOIN corpus_text_embeddings e ON e.chunk_id = t.id AND e.text_sha256 = ${TEXT_SHA_SQL("t")}
      LEFT JOIN LATERAL (SELECT id, title, decision_date, reporter_citation, case_number, judges, pdf_url, neutral_citation FROM corpus_judgments cj WHERE ${join} ORDER BY id LIMIT 1) j ON true
      WHERE t.id = ANY($1::text[])`,
    params: [`{${chunkIds.map((i) => `"${i.replace(/["\\{}]/g, "")}"`).join(",")}}`],
  });
}

function rowToHit(r: Row): TextSearchHit {
  const courtId = r.t_court ?? "sci";
  const neutral = r.neutral_citation ? canonicalNeutral(r.neutral_citation) ?? r.neutral_citation : null;
  const date = r.decision_date ?? r.t_date ?? null;
  return {
    judgmentId: r.id ?? null, neutralCitation: neutral, cnr: r.cnr ?? null, courtId,
    citation: neutral ?? `CNR ${r.cnr}${date ? `, decided ${date}` : ""}`, title: r.title ?? r.t_title ?? null, court: courtById(courtId)?.name ?? courtId,
    decisionDate: date, reporterCitation: r.reporter_citation ?? null, caseNumber: r.case_number ?? r.t_case_number ?? null, judges: parseArray(r.judges), pdfUrl: r.pdf_url ?? null,
    recordNeutralCitation: !neutral && r.j_neutral ? r.j_neutral : null, chunkIndex: Number(r.chunk_index), pageStart: r.page_start == null ? null : Number(r.page_start), pageEnd: r.page_end == null ? null : Number(r.page_end),
    passage: cleanJudgmentText(r.passage ?? "").replace(/\s+/g, " ").trim().slice(0, 600), rank: 0,
  };
}

/**
 * Hybrid judgment text search. `limit` judgments at most (one passage each). Never throws for missing embeddings; throws
 * only for the keyword search's own failures (as searchJudgmentText does).
 */
export async function searchJudgmentTextHybrid(q: string, f: JudgmentFilters & { limit?: number } = {}, store: RemoteStore | null = remoteStore(), deps: HybridDeps = {}): Promise<HybridResult> {
  const limit = Math.max(1, Math.min(f.limit ?? 10, 50));
  const filterNotes: string[] = [];
  if (!store || !q.trim()) return { available: Boolean(store), mode: "keyword", hits: [], filterNotes };
  const meta = hasMetaFilter(f);
  const citator = f.sectionKeys?.length ? await citatorAvailable(store) : false;
  const model = deps.model === undefined ? (await embeddingModel()) : deps.model;
  // The query embedding runs while the keyword search runs.
  const vecP: Promise<Float32Array | null> = model ? (deps.embed ?? defaultEmbed())([q.trim()], { query: true }).then((v) => v[0] ?? null, () => null) : Promise.resolve(null);
  const kw = await searchJudgmentText(q, { courts: f.courts, yearFrom: f.yearFrom, yearTo: f.yearTo, limit: Math.min(50, meta ? limit * 3 : limit * 2) }, store);
  if (!kw.available) return { available: false, mode: "keyword", hits: [], filterNotes };

  let note: string | undefined;
  let semantic: { key: string; chunkId: string; dist: number }[] = [];
  const support: EmbedSupport = model ? await ensureJudgmentEmbedSchema(store) : { ready: false, hc: false, vector: null };
  if (!model) note = "Semantic retrieval is not configured (no embedding provider); judgment results are keyword (full-text) matches only.";
  else if (!support.ready || !support.vector) note = `Semantic retrieval unavailable${support.error ? ` (${support.error})` : ""}; judgment results are keyword (full-text) matches only.`;
  else {
    const vec = await vecP;
    if (!vec || vec.length !== EMBED_DIMS) note = "The query could not be embedded; judgment results are keyword (full-text) matches only.";
    else {
      try {
        const s = await semanticCandidates(store, vec, model, support.vector, f, deps.maxDistance ?? judgmentMaxDistance());
        if (s === null) note = "No judgment embeddings exist yet for the courts and years in scope; judgment results are keyword (full-text) matches only.";
        else semantic = s;
      } catch (e) {
        note = `Semantic retrieval failed (${(e as Error).message.slice(0, 120)}); judgment results are keyword (full-text) matches only.`;
      }
    }
  }

  const kwHits = kw.hits;
  const kwKeys = kwHits.map(hitKey);
  const lists = semantic.length ? [kwKeys, semantic.map((s) => s.key)] : [kwKeys];
  const fused = rrfFuse(lists);
  const kwByKey = new Map(kwHits.map((h) => [hitKey(h), h] as const));
  const semByKey = new Map(semantic.map((s) => [s.key, s] as const));
  const semOnly = fused.filter((x) => !kwByKey.has(x.key) && semByKey.has(x.key)).slice(0, limit * 2).map((x) => semByKey.get(x.key)!.chunkId);
  const semRows = semOnly.length ? await semanticHitRows(store, semOnly, support.hc) : [];
  const semHitByKey = new Map<string, TextSearchHit>();
  for (const r of semRows) {
    const h = rowToHit(r);
    semHitByKey.set(hitKey(h), h);
    // The text key from corpus_texts identifies the chunk's judgment; keep the vector's key too (they agree by construction).
    const k = r.neutral_citation ? String(r.neutral_citation) : r.cnr && r.t_date ? `${r.cnr}@${r.t_date}` : null;
    if (k) semHitByKey.set(k, h);
  }

  let out: HybridHit[] = [];
  for (const x of fused) {
    const kwh = kwByKey.get(x.key);
    const sem = semByKey.get(x.key);
    const base = kwh ?? semHitByKey.get(x.key);
    if (!base) continue; // a semantic candidate whose text changed since it was embedded: not served
    out.push({ ...base, match: kwh && sem ? "both" : kwh ? "keyword" : "semantic", ...(sem ? { similarity: Math.round((1 - sem.dist) * 1e4) / 1e4 } : {}), fusedScore: Math.round(x.score * 1e6) / 1e6 });
  }

  if (meta) {
    const ids = Array.from(new Set(out.map((h) => h.judgmentId).filter((x): x is string => Boolean(x))));
    const { ok, notes } = await passingIds(store, ids, f, citator);
    filterNotes.push(...notes);
    const before = out.length;
    out = out.filter((h) => h.judgmentId && ok.has(h.judgmentId));
    if (before && !out.length) filterNotes.push("No full-text match passed the bench / judge / disposal / section filters.");
  }
  return { available: true, mode: semantic.length ? "hybrid" : "keyword", hits: out.slice(0, limit), note, filterNotes };
}

