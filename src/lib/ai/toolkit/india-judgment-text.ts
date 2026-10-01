import "server-only";
import { defineTool, type EvidenceProvenance, type ToolContext } from "../tools";
import { contentHash } from "@/lib/integrity/hash";
import type { TextSearchHit } from "@/modules/india/corpus/text";

/** The id read_judgment_text accepts for a hit: the corpus record, else the neutral citation, else CNR@date. */
export function textKey(h: TextSearchHit): string {
  return h.judgmentId ?? h.neutralCitation ?? `${h.cnr}@${h.decisionDate}`;
}

/**
 * Tools over the full text of Supreme Court judgments (table corpus_texts). Search returns the best passage per
 * judgment with its page; read returns the judgment text with page markers. Both refuse to guess: an unknown citation
 * or a judgment without text is an explicit error, never a nearby judgment.
 */

function emit(ctx: ToolContext, ev: EvidenceProvenance[]) { if (ev.length) ctx.emit({ type: "evidence", evidence: ev }); }

type SearchArgs = { query: string; courts?: string[]; year_from?: number; year_to?: number; limit?: number };

export const searchJudgmentTextTool = defineTool<SearchArgs>({
  name: "search_judgment_text",
  description: "PRIMARY tool for doctrine, holdings, tests and how courts applied a provision: full-text search inside judgments with page numbers — Supreme Court of India (about 35,000 judgments, 1950 onwards) and the High Courts of Karnataka, Andhra Pradesh and Telangana where loaded (see the coverage block for courts and years). Each result is the best matching passage of one judgment with its page, neutral citation (or CNR and decision date for High Courts) and the id to read it with. Then read the judgment with read_judgment_text (id + page) before characterising a holding, and cite the page. Query syntax: plain words, \"quoted phrase\", OR, -exclude. To identify a case by citation, CNR or party use search_judgment_index; for courts or years outside the full-text coverage it finds nothing.",
  parameters: { type: "object", properties: { query: { type: "string", description: "Words or a quoted phrase, e.g. \"anticipatory bail\" \"section 438\"" }, courts: { type: "array", items: { type: "string" }, description: "Registry court ids, e.g. [\"sci\"], [\"hc-karnataka\"]; omit for all" }, year_from: { type: "integer" }, year_to: { type: "integer" }, limit: { type: "integer", description: "Default 8, max 20" } }, required: ["query"] },
  examples: [{ query: "\"anticipatory bail\" conditions \"section 438\"", year_from: 2015, limit: 8 }],
  timeoutMs: 25_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Searching judgment text: ${a.query}`,
  async execute(args, ctx) {
    const { searchJudgmentText } = await import("@/modules/india/corpus/text");
    const { available, hits } = await searchJudgmentText(args.query, { courts: args.courts, yearFrom: args.year_from, yearTo: args.year_to, limit: Math.min(args.limit ?? 8, 20) });
    if (!available) return { count: 0, results: [], note: "Judgment text is not loaded on this deployment. Use search_judgment_index (metadata) instead." };
    const retrievedAt = new Date().toISOString();
    const source = (h: TextSearchHit) => `corpus://judgment/${textKey(h)}${h.pageStart != null ? `#p${h.pageStart}` : ""}`;
    emit(ctx, hits.map((h, i) => ({ source: source(h), kind: "opinion", provider: "open-india-law", tool: "search_judgment_text", query: args.query, rank: i + 1, score: h.rank, documentId: h.judgmentId ?? undefined, authorityId: h.citation, url: h.pdfUrl ?? undefined, hash: contentHash(`${h.citation}|${h.chunkIndex}|${h.passage}`), retrievedAt })));
    return {
      count: hits.length,
      results: hits.map((h) => ({
        type: "search_result" as const,
        source: source(h),
        title: `${h.title ?? "Untitled"}, ${h.citation}${h.reporterCitation ? `, ${h.reporterCitation}` : ""} (${h.court}${h.decisionDate ? `, ${h.decisionDate}` : ""})${h.pageStart != null ? `, p. ${h.pageStart}` : ""}`,
        content: [h.passage || "(no passage)"],
        id: textKey(h), neutral_citation: h.neutralCitation, cnr: h.cnr, court_id: h.courtId, case_number: h.caseNumber, decided: h.decisionDate, judges: h.judges, page: h.pageStart, chunk: h.chunkIndex, pdf_url: h.pdfUrl,
        linked_record: h.judgmentId ? true : "no matching record in the judgment index (text only)",
      })),
      ...(hits.length ? {} : { note: "No judgment text matched. Rephrase, or try search_judgment_index; do not cite authority that was not found." }),
    };
  },
});

type ReadArgs = { id: string; page?: number; from_chunk?: number; max_chars?: number };

export const readJudgmentTextTool = defineTool<ReadArgs>({
  name: "read_judgment_text",
  description: "Read the text of a judgment from the full-text corpus, with page markers ([p. 4]). `id` is exactly what search_judgment_text or search_judgment_index returned: a corpus id (sc:…, hc:…), a Supreme Court neutral citation (2024 INSC 735), or a High Court CNR with its decision date (KAHC010219082014@2014-09-09). Use `page` to jump to the page of a search passage, or `from_chunk` (from a previous call's next_chunk) to continue. A metadata-only record or unknown id is an error, never another judgment. Quote only from text returned here and cite it as \"Title, 2024 INSC 735, p. 6\" (High Courts: \"Title, CNR KAHC010219082014, decided 2014-09-09, p. 6\").",
  parameters: { type: "object", properties: { id: { type: "string", description: "sc:…/hc:… corpus id, a neutral citation such as 2024 INSC 735, or CNR@YYYY-MM-DD" }, page: { type: "integer" }, from_chunk: { type: "integer" }, max_chars: { type: "integer", description: "Default 40000, max 120000" } }, required: ["id"] },
  examples: [{ id: "2024 INSC 735" }, { id: "2024 INSC 735", page: 6 }],
  timeoutMs: 20_000,
  maxResultChars: 130_000,
  access: "read",
  label: (a) => `Reading judgment ${a.id}`,
  async execute(args, ctx) {
    const { readJudgmentText, chunksToText } = await import("@/modules/india/corpus/text");
    const r = await readJudgmentText(args.id, { page: args.page, fromChunk: args.from_chunk, maxChars: Math.min(args.max_chars ?? 40_000, 120_000) });
    if (!r) throw new Error(`No full text for "${args.id}" in the judgment text corpus (unknown id or metadata-only record). Do not substitute another judgment.`);
    if (!r.chunks.length) throw new Error(`Judgment ${r.citation} has no text at page ${args.page}.`);
    const text = chunksToText(r.chunks);
    const first = r.chunks[0];
    emit(ctx, [{ source: `corpus://judgment/${r.judgmentId || r.citation}${first.pageStart != null ? `#p${first.pageStart}` : ""}`, kind: "opinion", provider: "open-india-law", tool: "read_judgment_text", rank: 1, documentId: r.judgmentId || undefined, authorityId: r.citation, hash: contentHash(text), retrievedAt: new Date().toISOString() }]);
    return {
      id: r.judgmentId || null, citation: r.citation, neutral_citation: r.neutralCitation, cnr: r.cnr, decided: r.decisionDate, court_id: r.courtId, title: r.title, total_chunks: r.totalChunks,
      chunks: `${first.index}–${r.chunks[r.chunks.length - 1].index}`, next_chunk: r.nextChunk, attribution: r.attribution, text,
    };
  },
});

export const JUDGMENT_TEXT_TOOLS = [searchJudgmentTextTool, readJudgmentTextTool];
