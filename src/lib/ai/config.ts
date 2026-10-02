/**
 * Model configuration resolved from the environment (client-safe: no provider SDK, no database, no secrets exposed).
 *
 * `aiConfig()` keeps its historical shape — `model` / `fastModel` / `embeddingModel` / `imageModel` are the ids the
 * router resolves for those roles across every configured provider (Bedrock → Anthropic → OpenAI, or the
 * MODEL_PROVIDER preference), so callers that pass `model: cfg.fastModel` keep working whichever provider serves it.
 * `hasKey` is true when some provider can serve the primary role.
 */
import { OPENAI_DEFAULTS, describeModels, providerStates, readRuntimeEnv, type ReasoningEffortSetting, type RuntimeEnv } from "./providers/env";
import { InferenceError, type ModelDescriptor, type ModelRole, type PrivacyBoundary, type ProviderId, type RoutingDecision, type TaskType } from "./providers/types";
import { routeModel } from "./router";
import { resolveContextBudget, type BudgetProfileId, type ResolvedBudget } from "./context-budget";

export { isReasoningModel } from "./providers/openai-models";
export type { BudgetProfileId, ResolvedBudget } from "./context-budget";

export interface AIConfig {
  model: string;
  fastModel: string;
  embeddingModel: string;
  imageModel: string;
  reasoningEffort: ReasoningEffortSetting;
  baseURL?: string;
  /** True when a configured provider serves the primary role (any provider, not only OpenAI). */
  hasKey: boolean;
  /** Provider that serves each role; null when nothing configured serves it. */
  provider: ProviderId | null;
  fastProvider: ProviderId | null;
  embeddingProvider: ProviderId | null;
  imageProvider: ProviderId | null;
  preferredProvider: ProviderId | null;
  configuredProviders: ProviderId[];
}

const ROLE_TASK: Record<ModelRole, TaskType> = { primary: "chat", fast: "classify", router: "route", embedding: "embed", image: "image", vision: "vision" };

function tryRoute(role: ModelRole, models: ModelDescriptor[], env: RuntimeEnv, privacy: PrivacyBoundary = "internal"): RoutingDecision | null {
  try {
    return routeModel({ taskType: ROLE_TASK[role], role, privacy }, { available: models, preferred: env.preferred, allowExternalForMatterData: env.allowExternalForMatterData });
  } catch (e) {
    if (e instanceof InferenceError) return null;
    throw e;
  }
}

export function aiConfig(): AIConfig {
  const env = readRuntimeEnv();
  const models = describeModels(env);
  const primary = tryRoute("primary", models, env);
  const fast = tryRoute("fast", models, env);
  const embedding = tryRoute("embedding", models, env);
  const image = tryRoute("image", models, env);
  return {
    model: primary?.model ?? env.openai.model ?? OPENAI_DEFAULTS.model,
    fastModel: fast?.model ?? env.openai.fastModel ?? OPENAI_DEFAULTS.fastModel,
    embeddingModel: embedding?.model ?? env.openai.embeddingModel ?? OPENAI_DEFAULTS.embeddingModel,
    imageModel: image?.model ?? env.openai.imageModel ?? OPENAI_DEFAULTS.imageModel,
    reasoningEffort: env.openai.reasoningEffort,
    baseURL: env.openai.baseURL,
    hasKey: primary != null,
    provider: primary?.provider ?? null,
    fastProvider: fast?.provider ?? null,
    embeddingProvider: embedding?.provider ?? null,
    imageProvider: image?.provider ?? null,
    preferredProvider: env.preferred,
    configuredProviders: providerStates(env).filter((s) => s.configured).map((s) => s.id),
  };
}

export interface AIRuntimeStatus {
  configured: boolean;
  preferred: ProviderId | null;
  allowExternalForMatterData: boolean;
  providers: {
    id: ProviderId;
    configured: boolean;
    /** Env variable names that are set (never values). */
    present: string[];
    /** Env variable names still needed for the provider to count as configured. */
    missing: string[];
    models: { id: string; roles: ModelRole[]; privacy: PrivacyBoundary; reasoning: boolean }[];
  }[];
  /** Chosen model per role, or null when no configured provider serves the role. */
  roles: Record<ModelRole, { provider: ProviderId; model: string } | null>;
  /** Roles nobody serves, with the shortest fix. */
  missing: string[];
}

/** Configuration state for the settings UI: which providers are configured, which model serves each role, what is missing. No secrets. */
export function aiRuntimeStatus(): AIRuntimeStatus {
  const env = readRuntimeEnv();
  const models = describeModels(env);
  const states = providerStates(env);
  const roles = {} as AIRuntimeStatus["roles"];
  for (const role of ["primary", "fast", "router", "embedding", "image", "vision"] as ModelRole[]) {
    const d = tryRoute(role, models, env, role === "router" ? "external" : "internal");
    roles[role] = d ? { provider: d.provider, model: d.model } : null;
  }
  const missing: string[] = [];
  if (!roles.primary) missing.push("primary model: set ANTHROPIC_API_KEY + ANTHROPIC_MODEL, AWS credentials + BEDROCK_MODEL, or OPENAI_API_KEY");
  if (!roles.embedding) missing.push("embeddings: set OPENAI_API_KEY or BEDROCK_EMBEDDING_MODEL (semantic search is keyword-only without them)");
  if (!roles.image) missing.push("image generation: set OPENAI_API_KEY (OPENAI_IMAGE_MODEL)");
  return {
    configured: roles.primary != null,
    preferred: env.preferred,
    allowExternalForMatterData: env.allowExternalForMatterData,
    providers: states.map((s) => ({ id: s.id, configured: s.configured, present: s.present, missing: s.missing, models: models.filter((m) => m.provider === s.id).map((m) => ({ id: m.id, roles: m.roles, privacy: m.privacy, reasoning: m.reasoning })) })),
    roles,
    missing,
  };
}

/** Model role a budget profile runs on by default (bounded extraction on the fast role, synthesis and drafting on primary). */
const PROFILE_ROLE: Record<BudgetProfileId, "primary" | "fast"> = {
  chat_fast: "fast", chat_standard: "primary", deep_research_synthesis: "primary", research_lane: "fast", verify: "fast",
  workflow_step: "primary", workflow_agent: "primary", litigation_draft: "primary", ediscovery_doc: "fast", ediscovery_batch: "fast",
  deposition_segment: "primary", documents_window: "fast", documents_ask: "primary", office_agent: "primary",
};

/**
 * The budget for a profile resolved against the model the router would pick for its role (or `opts.fast` / `opts.role`).
 * Without a configured provider it resolves against conservative default limits (floors still apply).
 */
export function aiBudget(profile: BudgetProfileId, opts: { fast?: boolean; role?: ModelRole; env?: Record<string, string | undefined> } = {}): ResolvedBudget {
  const env = readRuntimeEnv(opts.env as Record<string, string | undefined> | undefined);
  const role: ModelRole = opts.role ?? (opts.fast != null ? (opts.fast ? "fast" : "primary") : PROFILE_ROLE[profile]);
  const decision = tryRoute(role, describeModels(env), env);
  return resolveContextBudget(profile, decision?.descriptor ?? null, opts.env);
}

export class AIConfigError extends Error {
  status = 503;
  constructor(message = "No model provider is configured. Add OPENAI_API_KEY, ANTHROPIC_API_KEY + ANTHROPIC_MODEL, or AWS credentials + BEDROCK_MODEL to .env.local to enable AI features.") {
    super(message);
    this.name = "AIConfigError";
  }
}
