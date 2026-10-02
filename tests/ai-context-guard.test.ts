/**
 * The runtime context guard: the oldest tool results are elided (never the latest tool turn, never user turns or
 * evidence) when the replayed history would exceed the input budget; a context-length error from the provider is a
 * typed, retry-once-after-aggressive-elision path instead of an "unknown" failure; budgets default the output cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponseInput } from "openai/resources/responses/responses";

const calls: Array<Record<string, unknown>> = [];
let failFirst: { status: number; message: string } | null = null;
/** Optional per-call script: the stream events for call n (1-based); default is a plain "ok" answer. */
let script: ((n: number) => unknown[] | null) | null = null;

function stream(events: unknown[]) {
  return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
}
vi.mock("@/lib/ai/openai", () => ({
  getOpenAI: () => ({
    responses: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (failFirst && calls.length === 1) { const e = Object.assign(new Error(failFirst.message), { status: failFirst.status }); throw e; }
        const scripted = script?.(calls.length);
        if (scripted) return stream(scripted);
        return stream([
          { type: "response.output_text.delta", delta: "ok", item_id: "m", output_index: 0 },
          { type: "response.completed", response: { id: `resp_${calls.length}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, output: [] } },
        ]);
      },
    },
  }),
}));

import { contextLimit, guardHistory, runAgent, type AgentEvent } from "@/lib/ai/agent";
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

beforeEach(() => { calls.length = 0; failFirst = null; script = null; process.env.OPENAI_API_KEY = "test"; });

/** A Responses stream that calls one function tool (with server ids, as the API returns them). */
function functionCallStream(n: number, name: string) {
  const item = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify({ id: `doc${n}` }), status: "completed" };
  return [
    { type: "response.output_item.added", item: { ...item, arguments: "" }, output_index: 0 },
    { type: "response.function_call_arguments.done", item_id: item.id, arguments: item.arguments, output_index: 0 },
    { type: "response.output_item.done", item, output_index: 0 },
    { type: "response.completed", response: { id: `resp_${n}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, output: [item] } },
  ];
}

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

describe("contextLimit (when the guard elides)", () => {
  it("elides at the model's capacity capped by the profile ceiling, not at the sizing share", () => {
    // research_lane on Claude Haiku 4.5 (200K window): the sizing share is ~38K tokens, but the model holds ~128K, so a
    // lane's five reads (~11K tokens each) stay in context instead of being elided mid-lane.
    const haiku = modelLimits("anthropic", "claude-haiku-4-5");
    const lane = resolveContextBudget("research_lane", haiku, {});
    expect(lane.inputTokens).toBeLessThan(60_000);
    const limit = contextLimit(haiku, lane, lane.maxOutputTokens);
    expect(limit).toBe(lane.guardTokens);
    expect(limit).toBeGreaterThan(5 * 11_000 + 20_000);
    expect(limit).toBeLessThanOrEqual(haiku.maxInput);
    // A large model is still capped by the profile ceiling (cost / long-context price tier), not by its 1M window.
    const big = modelLimits("openai", "gpt-5.4");
    expect(contextLimit(big, resolveContextBudget("research_lane", big, {}), 3_000)).toBe(160_000);
    expect(contextLimit(big, resolveContextBudget("deep_research_synthesis", big, {}), 16_000)).toBeLessThan(272_000);
    // chat_fast on gpt-5.4 is unchanged (share = ceiling = 96K).
    const fast = resolveContextBudget("chat_fast", big, {});
    expect(contextLimit(big, fast, fast.maxOutputTokens)).toBe(fast.inputTokens);
    // Never above what the model accepts with a larger explicit output reservation, never below the sizing share.
    expect(contextLimit(haiku, lane, 100_000)).toBe(Math.max(lane.inputTokens, Math.min(haiku.maxInput, haiku.contextWindow - 100_000) - 8_000));
    // AI_CONTEXT_SCALE shrinks the guard with the other input budgets.
    const scaled = resolveContextBudget("research_lane", haiku, { AI_CONTEXT_SCALE: "0.25" });
    expect(scaled.guardTokens).toBe(Math.max(scaled.inputTokens, 40_000));
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

  it("OpenAI step ≥ 2: an elision resets previous_response_id and replays the elided history (no truncation:auto)", async () => {
    // chat_fast on gpt-5.4 (~96k input tokens). Each read returns 250k characters (~67k tokens): step 2 fits one, step 3
    // does not, so the guard elides the first read — which only takes effect if the history is replayed in full.
    const read = { name: "read_judgment_text", description: "read", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, maxResultChars: 300_000, execute: async () => big("judgment", 250_000) };
    script = (n) => (n <= 2 ? functionCallStream(n, "read_judgment_text") : null);
    const events: AgentEvent[] = [];
    const res = await runAgent({ instructions: "test", input: "question", tools: [read as never], onEvent: (e) => events.push(e), budget: "chat_fast", maxSteps: 4 });
    expect(res.text).toBe("ok");
    expect(calls).toHaveLength(3);
    // Step 2 continued server-side (only the new tool output was sent), and never with truncation:auto.
    expect(calls[1].previous_response_id).toBe("resp_1");
    expect((calls[1].input as unknown[]).length).toBe(1);
    for (const c of calls) expect(c).not.toHaveProperty("truncation");
    // Step 3: the guard elided the first read, so the request starts from the local history again (no continuation).
    expect(res.elided).toBe(1);
    expect(calls[2].previous_response_id).toBeUndefined();
    const sent = calls[2].input as Array<Record<string, unknown>>;
    expect(sent[0]).toMatchObject({ role: "user", content: "question" });
    const outputs = sent.filter((i) => i.type === "function_call_output").map((i) => String(i.output));
    expect(outputs[0]).toBe("[elided 250000 chars — re-read with read_judgment_text]");
    expect(outputs[1].length).toBe(250_000);
    // Replayed function calls carry their call_id but not the server item id (no reasoning item travels with them).
    const fcs = sent.filter((i) => i.type === "function_call");
    expect(fcs.map((f) => f.call_id)).toEqual(["call_1", "call_2"]);
    for (const f of fcs) expect(f).not.toHaveProperty("id");
    expect(events.some((e) => e.type === "status" && /Context budget: elided 1 earlier tool result/.test(e.message))).toBe(true);
  });

  it("with a caller's stored conversation, an elision replays the local history on top of it (the base is never dropped)", async () => {
    const read = { name: "read_judgment_text", description: "read", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, maxResultChars: 300_000, execute: async () => big("judgment", 250_000) };
    script = (n) => (n <= 2 ? functionCallStream(n, "read_judgment_text") : null);
    await runAgent({ instructions: "test", input: "follow-up question", previousResponseId: "resp_base", tools: [read as never], onEvent: () => {}, budget: "chat_fast", maxSteps: 4 });
    expect(calls[0].previous_response_id).toBe("resp_base");
    expect(calls[1].previous_response_id).toBe("resp_1");
    expect(calls[2].previous_response_id).toBe("resp_base");
    const sent = calls[2].input as Array<Record<string, unknown>>;
    expect(sent[0]).toMatchObject({ role: "user", content: "follow-up question" });
    expect(sent.filter((i) => i.type === "function_call_output").map((i) => String(i.output).slice(0, 8))).toEqual(["[elided ", "judgment"]);
    for (const c of calls) expect(c).not.toHaveProperty("truncation");
  });

  it("fails honestly when nothing can be elided", async () => {
    failFirst = { status: 400, message: "prompt is too long: 2000000 tokens > 1050000 maximum" };
    await expect(runAgent({ instructions: "test", input: "one huge question", onEvent: () => {} })).rejects.toMatchObject({ code: "context_length" });
  });
});
