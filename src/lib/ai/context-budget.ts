/**
 * Context and output budgets per task profile (constitution §36, §51; pure and client-safe).
 *
 * Every surface that sizes a prompt (deep research evidence, workflow steps, e-discovery batches, deposition segments,
 * document windows, office agents, chat) asks for a profile and gets concrete numbers resolved against the model the
 * router chose (`ModelDescriptor.contextWindow / maxOutput / maxInput`, coded in providers/model-limits.ts):
 *
 *   resolveContextBudget("deep_research_synthesis", descriptor) → { maxOutputTokens, inputTokens, inputChars,
 *     perSourceChars, totalEvidenceChars, maxFullSources, blockChars, toolResultChars, historyChars, maxSteps, effort, … }
 *
 * Rules
 * - Floors are the constants each surface used before budgets existed: a larger model never makes a surface see LESS.
 * - Ceilings are safety bounds (latency, cost, the 272K long-context price tier on OpenAI's 1.05M models, the verifier's
 *   reach). A ceiling never exceeds what the model accepts: the model limit wins over a floor when the model is small
 *   (evidence ≤ 85% and tool results / history ≤ 50% of the input characters, one source ≤ the evidence total).
 * - Character budgets are derived from token budgets at a conservative 3 characters per token; text in Indic scripts
 *   costs more tokens per character, so callers that pack text against `inputTokens` use `estimateTokens` (script-aware).
 * - AI_CONTEXT_SCALE (0.25–1, default 1) shrinks every input-side budget above its floor (cost control).
 */
import type { ModelDescriptor, ReasoningEffort } from "./providers/types";

export type BudgetProfileId =
  | "chat_fast"
  | "chat_standard"
  | "deep_research_synthesis"
  | "research_lane"
  | "verify"
  | "workflow_step"
  | "workflow_agent"
  | "litigation_draft"
  | "ediscovery_doc"
  | "ediscovery_batch"
  | "deposition_segment"
  | "documents_window"
  | "documents_ask"
  | "office_agent";

export const BUDGET_PROFILE_IDS: readonly BudgetProfileId[] = [
  "chat_fast", "chat_standard", "deep_research_synthesis", "research_lane", "verify", "workflow_step", "workflow_agent", "litigation_draft",
  "ediscovery_doc", "ediscovery_batch", "deposition_segment", "documents_window", "documents_ask", "office_agent",
];

export function isBudgetProfileId(v: unknown): v is BudgetProfileId {
  return typeof v === "string" && (BUDGET_PROFILE_IDS as readonly string[]).includes(v);
}

export interface ResolvedBudget {
  profile: BudgetProfileId;
  /** Default `maxOutputTokens` for the call (visible answer size; reasoning headroom is added per provider, then clamped to the model). */
  maxOutputTokens: number;
  /** Tokens the whole input (instructions + history + evidence) is sized to: the share callers pack evidence and history against. */
  inputTokens: number;
  /**
   * Tokens of input the context guard allows before it elides old tool results: what the model accepts after the output
   * reservation, capped by the profile's input ceiling (latency, cost, the long-context price tier); never below
   * `inputTokens`. The guard is not the sizing share: a run on a smaller model keeps its earlier reads until the model's
   * own limit (or the ceiling) is near, instead of eliding them at a fraction of it.
   */
  guardTokens: number;
  /** `inputTokens` in characters at a conservative 3 chars/token (Latin script; use estimateTokens for Indic text). */
  inputChars: number;
  /** Characters of one source given in full (research evidence, verifier source, deposition segment, document window). */
  perSourceChars: number;
  /** Characters of evidence across all sources. */
  totalEvidenceChars: number;
  /** How many sources may be given in full (the rest as snippets) — or batch size / read cap where the profile says so. */
  maxFullSources: number;
  /** Characters per citable content block (citation granularity). */
  blockChars: number;
  /** Characters of one tool result the model sees. */
  toolResultChars: number;
  /** Characters of conversation history (or of the answer being verified, for `verify`). */
  historyChars: number;
  /** Conversation turns of history to replay (chat, office agents). */
  historyTurns: number;
  maxSteps: number;
  effort: ReasoningEffort;
  /** Bounded parallelism for fan-out work under this profile (segments, batches, windows). */
  concurrency: number;
  /** The model limits the budget was resolved against. */
  model: { contextWindow: number; maxOutput: number; maxInput: number };
  /** AI_CONTEXT_SCALE applied (0.25–1). */
  scale: number;
}

/** A numeric field: value on a large-context model (`target`), never below `floor`, never above `ceil`. */
interface Range { floor: number; target: number; ceil: number }

interface ProfileSpec {
  /** Share of the model's usable input this profile may fill. */
  inputShare: number;
  inputTokens: Range;
  outputTokens: Range;
  perSourceChars: Range;
  totalEvidenceChars: Range;
  blockChars: Range;
  toolResultChars: Range;
  historyChars: Range;
  maxFullSources: Range;
  historyTurns: Range;
  maxSteps: number;
  effort: ReasoningEffort;
  concurrency: number;
}

const R = (floor: number, target: number, ceil: number): Range => ({ floor, target, ceil });

/** Input size (tokens) at which a profile's char targets apply in full; smaller models scale them down to the floor. */
const REFERENCE_INPUT_TOKENS = 240_000;
/** Conservative characters per token for Latin-script prompts (real English is ~4; numbers and citations are denser). */
export const CHARS_PER_TOKEN = 3;
/** Tokens kept back from the context window for instructions, tool definitions and wire overhead. */
const OVERHEAD_TOKENS = 8_000;

/**
 * Profiles. Floors = the constants in use before budgets (see each comment); ceilings keep input under ~240K tokens
 * (below OpenAI's 272K long-context price tier and inside every 400K+ window) unless the model is smaller.
 */
export const BUDGET_PROFILES: Readonly<Record<BudgetProfileId, ProfileSpec>> = {
  // chat/server: routeMessage fast tier 3_000 output; tool output sliced to 60_000; 16 history turns; 8 rounds.
  chat_fast: { inputShare: 0.25, inputTokens: R(24_000, 64_000, 96_000), outputTokens: R(3_000, 4_000, 8_000), perSourceChars: R(6_000, 12_000, 20_000), totalEvidenceChars: R(40_000, 80_000, 120_000), blockChars: R(1_400, 1_600, 2_000), toolResultChars: R(60_000, 60_000, 80_000), historyChars: R(12_000, 24_000, 48_000), maxFullSources: R(5, 6, 8), historyTurns: R(16, 16, 24), maxSteps: 8, effort: "low", concurrency: 4 },
  // chat/server: standard tier 8_000 output (+12_000 reasoning headroom); tool output 60_000; 16 turns.
  chat_standard: { inputShare: 0.4, inputTokens: R(48_000, 160_000, 200_000), outputTokens: R(8_000, 12_000, 32_000), perSourceChars: R(6_000, 30_000, 40_000), totalEvidenceChars: R(80_000, 240_000, 360_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(60_000, 120_000, 150_000), historyChars: R(12_000, 40_000, 80_000), maxFullSources: R(5, 10, 12), historyTurns: R(16, 24, 40), maxSteps: 8, effort: "medium", concurrency: 4 },
  // search/engine: synthesis 8_000 output; evidence 6_000/source, 80_000 total, 1_400 per block.
  deep_research_synthesis: { inputShare: 0.5, inputTokens: R(32_000, 240_000, 240_000), outputTokens: R(8_000, 16_000, 32_000), perSourceChars: R(6_000, 40_000, 48_000), totalEvidenceChars: R(80_000, 520_000, 560_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(32_000, 60_000, 64_000), historyChars: R(2_500, 8_000, 16_000), maxFullSources: R(12, 12, 12), historyTurns: R(4, 6, 8), maxSteps: 1, effort: "medium", concurrency: 6 },
  // search/engine lanes: 1_800 output; read_source 30_000 default / 32_000 result; read caps 3–5 per lane.
  research_lane: { inputShare: 0.3, inputTokens: R(32_000, 120_000, 160_000), outputTokens: R(1_800, 3_000, 6_000), perSourceChars: R(30_000, 60_000, 60_000), totalEvidenceChars: R(80_000, 240_000, 320_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(32_000, 64_000, 64_000), historyChars: R(8_000, 16_000, 24_000), maxFullSources: R(5, 7, 8), historyTurns: R(1, 1, 1), maxSteps: 8, effort: "low", concurrency: 6 },
  // lib/ai/verify: 9_000 chars/source, 24 sources, answer 20_000 chars, 6_000 output; selfCorrect 40_000 evidence / 30_000 output.
  // Share 0.75: the verifier must be able to see what the synthesis it checks saw (deep research caps its evidence at
  // the verifier's capacity — verification is never weaker than synthesis).
  verify: { inputShare: 0.75, inputTokens: R(64_000, 200_000, 220_000), outputTokens: R(6_000, 12_000, 24_000), perSourceChars: R(9_000, 24_000, 40_000), totalEvidenceChars: R(216_000, 480_000, 560_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(30_000, 60_000, 80_000), historyChars: R(20_000, 60_000, 80_000), maxFullSources: R(24, 32, 40), historyTurns: R(1, 1, 1), maxSteps: 1, effort: "low", concurrency: 4 },
  // workflows/executors: inputs sliced at 40_000–150_000; 24 tool results × 8_000 kept as evidence; 10 research steps; no output cap.
  workflow_step: { inputShare: 0.45, inputTokens: R(64_000, 220_000, 240_000), outputTokens: R(8_000, 16_000, 32_000), perSourceChars: R(20_000, 60_000, 80_000), totalEvidenceChars: R(150_000, 480_000, 600_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(8_000, 24_000, 40_000), historyChars: R(40_000, 120_000, 200_000), maxFullSources: R(24, 32, 40), historyTurns: R(1, 1, 1), maxSteps: 10, effort: "medium", concurrency: 4 },
  // workflows/executors-agents + personas: context 100_000; brief/context/evidence 40_000 each for verification.
  workflow_agent: { inputShare: 0.45, inputTokens: R(64_000, 220_000, 240_000), outputTokens: R(8_000, 16_000, 32_000), perSourceChars: R(40_000, 80_000, 120_000), totalEvidenceChars: R(100_000, 480_000, 600_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(8_000, 24_000, 40_000), historyChars: R(40_000, 120_000, 200_000), maxFullSources: R(24, 32, 40), historyTurns: R(1, 1, 1), maxSteps: 14, effort: "medium", concurrency: 4 },
  // drafting: ai.draft context 100_000, 8 steps.
  litigation_draft: { inputShare: 0.45, inputTokens: R(64_000, 220_000, 240_000), outputTokens: R(16_000, 24_000, 48_000), perSourceChars: R(20_000, 60_000, 80_000), totalEvidenceChars: R(100_000, 400_000, 560_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(8_000, 24_000, 40_000), historyChars: R(40_000, 120_000, 200_000), maxFullSources: R(24, 32, 40), historyTurns: R(1, 1, 1), maxSteps: 8, effort: "medium", concurrency: 4 },
  // ediscovery/ai: MAX_TEXT 24_000 per document, 1_800 output, verify evidence 30_000.
  ediscovery_doc: { inputShare: 0.3, inputTokens: R(16_000, 80_000, 120_000), outputTokens: R(1_800, 3_000, 6_000), perSourceChars: R(24_000, 100_000, 160_000), totalEvidenceChars: R(30_000, 120_000, 200_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(12_000, 24_000, 40_000), historyChars: R(8_000, 16_000, 24_000), maxFullSources: R(1, 1, 1), historyTurns: R(1, 1, 1), maxSteps: 1, effort: "low", concurrency: 4 },
  // ediscovery/ai batch prediction: batch 10 (max 20) × 6_000 chars; output 220/doc + 200.
  ediscovery_batch: { inputShare: 0.3, inputTokens: R(24_000, 80_000, 120_000), outputTokens: R(2_400, 4_600, 8_000), perSourceChars: R(6_000, 12_000, 16_000), totalEvidenceChars: R(60_000, 200_000, 240_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(12_000, 24_000, 40_000), historyChars: R(8_000, 16_000, 24_000), maxFullSources: R(10, 20, 20), historyTurns: R(1, 1, 1), maxSteps: 1, effort: "low", concurrency: 4 },
  // ediscovery/analysis digest: 60_000 chars of transcript (a prefix — replaced by whole-transcript segmentation), 3_000 output.
  deposition_segment: { inputShare: 0.3, inputTokens: R(24_000, 80_000, 120_000), outputTokens: R(3_000, 6_000, 12_000), perSourceChars: R(60_000, 120_000, 160_000), totalEvidenceChars: R(60_000, 160_000, 200_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(12_000, 24_000, 40_000), historyChars: R(8_000, 16_000, 24_000), maxFullSources: R(1, 1, 1), historyTurns: R(1, 1, 1), maxSteps: 1, effort: "medium", concurrency: 4 },
  // documents/review-run: REVIEW_WINDOW_CHARS 20_000; extract WINDOW_CHARS 14_000; concurrency 4.
  documents_window: { inputShare: 0.25, inputTokens: R(12_000, 40_000, 60_000), outputTokens: R(4_000, 8_000, 12_000), perSourceChars: R(20_000, 40_000, 60_000), totalEvidenceChars: R(20_000, 40_000, 60_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(12_000, 24_000, 40_000), historyChars: R(8_000, 16_000, 24_000), maxFullSources: R(1, 1, 1), historyTurns: R(1, 1, 1), maxSteps: 1, effort: "low", concurrency: 4 },
  // documents/ask: 14 passages, synthesis with no output cap.
  documents_ask: { inputShare: 0.35, inputTokens: R(24_000, 120_000, 160_000), outputTokens: R(4_000, 8_000, 16_000), perSourceChars: R(1_500, 4_000, 6_000), totalEvidenceChars: R(30_000, 160_000, 240_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(24_000, 40_000, 60_000), historyChars: R(8_000, 16_000, 24_000), maxFullSources: R(14, 30, 40), historyTurns: R(4, 8, 12), maxSteps: 1, effort: "medium", concurrency: 4 },
  // office/shared/route-factory: 12 history messages × 12_000 chars, scope 8_000; 16–32 steps; no output cap.
  office_agent: { inputShare: 0.4, inputTokens: R(48_000, 200_000, 220_000), outputTokens: R(8_000, 16_000, 32_000), perSourceChars: R(8_000, 24_000, 40_000), totalEvidenceChars: R(60_000, 240_000, 400_000), blockChars: R(1_400, 2_000, 2_000), toolResultChars: R(12_000, 40_000, 60_000), historyChars: R(12_000, 24_000, 40_000), maxFullSources: R(8, 12, 16), historyTurns: R(12, 16, 24), maxSteps: 24, effort: "medium", concurrency: 4 },
};

export type BudgetEnv = Readonly<Record<string, string | undefined>>;

/** Model limits used when no descriptor is available (unknown model / nothing configured): conservative. */
export const DEFAULT_BUDGET_MODEL = Object.freeze({ contextWindow: 128_000, maxOutput: 16_000, maxInput: 112_000 });

/** AI_CONTEXT_SCALE clamped to [0.25, 1] (default 1). */
export function contextScale(env: BudgetEnv = defaultEnv()): number {
  const raw = Number((env.AI_CONTEXT_SCALE ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(0.25, Math.min(1, raw));
}

function defaultEnv(): BudgetEnv {
  return typeof process !== "undefined" && process.env ? (process.env as BudgetEnv) : {};
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Resolve a profile against the chosen model's limits. Pure; never returns NaN or a value above the model limit. */
export function resolveContextBudget(profile: BudgetProfileId, descriptor?: Pick<ModelDescriptor, "contextWindow" | "maxOutput" | "maxInput"> | null, env: BudgetEnv = defaultEnv()): ResolvedBudget {
  const spec = BUDGET_PROFILES[profile] ?? BUDGET_PROFILES.workflow_step;
  const contextWindow = positive(descriptor?.contextWindow) ?? DEFAULT_BUDGET_MODEL.contextWindow;
  const maxOutput = Math.min(positive(descriptor?.maxOutput) ?? DEFAULT_BUDGET_MODEL.maxOutput, contextWindow);
  const maxInput = Math.min(positive(descriptor?.maxInput) ?? Math.max(1, contextWindow - maxOutput), contextWindow);
  const scale = contextScale(env);

  // Output: the profile's target, never below its floor unless the model cannot produce that much.
  const maxOutputTokens = Math.max(1, Math.min(maxOutput, clamp(spec.outputTokens.target, spec.outputTokens.floor, spec.outputTokens.ceil)));

  // Input: a share of what the model accepts after the output reservation and overhead, inside the profile range.
  const usable = Math.max(1_000, Math.min(maxInput, contextWindow - maxOutputTokens) - OVERHEAD_TOKENS);
  const wanted = Math.round(usable * spec.inputShare * scale);
  const inputTokens = Math.max(1, Math.min(usable, clamp(wanted, spec.inputTokens.floor, spec.inputTokens.ceil)));
  const guardTokens = Math.max(inputTokens, Math.min(usable, Math.round(spec.inputTokens.ceil * scale)));
  const inputChars = inputTokens * CHARS_PER_TOKEN;
  // Char targets apply in full at REFERENCE_INPUT_TOKENS of input; smaller budgets scale them toward the floor.
  const ratio = Math.min(1, inputTokens / REFERENCE_INPUT_TOKENS) * scale;
  // The model-derived cap is applied LAST: on a small model it wins over the profile's floor (a floor is "what the
  // surface used before budgets", never a reason to ask a model for more than its input holds).
  const chars = (r: Range, cap = Number.POSITIVE_INFINITY) => Math.max(1, Math.min(Math.round(clamp(r.target * ratio, r.floor, r.ceil)), Math.floor(cap)));
  const count = (r: Range) => Math.round(clamp(r.target, r.floor, r.ceil));

  // Evidence must leave room for instructions and the question: at most 85% of the input characters.
  const totalEvidenceChars = chars(spec.totalEvidenceChars, inputChars * 0.85);
  const maxFullSources = count(spec.maxFullSources);
  // One source never exceeds the evidence total (the floor yields to it on a small model).
  const perSourceChars = Math.min(chars(spec.perSourceChars, totalEvidenceChars), Math.max(Math.min(spec.perSourceChars.floor, totalEvidenceChars), Math.floor(totalEvidenceChars / Math.max(1, Math.min(maxFullSources, 12)))));
  return {
    profile,
    maxOutputTokens,
    inputTokens,
    guardTokens,
    inputChars,
    perSourceChars,
    totalEvidenceChars,
    maxFullSources,
    blockChars: count(spec.blockChars),
    toolResultChars: chars(spec.toolResultChars, inputChars * 0.5),
    historyChars: chars(spec.historyChars, inputChars * 0.5),
    historyTurns: count(spec.historyTurns),
    maxSteps: spec.maxSteps,
    effort: spec.effort,
    concurrency: spec.concurrency,
    model: { contextWindow, maxOutput, maxInput },
    scale,
  };
}

function positive(n: number | undefined | null): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

// ---------------------------------------------------------------------------
// Token estimation (script-aware, conservative: it overestimates rather than underestimates)
// ---------------------------------------------------------------------------

/**
 * Estimated tokens for `text`. Per-character weights are conservative upper estimates, not measurements:
 * Latin letters and spaces 0.27 (≈3.7 chars/token), digits and punctuation 0.5, Indic scripts (Devanagari through
 * Malayalam, U+0900–U+0DFF; Sinhala; Ol Chiki) 0.8, Arabic / Urdu 0.6, CJK / Hangul 1.0, anything else 0.5.
 * Measure against provider usage before tightening (the Indic ratio in particular is UNVERIFIED).
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x20) t += 0.27;
      else if (c === 0x0a || c === 0x09) t += 0.3;
      else t += 0.5;
    } else if (c >= 0x0900 && c <= 0x0dff) t += 0.8; // Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, Sinhala
    else if (c >= 0x1c50 && c <= 0x1c7f) t += 0.8; // Ol Chiki (Santali)
    else if (c >= 0x0600 && c <= 0x06ff) t += 0.6; // Arabic script (Urdu)
    else if ((c >= 0x3040 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)) t += 1.0; // CJK, Hangul
    else if (c >= 0xd800 && c <= 0xdbff) { t += 1.0; i++; } // astral plane pair
    else if (c <= 0x024f) t += 0.3; // Latin-1 / Latin Extended letters
    else t += 0.5;
  }
  return Math.ceil(t);
}

/** Largest prefix of `text` (in characters) that fits `maxTokens` by estimateTokens (linear scan; exact for the estimator). */
export function charsForTokens(text: string, maxTokens: number): number {
  if (maxTokens <= 0) return 0;
  if (estimateTokens(text) <= maxTokens) return text.length;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Clip `text` to `maxChars` with an explicit marker (never silent). Returns the text unchanged when it fits.
 * `what` names the material in the marker so a reader knows something was left out.
 */
export function clipWithMarker(text: string, maxChars: number, what = "text"): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars))}\n…[${what} truncated: ${text.length - maxChars} of ${text.length} characters omitted]`;
}
