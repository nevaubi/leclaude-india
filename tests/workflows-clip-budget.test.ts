/**
 * Workflow step input is clipped to at most half of the step's input budget, counted in tokens after the fixed prompt
 * (constitution: the model's real limit wins over the old character floors). Indic text, which costs more tokens per
 * character, gets fewer characters than English; the cut is logged and marked, never silent.
 */
import { describe, expect, it } from "vitest";
import { estimateTokens, resolveContextBudget } from "@/lib/ai/context-budget";
import { modelLimits } from "@/lib/ai/providers/model-limits";
import { clipToBudget, stepInputTokens, STEP_INPUT_SHARE } from "@/modules/workflows/executors";

const hindi = (n: number) => "न्यायालय ने अग्रिम जमानत की शर्तों पर विचार किया और अभियुक्त की भूमिका को देखा। ".repeat(Math.ceil(n / 70)).slice(0, n);
const english = (n: number) => "The court considered the conditions of anticipatory bail and the role of the accused. ".repeat(Math.ceil(n / 86)).slice(0, n);

describe("clipToBudget", () => {
  for (const [label, model] of [["gpt-4o (128K)", modelLimits("openai", "gpt-4o")], ["unknown OpenRouter id", modelLimits("openrouter", "vendor/some-model")], ["gpt-5.4", modelLimits("openai", "gpt-5.4")]] as const) {
    for (const profile of ["workflow_step", "workflow_agent", "litigation_draft"] as const) {
      it(`${profile} on ${label}: ≤ 50% of the input budget in tokens after the fixed prompt (Hindi and English)`, () => {
        const b = resolveContextBudget(profile, model, {});
        const instructions = english(6_000);
        const fixed = estimateTokens(instructions);
        const limit = Math.floor((b.inputTokens - fixed) * STEP_INPUT_SHARE);
        expect(stepInputTokens(b, [instructions])).toBe(limit);
        for (const text of [hindi(400_000), english(800_000)]) {
          const logs: string[] = [];
          const out = clipToBudget({ log: (m: string) => logs.push(m) }, text, b, "Source", { fixed: [instructions] });
          const body = out.split("\n…[Source truncated:")[0];
          expect(estimateTokens(body)).toBeLessThanOrEqual(limit);
          expect(estimateTokens(body)).toBeGreaterThan(limit - 200); // packed to the limit, not far below it
          expect(out).toMatch(/…\[Source truncated: \d+ of \d+ characters omitted\]$/);
          expect(logs[0]).toMatch(/^Source: .* characters \(~.* tokens\); the first .* were given to the model\./);
        }
        // Hindi gets fewer characters than English for the same budget; the whole step stays inside the model's input.
        const hiChars = clipToBudget({ log: () => {} }, hindi(400_000), b, "S", { fixed: [instructions] }).length;
        const enChars = clipToBudget({ log: () => {} }, english(800_000), b, "S", { fixed: [instructions] }).length;
        expect(hiChars).toBeLessThan(enChars);
        expect(fixed + limit).toBeLessThan(b.model.maxInput);
      });
    }
  }

  it("leaves input that fits untouched and never asks for more than half even when the caller passes a larger share", () => {
    const b = resolveContextBudget("workflow_step", modelLimits("openai", "gpt-4o"), {});
    const logs: string[] = [];
    expect(clipToBudget({ log: (m: string) => logs.push(m) }, "short text", b, "Text")).toBe("short text");
    expect(logs).toEqual([]);
    expect(stepInputTokens(b, [], 0.9)).toBe(Math.floor(b.inputTokens * 0.5));
  });
});
