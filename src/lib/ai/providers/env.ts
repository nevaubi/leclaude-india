/**
 * Runtime configuration read from the environment only (constitution §15, §19, §41): which providers have
 * credentials, which model ids they serve per role, the preferred provider and the external-router data policy.
 * Nothing here guesses a model id for Anthropic, Bedrock or OpenRouter; the OpenAI defaults are the legacy
 * `aiConfig()` defaults that existing deployments already rely on.
 *
 * Pure over an env-like object (unit-testable) and client-safe: it never imports a provider SDK. Secrets are
 * returned only to server-side callers (the registry); `describeModels()` and `providerStatuses()` carry none.
 */
import { CAPABILITIES } from "../capabilities";
import { isReasoningModel } from "./openai-models";
import { claudeFamily } from "./claude-models";
import { modelLimits, type LimitsEnv } from "./model-limits";
import type { ModelDescriptor, ModelRole, ProviderId } from "./types";

export type Env = Record<string, string | undefined>;

export const OPENAI_DEFAULTS = { model: "gpt-5.4", fastModel: "gpt-5.4-mini", embeddingModel: "text-embedding-3-large", imageModel: "gpt-image-1.5" } as const;

export type ReasoningEffortSetting = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface OpenAIEnv {
  apiKey?: string;
  baseURL?: string;
  model: string;
  fastModel: string;
  embeddingModel: string;
  imageModel: string;
  reasoningEffort: ReasoningEffortSetting;
}

export interface AnthropicEnv {
  apiKey?: string;
  /** Workspace for an organisation-level (unscoped) API key; sent as `anthropic-workspace-id`. */
  workspaceId?: string;
  baseURL: string;
  model?: string;
  fastModel?: string;
  /** Legacy `budget_tokens` for budget-family models (Haiku 4.5, Sonnet 4.5 and older); 0 disables extended thinking there. */
  thinkingBudget: number;
  maxOutputTokens: number;
  toolExamples: boolean;
  structuredOutput: "auto" | "native" | "tool";
}

export interface BedrockEnv {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  bearerToken?: string;
  model?: string;
  fastModel?: string;
  embeddingModel?: string;
  thinkingBudget: number;
  maxOutputTokens: number;
  structuredOutput: "auto" | "native" | "tool";
}

export interface OpenRouterEnv {
  apiKey?: string;
  routerModel?: string;
  baseURL: string;
  referer?: string;
  title: string;
}

export interface RuntimeEnv {
  preferred: ProviderId | null;
  allowExternalForMatterData: boolean;
  /** Model-limit overrides (OPENAI_CONTEXT_WINDOW, OPENAI_MAX_OUTPUT_TOKENS, ANTHROPIC_/BEDROCK_CONTEXT_WINDOW); see model-limits.ts. */
  limits?: LimitsEnv;
  openai: OpenAIEnv;
  anthropic: AnthropicEnv;
  bedrock: BedrockEnv;
  openrouter: OpenRouterEnv;
}

const trim = (v: string | undefined) => (v == null || !v.trim() ? undefined : v.trim());
const flag = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? "").trim());
const num = (v: string | undefined, fallback: number) => { const n = Number(trim(v)); return Number.isFinite(n) && n >= 0 ? n : fallback; };
const EFFORTS: ReasoningEffortSetting[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const structuredMode = (v: string | undefined): "auto" | "native" | "tool" => { const s = (trim(v) ?? "auto").toLowerCase(); return s === "tool" || s === "native" ? s : "auto"; };

export function readRuntimeEnv(env: Env = process.env as Env): RuntimeEnv {
  const preferredRaw = (trim(env.MODEL_PROVIDER) ?? "").toLowerCase();
  const preferred = (["bedrock", "anthropic", "openai", "openrouter"] as ProviderId[]).find((p) => p === preferredRaw) ?? null;
  const effort = (trim(env.OPENAI_REASONING_EFFORT) ?? "medium") as ReasoningEffortSetting;
  return {
    preferred,
    allowExternalForMatterData: flag(env.ROUTER_ALLOW_MATTER_DATA),
    limits: Object.fromEntries((["OPENAI_CONTEXT_WINDOW", "OPENAI_MAX_OUTPUT_TOKENS", "ANTHROPIC_CONTEXT_WINDOW", "BEDROCK_CONTEXT_WINDOW"] as const).map((k) => [k, trim(env[k])]).filter(([, v]) => v != null)) as LimitsEnv,
    openai: {
      apiKey: trim(env.OPENAI_API_KEY),
      baseURL: trim(env.OPENAI_BASE_URL),
      model: trim(env.OPENAI_MODEL) ?? OPENAI_DEFAULTS.model,
      fastModel: trim(env.OPENAI_FAST_MODEL) ?? OPENAI_DEFAULTS.fastModel,
      embeddingModel: trim(env.OPENAI_EMBEDDING_MODEL) ?? OPENAI_DEFAULTS.embeddingModel,
      imageModel: trim(env.OPENAI_IMAGE_MODEL) ?? OPENAI_DEFAULTS.imageModel,
      reasoningEffort: EFFORTS.includes(effort) ? effort : "medium",
    },
    anthropic: {
      apiKey: trim(env.ANTHROPIC_API_KEY),
      workspaceId: trim(env.ANTHROPIC_WORKSPACE_ID),
      baseURL: (trim(env.ANTHROPIC_BASE_URL) ?? "https://api.anthropic.com").replace(/\/+$/, ""),
      model: trim(env.ANTHROPIC_MODEL),
      fastModel: trim(env.ANTHROPIC_FAST_MODEL),
      thinkingBudget: Math.floor(num(env.ANTHROPIC_THINKING_BUDGET, 0)),
      maxOutputTokens: Math.floor(num(env.ANTHROPIC_MAX_OUTPUT_TOKENS, 16_000)) || 16_000,
      toolExamples: flag(env.ANTHROPIC_TOOL_EXAMPLES),
      structuredOutput: structuredMode(env.ANTHROPIC_STRUCTURED_OUTPUT),
    },
    bedrock: {
      region: trim(env.AWS_REGION) ?? trim(env.AWS_DEFAULT_REGION),
      accessKeyId: trim(env.AWS_ACCESS_KEY_ID),
      secretAccessKey: trim(env.AWS_SECRET_ACCESS_KEY),
      sessionToken: trim(env.AWS_SESSION_TOKEN),
      bearerToken: trim(env.AWS_BEARER_TOKEN_BEDROCK),
      model: trim(env.BEDROCK_MODEL),
      fastModel: trim(env.BEDROCK_FAST_MODEL),
      embeddingModel: trim(env.BEDROCK_EMBEDDING_MODEL),
      thinkingBudget: Math.floor(num(env.BEDROCK_THINKING_BUDGET, 0)),
      maxOutputTokens: Math.floor(num(env.BEDROCK_MAX_OUTPUT_TOKENS, 16_000)) || 16_000,
      structuredOutput: structuredMode(env.BEDROCK_STRUCTURED_OUTPUT),
    },
    openrouter: {
      apiKey: trim(env.OPENROUTER_API_KEY),
      routerModel: trim(env.OPENROUTER_ROUTER_MODEL),
      baseURL: (trim(env.OPENROUTER_BASE_URL) ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
      referer: trim(env.OPENROUTER_HTTP_REFERER) ?? trim(env.NEXT_PUBLIC_APP_URL),
      title: trim(env.NEXT_PUBLIC_APP_NAME) ?? "LeClaude",
    },
  };
}

// ---------------- Configuration state (no secrets) ----------------

export interface ProviderConfigState {
  id: ProviderId;
  configured: boolean;
  /** Env variables that are set (names only). */
  present: string[];
  /** What is still needed for the provider to count as configured (names only). */
  missing: string[];
}

export function providerStates(cfg: RuntimeEnv): ProviderConfigState[] {
  const o = cfg.openai, a = cfg.anthropic, b = cfg.bedrock, r = cfg.openrouter;
  const bedrockCreds = Boolean(b.bearerToken || (b.accessKeyId && b.secretAccessKey));
  const bedrockModel = Boolean(b.model || b.embeddingModel);
  return [
    { id: "bedrock", configured: Boolean(b.region && bedrockCreds && bedrockModel), present: [b.region ? "AWS_REGION" : null, b.bearerToken ? "AWS_BEARER_TOKEN_BEDROCK" : null, b.accessKeyId ? "AWS_ACCESS_KEY_ID" : null, b.secretAccessKey ? "AWS_SECRET_ACCESS_KEY" : null, b.sessionToken ? "AWS_SESSION_TOKEN" : null, b.model ? "BEDROCK_MODEL" : null, b.fastModel ? "BEDROCK_FAST_MODEL" : null, b.embeddingModel ? "BEDROCK_EMBEDDING_MODEL" : null].filter((x): x is string => Boolean(x)), missing: [b.region ? null : "AWS_REGION", bedrockCreds ? null : "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_BEARER_TOKEN_BEDROCK)", bedrockModel ? null : "BEDROCK_MODEL"].filter((x): x is string => Boolean(x)) },
    { id: "anthropic", configured: Boolean(a.apiKey && a.model), present: [a.apiKey ? "ANTHROPIC_API_KEY" : null, a.model ? "ANTHROPIC_MODEL" : null, a.fastModel ? "ANTHROPIC_FAST_MODEL" : null].filter((x): x is string => Boolean(x)), missing: [a.apiKey ? null : "ANTHROPIC_API_KEY", a.model ? null : "ANTHROPIC_MODEL"].filter((x): x is string => Boolean(x)) },
    { id: "openai", configured: Boolean(o.apiKey), present: [o.apiKey ? "OPENAI_API_KEY" : null, "OPENAI_MODEL", "OPENAI_FAST_MODEL", "OPENAI_EMBEDDING_MODEL", "OPENAI_IMAGE_MODEL"].filter((x): x is string => Boolean(x)), missing: o.apiKey ? [] : ["OPENAI_API_KEY"] },
    { id: "openrouter", configured: Boolean(r.apiKey && r.routerModel), present: [r.apiKey ? "OPENROUTER_API_KEY" : null, r.routerModel ? "OPENROUTER_ROUTER_MODEL" : null].filter((x): x is string => Boolean(x)), missing: [r.apiKey ? null : "OPENROUTER_API_KEY", r.routerModel ? null : "OPENROUTER_ROUTER_MODEL"].filter((x): x is string => Boolean(x)) },
  ];
}

// ---------------- Model descriptors ----------------

function claudeReasoning(model: string, budget: number): boolean {
  const f = claudeFamily(model);
  return budget > 0 || f === "adaptive-always" || f === "adaptive";
}

/** Models the configured providers serve, with roles derived from which variables name them. */
export function describeModels(cfg: RuntimeEnv): ModelDescriptor[] {
  const states = Object.fromEntries(providerStates(cfg).map((s) => [s.id, s.configured])) as Record<ProviderId, boolean>;
  const out: ModelDescriptor[] = [];
  const push = (d: ModelDescriptor) => {
    const existing = out.find((m) => m.provider === d.provider && m.id === d.id);
    if (existing) { for (const r of d.roles) if (!existing.roles.includes(r)) existing.roles.push(r); return; }
    // Coded context window / max output for chat-capable models (embedding and image models have no such budget).
    if (d.capabilities.messages && d.contextWindow == null) {
      const lim = modelLimits(d.provider, d.id, cfg.limits ?? {});
      d.contextWindow = lim.contextWindow;
      d.maxOutput = lim.maxOutput;
      d.maxInput = lim.maxInput;
    }
    out.push(d);
  };
  const chatRoles = (hasFast: boolean): ModelRole[] => (hasFast ? ["primary", "vision"] : ["primary", "vision", "fast", "router"]);

  if (states.bedrock) {
    const b = cfg.bedrock, caps = CAPABILITIES.bedrock;
    if (b.model) push({ id: b.model, provider: "bedrock", roles: chatRoles(Boolean(b.fastModel)), capabilities: caps, privacy: "internal", reasoning: claudeReasoning(b.model, b.thinkingBudget), costTier: 3 });
    if (b.fastModel) push({ id: b.fastModel, provider: "bedrock", roles: ["fast", "router", "vision"], capabilities: caps, privacy: "internal", reasoning: claudeReasoning(b.fastModel, b.thinkingBudget), costTier: 1 });
    if (b.embeddingModel) push({ id: b.embeddingModel, provider: "bedrock", roles: ["embedding"], capabilities: { ...caps, messages: false, streaming: false, vision: false, structuredOutput: false, thinking: false }, privacy: "internal", reasoning: false, costTier: 1 });
  }
  if (states.anthropic) {
    const a = cfg.anthropic, caps = CAPABILITIES.anthropic;
    if (a.model) push({ id: a.model, provider: "anthropic", roles: chatRoles(Boolean(a.fastModel)), capabilities: caps, privacy: "internal", reasoning: claudeReasoning(a.model, a.thinkingBudget), costTier: 3 });
    if (a.fastModel) push({ id: a.fastModel, provider: "anthropic", roles: ["fast", "router", "vision"], capabilities: caps, privacy: "internal", reasoning: claudeReasoning(a.fastModel, a.thinkingBudget), costTier: 1 });
  }
  if (states.openai) {
    const o = cfg.openai, caps = CAPABILITIES.openai;
    push({ id: o.model, provider: "openai", roles: ["primary", "vision"], capabilities: caps, privacy: "internal", reasoning: isReasoningModel(o.model), costTier: 3 });
    push({ id: o.fastModel, provider: "openai", roles: ["fast", "router", "vision"], capabilities: caps, privacy: "internal", reasoning: isReasoningModel(o.fastModel), costTier: 1 });
    push({ id: o.embeddingModel, provider: "openai", roles: ["embedding"], capabilities: { ...caps, messages: false, streaming: false, vision: false, structuredOutput: false, thinking: false, previousResponseId: false }, privacy: "internal", reasoning: false, costTier: 1 });
    push({ id: o.imageModel, provider: "openai", roles: ["image"], capabilities: { ...caps, messages: false, streaming: false, vision: false, structuredOutput: false, thinking: false, previousResponseId: false }, privacy: "internal", reasoning: false, costTier: 2 });
  }
  if (states.openrouter) {
    const r = cfg.openrouter;
    if (r.routerModel) push({ id: r.routerModel, provider: "openrouter", roles: ["router"], capabilities: CAPABILITIES.openrouter, privacy: "external", reasoning: false, costTier: 1 });
  }
  return out;
}
