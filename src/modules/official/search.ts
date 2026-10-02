import "server-only";
import { cosine } from "@/lib/ai/embeddings";
import type { RemoteStore, Row, SqlValue } from "@/lib/db/remote";
import { decodeVector, defaultEmbed, embeddingModel, ensureVectorSupport, EMBED_DIMS, vectorLiteral, type EmbedFn } from "./embed";
import { sourceDef } from "./registry";
import type { OfficialSearchResult } from "./service";
import { isSourceId, sourceRef, type ExtractionMethod, type SourceId, type SourceKind, type SourceSearchHit, type SourceSearchQuery } from "./types";
import { officialStore, pgArray } from "./units";

/**
 * Hybrid retrieval over official-document chunks.
 *
 * Keyword: Postgres full text (websearch_to_tsquery, then an OR-of-words query when the strict one finds nothing) over
 * chunk text and document titles / numbers, bounded to 400 candidates under a statement timeout. Semantic: pgvector
 * ANN (top 100) when the vector column exists, else a cosine re-rank of the keyword candidates' stored vectors. The two
 * rankings are fused with reciprocal rank fusion (k = 60). Every hit is a verbatim excerpt of one chunk with a stable
 * `src://<documentId>#p<page>` (or `#c<chunk>`) reference, the publisher and the canonical URL. No match → `empty: true`
 * (never padded with unrelated documents). An explicitly empty filter (e.g. `sources: []`) matches nothing.
 */

export const KEYWORD_CANDIDATES = 400;
export const SEMANTIC_CANDIDATES = 100;
const RERANK_CANDIDATES = 150;
export const SEARCH_TIMEOUT_MS = 8_000;
const MAX_PER_DOCUMENT = 3;
export const EXCERPT_CHARS = 1_800;
const RRF_K = 60;

export const SOURCE_KINDS: readonly SourceKind[] = ["cause_list", "order", "judgment", "defect_list", "calendar", "regulation", "circular", "notification", "gazette", "minutes", "parliament_question", "parliament_debate", "committee_report", "company_record", "dataset"];

export function isSourceKind(v: unknown): v is SourceKind {
  return typeof v === "string" && (SOURCE_KINDS as readonly string[]).includes(v);
}

export class OfficialSearchTimeoutError extends Error {
  readonly code = "official_search_timeout";
  constructor() {
    super("The search was too broad to finish in time. Add words, quote a phrase, or narrow the source, kind or dates.");
    this.name = "OfficialSearchTimeoutError";
  }
}

/** Run statements under a statement timeout (one transaction: set_config(..., true) is local to it). */
export async function boundedQuery(store: RemoteStore, query: string, params: SqlValue[], timeoutMs = SEARCH_TIMEOUT_MS, extra: { query: string; params?: SqlValue[] }[] = []): Promise<Row[]> {
  try {
    const res = await store.transaction([
      { query: `SELECT set_config('statement_timeout', $1, true) AS t`, params: [String(Math.max(500, Math.trunc(timeoutMs)))] },
      ...extra,
      { query, params },
    ]);
    return res[res.length - 1] ?? [];
  } catch (e) {
    if (/statement timeout|canceling statement/i.test((e as Error).message)) throw new OfficialSearchTimeoutError();
    throw e;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FORUM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface NormalizedSearch {
  q: string;
  sources: SourceId[] | null;
  kinds: SourceKind[] | null;
  forum: string | null;
  from: string | null;
  to: string | null;
  limit: number;
  mode: "hybrid" | "keyword" | "semantic";
}

/** Validate and clamp a query; RangeError for input that cannot be trusted. */
export function normalizeSearch(q: SourceSearchQuery): NormalizedSearch {
  const text = String(q?.q ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new RangeError("q is required");
  if (text.length > 500) throw new RangeError("q must be at most 500 characters");
  if (q.sources !== undefined && (!Array.isArray(q.sources) || !q.sources.every(isSourceId))) throw new RangeError("unknown source");
  if (q.kinds !== undefined && (!Array.isArray(q.kinds) || !q.kinds.every(isSourceKind))) throw new RangeError("unknown kind");
  const forum = q.forum == null || q.forum === "" ? null : String(q.forum).toLowerCase();
  if (forum && !FORUM_RE.test(forum)) throw new RangeError("invalid forum");
  for (const d of [q.from, q.to]) if (d != null && d !== "" && !ISO_DATE.test(String(d))) throw new RangeError("dates must be YYYY-MM-DD");
  const limit = Math.max(1, Math.min(Math.floor(Number(q.limit) || 10), 50));
  const mode = q.mode === "keyword" || q.mode === "semantic" ? q.mode : "hybrid";
  return { q: text, sources: q.sources ? [...new Set(q.sources)] : null, kinds: q.kinds ? [...new Set(q.kinds)] : null, forum, from: q.from || null, to: q.to || null, limit, mode };
}

/** SQL conditions on official_documents (alias `d`) for the filters; parameters are appended to `params`. */
export function documentFilters(f: Pick<NormalizedSearch, "sources" | "kinds" | "forum" | "from" | "to">, params: SqlValue[], alias = "d"): string[] {
  const where: string[] = [];
  const p = (v: SqlValue) => { params.push(v); return `$${params.length}`; };
  if (f.sources) where.push(`${alias}.source = ANY(${p(pgArray(f.sources))}::text[])`);
  if (f.kinds) where.push(`${alias}.kind = ANY(${p(pgArray(f.kinds))}::text[])`);
  if (f.forum) { const a = p(f.forum); where.push(`(${alias}.forum = ${a} OR ${alias}.forum LIKE ${a} || '-%')`); }
  if (f.from) where.push(`${alias}.doc_date >= ${p(f.from)}::date`);
  if (f.to) where.push(`${alias}.doc_date <= ${p(f.to)}::date`);
  return where;
}

/** OR-of-words tsquery text for a fallback search (letters/digits only; never raw user syntax). */
export function anyWordsQuery(q: string): string | null {
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2))].slice(0, 16);
  return words.length >= 2 ? words.join(" | ") : null;
}

/** Reciprocal rank fusion of ranked key lists. Ties keep first-list order. */
export function rrfFuse(lists: string[][], k = RRF_K): { key: string; score: number; ranks: (number | null)[] }[] {
  const acc = new Map<string, { score: number; ranks: (number | null)[]; first: number }>();
  let order = 0;
  lists.forEach((list, li) => {
    list.forEach((key, i) => {
      let e = acc.get(key);
      if (!e) { e = { score: 0, ranks: lists.map(() => null), first: order++ }; acc.set(key, e); }
      if (e.ranks[li] != null) return; // duplicates inside one list count once
      e.ranks[li] = i + 1;
      e.score += 1 / (k + i + 1);
    });
  });
  return [...acc.entries()].sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first).map(([key, e]) => ({ key, score: e.score, ranks: e.ranks }));
}

/** A verbatim window of `text` (≤ max chars) around the densest cluster of query words; the start if none match. */
export function focusExcerpt(text: string, q: string, max = EXCERPT_CHARS): string {
  if (text.length <= max) return text;
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))].slice(0, 12);
  const lower = text.toLowerCase();
  const hits: { at: number; w: number }[] = [];
  words.forEach((w, wi) => {
    let from = 0;
    for (let n = 0; n < 60; n++) {
      const i = lower.indexOf(w, from);
      if (i < 0) break;
      hits.push({ at: i, w: wi });
      from = i + w.length;
    }
  });
  let start = 0;
  if (hits.length) {
    hits.sort((a, b) => a.at - b.at);
    let best = -1;
    for (const h of hits) {
      const s = Math.max(0, h.at - Math.floor(max / 5));
      const distinct = new Set(hits.filter((x) => x.at >= s && x.at < s + max).map((x) => x.w)).size;
      if (distinct > best) { best = distinct; start = s; }
    }
  }
  start = Math.min(start, Math.max(0, text.length - max));
  let end = Math.min(text.length, start + max);
  // Snap to whitespace so words are not cut (stays a verbatim substring).
  if (start > 0) { const sp = text.indexOf(" ", start); if (sp > 0 && sp - start < 40 && sp < end) start = sp + 1; }
  if (end < text.length) { const sp = text.lastIndexOf(" ", end); if (sp > start && end - sp < 40) end = sp; }
  return text.slice(start, end);
}

export interface SearchDeps {
  embed?: EmbedFn;
  /** Embedding model id (null: keyword only). Defaults to the configured embedding role. */
  model?: string | null;
  timeoutMs?: number;
}

interface Candidate { key: string; documentId: string; idx: number }

const keyOf = (documentId: string, idx: number) => `${documentId}#${idx}`;

function candidatesSql(tsquery: "websearch" | "words", filters: string[]): string {
  const fn = tsquery === "websearch" ? "websearch_to_tsquery" : "to_tsquery";
  const w = filters.length ? ` AND ${filters.join(" AND ")}` : "";
  return `WITH q AS (SELECT ${fn}('english', $1) AS tq),
    hits AS (
      (SELECT c.document_id, c.idx, ts_rank_cd(c.search, q.tq) AS r
        FROM official_chunks c JOIN official_documents d ON d.id = c.document_id, q
        WHERE c.search @@ q.tq${w}
        ORDER BY r DESC LIMIT ${KEYWORD_CANDIDATES})
      UNION ALL
      (SELECT c.document_id, c.idx, ts_rank_cd(d.search, q.tq) * 2 AS r
        FROM official_documents d JOIN official_chunks c ON c.document_id = d.id AND c.idx = 0, q
        WHERE d.search @@ q.tq${w}
        ORDER BY r DESC LIMIT 50))
    SELECT document_id, idx, max(r)::float8 AS r FROM hits GROUP BY document_id, idx ORDER BY r DESC, document_id, idx LIMIT ${KEYWORD_CANDIDATES}`;
}

async function keywordCandidates(store: RemoteStore, n: NormalizedSearch, timeoutMs: number): Promise<Candidate[]> {
  const toCand = (rows: Row[]) => rows.map((r) => ({ key: keyOf(String(r.document_id), Number(r.idx)), documentId: String(r.document_id), idx: Number(r.idx) }));
  const params: SqlValue[] = [n.q];
  const filters = documentFilters(n, params);
  const strict = toCand(await boundedQuery(store, candidatesSql("websearch", filters), params, timeoutMs));
  if (strict.length) return strict;
  const words = anyWordsQuery(n.q);
  if (!words) return [];
  return toCand(await boundedQuery(store, candidatesSql("words", filters), [words, ...params.slice(1)], timeoutMs));
}

async function semanticAnn(store: RemoteStore, n: NormalizedSearch, vec: Float32Array, model: string, type: "halfvec" | "vector", timeoutMs: number): Promise<Candidate[]> {
  const params: SqlValue[] = [vectorLiteral(vec), model];
  const filters = documentFilters(n, params);
  const rows = await boundedQuery(store,
    `SELECT c.document_id, c.idx FROM official_chunks c JOIN official_documents d ON d.id = c.document_id
      WHERE c.embedding_v IS NOT NULL AND c.embedding_model = $2${filters.length ? ` AND ${filters.join(" AND ")}` : ""}
      ORDER BY c.embedding_v <=> $1::${type} LIMIT ${SEMANTIC_CANDIDATES}`,
    params, timeoutMs, [{ query: `SELECT set_config('hnsw.ef_search', '${SEMANTIC_CANDIDATES}', true) AS e` }]);
  return rows.map((r) => ({ key: keyOf(String(r.document_id), Number(r.idx)), documentId: String(r.document_id), idx: Number(r.idx) }));
}

async function semanticRerank(store: RemoteStore, cands: Candidate[], vec: Float32Array, model: string, timeoutMs: number): Promise<Candidate[]> {
  const top = cands.slice(0, RERANK_CANDIDATES);
  if (!top.length) return [];
  const rows = await boundedQuery(store,
    `SELECT c.document_id, c.idx, c.embedding FROM official_chunks c JOIN jsonb_to_recordset($1::jsonb) AS x(document_id text, idx int) ON c.document_id = x.document_id AND c.idx = x.idx
      WHERE c.embedding IS NOT NULL AND c.embedding_model = $2 AND c.embedding_dims = ${EMBED_DIMS}`,
    [JSON.stringify(top.map((c) => ({ document_id: c.documentId, idx: c.idx }))), model], timeoutMs);
  return rows.map((r) => ({ c: { key: keyOf(String(r.document_id), Number(r.idx)), documentId: String(r.document_id), idx: Number(r.idx) }, v: decodeVector(r.embedding) }))
    .filter((x): x is { c: Candidate; v: Float32Array } => Boolean(x.v))
    .map((x) => ({ ...x, s: cosine(vec, x.v) }))
    .sort((a, b) => b.s - a.s || a.c.key.localeCompare(b.c.key))
    .map((x) => x.c);
}

/** Hybrid search (see module notes). Throws OfficialNotConfiguredError without Postgres, RangeError on bad input. */
export async function searchOfficial(query: SourceSearchQuery, storeArg?: RemoteStore | null, deps: SearchDeps = {}): Promise<OfficialSearchResult> {
  const n = normalizeSearch(query);
  const store = await officialStore(storeArg);
  const none: OfficialSearchResult = { hits: [], mode: n.mode === "semantic" ? "semantic" : "keyword", candidates: 0, empty: true };
  if ((n.sources && !n.sources.length) || (n.kinds && !n.kinds.length)) return none;
  const timeoutMs = deps.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const model = deps.model === undefined ? embeddingModel() : deps.model;

  // The query embedding (a provider call) runs while the keyword stage runs; its failure is handled below.
  const wantVec = Boolean(model) && n.mode !== "keyword";
  const vecPromise: Promise<Float32Array | null> = wantVec
    ? (deps.embed ?? defaultEmbed())([n.q], { query: true }).then((v) => v[0] ?? null, () => null)
    : Promise.resolve(null);
  // Keyword candidates are always computed (bounded): they are the fallback when no vectors exist yet.
  const keyword = await keywordCandidates(store, n, timeoutMs);
  let semantic: Candidate[] = [];
  if (model && wantVec) {
    try {
      const vec = await vecPromise;
      if (vec && vec.length === EMBED_DIMS) {
        const support = await ensureVectorSupport(store);
        if (support.mode === "pgvector" && support.type) semantic = await semanticAnn(store, n, vec, model, support.type, timeoutMs);
        else semantic = await semanticRerank(store, keyword, vec, model, timeoutMs);
      }
    } catch (e) {
      if (e instanceof OfficialSearchTimeoutError) throw e;
      semantic = []; // embeddings unavailable: keyword results stand
    }
  }
  const lists = n.mode === "semantic" && semantic.length ? [semantic] : semantic.length ? [keyword, semantic] : [keyword];
  const mode: OfficialSearchResult["mode"] = semantic.length ? (lists.length === 2 ? "hybrid" : "semantic") : "keyword";
  const fused = rrfFuse(lists.map((l) => l.map((c) => c.key)));
  // Diversify: at most MAX_PER_DOCUMENT chunks per document.
  const perDoc = new Map<string, number>();
  const picked: typeof fused = [];
  for (const f of fused) {
    const doc = f.key.slice(0, f.key.lastIndexOf("#"));
    const k = perDoc.get(doc) ?? 0;
    if (k >= MAX_PER_DOCUMENT) continue;
    perDoc.set(doc, k + 1);
    picked.push(f);
    if (picked.length >= n.limit) break;
  }
  if (!picked.length) return { ...none, mode, candidates: keyword.length };
  const wanted = picked.map((f) => { const i = f.key.lastIndexOf("#"); return { document_id: f.key.slice(0, i), idx: Number(f.key.slice(i + 1)) }; });
  const rows = await boundedQuery(store,
    `SELECT c.document_id, c.idx, c.page_start, c.page_end, c.heading, c.text, d.source, d.kind, d.title, d.url, d.doc_date::text AS doc_date, d.extraction
      FROM official_chunks c JOIN official_documents d ON d.id = c.document_id
      JOIN jsonb_to_recordset($1::jsonb) AS x(document_id text, idx int) ON c.document_id = x.document_id AND c.idx = x.idx`,
    [JSON.stringify(wanted)], timeoutMs);
  const byKey = new Map(rows.map((r) => [keyOf(String(r.document_id), Number(r.idx)), r]));
  const inKeyword = new Set(keyword.map((c) => c.key));
  const inSemantic = new Set(semantic.map((c) => c.key));
  const hits: SourceSearchHit[] = [];
  for (const f of picked) {
    const r = byKey.get(f.key);
    if (!r || !isSourceId(r.source)) continue;
    const pageStart = r.page_start == null ? null : Number(r.page_start);
    const idx = Number(r.idx);
    hits.push({
      ref: pageStart != null ? sourceRef(String(r.document_id), { page: pageStart }) : sourceRef(String(r.document_id), { chunk: idx }),
      documentId: String(r.document_id),
      chunkIndex: idx,
      sourceId: r.source,
      kind: String(r.kind) as SourceKind,
      title: String(r.title ?? ""),
      publisher: sourceDef(r.source)?.publisher ?? r.source,
      url: String(r.url ?? ""),
      docDate: r.doc_date ?? null,
      pageStart,
      pageEnd: r.page_end == null ? pageStart : Number(r.page_end),
      text: focusExcerpt(String(r.text ?? ""), n.q),
      score: Math.round(f.score * 1e6) / 1e6,
      match: inKeyword.has(f.key) && inSemantic.has(f.key) ? "both" : inSemantic.has(f.key) ? "semantic" : "keyword",
      extraction: (r.extraction ?? null) as ExtractionMethod | null,
    });
  }
  return { hits, mode, candidates: keyword.length, empty: hits.length === 0 };
}
