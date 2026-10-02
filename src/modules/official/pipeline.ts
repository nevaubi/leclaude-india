import "server-only";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import type { ParseInput, SourceAdapter } from "./adapter";
import { chunkMarkdown, sha256Hex, type ChunkDraft } from "./chunk";
import { embedPendingChunks, type EmbedFn } from "./embed";
import { EXTRACTOR_VERSION, extractDocument, extractFirecrawlMarkdown, extractHtml, extractPdf, extractProvidedText, pageMarkdown, type ExtractedDocument, type PageText } from "./extract";
import { fallbackWorthy, isNotPublished, isTooLarge, makeAdapterContext, maxFileBytes, type OfficialHttp } from "./http";
import { ocrDocument, ocrMaxPages, type OcrModel } from "./ocr";
import { allowHostsFor, officialAdapter, sourceDef } from "./registry";
import type { DiscoveredDoc, FetchProvenance, SourceDef, SourceId } from "./types";
import { isSourceId } from "./types";
import { completeUnit, enqueueUnits, failUnit, getOfficialState, releaseUnit, setOfficialState, skipUnit, unitId, MAX_ATTEMPTS, type OfficialUnit, type UnitInput } from "./units";
import { hostMatches } from "@/lib/net/safe-fetch";

/**
 * Stage processors of the official-sources pipeline. Each takes one claimed unit and finishes it (done / retry /
 * failed / skipped / released at the deadline); none throws for a document-level problem.
 *
 *   discover  adapter.discover(ctx) with the stored cursor → upsert official_documents (id = od_ + sha256(source|url))
 *             → enqueue fetch units (or extract units when the listing supplied the text)
 *   fetch     download (direct, legacy TLS; Firecrawl PDF parse for firecrawl_in sources when the direct fetch fails)
 *             → sha256 (unchanged bytes and extractor → nothing to do; changed → version + 1, previous hash in history)
 *             → extract (text layer / HTML / dataset) → pages needing OCR → `ocr` unit; otherwise chunk + store
 *             (status indexed, keyword-searchable) → `index` unit (embeddings) → adapter.parse + persist
 *   extract   text supplied by the listing (dataset) → chunk + store
 *   ocr       re-read the bytes (same sha256 or the unit is stale) → OCR the unreadable pages → chunk + store
 *   index     embed the document's chunks (bounded per run); failures leave the keyword index intact
 *   parse     re-run adapter.parse + persist for a document (after a parse failure)
 *
 * Raw bytes are not stored: the official URL, SHA-256 and fetch provenance are; the text of record is the chunks.
 */

export type StageCounts = { discovered: number; fetched: number; extracted: number; ocr: number; indexed: number; failed: number; skipped: number };

export interface UnitOutcome {
  status: "done" | "retry" | "failed" | "skipped" | "released";
  counts: Partial<StageCounts>;
  error?: { url: string; error: string };
  note?: string;
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
  signal?: AbortSignal;
  log: (event: string, data: Record<string, unknown>) => void;
}

export const PRIORITY = { discover: 0, fetchUrgent: 10, fetch: 20, extract: 20, parse: 25, ocr: 30, index: 40 } as const;
const URGENT_KINDS = new Set(["cause_list", "defect_list"]);
const INSERT_MAX_CHARS = 1_500_000;
const INSERT_MAX_ROWS = 1_000;

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

const DOC_ROW = `id, source, kind, url, file_url, title, doc_date::text AS doc_date, forum, status, mime, sha256, version, extractor_version, text_sha256, meta, fetched_at, attempts, extraction`;

interface DocRow {
  id: string; source: SourceId; kind: string; url: string; fileUrl: string | null; title: string; docDate: string | null; status: string;
  mime: string | null; sha256: string | null; version: number; extractorVersion: number | null; meta: Record<string, unknown>; fetchedAt: string | null; extraction: string | null;
}

function toDocRow(r: Row): DocRow {
  let meta: Record<string, unknown> = {};
  try { meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
  return {
    id: String(r.id), source: String(r.source) as SourceId, kind: String(r.kind), url: String(r.url), fileUrl: r.file_url ?? null, title: String(r.title ?? ""),
    docDate: r.doc_date ? String(r.doc_date).slice(0, 10) : null, status: String(r.status), mime: r.mime ?? null, sha256: r.sha256 ?? null,
    version: Number(r.version ?? 1), extractorVersion: r.extractor_version == null ? null : Number(r.extractor_version), meta, fetchedAt: r.fetched_at ?? null, extraction: r.extraction ?? null,
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

/**
 * The text of an earlier version is not the current official copy: when the new bytes cannot be indexed (OCR pending,
 * unreadable), the old chunks are removed rather than left searchable as if current.
 */
async function dropChunks(store: RemoteStore, id: string): Promise<void> {
  await store.transaction([
    { query: `DELETE FROM official_chunks WHERE document_id = $1`, params: [id] },
    { query: `UPDATE official_documents SET chunks = 0, embedded = 0, text_sha256 = NULL, updated_at = now() WHERE id = $1`, params: [id] },
  ]);
}

const clean = (s: string) => s.replace(/\u0000/g, "");

/** Replace a document's chunks and mark it indexed (atomic when the text fits one request). */
async function storeChunks(store: RemoteStore, docId: string, chunks: ChunkDraft[], ocrPages: Set<number>, textSha: string, final: SqlQuery): Promise<void> {
  const rows = chunks.map((c) => {
    let ocr = false;
    if (c.pageStart != null) for (let p = c.pageStart; p <= (c.pageEnd ?? c.pageStart); p++) if (ocrPages.has(p)) { ocr = true; break; }
    const text = clean(c.text);
    return { document_id: docId, idx: c.index, text_sha256: textSha, page_start: c.pageStart, page_end: c.pageEnd, heading: c.heading ? clean(c.heading) : null, text, ocr, chars: text.length };
  });
  const inserts: SqlQuery[] = [];
  let batch: typeof rows = [];
  let chars = 0;
  const push = () => {
    if (!batch.length) return;
    inserts.push({
      query: `INSERT INTO official_chunks (document_id, idx, text_sha256, page_start, page_end, heading, text, ocr, chars)
        SELECT document_id, idx, text_sha256, page_start, page_end, heading, text, ocr, chars
        FROM jsonb_to_recordset($1::jsonb) AS x(document_id text, idx int, text_sha256 text, page_start int, page_end int, heading text, text text, ocr boolean, chars int)`,
      params: [JSON.stringify(batch)],
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
  const del: SqlQuery = { query: `DELETE FROM official_chunks WHERE document_id = $1`, params: [docId] };
  if (inserts.length <= 2) {
    await store.transaction([del, ...inserts, final]);
    return;
  }
  // Very long documents: one request per batch (request size limits); the document is marked indexed last.
  await store.query(del);
  for (const q of inserts) await store.query(q);
  await store.query(final);
}

// ---------------------------------------------------------------------------
// Index (chunk + store) and parse
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
}

async function indexDocument(deps: PipelineDeps, x: IndexInput): Promise<UnitOutcome> {
  const { store } = deps;
  const markdown = pageMarkdown(x.pages, x.extracted.paged);
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
  const meta: Record<string, unknown> = {};
  if (x.failedOcrPages?.length) meta.ocrFailedPages = x.failedOcrPages;
  if (x.extracted.truncated) meta.textTruncated = true;
  const final: SqlQuery = {
    query: `UPDATE official_documents SET status = 'indexed', text_sha256 = $2, text_chars = $3, chunks = $4, embedded = 0, extraction = $5, pages = $6,
      ocr_pages = $7::int[], ocr_model = $8, language = $9, indexed_at = now(), error = $10, extractor_version = $11, meta = meta || $12::jsonb, updated_at = now() WHERE id = $1`,
    params: [x.doc.id, textSha, markdown.length, chunks.length, method, x.extracted.pageCount, `{${x.ocrPages.join(",")}}`, x.ocrModel, x.extracted.language, note, EXTRACTOR_VERSION, JSON.stringify(meta)],
  };
  await storeChunks(store, x.doc.id, chunks, new Set(x.ocrPages), textSha, final);
  const units: UnitInput[] = [];
  if (deps.embedModel) units.push({ id: unitId("index", x.doc.id), source: x.doc.source, stage: "index", key: x.doc.url, documentId: x.doc.id, priority: PRIORITY.index });
  if (units.length) await enqueueUnits(store, units, { requeue: true });
  const out: UnitOutcome = { status: "done", counts: { indexed: 1 } };
  if (x.adapter?.parse) {
    const input: ParseInput = { id: x.doc.id, url: x.doc.url, title: x.doc.title, docDate: x.doc.docDate, meta: x.doc.meta, markdown, pages: x.pages, items: x.extracted.items.length ? x.extracted.items : undefined, fetchedAt: new Date(deps.now()).toISOString() };
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
  const r = await indexDocument(deps, { doc, def, adapter, extracted, pages: extracted.pages, ocrPages: [], ocrModel: null });
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
  const next = res.done ? null : res.nextCursor ?? null;
  const stuck = next != null && next === cursor; // a cursor that does not move would loop forever
  await setOfficialState(store, cursorKey, stuck ? null : next);
  await setOfficialState(store, `official_discover:${def.id}`, { at: new Date(deps.now()).toISOString(), found: items.length, inserted, rejected, done: res.done || stuck, notes: (res.notes ?? []).slice(0, 10) });
  if (next && !stuck) {
    // More to list: the unit goes straight back to the queue for the next worker / run.
    await releaseUnit(store, unit.id, null, `continues at cursor ${next.slice(0, 80)}`);
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
      text_sha: d.text ? sha256Hex(d.text) : null, refetch: meta.refetch === true,
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
        RETURNING id, status, sha256, (xmax = 0) AS inserted)
      SELECT id, status, sha256, inserted FROM up`,
    params: [JSON.stringify(recs.map((r) => ({ id: r.id, source: r.source, kind: r.kind, url: r.url, file_url: r.file_url, title: r.title, doc_date: r.doc_date, forum: r.forum, mime: r.mime, meta: r.meta })))],
  });
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const fresh: UnitInput[] = [];
  const again: UnitInput[] = [];
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
    else if (rec.refetch || (text && rec.text_sha && rec.text_sha !== r.sha256)) again.push(unit);
  });
  if (fresh.length) await enqueueUnits(store, fresh);
  if (again.length) await enqueueUnits(store, again, { requeue: true });
  return inserted;
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
  let sha: string;
  let provenance: FetchProvenance & { hashOf?: string };
  let extracted: ExtractedDocument;
  let byteCount: number;
  let mime: string | null;
  let bytes: Uint8Array | null = null;
  try {
    const f = await http.fetchFile(target, { maxBytes: maxFileBytes() });
    bytes = f.bytes;
    sha = sha256Hex(f.bytes);
    provenance = f.provenance;
    byteCount = f.bytes.byteLength;
    mime = f.mime;
    if (sha === doc.sha256 && doc.extractorVersion === EXTRACTOR_VERSION && (doc.status === "indexed" || doc.status === "ocr_needed")) {
      await store.query({ query: `UPDATE official_documents SET fetched_at = now(), fetch_provenance = $2::jsonb, updated_at = now() WHERE id = $1`, params: [doc.id, JSON.stringify(provenance)] });
      await completeUnit(store, unit.id, "unchanged");
      return { status: "done", counts: { fetched: 1, skipped: 1 }, note: "unchanged" };
    }
    extracted = await extractDocument({ bytes: f.bytes, mime: f.mime, url: target, finalUrl: f.finalUrl });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    if (isNotPublished(e)) {
      await setDocStatus(store, doc.id, "failed", `not published at this URL (HTTP ${(e as { status?: number }).status ?? 404})`);
      await insertReject(store, doc.source, target, "fetch", msg);
      await failUnit(store, unit, msg, { permanent: true });
      return { status: "failed", counts: { failed: 1 }, error: { url: target, error: msg } };
    }
    if (isTooLarge(e)) {
      await setDocStatus(store, doc.id, "excluded", `file larger than the ${Math.round(maxFileBytes() / 1048576)} MB limit (OFFICIAL_MAX_FILE_MB)`);
      await insertReject(store, doc.source, target, "fetch", msg);
      await skipUnit(store, unit.id, "too large");
      return { status: "skipped", counts: { skipped: 1 }, error: { url: target, error: msg } };
    }
    // Firecrawl (location IN) for firecrawl_in sources when the direct fetch failed for a reason another route may fix.
    const fc = http.firecrawlAllowed && fallbackWorthy(e) ? await firecrawlFallback(http, target, doc).catch(() => null) : null;
    if (!fc) {
      const final = (await failUnit(store, unit, msg)) === "failed";
      if (final) { await setDocStatus(store, doc.id, "failed", msg); await insertReject(store, doc.source, target, "fetch", msg); }
      return { status: final ? "failed" : "retry", counts: final ? { failed: 1 } : {}, error: { url: target, error: msg } };
    }
    sha = sha256Hex(fc.text);
    provenance = { ...fc.provenance, hashOf: fc.hashOf };
    byteCount = fc.text.length;
    mime = fc.mime;
    extracted = fc.extracted;
    if (sha === doc.sha256 && doc.extractorVersion === EXTRACTOR_VERSION && doc.status === "indexed") {
      await completeUnit(store, unit.id, "unchanged");
      return { status: "done", counts: { fetched: 1, skipped: 1 }, note: "unchanged" };
    }
  }
  const changed = Boolean(doc.sha256 && doc.sha256 !== sha);
  const history = changed ? [{ version: doc.version, sha256: doc.sha256, fetchedAt: doc.fetchedAt }] : [];
  await store.query({
    query: `UPDATE official_documents SET status = 'fetched', sha256 = $2, bytes = $3, mime = coalesce($4, mime), fetch_provenance = $5::jsonb, fetched_at = now(),
      version = version + $6, history = history || $7::jsonb, attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = $1`,
    params: [doc.id, sha, byteCount, mime, JSON.stringify(provenance), changed ? 1 : 0, JSON.stringify(history)],
  });
  if (bytes && extracted.kind === "pdf") deps.bytes.set(doc.id, sha, bytes);
  const out = await afterExtraction(deps, { ...doc, sha256: sha, version: doc.version + (changed ? 1 : 0) }, def, adapter, extracted, sha, { fetched: 1 });
  await finishUnit(store, unit, out);
  return out;
}

const looksPdf = (url: string, mime: string | null) => /pdf/i.test(mime ?? "") || /\.pdf($|[?#])/i.test(url);

/** Firecrawl copy of a document: PDF → its markdown parse (page-less); page → raw HTML → markdown. Null when empty. */
async function firecrawlFallback(http: OfficialHttp, target: string, doc: DocRow): Promise<{ text: string; extracted: ExtractedDocument; provenance: FetchProvenance; hashOf: string; mime: string } | null> {
  if (looksPdf(target, doc.mime)) {
    const r = await http.firecrawlDocument(target, { maxPages: firecrawlMaxPages() });
    if (!r || !r.markdown.trim()) return null;
    return { text: r.markdown, extracted: extractFirecrawlMarkdown(r.markdown, r.numPages), provenance: r.provenance, hashOf: "firecrawl_markdown", mime: "text/markdown" };
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
  if (sha === doc.sha256 && doc.extractorVersion === EXTRACTOR_VERSION && doc.status === "indexed") { await completeUnit(store, unit.id, "unchanged"); return { status: "done", counts: { skipped: 1 } }; }
  const changed = Boolean(doc.sha256 && doc.sha256 !== sha);
  const provenance: FetchProvenance & { hashOf: string } = { via: "direct", proxy: null, timezone: null, status: 200, finalUrl: doc.url, hashOf: "listing_text" };
  await store.query({
    query: `UPDATE official_documents SET status = 'fetched', sha256 = $2, bytes = $3, mime = 'text/plain', fetch_provenance = $4::jsonb, fetched_at = now(),
      version = version + $5, history = history || $6::jsonb, error = NULL, updated_at = now() WHERE id = $1`,
    params: [doc.id, sha, text.length, JSON.stringify(provenance), changed ? 1 : 0, JSON.stringify(changed ? [{ version: doc.version, sha256: doc.sha256, fetchedAt: doc.fetchedAt }] : [])],
  });
  const out = await afterExtraction(deps, doc, def, adapter, extractProvidedText(text), sha, {});
  await finishUnit(store, unit, out);
  return out;
}

/** Bytes for a document at a known hash: cache, else a fresh direct download that must match. */
async function bytesFor(deps: PipelineDeps, doc: DocRow, def: SourceDef, sha: string): Promise<Uint8Array | "changed"> {
  const cached = deps.bytes.get(doc.id, sha);
  if (cached) return cached;
  const f = await deps.http(def).fetchFile(doc.fileUrl ?? doc.url, { maxBytes: maxFileBytes() });
  if (sha256Hex(f.bytes) !== sha) return "changed";
  deps.bytes.set(doc.id, sha, f.bytes);
  return f.bytes;
}

async function processOcr(unit: OfficialUnit, deps: PipelineDeps): Promise<UnitOutcome> {
  const { store } = deps;
  const doc = await loadDoc(store, unit.documentId);
  const sha = typeof unit.payload?.sha256 === "string" ? unit.payload.sha256 : null;
  const pages = Array.isArray(unit.payload?.pages) ? (unit.payload!.pages as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!doc || !sha || !pages.length) { await skipUnit(store, unit.id, "nothing to OCR"); return { status: "skipped", counts: { skipped: 1 } }; }
  if (doc.sha256 !== sha) { await skipUnit(store, unit.id, "document changed since the OCR was queued (a new fetch supersedes it)"); return { status: "skipped", counts: { skipped: 1 } }; }
  const def = sourceDef(doc.source);
  const adapter = officialAdapter(doc.source);
  if (!def || !def.enabled || !adapter) { await releaseUnit(store, unit.id, undefined, "source disabled"); return { status: "released", counts: {} }; }
  const target = doc.fileUrl ?? doc.url;
  try {
    const bytes = await bytesFor(deps, doc, def, sha);
    if (bytes === "changed") {
      await enqueueUnits(store, [{ id: unitId("fetch", doc.id), source: doc.source, stage: "fetch", key: doc.url, documentId: doc.id, priority: PRIORITY.fetch }], { requeue: true });
      await skipUnit(store, unit.id, "published file changed; re-fetch queued");
      return { status: "skipped", counts: { skipped: 1 } };
    }
    const extracted = await extractPdf(bytes);
    const done = (unit.payload?.done && typeof unit.payload.done === "object" ? unit.payload.done : {}) as Record<string, string>;
    const ocr = await ocrDocument(bytes, pages, { model: deps.ocrModel(), done, deadline: deps.deadline, now: deps.now, signal: deps.signal, maxPages: deps.maxOcrPages, concurrency: deps.ocrConcurrency });
    if (ocr.capped) {
      await setDocStatus(store, doc.id, "ocr_needed", `${pages.length} page(s) need OCR, above the OCR cap (OFFICIAL_OCR_MAX_PAGES); not indexed`);
      await completeUnit(store, unit.id, "ocr above cap");
      return { status: "done", counts: {} };
    }
    const merged: Record<string, string> = { ...done };
    for (const p of ocr.pages) merged[String(p.page)] = p.text;
    if (!ocr.complete) {
      await releaseUnit(store, unit.id, { ...unit.payload, done: merged }, `${Object.keys(merged).length} of ${pages.length} page(s) transcribed; resumes`);
      return { status: "released", counts: {} };
    }
    const failedPages = ocr.failed.map((f) => f.page);
    if (failedPages.length && unit.attempts < MAX_ATTEMPTS) {
      await store.query({ query: `UPDATE official_units SET payload = $2::jsonb WHERE id = $1`, params: [unit.id, JSON.stringify({ ...unit.payload, done: merged })] });
      const msg = `OCR failed for page(s) ${failedPages.join(", ")}: ${ocr.failed[0].error}`;
      await failUnit(store, unit, msg);
      return { status: "retry", counts: {}, error: { url: target, error: msg } };
    }
    const ocrSet = new Set(Object.keys(merged).map(Number));
    const finalPages = extracted.pages.map((p) => (ocrSet.has(p.page) ? { page: p.page, text: merged[String(p.page)] ?? "" } : p));
    const r = await indexDocument(deps, { doc, def, adapter, extracted, pages: finalPages, ocrPages: [...ocrSet].sort((a, b) => a - b), ocrModel: ocr.model || (unit.payload?.model as string | undefined) || null, failedOcrPages: failedPages });
    const out: UnitOutcome = { ...r, counts: sumCounts(r.counts, { ocr: 1 }) };
    await finishUnit(store, unit, out);
    return out;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    const final = (await failUnit(store, unit, msg, { permanent: isNotPublished(e) })) === "failed";
    if (final) await setDocStatus(store, doc.id, "ocr_needed", `OCR could not complete: ${msg}`);
    return { status: final ? "failed" : "retry", counts: final ? { failed: 1 } : {}, error: { url: target, error: msg } };
  }
}

async function processIndex(unit: OfficialUnit, deps: PipelineDeps): Promise<UnitOutcome> {
  const { store } = deps;
  if (!deps.embedModel) { await skipUnit(store, unit.id, "embeddings are not configured (keyword search only)"); return { status: "skipped", counts: {} }; }
  if (deps.embedBudget.left <= 0) { await releaseUnit(store, unit.id, undefined, "embedding budget for this run used"); return { status: "released", counts: {} }; }
  const r = await embedPendingChunks(store, { documentId: unit.documentId, maxChunks: Math.min(deps.embedBudget.left, 2_000), embed: deps.embed, model: deps.embedModel, signal: deps.signal, deadline: deps.deadline, now: deps.now });
  deps.embedBudget.left -= r.embedded;
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
      pages = ex.pages;
      items = ex.items;
      markdown = pageMarkdown(pages, true);
    } else {
      // Text of record from the stored chunks (no overlap, so the join is the document text).
      const rows = await store.query({ query: `SELECT idx, page_start, text FROM official_chunks WHERE document_id = $1 ORDER BY idx`, params: [doc.id] });
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
    const msg = (e as Error).message.slice(0, 500);
    const final = (await failUnit(deps.store, unit, msg)) === "failed";
    if (final && unit.documentId && unit.stage !== "index" && unit.stage !== "parse") await setDocStatus(deps.store, unit.documentId, "failed", msg).catch(() => undefined);
    return { status: final ? "failed" : "retry", counts: final ? { failed: 1 } : {}, error: { url: unit.key, error: msg } };
  }
}
