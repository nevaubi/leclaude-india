import type { RemoteStore, Row, SqlQuery, SqlValue } from "@/lib/db/remote";
import { OFFICIAL_SCHEMA_VERSION } from "@/modules/official/schema";

/**
 * In-memory stand-in for the official-sources tables. It recognises the statements the official-core modules issue
 * (by their leading text) and applies them to plain objects; anything unrecognised is recorded and answered with [].
 * Not a SQL engine: it exists to test the pipeline's control flow, ids, statuses and counts end to end.
 */

export interface FakeUnit { id: string; source: string; stage: string; key: string; document_id: string | null; payload: Record<string, unknown> | null; priority: number; status: string; attempts: number; error: string | null; note: string | null; run_after: number | null; lease_until: number | null; finished_at: number | null }
export interface FakeDoc { id: string; source: string; kind: string; url: string; file_url: string | null; title: string; doc_date: string | null; forum: string | null; status: string; mime: string | null; sha256: string | null; bytes: number | null; pages: number | null; extraction: string | null; ocr_pages: number[]; ocr_model: string | null; language: string | null; meta: Record<string, unknown>; version: number; history: unknown[]; fetch_provenance: unknown; text_sha256: string | null; text_chars: number | null; chunks: number; embedded: number; error: string | null; attempts: number; fetched_at: string | null; indexed_at: string | null; extractor_version: number | null; parse_result: unknown }
export interface FakeChunk { document_id: string; idx: number; text_sha256: string; page_start: number | null; page_end: number | null; heading: string | null; text: string; ocr: boolean; chars: number; embedding: string | null; embedding_model: string | null; embedding_dims: number | null }

const s = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));
const arr = (v: SqlValue | undefined): string[] => String(v ?? "").replace(/^\{|\}$/g, "").split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);

export class OfficialFakeStore implements RemoteStore {
  calls: SqlQuery[] = [];
  state = new Map<string, string>([["official_schema_version", String(OFFICIAL_SCHEMA_VERSION)]]);
  units = new Map<string, FakeUnit>();
  docs = new Map<string, FakeDoc>();
  chunks: FakeChunk[] = [];
  rejects: { source: string; url: string; stage: string; reason: string }[] = [];
  dbBytes = 1_000_000;
  clock = Date.now();
  pgvector = false;
  /** Optional search answers: candidates for a tsquery text (keyword stage). */
  keyword?: (q: string, fn: "websearch" | "words") => { document_id: string; idx: number }[];

  constructor(init: { dbBytes?: number } = {}) {
    if (init.dbBytes != null) this.dbBytes = init.dbBytes;
  }

  private now() { return this.clock; }

  async transaction(qs: SqlQuery[]): Promise<Row[][]> {
    const out: Row[][] = [];
    for (const q of qs) out.push(await this.query(q));
    return out;
  }

  async query(q: SqlQuery): Promise<Row[]> {
    this.calls.push(q);
    const sql = q.query.replace(/\s+/g, " ").trim();
    const p = q.params ?? [];
    // ---- state / schema ----
    if (sql.startsWith("SELECT value FROM corpus_state WHERE key = 'official_schema_version'")) return [{ value: this.state.get("official_schema_version") ?? null }];
    if (sql.startsWith("SELECT value FROM corpus_state WHERE key = $1")) { const v = this.state.get(String(p[0])); return v != null ? [{ value: v }] : []; }
    if (sql.startsWith("SELECT key, value FROM corpus_state WHERE key LIKE")) return [...this.state.entries()].filter(([k]) => k.startsWith("official_discover:")).map(([key, value]) => ({ key, value }));
    if (sql.startsWith("INSERT INTO corpus_state")) { this.state.set(String(p[0]), String(p[1])); return []; }
    if (/^(CREATE|ALTER)\b/.test(sql)) return [];
    if (sql.includes("pg_database_size")) return [{ b: String(this.dbBytes) }];
    if (sql.startsWith("SELECT set_config")) return [{ t: "ok" }];
    if (sql.startsWith("SELECT udt_name FROM information_schema.columns")) return this.pgvector ? [{ udt_name: "halfvec" }] : [];
    if (sql.startsWith("SELECT 1 AS ok FROM pg_available_extensions")) return [];
    // ---- units ----
    if (sql.startsWith("WITH s AS (UPDATE official_units SET status = 'failed'")) return [{ n: "0" }];
    if (sql.startsWith("WITH ins AS ( INSERT INTO official_units (id, source, stage, key, priority, payload)")) return this.scheduleDiscovery(String(p[0]));
    if (sql.startsWith("WITH ins AS ( INSERT INTO official_units (id, source, stage, key, document_id, payload, priority, run_after)")) return this.enqueue(String(p[0]), sql.includes("DO UPDATE"));
    if (sql.startsWith("UPDATE official_units SET status = 'running'")) return this.claim(arr(p[0]), arr(p[1]));
    if (sql.startsWith("UPDATE official_units SET status = 'done'")) { this.patchUnit(String(p[0]), { status: "done", error: null, note: s(p[1]), lease_until: null, finished_at: this.now() }); return []; }
    if (sql.startsWith("UPDATE official_units SET status = 'skipped'")) { this.patchUnit(String(p[0]), { status: "skipped", note: s(p[1]), lease_until: null, finished_at: this.now() }); return []; }
    if (sql.startsWith("UPDATE official_units SET status = $2, error = $3")) {
      const failed = p[1] === "failed";
      const backoff = /interval '(\d+) minutes'/.exec(sql);
      this.patchUnit(String(p[0]), { status: String(p[1]), error: s(p[2]), lease_until: null, run_after: failed ? null : this.now() + Number(backoff?.[1] ?? 0) * 60_000, finished_at: failed ? this.now() : null });
      return [];
    }
    if (sql.startsWith("UPDATE official_units SET status = 'pending', lease_until = NULL, attempts = greatest(attempts - 1, 0)")) {
      const u = this.units.get(String(p[0]));
      if (u) {
        u.status = "pending"; u.lease_until = null; u.attempts = Math.max(0, u.attempts - 1);
        if (sql.includes("payload = $2::jsonb")) { u.payload = p[1] == null ? null : JSON.parse(String(p[1])); u.note = s(p[2]); } else u.note = s(p[1]);
      }
      return [];
    }
    if (sql.startsWith("WITH u AS ( UPDATE official_units SET status = 'pending', attempts = 0")) return this.retryFailed(arr(p[0]), sql);
    if (sql.startsWith("UPDATE official_units SET payload = $2::jsonb")) { const u = this.units.get(String(p[0])); if (u) u.payload = JSON.parse(String(p[1])); return []; }
    if (sql.startsWith("UPDATE official_units SET lease_until")) return [];
    if (sql.startsWith("SELECT status, count(*)::int AS n FROM official_units")) {
      const m = new Map<string, number>();
      for (const u of this.units.values()) m.set(u.status, (m.get(u.status) ?? 0) + 1);
      return [...m.entries()].map(([status, n]) => ({ status, n: String(n) }));
    }
    if (sql.startsWith("SELECT count(*)::int AS n FROM official_units WHERE (status = 'pending'")) {
      const sources = arr(p[0]), stages = arr(p[1]);
      return [{ n: String([...this.units.values()].filter((u) => u.status === "pending" && sources.includes(u.source) && stages.includes(u.stage) && (u.run_after == null || u.run_after <= this.now())).length) }];
    }
    // ---- documents ----
    if (sql.startsWith("WITH x AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text, source text, kind text")) return this.upsertDocs(String(p[0]));
    if (/^SELECT .* FROM official_documents WHERE id = \$1$/.test(sql)) { const d = this.docs.get(String(p[0])); return d ? [this.docRow(d)] : []; }
    if (sql.startsWith("INSERT INTO official_rejects")) { this.rejects.push({ source: String(p[0]), url: String(p[1]), stage: String(p[2]), reason: String(p[3]) }); return []; }
    if (sql.startsWith("UPDATE official_documents SET status = $2, error = $3, pages = coalesce($4, pages)")) { this.patchDoc(String(p[0]), { status: String(p[1]), error: s(p[2]), ...(p[3] != null ? { pages: Number(p[3]) } : {}) }); return []; }
    if (sql.startsWith("UPDATE official_documents SET status = 'fetched'")) {
      const d = this.docs.get(String(p[0]));
      if (d) {
        d.status = "fetched"; d.sha256 = String(p[1]); d.bytes = Number(p[2]);
        if (sql.includes("mime = coalesce($4, mime)")) { if (p[3] != null) d.mime = String(p[3]); d.fetch_provenance = JSON.parse(String(p[4])); d.version += Number(p[5]); d.history.push(...(JSON.parse(String(p[6])) as unknown[])); d.attempts++; }
        else { d.mime = "text/plain"; d.fetch_provenance = JSON.parse(String(p[3])); d.version += Number(p[4]); d.history.push(...(JSON.parse(String(p[5])) as unknown[])); }
        d.fetched_at = new Date(this.now()).toISOString(); d.error = null;
      }
      return [];
    }
    if (sql.startsWith("UPDATE official_documents SET fetched_at = now(), fetch_provenance")) { this.patchDoc(String(p[0]), { fetched_at: new Date(this.now()).toISOString(), fetch_provenance: JSON.parse(String(p[1])) }); return []; }
    if (sql.startsWith("UPDATE official_documents SET status = 'indexed'")) {
      const d = this.docs.get(String(p[0]));
      if (d) Object.assign(d, { status: "indexed", text_sha256: String(p[1]), text_chars: Number(p[2]), chunks: Number(p[3]), embedded: 0, extraction: String(p[4]), pages: p[5] == null ? null : Number(p[5]), ocr_pages: arr(p[6]).map(Number), ocr_model: s(p[7]), language: s(p[8]), indexed_at: new Date(this.now()).toISOString(), error: s(p[9]), extractor_version: Number(p[10]), meta: { ...d.meta, ...(JSON.parse(String(p[11])) as object) } });
      return [];
    }
    if (sql.startsWith("UPDATE official_documents SET chunks = 0, embedded = 0, text_sha256 = NULL")) { this.patchDoc(String(p[0]), { chunks: 0, embedded: 0, text_sha256: null }); return []; }
    if (sql.startsWith("UPDATE official_documents SET parse_result")) { this.patchDoc(String(p[0]), { parse_result: JSON.parse(String(p[1])) }); return []; }
    if (sql.startsWith("UPDATE official_documents d SET embedded")) {
      for (const id of arr(p[0])) { const d = this.docs.get(id); if (d) d.embedded = this.chunks.filter((c) => c.document_id === id && c.embedding).length; }
      return [];
    }
    // ---- chunks ----
    if (sql.startsWith("DELETE FROM official_chunks WHERE document_id = $1")) { this.chunks = this.chunks.filter((c) => c.document_id !== p[0]); return []; }
    if (sql.startsWith("INSERT INTO official_chunks")) {
      for (const r of JSON.parse(String(p[0])) as FakeChunk[]) this.chunks.push({ ...r, embedding: null, embedding_model: null, embedding_dims: null });
      return [];
    }
    if (sql.startsWith("SELECT document_id, idx, text FROM official_chunks WHERE embedding IS NULL")) {
      const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 1000);
      return this.chunks.filter((c) => !c.embedding && (!sql.includes("document_id = $1") || c.document_id === p[0])).sort((a, b) => a.document_id.localeCompare(b.document_id) || a.idx - b.idx).slice(0, limit).map((c) => ({ document_id: c.document_id, idx: String(c.idx), text: c.text }));
    }
    if (sql.startsWith("UPDATE official_chunks c SET embedding = decode(x.e, 'hex')")) {
      for (const r of JSON.parse(String(p[0])) as { document_id: string; idx: number; e: string }[]) {
        const c = this.chunks.find((k) => k.document_id === r.document_id && k.idx === r.idx);
        if (c) { c.embedding = `\\x${r.e}`; c.embedding_model = String(p[1]); c.embedding_dims = 1024; }
      }
      return [];
    }
    if (sql.startsWith("SELECT idx, page_start, text FROM official_chunks WHERE document_id = $1 ORDER BY idx")) return this.chunks.filter((c) => c.document_id === p[0]).sort((a, b) => a.idx - b.idx).map((c) => ({ idx: String(c.idx), page_start: c.page_start == null ? null : String(c.page_start), text: c.text }));
    // ---- search ----
    if (sql.startsWith("WITH q AS (SELECT websearch_to_tsquery") || sql.startsWith("WITH q AS (SELECT to_tsquery")) {
      const fn = sql.startsWith("WITH q AS (SELECT websearch") ? "websearch" : "words";
      const hits = this.keyword ? this.keyword(String(p[0]), fn) : this.naiveKeyword(String(p[0]), fn);
      return hits.map((h, i) => ({ document_id: h.document_id, idx: String(h.idx), r: String(1 / (i + 1)) }));
    }
    if (sql.startsWith("SELECT c.document_id, c.idx, c.embedding FROM official_chunks c JOIN jsonb_to_recordset")) {
      const want = JSON.parse(String(p[0])) as { document_id: string; idx: number }[];
      return this.chunks.filter((c) => c.embedding && c.embedding_model === p[1] && want.some((w) => w.document_id === c.document_id && w.idx === c.idx)).map((c) => ({ document_id: c.document_id, idx: String(c.idx), embedding: c.embedding }));
    }
    if (sql.startsWith("SELECT c.document_id, c.idx, c.page_start, c.page_end, c.heading, c.text, d.source")) {
      const want = JSON.parse(String(p[0])) as { document_id: string; idx: number }[];
      return this.chunks.filter((c) => want.some((w) => w.document_id === c.document_id && w.idx === c.idx)).map((c) => {
        const d = this.docs.get(c.document_id)!;
        return { document_id: c.document_id, idx: String(c.idx), page_start: c.page_start == null ? null : String(c.page_start), page_end: c.page_end == null ? null : String(c.page_end), heading: c.heading, text: c.text, source: d.source, kind: d.kind, title: d.title, url: d.url, doc_date: d.doc_date, extraction: d.extraction };
      });
    }
    if (sql.startsWith("SELECT document_id, idx, page_start, page_end, heading, text FROM official_chunks WHERE document_id = $1 AND idx >= $2")) {
      return this.chunks.filter((c) => c.document_id === p[0] && c.idx >= Number(p[1])).sort((a, b) => a.idx - b.idx).slice(0, 200).map((c) => ({ document_id: c.document_id, idx: String(c.idx), page_start: c.page_start == null ? null : String(c.page_start), page_end: c.page_end == null ? null : String(c.page_end), heading: c.heading, text: c.text }));
    }
    if (sql.startsWith("SELECT idx FROM official_chunks WHERE document_id = $1 AND page_start <= $2")) {
      const pg = Number(p[1]);
      const c = this.chunks.filter((k) => k.document_id === p[0] && k.page_start != null && k.page_start <= pg && (k.page_end ?? k.page_start) >= pg).sort((a, b) => a.idx - b.idx)[0];
      return c ? [{ idx: String(c.idx) }] : [];
    }
    if (sql.startsWith("SELECT idx FROM official_chunks WHERE document_id = $1 AND page_start > $2")) {
      const c = this.chunks.filter((k) => k.document_id === p[0] && k.page_start != null && k.page_start > Number(p[1])).sort((a, b) => a.idx - b.idx)[0];
      return c ? [{ idx: String(c.idx) }] : [];
    }
    return [];
  }

  // ---- helpers ----
  naiveKeyword(q: string, fn: "websearch" | "words"): { document_id: string; idx: number }[] {
    const words = fn === "websearch" ? q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [] : q.split(" | ");
    return this.chunks.filter((c) => {
      const t = `${c.heading ?? ""} ${c.text}`.toLowerCase();
      return fn === "websearch" ? words.every((w) => t.includes(w)) : words.some((w) => t.includes(w));
    }).map((c) => ({ document_id: c.document_id, idx: c.idx }));
  }

  private scheduleDiscovery(json: string): Row[] {
    let n = 0;
    for (const r of JSON.parse(json) as { id: string; source: string; stage: string; key: string; priority: number; payload: { cadenceMinutes: number; force: boolean } }[]) {
      const u = this.units.get(r.id);
      if (!u) { this.units.set(r.id, this.newUnit({ ...r, document_id: null })); n++; continue; }
      if (["done", "failed", "skipped"].includes(u.status) && (r.payload.force || u.finished_at == null || u.finished_at < this.now() - r.payload.cadenceMinutes * 60_000)) {
        Object.assign(u, { status: "pending", attempts: 0, error: null, note: null, lease_until: null, run_after: null, finished_at: null, payload: r.payload });
        n++;
      }
    }
    return [{ n: String(n) }];
  }

  private newUnit(r: { id: string; source: string; stage: string; key: string; document_id: string | null; payload?: Record<string, unknown> | null; priority?: number; run_after?: string | null }): FakeUnit {
    return { id: r.id, source: r.source, stage: r.stage, key: r.key, document_id: r.document_id, payload: r.payload ?? null, priority: r.priority ?? 5, status: "pending", attempts: 0, error: null, note: null, run_after: r.run_after ? Date.parse(r.run_after) : null, lease_until: null, finished_at: null };
  }

  private enqueue(json: string, requeue: boolean): Row[] {
    let n = 0;
    for (const r of JSON.parse(json) as Parameters<OfficialFakeStore["newUnit"]>[0][]) {
      const u = this.units.get(r.id);
      if (!u) { this.units.set(r.id, this.newUnit(r)); n++; continue; }
      if (requeue && ["done", "failed", "skipped"].includes(u.status)) {
        Object.assign(u, { status: "pending", attempts: 0, error: null, note: null, payload: r.payload ?? null, priority: r.priority ?? 5, run_after: null, lease_until: null, finished_at: null });
        n++;
      }
    }
    return [{ n: String(n) }];
  }

  private claim(sources: string[], stages: string[]): Row[] {
    const u = [...this.units.values()]
      .filter((x) => x.status === "pending" && x.attempts < 5 && (x.run_after == null || x.run_after <= this.now()) && sources.includes(x.source) && stages.includes(x.stage))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
    if (!u) return [];
    u.status = "running"; u.attempts++; u.lease_until = this.now() + 6 * 60_000;
    return [{ id: u.id, source: u.source, stage: u.stage, key: u.key, document_id: u.document_id, payload: u.payload ? JSON.stringify(u.payload) : null, priority: String(u.priority), status: u.status, attempts: String(u.attempts), error: u.error }];
  }

  private retryFailed(sources: string[], sql: string): Row[] {
    const cooldown = /interval '(\d+) minutes' AND coalesce\(\(payload->>'redrives'\)::int, 0\) < (\d+)/.exec(sql);
    let n = 0;
    let docs = 0;
    for (const u of this.units.values()) {
      if (u.status !== "failed" || !["fetch", "ocr", "index", "parse"].includes(u.stage) || !sources.includes(u.source)) continue;
      const d = u.document_id ? this.docs.get(u.document_id) : undefined;
      if (d?.error?.startsWith("not published")) continue;
      const redrives = Number(u.payload?.redrives ?? 0);
      if (cooldown) {
        if (u.finished_at == null || u.finished_at >= this.now() - Number(cooldown[1]) * 60_000) continue;
        if (redrives >= Number(cooldown[2])) continue;
        u.payload = { ...(u.payload ?? {}), redrives: redrives + 1 };
      }
      Object.assign(u, { status: "pending", attempts: 0, error: null, run_after: null, lease_until: null, finished_at: null });
      n++;
      if (d && d.status === "failed") { d.status = "discovered"; d.error = null; docs++; }
    }
    return [{ n: String(n), docs: String(docs) }];
  }

  private patchUnit(id: string, patch: Partial<FakeUnit>) { const u = this.units.get(id); if (u) Object.assign(u, patch); }
  private patchDoc(id: string, patch: Partial<FakeDoc>) { const d = this.docs.get(id); if (d) Object.assign(d, patch); }

  private upsertDocs(json: string): Row[] {
    const out: Row[] = [];
    for (const r of JSON.parse(json) as { id: string; source: string; kind: string; url: string; file_url: string | null; title: string; doc_date: string | null; forum: string | null; mime: string | null; meta: Record<string, unknown> }[]) {
      const d = this.docs.get(r.id);
      if (!d) {
        this.docs.set(r.id, { id: r.id, source: r.source, kind: r.kind, url: r.url, file_url: r.file_url, title: r.title, doc_date: r.doc_date, forum: r.forum, status: "discovered", mime: r.mime, sha256: null, bytes: null, pages: null, extraction: null, ocr_pages: [], ocr_model: null, language: null, meta: r.meta ?? {}, version: 1, history: [], fetch_provenance: null, text_sha256: null, text_chars: null, chunks: 0, embedded: 0, error: null, attempts: 0, fetched_at: null, indexed_at: null, extractor_version: null, parse_result: null });
        out.push({ id: r.id, status: "discovered", sha256: null, inserted: "t" });
      } else {
        Object.assign(d, { title: r.title, kind: r.kind, file_url: r.file_url ?? d.file_url, doc_date: r.doc_date ?? d.doc_date, meta: { ...d.meta, ...r.meta } });
        out.push({ id: r.id, status: d.status, sha256: d.sha256, inserted: "f" });
      }
    }
    return out;
  }

  private docRow(d: FakeDoc): Row {
    return {
      id: d.id, source: d.source, kind: d.kind, url: d.url, file_url: d.file_url, title: d.title, doc_date: d.doc_date, forum: d.forum, status: d.status, mime: d.mime, sha256: d.sha256,
      bytes: d.bytes == null ? null : String(d.bytes), pages: d.pages == null ? null : String(d.pages), extraction: d.extraction, ocr_pages: `{${d.ocr_pages.join(",")}}`, ocr_model: d.ocr_model,
      language: d.language, meta: JSON.stringify(d.meta), version: String(d.version), extractor_version: d.extractor_version == null ? null : String(d.extractor_version), text_sha256: d.text_sha256,
      fetched_at: d.fetched_at, indexed_at: d.indexed_at, error: d.error, attempts: String(d.attempts), chunks: String(d.chunks), embedded: String(d.embedded),
    };
  }
}
