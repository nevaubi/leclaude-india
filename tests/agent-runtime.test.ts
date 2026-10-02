import { describe, expect, it, vi } from "vitest";

// Fake OpenAI client: scripted Responses API streams.
const calls: Array<Record<string, unknown>> = [];
function stream(events: unknown[]) {
  return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
}
vi.mock("@/lib/ai/openai", () => ({
  getOpenAI: () => ({
    responses: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (calls.length === 1) {
          return stream([
            { type: "response.created" },
            { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" } },
            { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"q":' },
            { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"q":"pfas","limit":null}' },
            { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"q":"pfas","limit":null}' } },
            { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: [] } },
          ]);
        }
        return stream([
          { type: "response.output_text.delta", delta: "Found ", item_id: "msg_1", output_index: 0 },
          { type: "response.output_text.delta", delta: "2 results.", item_id: "msg_1", output_index: 0 },
          { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://example.com/x", title: "Example" } },
          { type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }, output: [] } },
        ]);
      },
    },
  }),
  aiConfig: () => ({ model: "gpt-test", fastModel: "gpt-test-mini", embeddingModel: "e", imageModel: "i", reasoningEffort: "low", hasKey: true }),
}));

import { runAgent, type AgentEvent } from "@/lib/ai/agent";
import { defineTool } from "@/lib/ai/tools";

describe("runAgent", () => {
  it("executes tools, continues with previous_response_id and streams events", async () => {
    process.env.OPENAI_API_KEY = "test";
    const events: AgentEvent[] = [];
    const executed: unknown[] = [];
    const lookup = defineTool<{ q: string; limit?: number }>({
      name: "lookup",
      description: "test",
      parameters: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer" } }, required: ["q"] },
      execute: async (args) => { executed.push(args); return { count: 2 }; },
    });
    const result = await runAgent({ instructions: "test", input: "find pfas", tools: [lookup as never], onEvent: (e) => events.push(e), model: "gpt-5.4" });

    expect(executed).toEqual([{ q: "pfas" }]); // null stripped by normalizeArgs
    expect(result.text).toBe("Found 2 results.");
    expect(result.responseId).toBe("resp_2");
    expect(result.usage.total).toBe(43);
    expect(result.toolCalls[0]).toMatchObject({ name: "lookup", result: { count: 2 } });

    // second call continues the conversation with the tool output
    expect(calls[1].previous_response_id).toBe("resp_1");
    expect(calls[1].input).toEqual([{ type: "function_call_output", call_id: "call_1", output: JSON.stringify({ count: 2 }) }]);
    // reasoning model → reasoning param, no temperature
    expect(calls[0].reasoning).toBeTruthy();
    expect(calls[0].temperature).toBeUndefined();
    const tool = (calls[0].tools as Array<Record<string, unknown>>)[0];
    expect(tool).toMatchObject({ type: "function", name: "lookup", strict: true });

    const types = events.map((e) => e.type);
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types).toContain("text.delta");
    expect(types).toContain("citation");
    expect(types.at(-1)).toBe("done");
    expect(events.find((e) => e.type === "tool.call")).toMatchObject({ name: "lookup", args: { q: "pfas" } });
  });
});

import { outputTokenBudget, parseModelJSON } from "@/lib/ai/agent";
describe("output budgets and JSON parsing", () => {
  it("gives reasoning models headroom, leaves others alone and never exceeds the model's maximum output", () => {
    expect(outputTokenBudget("gpt-5.4", 1800)).toBeGreaterThanOrEqual(17_800);
    expect(outputTokenBudget("gpt-4.1", 1800)).toBe(1800);
    expect(outputTokenBudget("gpt-5.4", undefined)).toBeUndefined();
    // gpt-5.4: 128,000 max output (developers.openai.com/api/docs/models/gpt-5.4) — 3 × 60,000 is clamped to it.
    expect(outputTokenBudget("gpt-5.4", 60_000)).toBe(128_000);
    expect(outputTokenBudget("gpt-4o", 40_000)).toBe(16_384);
    expect(outputTokenBudget("gpt-5.4", 20_000, 50_000)).toBe(50_000); // descriptor limit wins
  });
  it("parses fenced or prose-wrapped JSON", () => {
    expect(parseModelJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJSON('Here you go: {"a":[1,2]} thanks')).toEqual({ a: [1, 2] });
    expect(() => parseModelJSON("no json here")).toThrow();
  });
});
