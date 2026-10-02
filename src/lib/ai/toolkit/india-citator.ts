import "server-only";
import { defineTool, type EvidenceProvenance, type ToolContext } from "../tools";
import { contentHash } from "@/lib/integrity/hash";

/**
 * Citator tool over the corpus (table corpus_citations): which corpus judgments cite a judgment, with deterministic
 * TEXT CUES (the citing sentence says "overruled", "distinguished", …) and a cautious negative-signal summary with
 * coverage. Never a verified treatment and never "good law".
 */

function emit(ctx: ToolContext, ev: EvidenceProvenance[]) { if (ev.length) ctx.emit({ type: "evidence", evidence: ev }); }

export const CITATOR_RELATION = "cites (exact citation match); signal = text cue, not verified treatment";

export const citatorCheckTool = defineTool<{ id: string; limit?: number }>({
  name: "citator_check",
  description: "Citator for a judgment in the corpus: later corpus judgments that cite it by its exact neutral or reporter citation, each with the citing sentence and page, plus any TEXT CUE in that sentence (overruled / not good law, per incuriam, doubted, referred to a larger bench, distinguished, followed / relied upon) found by fixed rules. Also returns negative cues (overruled, doubted, per incuriam) and a summary status: negative_signal (from the Supreme Court or a bench at least as large), caution (other negative cues), no_negative_signal_found, or not_assessed (citator not built for it: plain text mentions without cues). Accepts an sc:/hc: id or a neutral citation. A cue is NOT a verified treatment and no result establishes good law: read the citing passage (read_judgment_text with the citing id and page) before saying how the judgment was treated.",
  parameters: { type: "object", properties: { id: { type: "string", description: "sc:…/hc:… corpus id, or a neutral citation such as 2024 INSC 735 or 2024:KHC-D:7336" }, limit: { type: "integer", description: "Citing judgments to return; default 15, max 40" } }, required: ["id"] },
  examples: [{ id: "2024 INSC 735" }, { id: "sc:2024_1_1_10", limit: 10 }],
  timeoutMs: 25_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Checking the citator for ${a.id}`,
  async execute(args, ctx) {
    const { resolveCorpusJudgment } = await import("@/modules/india/corpus/text");
    const { citatorFor } = await import("@/modules/india/citator/read");
    const { remoteStore } = await import("@/lib/db/remote");
    if (!remoteStore()) throw new Error("The judgment corpus (Postgres) is not configured on this deployment; citator_check is unavailable.");
    const key = args.id.trim().replace(/^corpus:/, "");
    const id = /^(sc|hc):\S+$/.test(key) ? key : (await resolveCorpusJudgment(key))?.id;
    if (!id) throw new Error(`No judgment "${args.id}" in the judgment index (exact sc:/hc: id or neutral citation). It is not substituted with another judgment; find the id with search_judgment_index.`);
    const r = await citatorFor(id);
    if (!r) throw new Error(`No judgment with id ${id} in the judgment index. It is not substituted with another judgment.`);
    const limit = Math.max(1, Math.min(args.limit ?? 15, 40));
    const shown = [...r.negative, ...r.citedBy.filter((c) => !r.negative.includes(c))].slice(0, limit);
    const retrievedAt = new Date().toISOString();
    const source = (c: (typeof shown)[number]) => `corpus://judgment/${c.citingId ?? c.citation}${c.page != null ? `#p${c.page}` : ""}`;
    emit(ctx, shown.map((c, i) => ({ source: source(c), kind: "opinion", provider: "corpus-citator", tool: "citator_check", query: id, rank: i + 1, documentId: c.citingId ?? undefined, authorityId: c.citation ?? undefined, page: c.page ?? undefined, hash: contentHash(`${c.citingId}|${c.page}|${c.context ?? ""}`), retrievedAt })));
    return {
      id,
      status: r.status,
      relation: r.status === "built" ? CITATOR_RELATION : "mentions (text match); no cues assessed",
      summary: { status: r.goodLaw.status, text: r.goodLaw.summary, coverage: r.goodLaw.coverage },
      counts: r.counts,
      citing: shown.map((c) => ({
        type: "search_result" as const,
        source: source(c),
        title: `${c.title ?? "Untitled"}${c.citation ? `, ${c.citation}` : ""} (${c.court ?? "court not recorded"}${c.decisionDate ? `, ${c.decisionDate}` : ""})${c.page != null ? `, p. ${c.page}` : ""}`,
        content: [c.context || "(cites the judgment)"],
        id: c.citingId, court_id: c.courtId, bench_strength: c.benchStrength, decided: c.decisionDate, page: c.page,
        text_cue: c.signal ? { signal: c.signal, words: c.cue, basis: "text cue, not verified treatment" } : null,
      })),
      omitted: Math.max(0, r.citedBy.length - shown.length),
      note: `${r.signalNote} ${r.goodLaw.coverage.note}`,
    };
  },
});

export const CITATOR_TOOLS = [citatorCheckTool];
