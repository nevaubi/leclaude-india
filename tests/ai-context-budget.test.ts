/**
 * Context-budget profiles: resolved against the chosen model, never below the constants each surface used before
 * (floors), never above the safety ceilings or the model's own limits; AI_CONTEXT_SCALE shrinks input budgets toward the
 * floors; token estimates are script-aware (Indic text costs more tokens per character).
 */
import { describe, expect, it } from "vitest";
import { BUDGET_PROFILE_IDS, BUDGET_PROFILES, charsForTokens, clipWithMarker, contextScale, estimateTokens, resolveContextBudget } from "@/lib/ai/context-budget";
import { modelLimits } from "@/lib/ai/providers/model-limits";
import { aiBudget } from "@/lib/ai/config";

const BIG = modelLimits("openai", "gpt-5.4"); // 1.05M / 128K
const MINI = modelLimits("openai", "gpt-5.4-mini"); // 400K / 128K (272K input)
const NO_ENV = {};

describe("resolveContextBudget", () => {
  it("never shrinks below today's constants and never exceeds the profile ceilings or the model", () => {
    for (const id of BUDGET_PROFILE_IDS) {
      const spec = BUDGET_PROFILES[id];
      for (const model of [BIG, MINI, null, { contextWindow: 200_000, maxOutput: 64_000, maxInput: 136_000 }]) {
        const b = resolveContextBudget(id, model, NO_ENV);
        const label = `${id} @ ${model?.contextWindow ?? "default"}`;
        expect(b.maxOutputTokens, label).toBeGreaterThanOrEqual(Math.min(spec.outputTokens.floor, b.model.maxOutput));
        expect(b.maxOutputTokens, label).toBeLessThanOrEqual(Math.min(spec.outputTokens.ceil, b.model.maxOutput));
        expect(b.inputTokens, label).toBeLessThanOrEqual(spec.inputTokens.ceil);
        expect(b.inputTokens + b.maxOutputTokens, label).toBeLessThan(b.model.contextWindow);
        // Floors hold unless the model's input cannot carry them: then the model limit wins (85% of the input characters
        // for evidence, 50% for one tool result or the history, one source never above the evidence total).
        const caps = { totalEvidenceChars: b.inputChars * 0.85, toolResultChars: b.inputChars * 0.5, historyChars: b.inputChars * 0.5, perSourceChars: b.totalEvidenceChars, blockChars: Number.POSITIVE_INFINITY };
        for (const k of ["perSourceChars", "totalEvidenceChars", "toolResultChars", "historyChars", "blockChars"] as const) {
          const r = spec[k];
          expect(b[k], `${label} ${k}`).toBeGreaterThanOrEqual(Math.min(r.floor, Math.floor(caps[k])));
          expect(b[k], `${label} ${k}`).toBeLessThanOrEqual(Math.min(r.ceil, Math.ceil(caps[k])));
        }
        expect(b.maxFullSources, label).toBeGreaterThanOrEqual(spec.maxFullSources.floor);
        expect(Number.isFinite(b.inputChars) && b.inputChars > 0, label).toBe(true);
      }
    }
  });

  it("deep research on a 1.05M model: 12 sources in full at ~40k chars each, ≤2k-character blocks, under the 272K price tier", () => {
    const b = resolveContextBudget("deep_research_synthesis", BIG, NO_ENV);
    expect(b.maxFullSources).toBe(12);
    expect(b.perSourceChars).toBe(40_000);
    expect(b.blockChars).toBe(2_000);
    expect(b.totalEvidenceChars).toBeGreaterThanOrEqual(12 * 40_000);
    expect(b.inputTokens).toBeLessThanOrEqual(240_000);
    expect(b.maxOutputTokens).toBe(16_000);
    // A conservative unknown model still gets at least the old 6k/80k evidence.
    const small = resolveContextBudget("deep_research_synthesis", null, NO_ENV);
    expect(small.perSourceChars).toBeGreaterThanOrEqual(6_000);
    expect(small.totalEvidenceChars).toBeGreaterThanOrEqual(80_000);
    expect(small.totalEvidenceChars).toBeLessThan(b.totalEvidenceChars);
  });

  it("a small model's limit wins over a floor (never asks for more output than the model produces)", () => {
    const b = resolveContextBudget("litigation_draft", { contextWindow: 200_000, maxOutput: 4_096, maxInput: 195_000 }, NO_ENV);
    expect(b.maxOutputTokens).toBe(4_096);
  });

  it("the model limit wins over char floors on 128K / 200K models (verify evidence ≤ 85% of its input)", () => {
    for (const model of [null, { contextWindow: 200_000, maxOutput: 64_000, maxInput: 136_000 }, modelLimits("openai", "gpt-4o")]) {
      const v = resolveContextBudget("verify", model, NO_ENV);
      expect(v.totalEvidenceChars, `${model?.contextWindow ?? "default"}`).toBeLessThanOrEqual(v.inputChars * 0.85);
      expect(v.perSourceChars).toBeLessThanOrEqual(v.totalEvidenceChars);
      expect(v.toolResultChars).toBeLessThanOrEqual(v.inputChars * 0.5);
      expect(v.historyChars).toBeLessThanOrEqual(v.inputChars * 0.5);
      const chat = resolveContextBudget("chat_fast", model, NO_ENV);
      expect(chat.toolResultChars).toBeLessThanOrEqual(chat.inputChars * 0.5);
    }
  });

  it("AI_CONTEXT_SCALE shrinks input budgets toward the floors (clamped to 0.25–1)", () => {
    expect(contextScale({ AI_CONTEXT_SCALE: "0.1" })).toBe(0.25);
    expect(contextScale({ AI_CONTEXT_SCALE: "3" })).toBe(1);
    expect(contextScale({})).toBe(1);
    const full = resolveContextBudget("deep_research_synthesis", BIG, {});
    const quarter = resolveContextBudget("deep_research_synthesis", BIG, { AI_CONTEXT_SCALE: "0.25" });
    expect(quarter.scale).toBe(0.25);
    expect(quarter.inputTokens).toBeLessThan(full.inputTokens);
    expect(quarter.totalEvidenceChars).toBeLessThan(full.totalEvidenceChars);
    expect(quarter.totalEvidenceChars).toBeGreaterThanOrEqual(80_000);
    expect(quarter.maxOutputTokens).toBe(full.maxOutputTokens); // output is not a context cost
  });

  it("aiBudget resolves against the configured model for the profile's role (conservative without a provider)", () => {
    const b = aiBudget("verify", { env: {} });
    expect(b.model.contextWindow).toBe(128_000);
    expect(b.maxFullSources).toBeGreaterThanOrEqual(24);
    const configured = aiBudget("deep_research_synthesis", { env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5.4", OPENAI_FAST_MODEL: "gpt-5.4-mini" } });
    expect(configured.model.contextWindow).toBe(1_050_000);
    expect(aiBudget("research_lane", { env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5.4", OPENAI_FAST_MODEL: "gpt-5.4-mini" } }).model.contextWindow).toBe(400_000);
  });
});

describe("estimateTokens", () => {
  it("counts Indic scripts at more tokens per character than English", () => {
    const en = "The appellant was granted anticipatory bail subject to conditions.";
    const kn = "ಮೇಲ್ಮನವಿದಾರರಿಗೆ ಷರತ್ತುಗಳಿಗೆ ಒಳಪಟ್ಟು ನಿರೀಕ್ಷಣಾ ಜಾಮೀನು ನೀಡಲಾಯಿತು.";
    const hiText = "अपीलार्थी को शर्तों के अधीन अग्रिम जमानत दी गई।";
    expect(estimateTokens(en) / en.length).toBeLessThan(0.35);
    expect(estimateTokens(kn) / kn.length).toBeGreaterThan(0.6);
    expect(estimateTokens(hiText) / hiText.length).toBeGreaterThan(0.6);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  it("charsForTokens finds the largest prefix within a token budget; clipWithMarker never truncates silently", () => {
    const kn = "ಜಾಮೀನು ".repeat(200);
    const n = charsForTokens(kn, 100);
    expect(estimateTokens(kn.slice(0, n))).toBeLessThanOrEqual(100);
    expect(estimateTokens(kn.slice(0, n + 1))).toBeGreaterThan(100);
    expect(clipWithMarker("abc", 10)).toBe("abc");
    expect(clipWithMarker("abcdefghij", 4, "source")).toMatch(/^abcd\n…\[source truncated: 6 of 10 characters omitted\]$/);
  });
});
