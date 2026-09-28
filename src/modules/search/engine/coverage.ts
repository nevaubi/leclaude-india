/**
 * Round decision: is the synthesis adequately covered by sources, or should
 * the engine run another round with refined queries? Pure and client-safe.
 */
import { citedNumbers } from "./markers";
import type { LaneKind, ResearchLane, ResearchSource, VerificationSummary } from "./types";

export interface CoverageInput {
  round: number;
  maxRounds: number;
  sources: ResearchSource[];
  answer: string;
  verification: VerificationSummary | null;
  lanes: ResearchLane[];
  /** Lane ids that produced zero sources. */
  emptyLaneIds?: string[];
}

export interface CoverageDecision {
  complete: boolean;
  /** True when the loop stops only because the round budget is spent while coverage is still thin (constitution §25 budget_exhausted). */
  exhausted: boolean;
  reason: string;
  /** Deterministic refinements per lane kind for the next round (may be augmented by the model). */
  refinements: Partial<Record<LaneKind, string[]>>;
  /** Claims that need support (feed the refinement generator). */
  gaps: string[];
}

export const MIN_SOURCES = 3;
export const MIN_READ = 1;
export const MIN_SCORE = 0.6;
export const MAX_UNSUPPORTED = 2;

/** Extract short retrieval queries from unsupported claims (drop filler, keep terms of art). */
export function claimToQuery(claim: string): string {
  const stop = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "under", "that", "this", "is", "are", "was", "were", "be", "by", "with", "and", "or", "at", "from", "it", "its", "as", "has", "have", "had", "not", "must", "may", "can", "court", "held", "holds", "holding"]);
  const words = claim.replace(/\[\d+\]/g, "").replace(/[^\w\s§.'-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w.toLowerCase()));
  return words.slice(0, 10).join(" ");
}

export function decideCoverage(input: CoverageInput): CoverageDecision {
  const readCount = input.sources.filter((s) => s.read).length;
  const cited = citedNumbers(input.answer);
  const v = input.verification;
  const gaps = (v?.verdicts ?? []).filter((x) => x.status !== "supported").map((x) => x.claim);
  const refinements: Partial<Record<LaneKind, string[]>> = {};
  const reasons: string[] = [];

  if (input.sources.length < MIN_SOURCES) reasons.push(`only ${input.sources.length} source${input.sources.length === 1 ? "" : "s"} found`);
  if (readCount < MIN_READ && input.sources.length > 0) reasons.push("no source was read in full");
  if (cited.size === 0 && input.sources.length > 0) reasons.push("the answer cites no sources");
  if (v && v.verdicts.length > 0 && v.score < MIN_SCORE) reasons.push(`verification score ${(v.score * 100).toFixed(0)}%`);
  if (v && v.unsupported + v.contradicted > MAX_UNSUPPORTED) reasons.push(`${v.unsupported + v.contradicted} unsupported or contradicted claims`);

  const thin = reasons.length > 0;
  if (!thin) return { complete: true, exhausted: false, reason: `coverage adequate: ${input.sources.length} sources, ${readCount} read${v ? `, ${(v.score * 100).toFixed(0)}% verified` : ""}`, refinements: {}, gaps: [] };
  if (input.round >= input.maxRounds) return { complete: true, exhausted: true, reason: `stopping after round ${input.round} (${reasons.join("; ")})`, refinements: {}, gaps };

  // Build refinements: unsupported claims → queries for the lanes most likely to support them; empty lanes get a broadened query.
  const claimQueries = gaps.map(claimToQuery).filter((q) => q.split(" ").length >= 2).slice(0, 3);
  for (const lane of input.lanes) {
    const wasEmpty = input.emptyLaneIds?.includes(lane.id);
    const list: string[] = [];
    if (claimQueries.length && (lane.kind === "controlling" || lane.kind === "persuasive" || lane.kind === "statute" || lane.kind === "regulatory" || lane.kind === "secondary" || lane.kind === "fast")) list.push(...claimQueries);
    if (wasEmpty) list.push(broaden(lane.queries[0] ?? ""));
    if (list.length) refinements[lane.kind] = Array.from(new Set(list.filter(Boolean)));
  }
  if (!Object.keys(refinements).length) {
    // Nothing specific to refine: broaden the primary lane's query.
    const primary = input.lanes[0];
    if (primary) refinements[primary.kind] = [broaden(primary.queries[0] ?? "")].filter(Boolean);
  }
  return { complete: false, exhausted: false, reason: reasons.join("; "), refinements, gaps };
}

/** Loosen a boolean query: drop NOT clauses, turn ANDs into ORs for the tail, strip proximity. */
export function broaden(query: string): string {
  const q = query.replace(/\s+NOT\s+\S+/g, "").replace(/"([^"]+)"~\d+/g, '"$1"').trim();
  const parts = q.split(/\s+AND\s+/);
  if (parts.length > 2) return `${parts[0]} AND (${parts.slice(1).join(" OR ")})`;
  return q;
}
