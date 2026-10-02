import "server-only";
import type { RemoteStore, Row } from "@/lib/db/remote";
import { pgTimestampToIso } from "@/modules/official/units";
import { TEXT_STATUSES_SQL } from "../text-status";
import { HC_PDF_PREFIX, PDF_TEXT_VERSION_PREFIX } from "./config";
import { HC_TEXT_SCHEMA, HC_TEXT_SCHEMA_VERSION } from "./schema";
import type { Slice } from "./schedule";

/**
 * Persistence of the PDF text worker behind one interface (the SQL implementation below; tests use an in-memory fake).
 * Every statement is bounded and parameterised; constants are the only interpolated values.
 */

export type UnitStatus = "pending" | "running" | "done" | "skipped" | "failed";
export type PdfTextResult = "full_text" | "ocr" | "partial" | "failed";

export interface HcUnit {
  judgmentId: string;
  courtId: string;
  year: number | null;
  decisionDate: string | null;
  cnr: string | null;
  pdfUrl: string;
  priority: number;
  status: UnitStatus;
  attempts: number;
  payload: UnitPayload | null;
}

/** Resume state kept on a unit between attempts (no raw PDF bytes). */
export interface UnitPayload {
  /** sha256 of the PDF bytes the progress belongs to; progress is discarded when the bytes differ. */
  sha256?: string;
  /** OCR'd page text by page number (scrubbed), so a resumed unit does not pay for those pages again. */
  ocrDone?: Record<string, string>;
  ocrModel?: string;
}

export interface JudgmentRecord {
  id: string;
  courtId: string | null;
  cnr: string | null;
  decisionDate: string | null;
  textStatus: string;
  pdfUrl: string | null;
  title: string | null;
  caseNumber: string | null;
}

export interface TextChunkRow { index: number; pageStart: number | null; pageEnd: number | null; sectionType: string | null; text: string }

export interface StoreTextInput {
  judgmentId: string;
  courtId: string;
  cnr: string;
  decisionDate: string;
  title: string | null;
  caseNumber: string | null;
  status: Exclude<PdfTextResult, "failed">;
  datasetVersion: string;
  chunks: TextChunkRow[];
}

export type StoreTextOutcome =
  | { stored: true; chunks: number }
  /** open_india_law: Open India Law text exists for this CNR + date (never replaced); duplicate: another record with the
   * same CNR + date already has PDF text; record_has_text: the record's text_status is already "full". */
  | { stored: false; reason: "open_india_law" | "duplicate" | "record_has_text" | "record_missing" };

export interface Provenance {
  result: PdfTextResult | "skipped";
  sourceUrl?: string | null;
  sha256?: string | null;
  bytes?: number | null;
  pages?: number | null;
  textPages?: number | null;
  ocrPages?: number[];
  ocrFailedPages?: number[];
  ocrModel?: string | null;
  extractorVersion?: number | null;
  pipelineVersion?: number | null;
  datasetVersion?: string | null;
  chunks?: number | null;
  chars?: number | null;
  oilText?: boolean;
  note?: string | null;
  error?: string | null;
}

export interface CoverageRow {
  courtId: string;
  year: number | null;
  judgments: number;
  withText: number;
  openIndiaLaw: number;
  pdfText: number;
  ocr: number;
  partial: number;
  failed: number;
  metadataOnly: number;
  lastUpdate: string | null;
  /** When these counts were computed (summary table), null for a live count. */
  refreshedAt?: string | null;
}

export interface QueueCounts { pending: number; running: number; done: number; skipped: number; failed: number }

export interface HcTextRepo {
  /** Create / migrate the worker's tables; `judgments` is false when corpus_judgments does not exist (nothing to do). */
  ensureSchema(): Promise<{ judgments: boolean }>;
  /** Queue up to `limit` judgments of one slice that need text (newest first); returns how many were queued. */
  seedSlice(slice: Slice, limit: number): Promise<number>;
  pendingCount(): Promise<number>;
  claim(leaseMinutes: number, maxAttempts: number): Promise<HcUnit | null>;
  judgment(id: string): Promise<JudgmentRecord | null>;
  /** Open India Law text (any corpus_texts row not written by this worker) exists for the CNR + date. */
  openIndiaLawText(cnr: string, decisionDate: string): Promise<boolean>;
  /** Write chunks + text_status in one statement, guarded (never replaces Open India Law text, never a "full" record). */
  storeText(input: StoreTextInput): Promise<StoreTextOutcome>;
  /** text_status = failed for a record without text (never touches a record that has text). */
  markJudgmentFailed(id: string): Promise<void>;
  finish(id: string, status: "done" | "skipped" | "failed", prov: Provenance): Promise<void>;
  /** Back to pending after a transient failure, not before `backoffMinutes`. */
  retry(id: string, error: string, backoffMinutes: number): Promise<void>;
  /** Re-queue partial / failed units whose note or error matches `pattern` (e.g. the OCR provider had no credit). */
  requeueMatching?(pattern: string, limit: number): Promise<number>;
  /** Hand a claimed unit back (deadline): the attempt is given back. */
  release(id: string, note: string, payload?: UnitPayload | null): Promise<void>;
  /** Wait (not a failure): not claimable for `seconds`; the attempt is given back. */
  defer(id: string, seconds: number, note: string, payload?: UnitPayload | null): Promise<void>;
  saveProgress(id: string, payload: UnitPayload): Promise<void>;
  extendLease(id: string, leaseMinutes: number): Promise<void>;
  /** Running units whose lease expired on their last attempt → failed (recorded). */
  sweepExpired(maxAttempts: number): Promise<number>;
  /** Re-queue finished units with these results (operator retry after a fix, e.g. OCR configured). */
  requeue(results: string[], limit: number): Promise<number>;
  queueCounts(): Promise<QueueCounts>;
  dbBytes(): Promise<number>;
  getState<T>(key: string): Promise<T | null>;
  setState(key: string, value: unknown): Promise<void>;
  claimStartSlot(key: string, minIntervalSeconds: number): Promise<boolean>;
  /** Courts whose coverage summary is missing or older than `olderThanMinutes`, oldest first (of `courts`). */
  staleCoverageCourts(courts: string[], olderThanMinutes: number, limit: number): Promise<string[]>;
  /** Recount one court into hc_text_coverage (one transaction; bounded by a statement timeout). */
  refreshCoverage(courtId: string): Promise<void>;
  /** The summary table when it has rows, otherwise a live grouped count (small deployments, before the first refresh). */
  coverage(): Promise<CoverageRow[]>;
}

const num = (v: string | null | undefined) => (v == null || v === "" ? 0 : Number(v));
const t = (v: unknown) => String(v) === "true" || String(v) === "t";

function parsePayload(v: string | null | undefined): UnitPayload | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as UnitPayload) : null;
  } catch { return null; }
}

export function toUnit(r: Row): HcUnit {
  return {
    judgmentId: String(r.judgment_id),
    courtId: String(r.court_id),
    year: r.year == null ? null : Number(r.year),
    decisionDate: r.decision_date ? String(r.decision_date).slice(0, 10) : null,
    cnr: r.cnr ?? null,
    pdfUrl: String(r.pdf_url ?? ""),
    priority: Number(r.priority ?? 0),
    status: String(r.status ?? "pending") as UnitStatus,
    attempts: Number(r.attempts ?? 0),
    payload: parsePayload(r.payload),
  };
}

const intArray = (v: number[] | undefined) => (v && v.length ? `{${v.filter((n) => Number.isInteger(n)).join(",")}}` : null);
const LIKE_PREFIX = `${HC_PDF_PREFIX}%`;
/** Rows this worker wrote. */
const PDF_ROW = `dataset_version LIKE '${PDF_TEXT_VERSION_PREFIX}%'`;

const ready = new WeakSet<RemoteStore>();

/** Count columns shared by the live coverage query and the summary refresh (n, with_text, …, last_update). */
const COUNTS = `count(*)::int AS n,
  count(*) FILTER (WHERE text_status IN (${TEXT_STATUSES_SQL}))::int AS with_text,
  count(*) FILTER (WHERE text_status = 'full')::int AS oil,
  count(*) FILTER (WHERE text_status = 'full_text')::int AS pdf,
  count(*) FILTER (WHERE text_status = 'ocr')::int AS ocr,
  count(*) FILTER (WHERE text_status = 'partial')::int AS partial,
  count(*) FILTER (WHERE text_status = 'failed')::int AS failed,
  count(*) FILTER (WHERE text_status IN ('none', 'metadata'))::int AS meta,
  max(updated_at) FILTER (WHERE text_status <> 'none') AS last_update`;

function rowToCoverage(r: Row): CoverageRow {
  return {
    courtId: String(r.court_id), year: r.year == null ? null : Number(r.year), judgments: num(r.n), withText: num(r.with_text), openIndiaLaw: num(r.oil),
    pdfText: num(r.pdf), ocr: num(r.ocr), partial: num(r.partial), failed: num(r.failed), metadataOnly: num(r.meta), lastUpdate: pgTimestampToIso(r.last_update),
  };
}

export class SqlHcTextRepo implements HcTextRepo {
  constructor(private readonly store: RemoteStore) {}

  async ensureSchema(): Promise<{ judgments: boolean }> {
    const r = await this.store.query({ query: `SELECT to_regclass('public.corpus_judgments') IS NOT NULL AS j` });
    const judgments = t(r[0]?.j);
    if (!ready.has(this.store)) {
      const v = await this.store.query({ query: `SELECT value FROM corpus_state WHERE key = 'hc_text_schema_version'` }).catch(() => [] as Row[]);
      if (!(Number(v[0]?.value ?? 0) >= HC_TEXT_SCHEMA_VERSION)) {
        for (const q of HC_TEXT_SCHEMA) {
          if (/^ALTER TABLE/.test(q.query)) await this.store.transaction([{ query: `SELECT set_config('lock_timeout', '5000', true) AS t` }, q]);
          else await this.store.query(q);
        }
        await this.setState("hc_text_schema_version", HC_TEXT_SCHEMA_VERSION);
      }
      ready.add(this.store);
    }
    return { judgments };
  }

  async seedSlice(slice: Slice, limit: number): Promise<number> {
    const from = `${slice.year}-01-01`;
    const to = `${slice.year + 1}-01-01`;
    const r = await this.store.query({
      query: `WITH ins AS (
        INSERT INTO hc_text_units (judgment_id, court_id, year, decision_date, cnr, pdf_url, priority)
        SELECT j.id, j.court_id, extract(year FROM j.decision_date)::int, j.decision_date, j.cnr, j.pdf_url, $5
        FROM corpus_judgments j
        WHERE j.court_id = $1 AND j.decision_date >= $2::date AND j.decision_date < $3::date
          AND j.text_status IN ('none', 'metadata') AND j.pdf_url LIKE $4 AND j.cnr ~ '^[A-Z]{4}[0-9]{12}$'
          AND NOT EXISTS (SELECT 1 FROM hc_text_units u WHERE u.judgment_id = j.id)
        ORDER BY j.decision_date DESC, j.id LIMIT ${Math.max(1, Math.min(Math.floor(limit), 20_000))}
        ON CONFLICT (judgment_id) DO NOTHING RETURNING 1) SELECT count(*)::int AS n FROM ins`,
      params: [slice.courtId, from, to, LIKE_PREFIX, slice.index],
    });
    return num(r[0]?.n);
  }

  async pendingCount(): Promise<number> {
    const r = await this.store.query({ query: `SELECT count(*)::int AS n FROM hc_text_units WHERE status = 'pending'` });
    return num(r[0]?.n);
  }

  async claim(leaseMinutes: number, maxAttempts: number): Promise<HcUnit | null> {
    const lease = Math.max(1, Math.min(Math.floor(leaseMinutes), 60));
    const r = await this.store.query({
      query: `UPDATE hc_text_units SET status = 'running', lease_until = now() + interval '${lease} minutes', attempts = attempts + 1,
        started_at = coalesce(started_at, now()), updated_at = now()
        WHERE judgment_id = (
          SELECT judgment_id FROM hc_text_units
          WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND attempts < ${Math.max(1, Math.floor(maxAttempts))}
            AND (run_after IS NULL OR run_after <= now())
          ORDER BY priority, decision_date DESC NULLS LAST, judgment_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING judgment_id, court_id, year, decision_date::text AS decision_date, cnr, pdf_url, priority, status, attempts, payload`,
    });
    return r[0] ? toUnit(r[0]) : null;
  }

  async judgment(id: string): Promise<JudgmentRecord | null> {
    const r = await this.store.query({
      query: `SELECT id, court_id, cnr, decision_date::text AS decision_date, text_status, pdf_url, title, case_number FROM corpus_judgments WHERE id = $1`,
      params: [id],
    });
    const x = r[0];
    if (!x) return null;
    return { id: String(x.id), courtId: x.court_id, cnr: x.cnr, decisionDate: x.decision_date ? x.decision_date.slice(0, 10) : null, textStatus: x.text_status ?? "none", pdfUrl: x.pdf_url, title: x.title, caseNumber: x.case_number };
  }

  async openIndiaLawText(cnr: string, decisionDate: string): Promise<boolean> {
    const r = await this.store.query({
      query: `SELECT EXISTS (SELECT 1 FROM corpus_texts WHERE cnr = $1 AND decision_date = $2::date AND NOT (${PDF_ROW})) AS x`,
      params: [cnr, decisionDate],
    });
    return t(r[0]?.x);
  }

  async storeText(x: StoreTextInput): Promise<StoreTextOutcome> {
    const rows = x.chunks.map((c) => ({
      id: `hcpdf:${x.judgmentId}:${c.index}`, chunk_index: c.index, page_start: c.pageStart, page_end: c.pageEnd, section_type: c.sectionType, text: c.text.replace(/\u0000/g, ""),
    }));
    // One statement: the guard decides for the insert, the stale-tail delete and the record update together (data-
    // modifying CTEs share one snapshot). The insert and the delete never touch the same row (the delete takes only
    // indexes at or beyond the new chunk count), so a re-run of the same judgment rewrites its rows in place.
    const r = await this.store.query({
      query: `WITH g AS (
          SELECT
            (SELECT text_status FROM corpus_judgments WHERE id = $1) AS status,
            EXISTS (SELECT 1 FROM corpus_texts WHERE cnr = $2 AND decision_date = $3::date AND NOT (${PDF_ROW})) AS oil,
            EXISTS (SELECT 1 FROM corpus_texts WHERE cnr = $2 AND decision_date = $3::date AND ${PDF_ROW} AND case_key <> $1) AS dup
        ), ok AS (SELECT status IS NOT NULL AND status <> 'full' AND NOT oil AND NOT dup AS ok FROM g),
        ins AS (
          INSERT INTO corpus_texts (id, case_key, neutral_citation, chunk_index, total_chunks, page_start, page_end, section_type, text,
            dataset_version, court_id, cnr, decision_date, title, case_number)
          SELECT c.id, $1, NULL, c.chunk_index, $4::int, c.page_start, c.page_end, c.section_type, c.text, $5, $6, $2, $3::date, $7, $8
          FROM jsonb_to_recordset($9::jsonb) AS c(id text, chunk_index int, page_start int, page_end int, section_type text, text text)
          WHERE (SELECT ok FROM ok)
          ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, total_chunks = EXCLUDED.total_chunks, page_start = EXCLUDED.page_start,
            page_end = EXCLUDED.page_end, section_type = EXCLUDED.section_type, dataset_version = EXCLUDED.dataset_version,
            court_id = EXCLUDED.court_id, cnr = EXCLUDED.cnr, decision_date = EXCLUDED.decision_date, title = EXCLUDED.title,
            case_number = EXCLUDED.case_number
          RETURNING 1
        ), del AS (
          DELETE FROM corpus_texts WHERE cnr = $2 AND decision_date = $3::date AND case_key = $1 AND ${PDF_ROW} AND chunk_index >= $4::int
            AND (SELECT ok FROM ok) RETURNING 1
        ), j AS (
          UPDATE corpus_judgments SET text_status = $10, updated_at = now()
          WHERE id = $1 AND (SELECT ok FROM ok) AND text_status IN ('none', 'metadata', 'failed', 'full_text', 'ocr', 'partial') RETURNING 1
        )
        SELECT (SELECT status FROM g) AS status, (SELECT oil FROM g) AS oil, (SELECT dup FROM g) AS dup, (SELECT ok FROM ok) AS ok,
          (SELECT count(*) FROM ins)::int AS n, (SELECT count(*) FROM del)::int AS d, (SELECT count(*) FROM j)::int AS j`,
      params: [x.judgmentId, x.cnr, x.decisionDate, rows.length, x.datasetVersion, x.courtId, x.title, x.caseNumber, JSON.stringify(rows), x.status],
    });
    const o = r[0] ?? {};
    if (t(o.ok)) return { stored: true, chunks: num(o.n) };
    if (o.status == null) return { stored: false, reason: "record_missing" };
    if (o.status === "full") return { stored: false, reason: "record_has_text" };
    if (t(o.oil)) return { stored: false, reason: "open_india_law" };
    return { stored: false, reason: "duplicate" };
  }

  async markJudgmentFailed(id: string): Promise<void> {
    await this.store.query({ query: `UPDATE corpus_judgments SET text_status = 'failed', updated_at = now() WHERE id = $1 AND text_status IN ('none', 'metadata')`, params: [id] });
  }

  async finish(id: string, status: "done" | "skipped" | "failed", p: Provenance): Promise<void> {
    await this.store.query({
      query: `UPDATE hc_text_units SET status = $2, result = $3, lease_until = NULL, run_after = NULL, finished_at = now(), updated_at = now(), payload = NULL,
        source_url = coalesce($4, source_url), pdf_sha256 = coalesce($5, pdf_sha256), pdf_bytes = coalesce($6::int, pdf_bytes), pages = coalesce($7::int, pages),
        text_pages = coalesce($8::int, text_pages), ocr_pages = coalesce($9::int[], ocr_pages), ocr_failed_pages = coalesce($10::int[], ocr_failed_pages),
        ocr_model = coalesce($11, ocr_model), extractor_version = coalesce($12::int, extractor_version), pipeline_version = coalesce($13::int, pipeline_version),
        dataset_version = coalesce($14, dataset_version), chunks = coalesce($15::int, chunks), chars = coalesce($16::int, chars),
        oil_text = oil_text OR $17, note = $18, error = $19
        WHERE judgment_id = $1`,
      params: [
        id, status, p.result, p.sourceUrl ?? null, p.sha256 ?? null, p.bytes ?? null, p.pages ?? null, p.textPages ?? null, intArray(p.ocrPages), intArray(p.ocrFailedPages),
        p.ocrModel ?? null, p.extractorVersion ?? null, p.pipelineVersion ?? null, p.datasetVersion ?? null, p.chunks ?? null, p.chars ?? null, Boolean(p.oilText),
        p.note?.slice(0, 500) ?? null, p.error?.slice(0, 1000) ?? null,
      ],
    });
  }

  async retry(id: string, error: string, backoffMinutes: number): Promise<void> {
    const m = Math.max(1, Math.min(Math.floor(backoffMinutes), 24 * 60));
    await this.store.query({ query: `UPDATE hc_text_units SET status = 'pending', error = $2, lease_until = NULL, run_after = now() + interval '${m} minutes', updated_at = now() WHERE judgment_id = $1`, params: [id, error.slice(0, 1000)] });
  }

  async release(id: string, note: string, payload?: UnitPayload | null): Promise<void> {
    await this.store.query({
      query: `UPDATE hc_text_units SET status = 'pending', lease_until = NULL, attempts = greatest(attempts - 1, 0), note = $2,
        payload = CASE WHEN $3::boolean THEN $4::jsonb ELSE payload END, updated_at = now() WHERE judgment_id = $1 AND status = 'running'`,
      params: [id, note.slice(0, 500), payload !== undefined, payload == null ? null : JSON.stringify(payload)],
    });
  }

  async defer(id: string, seconds: number, note: string, payload?: UnitPayload | null): Promise<void> {
    const s = Math.max(1, Math.min(Math.floor(seconds), 30 * 86_400));
    await this.store.query({
      query: `UPDATE hc_text_units SET status = 'pending', lease_until = NULL, attempts = greatest(attempts - 1, 0), note = $2, run_after = now() + interval '${s} seconds',
        payload = CASE WHEN $3::boolean THEN $4::jsonb ELSE payload END, updated_at = now() WHERE judgment_id = $1`,
      params: [id, note.slice(0, 500), payload !== undefined, payload == null ? null : JSON.stringify(payload)],
    });
  }

  async saveProgress(id: string, payload: UnitPayload): Promise<void> {
    await this.store.query({ query: `UPDATE hc_text_units SET payload = $2::jsonb, updated_at = now() WHERE judgment_id = $1 AND status = 'running'`, params: [id, JSON.stringify(payload)] });
  }

  async extendLease(id: string, leaseMinutes: number): Promise<void> {
    const lease = Math.max(1, Math.min(Math.floor(leaseMinutes), 60));
    await this.store.query({ query: `UPDATE hc_text_units SET lease_until = now() + interval '${lease} minutes', updated_at = now() WHERE judgment_id = $1 AND status = 'running'`, params: [id] });
  }

  async sweepExpired(maxAttempts: number): Promise<number> {
    const r = await this.store.query({
      query: `WITH s AS (UPDATE hc_text_units SET status = 'failed', result = 'failed', error = coalesce(error, 'lease expired on the last attempt'), lease_until = NULL, finished_at = now(), updated_at = now()
        WHERE status = 'running' AND lease_until < now() AND attempts >= ${Math.max(1, Math.floor(maxAttempts))} RETURNING 1) SELECT count(*)::int AS n FROM s`,
    });
    return num(r[0]?.n);
  }

  async requeueMatching(pattern: string, limit: number): Promise<number> {
    const r = await this.store.query({
      query: `WITH u AS (UPDATE hc_text_units SET status = 'pending', attempts = 0, error = NULL, run_after = NULL, lease_until = NULL, finished_at = NULL, updated_at = now()
        WHERE judgment_id IN (SELECT judgment_id FROM hc_text_units WHERE status IN ('done', 'failed') AND result IN ('partial', 'failed')
          AND (coalesce(note, '') ~* $1 OR coalesce(error, '') ~* $1) ORDER BY priority LIMIT ${Math.max(1, Math.min(Math.floor(limit), 100_000))})
        RETURNING judgment_id),
        j AS (UPDATE corpus_judgments SET text_status = 'none', updated_at = now() WHERE id IN (SELECT judgment_id FROM u) AND text_status = 'failed' RETURNING 1)
        SELECT (SELECT count(*) FROM u)::int AS n`,
      params: [pattern],
    });
    return num(r[0]?.n);
  }

  async requeue(results: string[], limit: number): Promise<number> {
    const allowed = results.filter((x) => ["failed", "partial", "skipped"].includes(x));
    if (!allowed.length) return 0;
    const r = await this.store.query({
      query: `WITH u AS (UPDATE hc_text_units SET status = 'pending', attempts = 0, error = NULL, run_after = NULL, lease_until = NULL, finished_at = NULL, updated_at = now()
        WHERE judgment_id IN (SELECT judgment_id FROM hc_text_units WHERE status IN ('done', 'failed', 'skipped') AND result = ANY($1::text[]) ORDER BY priority LIMIT ${Math.max(1, Math.min(Math.floor(limit), 100_000))})
        RETURNING judgment_id),
        j AS (UPDATE corpus_judgments SET text_status = 'none', updated_at = now() WHERE id IN (SELECT judgment_id FROM u) AND text_status = 'failed' RETURNING 1)
        SELECT (SELECT count(*) FROM u)::int AS n`,
      params: [`{${allowed.join(",")}}`],
    });
    return num(r[0]?.n);
  }

  async queueCounts(): Promise<QueueCounts> {
    const rows = await this.store.query({ query: `SELECT status, count(*)::int AS n FROM hc_text_units GROUP BY status` });
    const out: QueueCounts = { pending: 0, running: 0, done: 0, skipped: 0, failed: 0 };
    for (const r of rows) if (r.status && r.status in out) out[r.status as keyof QueueCounts] = num(r.n);
    return out;
  }

  async dbBytes(): Promise<number> {
    const r = await this.store.query({ query: `SELECT pg_database_size(current_database())::bigint AS b` });
    return num(r[0]?.b);
  }

  async getState<T>(key: string): Promise<T | null> {
    const r = await this.store.query({ query: `SELECT value FROM corpus_state WHERE key = $1`, params: [key] });
    if (!r[0]?.value) return null;
    try { return JSON.parse(r[0].value) as T; } catch { return null; }
  }

  async setState(key: string, value: unknown): Promise<void> {
    await this.store.query({ query: `INSERT INTO corpus_state (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, params: [key, JSON.stringify(value)] });
  }

  async claimStartSlot(key: string, minIntervalSeconds: number): Promise<boolean> {
    const seconds = Math.max(1, Math.min(Math.floor(minIntervalSeconds), 86_400));
    const r = await this.store.query({
      query: `INSERT INTO corpus_state (key, value, updated_at) VALUES ($1, '{}'::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET updated_at = now() WHERE corpus_state.updated_at < now() - interval '${seconds} seconds' RETURNING 1 AS ok`,
      params: [key],
    });
    return r.length > 0;
  }

  async staleCoverageCourts(courts: string[], olderThanMinutes: number, limit: number): Promise<string[]> {
    const rows = await this.store.query({ query: `SELECT court_id, min(refreshed_at)::text AS at FROM hc_text_coverage GROUP BY court_id` });
    const at = new Map(rows.map((x) => [String(x.court_id), Date.parse(pgTimestampToIso(x.at) ?? "") || 0]));
    const cutoff = Date.now() - olderThanMinutes * 60_000;
    return courts.filter((c) => (at.get(c) ?? 0) < cutoff).sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0)).slice(0, Math.max(0, limit));
  }

  async refreshCoverage(courtId: string): Promise<void> {
    await this.store.transaction([
      { query: `SELECT set_config('statement_timeout', '60000', true) AS t` },
      { query: `DELETE FROM hc_text_coverage WHERE court_id = $1`, params: [courtId] },
      {
        query: `INSERT INTO hc_text_coverage (court_id, year, judgments, with_text, oil, pdf, ocr, partial, failed, meta, last_update, refreshed_at)
          SELECT $1, coalesce(extract(year FROM decision_date)::int, 0), ${COUNTS}, now()
          FROM corpus_judgments WHERE court_id = $1 GROUP BY 2`,
        params: [courtId],
      },
    ]);
  }

  async coverage(): Promise<CoverageRow[]> {
    const summary = await this.store.query({
      query: `SELECT court_id, nullif(year, 0) AS year, judgments AS n, with_text, oil, pdf, ocr, partial, failed, meta, last_update::text AS last_update, refreshed_at::text AS refreshed_at
        FROM hc_text_coverage`,
    });
    if (summary.length) return summary.map((r) => ({ ...rowToCoverage(r), refreshedAt: pgTimestampToIso(r.refreshed_at) }));
    // No summary yet: one live grouped scan of the High Court records (bounded by a statement timeout; callers cache).
    const [, rows] = await this.store.transaction([
      { query: `SELECT set_config('statement_timeout', '20000', true) AS t` },
      {
        query: `SELECT court_id, extract(year FROM decision_date)::int AS year, ${COUNTS}

          FROM corpus_judgments WHERE court_id LIKE 'hc-%' GROUP BY 1, 2`,
      },
    ]);
    return rows.map((r) => ({ ...rowToCoverage(r), refreshedAt: null }));
  }
}
