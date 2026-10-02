import "server-only";
import { remoteStore, type RemoteStore, type Row, type SqlQuery, type SqlValue } from "@/lib/db/remote";
import { canonicalNeutral } from "../corpus/text";
import { getState, setState } from "../corpus/backfill";
import { CorpusNotConfiguredError } from "../corpus/directory";
import { canonicalCitation, compactKey, EXTRACTOR_VERSION, extractCitationDrafts, type CitationDraft, type TextChunkIn } from "./extract";
import { compactSql, ensureCitatorSchema } from "./schema";

/**
 * Citator builder: scans judgments that have full text (corpus_judgments.text_status = 'full') in id order after a
 * cursor, extracts their citations and resolves case citations to corpus judgments by EXACT normalised match on
 * neutral_citation or reporter_citation only (one match: resolved; several: ambiguous, none chosen; none: unresolved).
 * Never a fuzzy, nearest-title or name match. A judgment never resolves to itself (its own citations are skipped).
 * Idempotent: a judgment's rows are replaced (delete + insert in one transaction).
 */

export const DEFAULT_BATCH = 25;
export const MAX_BATCH = 200;
/** Text read per judgment (chunks), and parallel text reads. */
const MAX_CHUNKS = 400;
const MAX_TEXT_CHARS = 1_500_000;
const TEXT_CONCURRENCY = 4;
/** Rows per INSERT statement (17 parameters each). */
const INSERT_ROWS = 500;

export interface CitatorBatchResult {
  processed: number;
  citations: number;
  resolved: number;
  unresolved: number;
  ambiguous: number;
  statutes: number;
  /** Judgments marked as having text but none found in corpus_texts (recorded as scanned with 0 characters). */
  noText: number;
  nextCursor: string | null;
  done: boolean;
  stop: "batch_complete" | "deadline" | "pass_complete" | "text_not_loaded" | "storage_budget";
}

interface JudgmentRow { id: string; courtId: string | null; year: number | null; neutral: string | null; reporter: string | null; cnr: string | null; date: string | null }

const t = (v: unknown) => String(v) === "true" || String(v) === "t";

async function textColumns(store: RemoteStore): Promise<{ ok: boolean; hc: boolean }> {
  const r = await store.query({
    query: `SELECT to_regclass('public.corpus_texts') IS NOT NULL AS ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'corpus_texts' AND column_name = 'cnr') AS hc`,
  });
  return { ok: t(r[0]?.ok), hc: t(r[0]?.hc) };
}

async function readChunks(store: RemoteStore, j: JudgmentRow, hc: boolean): Promise<TextChunkIn[]> {
  const neutral = j.courtId === "sci" ? canonicalNeutral(j.neutral) : null;
  let rows: Row[] = [];
  if (neutral) {
    rows = await store.query({ query: `SELECT chunk_index, page_start, text FROM corpus_texts WHERE neutral_citation = $1 ORDER BY chunk_index LIMIT ${MAX_CHUNKS}`, params: [neutral.toUpperCase()] });
  } else if (hc && j.cnr && j.date) {
    rows = await store.query({ query: `SELECT chunk_index, page_start, text FROM corpus_texts WHERE cnr = $1 AND decision_date = $2::date ORDER BY chunk_index LIMIT ${MAX_CHUNKS}`, params: [j.cnr, j.date] });
  }
  const out: TextChunkIn[] = [];
  let used = 0;
  for (const r of rows) {
    const text = r.text ?? "";
    if (used + text.length > MAX_TEXT_CHARS && out.length) break;
    used += text.length;
    out.push({ index: Number(r.chunk_index), pageStart: r.page_start == null ? null : Number(r.page_start), text });
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Candidate ids per canonical citation, from one bounded query over the compact-key indexes. */
async function resolveKeys(store: RemoteStore, canon: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!canon.length) return out;
  const compact = Array.from(new Set(canon.map(compactKey))).filter((k) => /^[A-Z0-9]{4,80}$/.test(k));
  if (!compact.length) return out;
  const arr = `{${compact.map((k) => `"${k}"`).join(",")}}`;
  const rows = await store.query({
    query: `SELECT id, neutral_citation, reporter_citation FROM corpus_judgments
      WHERE (neutral_citation IS NOT NULL AND ${compactSql("neutral_citation")} = ANY($1::text[]))
         OR (reporter_citation IS NOT NULL AND ${compactSql("reporter_citation")} = ANY($1::text[]))
      LIMIT 20000`,
    params: [arr],
  });
  const want = new Set(canon);
  for (const r of rows) {
    for (const v of [r.neutral_citation, r.reporter_citation]) {
      const c = canonicalCitation(v);
      // Confirmed by the parser: the stored value must normalise to exactly the cited form.
      if (c && want.has(c) && r.id) { if (!out.has(c)) out.set(c, new Set()); out.get(c)!.add(r.id); }
    }
  }
  return out;
}

const COLS = ["citing_id", "seq", "kind", "raw", "key", "cited_id", "resolution", "candidates", "act_id", "section", "chunk_index", "page", "context", "signal", "cue", "occurrences", "citing_court", "citing_year", "extractor_version"];

interface Resolved extends CitationDraft { citedId: string | null; resolution: "resolved" | "unresolved" | "ambiguous"; candidates: number }

function writeStatements(j: JudgmentRow, rows: Resolved[], textChars: number, truncated: boolean): SqlQuery[] {
  const qs: SqlQuery[] = [{ query: `DELETE FROM corpus_citations WHERE citing_id = $1`, params: [j.id] }];
  for (let i = 0; i < rows.length; i += INSERT_ROWS) {
    const part = rows.slice(i, i + INSERT_ROWS);
    const params: SqlValue[] = [];
    const values = part.map((d, k) => {
      const vals: SqlValue[] = [j.id, i + k + 1, d.kind, d.raw.slice(0, 300), d.key.slice(0, 300), d.citedId, d.resolution, d.candidates, d.actId, d.section, d.chunkIndex, d.page, d.context, d.signal, d.cue, d.occurrences, j.courtId, j.year, EXTRACTOR_VERSION];
      const ph = vals.map((v) => { params.push(v); return `$${params.length}`; });
      return `(${ph.join(", ")})`;
    });
    qs.push({ query: `INSERT INTO corpus_citations (${COLS.join(", ")}) VALUES ${values.join(", ")}`, params });
  }
  qs.push({
    query: `INSERT INTO corpus_citator_scans (citing_id, extractor_version, citations, text_chars, truncated, scanned_at) VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (citing_id) DO UPDATE SET extractor_version = EXCLUDED.extractor_version, citations = EXCLUDED.citations, text_chars = EXCLUDED.text_chars, truncated = EXCLUDED.truncated, scanned_at = now()`,
    params: [j.id, EXTRACTOR_VERSION, rows.length, textChars, truncated],
  });
  return qs;
}

/**
 * One bounded batch: up to `limit` judgments with text after `afterId` (id order). Stops early (between judgments)
 * when `deadlineMs` (a duration from the call) has passed; `nextCursor` is the last judgment fully written.
 */
export async function buildCitationsBatch(o: { store: RemoteStore; limit?: number; afterId?: string | null; deadlineMs?: number; now?: () => number }): Promise<CitatorBatchResult> {
  const { store } = o;
  const now = o.now ?? Date.now;
  const t0 = now();
  const deadline = t0 + Math.max(1_000, o.deadlineMs ?? 60_000);
  const limit = Math.max(1, Math.min(Math.floor(o.limit ?? DEFAULT_BATCH), MAX_BATCH));
  const res: CitatorBatchResult = { processed: 0, citations: 0, resolved: 0, unresolved: 0, ambiguous: 0, statutes: 0, noText: 0, nextCursor: o.afterId ?? null, done: false, stop: "batch_complete" };
  await ensureCitatorSchema(store);
  const cols = await textColumns(store);
  if (!cols.ok) return { ...res, stop: "text_not_loaded" };

  const rows = await store.query({
    query: `SELECT id, court_id, year, neutral_citation, reporter_citation, cnr, decision_date::text AS decision_date FROM corpus_judgments
      WHERE text_status = 'full'${o.afterId ? " AND id > $1" : ""} ORDER BY id LIMIT ${limit}`,
    params: o.afterId ? [o.afterId] : [],
  });
  const judgments: JudgmentRow[] = rows.filter((r) => r.id).map((r) => ({
    id: r.id!, courtId: r.court_id, year: r.year == null ? null : Number(r.year), neutral: r.neutral_citation, reporter: r.reporter_citation, cnr: r.cnr, date: r.decision_date,
  }));
  if (!judgments.length) return { ...res, done: true, stop: "pass_complete" };

  // Read text in parallel (bounded), extract, then resolve every case citation of the batch in one query.
  const texts = await pool(judgments, TEXT_CONCURRENCY, (j) => (now() > deadline ? Promise.resolve(null) : readChunks(store, j, cols.hc)));
  const extracted = judgments.map((j, i) => {
    const chunks = texts[i];
    if (!chunks) return null;
    const ownKeys = [canonicalCitation(j.neutral), canonicalCitation(j.reporter), j.neutral, j.reporter].filter((x): x is string => Boolean(x));
    const { drafts, truncated } = extractCitationDrafts(chunks, { ownKeys });
    return { drafts, truncated, chars: chunks.reduce((n, c) => n + c.text.length, 0) };
  });
  const canon = extracted.flatMap((e) => (e ? e.drafts.filter((d) => d.kind === "case" && d.valid).map((d) => d.key) : []));
  const candidates = await resolveKeys(store, canon);

  for (let i = 0; i < judgments.length; i++) {
    const j = judgments[i], e = extracted[i];
    if (!e || now() > deadline) { res.stop = "deadline"; break; }
    const resolved: Resolved[] = e.drafts.map((d) => {
      if (d.kind === "statute") return { ...d, citedId: null, resolution: d.actId ? "resolved" : "unresolved", candidates: d.actId ? 1 : 0 };
      const ids = [...(candidates.get(d.key) ?? [])].filter((id) => id !== j.id);
      if (!d.valid || !ids.length) return { ...d, citedId: null, resolution: "unresolved", candidates: 0 };
      if (ids.length > 1) return { ...d, citedId: null, resolution: "ambiguous", candidates: ids.length };
      return { ...d, citedId: ids[0], resolution: "resolved", candidates: 1 };
    });
    await store.transaction(writeStatements(j, resolved, e.chars, e.truncated));
    res.processed++;
    if (!e.chars) res.noText++;
    for (const r of resolved) {
      if (r.kind === "statute") { res.statutes++; continue; }
      res.citations++;
      res[r.resolution]++;
    }
    res.nextCursor = j.id;
  }
  if (res.stop === "batch_complete" && judgments.length < limit) { res.done = true; res.stop = "pass_complete"; }
  return res;
}

// ---------------------------------------------------------------------------
// Resumable runs (cursor in corpus_state)
// ---------------------------------------------------------------------------

/** Storage budget for citator writes: CITATOR_MAX_DB_MB (default 60,000 MB), checked before every batch. */
export const DEFAULT_CITATOR_MAX_DB_MB = 60_000;

export function citatorLimitBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const mb = Number(env.CITATOR_MAX_DB_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_CITATOR_MAX_DB_MB) * 1024 * 1024;
}

async function databaseBytes(store: RemoteStore): Promise<number> {
  const r = await store.query({ query: `SELECT pg_database_size(current_database())::bigint AS b` });
  return Number(r[0]?.b ?? 0);
}

export interface CitatorCursor { afterId: string | null; done: boolean; version: number; passStartedAt: string; updatedAt: string; scannedThisPass: number }

export interface CitatorRunResult extends CitatorBatchResult { batches: number; cursor: CitatorCursor; dbBytes?: number; limitBytes?: number }

const CURSOR_KEY = "citator_cursor";

export async function citatorCursor(store: RemoteStore): Promise<CitatorCursor | null> {
  return getState<CitatorCursor>(store, CURSOR_KEY);
}

/**
 * Run batches until the deadline or the end of the pass, resuming from the stored cursor. `restart` starts a new
 * pass from the beginning (to pick up judgments whose text was loaded after the cursor passed them, or a new
 * extractor version, which also restarts automatically).
 */
export async function runCitatorBuild(o: { store?: RemoteStore | null; limit?: number; deadlineMs?: number; restart?: boolean; now?: () => number } = {}): Promise<CitatorRunResult> {
  const store = o.store === undefined ? remoteStore() : o.store;
  if (!store) throw new CorpusNotConfiguredError();
  const now = o.now ?? Date.now;
  const t0 = now();
  const budget = Math.max(5_000, o.deadlineMs ?? 240_000);
  await ensureCitatorSchema(store);
  const iso = () => new Date(now()).toISOString();
  let cursor = await citatorCursor(store);
  if (!cursor || o.restart || cursor.version !== EXTRACTOR_VERSION) {
    cursor = { afterId: null, done: false, version: EXTRACTOR_VERSION, passStartedAt: iso(), updatedAt: iso(), scannedThisPass: 0 };
  }
  const total: CitatorRunResult = { processed: 0, citations: 0, resolved: 0, unresolved: 0, ambiguous: 0, statutes: 0, noText: 0, nextCursor: cursor.afterId, done: cursor.done, stop: cursor.done ? "pass_complete" : "batch_complete", batches: 0, cursor };
  if (cursor.done) return total;
  const limitBytes = citatorLimitBytes();
  total.limitBytes = limitBytes;
  while (now() - t0 < budget) {
    // Storage budget: stop before writing when the database has reached CITATOR_MAX_DB_MB.
    const dbBytes = await databaseBytes(store);
    total.dbBytes = dbBytes;
    if (dbBytes >= limitBytes) { total.stop = "storage_budget"; break; }
    const remaining = budget - (now() - t0);
    const r = await buildCitationsBatch({ store, limit: o.limit, afterId: cursor.afterId, deadlineMs: remaining, now });
    total.batches++;
    for (const k of ["processed", "citations", "resolved", "unresolved", "ambiguous", "statutes", "noText"] as const) total[k] += r[k];
    total.stop = r.stop;
    if (r.stop === "text_not_loaded") break;
    cursor = { ...cursor, afterId: r.nextCursor, done: r.done, updatedAt: iso(), scannedThisPass: cursor.scannedThisPass + r.processed };
    await setState(store, CURSOR_KEY, cursor);
    if (r.done || r.stop === "deadline" || r.processed === 0) break;
  }
  if (total.stop === "batch_complete" && !cursor.done) total.stop = "deadline";
  return { ...total, nextCursor: cursor.afterId, done: cursor.done, cursor };
}
