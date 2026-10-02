/**
 * Coded model limits (constitution §53.5: platform facts are coded, not remembered). Pure and client-safe.
 *
 * `modelLimits(provider, modelId, env)` maps a configured model id to its context window and maximum output, keyed on
 * the model FAMILY (model ids come only from configuration, never from this table). Unknown ids get a conservative
 * 128k context / 16k output so a misclassified model can never be sent more than it accepts.
 *
 * Sources (checked 2026-10-02; re-check when a family is added):
 * - OpenAI model pages (developers.openai.com):
 *   https://developers.openai.com/api/docs/models/gpt-5.4 — "1,050,000 context window", "128,000 max output tokens";
 *     "For models with a 1.05M context window (GPT-5.4 and GPT-5.4 Pro), prompts with >272K input tokens are priced at
 *     2x input and 1.5x output".
 *   https://developers.openai.com/api/docs/models/gpt-5.4-mini and /gpt-5.4-nano — "400,000 context window", "128,000 max output tokens".
 *   https://developers.openai.com/api/docs/models/gpt-5.5 — "1,050,000 context window", "128,000 max output tokens".
 *   https://developers.openai.com/api/docs/models/gpt-5.6 (gpt-5.6-sol) — "1,050,000 context window", "128,000 max output tokens".
 *   https://developers.openai.com/api/docs/models/gpt-5 and /gpt-5.2 — "400,000 context window", "Maximum input tokens: 272,000"
 *     (gpt-5), "128,000 max output tokens".
 *   https://developers.openai.com/api/docs/models (catalog) and /gpt-6-luna — gpt-6-astra, gpt-6.1-sol, gpt-6-luna:
 *     "Context window 1.05M", "Max output 128K tokens"; gpt-6-luna "Maximum input tokens: 922,000"; ">272K input tokens are
 *     priced at 2x input and cache rates and 1.5x output".
 * - Anthropic (platform.claude.com models overview; Claude on Amazon Bedrock):
 *   Fable 5 / 5.1, Mythos 5 / 5.1, Opus 5 / 5.5, Opus 4.6–4.8, Sonnet 4.6 / 5 / 5.5: 1M context, 128K max output;
 *   Haiku 4.5 and Sonnet / Opus 4.5: 200K context, 64K max output. "Claude Fable 5.1, … Claude Sonnet 4.6 have a
 *   1M-token context window on Amazon Bedrock" (https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock-legacy);
 *   Bedrock limits request payloads to 20 MB.
 *
 * Env overrides (clamped to [8k, the family ceiling]; a typo can only shrink, never exceed what the family accepts):
 * OPENAI_CONTEXT_WINDOW / OPENAI_MAX_OUTPUT_TOKENS, ANTHROPIC_CONTEXT_WINDOW, BEDROCK_CONTEXT_WINDOW.
 * (ANTHROPIC_/BEDROCK_MAX_OUTPUT_TOKENS remain the DEFAULT `max_tokens` of a request; see providers/env.ts.)
 */
import { normalizeClaudeModelId } from "./claude-models";
import type { ProviderId } from "./types";

export interface ModelLimits {
  /** Total tokens the model accepts (input + output). */
  contextWindow: number;
  /** Largest `max_output_tokens` / `max_tokens` the model accepts (reasoning / thinking tokens count against it). */
  maxOutput: number;
  /** Largest input the model accepts (contextWindow − reserved output where the publisher states it). */
  maxInput: number;
  /** Input size above which the publisher charges a long-context premium (OpenAI 1.05M models: 272K). */
  longContextThreshold?: number;
  /** Which row matched (for status pages and tests). */
  family: string;
  /** "coded" (family table), "env" (an override applied), "default" (unknown id: conservative). */
  basis: "coded" | "env" | "default";
}

export type LimitsEnv = Readonly<Record<string, string | undefined>>;

/** Conservative limits for an id no family row recognises. */
export const UNKNOWN_MODEL_LIMITS: Readonly<ModelLimits> = Object.freeze({ contextWindow: 128_000, maxOutput: 16_000, maxInput: 112_000, family: "unknown", basis: "default" as const });

interface Row { re: RegExp; family: string; contextWindow: number; maxOutput: number; maxInput?: number; longContextThreshold?: number }

/** OpenAI families, first match wins (more specific rows first). */
const OPENAI_ROWS: Row[] = [
  // chat-latest aliases are non-reasoning chat snapshots with smaller windows; never assume the reasoning family's size.
  { re: /chat-latest/i, family: "openai-chat-latest", contextWindow: 128_000, maxOutput: 16_384 },
  { re: /^gpt-6/i, family: "gpt-6", contextWindow: 1_050_000, maxOutput: 128_000, maxInput: 922_000, longContextThreshold: 272_000 },
  // gpt-5.x mini / nano: 400K (gpt-5.4-mini, gpt-5.4-nano).
  { re: /^gpt-5(\.\d+)?-(mini|nano)/i, family: "gpt-5-mini", contextWindow: 400_000, maxOutput: 128_000, maxInput: 272_000 },
  // gpt-5.4 and later full models (incl. -pro, -sol): 1.05M.
  { re: /^gpt-5\.([4-9]|\d{2,})/i, family: "gpt-5.4+", contextWindow: 1_050_000, maxOutput: 128_000, maxInput: 922_000, longContextThreshold: 272_000 },
  // gpt-5, gpt-5.1–5.3: 400K with 272K max input.
  { re: /^gpt-5/i, family: "gpt-5", contextWindow: 400_000, maxOutput: 128_000, maxInput: 272_000 },
  { re: /^o[1-9]/i, family: "openai-o-series", contextWindow: 200_000, maxOutput: 100_000 },
  { re: /^gpt-4\.1/i, family: "gpt-4.1", contextWindow: 1_047_576, maxOutput: 32_768 },
  { re: /^gpt-4o/i, family: "gpt-4o", contextWindow: 128_000, maxOutput: 16_384 },
];

/** Claude families over the normalized first-party id (Bedrock decorations stripped by normalizeClaudeModelId). */
const CLAUDE_ROWS: Row[] = [
  { re: /^claude-(fable|mythos)-/, family: "claude-fable", contextWindow: 1_000_000, maxOutput: 128_000 },
  { re: /^claude-opus-5(-\d+)?$/, family: "claude-opus-5", contextWindow: 1_000_000, maxOutput: 128_000 },
  { re: /^claude-sonnet-5(-\d+)?$/, family: "claude-sonnet-5", contextWindow: 1_000_000, maxOutput: 128_000 },
  { re: /^claude-opus-4-[678]$/, family: "claude-opus-4.6+", contextWindow: 1_000_000, maxOutput: 128_000 },
  { re: /^claude-sonnet-4-6$/, family: "claude-sonnet-4.6", contextWindow: 1_000_000, maxOutput: 128_000 },
  { re: /^claude-(opus|sonnet|haiku)-4-5$/, family: "claude-4.5", contextWindow: 200_000, maxOutput: 64_000 },
  { re: /^claude-sonnet-4(-0)?$/, family: "claude-sonnet-4", contextWindow: 200_000, maxOutput: 64_000 },
  { re: /^claude-opus-4(-[01])?$/, family: "claude-opus-4", contextWindow: 200_000, maxOutput: 32_000 },
  { re: /^claude-3-7-sonnet/, family: "claude-3.7", contextWindow: 200_000, maxOutput: 64_000 },
  { re: /^claude-3-5-/, family: "claude-3.5", contextWindow: 200_000, maxOutput: 8_192 },
  { re: /^claude-3-/, family: "claude-3", contextWindow: 200_000, maxOutput: 4_096 },
];

function fromRow(r: Row): ModelLimits {
  return { contextWindow: r.contextWindow, maxOutput: r.maxOutput, maxInput: r.maxInput ?? Math.max(1, r.contextWindow - r.maxOutput), longContextThreshold: r.longContextThreshold, family: r.family, basis: "coded" };
}

/** Positive integer from env, else null. */
function envInt(v: string | undefined): number | null {
  if (v == null || !v.trim()) return null;
  const n = Math.floor(Number(v.trim()));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Coded limits for a configured model id (env overrides applied, clamped). */
export function modelLimits(provider: ProviderId, modelId: string, env: LimitsEnv = {}): ModelLimits {
  const id = (modelId ?? "").trim();
  let base: ModelLimits | null = null;
  if (provider === "openai") {
    const row = OPENAI_ROWS.find((r) => r.re.test(id));
    base = row ? fromRow(row) : null;
  } else if (provider === "anthropic" || provider === "bedrock") {
    const norm = normalizeClaudeModelId(id);
    const row = CLAUDE_ROWS.find((r) => r.re.test(norm));
    base = row ? fromRow(row) : null;
  }
  // OpenRouter and unknown ids: conservative.
  const limits: ModelLimits = base ?? { ...UNKNOWN_MODEL_LIMITS };
  const ctxVar = provider === "openai" ? env.OPENAI_CONTEXT_WINDOW : provider === "anthropic" ? env.ANTHROPIC_CONTEXT_WINDOW : provider === "bedrock" ? env.BEDROCK_CONTEXT_WINDOW : undefined;
  const outVar = provider === "openai" ? env.OPENAI_MAX_OUTPUT_TOKENS : undefined;
  const ctx = envInt(ctxVar);
  const out = envInt(outVar);
  if (ctx == null && out == null) return limits;
  // An override may lower a coded limit, or (for an unknown id) raise the conservative default up to the largest
  // window any coded family has; it can never exceed the family's own ceiling.
  const ctxCeiling = base ? base.contextWindow : 1_050_000;
  const outCeiling = base ? base.maxOutput : 128_000;
  const contextWindow = ctx != null ? clamp(ctx, 8_000, ctxCeiling) : limits.contextWindow;
  const maxOutput = out != null ? clamp(out, 1_000, Math.min(outCeiling, contextWindow - 1_000)) : Math.min(limits.maxOutput, contextWindow - 1_000);
  const maxInput = Math.max(1, Math.min(limits.maxInput, contextWindow - maxOutput));
  return { ...limits, contextWindow, maxOutput, maxInput, basis: "env" };
}

/** Clamp a requested output size to the model's limit (undefined stays undefined). */
export function clampOutputTokens(requested: number | undefined, limits: Pick<ModelLimits, "maxOutput"> | null | undefined): number | undefined {
  if (requested == null) return undefined;
  if (!limits) return requested;
  return Math.max(1, Math.min(Math.floor(requested), limits.maxOutput));
}
