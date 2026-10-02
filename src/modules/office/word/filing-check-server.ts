import "server-only";
import { createHash } from "node:crypto";
import { aiConfig } from "@/lib/ai/config";
import { remoteStore, type RemoteStore } from "@/lib/db/remote";
import { listProvenance } from "@/lib/integrity/store";
import { citatorFor } from "@/modules/india/citator/read";
import { cleanJudgmentText, readJudgmentText, type JudgmentText } from "@/modules/india/corpus/text";
import { checkCitations } from "@/modules/search/service";
import type { PMNode } from "./doc-model";
import { filingText, runFilingCheck, textBlocks, type FilingCheckDeps, type FilingCheckReport } from "./filing-check";
import { checkStateOf, type CheckState, type ProvenanceSourceItem } from "./provenance";

/**
 * Server wiring for the Word filing check: the India citation check (judgment store), exact Supreme Court neutral
 * citation lookup in the official corpus (text for quote checks), and citator negative text cues. Results are cached
 * per document-body hash for a few minutes so the export can reuse the check the gate just ran.
 */

/** SHA-256 of the checked body text (tracked deletions excluded, one block per line). */
export function docBodyHash(doc: PMNode): string {
  return createHash("sha256").update(filingText(doc)).digest("hex");
}

const JUDGMENT_TEXT_MAX = 400_000;
/** Rows readJudgmentText reads per call (its LIMIT): a read that returned this many chunks may have stopped there. */
const CORPUS_ROWS_PER_READ = 400;

/**
 * The judgment text a quotation is compared with, and whether it is the WHOLE judgment. Chunk texts are joined without
 * the reader's "[p. N]" page markers, so a quotation running across a page break still matches. `complete` holds only
 * when the chunks run from the first (index 0) to the last one the corpus records (total_chunks) with no gap and nothing
 * left unread (nextChunk null). A quotation is reported "not found" only against complete text; otherwise it is
 * "text_incomplete" (not checked), never "not found".
 */
export function judgmentTextForQuotes(t: Pick<JudgmentText, "chunks" | "nextChunk" | "totalChunks">): { text: string | null; complete: boolean } {
  const chunks = t.chunks;
  if (!chunks.length) return { text: null, complete: false };
  const text = chunks.map((c) => cleanJudgmentText(c.text)).join("\n");
  const contiguous = chunks.every((c, i) => c.index === (i === 0 ? 0 : chunks[i - 1].index + 1));
  const last = chunks[chunks.length - 1].index;
  const complete = t.nextChunk == null && contiguous && (!(t.totalChunks > 0) || last + 1 >= t.totalChunks);
  return { text: text.trim() ? text : null, complete };
}

/** `store`: injectable for tests (default: the configured remote store, resolved per call). */
export function serverFilingDeps(opts: { store?: RemoteStore | null } = {}): FilingCheckDeps {
  return {
    citecheck: (text, signal) => checkCitations(text.slice(0, 120_000), signal),
    corpusJudgment: async (citation) => {
      const store = "store" in opts ? opts.store ?? null : remoteStore();
      if (!store) return "unavailable";
      try {
        const t = await readJudgmentText(citation, { maxChars: JUDGMENT_TEXT_MAX }, store);
        if (!t || !t.judgmentId) return null;
        const r = judgmentTextForQuotes(t);
        let complete = r.complete;
        // The read may have stopped at its row limit with nothing to say so: read on from the last chunk to confirm.
        if (complete && t.chunks.length >= CORPUS_ROWS_PER_READ) {
          const more = await readJudgmentText(citation, { fromChunk: t.chunks[t.chunks.length - 1].index + 1, maxChars: 2000 }, store);
          if (!more || more.chunks.length > 0) complete = false;
        }
        return { id: t.judgmentId, title: t.title, text: r.text, complete: complete && r.text != null };
      } catch {
        return "unavailable";
      }
    },
    citator: async (id) => {
      if (!/^(sc|hc):\S{1,390}$/.test(id)) return null;
      try {
        const r = await citatorFor(id);
        if (!r) return null;
        return {
          status: r.status,
          negative: r.negative.map((n) => ({ title: n.title ?? n.citation ?? "Citing judgment", court: n.court, decided: n.decisionDate, cue: n.cue, context: n.context ? n.context.slice(0, 400) : null })),
        };
      } catch {
        return "unavailable";
      }
    },
  };
}

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; report: FilingCheckReport }>();

export function resetFilingCacheForTests() { cache.clear(); }

/** Run (or reuse a complete check of) the filing check for a document body. `deps` is injectable for tests. */
export async function filingCheckFor(doc: PMNode, opts: { deps?: FilingCheckDeps; signal?: AbortSignal; fresh?: boolean } = {}): Promise<FilingCheckReport> {
  const hash = docBodyHash(doc);
  // The cache key covers block ids too: two documents with the same text keep their own "show in document" targets.
  const key = createHash("sha256").update(JSON.stringify(textBlocks(doc))).digest("hex");
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.report;
  const report = await runFilingCheck(doc, hash, opts.deps ?? serverFilingDeps(), opts.signal);
  // Only a complete check is reused: a resolver or corpus outage must not be served again for ten minutes.
  if (report.coverage === "complete") {
    if (cache.size > 100) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), report });
  } else cache.delete(key);
  return report;
}

/**
 * The check state recorded in an export: a fresh/cached check of exactly this body — "checked" only when it ran in
 * full, "partial" when part of it could not run, "not_run" when nothing ran — or why there is none.
 */
export async function exportCheckState(doc: PMNode, opts: { deps?: FilingCheckDeps; timeoutMs?: number } = {}): Promise<{ state: CheckState; report: FilingCheckReport | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25_000);
  try {
    const report = await Promise.race([
      filingCheckFor(doc, { deps: opts.deps, signal: ctrl.signal }),
      new Promise<never>((_, rej) => ctrl.signal.addEventListener("abort", () => rej(new Error("timed out")), { once: true })),
    ]);
    return { state: checkStateOf(report), report };
  } catch (e) {
    return { state: { state: "not_run", reason: `the check could not complete: ${(e as Error).message}` }, report: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Drafting-assistant turns recorded for a document (office.proposal provenance records), with their sources and models. */
export function assistantRecord(docId: string | null | undefined): { turns: number; sources: ProvenanceSourceItem[]; models: string[] } {
  if (!docId) return { turns: 0, sources: [], models: [] };
  const recs = listProvenance({ kind: "office.proposal" }).filter((r) => r.recordId.startsWith(`${docId}:`));
  const sources: ProvenanceSourceItem[] = [];
  const models = new Set<string>();
  for (const r of recs) {
    if (r.provenance.model) models.add(r.provenance.model);
    for (const s of r.provenance.sources ?? []) sources.push({ kind: s.kind, title: s.title, cite: s.cite, url: s.url });
  }
  return { turns: recs.length, sources, models: Array.from(models).slice(0, 6) };
}

/** "primary role: anthropic" (the configured provider serving drafting), or "not configured". */
export function providerRole(): string {
  try {
    const c = aiConfig();
    return c.provider ? `primary role: ${c.provider}${c.fastProvider && c.fastProvider !== c.provider ? `; fast role: ${c.fastProvider}` : ""}` : "not configured";
  } catch {
    return "not configured";
  }
}
