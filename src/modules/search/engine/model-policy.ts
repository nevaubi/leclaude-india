/**
 * Which model role each research step runs on (constitution §15–§17, §36). The router maps
 * `taskType` to a role (`roleForTask`): bounded decisions (planning, query rewriting, snippet
 * triage, lane reading notes, claim extraction/verification, follow-ups) go to the fast role;
 * only the synthesis runs on the primary model. Client-safe constants; defaultDeps reads them
 * so tests can assert the routing without a network call.
 *
 * Output and input sizes come from context-budget profiles (src/lib/ai/context-budget.ts) resolved against the model
 * the router picks: lanes use `research_lane`, synthesis and correction `deep_research_synthesis`, the verifier
 * `verify`. Short structured steps (plan, refine, triage, follow-ups) keep fixed small caps.
 */
import type { BudgetProfileId } from "@/lib/ai/context-budget";
import type { ReasoningEffort, TaskType } from "@/lib/ai/providers/types";

export type ResearchStep = "plan" | "refine" | "triage" | "laneAgent" | "verify" | "correct" | "followUps" | "synthesize";

export interface StepPolicy {
  taskType: TaskType;
  /** true → the fast model role; false → primary. Must agree with roleForTask(taskType) for generate* helpers. */
  fast: boolean;
  /** Omitted → the configured default effort for the role. */
  reasoningEffort?: ReasoningEffort;
  /** Byte-stable instructions + tool definitions are marked cacheable. */
  cacheStablePrefix: boolean;
  /** Context-budget profile: the step's output and input sizes follow the model the router picks. */
  budget?: BudgetProfileId;
  /** Fixed output cap for short structured steps (no budget profile). */
  maxOutputTokens?: number;
}

export const RESEARCH_MODEL_POLICY: Record<ResearchStep, StepPolicy> = {
  plan: { taskType: "extract", fast: true, reasoningEffort: "low", cacheStablePrefix: true, maxOutputTokens: 700 },
  refine: { taskType: "extract", fast: true, reasoningEffort: "low", cacheStablePrefix: true, maxOutputTokens: 600 },
  triage: { taskType: "classify", fast: true, reasoningEffort: "low", cacheStablePrefix: true, maxOutputTokens: 400 },
  laneAgent: { taskType: "summarize", fast: true, reasoningEffort: "low", cacheStablePrefix: true, budget: "research_lane" },
  verify: { taskType: "extract", fast: true, reasoningEffort: "low", cacheStablePrefix: true, budget: "verify" },
  correct: { taskType: "summarize", fast: true, reasoningEffort: "low", cacheStablePrefix: true, budget: "deep_research_synthesis" },
  followUps: { taskType: "extract", fast: true, reasoningEffort: "low", cacheStablePrefix: true, maxOutputTokens: 400 },
  synthesize: { taskType: "synthesize", fast: false, cacheStablePrefix: true, budget: "deep_research_synthesis" },
};
