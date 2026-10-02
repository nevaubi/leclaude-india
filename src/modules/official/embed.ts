import "server-only";
import { aiConfig } from "@/lib/ai/config";
import { bufferToFloat32, embedTexts, float32ToBuffer } from "@/lib/ai/embeddings";
import { fromBytea, type RemoteStore } from "@/lib/db/remote";
import { getOfficialState, pgArray, setOfficialState } from "./units";

/**
 * Embeddings for official-document chunks.
 *
 * - Vectors are 1,024-dimensional (the embedding role's model asked for `dimensions: 1024`), stored as float32 bytea in
 *   `official_chunks.embedding` with `embedding_model` / `embedding_dims`, and ALSO in a pgvector column `embedding_v`
 *   (halfvec(1024), or vector(1024) where halfvec is unsupported) with an HNSW cosine index when the database offers
 *   the `vector` extension. `ensureVectorSupport` probes once per store and records the outcome in corpus_state
 *   ('official_vector'); status reports 'pgvector' | 'bytea' | 'none'.
 * - A provider that ignores `dimensions` (vector length ≠ 1024) is an error, never silently stored.
 * - Embedding failures leave chunks keyword-searchable: indexing never waits on embeddings.
 */

export const EMBED_DIMS = 1024;
const BATCH = 32;

export interface VectorSupport {
  mode: "pgvector" | "bytea";
  type: "halfvec" | "vector" | null;
  error?: string | null;
}

export type EmbedFn = (texts: string[], opts: { signal?: AbortSignal; query?: boolean }) => Promise<Float32Array[]>;

const probes = new WeakMap<RemoteStore, Promise<VectorSupport>>();

export function resetVectorProbeForTests(store: RemoteStore): void {
  probes.delete(store);
}

async function probe(store: RemoteStore): Promise<VectorSupport> {
  const col = await store.query({ query: `SELECT udt_name FROM information_schema.columns WHERE table_name = 'official_chunks' AND column_name = 'embedding_v'` });
  if (col[0]?.udt_name === "halfvec" || col[0]?.udt_name === "vector") return { mode: "pgvector", type: col[0].udt_name };
  const avail = await store.query({ query: `SELECT 1 AS ok FROM pg_available_extensions WHERE name = 'vector'` });
  if (!avail.length) return { mode: "bytea", type: null, error: "pgvector is not available on this database" };
  try {
    await store.query({ query: `CREATE EXTENSION IF NOT EXISTS vector` });
  } catch (e) {
    return { mode: "bytea", type: null, error: `CREATE EXTENSION vector failed: ${(e as Error).message.slice(0, 200)}` };
  }
  let type: "halfvec" | "vector" = "halfvec";
  try {
    await store.query({ query: `ALTER TABLE official_chunks ADD COLUMN IF NOT EXISTS embedding_v halfvec(${EMBED_DIMS})` });
  } catch {
    type = "vector";
    try {
      await store.query({ query: `ALTER TABLE official_chunks ADD COLUMN IF NOT EXISTS embedding_v vector(${EMBED_DIMS})` });
    } catch (e) {
      return { mode: "bytea", type: null, error: `adding the vector column failed: ${(e as Error).message.slice(0, 200)}` };
    }
  }
  try {
    await store.query({ query: `CREATE INDEX IF NOT EXISTS official_chunks_embedding_v ON official_chunks USING hnsw (embedding_v ${type}_cosine_ops)` });
  } catch (e) {
    // The column works without the index (exact scan); record why.
    return { mode: "pgvector", type, error: `HNSW index not created: ${(e as Error).message.slice(0, 200)}` };
  }
  return { mode: "pgvector", type };
}

/** Probe (and, where possible, enable) pgvector for official chunks; cached per store instance. */
export function ensureVectorSupport(store: RemoteStore): Promise<VectorSupport> {
  let p = probes.get(store);
  if (!p) {
    p = probe(store).then(async (s) => {
      await setOfficialState(store, "official_vector", { ...s, at: new Date().toISOString() }).catch(() => undefined);
      return s;
    }).catch((e: unknown) => ({ mode: "bytea" as const, type: null, error: (e as Error).message.slice(0, 200) }));
    probes.set(store, p);
  }
  return p;
}

/** Recorded vector mode without probing (status pages). */
export async function recordedVectorSupport(store: RemoteStore): Promise<VectorSupport | null> {
  return getOfficialState<VectorSupport>(store, "official_vector");
}

/** The embedding model when an embedding provider is configured; null otherwise (keyword-only corpus). */
export function embeddingModel(): string | null {
  try {
    const cfg = aiConfig();
    return cfg.embeddingProvider ? cfg.embeddingModel : null;
  } catch { return null; }
}

export function defaultEmbed(): EmbedFn {
  return (texts, o) => embedTexts(texts, { dimensions: EMBED_DIMS, signal: o.signal, inputType: o.query ? "query" : "document" });
}

/** pgvector text literal ("[0.1,0.2,…]"), 7 significant digits. */
export function vectorLiteral(v: Float32Array): string {
  let s = "[";
  for (let i = 0; i < v.length; i++) s += (i ? "," : "") + (Number.isFinite(v[i]) ? Number(v[i].toPrecision(7)) : 0);
  return s + "]";
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

export function decodeVector(v: string | null): Float32Array | null {
  const b = fromBytea(v);
  return b && b.byteLength % 4 === 0 && b.byteLength ? bufferToFloat32(b) : null;
}

export interface EmbedRunResult {
  embedded: number;
  failed: number;
  remaining: boolean;
  model: string | null;
  mode: VectorSupport["mode"] | "none";
  error: string | null;
}

/**
 * Embed chunks that have no embedding yet (of one document, or any), at most `maxChunks`. Returns what was done;
 * an embedding error stops this pass and is returned (the chunks stay keyword-searchable).
 */
export async function embedPendingChunks(store: RemoteStore, opts: { documentId?: string | null; maxChunks: number; embed?: EmbedFn; model?: string | null; signal?: AbortSignal; deadline?: number; now?: () => number }): Promise<EmbedRunResult> {
  const model = opts.model === undefined ? embeddingModel() : opts.model;
  const out: EmbedRunResult = { embedded: 0, failed: 0, remaining: false, model, mode: "none", error: null };
  if (!model) return { ...out, error: "embeddings are not configured" };
  const max = Math.max(0, Math.floor(opts.maxChunks));
  if (!max) return { ...out, remaining: true };
  const support = await ensureVectorSupport(store);
  out.mode = support.mode;
  const embed = opts.embed ?? defaultEmbed();
  const now = opts.now ?? Date.now;
  const rows = await store.query({
    query: `SELECT document_id, idx, text FROM official_chunks WHERE embedding IS NULL${opts.documentId ? " AND document_id = $1" : ""} ORDER BY document_id, idx LIMIT ${max + 1}`,
    params: opts.documentId ? [opts.documentId] : [],
  });
  out.remaining = rows.length > max;
  const todo = rows.slice(0, max);
  const docs = new Set<string>();
  for (let i = 0; i < todo.length; i += BATCH) {
    if (opts.deadline != null && now() > opts.deadline - 5_000) { out.remaining = true; break; }
    const batch = todo.slice(i, i + BATCH);
    let vectors: Float32Array[];
    try {
      vectors = await embed(batch.map((r) => String(r.text ?? "").slice(0, 8_000)), { signal: opts.signal });
    } catch (e) {
      out.error = (e as Error).message.slice(0, 300);
      out.failed += batch.length;
      out.remaining = true;
      break;
    }
    if (vectors.length !== batch.length || vectors.some((v) => v.length !== EMBED_DIMS)) {
      out.error = `embedding provider returned ${vectors[0]?.length ?? 0}-dimensional vectors (expected ${EMBED_DIMS}); not stored`;
      out.failed += batch.length;
      out.remaining = true;
      break;
    }
    const recs = batch.map((r, k) => ({ document_id: String(r.document_id), idx: Number(r.idx), e: hex(float32ToBuffer(vectors[k])), ...(support.mode === "pgvector" ? { v: vectorLiteral(vectors[k]) } : {}) }));
    const setV = support.mode === "pgvector" && support.type ? `, embedding_v = x.v::${support.type}` : "";
    await store.query({
      query: `UPDATE official_chunks c SET embedding = decode(x.e, 'hex'), embedding_model = $2, embedding_dims = ${EMBED_DIMS}${setV}
        FROM jsonb_to_recordset($1::jsonb) AS x(document_id text, idx int, e text, v text)
        WHERE c.document_id = x.document_id AND c.idx = x.idx`,
      params: [JSON.stringify(recs), model],
    });
    out.embedded += batch.length;
    for (const r of batch) docs.add(String(r.document_id));
  }
  if (docs.size) {
    await store.query({
      query: `UPDATE official_documents d SET embedded = (SELECT count(*) FROM official_chunks c WHERE c.document_id = d.id AND c.embedding IS NOT NULL), updated_at = now() WHERE d.id = ANY($1::text[])`,
      params: [pgArray([...docs])],
    });
  }
  return out;
}
