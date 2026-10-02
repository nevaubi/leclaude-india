/**
 * The runtime context guard: the oldest tool results are elided (never the latest tool turn, never user turns or
 * evidence) when the replayed history would exceed the input budget; a context-length error from the provider is a
 * typed, retry-once-after-aggressive-elision path instead of an "unknown" failure; budgets default the output cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponseInput } from "openai/resources/responses/responses";

const calls: Array<Record<string, unknown>> = [];
let failFirst: { status: number; message: string } | null = null;

function stream(events: unknown[]) {
  return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
}
vi.mock("@/lib/ai/openai", () => ({
  getOpenAI: () => ({
    responses: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (failFirst && calls.length === 1) { const e = Object.assign(new Error(failFirst.message), { status: failFirst.status }); throw e; }
        return stream([
          { type: "response.output_text.delta", delta: "ok", item_id: "m", output_index: 0 },
          { type: "response.completed", response: { id: `resp_${calls.length}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, output: [] } },
        ]);
      },
    },
  }),
}));

import { guardHistory, runAgent, type AgentEvent } from "@/lib/ai/agent";
import { mapOpenAIError } from "@/lib/ai/providers/openai";
import { InferenceError, type InferenceMessage } from "@/lib/ai/providers/types";
import { resolveContextBudget } from "@/lib/ai/context-budget";
import { modelLimits } from "@/lib/ai/providers/model-limits";
import { outputTokenBudget } from "@/lib/ai/providers/openai-models";

const big = (label: string, n: number) => `${label} `.repeat(Math.ceil(n / (label.length + 1))).slice(0, n);

function toolTurns(sizes: number[]): InferenceMessage[] {
  const out: InferenceMessage[] = [{ role: "user", content: [{ type: "text", text: "Research the question." }] }];
  sizes.forEach((n, i) => {
    out.push({ role: "assistant", content: [{ type: "tool_call", id: `c${i}`, name: i % 2 ? "read_judgment_text" : "read_law_section", args: { id: `x${i}` } }] });
    out.push({ role: "tool", content: [{ type: "tool_result", callId: `c${i}`, content: big(`result${i}`, n) }] });
  });
  return out;
}

beforeEach(() => { calls.length = 0; failFirst = null; process.env.OPENAI_API_KEY = "test"; });

describe("guardHistory", () => {
  it("elides the oldest tool results first, never the latest tool turn, and says how to re-read them", () => {
    const h = toolTurns([40_000, 40_000, 40_000]);
    const r = guardHistory(h, { maxTokens: 20_000 });
    expect(r.elided).toBe(2);
    expect(r.tokens).toBeLessThanOrEqual(20_000 + 12_000); // the latest result alone is ~11k tokens
    const results = h.filter((m) => m.role === "tool").map((m) => (m.content[0] as { content: string }).content);
    expect(results[0]).toBe("[elided 40000 chars — re-read with read_law_section]");
    expect(results[1]).toBe("[elided 40000 chars — re-read with read_judgment_text]");
    expect(results[2].length).toBe(40_000); // the latest tool turn is untouched
    expect((h[0].content[0] as { text: string }).text).toBe("Research the question.");
  });

  it("does nothing when the history fits, and aggressive mode targets 60% of the budget", () => {
    const fits = toolTurns([2_000, 2_000]);
    expect(guardHistory(fits, { maxTokens: 50_000 }).elided).toBe(0);
    const h = toolTurns([30_000, 30_000, 30_000, 30_000]);
    const normal = guardHistory(toolTurns([30_000, 30_000, 30_000, 30_000]), { maxTokens: 30_000 });
    const aggressive = guardHistory(h, { maxTokens: 30_000, aggressive: true });
    expect(aggressive.elided).toBeGreaterThanOrEqual(normal.elided);
    expect(aggressive.tokens).toBeLessThanOrEqual(normal.tokens);
  });
});

describe("runAgent budgets and the context guard", () => {
  it("defaults max_output_tokens from the budget profile of the routed model", async () => {
    const res = await runAgent({ instructions: "test", input: "hello", onEvent: () => {}, budget: "chat_fast" });
    const b = resolveContextBudget("chat_fast", modelLimits("openai", "gpt-5.4"));
    expect(res.budget?.maxOutputTokens).toBe(b.maxOutputTokens);
    expect(calls[0].max_output_tokens).toBe(outputTokenBudget("gpt-5.4", b.maxOutputTokens));
    // An explicit cap still wins.
    calls.length = 0;
    await runAgent({ instructions: "test", input: "hello", onEvent: () => {}, budget: "chat_fast", maxOutputTokens: 500 });
    expect(calls[0].max_output_tokens).toBe(outputTokenBudget("gpt-5.4", 500));
  });

  it("elides old tool results before a request that would exceed the input budget", async () => {
    // chat_fast on gpt-5.4: ~96k input tokens; two 250k-character tool results (~67k tokens each) do not fit.
    const input = [
      { role: "user", content: "question" },
      { type: "function_call", call_id: "a", name: "read_judgment_text", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: big("alpha", 250_000) },
      { type: "function_call", call_id: "b", name: "read_law_section", arguments: "{}" },
      { type: "function_call_output", call_id: "b", output: big("beta", 250_000) },
    ] as unknown as ResponseInput;
    const events: AgentEvent[] = [];
    const res = await runAgent({ instructions: "test", input, onEvent: (e) => events.push(e), budget: "chat_fast" });
    expect(res.elided).toBe(1);
    const sent = calls[0].input as Array<Record<string, unknown>>;
    const outputs = sent.filter((i) => i.type === "function_call_output").map((i) => String(i.output));
    expect(outputs[0]).toBe("[elided 250000 chars — re-read with read_judgment_text]");
    expect(outputs[1].length).toBe(250_000);
    expect(events.some((e) => e.type === "status" && /Context budget: elided 1 earlier tool result/.test(e.message))).toBe(true);
  });

  it("maps a provider context-length 400 to a typed error and retries once after aggressive elision", async () => {
    expect(mapOpenAIError({ status: 400, message: "This model's maximum context length is 1050000 tokens." })).toMatchObject({ code: "context_length", retryable: false });
    expect(mapOpenAIError({ status: 400, code: "context_length_exceeded", message: "too long" })).toBeInstanceOf(InferenceError);
    expect((mapOpenAIError({ status: 400, message: "Invalid schema" }) as InferenceError).code).toBe("unknown");

    failFirst = { status: 400, message: "Your input exceeds the context window of this model." };
    const input = [
      { role: "user", content: "question" },
      { type: "function_call", call_id: "a", name: "read_judgment_text", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: big("alpha", 5_000) },
      { type: "function_call", call_id: "b", name: "read_law_section", arguments: "{}" },
      { type: "function_call_output", call_id: "b", output: big("beta", 5_000) },
    ] as unknown as ResponseInput;
    const events: AgentEvent[] = [];
    const res = await runAgent({ instructions: "test", input, onEvent: (e) => events.push(e) });
    expect(res.text).toBe("ok");
    expect(calls.length).toBe(2);
    const retried = (calls[1].input as Array<Record<string, unknown>>).filter((i) => i.type === "function_call_output").map((i) => String(i.output));
    expect(retried[0]).toMatch(/^\[elided 5000 chars — re-read with read_judgment_text\]$/);
    expect(retried[1].length).toBe(5_000);
    expect(events.some((e) => e.type === "status" && /Context window exceeded; elided 1 earlier tool result/.test(e.message))).toBe(true);
  });

  it("fails honestly when nothing can be elided", async () => {
    failFirst = { status: 400, message: "prompt is too long: 2000000 tokens > 1050000 maximum" };
    await expect(runAgent({ instructions: "test", input: "one huge question", onEvent: () => {} })).rejects.toMatchObject({ code: "context_length" });
  });
});
