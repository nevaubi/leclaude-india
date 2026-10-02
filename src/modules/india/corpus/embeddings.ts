import "server-only";
import { float32ToBuffer } from "@/lib/ai/embeddings";
import { isProviderQuotaError, PROVIDER_QUOTA_RE } from "@/lib/ai/quota";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { defaultEmbed, EMBED_DIMS, embeddingModel, vectorLiteral, type EmbedFn } from "@/modules/official/embed";

/**
 * Embeddings for judgment text chunks (roadmap P3.1, P5.2, P5.3). Contract with the text loaders (SC, HC and the HC text
 * pipeline): docs/architecture/judgment-retrieval.md.
 *
 * Storage (separate from `corpus_texts`, so loaders can upsert or reload text without touching vectors):
 * - `corpus_text_embeddings`: one row per embedded chunk, keyed by `corpus_texts.id`. Same conventions as official-source
 *   embeddings (src/modules/official/embed.ts): 1,024 dimensions, float32 in `embedding` (bytea) plus a pgvector column
 *   `embedding_v` (halfvec(1024), or vector(1024) where halfvec is unsupported) with an HNSW cosine index when the
 *   database offers pgvector; the embedding model id and dimensions are recorded on every row; `text_sha256` is the hash
 *   of the exact chunk text the vector was computed from, and search serves a vector only while it still matches.
 * - `corpus_embed_queue`: one row per judgment text key (Supreme Court neutral citation, or High Court "CNR@date"),
 *   tiered: 0 = requested on first access (a judgment read in research), 1 = Supreme Court, 2 = priority High Courts
 *   (JUDGMENT_EMBED_PRIORITY_COURTS, default Karnataka, Telangana, Andhra Pradesh), 3 = others (queued in bulk only
 *   when JUDGMENT_EMBED_ALL=1; otherwise on first access). Workers claim rows with a lease, in tier order.
 *
 * Embedding failures never block text search: a judgment without vectors stays keyword-searchable and the hybrid search
 * says so in its coverage note.
 */

export const JUDGMENT_EMBED_SCHEMA_VERSION = 1;
const BATCH = 32;
const LEASE_MINUTES = 6;
const MAX_ATTEMPTS = 3;
/** Characters of one chunk sent to the embedding model. */
export const EMBED_CHUNK_CHARS = 8_000;

export const JUDGMENT_EMBED_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS corpus_text_embeddings (
      chunk_id text PRIMARY KEY,
      text_key text NOT NULL,
      court_id text NOT NULL,
      decision_year int,
      chunk_index int NOT NULL,
      text_sha256 text NOT NULL,
      embedding_model text NOT NULL,
      embedding_dims int NOT NULL,
      embedding bytea NOT NULL,
      embedded_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS corpus_text_embeddings_key ON corpus_text_embeddings (text_key)` },
  { query: `CREATE INDEX IF NOT EXISTS corpus_text_embeddings_scope ON corpus_text_embeddings (embedding_model, court_id, decision_year)` },
  {
    query: `CREATE TABLE IF NOT EXISTS corpus_embed_queue (
      text_key text PRIMARY KEY,
      court_id text NOT NULL,
      tier smallint NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempts int NOT NULL DEFAULT 0,
      chunks int,
      embedded int NOT NULL DEFAULT 0,
      model text,
      error text,
      lease_until timestamptz,
      requested_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT corpus_embed_queue_status CHECK (status IN ('pending', 'running', 'done', 'failed'))
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS corpus_embed_queue_claim ON corpus_embed_queue (status, tier, requested_at)` },
];

/** SQL for a corpus_texts row's text key (alias t): the neutral citation, else "CNR@YYYY-MM-DD". */
export const TEXT_KEY_SQL = (t = "t") => `coalesce(${t}.neutral_citation, ${t}.cnr || '@' || ${t}.decision_date::text)`;
/** SQL for the hash of a chunk's text (alias t). */
export const TEXT_SHA_SQL = (t = "t") => `encode(sha256(convert_to(${t}.text, 'UTF8')), 'hex')`;

export interface EmbedSupport { ready: boolean; hc: boolean; vector: "halfvec" | "vector" | null; error?: string }

const probes = new WeakMap<RemoteStore, Promise<EmbedSupport>>();

export function resetJudgmentEmbedProbeForTests(store: RemoteStore): void { probes.delete(store); }

async function probe(store: RemoteStore): Promise<EmbedSupport> {
  const t = await store.query({ query: `SELECT to_regclass('public.corpus_texts') IS NOT NULL AS ok, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'corpus_texts' AND column_name = 'cnr') AS hc` });
  const yes = (v: unknown) => String(v) === "true" || String(v) === "t";
  if (!yes(t[0]?.ok)) return { ready: false, hc: false, vector: null, error: "corpus_texts is not loaded" };
  for (const q of JUDGMENT_EMBED_SCHEMA) await store.query(q);
  const hc = yes(t[0]?.hc);
  const col = await store.query({ query: `SELECT udt_name FROM information_schema.columns WHERE table_name = 'corpus_text_embeddings' AND column_name = 'embedding_v'` });
  if (col[0]?.udt_name === "halfvec" || col[0]?.udt_name === "vector") return { ready: true, hc, vector: col[0].udt_name };
  const avail = await store.query({ query: `SELECT 1 AS ok FROM pg_available_extensions WHERE name = 'vector'` });
  if (!avail.length) return { ready: true, hc, vector: null, error: "pgvector is not available on this database (vectors kept as bytea; semantic search re-ranks keyword candidates only)" };
  try { await store.query({ query: `CREATE EXTENSION IF NOT EXISTS vector` }); } catch (e) { return { ready: true, hc, vector: null, error: `CREATE EXTENSION vector failed: ${(e as Error).message.slice(0, 200)}` }; }
  let type: "halfvec" | "vector" = "halfvec";
  try { await store.query({ query: `ALTER TABLE corpus_text_embeddings ADD COLUMN IF NOT EXISTS embedding_v halfvec(${EMBED_DIMS})` }); } catch {
    type = "vector";
    try { await store.query({ query: `ALTER TABLE corpus_text_embeddings ADD COLUMN IF NOT EXISTS embedding_v vector(${EMBED_DIMS})` }); } catch (e) { return { ready: true, hc, vector: null, error: `adding the vector column failed: ${(e as Error).message.slice(0, 200)}` }; }
  }
  try { await store.query({ query: `CREATE INDEX IF NOT EXISTS corpus_text_embeddings_v ON corpus_text_embeddings USING hnsw (embedding_v ${type}_cosine_ops)` }); } catch (e) {
    return { ready: true, hc, vector: type, error: `HNSW index not created: ${(e as Error).message.slice(0, 200)}` };
  }
  return { ready: true, hc, vector: type };
}

/** Create the embedding tables (idempotent) and probe pgvector; cached per store. Never throws (errors are in the result). */
export function ensureJudgmentEmbedSchema(store: RemoteStore): Promise<EmbedSupport> {
  let p = probes.get(store);
  if (!p) {
    p = probe(store).catch((e: unknown) => ({ ready: false, hc: false, vector: null, error: (e as Error).message.slice(0, 200) }));
    probes.set(store, p);
  }
  return p;
}

/** Registry court ids embedded in bulk after the Supreme Court (tier 2). */
export function priorityCourts(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const raw = (env.JUDGMENT_EMBED_PRIORITY_COURTS ?? "").split(/[\s,]+/).filter((c) => /^hc-[a-z-]+$/.test(c));
  return raw.length ? raw : ["hc-karnataka", "hc-telangana", "hc-andhra"];
}

/** Tier for a court: 1 Supreme Court, 2 priority High Court, 3 other. (0 is "requested on access".) */
export function tierFor(courtId: string, env: Readonly<Record<string, string | undefined>> = process.env): 1 | 2 | 3 {
  return courtId === "sci" ? 1 : priorityCourts(env).includes(courtId) ? 2 : 3;
}

/**
 * Queue one judgment for embedding because it was just read (tier 0: next in line). Idempotent; a judgment already
 * embedded with the current model is not re-queued; a failed one is retried. Best effort: returns false on any error.
 */
export async function requestJudgmentEmbedding(store: RemoteStore, textKey: string, courtId: string): Promise<boolean> {
  if (!textKey || !courtId || textKey.length > 120) return false;
  try {
    const s = await ensureJudgmentEmbedSchema(store);
    if (!s.ready || !embeddingModel()) return false;
    await store.query({
      query: `INSERT INTO corpus_embed_queue (text_key, court_id, tier) VALUES ($1, $2, 0)
        ON CONFLICT (text_key) DO UPDATE SET tier = 0, updated_at = now(),
          status = CASE WHEN corpus_embed_queue.status = 'failed' THEN 'pending' ELSE corpus_embed_queue.status END,
          attempts = CASE WHEN corpus_embed_queue.status = 'failed' THEN 0 ELSE corpus_embed_queue.attempts END`,
      params: [textKey, courtId],
    });
    return true;
  } catch { return false; }
}

/** Queue Supreme Court and priority High Court judgments (newest first) that have text but no queue row. Bounded. */
export async function seedEmbedQueue(store: RemoteStore, o: { limit: number; env?: Readonly<Record<string, string | undefined>> }): Promise<number> {
  const s = await ensureJudgmentEmbedSchema(store);
  if (!s.ready) return 0;
  const env = o.env ?? process.env;
  const limit = Math.max(1, Math.min(Math.floor(o.limit), 5_000));
  const all = /^(1|true|on)$/i.test(env.JUDGMENT_EMBED_ALL ?? "");
  const courts = ["sci", ...priorityCourts(env)];
  const courtExpr = s.hc ? `coalesce(t.court_id, 'sci')` : `'sci'`;
  const dateExpr = s.hc ? `coalesce(extract(year FROM t.decision_date)::int, substr(t.neutral_citation, 1, 4)::int)` : `substr(t.neutral_citation, 1, 4)::int`;
  const keyExpr = s.hc ? TEXT_KEY_SQL("t") : `t.neutral_citation`;
  const scope = all ? ` AND $1::text[] IS NOT NULL` : ` AND ${courtExpr} = ANY($1::text[])`;
  const prio = priorityCourts(env);
  const r = await store.query({
    query: `WITH c AS (
        SELECT DISTINCT ON (${keyExpr}) ${keyExpr} AS text_key, ${courtExpr} AS court_id, ${dateExpr} AS y
        FROM corpus_texts t
        WHERE t.chunk_index = 0 AND ${keyExpr} IS NOT NULL${scope}
          AND NOT EXISTS (SELECT 1 FROM corpus_embed_queue q WHERE q.text_key = ${keyExpr})
        ORDER BY ${keyExpr}
        LIMIT ${limit * 4}
      ), ins AS (
        INSERT INTO corpus_embed_queue (text_key, court_id, tier)
        SELECT text_key, court_id, CASE WHEN court_id = 'sci' THEN 1 WHEN court_id = ANY($2::text[]) THEN 2 ELSE 3 END
        FROM c ORDER BY 3, y DESC NULLS LAST LIMIT ${limit}
        ON CONFLICT (text_key) DO NOTHING RETURNING 1)
      SELECT count(*)::int AS n FROM ins`,
    params: [`{${courts.join(",")}}`, `{${prio.join(",")}}`],
  });
  return Number(r[0]?.n ?? 0);
}

export interface JudgmentEmbedRun {
  model: string | null;
  vector: EmbedSupport["vector"];
  claimed: number;
  judgments: number;
  embedded: number;
  failed: number;
  queued: number;
  remaining: boolean;
  error: string | null;
}

/**
 * Work the embedding queue until `deadline` (epoch ms) or `maxChunks`: seed the bulk tiers, claim judgments in tier
 * order with a lease, embed their chunks that have no vector for the current model (or whose text changed), and record
 * the outcome per judgment. An embedding error stops the pass (rows go back to pending, or failed after 3 attempts).
 */
export async function runJudgmentEmbedding(store: RemoteStore, o: { deadline: number; maxChunks?: number; embed?: EmbedFn; model?: string | null; seed?: number; now?: () => number; signal?: AbortSignal }): Promise<JudgmentEmbedRun> {
  const model = o.model === undefined ? embeddingModel() : o.model;
  const now = o.now ?? Date.now;
  const out: JudgmentEmbedRun = { model, vector: null, claimed: 0, judgments: 0, embedded: 0, failed: 0, queued: 0, remaining: false, error: null };
  if (!model) return { ...out, error: "embeddings are not configured (no embedding provider)" };
  const s = await ensureJudgmentEmbedSchema(store);
  out.vector = s.vector;
  if (!s.ready) return { ...out, error: s.error ?? "judgment text is not loaded" };
  out.queued = await seedEmbedQueue(store, { limit: o.seed ?? 200 });
  // Rows that failed only because the provider had no credit (older runs) are tried again with fresh attempts.
  await store.query({ query: `UPDATE corpus_embed_queue SET status = 'pending', attempts = 0, updated_at = now() WHERE status = 'failed' AND error ~* $1`, params: [PROVIDER_QUOTA_RE.source] }).catch(() => undefined);
  const embed = o.embed ?? defaultEmbed();
  let budget = Math.max(1, Math.floor(o.maxChunks ?? 2_000));
  const keyExpr = s.hc ? TEXT_KEY_SQL("t") : `t.neutral_citation`;
  const courtExpr = s.hc ? `coalesce(t.court_id, 'sci')` : `'sci'`;
  const yearExpr = s.hc ? `coalesce(extract(year FROM t.decision_date)::int, substr(t.neutral_citation, 1, 4)::int)` : `substr(t.neutral_citation, 1, 4)::int`;
  while (budget > 0 && now() < o.deadline - 10_000 && !o.signal?.aborted) {
    const claimed = await store.query({
      query: `UPDATE corpus_embed_queue q SET status = 'running', attempts = q.attempts + 1, lease_until = now() + interval '${LEASE_MINUTES} minutes', updated_at = now()
        WHERE q.text_key IN (SELECT text_key FROM corpus_embed_queue WHERE status = 'pending' OR (status = 'running' AND lease_until < now())
          ORDER BY tier, requested_at, text_key LIMIT 4 FOR UPDATE SKIP LOCKED)
        RETURNING q.text_key, q.court_id, q.attempts`,
    });
    if (!claimed.length) break;
    out.claimed += claimed.length;
    for (const job of claimed) {
      const key = String(job.text_key);
      const cap = Math.max(1, Math.min(400, budget));
      let rows: Row[];
      try {
        rows = await store.query({
          query: `SELECT t.id, t.chunk_index, ${courtExpr} AS court_id, ${yearExpr} AS y, left(t.text, ${EMBED_CHUNK_CHARS}) AS text, ${TEXT_SHA_SQL("t")} AS sha
            FROM corpus_texts t
            WHERE ${keyExpr} = $1
              AND NOT EXISTS (SELECT 1 FROM corpus_text_embeddings e WHERE e.chunk_id = t.id AND e.embedding_model = $2 AND e.text_sha256 = ${TEXT_SHA_SQL("t")})
            ORDER BY t.chunk_index LIMIT ${cap}`,
          params: [key, model],
        });
      } catch (e) {
        out.error = (e as Error).message.slice(0, 300);
        await release(store, key, job.attempts, out.error);
        return { ...out, remaining: true };
      }
      let failedHere: string | null = null;
      for (let i = 0; i < rows.length; i += BATCH) {
        if (now() > o.deadline - 5_000 || o.signal?.aborted) { failedHere = "deadline"; break; }
        const batch = rows.slice(i, i + BATCH);
        let vectors: Float32Array[];
        try { vectors = await embed(batch.map((r) => String(r.text ?? "")), { signal: o.signal }); } catch (e) { failedHere = (e as Error).message.slice(0, 300); break; }
        if (vectors.length !== batch.length || vectors.some((v) => v.length !== EMBED_DIMS)) { failedHere = `embedding provider returned ${vectors[0]?.length ?? 0}-dimensional vectors (expected ${EMBED_DIMS}); not stored`; break; }
        const recs = batch.map((r, k) => ({ chunk_id: String(r.id), text_key: key, court_id: String(r.court_id ?? job.court_id), y: r.y == null ? null : Number(r.y), idx: Number(r.chunk_index), sha: String(r.sha), e: Buffer.from(float32ToBuffer(vectors[k])).toString("hex"), ...(s.vector ? { v: vectorLiteral(vectors[k]) } : {}) }));
        const vCol = s.vector ? `, embedding_v` : "";
        const vVal = s.vector ? `, x.v::${s.vector}` : "";
        const vSet = s.vector ? `, embedding_v = EXCLUDED.embedding_v` : "";
        await store.query({
          query: `INSERT INTO corpus_text_embeddings (chunk_id, text_key, court_id, decision_year, chunk_index, text_sha256, embedding_model, embedding_dims, embedding${vCol})
            SELECT x.chunk_id, x.text_key, x.court_id, x.y, x.idx, x.sha, $2, ${EMBED_DIMS}, decode(x.e, 'hex')${vVal}
            FROM jsonb_to_recordset($1::jsonb) AS x(chunk_id text, text_key text, court_id text, y int, idx int, sha text, e text, v text)
            ON CONFLICT (chunk_id) DO UPDATE SET text_key = EXCLUDED.text_key, court_id = EXCLUDED.court_id, decision_year = EXCLUDED.decision_year, chunk_index = EXCLUDED.chunk_index,
              text_sha256 = EXCLUDED.text_sha256, embedding_model = EXCLUDED.embedding_model, embedding_dims = EXCLUDED.embedding_dims, embedding = EXCLUDED.embedding${vSet}, embedded_at = now()`,
          params: [JSON.stringify(recs), model],
        });
        out.embedded += batch.length;
        budget -= batch.length;
      }
      if (failedHere && failedHere !== "deadline") {
        out.failed++;
        out.error = failedHere;
        await release(store, key, job.attempts, failedHere);
        return { ...out, remaining: true };
      }
      // Out of time, or the chunk cap was reached (more chunks may be left): back to pending without costing an attempt.
      if (failedHere === "deadline" || rows.length >= cap) {
        await release(store, key, Math.max(0, Number(job.attempts) - 1), null);
        out.remaining = true;
        continue;
      }
      await store.query({ query: `UPDATE corpus_embed_queue SET status = 'done', model = $2, embedded = embedded + $3, chunks = (SELECT count(*) FROM corpus_text_embeddings e WHERE e.text_key = $1 AND e.embedding_model = $2), error = NULL, lease_until = NULL, finished_at = now(), updated_at = now() WHERE text_key = $1`, params: [key, model, rows.length] });
      out.judgments++;
    }
  }
  const left = await store.query({ query: `SELECT 1 AS n FROM corpus_embed_queue WHERE status = 'pending' LIMIT 1` });
  out.remaining = out.remaining || left.length > 0;
  return out;
}

async function release(store: RemoteStore, key: string, attempts: unknown, error: string | null): Promise<void> {
  // A provider without credit is not this text's failure: the attempt is given back and the row waits.
  const quota = error != null && isProviderQuotaError(error);
  const n = Math.max(0, (Number(attempts) || 0) - (quota ? 1 : 0));
  const failed = !quota && error != null && n >= MAX_ATTEMPTS;
  await store.query({ query: `UPDATE corpus_embed_queue SET status = $2, error = $3, lease_until = NULL, updated_at = now(), attempts = $4 WHERE text_key = $1`, params: [key, failed ? "failed" : "pending", error, n] }).catch(() => undefined);
}

/** Queue and vector counts for status pages (bounded queries). */
export async function judgmentEmbedStatus(store: RemoteStore): Promise<{ ready: boolean; vector: EmbedSupport["vector"]; model: string | null; byStatus: Record<string, number>; embeddedJudgments: number; error?: string }> {
  const s = await ensureJudgmentEmbedSchema(store);
  const model = embeddingModel();
  if (!s.ready) return { ready: false, vector: null, model, byStatus: {}, embeddedJudgments: 0, error: s.error };
  const q = await store.query({ query: `SELECT status, count(*)::int AS n FROM corpus_embed_queue GROUP BY status` });
  const e = await store.query({ query: `SELECT count(DISTINCT text_key)::int AS n FROM corpus_text_embeddings WHERE embedding_model = $1`, params: [model ?? ""] });
  return { ready: true, vector: s.vector, model, byStatus: Object.fromEntries(q.map((r) => [String(r.status), Number(r.n)])), embeddedJudgments: Number(e[0]?.n ?? 0), error: s.error };
}

/** JUDGMENT_EMBED=1 turns on the scheduled embedding pass (it calls the embedding provider: opt-in, like OFFICIAL_INGEST). */
export function judgmentEmbedEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.JUDGMENT_EMBED ?? "").trim());
}
