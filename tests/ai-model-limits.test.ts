/**
 * Coded model limits (constitution §53.5): context window and maximum output per model family, env overrides that can
 * only shrink a coded limit, descriptors populated from configuration, and every output cap clamped to the model.
 */
import { describe, expect, it } from "vitest";
import { clampOutputTokens, modelLimits, UNKNOWN_MODEL_LIMITS } from "@/lib/ai/providers/model-limits";
import { outputTokenBudget } from "@/lib/ai/providers/openai-models";
import { describeModels, readRuntimeEnv } from "@/lib/ai/providers/env";
import { buildAnthropicRequest, THINKING_BINDING_BETA, type AnthropicWireOptions } from "@/lib/ai/providers/anthropic-wire";
import { buildOpenAIParams } from "@/lib/ai/providers/openai";
import { CAPABILITIES } from "@/lib/ai/capabilities";
import { resolveContextBudget } from "@/lib/ai/context-budget";
import type { InferenceRequest } from "@/lib/ai/providers/types";

const anthropicOpts = (model: string, extra: Partial<AnthropicWireOptions> = {}): AnthropicWireOptions => ({ platform: "anthropic", model, capabilities: CAPABILITIES.anthropic, defaultMaxTokens: 16_000, thinkingBudget: 0, toolExamples: false, structuredOutput: "auto", ...extra });
const hi: InferenceRequest = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

describe("model limits by family", () => {
  it("OpenAI families match the published model pages", () => {
    expect(modelLimits("openai", "gpt-5.4")).toMatchObject({ contextWindow: 1_050_000, maxOutput: 128_000, maxInput: 922_000, longContextThreshold: 272_000, family: "gpt-5.4+" });
    expect(modelLimits("openai", "gpt-5.4-2026-03-05").contextWindow).toBe(1_050_000);
    expect(modelLimits("openai", "gpt-5.5")).toMatchObject({ contextWindow: 1_050_000, maxOutput: 128_000 });
    expect(modelLimits("openai", "gpt-5.4-mini")).toMatchObject({ contextWindow: 400_000, maxOutput: 128_000, maxInput: 272_000 });
    expect(modelLimits("openai", "gpt-5.4-nano").contextWindow).toBe(400_000);
    expect(modelLimits("openai", "gpt-5")).toMatchObject({ contextWindow: 400_000, maxInput: 272_000 });
    expect(modelLimits("openai", "gpt-5.2").contextWindow).toBe(400_000);
    expect(modelLimits("openai", "gpt-6-luna")).toMatchObject({ contextWindow: 1_050_000, maxOutput: 128_000, maxInput: 922_000 });
    expect(modelLimits("openai", "gpt-6.1-sol").family).toBe("gpt-6");
    expect(modelLimits("openai", "gpt-5-chat-latest")).toMatchObject({ contextWindow: 128_000, maxOutput: 16_384 });
  });

  it("Claude families (first-party and Bedrock ids) match the Anthropic model table", () => {
    expect(modelLimits("anthropic", "claude-fable-5-1")).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000 });
    expect(modelLimits("anthropic", "claude-opus-5-5")).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000 });
    expect(modelLimits("bedrock", "global.anthropic.claude-opus-4-6-v1")).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000 });
    expect(modelLimits("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toMatchObject({ contextWindow: 200_000, maxOutput: 64_000 });
    expect(modelLimits("anthropic", "claude-haiku-4-5")).toMatchObject({ contextWindow: 200_000, maxOutput: 64_000 });
    expect(modelLimits("anthropic", "claude-sonnet-5-5").maxOutput).toBe(128_000);
  });

  it("unknown ids are conservative (128k / 16k)", () => {
    expect(modelLimits("openai", "mystery-model")).toMatchObject({ contextWindow: UNKNOWN_MODEL_LIMITS.contextWindow, maxOutput: 16_000, basis: "default" });
    expect(modelLimits("openrouter", "some/router")).toMatchObject({ contextWindow: 128_000, maxOutput: 16_000 });
    expect(modelLimits("anthropic", "claude-future-9")).toMatchObject({ contextWindow: 128_000, maxOutput: 16_000 });
  });

  it("env overrides are clamped: they can lower a coded limit but never exceed it", () => {
    expect(modelLimits("openai", "gpt-5.4", { OPENAI_CONTEXT_WINDOW: "300000", OPENAI_MAX_OUTPUT_TOKENS: "32000" })).toMatchObject({ contextWindow: 300_000, maxOutput: 32_000, maxInput: 268_000, basis: "env" });
    expect(modelLimits("openai", "gpt-5.4", { OPENAI_CONTEXT_WINDOW: "5000000", OPENAI_MAX_OUTPUT_TOKENS: "999999" })).toMatchObject({ contextWindow: 1_050_000, maxOutput: 128_000 });
    expect(modelLimits("openai", "gpt-5.4", { OPENAI_CONTEXT_WINDOW: "nonsense" }).basis).toBe("coded");
    expect(modelLimits("openai", "gpt-5.4", { OPENAI_CONTEXT_WINDOW: "10" }).contextWindow).toBe(8_000);
    expect(modelLimits("bedrock", "anthropic.claude-opus-4-6-v1", { BEDROCK_CONTEXT_WINDOW: "200000" }).contextWindow).toBe(200_000);
    // An unknown id may be raised by the operator, up to the largest coded window (and its input follows the window).
    expect(modelLimits("openai", "mystery-model", { OPENAI_CONTEXT_WINDOW: "400000" })).toMatchObject({ contextWindow: 400_000, maxOutput: 16_000, maxInput: 384_000 });
    expect(clampOutputTokens(200_000, { maxOutput: 128_000 })).toBe(128_000);
    expect(clampOutputTokens(undefined, { maxOutput: 128_000 })).toBeUndefined();
  });

  it("a window-only override never lets the output reservation eat the input (maxInput ≥ window / 2)", () => {
    for (const [provider, model, key] of [["openai", "gpt-5.4", "OPENAI_CONTEXT_WINDOW"], ["openai", "gpt-6-luna", "OPENAI_CONTEXT_WINDOW"], ["openai", "gpt-5.4-mini", "OPENAI_CONTEXT_WINDOW"], ["bedrock", "us.anthropic.claude-fable-5-1-v1", "BEDROCK_CONTEXT_WINDOW"], ["anthropic", "claude-opus-5-5", "ANTHROPIC_CONTEXT_WINDOW"]] as const) {
      for (const window of [128_000, 200_000, 300_000]) {
        const l = modelLimits(provider, model, { [key]: String(window) });
        expect(l.contextWindow, `${model} @ ${window}`).toBe(window);
        expect(l.maxInput, `${model} @ ${window}`).toBeGreaterThanOrEqual(window / 2);
        expect(l.maxInput + l.maxOutput, `${model} @ ${window}`).toBeLessThanOrEqual(window);
      }
    }
    // The reviewer's cases: 128K → 96K input (was 1K), 200K → 150K input (was 72K).
    expect(modelLimits("openai", "gpt-5.4", { OPENAI_CONTEXT_WINDOW: "128000" })).toMatchObject({ maxOutput: 32_000, maxInput: 96_000 });
    expect(modelLimits("openai", "gpt-5.4", { OPENAI_CONTEXT_WINDOW: "200000" })).toMatchObject({ maxOutput: 50_000, maxInput: 150_000 });
    // An explicit output override is still honoured as given.
    expect(modelLimits("openai", "gpt-5.4", { OPENAI_CONTEXT_WINDOW: "300000", OPENAI_MAX_OUTPUT_TOKENS: "32000" }).maxOutput).toBe(32_000);
  });

  it("deep research on a 200K Bedrock window keeps a real input budget (not the 32K floor)", () => {
    const fable200 = modelLimits("bedrock", "us.anthropic.claude-fable-5-1-v1", { BEDROCK_CONTEXT_WINDOW: "200000" });
    const b = resolveContextBudget("deep_research_synthesis", fable200, {});
    expect(b.inputTokens).toBeGreaterThan(60_000);
    expect(b.inputTokens + b.maxOutputTokens).toBeLessThan(200_000);
  });

  it("describeModels fills contextWindow / maxOutput / maxInput on chat models only", () => {
    const env = readRuntimeEnv({ OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5.4", OPENAI_FAST_MODEL: "gpt-5.4-mini", OPENAI_CONTEXT_WINDOW: "500000" });
    const models = describeModels(env);
    const primary = models.find((m) => m.roles.includes("primary"))!;
    const fast = models.find((m) => m.roles.includes("fast"))!;
    expect(primary).toMatchObject({ id: "gpt-5.4", contextWindow: 500_000, maxOutput: 128_000 });
    expect(fast).toMatchObject({ id: "gpt-5.4-mini", contextWindow: 400_000, maxOutput: 128_000, maxInput: 272_000 });
    expect(models.find((m) => m.roles.includes("embedding"))?.contextWindow).toBeUndefined();
  });
});

describe("output caps follow the model", () => {
  it("OpenAI max_output_tokens never exceeds the model's maximum output", () => {
    expect(outputTokenBudget("gpt-5.4", 60_000)).toBe(128_000);
    const p = buildOpenAIParams({ ...hi, maxOutputTokens: 60_000 }, "gpt-5.4", { reasoningEffort: "medium" }, { maxOutput: 100_000 }) as unknown as Record<string, unknown>;
    expect(p.max_output_tokens).toBe(100_000);
    expect(p).not.toHaveProperty("truncation");
    // A continuation never asks the API to drop the oldest items silently (truncation:auto): overflow is a typed
    // context_length error and the runtime replays the elided local history instead.
    const cont = buildOpenAIParams({ ...hi, previousResponseId: "resp_1" }, "gpt-5.4", { reasoningEffort: "medium" }) as unknown as Record<string, unknown>;
    expect(cont).not.toHaveProperty("truncation");
    expect(cont.previous_response_id).toBe("resp_1");
  });

  it("Anthropic max_tokens uses the model limit instead of a fixed 64k clamp", () => {
    // Fable 5.1 (128K output): 3 × 40,000 = 120,000 fits; previously clamped to 64,000.
    expect(buildAnthropicRequest({ ...hi, reasoningEffort: "high", maxOutputTokens: 40_000 }, anthropicOpts("claude-fable-5-1")).body.max_tokens).toBe(120_000);
    // Haiku 4.5 (64K output): never above 64,000.
    expect(buildAnthropicRequest({ ...hi, reasoningEffort: "none", maxOutputTokens: 90_000 }, anthropicOpts("claude-haiku-4-5")).body.max_tokens).toBe(64_000);
    // The descriptor's limit (env override) wins.
    expect(buildAnthropicRequest({ ...hi, reasoningEffort: "high", maxOutputTokens: 40_000 }, anthropicOpts("claude-fable-5-1", { maxOutputLimit: 50_000 })).body.max_tokens).toBe(50_000);
    // Budget thinking stays below max_tokens when the limit is small.
    const small = buildAnthropicRequest({ ...hi, reasoningEffort: "high", maxOutputTokens: 4_000 }, anthropicOpts("claude-haiku-4-5", { thinkingBudget: 70_000 })).body;
    expect(small.max_tokens).toBe(64_000);
    expect((small.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(64_000);
  });

  it("after the context guard edits history, thinking blocks bound to the old prefix are dropped, not rejected", () => {
    const edited = buildAnthropicRequest({ ...hi, reasoningEffort: "high", historyEdited: true }, anthropicOpts("claude-opus-5-5"));
    expect(edited.body.thinking).toMatchObject({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(edited.betas).toContain(THINKING_BINDING_BETA);
    // Thinking always on (effort none): the binding still goes with {type: "adaptive"}.
    expect(buildAnthropicRequest({ ...hi, reasoningEffort: "none", historyEdited: true }, anthropicOpts("claude-fable-5-1")).body.thinking).toMatchObject({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    const untouched = buildAnthropicRequest({ ...hi, reasoningEffort: "high" }, anthropicOpts("claude-opus-5-5"));
    expect(untouched.betas).not.toContain(THINKING_BINDING_BETA);
    expect(untouched.body.thinking).not.toHaveProperty("block_binding");
    // Sonnet 5 / 5.5 think when `thinking` is omitted (effort none): the binding still goes with {type: "adaptive"}.
    for (const m of ["claude-sonnet-5-5", "claude-sonnet-5", "us.anthropic.claude-sonnet-5-5-v1"]) {
      const r = buildAnthropicRequest({ ...hi, reasoningEffort: "none", historyEdited: true }, anthropicOpts(m));
      expect(r.body.thinking, m).toMatchObject({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
      expect(r.betas, m).toContain(THINKING_BINDING_BETA);
    }
    // Opus 4.6 / Sonnet 4.6 run without thinking when it is omitted: no thinking is switched on for them.
    expect(buildAnthropicRequest({ ...hi, reasoningEffort: "none", historyEdited: true }, anthropicOpts("claude-sonnet-4-6")).body).not.toHaveProperty("thinking");
    // No thinking (older family, effort none): nothing to bind.
    expect(buildAnthropicRequest({ ...hi, reasoningEffort: "none", historyEdited: true }, anthropicOpts("claude-haiku-4-5")).body).not.toHaveProperty("thinking");
  });
});
