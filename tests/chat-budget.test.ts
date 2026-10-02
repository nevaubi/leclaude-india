/**
 * Chat sizes come from the chat_fast / chat_standard budget of the model that serves the tier: never below the old
 * constants (3,000 / 8,000 output tokens, 16 turns, 60,000-character tool results), larger on a 1.05M-context model,
 * and clamped to a small model's own output limit.
 */
import { describe, expect, it } from "vitest";
import { chatBudget, routeMessage } from "@/modules/chat/server/routing";
import { DEFAULT_TOOL_FLAGS } from "@/modules/chat/types";

describe("chat budgets", () => {
  it("keeps the old floors on an unknown model and grows on gpt-5.4", () => {
    const unknownFast = chatBudget("fast", "some-unknown-model", {});
    expect(unknownFast.maxOutputTokens).toBeGreaterThanOrEqual(3_000);
    expect(unknownFast.historyTurns).toBeGreaterThanOrEqual(16);
    expect(unknownFast.toolResultChars).toBeGreaterThanOrEqual(60_000);
    const unknownStd = chatBudget("standard", "some-unknown-model", {});
    expect(unknownStd.maxOutputTokens).toBeGreaterThanOrEqual(8_000);
    const big = chatBudget("standard", "gpt-5.4", {});
    expect(big.modelMaxOutput).toBe(128_000);
    expect(big.historyTurns).toBeGreaterThanOrEqual(unknownStd.historyTurns);
    expect(big.toolResultChars).toBeGreaterThan(unknownStd.toolResultChars);
    expect(big.maxOutputTokens).toBeLessThanOrEqual(32_000);
  });

  it("clamps output to the model's limit and honours AI_CONTEXT_SCALE without shrinking below the floors", () => {
    const small = chatBudget("standard", "gpt-4o", {});
    expect(small.modelMaxOutput).toBe(16_384);
    expect(small.maxOutputTokens).toBeLessThanOrEqual(16_384);
    const scaled = chatBudget("standard", "gpt-5.4", { AI_CONTEXT_SCALE: "0.25" });
    expect(scaled.toolResultChars).toBeGreaterThanOrEqual(60_000);
    expect(scaled.toolResultChars).toBeLessThanOrEqual(chatBudget("standard", "gpt-5.4", {}).toolResultChars);
  });

  it("routeMessage carries the budget of the tier's model", () => {
    const r = routeMessage("Compare the two arbitration clauses and explain why one is unenforceable", DEFAULT_TOOL_FLAGS, { models: { standard: "gpt-5.4", fast: "gpt-5.4-mini" } });
    expect(r.tier).toBe("standard");
    expect(r.modelMaxOutput).toBe(128_000);
    expect(r.maxOutputTokens).toBeGreaterThanOrEqual(8_000);
    const f = routeMessage("What is the capital of Karnataka?", DEFAULT_TOOL_FLAGS, { models: { standard: "gpt-5.4", fast: "gpt-5.4-mini" } });
    expect(f.tier).toBe("fast");
    expect(f.maxOutputTokens).toBeGreaterThanOrEqual(3_000);
    expect(f.historyTurns).toBeGreaterThanOrEqual(16);
  });
});
