import "server-only";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { isProviderError } from "@/modules/intel/providers/base";
import type { ParseInput, SourceAdapter } from "./adapter";
import { addCounts, chunkMarkdown, scrubPersonalData, sha256Hex, SCRUB_VERSION, type ChunkDraft, type ScrubCounts } from "./chunk";
import { embedPendingChunks, type EmbedFn } from "./embed";
import { EXTRACTOR_VERSION, extractDocument, extractFirecrawlMarkdown, extractHtml, extractPdf, extractProvidedText, pageMarkdown, sniffBytes, type ExtractedDocument, type PageText } from "./extract";
import { fallbackWorthy, isDeadlineError, isLocalRateLimit, isNotPublished, isTooLarge, makeAdapterContext, maxFileBytes, type OfficialHttp } from "./http";
import { ocrDocument, ocrMaxPages, type OcrModel } from "./ocr";
import { allowHostsFor, officialAdapter, sourceDef } from "./registry";
import type { DiscoveredDoc, FetchProvenance, SourceDef, SourceId } from "./types";
import { isSourceId } from "./types";
import { completeUnit, deferUnit, enqueueUnits, failUnit, getOfficialState, pgArray, releaseUnit, setOfficialState, skipUnit, unitId, MAX_ATTEMPTS, type OfficialUnit, type UnitInput } from "./units";
import { hostMatches } from "@/lib/net/safe-fetch";

/**
 * Stage processors of the official-sources pipeline. Each takes one claimed unit and finishes it (done / retry /
 * failed / skipped / released at the deadline); none throws for a document-level problem.
 *
 *   discover  adapter.discover(ctx) with the stored cursor → upsert official_documents (id = od_ + sha256(source|url))
 *             → enqueue fetch units (or extract units when the listing supplied the text)
 *   fetch     download (direct, legacy TLS; Firecrawl PDF parse for firecrawl_in sources when the direct fetch fails)
 *             → refuse content that is not the document (an HTML error / WAF / soft-404 page where a PDF is expected,
 *             or an HTML page after a redirect elsewhere): a retryable fetch failure, the indexed version untouched
 *             → sha256 (unchanged bytes and extractor → nothing to do; changed → version + 1, previous hash in history;
 *             a switch between direct bytes and a Firecrawl parse is not a new version)
 *             → extract (text layer / HTML / dataset) → pages needing OCR → `ocr` unit; otherwise scrub contact data,
 *             chunk + store (status indexed, keyword-searchable) → `index` unit (embeddings) → adapter.parse + persist
 *   extract   text supplied by the listing (dataset) → scrub → chunk + store
 *   ocr       re-read the bytes (same sha256; a unit queued for an older version re-targets the current one) → OCR the
 *             unreadable pages (progress saved after every range) → scrub → chunk + store
 *   index     embed the document's chunks (bounded per run); failures leave the keyword index intact
 *   parse     re-run adapter.parse + persist for a document (after a parse failure)
 *
 * Raw bytes are not stored: the official URL, SHA-256 and fetch provenance are; the text of record is the chunks, with
 * contact data (phone numbers, e-mail addresses, meeting links) replaced by visible markers before anything is
 * chunked, indexed or embedded (`meta.redacted`, `meta.scrubVersion`; text_sha256 is over the scrubbed text, sha256
 * stays the hash of the publisher's bytes). Chunks are written only for the document version they were made from.
 * When the run's deadline (or its abort signal) interrupts a unit, the unit is released — the attempt is not consumed.
 */

export type StageCounts = { discovered: number; fetched: number; extracted: number; ocr: number; indexed: number; failed: number; skipped: number };

export interface UnitOutcome {
  status: "done" | "retry" | "failed" | "skipped" | "released";
  counts: Partial<StageCounts>;
  error?: { url: string; error: string };
  note?: string;
  /** The document changed while this unit worked on it: nothing was written for the old version. */
  stale?: boolean;
}

export interface PipelineDeps {
  store: RemoteStore;
  now: () => number;
  /** Epoch ms by which the unit must be finished or released. */
  deadline: number;
  /** One http client per source for the whole run (shared token buckets). */
  http: (def: SourceDef) => OfficialHttp;
  ocrModel: () => OcrModel;
  embed?: EmbedFn;
  embedModel?: string | null;
  /** Chunks this run may still embed (OFFICIAL_EMBED_MAX_CHUNKS_PER_RUN). */
  embedBudget: { left: number };
  discoverLimit: number;
  maxOcrPages?: number;
  ocrConcurrency?: number;
  bytes: BytesCache;
  /** Aborted at the run's deadline (and when the caller aborts): in-flight requests stop, the unit is released. */
  signal?: AbortSignal;
  log: (event: string, data: Record<string, unknown>) => void;
}

export const PRIORITY = { discover: 0, fetchUrgent: 10, fetch: 20, extract: 20, parse: 25, ocr: 30, index: 40 } as const;
const URGENT_KINDS = new Set(["cause_list", "defect_list"]);
const INSERT_MAX_CHARS = 1_500_000;
const INSERT_MAX_ROWS = 1_000;
/** "Not yet published" (404 for a dated / pattern URL): re-checked this often until the day after its date. */
export const NOT_YET_RECHECK_SECONDS = 30 * 60;
/** Re-checks of a dateless pattern URL before its 404 is final. */
export const NOT_YET_MAX_CHECKS = 12;
/** A document a listing shows again is re-fetched after a "not published" 404 at most this often. */
const NOT_PUBLISHED_REQUEUE_MINUTES = 6 * 60;
/** Pattern URLs (no listing behind them) are re-checked until this many days after their date. */
export const NOT_YET_PATTERN_DAYS = 3;
export const DEFAULT_REFETCH_MIN_MINUTES = 120;

/**
 * OFFICIAL_REFETCH_MIN_MINUTES (default 120): an adapter's `meta.refetch` re-queues a document's fetch only when its
 * last fetch finished at least this long ago (lists re-announced on every discovery pass are not re-downloaded — or
 * sent to the paid Firecrawl fallback — each time).
 */
export function refetchMinMinutes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number(env.OFFICIAL_REFETCH_MIN_MINUTES);
  return env.OFFICIAL_REFETCH_MIN_MINUTES != null && env.OFFICIAL_REFETCH_MIN_MINUTES.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 7 * 24 * 60) : DEFAULT_REFETCH_MIN_MINUTES;
}
/** OCR progress is saved on the unit at most this often while a document is transcribed. */
const OCR_PROGRESS_SAVE_MS = 30_000;

/** Stable document id: "od_" + the first 24 hex chars of sha256("<source>|<canonical url>"). */
export function documentIdFor(source: SourceId, url: string): string {
  return `od_${sha256Hex(`${source}|${url}`).slice(0, 24)}`;
}

/** Recently fetched bytes (so an OCR or parse unit in the same run does not download again). */
export class BytesCache {
  private map = new Map<string, { sha: string; bytes: Uint8Array }>();
  private size = 0;
  constructor(private readonly maxBytes = 120 * 1024 * 1024) {}
  get(id: string, sha: string): Uint8Array | null {
    const e = this.map.get(id);
    return e && e.sha === sha ? e.bytes : null;
  }
  set(id: string, sha: string, bytes: Uint8Array): void {
    if (bytes.byteLength > this.maxBytes) return;
    const old = this.map.get(id);
    if (old) { this.size -= old.bytes.byteLength; this.map.delete(id); }
    this.map.set(id, { sha, bytes });
    this.size += bytes.byteLength;
    for (const [k, v] of this.map) {
      if (this.size <= this.maxBytes) break;
      this.map.delete(k);
      this.size -= v.bytes.byteLength;
    }
  }
}

// ---------------------------------------------------------------------------
// Small store helpers
// ---------------------------------------------------------------------------

const DOC_ROW = `id, source, kind, url, file_url, title, doc_date::text AS doc_date, forum, status, mime, sha256, version, extractor_version, text_sha256, meta, fetched_at, attempts, extraction, pages, fetch_provenance`;

interface DocRow {
  id: string; source: SourceId; kind: string; url: string; fileUrl: string | null; title: string; docDate: string | null; status: string;
  mime: string | null; sha256: string | null; version: number; extractorVersion: number | null; meta: Record<string, unknown>; fetchedAt: string | null; extraction: string | null;
  pages: number | null;
  /** What the stored sha256 is the hash of: "bytes" (direct fetch), "firecrawl_markdown", "firecrawl_raw_html", "listing_text"; null before any fetch. */
  hashOf: string | null;
}

function toDocRow(r: Row): DocRow {
  let meta: Record<string, unknown> = {};
  try { meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
  let hashOf: string | null = null;
  if (r.fetch_provenance) {
    try { const p = JSON.parse(r.fetch_provenance) as { hashOf?: unknown }; hashOf = typeof p?.hashOf === "string" ? p.hashOf : "bytes"; } catch { hashOf = "bytes"; }
  }
  return {
    id: String(r.id), source: String(r.source) as SourceId, kind: String(r.kind), url: String(r.url), fileUrl: r.file_url ?? null, title: String(r.title ?? ""),
    docDate: r.doc_date ? String(r.doc_date).slice(0, 10) : null, status: String(r.status), mime: r.mime ?? null, sha256: r.sha256 ?? null,
    version: Number(r.version ?? 1), extractorVersion: r.extractor_version == null ? null : Number(r.extractor_version), meta, fetchedAt: r.fetched_at ?? null, extraction: r.extraction ?? null,
    pages: r.pages == null ? null : Number(r.pages), hashOf,
  };
}

async function loadDoc(store: RemoteStore, id: string | null): Promise<DocRow | null> {
  if (!id) return null;
  const rows = await store.query({ query: `SELECT ${DOC_ROW} FROM official_documents WHERE id = $1`, params: [id] });
  return rows[0] ? toDocRow(rows[0]) : null;
}

export async function insertReject(store: RemoteStore, source: string, url: string, stage: string, reason: string): Promise<void> {
  await store.query({ query: `INSERT INTO official_rejects (source, url, stage, reason) VALUES ($1, $2, $3, $4)`, params: [source, url.slice(0, 2000), stage, reason.slice(0, 1000)] });
}

async function setDocStatus(store: RemoteStore, id: string, status: "failed" | "excluded" | "ocr_needed", error: string | null, extra: { pages?: number | null } = {}): Promise<void> {
  await store.query({
    query: `UPDATE official_documents SET status = $2, error = $3, pages = coalesce($4, pages), updated_at = now() WHERE id = $1`,
    params: [id, status, error ? error.slice(0, 1000) : null, extra.pages ?? null],
  });
}

/** Record an error on a document without changing its status (an indexed version stays the current text). */
async function setDocError(store: RemoteStore, id: string, error: string): Promise<void> {
  await store.query({ query: `UPDATE official_documents SET error = $2, updated_at = now() WHERE id = $1`, params: [id, error.slice(0, 1000)] });
}

/**
 * The text of an earlier version is not the current official copy: when the new bytes cannot be indexed (OCR pending,
 * unreadable, no longer published), the old chunks are removed rather than left searchable as if current.
 */
async function dropChunks(store: RemoteStore, id: string): Promise<void> {
  await store.transaction([
    { query: `DELETE FROM official_chunks WHERE document_id = $1`, params: [id] },
    { query: `UPDATE official_documents SET chunks = 0, embedded = 0, text_sha256 = NULL, updated_at = now() WHERE id = $1`, params: [id] },
  ]);
}

const clean = (s: string) => s.replace(/\u0000/g, "");

/** True when the run's deadline (or the caller) interrupted the work: the unit is released, not failed. */
function interrupted(deps: PipelineDeps, e?: unknown): boolean {
  return deps.signal?.aborted === true || (e !== undefined && isDeadlineError(e));
}

async function releaseInterrupted(store: RemoteStore, unit: OfficialUnit, payload?: Record<string, unknown> | null): Promise<UnitOutcome> {
  await releaseUnit(store, unit.id, payload, "run deadline reached; resumes in a later run");
  return { status: "released", counts: {}, note: "deadline" };
}

/** Seconds a unit waits after our own host rate limit refused its request (spread so waiting units do not return together). */
export const LOCAL_LIMIT_DEFER_SECONDS = 20;

/**
 * Our own host rate limit refused a request (the publisher was not asked): the unit waits a short, spread interval and
 * keeps its attempt, so a busy host never fails documents or pushes them into exponential backoff.
 */
async function deferThrottled(store: RemoteStore, unit: OfficialUnit): Promise<UnitOutcome> {
  const spread = Number.parseInt(unit.id.replace(/[^0-9a-f]/gi, "").slice(-2) || "0", 16) % LOCAL_LIMIT_DEFER_SECONDS;
  await deferUnit(store, unit.id, LOCAL_LIMIT_DEFER_SECONDS + spread, "host request rate (local limit) reached; resumes shortly");
  return { status: "released", counts: {}, note: "throttled" };
}

/**
 * Replace a document's chunks and mark it indexed — only while the document still has the hash the text was made
 * from (`expectSha`): the row is locked, every statement is guarded, and false is returned when a newer fetch changed
 * the document meanwhile (nothing is written for the old version). Atomic when the text fits one request.
 */
async function storeChunks(store: RemoteStore, docId: string, expectSha: string, chunks: ChunkDraft[], ocrPages: Set<number>, textSha: string, final: SqlQuery): Promise<boolean> {
  const rows = chunks.map((c) => {
    let ocr = false;
    if (c.pageStart != null) for (let p = c.pageStart; p <= (c.pageEnd ?? c.pageStart); p++) if (ocrPages.has(p)) { ocr = true; break; }
    const text = clean(c.text);
    return { document_id: docId, idx: c.index, text_sha256: textSha, page_start: c.pageStart, page_end: c.pageEnd, heading: c.heading ? clean(c.heading) : null, text, ocr, chars: text.length, page_marks: c.pageMarks };
  });
  const current = `EXISTS (SELECT 1 FROM official_documents WHERE id = $2 AND sha256 = $3)`;
  const inserts: SqlQuery[] = [];
  let batch: typeof rows = [];
  let chars = 0;
  const push = () => {
    if (!batch.length) return;
    inserts.push({
      query: `INSERT INTO official_chunks (document_id, idx, text_sha256, page_start, page_end, heading, text, ocr, chars, page_marks)
        SELECT document_id, idx, text_sha256, page_start, page_end, heading, text, ocr, chars, page_marks
        FROM jsonb_to_recordset($1::jsonb) AS x(document_id text, idx int, text_sha256 text, page_start int, page_end int, heading text, text text, ocr boolean, chars int, page_marks jsonb)
        WHERE ${current}`,
      params: [JSON.stringify(batch), docId, expectSha],
    });
    batch = [];
    chars = 0;
  };
  for (const r of rows) {
    if (batch.length && (chars + r.chars > INSERT_MAX_CHARS || batch.length >= INSERT_MAX_ROWS)) push();
    batch.push(r);
    chars += r.chars;
  }
  push();
  const del: SqlQuery = { query: `DELETE FROM official_chunks WHERE document_id = $1 AND EXISTS (SELECT 1 FROM official_documents WHERE id = $1 AND sha256 = $2)`, params: [docId, expectSha] };
  if (inserts.length <= 2) {
    const lock: SqlQuery = { query: `SELECT id FROM official_documents WHERE id = $1 AND sha256 = $2 FOR UPDATE`, params: [docId, expectSha] };
    const res = await store.transaction([lock, del, ...inserts, final]);
    return (res[res.length - 1] ?? []).length > 0;
  }
  // Very long documents: one request per batch (request size limits); every statement is guarded by the hash and the
  // document is marked indexed last (until then search and read do not serve the new rows: status / text version).
  const still = await store.query({ query: `SELECT id FROM official_documents WHERE id = $1 AND sha256 = $2`, params: [docId, expectSha] });
  if (!still.length) return false;
  await store.query(del);
  for (const q of inserts) await store.query(q);
  return (await store.query(final)).length > 0;
}

// ---------------------------------------------------------------------------
// Index (scrub + chunk + store) and parse
// ---------------------------------------------------------------------------

interface IndexInput {
  doc: DocRow;
  def: SourceDef;
  adapter: SourceAdapter | null;
  extracted: ExtractedDocument;
  pages: PageText[];
  ocrPages: number[];
  ocrModel: string | null;
  failedOcrPages?: number[];
  /** sha256 the document must still have (the bytes / text this index was made from). */
  expectSha: string;
  /** Contact data already removed upstream (OCR transcriptions are scrubbed before their progress is saved). */
  preRedacted?: ScrubCounts;
}

const NO_REDACTIONS: ScrubCounts = { phones: 0, emails: 0, links: 0 };

/** Pages with contact data replaced (see chunk.ts scrubPersonalData); cause lists and defect lists lose every link. */
export function scrubPages(pages: PageText[], kind: string): { pages: PageText[]; counts: ScrubCounts } {
  const allLinks = URGENT_KINDS.has(kind);
  let counts = NO_REDACTIONS;
  const out = pages.map((p) => {
    const r = scrubPersonalData(clean(p.text), { allLinks });
    counts = addCounts(counts, r.counts);
    return { page: p.page, text: r.text };
  });
  return { pages: out, counts };
}

async function indexDocument(deps: PipelineDeps, x: IndexInput): Promise<UnitOutcome> {
  const { store } = deps;
  const scrubbed = scrubPages(x.pages, x.doc.kind);
  const redacted = addCounts(x.preRedacted ?? NO_REDACTIONS, scrubbed.counts);
  const markdown = pageMarkdown(scrubbed.pages, x.extracted.paged);
  const chunks = chunkMarkdown(markdown);
  if (!chunks.length || !markdown.trim()) {
    await dropChunks(store, x.doc.id);
    await setDocStatus(store, x.doc.id, "excluded", "no readable text in the published document", { pages: x.extracted.pageCount });
    await insertReject(store, x.doc.source, x.doc.fileUrl ?? x.doc.url, "extract", "no readable text");
    return { status: "skipped", counts: { skipped: 1 }, note: "no readable text" };
  }
  const textSha = sha256Hex(markdown);
  const method = x.ocrPages.length ? "ocr_model" : x.extracted.method ?? "text_layer";
  const note = x.failedOcrPages?.length ? `OCR failed for page(s) ${x.failedOcrPages.join(", ")}; those pages are not searchable` : x.extracted.truncated ? (x.extracted.warning ?? "text truncated") : null;
  // scrubSha: the text version the scrub applied to (a re-index by code that does not scrub leaves it behind, and the
  // backfill then re-scrubs).
  const meta: Record<string, unknown> = { scrubVersion: SCRUB_VERSION, scrubSha: textSha, redacted };
  if (x.failedOcrPages?.length) meta.ocrFailedPages = x.failedOcrPages;
  if (x.extracted.truncated) meta.textTruncated = true;
  const final: SqlQuery = {
    // Warning flags of an earlier version are dropped (not merged): they describe that version only.
    query: `UPDATE official_documents SET status = 'indexed', text_sha256 = $2, text_chars = $3, chunks = $4, embedded = 0, extraction = $5, pages = $6,
      ocr_pages = $7::int[], ocr_model = $8, language = $9, indexed_at = now(), error = $10, extractor_version = $11,
      meta = (meta - 'ocrFailedPages' - 'textTruncated' - 'redacted') || $12::jsonb, updated_at = now()
      WHERE id = $1 AND sha256 = $13 RETURNING id`,
    params: [x.doc.id, textSha, markdown.length, chunks.length, method, x.extracted.pageCount, `{${x.ocrPages.join(",")}}`, x.ocrModel, x.extracted.language, note, EXTRACTOR_VERSION, JSON.stringify(meta), x.expectSha],
  };
  const stored = await storeChunks(store, x.doc.id, x.expectSha, chunks, new Set(x.ocrPages), textSha, final);
  if (!stored) return { status: "skipped", counts: { skipped: 1 }, note: "the document changed while it was being indexed; the newer version is processed by its own unit", stale: true };
  const units: UnitInput[] = [];
  if (deps.embedModel) units.push({ id: unitId("index", x.doc.id), source: x.doc.source, stage: "index", key: x.doc.url, documentId: x.doc.id, priority: PRIORITY.index });
  if (units.length) await enqueueUnits(store, units, { requeue: true });
  const out: UnitOutcome = { status: "done", counts: { indexed: 1 } };
  if (x.adapter?.parse) {
    // The parser reads the same scrubbed text as the index (positional items are transient and never stored here).
    const input: ParseInput = { id: x.doc.id, url: x.doc.url, title: x.doc.title, docDate: x.doc.docDate, meta: x.doc.meta, markdown, pages: scrubbed.pages, items: x.extracted.items.length ? x.extracted.items : undefined, fetchedAt: new Date(deps.now()).toISOString() };
    const parsed = await runParse(store, x.adapter, input);
    if (!parsed.ok) {
      await enqueueUnits(store, [{ id: unitId("parse", x.doc.id), source: x.doc.source, stage: "parse", key: x.doc.url, documentId: x.doc.id, priority: PRIORITY.parse }], { requeue: true });
      out.note = `parse failed: ${parsed.error}`;
    }
  }
  return out;
}

async function runParse(store: RemoteStore, adapter: SourceAdapter, input: ParseInput): Promise<{ ok: true; records: number } | { ok: false; error: string }> {
  try {
    const result = adapter.parse!(input);
    const stored = adapter.persist ? (await adapter.persist(store, input, result)).stored : null;
    if (!adapter.persist) {
      // Metadata-only parsers (SEBI order numbers, gazette part/section, ...) return [{ meta }]: merge it.
      const first = result.records[0] as { meta?: unknown } | undefined;
      if (first && first.meta && typeof first.meta === "object" && !Array.isArray(first.meta)) {
        await store.query({ query: `UPDATE official_documents SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1`, params: [input.id, JSON.stringify(first.meta)] });
      }
    }
    await store.query({
      query: `UPDATE official_documents SET parse_result = $2::jsonb, updated_at = now() WHERE id = $1`,
      params: [input.id, JSON.stringify({ records: result.records.length, unparsed: result.unparsed, stored, notes: (result.notes ?? []).slice(0, 20), at: input.fetchedAt })],
    });
    return { ok: true, records: result.records.length };
  } catch (e) {
    const error = (e as Error).message.slice(0, 300);
    await store.query({ query: `UPDATE official_documents SET parse_result = $2::jsonb, updated_at = now() WHERE id = $1`, params: [input.id, JSON.stringify({ error, at: input.fetchedAt })] }).catch(() => undefined);
    return { ok: false, error };
  }
}

/** Decide what to do with an extraction: OCR unit, OCR-needed (over the cap), unreadable, or index now. */
async function afterExtraction(deps: PipelineDeps, doc: DocRow, def: SourceDef, adapter: SourceAdapter | null, extracted: ExtractedDocument, sha: string, base: Partial<StageCounts>): Promise<UnitOutcome> {
  const { store } = deps;
  const counts = { ...base };
  if (extracted.ocrPages.length) {
    counts.extracted = (counts.extracted ?? 0) + 1;
    await dropChunks(store, doc.id);
    const cap = deps.maxOcrPages ?? ocrMaxPages();
    if (extracted.ocrPages.length > cap) {
      await setDocStatus(store, doc.id, "ocr_needed", `${extracted.ocrPages.length} page(s) have no usable text layer, above the OCR cap (OFFICIAL_OCR_MAX_PAGES=${cap}); not indexed`, { pages: extracted.pageCount });
      return { status: "done", counts, note: "ocr above cap" };
    }
    await setDocStatus(store, doc.id, "ocr_needed", null, { pages: extracted.pageCount });
    await enqueueUnits(store, [{ id: unitId("ocr", doc.id), source: doc.source, stage: "ocr", key: doc.url, documentId: doc.id, priority: PRIORITY.ocr, payload: { sha256: sha, pages: extracted.ocrPages } }], { requeue: true });
    return { status: "done", counts, note: `${extracted.ocrPages.length} page(s) queued for OCR` };
  }
  if (!extracted.method) {
    const reason = extracted.warning ?? "no readable text";
    await dropChunks(store, doc.id);
    if (extracted.kind === "unsupported") {
      await setDocStatus(store, doc.id, "excluded", reason);
      await insertReject(store, doc.source, doc.fileUrl ?? doc.url, "extract", reason);
      return { status: "skipped", counts: { ...counts, skipped: (counts.skipped ?? 0) + 1 }, note: reason };
    }
    await setDocStatus(store, doc.id, "failed", reason, { pages: extracted.pageCount });
    await insertReject(store, doc.source, doc.fileUrl ?? doc.url, "extract", reason);
    return { status: "failed", counts: { ...counts, failed: (counts.failed ?? 0) + 1 }, error: { url: doc.fileUrl ?? doc.url, error: reason } };
  }
  counts.extracted = (counts.extracted ?? 0) + 1;
  const r = await indexDocument(deps, { doc, def, adapter, extracted, pages: extracted.pages, ocrPages: [], ocrModel: null, expectSha: sha });
  return { ...r, counts: { ...counts, ...sumCounts(counts, r.counts) } };
}

function sumCounts(a: Partial<StageCounts>, b: Partial<StageCounts>): Partial<StageCounts> {
  const out: Partial<StageCounts> = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof StageCounts, number][]) out[k] = (a[k] ?? 0) + v;
  return out;
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function validDiscovered(def: SourceDef, d: DiscoveredDoc, allow: string[]): string | null {
  if (!d || d.sourceId !== def.id) return "item is for another source";
  for (const u of [d.url, d.fileUrl].filter(Boolean) as string[]) {
    let url: URL;
    try { url = new URL(u); } catch { return `invalid URL: ${String(u).slice(0, 200)}`; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return `not an http(s) URL: ${u.slice(0, 200)}`;
    if (!allow.some((h) => hostMatches(url.hostname, h))) return `host ${url.hostname} is not one of the source's hosts`;
  }
  if (!d.kind || !def.kinds.includes(d.kind)) return `kind ${String(d.kind)} is not declared by the source`;
  return null;
}

async function processDiscover(unit: OfficialUnit, deps: PipelineDeps): Promise<UnitOutcome> {
  const { store } = deps;
  const def = sourceDef(unit.source);
  const adapter = isSourceId(unit.source) ? officialAdapter(unit.source) : null;
  if (!def || !adapter || !def.enabled) { await skipUnit(store, unit.id, "source disabled or has no adapter"); return { status: "skipped", counts: {}, note: "source disabled" }; }
  const cursorKey = `official_cursor:${def.id}`;
  const cursor = await getOfficialState<string>(store, cursorKey);
  const ctx = makeAdapterContext(def, {
    limit: deps.discoverLimit,
    deadline: deps.deadline - 10_000,
    cursor: typeof cursor === "string" ? cursor : null,
    http: deps.http(def),
    now: deps.now,
    signal: deps.signal,
    log: (message, data) => deps.log("official.adapter", { source: def.id, message, ...(data ?? {}) }),
  });
  const res = await adapter.discover(ctx);
  const allow = allowHostsFor(def);
  const seen = new Set<string>();
  const items: DiscoveredDoc[] = [];
  let rejected = 0;
  for (const d of (res.items ?? []).slice(0, Math.max(deps.discoverLimit, 1) * 4)) {
    const why = validDiscovered(def, d, allow);
    if (why) { rejected++; await insertReject(store, def.id, String(d?.url ?? ""), "discover", why); continue; }
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    items.push(d);
  }
  const inserted = await upsertDiscovered(store, def, items);
  // The adapter's cursor is kept whenever it returns one — also with `done` (a "last seen" mark the next pass resumes
  // from, e.g. id walks). A cursor that does not move while more is promised would loop forever: the pass ends.
  const nextCursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : null;
  const more = !res.done && nextCursor != null;
  const stuck = more && nextCursor === cursor;
  await setOfficialState(store, cursorKey, stuck ? null : nextCursor);
  await setOfficialState(store, `official_discover:${def.id}`, { at: new Date(deps.now()).toISOString(), found: items.length, inserted, rejected, done: !more || stuck, notes: (res.notes ?? []).slice(0, 10) });
  if (more && !stuck) {
    // More to list: the unit goes straight back to the queue for the next worker / run.
    await releaseUnit(store, unit.id, null, `continues at cursor ${nextCursor.slice(0, 80)}`);
    return { status: "released", counts: { discovered: inserted } };
  }
  await completeUnit(store, unit.id, `${items.length} listed, ${inserted} new${rejected ? `, ${rejected} rejected` : ""}${stuck ? "; cursor did not advance (pass ended)" : ""}`);
  return { status: "done", counts: { discovered: inserted } };
}

/** Upsert discovered documents and queue their next stage. Returns how many were new. */
export async function upsertDiscovered(store: RemoteStore, def: SourceDef, items: DiscoveredDoc[]): Promise<number> {
  if (!items.length) return 0;
  const recs = items.map((d) => {
    const meta = { ...(d.meta ?? {}) } as Record<string, unknown>;
    const forum = typeof meta.forum === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(meta.forum) ? meta.forum : def.forum;
    return {
      id: documentIdFor(def.id, d.url), source: def.id, kind: d.kind, url: d.url, file_url: d.fileUrl ?? null, title: (d.title || d.url).replace(/\s+/g, " ").trim().slice(0, 1000),
      doc_date: d.docDate && /^\d{4}-\d{2}-\d{2}$/.test(d.docDate) ? d.docDate : null, forum, mime: d.mime ?? null, meta,
      text_sha: d.text ? sha256Hex(d.text) : null, refetch: meta.refetch === true, pattern: meta.urlFromPattern === true,
    };
  });
  const rows = await store.query({
    query: `WITH x AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text, source text, kind text, url text, file_url text, title text, doc_date date, forum text, mime text, meta jsonb)),
      up AS (
        INSERT INTO official_documents (id, source, kind, url, file_url, title, doc_date, forum, mime, meta)
        SELECT id, source, kind, url, file_url, title, doc_date, forum, mime, coalesce(meta, '{}'::jsonb) FROM x
        ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, kind = EXCLUDED.kind, file_url = coalesce(EXCLUDED.file_url, official_documents.file_url),
          doc_date = coalesce(EXCLUDED.doc_date, official_documents.doc_date), forum = coalesce(EXCLUDED.forum, official_documents.forum),
          mime = coalesce(EXCLUDED.mime, official_documents.mime), meta = official_documents.meta || EXCLUDED.meta, updated_at = now()
        RETURNING id, status, sha256, error, (xmax = 0) AS inserted)
      SELECT id, status, sha256, error, inserted FROM up`,
    params: [JSON.stringify(recs.map((r) => ({ id: r.id, source: r.source, kind: r.kind, url: r.url, file_url: r.file_url, title: r.title, doc_date: r.doc_date, forum: r.forum, mime: r.mime, meta: r.meta })))],
  });
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const fresh: UnitInput[] = [];
  const again: UnitInput[] = [];
  const refetch: UnitInput[] = [];
  const reappeared: UnitInput[] = [];
  let inserted = 0;
  recs.forEach((rec, i) => {
    const r = byId.get(rec.id);
    if (!r) return;
    const isNew = r.inserted === "t" || r.inserted === "true";
    if (isNew) inserted++;
    const text = items[i].text;
    const unit: UnitInput = text
      ? { id: unitId("extract", rec.id), source: def.id, stage: "extract", key: rec.url, documentId: rec.id, priority: PRIORITY.extract, payload: { text } }
      : { id: unitId("fetch", rec.id), source: def.id, stage: "fetch", key: rec.url, documentId: rec.id, priority: URGENT_KINDS.has(rec.kind) ? PRIORITY.fetchUrgent : PRIORITY.fetch };
    if (isNew || r.status === "discovered") fresh.push(unit);
    else if (text && rec.text_sha && rec.text_sha !== r.sha256) again.push(unit);
    else if (rec.refetch) refetch.push(unit);
    // A publisher's own listing links the document again after it answered 404: look again (bounded; never for a URL
    // the adapter built from a pattern, which a listing does not vouch for).
    else if (!text && !rec.pattern && r.status === "failed" && /^not published/.test(String(r.error ?? ""))) reappeared.push(unit);
  });
  if (fresh.length) await enqueueUnits(store, fresh);
  if (again.length) await enqueueUnits(store, again, { requeue: true });
  // meta.refetch: only when the last fetch (the unit's finish) is at least OFFICIAL_REFETCH_MIN_MINUTES old.
  if (refetch.length) await enqueueUnits(store, refetch, { requeue: true, minAgeMinutes: refetchMinMinutes() || undefined });
  if (reappeared.length) await enqueueUnits(store, reappeared, { requeue: true, minAgeMinutes: NOT_PUBLISHED_REQUEUE_MINUTES });
  return inserted;
}

const looksPdf = (url: string, mime: string | null) => /pdf/i.test(mime ?? "") || /\.pdf($|[?#])/i.test(url);

/** A PDF is expected: the URL or declared type says so, or the version on record was a PDF. */
function expectsPdf(doc: DocRow, target: string): boolean {
  if (looksPdf(target, doc.mime)) return true;
  if (doc.extraction === "ocr_model" || doc.extraction === "firecrawl_pdf") return true;
  return doc.extraction === "text_layer" && doc.pages != null;
}

/** Same document address up to scheme, "www.", default port, trailing slash and fragment. */
export function sameDocumentUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      const host = x.hostname.toLowerCase().replace(/^www\./, "");
      return `${host}${x.pathname.replace(/\/+$/, "") || "/"}${x.search}`;
    } catch { return u; }
  };
  return norm(a) === norm(b);
}

/**
 * Why fetched content is not the document (null when it is): an HTML / text page where a PDF is expected (error, WAF
 * or removed-file page served with HTTP 200), or an HTML page after a redirect to another address (a soft 404).
 */
export function contentMismatch(target: string, finalUrl: string | null | undefined, mime: string | null, bytes: Uint8Array, expectPdf: boolean): string | null {
  const sniff = sniffBytes(bytes);
  if (expectPdf && sniff === "html") return "the publisher returned an HTML page (error, firewall or removed-file page) instead of the PDF";
  if (expectPdf && sniff === "other") return `the publisher returned non-PDF content (${mime ?? "unknown type"}, ${bytes.byteLength} bytes) instead of the PDF`;
  if (sniff === "html" && finalUrl && !sameDocumentUrl(target, finalUrl)) {
    let to = finalUrl;
    try { const u = new URL(finalUrl); to = `${u.hostname}${u.pathname}`; } catch { /* keep as is */ }
    return `the publisher redirected to ${to.slice(0, 200)} and returned an HTML page there (moved or removed document)`;
  }
  return null;
}

class ContentMismatchError extends Error {
  constructor(message: string) { super(message); this.name = "ContentMismatchError"; }
}

async function processFetch(unit: OfficialUnit, deps: PipelineDeps): Promise<UnitOutcome> {
  const { store } = deps;
  const doc = await loadDoc(store, unit.documentId);
  if (!doc) { await skipUnit(store, unit.id, "document no longer exists"); return { status: "skipped", counts: { skipped: 1 } }; }
  const def = sourceDef(doc.source);
  const adapter = officialAdapter(doc.source);
  if (!def || !def.enabled || !adapter) { await releaseUnit(store, unit.id, undefined, "source disabled"); return { status: "released", counts: {}, note: "source disabled" }; }
  if (doc.status === "excluded") { await skipUnit(store, unit.id, "document excluded"); return { status: "skipped", counts: { skipped: 1 } }; }
  const http = deps.http(def);
  const target = doc.fileUrl ?? doc.url;
  const expectPdf = expectsPdf(doc, target);
  let sha: string;
  let provenance: FetchProvenance & { hashOf?: string };
  let hashOf = "bytes";
  let extracted: ExtractedDocument;
  let byteCount: number;
  let mime: string | null;
  let bytes: Uint8Array | null = null;
  try {
    const raw = await http.fetchFile(target, { maxBytes: maxFileBytes() });
    const decoded = adapter.decode ? adapter.decode(doc.meta, raw.bytes) : null;
    const f = decoded ? { ...raw, bytes: decoded.bytes, mime: decoded.mime ?? raw.mime } : raw;
    // Not the document (HTML error / WAF / soft-404 page): refused before anything is hashed or replaced.
    const mismatch = contentMismatch(target, f.finalUrl, f.mime, f.bytes, expectPdf);
    if (mismatch) {
      await insertReject(store, doc.source, target, "fetch", mismatch);
      throw new ContentMismatchError(mismatch);
    }
    bytes = f.bytes;
    sha = sha256Hex(f.bytes);
    provenance = f.provenance;
    byteCount = f.bytes.byteLength;
    mime = sniffBytes(f.bytes) === "pdf" ? "application/pdf" : f.mime;
    if (sha === doc.sha256 && doc.extractorVersion === EXTRACTOR_VERSION && (doc.status === "indexed" || doc.status === "ocr_needed")) {
      await store.query({ query: `UPDATE official_documents SET fetched_at = now(), fetch_provenance = $2::jsonb, updated_at = now() WHERE id = $1`, params: [doc.id, JSON.stringify(provenance)] });
      await completeUnit(store, unit.id, "unchanged");
      return { status: "done", counts: { fetched: 1, skipped: 1 }, note: "unchanged" };
    }
    extracted = await extractDocument({ bytes: f.bytes, mime: f.mime, url: target, finalUrl: f.finalUrl });
  } catch (e) {
    if (interrupted(deps, e)) return releaseInterrupted(store, unit);
    if (isLocalRateLimit(e)) return deferThrottled(store, unit);
    const msg = (e as Error).message.slice(0, 500);
    if (isNotPublished(e)) return notPublished(unit, deps, doc, target, msg, (e as { status?: number }).status ?? 404);
    if (isTooLarge(e)) {
      await setDocStatus(store, doc.id, "excluded", `file larger than the ${Math.round(maxFileBytes() / 1048576)} MB limit (OFFICIAL_MAX_FILE_MB)`);
      await dropChunks(store, doc.id);
      await insertReject(store, doc.source, target, "fetch", msg);
      await skipUnit(store, unit.id, "too large");
      return { status: "skipped", counts: { skipped: 1 }, error: { url: target, error: msg } };
    }
    // Firecrawl (location IN) for firecrawl_in sources when the direct fetch failed for a reason another route may fix.
    let fcError: unknown;
    const fc = http.firecrawlAllowed && fallbackWorthy(e)
      ? await firecrawlFallback(http, target, doc, expectPdf, (why) => insertReject(store, doc.source, target, "fetch", why)).catch((fe: unknown) => { fcError = fe; return null; })
      : null;
    if (!fc) {
      if (interrupted(deps, fcError)) return releaseInterrupted(store, unit);
      if (isProviderError(fcError) && fcError.code === "not_configured" && fcError.status == null && /not one of the source's hosts/.test(fcError.message)) {
        await insertReject(store, doc.source, target, "fetch", fcError.message);
      }
      return fetchFailed(unit, deps, doc, target, msg);
    }
    sha = sha256Hex(fc.text);
    hashOf = fc.hashOf;
    provenance = { ...fc.provenance, hashOf: fc.hashOf };
    byteCount = fc.text.length;
    mime = fc.mime;
    extracted = fc.extracted;
    if (sha === doc.sha256 && doc.extractorVersion === EXTRACTOR_VERSION && doc.status === "indexed") {
      await completeUnit(store, unit.id, "unchanged");
      return { status: "done", counts: { fetched: 1, skipped: 1 }, note: "unchanged" };
    }
  }
  // A new version only when the same kind of hash changed: a switch between the publisher's bytes and a Firecrawl
  // parse (different things hashed) updates the text and provenance but is not a new publication.
  const changed = Boolean(doc.sha256 && doc.sha256 !== sha && (doc.hashOf ?? "bytes") === hashOf);
  const history = changed ? [{ version: doc.version, sha256: doc.sha256, fetchedAt: doc.fetchedAt }] : [];
  await store.query({
    query: `UPDATE official_documents SET status = 'fetched', sha256 = $2, bytes = $3, mime = coalesce($4, mime), fetch_provenance = $5::jsonb, fetched_at = now(),
      version = version + $6, history = history || $7::jsonb, attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = $1`,
    params: [doc.id, sha, byteCount, mime, JSON.stringify(provenance), changed ? 1 : 0, JSON.stringify(history)],
  });
  if (bytes && extracted.kind === "pdf") deps.bytes.set(doc.id, sha, bytes);
  const out = await afterExtraction(deps, { ...doc, sha256: sha, version: doc.version + (changed ? 1 : 0), hashOf }, def, adapter, extracted, sha, { fetched: 1 });
  await finishUnit(store, unit, out);
  return out;
}

/** A transient fetch failure: retried with backoff; at the last attempt an indexed version stays the current text. */
async function fetchFailed(unit: OfficialUnit, deps: PipelineDeps, doc: DocRow, target: string, msg: string): Promise<UnitOutcome> {
  const { store } = deps;
  const final = (await failUnit(store, unit, msg)) === "failed";
  if (final) {
    await insertReject(store, doc.source, target, "fetch", msg);
    if (doc.status === "indexed") await setDocError(store, doc.id, `re-fetch failed (the indexed version is kept): ${msg}`);
    else await setDocStatus(store, doc.id, "failed", msg);
  }
  return { status: final ? "failed" : "retry", counts: final ? { failed: 1 } : {}, error: { url: target, error: msg } };
}

const isoDay = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/**
 * Epoch ms until which a 404 for this document means "not yet published" (dates in IST): a cause list / defect list
 * until the end of the day after its list date (meta.listDate, else its date); a pattern URL (e.g. a dated order file
 * name) until the end of the NOT_YET_PATTERN_DAYS-th day after its date (meta.orderDate, else its date). Null without
 * a date (then a bounded number of re-checks applies).
 */
export function notYetUntil(doc: { kind: string; docDate: string | null; meta: Record<string, unknown> }): number | null {
  const urgent = URGENT_KINDS.has(doc.kind);
  const day = urgent ? isoDay(doc.meta.listDate) ?? doc.docDate : isoDay(doc.meta.orderDate) ?? doc.docDate;
  if (!day) return null;
  const t = Date.parse(`${day}T00:00:00+05:30`);
  if (!Number.isFinite(t)) return null;
  return t + ((urgent ? 1 : NOT_YET_PATTERN_DAYS) + 1) * 86_400_000;
}

/**
 * HTTP 404/410. For a cause list / defect list, or a URL the adapter built from the publisher's pattern, that was never
 * read, it means "not yet published": re-checked every NOT_YET_RECHECK_SECONDS until the day after its date (or
 * NOT_YET_MAX_CHECKS times without a date), without consuming attempts. Otherwise (or after that window) the document
 * is "not published at this URL": recorded, never substituted, and its old text is no longer served.
 */
async function notPublished(unit: OfficialUnit, deps: PipelineDeps, doc: DocRow, target: string, msg: string, status: number): Promise<UnitOutcome> {
  const { store } = deps;
  const dated = URGENT_KINDS.has(doc.kind) || doc.meta.urlFromPattern === true;
  if (dated && doc.status !== "indexed") {
    const until = notYetUntil(doc);
    const checks = Number(unit.payload?.notYetChecks ?? 0) || 0;
    if (until != null ? deps.now() < until : checks < NOT_YET_MAX_CHECKS) {
      const by = until != null ? new Date(until).toISOString().slice(0, 10) : `${NOT_YET_MAX_CHECKS - checks - 1} more check(s)`;
      await setDocError(store, doc.id, `not yet published at this URL (HTTP 404); re-checked every ${NOT_YET_RECHECK_SECONDS / 60} minutes until ${by}`);
      await deferUnit(store, unit.id, NOT_YET_RECHECK_SECONDS, "not yet published; re-checked later", { ...(unit.payload ?? {}), notYetChecks: checks + 1 });
      return { status: "released", counts: {}, note: "not yet published" };
    }
  }
  await setDocStatus(store, doc.id, "failed", `not published at this URL (HTTP ${status})`);
  await dropChunks(store, doc.id);
  await insertReject(store, doc.source, target, "fetch", msg);
  await failUnit(store, unit, msg, { permanent: true });
  return { status: "failed", counts: { failed: 1 }, error: { url: target, error: msg } };
}

/**
 * Firecrawl copy of a document: PDF → its markdown parse; page → raw HTML → markdown. Null when empty or not the
 * document (`reject` records why): non-PDF content where a PDF is expected, or a parse that stopped at the page
 * limit for a cause list / defect list (a partial list would make missing cases look "not listed").
 */
async function firecrawlFallback(http: OfficialHttp, target: string, doc: DocRow, expectPdf: boolean, reject: (why: string) => Promise<void>): Promise<{ text: string; extracted: ExtractedDocument; provenance: FetchProvenance; hashOf: string; mime: string } | null> {
  if (expectPdf) {
    const maxPages = firecrawlMaxPages();
    const r = await http.firecrawlDocument(target, { maxPages });
    if (!r || !r.markdown.trim()) return null;
    if (r.contentType && !/pdf/i.test(r.contentType)) { await reject(`Firecrawl was served ${r.contentType} instead of the PDF`); return null; }
    const extracted = extractFirecrawlMarkdown(r.markdown, r.numPages, maxPages);
    if (extracted.truncated && URGENT_KINDS.has(doc.kind)) { await reject(`${extracted.warning ?? "Firecrawl parse incomplete"}; a partial ${doc.kind.replace("_", " ")} is not indexed`); return null; }
    return { text: r.markdown, extracted, provenance: r.provenance, hashOf: "firecrawl_markdown", mime: "text/markdown" };
  }
  const page = await http.firecrawlPage(target);
  if (!page) return null;
  const text = page.html ?? page.markdown ?? "";
  if (!text.trim()) return null;
  const extracted = page.html ? extractHtml(page.html, page.finalUrl) : extractProvidedText(page.markdown ?? "");
  return { text, extracted: page.html ? extracted : { ...extracted, method: extracted.method ? "html" : null }, provenance: page.provenance, hashOf: page.html ? "firecrawl_raw_html" : "firecrawl_markdown", mime: page.html ? "text/html" : "text/markdown" };
}

function firecrawlMaxPages(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number(env.OFFICIAL_FIRECRAWL_MAX_PAGES);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 2_000) : 300;
}

async function finishUnit(store: RemoteStore, unit: OfficialUnit, out: UnitOutcome): Promise<void> {
  if (out.status === "done") await completeUnit(store, unit.id, out.note ?? null);
  else if (out.status === "skipped") await skipUnit(store, unit.id, out.note ?? "skipped");
  else if (out.status === "failed") await failUnit(store, unit, out.error?.error ?? out.note ?? "failed", { permanent: true });
}

async function processExtract(unit: OfficialUnit, deps: PipelineDeps): Promise<UnitOutcome> {
  const { store } = deps;
  const doc = await loadDoc(store, unit.documentId);
  const text = typeof unit.payload?.text === "string" ? unit.payload.text : null;
  if (!doc || !text) { await skipUnit(store, unit.id, doc ? "no text in the unit" : "document no longer exists"); return { status: "skipped", counts: { skipped: 1 } }; }
  const def = sourceDef(doc.source);
  const adapter = officialAdapter(doc.source);
  if (!def || !def.enabled || !adapter) { await releaseUnit(store, unit.id, undefined, "source disabled"); return { status: "released", counts: {} }; }
  const sha = sha256Hex(text);
  if (sha === doc.sha256 && doc.extractorVersion === EXTRACTOR_VERSION && doc.status === "indexed") {
    await completeUnit(store, unit.id, "unchanged");
    await dropUnitText(store, unit.id);
    return { status: "done", counts: { skipped: 1 } };
  }
  const changed = Boolean(doc.sha256 && doc.sha256 !== sha && (doc.hashOf ?? "listing_text") === "listing_text");
  const provenance: FetchProvenance & { hashOf: string } = { via: "direct", proxy: null, timezone: null, status: 200, finalUrl: doc.url, hashOf: "listing_text" };
  await store.query({
    query: `UPDATE official_documents SET status = 'fetched', sha256 = $2, bytes = $3, mime = 'text/plain', fetch_provenance = $4::jsonb, fetched_at = now(),
      version = version + $5, history = history || $6::jsonb, error = NULL, updated_at = now() WHERE id = $1`,
    params: [doc.id, sha, text.length, JSON.stringify(provenance), changed ? 1 : 0, JSON.stringify(changed ? [{ version: doc.version, sha256: doc.sha256, fetchedAt: doc.fetchedAt }] : [])],
  });
  const out = await afterExtraction(deps, { ...doc, sha256: sha, hashOf: "listing_text" }, def, adapter, extractProvidedText(text), sha, {});
  await finishUnit(store, unit, out);
  // The listing text (raw, with any contact data) is not kept once the document's text of record is stored.
  if (out.status === "done" || out.status === "skipped") await dropUnitText(store, unit.id);
  return out;
}

async function dropUnitText(store: RemoteStore, id: string): Promise<void> {
  await store.query({ query: `UPDATE official_units SET payload = payload - 'text' WHERE id = $1 AND status IN ('done', 'skipped')`, params: [id] });
}

/** Bytes for a document at a known hash: cache, else a fresh direct download that must match. */
async function bytesFor(deps: PipelineDeps, doc: DocRow, def: SourceDef, sha: string): Promise<Uint8Array | "changed"> {
  const cached = deps.bytes.get(doc.id, sha);
  if (cached) return cached;
  const raw = await deps.http(def).fetchFile(doc.fileUrl ?? doc.url, { maxBytes: maxFileBytes() });
  const adapter = officialAdapter(doc.source);
  const fileBytes = adapter?.decode ? adapter.decode(doc.meta, raw.bytes).bytes : raw.bytes;
  if (sha256Hex(fileBytes) !== sha) return "changed";
  deps.bytes.set(doc.id, sha, fileBytes);
  return fileBytes;
}

function pagesOf(v: unknown): number[] {
  return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

function countsOf(v: unknown): ScrubCounts {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = (k: string) => (Number.isFinite(Number(o[k])) ? Number(o[k]) : 0);
  return { phones: n("phones"), emails: n("emails"), links: n("links") };
}

async function processOcr(unit: OfficialUnit, deps: PipelineDeps): Promise<UnitOutcome> {
  const { store } = deps;
  const doc = await loadDoc(store, unit.documentId);
  if (!doc) { await skipUnit(store, unit.id, "document no longer exists"); return { status: "skipped", counts: { skipped: 1 } }; }
  let sha = typeof unit.payload?.sha256 === "string" ? unit.payload.sha256 : null;
  let pages = pagesOf(unit.payload?.pages);
  let done = (unit.payload?.done && typeof unit.payload.done === "object" ? unit.payload.done : {}) as Record<string, string>;
  let redacted = countsOf(unit.payload?.redacted);
  let retarget = false;
  if (!sha || doc.sha256 !== sha || !pages.length) {
    // Queued for an earlier version (or the request lost its pages): re-target the current version when it awaits
    // OCR — the newer fetch could not re-queue this unit while it was pending or running; otherwise nothing to do.
    if (doc.status !== "ocr_needed" || !doc.sha256) {
      await skipUnit(store, unit.id, sha && doc.sha256 !== sha ? "document changed since the OCR was queued (a new fetch supersedes it)" : "nothing to OCR");
      return { status: "skipped", counts: { skipped: 1 } };
    }
    sha = doc.sha256;
    pages = [];
    done = {};
    redacted = NO_REDACTIONS;
    retarget = true;
  }
  const def = sourceDef(doc.source);
  const adapter = officialAdapter(doc.source);
  if (!def || !def.enabled || !adapter) { await releaseUnit(store, unit.id, undefined, "source disabled"); return { status: "released", counts: {} }; }
  const target = doc.fileUrl ?? doc.url;
  const allLinks = URGENT_KINDS.has(doc.kind);
  try {
    const bytes = await bytesFor(deps, doc, def, sha);
    if (bytes === "changed") {
      await enqueueUnits(store, [{ id: unitId("fetch", doc.id), source: doc.source, stage: "fetch", key: doc.url, documentId: doc.id, priority: PRIORITY.fetch }], { requeue: true });
      await skipUnit(store, unit.id, "published file changed; re-fetch queued");
      return { status: "skipped", counts: { skipped: 1 } };
    }
    const extracted = await extractPdf(bytes);
    if (retarget) {
      pages = extracted.ocrPages;
      if (!pages.length) {
        const out = await afterExtraction(deps, doc, def, adapter, extracted, sha, {});
        await finishUnit(store, unit, out);
        return out;
      }
    }
    // Progress: each transcribed range is scrubbed and saved on the unit at once (a killed run loses only ranges in
    // flight); transcriptions are never stored with contact data.
    const persisted: Record<string, string> = {};
    for (const [k, v] of Object.entries(done)) {
      const r = scrubPersonalData(clean(String(v ?? "")), { allLinks }); // progress saved by an earlier version may be raw
      persisted[k] = r.text;
      redacted = addCounts(redacted, r.counts);
    }
    const payloadNow = () => ({ ...(retarget ? {} : unit.payload ?? {}), sha256: sha, pages, done: persisted, redacted });
    // Saves are coalesced (one in flight; the latest state wins) and at most every OCR_PROGRESS_SAVE_MS, so a long
    // scan (hundreds of pages) does not rewrite a growing payload after every range; the release / failure paths
    // below always write the final state.
    let saving: Promise<void> | null = null;
    let dirty = false;
    let lastSave = -Infinity;
    const flushProgress = (): Promise<void> => {
      if (saving) return saving;
      saving = (async () => {
        while (dirty) {
          dirty = false;
          lastSave = deps.now();
          await store.query({ query: `UPDATE official_units SET payload = $2::jsonb WHERE id = $1 AND status = 'running'`, params: [unit.id, JSON.stringify(payloadNow())] }).catch(() => undefined);
        }
      })().finally(() => { saving = null; });
      return saving;
    };
    const onProgress = (got: PageText[]): void => {
      for (const p of got) {
        const r = scrubPersonalData(clean(p.text), { allLinks });
        persisted[String(p.page)] = r.text;
        redacted = addCounts(redacted, r.counts);
      }
      dirty = true;
      if (deps.now() - lastSave >= OCR_PROGRESS_SAVE_MS) void flushProgress();
    };
    const ocr = await ocrDocument(bytes, pages, { model: deps.ocrModel(), done: persisted, deadline: deps.deadline, now: deps.now, signal: deps.signal, maxPages: deps.maxOcrPages, concurrency: deps.ocrConcurrency, onProgress });
    await (saving as Promise<void> | null); // the closure may have started a save
    if (ocr.capped) {
      await setDocStatus(store, doc.id, "ocr_needed", `${pages.length} page(s) need OCR, above the OCR cap (OFFICIAL_OCR_MAX_PAGES); not indexed`);
      await completeUnit(store, unit.id, "ocr above cap");
      return { status: "done", counts: {} };
    }
    if (!ocr.complete || interrupted(deps)) {
      await releaseUnit(store, unit.id, payloadNow(), `${Object.keys(persisted).length} of ${pages.length} page(s) transcribed; resumes`);
      return { status: "released", counts: {} };
    }
    const failedPages = ocr.failed.map((f) => f.page);
    if (failedPages.length && unit.attempts < MAX_ATTEMPTS) {
      await store.query({ query: `UPDATE official_units SET payload = $2::jsonb WHERE id = $1`, params: [unit.id, JSON.stringify(payloadNow())] });
      const msg = `OCR failed for page(s) ${failedPages.join(", ")}: ${ocr.failed[0].error}`;
      await failUnit(store, unit, msg);
      return { status: "retry", counts: {}, error: { url: target, error: msg } };
    }
    const ocrSet = new Set(Object.keys(persisted).map(Number));
    const finalPages = extracted.pages.map((p) => (ocrSet.has(p.page) ? { page: p.page, text: persisted[String(p.page)] ?? "" } : p));
    const r = await indexDocument(deps, { doc, def, adapter, extracted, pages: finalPages, ocrPages: [...ocrSet].sort((a, b) => a - b), ocrModel: ocr.model || (unit.payload?.model as string | undefined) || null, failedOcrPages: failedPages, expectSha: sha, preRedacted: redacted });
    if (r.stale) {
      // A newer version arrived while this ran: the next claim re-targets it (its own OCR request could not be queued).
      await releaseUnit(store, unit.id, { sha256: null }, "document changed during OCR; re-targets the current version");
      return { status: "released", counts: {}, note: r.note };
    }
    const out: UnitOutcome = { ...r, counts: sumCounts(r.counts, { ocr: 1 }) };
    await finishUnit(store, unit, out);
    return out;
  } catch (e) {
    if (interrupted(deps, e)) return releaseInterrupted(store, unit);
    if (isLocalRateLimit(e)) return deferThrottled(store, unit);
    const msg = (e as Error).message.slice(0, 500);
    const final = (await failUnit(store, unit, msg, { permanent: isNotPublished(e) })) === "failed";
    if (final) { await setDocStatus(store, doc.id, "ocr_needed", `OCR could not complete: ${msg}`); await dropChunks(store, doc.id); }
    return { status: final ? "failed" : "retry", counts: final ? { failed: 1 } : {}, error: { url: target, error: msg } };
  }
}

async function processIndex(unit: OfficialUnit, deps: PipelineDeps): Promise<UnitOutcome> {
  const { store } = deps;
  if (!deps.embedModel) { await skipUnit(store, unit.id, "embeddings are not configured (keyword search only)"); return { status: "skipped", counts: {} }; }
  if (deps.embedBudget.left <= 0) {
    // Not claimable again in this run (the runner stops claiming index units once the budget is used).
    await deferUnit(store, unit.id, 60, "embedding budget for this run used");
    return { status: "released", counts: {} };
  }
  const r = await embedPendingChunks(store, { documentId: unit.documentId, maxChunks: Math.min(deps.embedBudget.left, 2_000), embed: deps.embed, model: deps.embedModel, signal: deps.signal, deadline: deps.deadline, now: deps.now });
  deps.embedBudget.left -= r.embedded;
  if (interrupted(deps)) return releaseInterrupted(store, unit);
  if (r.error) {
    const final = (await failUnit(store, unit, r.error)) === "failed";
    return { status: final ? "failed" : "retry", counts: {}, error: { url: unit.key, error: r.error } };
  }
  if (r.remaining) { await releaseUnit(store, unit.id, undefined, `${r.embedded} chunk(s) embedded; more remain`); return { status: "released", counts: {} }; }
  await completeUnit(store, unit.id, `${r.embedded} chunk(s) embedded`);
  return { status: "done", counts: {} };
}

async function processParse(unit: OfficialUnit, deps: PipelineDeps): Promise<UnitOutcome> {
  const { store } = deps;
  const doc = await loadDoc(store, unit.documentId);
  if (!doc || doc.status !== "indexed") { await skipUnit(store, unit.id, "document not indexed"); return { status: "skipped", counts: {} }; }
  const def = sourceDef(doc.source);
  const adapter = officialAdapter(doc.source);
  if (!def || !adapter?.parse) { await skipUnit(store, unit.id, "no parser"); return { status: "skipped", counts: {} }; }
  try {
    let pages: PageText[];
    let items: ExtractedDocument["items"] = [];
    let markdown: string;
    if (doc.extraction === "text_layer" && doc.sha256 && /pdf/i.test(doc.mime ?? "pdf")) {
      const bytes = await bytesFor(deps, doc, def, doc.sha256);
      if (bytes === "changed") {
        await enqueueUnits(store, [{ id: unitId("fetch", doc.id), source: doc.source, stage: "fetch", key: doc.url, documentId: doc.id, priority: PRIORITY.fetch }], { requeue: true });
        await skipUnit(store, unit.id, "published file changed; re-fetch queued");
        return { status: "skipped", counts: {} };
      }
      const ex = await extractPdf(bytes);
      pages = scrubPages(ex.pages, doc.kind).pages;
      items = ex.items;
      markdown = pageMarkdown(pages, true);
    } else {
      // Text of record from the stored chunks of the current version (already scrubbed; no overlap, so the join is
      // the document text).
      const rows = await store.query({ query: `SELECT idx, page_start, text FROM official_chunks WHERE document_id = $1 AND text_sha256 = (SELECT text_sha256 FROM official_documents WHERE id = $1) ORDER BY idx`, params: [doc.id] });
      const byPage = new Map<number, string[]>();
      for (const r of rows) { const p = r.page_start == null ? 1 : Number(r.page_start); byPage.set(p, [...(byPage.get(p) ?? []), String(r.text ?? "")]); }
      pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, t]) => ({ page, text: t.join("\n\n") }));
      markdown = rows.map((r) => String(r.text ?? "")).join("\n\n");
    }
    const r = await runParse(store, adapter, { id: doc.id, url: doc.url, title: doc.title, docDate: doc.docDate, meta: doc.meta, markdown, pages, items: items.length ? items : undefined, fetchedAt: new Date(deps.now()).toISOString() });
    if (!r.ok) {
      const final = (await failUnit(store, unit, r.error)) === "failed";
      return { status: final ? "failed" : "retry", counts: {}, error: { url: doc.url, error: r.error } };
    }
    await completeUnit(store, unit.id, `${r.records} record(s)`);
    return { status: "done", counts: {} };
  } catch (e) {
    if (interrupted(deps, e)) return releaseInterrupted(store, unit);
    const msg = (e as Error).message.slice(0, 500);
    const final = (await failUnit(store, unit, msg)) === "failed";
    return { status: final ? "failed" : "retry", counts: {}, error: { url: doc.url, error: msg } };
  }
}

/** Process one claimed unit. Unexpected errors are recorded on the unit (retry with backoff); store errors propagate. */
export async function processUnit(unit: OfficialUnit, deps: PipelineDeps): Promise<UnitOutcome> {
  try {
    switch (unit.stage) {
      case "discover": return await processDiscover(unit, deps);
      case "fetch": return await processFetch(unit, deps);
      case "extract": return await processExtract(unit, deps);
      case "ocr": return await processOcr(unit, deps);
      case "index": return await processIndex(unit, deps);
      case "parse": return await processParse(unit, deps);
      default:
        await skipUnit(deps.store, unit.id, `unknown stage ${String(unit.stage)}`);
        return { status: "skipped", counts: {} };
    }
  } catch (e) {
    if (interrupted(deps, e)) return releaseInterrupted(deps.store, unit);
    if (isLocalRateLimit(e)) return deferThrottled(deps.store, unit);
    const msg = (e as Error).message.slice(0, 500);
    const final = (await failUnit(deps.store, unit, msg)) === "failed";
    if (final && unit.documentId && unit.stage !== "index" && unit.stage !== "parse" && unit.stage !== "discover") {
      // An indexed version that this unit never replaced stays current; anything else is failed and not served.
      const doc = await loadDoc(deps.store, unit.documentId).catch(() => null);
      if (doc && doc.status !== "indexed") {
        await setDocStatus(deps.store, unit.documentId, "failed", msg).catch(() => undefined);
        await dropChunks(deps.store, unit.documentId).catch(() => undefined);
      }
    }
    return { status: final ? "failed" : "retry", counts: final ? { failed: 1 } : {}, error: { url: unit.key, error: msg } };
  }
}

// ---------------------------------------------------------------------------
// Contact-data backfill for documents indexed before (or with an older version of) the scrubber
// ---------------------------------------------------------------------------

export interface ScrubBackfillResult {
  /** Documents examined (marked with the current scrubVersion). */
  documents: number;
  /** Documents whose stored text changed. */
  changed: number;
  /** Chunks rewritten (their embeddings cleared for re-embedding). */
  chunks: number;
  /** Documents no longer indexed (failed / excluded) whose leftover chunks were removed. */
  purged: number;
  /** Finished units whose stored listing text / OCR transcriptions were dropped. */
  payloads: number;
  redacted: ScrubCounts;
}

/**
 * Re-scrub the stored chunks of indexed documents whose `meta.scrubVersion` is not SCRUB_VERSION (cause lists and
 * defect lists first), at most `limit` documents per call, one document at a time:
 *  1. read its chunks of the current text version; scrub each (deterministic, idempotent);
 *  2. rewrite only the chunks that changed, in bounded batches, each guarded by the document's text version, clearing
 *     their embeddings (they are re-embedded from the scrubbed text);
 *  3. in one transaction: move the document and all its current chunks to a new text_sha256 (the hash of the scrubbed
 *     chunk text) and set meta.scrubVersion / meta.redacted — only if the document still has the version read in 1.
 * Overlapping runs are safe: a second run's guarded statements match nothing once the first moved the version, and a
 * re-index in between replaces the chunks (already scrubbed) and wins. Also removes leftover chunks of documents that
 * are no longer indexed and drops raw listing text / OCR transcriptions from finished units.
 */
export async function scrubIndexedDocuments(store: RemoteStore, o: { limit: number; deadline: number; now: () => number; embedModel?: string | null; signal?: AbortSignal }): Promise<ScrubBackfillResult> {
  const out: ScrubBackfillResult = { documents: 0, changed: 0, chunks: 0, purged: 0, payloads: 0, redacted: NO_REDACTIONS };
  const limit = Math.max(0, Math.min(Math.floor(o.limit), 500));
  if (!limit) return out;
  const stop = () => o.now() > o.deadline || o.signal?.aborted === true;
  const docs = await store.query({
    query: `SELECT id, source, kind, url, text_sha256 FROM official_documents
      WHERE status = 'indexed' AND text_sha256 IS NOT NULL AND (coalesce(meta->>'scrubVersion', '') <> $1 OR coalesce(meta->>'scrubSha', '') <> text_sha256)
      ORDER BY (kind = ANY($2::text[])) DESC, indexed_at DESC NULLS LAST, id LIMIT ${limit}`,
    params: [String(SCRUB_VERSION), pgArray([...URGENT_KINDS])],
  });
  for (const d of docs) {
    if (stop()) break;
    const r = await rescrubDocument(store, { id: String(d.id), source: String(d.source), kind: String(d.kind), url: String(d.url), textSha: String(d.text_sha256) }, o.embedModel ?? null);
    out.documents++;
    if (r.chunks) { out.changed++; out.chunks += r.chunks; }
    out.redacted = addCounts(out.redacted, r.counts);
  }
  if (!stop()) {
    const stale = await store.query({ query: `SELECT id FROM official_documents WHERE status IN ('failed', 'excluded') AND chunks > 0 ORDER BY id LIMIT ${limit}` });
    for (const s of stale) {
      if (stop()) break;
      await dropChunks(store, String(s.id));
      out.purged++;
    }
  }
  if (!stop()) {
    const p = await store.query({
      query: `WITH p AS (SELECT id FROM official_units WHERE stage IN ('extract', 'ocr') AND status IN ('done', 'skipped') AND ((payload->'text') IS NOT NULL OR (payload->'done') IS NOT NULL) ORDER BY id LIMIT 500)
        UPDATE official_units u SET payload = u.payload - 'text' - 'done' FROM p WHERE u.id = p.id RETURNING 1 AS n`,
    });
    out.payloads = p.length;
  }
  return out;
}

const RESCRUB_BATCH_CHARS = 1_000_000;

async function rescrubDocument(store: RemoteStore, d: { id: string; source: string; kind: string; url: string; textSha: string }, embedModel: string | null): Promise<{ chunks: number; counts: ScrubCounts }> {
  const rows = await store.query({ query: `SELECT idx, text, text_sha256 FROM official_chunks WHERE document_id = $1 ORDER BY idx`, params: [d.id] });
  const allLinks = URGENT_KINDS.has(d.kind);
  let counts = NO_REDACTIONS;
  const texts: string[] = [];
  const changed: { idx: number; text: string; chars: number }[] = [];
  for (const r of rows) {
    if (String(r.text_sha256) !== d.textSha) continue; // rows of another version are not served (a re-index is in flight)
    const before = String(r.text ?? "");
    const s = scrubPersonalData(before, { allLinks });
    counts = addCounts(counts, s.counts);
    texts.push(s.text);
    if (s.text !== before) changed.push({ idx: Number(r.idx), text: s.text, chars: s.text.length });
  }
  const meta = (sha: string) => JSON.stringify({ scrubVersion: SCRUB_VERSION, scrubSha: sha, redacted: counts });
  if (!changed.length) {
    await store.query({ query: `UPDATE official_documents SET meta = (meta - 'redacted') || $3::jsonb, updated_at = now() WHERE id = $1 AND status = 'indexed' AND text_sha256 = $2`, params: [d.id, d.textSha, meta(d.textSha)] });
    return { chunks: 0, counts };
  }
  // 2. Rewrite the changed chunks (bounded requests), guarded by the text version read above.
  let batch: typeof changed = [];
  let chars = 0;
  const flush = async () => {
    if (!batch.length) return;
    await store.query({
      query: `UPDATE official_chunks c SET text = x.text, chars = x.chars, embedding = NULL, embedding_model = NULL, embedding_dims = NULL, page_marks = NULL
        FROM jsonb_to_recordset($2::jsonb) AS x(idx int, text text, chars int)
        WHERE c.document_id = $1 AND c.idx = x.idx AND c.text_sha256 = $3
          AND EXISTS (SELECT 1 FROM official_documents WHERE id = $1 AND status = 'indexed' AND text_sha256 = $3)`,
      params: [d.id, JSON.stringify(batch), d.textSha],
    });
    batch = [];
    chars = 0;
  };
  for (const c of changed) {
    if (batch.length && chars + c.chars > RESCRUB_BATCH_CHARS) await flush();
    batch.push(c);
    chars += c.chars;
  }
  await flush();
  // 3. Move the document and its chunks to the scrubbed text version (atomic, only from the version read above).
  const newSha = sha256Hex(texts.join("\n\n"));
  await store.transaction([
    {
      query: `WITH d AS (UPDATE official_documents SET text_sha256 = $3, meta = (meta - 'redacted') || $4::jsonb, updated_at = now()
          WHERE id = $1 AND status = 'indexed' AND text_sha256 = $2 RETURNING id)
        UPDATE official_chunks c SET text_sha256 = $3 FROM d WHERE c.document_id = d.id AND c.text_sha256 = $2 RETURNING c.idx`,
      params: [d.id, d.textSha, newSha, meta(newSha)],
    },
    { query: `UPDATE official_documents d SET embedded = (SELECT count(*) FROM official_chunks c WHERE c.document_id = d.id AND c.embedding IS NOT NULL), updated_at = now() WHERE d.id = ANY($1::text[])`, params: [pgArray([d.id])] },
  ]);
  if (embedModel) await enqueueUnits(store, [{ id: unitId("index", d.id), source: d.source, stage: "index", key: d.url, documentId: d.id, priority: PRIORITY.index }], { requeue: true });
  return { chunks: changed.length, counts };
}
