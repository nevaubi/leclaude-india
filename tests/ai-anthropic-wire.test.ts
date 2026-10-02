import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/ai/capabilities";
import { AnthropicStreamParser, buildAnthropicRequest, thinkingConfig, toAnthropicSchema, type AnthropicWireOptions } from "@/lib/ai/providers/anthropic-wire";
import { claudeFamily, normalizeClaudeModelId, webToolVersions } from "@/lib/ai/providers/claude-models";
import { InferenceError, type InferenceEvent, type InferenceRequest } from "@/lib/ai/providers/types";

const anthropicOpts = (model = "claude-opus-4-6", over: Partial<AnthropicWireOptions> = {}): AnthropicWireOptions => ({ platform: "anthropic", model, capabilities: CAPABILITIES.anthropic, defaultMaxTokens: 16_000, thinkingBudget: 0, toolExamples: false, structuredOutput: "auto", ...over });
const bedrockOpts = (model = "us.anthropic.claude-opus-4-6-v1", over: Partial<AnthropicWireOptions> = {}): AnthropicWireOptions => ({ platform: "bedrock", model, capabilities: CAPABILITIES.bedrock, defaultMaxTokens: 16_000, thinkingBudget: 0, toolExamples: false, structuredOutput: "auto", ...over });

const lookupTool = { name: "lookup", description: "Find documents", parameters: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer" } }, required: ["q"] }, examples: [{ q: "solvent" }] };

const toolLoop: InferenceRequest = {
  instructions: "You are a careful litigator.",
  messages: [
    { role: "user", content: [{ type: "text", text: "find solvent" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "toolu_1", name: "lookup", args: { q: "solvent" } }] },
    { role: "tool", content: [{ type: "tool_result", callId: "toolu_1", content: '{"count":2}' }, { type: "tool_result", callId: "toolu_2", content: "boom", isError: true }] },
  ],
  tools: [lookupTool],
  cacheStablePrefix: true,
  reasoningEffort: "none",
};

describe("Claude model families", () => {
  it("normalises Bedrock ids and classifies families", () => {
    expect(normalizeClaudeModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5");
    expect(normalizeClaudeModelId("global.anthropic.claude-opus-4-6-v1")).toBe("claude-opus-4-6");
    expect(normalizeClaudeModelId("arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4-5");
    expect(claudeFamily("claude-fable-5-1")).toBe("adaptive-always");
    expect(claudeFamily("claude-opus-5")).toBe("adaptive-always");
    expect(claudeFamily("claude-opus-4-7")).toBe("adaptive");
    expect(claudeFamily("claude-sonnet-5")).toBe("adaptive");
    expect(claudeFamily("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("budget");
    expect(claudeFamily("claude-3-5-sonnet-20241022")).toBe("budget");
    expect(claudeFamily("gpt-5.4")).toBe("unknown");
    expect(webToolVersions("claude-opus-4-6").search).toBe("web_search_20260209");
    expect(webToolVersions("claude-haiku-4-5").search).toBe("web_search_20250305");
  });
});

describe("Anthropic request builder", () => {
  it("places cache breakpoints: system block + top-level automatic caching on Anthropic, never on volatile content", () => {
    const { body } = buildAnthropicRequest(toolLoop, anthropicOpts());
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.stream).toBe(true);
    expect(body.system).toEqual([{ type: "text", text: "You are a careful litigator.", cache_control: { type: "ephemeral" } }]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0].content[0]).not.toHaveProperty("cache_control");
    for (const b of messages[2].content) expect(b).not.toHaveProperty("cache_control");
    expect(body.tools).toHaveLength(1);
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["tools", "system", "messages"]));
  });

  it("uses explicit breakpoints only on Bedrock: system block + the last tool_result of the current turn", () => {
    const { body } = buildAnthropicRequest(toolLoop, bedrockOpts());
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("cache_control");
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const last = messages[2].content;
    expect(last[0]).not.toHaveProperty("cache_control");
    expect(last[1]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_2", is_error: true, cache_control: { type: "ephemeral" } });
  });

  it("honours a 1h TTL from metadata", () => {
    const { body } = buildAnthropicRequest({ ...toolLoop, metadata: { cacheTtl: "1h" } }, anthropicOpts());
    expect((body.system as Array<Record<string, unknown>>)[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("maps tool calls and tool results, in order, in a single user turn", () => {
    const { body } = buildAnthropicRequest(toolLoop, anthropicOpts());
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[1].content).toEqual([{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "solvent" } }]);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: '{"count":2}' },
      { type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true },
    ]);
    // strict tools on Anthropic carry additionalProperties:false and required for every key
    const tool = (body.tools as Array<Record<string, unknown>>)[0];
    expect(tool.strict).toBe(true);
    expect(tool.input_schema).toMatchObject({ additionalProperties: false, required: ["q", "limit"] });
    expect((tool.input_schema as { properties: Record<string, unknown> }).properties.limit).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(tool).not.toHaveProperty("input_examples");
  });

  it("replays an assistant turn verbatim, thinking block and signature included, on the same platform only", () => {
    const rawBlocks = [
      { type: "thinking", thinking: "consider the record", signature: "sig_abc" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "bates", limit: 3 } },
    ];
    const req: InferenceRequest = {
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_call", id: "toolu_9", name: "lookup", args: { q: "bates", limit: 3 } }], raw: { provider: "anthropic", content: rawBlocks } },
        { role: "tool", content: [{ type: "tool_result", callId: "toolu_9", content: "ok" }] },
      ],
      tools: [lookupTool],
    };
    const same = buildAnthropicRequest(req, anthropicOpts()).body.messages as Array<{ content: unknown[] }>;
    expect(same[1].content).toBe(rawBlocks); // identical object: nothing re-serialised or reordered
    expect(JSON.stringify(same[1].content)).toBe(JSON.stringify(rawBlocks));
    const other = buildAnthropicRequest(req, bedrockOpts()).body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(other[1].content).toEqual([{ type: "text", text: "Checking." }, { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "bates", limit: 3 } }]);
  });

  it("renders evidence as search_result blocks with citations enabled, or numbered text under structured output", () => {
    const req: InferenceRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "What did Vasudevan admit?" }] }],
      evidence: [{ type: "search_result", source: "depo://m1/dep_voss/p/20/l/4-12", title: "Vasudevan dep. 20:4-12", content: ["Q. Did you know? A. Yes, in 1998.", "Q. Anything else? A. No."] }],
    };
    const { body } = buildAnthropicRequest(req, anthropicOpts());
    const user = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(user[0]).toEqual({ type: "search_result", source: "depo://m1/dep_voss/p/20/l/4-12", title: "Vasudevan dep. 20:4-12", content: [{ type: "text", text: "Q. Did you know? A. Yes, in 1998." }, { type: "text", text: "Q. Anything else? A. No." }], citations: { enabled: true } });
    expect(user[1]).toEqual({ type: "text", text: "What did Vasudevan admit?" });

    const structured = buildAnthropicRequest({ ...req, jsonSchema: { name: "admissions", schema: { type: "object", properties: { found: { type: "boolean" } }, required: ["found"] } } }, anthropicOpts());
    const sUser = (structured.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(sUser[0].type).toBe("text");
    expect(String(sUser[0].text)).toContain("[1] Vasudevan dep. 20:4-12");
    expect(String(sUser[0].text)).toContain("source: depo://m1/dep_voss/p/20/l/4-12");
    expect(structured.body.output_config).toEqual({ format: { type: "json_schema", schema: { type: "object", properties: { found: { type: "boolean" } }, required: ["found"], additionalProperties: false } }, effort: "medium" });
  });

  it("keeps evidence on the question turn across tool rounds, never ahead of tool_result blocks", () => {
    const evidence = [{ type: "search_result" as const, source: "matter://m1/document/d1/page/3", title: "Report p.3", content: ["Contamination confirmed."] }];
    const { body } = buildAnthropicRequest({ ...toolLoop, evidence }, anthropicOpts());
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[0].content.map((b) => b.type)).toEqual(["search_result", "text"]);
    expect(messages[2].content.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
    // a lone tool-result turn still gets the evidence, after the tool_result blocks
    const only = buildAnthropicRequest({ messages: [toolLoop.messages[2]], evidence }, anthropicOpts()).body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(only[0].content.map((b) => b.type)).toEqual(["tool_result", "tool_result", "search_result"]);
  });

  it("uses a forced tool for structured output on models without output_config.format, and refuses where forced tool use is gone", () => {
    const req: InferenceRequest = { messages: [{ role: "user", content: [{ type: "text", text: "classify" }] }], jsonSchema: { name: "classification", schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } } };
    const old = buildAnthropicRequest(req, bedrockOpts("anthropic.claude-3-5-sonnet-20241022-v2:0"));
    expect(old.structuredToolName).toBe("classification");
    expect(old.body.tool_choice).toEqual({ type: "tool", name: "classification" });
    expect(old.body.thinking).toEqual({ type: "disabled" });
    expect(old.body).not.toHaveProperty("output_config");
    expect((old.body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "classification" });
    // with other tools present the forced choice is "any" so the model can still call real tools
    const withTools = buildAnthropicRequest({ ...req, tools: [lookupTool] }, bedrockOpts("anthropic.claude-3-5-sonnet-20241022-v2:0"));
    expect(withTools.body.tool_choice).toEqual({ type: "any" });
    expect(() => buildAnthropicRequest(req, anthropicOpts("claude-fable-5-1", { structuredOutput: "tool" }))).toThrow(InferenceError);
    expect(buildAnthropicRequest(req, anthropicOpts("claude-fable-5-1")).body.output_config).toMatchObject({ format: { type: "json_schema" } });
  });

  it("configures thinking per family", () => {
    expect(thinkingConfig("claude-fable-5-1", "xhigh", 0, true)).toEqual({ thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh", allowsTemperature: false });
    expect(thinkingConfig("claude-fable-5-1", "none", 0, false)).toEqual({ thinking: undefined, effort: "low", allowsTemperature: false });
    expect(thinkingConfig("claude-opus-4-6", "xhigh", 0, false)).toEqual({ thinking: { type: "adaptive" }, effort: "max", allowsTemperature: false });
    expect(thinkingConfig("claude-opus-4-7", "none", 0, false)).toEqual({ effort: "low", allowsTemperature: false });
    expect(thinkingConfig("claude-opus-4-6", "minimal", 0, false)).toEqual({ effort: "low", allowsTemperature: true });
    expect(thinkingConfig("claude-haiku-4-5", "high", 2048, false)).toEqual({ thinking: { type: "enabled", budget_tokens: 2048 }, allowsTemperature: false });
    expect(thinkingConfig("claude-haiku-4-5", "high", 0, false)).toEqual({ allowsTemperature: true });
    expect(thinkingConfig("claude-haiku-4-5", "low", 2048, false)).toEqual({ allowsTemperature: true });
    // wire: budget must stay below max_tokens; adaptive requests get headroom; temperature only where allowed
    const haiku = buildAnthropicRequest({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], reasoningEffort: "medium", maxOutputTokens: 500, temperature: 0.2 }, anthropicOpts("claude-haiku-4-5", { thinkingBudget: 4000 })).body;
    expect(haiku.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
    expect(haiku.max_tokens).toBeGreaterThan(4000);
    expect(haiku).not.toHaveProperty("temperature");
    const fable = buildAnthropicRequest({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], reasoningEffort: "high", maxOutputTokens: 500, temperature: 0.2 }, anthropicOpts("claude-fable-5-1")).body;
    expect(fable.thinking).toEqual({ type: "adaptive" });
    expect(fable.output_config).toEqual({ effort: "high" });
    expect(fable.max_tokens).toBe(16_500);
    expect(fable).not.toHaveProperty("temperature");
    const plain = buildAnthropicRequest({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], reasoningEffort: "none", maxOutputTokens: 500, temperature: 0.2 }, anthropicOpts("claude-haiku-4-5")).body;
    expect(plain).not.toHaveProperty("thinking");
    expect(plain.temperature).toBe(0.2);
    expect(plain.max_tokens).toBe(500);
  });

  it("emits allowed_callers and the code execution tool for programmatic tool calling on Anthropic only", () => {
    const req: InferenceRequest = { messages: [{ role: "user", content: [{ type: "text", text: "aggregate" }] }], tools: [{ ...lookupTool, callers: ["code_execution"] }], builtins: [{ type: "code_execution" }], containerId: "container_1" };
    const { body } = buildAnthropicRequest(req, anthropicOpts("claude-opus-4-6"));
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: "lookup", allowed_callers: ["code_execution_20260120"] });
    expect(tools[1]).toEqual({ type: "code_execution_20260120", name: "code_execution" });
    expect(body.container).toBe("container_1");
    // no code execution requested → no allowed_callers
    const plain = buildAnthropicRequest({ ...req, builtins: [], containerId: undefined }, anthropicOpts()).body.tools as Array<Record<string, unknown>>;
    expect(plain[0]).not.toHaveProperty("allowed_callers");
    // Bedrock has neither: fail closed at the wire (the router never sends it here)
    expect(() => buildAnthropicRequest(req, bedrockOpts())).toThrow(/code execution/);
  });

  it("sends server web search / fetch tools with the family's version, and input_examples only behind the flag", () => {
    const req: InferenceRequest = { messages: [{ role: "user", content: [{ type: "text", text: "search" }] }], tools: [lookupTool], builtins: [{ type: "web_search", allowedDomains: ["courtlistener.com"] }, { type: "web_fetch" }] };
    const modern = buildAnthropicRequest(req, anthropicOpts("claude-opus-4-6", { toolExamples: true }));
    const tools = modern.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: "lookup", input_examples: [{ q: "solvent" }] });
    expect(tools[1]).toEqual({ type: "web_search_20260209", name: "web_search", allowed_domains: ["courtlistener.com"], user_location: { type: "approximate", country: "IN" } });
    expect(tools[2]).toEqual({ type: "web_fetch_20260209", name: "web_fetch" });
    expect(modern.betas).toEqual(["advanced-tool-use-2025-11-20"]);
    const legacy = buildAnthropicRequest(req, anthropicOpts("claude-haiku-4-5"));
    expect((legacy.body.tools as Array<Record<string, unknown>>)[1].type).toBe("web_search_20250305");
    expect(legacy.betas).toEqual(["web-fetch-2025-09-10"]);
    expect(() => buildAnthropicRequest(req, bedrockOpts())).toThrow(/web search/);
  });

  it("converts nullable type arrays to anyOf and strips unsupported keywords", () => {
    expect(toAnthropicSchema({ type: "object", properties: { n: { type: "integer", minimum: 1 }, s: { type: "string", format: "date" } }, required: ["n"] })).toEqual({
      type: "object",
      properties: { n: { type: "integer" }, s: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["n", "s"],
      additionalProperties: false,
    });
  });
});

describe("Anthropic stream parser", () => {
  const transcript = [
    { type: "message_start", message: { id: "msg_01", type: "message", role: "assistant", model: "claude-opus-4-6", content: [], stop_reason: null, usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 40, output_tokens: 1 }, container: { id: "container_7", expires_at: "2026-09-24T00:00:00Z" } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Weighing the record. " } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_xyz" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Vasudevan admitted knowledge " } },
    { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { type: "search_result_location", source: "depo://m1/dep_voss/p/20/l/4-12", title: "Vasudevan dep. 20:4-12", cited_text: "A. Yes, in 1998.", search_result_index: 0, start_block_index: 0, end_block_index: 1 } } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "in 1998." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query": "Depo-Provera MDL' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ' 3140"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] } },
    { type: "content_block_stop", index: 3 },
    { type: "content_block_start", index: 4, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {}, caller: { type: "direct" } } },
    { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '{"q": "sol' } },
    { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: 'vent", "limit": 3}' } },
    { type: "content_block_stop", index: 4 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 57 } },
    { type: "message_stop" },
  ];

  it("emits text, reasoning, citation, web search and tool events and accumulates a replayable turn with usage", () => {
    const events: InferenceEvent[] = [];
    const parser = new AnthropicStreamParser((e) => events.push(e), { provider: "anthropic" });
    for (const ev of transcript) parser.handle(ev);
    const out = parser.finish();
    expect(events.map((e) => e.type)).toEqual(["reasoning.delta", "text.delta", "citation", "text.delta", "web_search", "web_search", "tool.call"]);
    expect(events.find((e) => e.type === "citation")).toEqual({ type: "citation", source: "depo://m1/dep_voss/p/20/l/4-12", title: "Vasudevan dep. 20:4-12", quote: "A. Yes, in 1998.", blockIndex: 0 });
    expect(events.filter((e) => e.type === "web_search")).toEqual([{ type: "web_search", status: "searching" }, { type: "web_search", status: "completed", query: "Depo-Provera MDL 3140" }]);
    expect(events.find((e) => e.type === "tool.call")).toEqual({ type: "tool.call", id: "toolu_1", name: "lookup", args: { q: "solvent", limit: 3 }, caller: "direct" });
    expect(out.text).toBe("Vasudevan admitted knowledge in 1998.");
    expect(out.toolCalls).toEqual([{ id: "toolu_1", name: "lookup", args: { q: "solvent", limit: 3 }, caller: "direct" }]);
    expect(out.stopReason).toBe("tool_calls");
    expect(out.messageId).toBe("msg_01");
    expect(out.containerId).toBe("container_7");
    expect(out.usage).toEqual({ input: 150, output: 57, total: 207, cacheRead: 40, cacheWrite: 10 });
    expect(out.complete).toBe(true);
    expect(parser.emitted).toBe(true);
    // replay turn: thinking block with its signature, text with citations, server tool blocks and tool_use with parsed input, in order
    const raw = out.assistantTurn.raw!;
    expect(raw.provider).toBe("anthropic");
    expect(raw.content.map((b) => (b as { type: string }).type)).toEqual(["thinking", "text", "server_tool_use", "web_search_tool_result", "tool_use"]);
    expect(raw.content[0]).toEqual({ type: "thinking", thinking: "Weighing the record. ", signature: "sig_xyz" });
    expect(raw.content[4]).toEqual({ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "solvent", limit: 3 }, caller: { type: "direct" } });
    expect((raw.content[1] as { citations: unknown[] }).citations).toHaveLength(1);
    expect(out.assistantTurn.content).toEqual([{ type: "text", text: "Vasudevan admitted knowledge in 1998." }, { type: "tool_call", id: "toolu_1", name: "lookup", args: { q: "solvent", limit: 3 } }]);
  });

  it("returns structured output from the forced tool without emitting a tool call", () => {
    const events: InferenceEvent[] = [];
    const parser = new AnthropicStreamParser((e) => events.push(e), { provider: "bedrock", structuredToolName: "classification" });
    for (const ev of [
      { type: "message_start", message: { id: "msg_02", usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_s", name: "classification", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"label":"privileged"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ]) parser.handle(ev);
    const out = parser.finish();
    expect(events.map((e) => e.type)).toEqual([]);
    expect(out.json).toEqual({ label: "privileged" });
    expect(out.text).toBe('{"label":"privileged"}');
    expect(out.toolCalls).toEqual([]);
    expect(out.stopReason).toBe("end");
  });

  it("marks unknown stop reasons as terminal and maps refusal / max_tokens / pause_turn", () => {
    const run = (stop: string) => {
      const p = new AnthropicStreamParser(() => {}, { provider: "anthropic" });
      p.handle({ type: "message_start", message: { id: "m", usage: { input_tokens: 1 } } });
      p.handle({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } });
      p.handle({ type: "message_stop" });
      return p.finish();
    };
    expect(run("something_new")).toMatchObject({ stopReason: "unknown", rawStopReason: "something_new" });
    expect(run("refusal").stopReason).toBe("refusal");
    expect(run("max_tokens").stopReason).toBe("max_tokens");
    expect(run("model_context_window_exceeded").stopReason).toBe("max_tokens");
    expect(run("pause_turn").stopReason).toBe("pause_turn");
    expect(run("end_turn").stopReason).toBe("end");
  });

  it("turns stream error events into InferenceErrors that are retryable only before output", () => {
    const fresh = new AnthropicStreamParser(() => {}, { provider: "anthropic" });
    expect(() => fresh.handle({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toThrow(expect.objectContaining({ code: "provider_unavailable", retryable: true }));
    const busy = new AnthropicStreamParser(() => {}, { provider: "anthropic" });
    busy.handle({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    busy.handle({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
    expect(() => busy.handle({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toThrow(expect.objectContaining({ code: "provider_unavailable", retryable: false }));
    expect(() => fresh.handle({ type: "error", error: { type: "invalid_request_error", message: "bad" } })).toThrow(expect.objectContaining({ code: "unknown", retryable: false }));
  });
});
