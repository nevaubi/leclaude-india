import "server-only";
import { defineTool, type EvidenceProvenance, type ToolContext } from "../tools";
import { contentHash } from "@/lib/integrity/hash";

/**
 * Tools over the full text of Supreme Court judgments (table corpus_texts). Search returns the best passage per
 * judgment with its page; read returns the judgment text with page markers. Both refuse to guess: an unknown citation
 * or a judgment without text is an explicit error, never a nearby judgment.
 */

function emit(ctx: ToolContext, ev: EvidenceProvenance[]) { if (ev.length) ctx.emit({ type: "evidence", evidence: ev }); }

type SearchArgs = { query: string; year_from?: number; year_to?: number; limit?: number };

export const searchJudgmentTextTool = defineTool<SearchArgs>({
  name: "search_judgment_text",
  description: "Full-text search inside Supreme Court of India judgments (English text of about 35,000 judgments, 1950 onwards, with page numbers). Use it to find where the Court discussed a doctrine, a statutory provision or a phrase; each result is the best matching passage of one judgment with its page, neutral citation and corpus id. Read the judgment (read_judgment_text) before characterising a holding. Query syntax: plain words, \"quoted phrase\", OR, -exclude.",
  parameters: { type: "object", properties: { query: { type: "string", description: "Words or a quoted phrase, e.g. \"anticipatory bail\" \"section 438\"" }, year_from: { type: "integer" }, year_to: { type: "integer" }, limit: { type: "integer", description: "Default 8, max 20" } }, required: ["query"] },
  examples: [{ query: "\"anticipatory bail\" conditions \"section 438\"", year_from: 2015, limit: 8 }],
  timeoutMs: 25_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Searching Supreme Court judgment text: ${a.query}`,
  async execute(args, ctx) {
    const { searchJudgmentText } = await import("@/modules/india/corpus/text");
    const { available, hits } = await searchJudgmentText(args.query, { yearFrom: args.year_from, yearTo: args.year_to, limit: Math.min(args.limit ?? 8, 20) });
    if (!available) return { count: 0, results: [], note: "Supreme Court judgment text is not loaded on this deployment. Use search_judgment_index (metadata) instead." };
    const retrievedAt = new Date().toISOString();
    const source = (h: { judgmentId: string | null; neutralCitation: string; pageStart: number | null }) => `corpus://judgment/${h.judgmentId ?? h.neutralCitation}${h.pageStart != null ? `#p${h.pageStart}` : ""}`;
    emit(ctx, hits.map((h, i) => ({ source: source(h), kind: "opinion", provider: "open-india-law", tool: "search_judgment_text", query: args.query, rank: i + 1, score: h.rank, documentId: h.judgmentId ?? undefined, authorityId: h.neutralCitation, url: h.pdfUrl ?? undefined, hash: contentHash(`${h.neutralCitation}|${h.chunkIndex}|${h.passage}`), retrievedAt })));
    return {
      count: hits.length,
      results: hits.map((h) => ({
        type: "search_result" as const,
        source: source(h),
        title: `${h.title ?? "Untitled"}, ${h.neutralCitation}${h.reporterCitation ? `, ${h.reporterCitation}` : ""} (${h.court}${h.decisionDate ? `, ${h.decisionDate}` : ""})${h.pageStart != null ? `, p. ${h.pageStart}` : ""}`,
        content: [h.passage || "(no passage)"],
        id: h.judgmentId, neutral_citation: h.neutralCitation, decided: h.decisionDate, judges: h.judges, page: h.pageStart, chunk: h.chunkIndex, pdf_url: h.pdfUrl,
        linked_record: h.judgmentId ? true : "no matching record in the judgment index (text only)",
      })),
      ...(hits.length ? {} : { note: "No Supreme Court judgment text matched. Rephrase, or try search_judgment_index; do not cite authority that was not found." }),
    };
  },
});

type ReadArgs = { id: string; page?: number; from_chunk?: number; max_chars?: number };

export const readJudgmentTextTool = defineTool<ReadArgs>({
  name: "read_judgment_text",
  description: "Read the text of a Supreme Court of India judgment from the full-text corpus, with page markers ([p. 4]). `id` is a corpus id (sc:…) or a neutral citation (2024 INSC 735). Use `page` to start at a page, or `from_chunk` (from a previous call's next_chunk) to continue. Quote only from text returned here and cite the page.",
  parameters: { type: "object", properties: { id: { type: "string", description: "sc:… corpus id or a neutral citation such as 2024 INSC 735" }, page: { type: "integer" }, from_chunk: { type: "integer" }, max_chars: { type: "integer", description: "Default 40000, max 120000" } }, required: ["id"] },
  examples: [{ id: "2024 INSC 735" }, { id: "2024 INSC 735", page: 6 }],
  timeoutMs: 20_000,
  maxResultChars: 130_000,
  access: "read",
  label: (a) => `Reading judgment ${a.id}`,
  async execute(args, ctx) {
    const { readJudgmentText, chunksToText } = await import("@/modules/india/corpus/text");
    const r = await readJudgmentText(args.id, { page: args.page, fromChunk: args.from_chunk, maxChars: Math.min(args.max_chars ?? 40_000, 120_000) });
    if (!r) throw new Error(`No full text for "${args.id}" in the Supreme Court text corpus (unknown citation or metadata-only record). Do not substitute another judgment.`);
    if (!r.chunks.length) throw new Error(`Judgment ${r.neutralCitation} has no text at page ${args.page}.`);
    const text = chunksToText(r.chunks);
    const first = r.chunks[0];
    emit(ctx, [{ source: `corpus://judgment/${r.judgmentId || r.neutralCitation}${first.pageStart != null ? `#p${first.pageStart}` : ""}`, kind: "opinion", provider: "open-india-law", tool: "read_judgment_text", rank: 1, documentId: r.judgmentId || undefined, authorityId: r.neutralCitation, hash: contentHash(text), retrievedAt: new Date().toISOString() }]);
    return {
      id: r.judgmentId || null, neutral_citation: r.neutralCitation, title: r.title, total_chunks: r.totalChunks,
      chunks: `${first.index}–${r.chunks[r.chunks.length - 1].index}`, next_chunk: r.nextChunk, attribution: r.attribution, text,
    };
  },
});

export const JUDGMENT_TEXT_TOOLS = [searchJudgmentTextTool, readJudgmentTextTool];
