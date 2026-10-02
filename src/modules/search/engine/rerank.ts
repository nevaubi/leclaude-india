/**
 * Issue-level reranking of judgment candidates (constitution §15–§17, §36; roadmap P3.1). Client-safe and pure apart
 * from the injected scorer.
 *
 * The scorer is a bounded model call on the fast role (EngineDeps.rerank → generateJSON via the router): it sees the
 * question, the issues (sub-questions) and at most `topN` candidates (title, court, date, a short snippet) and returns a
 * 0–3 relevance per candidate id. Everything around it is deterministic:
 *   - ids the scorer returns are resolved against the candidate set (unknown ids are ignored, never matched by name);
 *   - candidates the scorer did not score keep score null and rank after scored ones in their original order;
 *   - ties break on authority (binding > persuasive > other), bench strength, decision date (newest), then the original
 *     retrieval rank, then id — so the same scores always give the same order;
 *   - a scorer failure, timeout, missing configuration or the RESEARCH_RERANK switch being off returns the original order
 *     with `applied: false` and the reason (fallback, never an error that costs the lane its results).
 *
 * Whether reranking runs at all is a switch (RESEARCH_RERANK, default off): the roadmap requires measured recall@10
 * improvement on the eval set before it is on by default (scripts/evals/india-research-live.ts reports both).
 */
import type { ResearchSource } from "./types";

export interface RerankCandidate { id: string; title: string; court?: string; date?: string; snippet?: string; authority?: string; bench?: number }
export interface RerankScore { id: string; score: number }
export type RerankScorer = (input: { question: string; issues: string[]; candidates: RerankCandidate[]; signal?: AbortSignal }) => Promise<RerankScore[]>;

export interface RerankResult<T> {
  items: T[];
  applied: boolean;
  /** Why the original order was kept (switch off, no scorer, failure, timeout, too few candidates). */
  reason?: string;
  scored: number;
}

export const RERANK_TOP_N = 20;
export const RERANK_TIMEOUT_MS = 8_000;
const SNIPPET_CHARS = 360;

/** RESEARCH_RERANK=on|1|true enables reranking (default off until recall@10 shows a gain). */
export function rerankEnabled(env: Readonly<Record<string, string | undefined>> = typeof process !== "undefined" ? process.env : {}): boolean {
  return /^(1|on|true|yes)$/i.test((env.RESEARCH_RERANK ?? "").trim());
}

const AUTH_RANK: Record<string, number> = { binding: 2, persuasive: 1 };

/** Deterministic order of scored items: score desc, authority, bench, date (newest), original rank, id. */
export function rerankOrder<T>(items: { item: T; id: string; score: number | null; authority?: string; bench?: number; date?: string; rank: number }[]): T[] {
  return [...items].sort((a, b) =>
    (b.score ?? -1) - (a.score ?? -1)
    || (AUTH_RANK[b.authority ?? ""] ?? 0) - (AUTH_RANK[a.authority ?? ""] ?? 0)
    || (b.bench ?? 0) - (a.bench ?? 0)
    || (b.date ?? "").localeCompare(a.date ?? "")
    || a.rank - b.rank
    || a.id.localeCompare(b.id),
  ).map((x) => x.item);
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("rerank timeout"), { code: "timeout" })), ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); resolve(v); }, (e) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); reject(e); });
  });
}

/**
 * Rerank research sources by issue relevance. Only the first `topN` are sent to the scorer; the rest keep their order
 * after them. Never throws for scorer problems (abort is rethrown so cancellation stays cancellation).
 */
export async function rerankSources(sources: ResearchSource[], o: { question: string; issues?: string[]; scorer?: RerankScorer | null; enabled?: boolean; topN?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<RerankResult<ResearchSource>> {
  const keep = (reason: string): RerankResult<ResearchSource> => ({ items: sources, applied: false, reason, scored: 0 });
  if (o.enabled === false) return keep("reranking is off (RESEARCH_RERANK)");
  if (!o.scorer) return keep("no reranking model is configured");
  const topN = Math.max(2, Math.min(o.topN ?? RERANK_TOP_N, 40));
  const head = sources.slice(0, topN);
  const tail = sources.slice(topN);
  if (head.length < 3) return keep("too few candidates to rerank");
  const candidates: RerankCandidate[] = head.map((s) => ({ id: s.id, title: s.title, court: s.court ?? s.hit.court, date: s.date, snippet: (s.snippet ?? "").slice(0, SNIPPET_CHARS), authority: s.authority, bench: s.hit.india?.benchStrength }));
  let scores: RerankScore[];
  try {
    scores = await withTimeout(o.scorer({ question: o.question, issues: (o.issues ?? []).slice(0, 6), candidates, signal: o.signal }), o.timeoutMs ?? RERANK_TIMEOUT_MS, o.signal);
  } catch (e) {
    if ((e as Error).name === "AbortError" && o.signal?.aborted) throw e;
    return keep(`reranker unavailable (${(e as Error).message || "error"}); retrieval order kept`);
  }
  const ids = new Set(head.map((s) => s.id));
  const byId = new Map<string, number>();
  for (const s of Array.isArray(scores) ? scores : []) {
    if (!s || typeof s.id !== "string" || !ids.has(s.id) || byId.has(s.id)) continue; // unknown ids never bind to a candidate
    const n = Number(s.score);
    if (Number.isFinite(n)) byId.set(s.id, Math.max(0, Math.min(3, n)));
  }
  if (!byId.size) return keep("reranker returned no usable scores; retrieval order kept");
  const ordered = rerankOrder(head.map((s, i) => ({ item: s, id: s.id, score: byId.get(s.id) ?? null, authority: s.authority, bench: s.hit.india?.benchStrength, date: s.date, rank: i })));
  return { items: [...ordered, ...tail], applied: true, scored: byId.size };
}
