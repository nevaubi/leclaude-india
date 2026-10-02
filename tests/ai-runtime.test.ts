import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceResult, ModelDescriptor, ModelProvider, ProviderId } from "@/lib/ai/providers/types";

/**
 * Runtime routing/fallback with fake providers: fallback happens only on retryable errors before any output,
 * never on capability/privacy/auth errors; not_configured surfaces as AIConfigError at the agent boundary; the
 * agent loop keeps a local history so non-OpenAI providers get tool results replayed.
 */
const state = vi.hoisted(() => ({ registry: null as unknown, traces: [] as Record<string, unknown>[] }));

vi.mock("@/lib/ai/providers/registry", () => ({ getRegistry: () => state.registry, resetProviderRegistry: () => {} }));
vi.mock("@/lib/ai/telemetry", () => ({ recordTrace: (t: Record<string, unknown>) => { state.traces.push(t); return t; } }));

import { CAPABILITIES } from "@/lib/ai/capabilities";
import { AIConfigError } from "@/lib/ai/config";
import { deriveNeeds, infer, prepareForProvider } from "@/lib/ai/runtime";
import { InferenceError } from "@/lib/ai/providers/types";
import { runAgent, type AgentEvent } from "@/lib/ai/agent";
import { defineTool } from "@/lib/ai/tools";

type Script = (req: InferenceRequest, onEvent: (e: InferenceEvent) => void) => Promise<InferenceResult>;

function fakeProvider(id: ProviderId, models: ModelDescriptor[], script: Script): ModelProvider & { calls: InferenceRequest[] } {
  const calls: InferenceRequest[] = [];
  return { id, calls, models: () => models, isConfigured: () => true, infer: async (req, onEvent = () => {}) => { calls.push(req); return script(req, onEvent); } };
}

function descriptor(provider: ProviderId, id: string, roles: ModelDescriptor["roles"] = ["primary", "fast", "vision"]): ModelDescriptor {
  return { id, provider, roles, capabilities: CAPABILITIES[provider], privacy: provider === "openrouter" ? "external" : "internal", reasoning: true, costTier: 2 };
}

function ok(provider: ProviderId, model: string, text: string, extra: Partial<InferenceResult> = {}): InferenceResult {
  return { provider, model, text, toolCalls: [], citations: [], usage: { input: 10, output: 5, total: 15 }, stopReason: "end", responseId: null, latencyMs: 1, assistantTurn: { role: "assistant", content: [{ type: "text", text }] }, ...extra };
}

function registry(providers: ModelProvider[], preferred: ProviderId | null = null) {
  return { env: { preferred, allowExternalForMatterData: false }, providers: new Map(providers.map((p) => [p.id, p])), models: providers.flatMap((p) => p.models()), preferred, allowExternalForMatterData: false };
}

const req: InferenceRequest = { instructions: "test", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], taskType: "draft" };

beforeEach(() => { state.traces = []; process.env.OPENAI_API_KEY = "test-key"; });

describe("infer routing and fallback", () => {
  it("falls back to the next eligible model on a retryable error and records both traces", async () => {
    const bedrock = fakeProvider("bedrock", [descriptor("bedrock", "us.anthropic.claude-opus-4-6-v1")], async () => { throw new InferenceError("rate_limited", "bedrock HTTP 429", { provider: "bedrock" }); });
    const anthropic = fakeProvider("anthropic", [descriptor("anthropic", "claude-opus-4-6")], async () => ok("anthropic", "claude-opus-4-6", "hello"));
    state.registry = registry([bedrock, anthropic]);
    const fallbacks: string[] = [];
    const res = await infer(req, undefined, { onFallback: ({ from, to, error }) => fallbacks.push(`${from.provider}->${to.provider}:${error.code}`) });
    expect(res.provider).toBe("anthropic");
    expect(bedrock.calls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(1);
    expect(fallbacks).toEqual(["bedrock->anthropic:rate_limited"]);
    expect(state.traces.map((t) => [t.provider, t.error ? (t.error as { code: string }).code : "ok", t.fallbackFrom ? (t.fallbackFrom as { provider: string }).provider : null])).toEqual([["bedrock", "rate_limited", null], ["anthropic", "ok", "bedrock"]]);
  });

  it("never falls back on capability, privacy, auth or malformed-output errors", async () => {
    for (const code of ["auth", "capability_unavailable", "privacy_boundary", "malformed_output"] as const) {
      const bedrock = fakeProvider("bedrock", [descriptor("bedrock", "us.anthropic.claude-opus-4-6-v1")], async () => { throw new InferenceError(code, `bedrock ${code}`, { provider: "bedrock" }); });
      const anthropic = fakeProvider("anthropic", [descriptor("anthropic", "claude-opus-4-6")], async () => ok("anthropic", "claude-opus-4-6", "hello"));
      state.registry = registry([bedrock, anthropic]);
      await expect(infer(req)).rejects.toMatchObject({ code });
      expect(anthropic.calls).toHaveLength(0);
    }
  });

  it("does not fall back once output has been streamed", async () => {
    const bedrock = fakeProvider("bedrock", [descriptor("bedrock", "us.anthropic.claude-opus-4-6-v1")], async (_r, onEvent) => { onEvent({ type: "text.delta", delta: "partial" }); throw new InferenceError("provider_unavailable", "bedrock stream error", { provider: "bedrock", retryable: true }); });
    const anthropic = fakeProvider("anthropic", [descriptor("anthropic", "claude-opus-4-6")], async () => ok("anthropic", "claude-opus-4-6", "hello"));
    state.registry = registry([bedrock, anthropic]);
    await expect(infer(req)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(anthropic.calls).toHaveLength(0);
  });

  it("derives needs from the request so Bedrock is excluded for server web search and the explicit-model hint still routes", async () => {
    const bedrock = fakeProvider("bedrock", [descriptor("bedrock", "us.anthropic.claude-opus-4-6-v1")], async () => ok("bedrock", "us.anthropic.claude-opus-4-6-v1", "b"));
    const anthropic = fakeProvider("anthropic", [descriptor("anthropic", "claude-opus-4-6")], async () => ok("anthropic", "claude-opus-4-6", "a"));
    state.registry = registry([bedrock, anthropic]);
    expect(deriveNeeds({ ...req, builtins: [{ type: "web_search" }], jsonSchema: { name: "x", schema: {} }, messages: [{ role: "user", content: [{ type: "image", url: "data:image/png;base64,AA==" }] }] })).toEqual({ structuredOutput: true, serverWebSearch: true, vision: true });
    const res = await infer({ ...req, builtins: [{ type: "web_search" }] });
    expect(res.provider).toBe("anthropic");
    expect(bedrock.calls).toHaveLength(0);
    state.registry = registry([bedrock]);
    await expect(infer({ ...req, builtins: [{ type: "web_search" }] })).rejects.toThrow(/not available on Amazon Bedrock/);
  });

  it("renders evidence as numbered text for providers without search_result blocks and drops previous_response_id elsewhere", () => {
    const evidence = [{ type: "search_result" as const, source: "matter://m1/document/d1/page/3", title: "Sundaram report p.3", content: ["The tests showed contamination."] }];
    const openai = prepareForProvider({ ...req, evidence, previousResponseId: "resp_1" }, descriptor("openai", "gpt-5.4"));
    expect(openai.evidence).toBeUndefined();
    expect(openai.previousResponseId).toBe("resp_1");
    expect(openai.messages[0].content[0]).toEqual({ type: "text", text: expect.stringContaining("[1] Sundaram report p.3\nsource: matter://m1/document/d1/page/3\nThe tests showed contamination.") });
    const anthropic = prepareForProvider({ ...req, evidence, previousResponseId: "resp_1", tools: [{ name: "t", description: "d", parameters: {}, callers: ["code_execution"] }] }, descriptor("bedrock", "x"));
    expect(anthropic.evidence).toEqual(evidence);
    expect(anthropic.previousResponseId).toBeNull();
    expect(anthropic.tools?.[0].callers).toBeUndefined();
  });
});

describe("agent boundary", () => {
  it("maps not_configured to AIConfigError before any event is emitted", async () => {
    state.registry = registry([]);
    const events: AgentEvent[] = [];
    await expect(runAgent({ instructions: "x", input: "hi", onEvent: (e) => events.push(e) })).rejects.toBeInstanceOf(AIConfigError);
    expect(events).toEqual([]);
  });

  it("keeps a local history across tool rounds so a provider without server-side state gets the tool results", async () => {
    const seen: InferenceRequest[] = [];
    const anthropic = fakeProvider("anthropic", [descriptor("anthropic", "claude-opus-4-6")], async (r, onEvent) => {
      seen.push(r);
      if (seen.length === 1) {
        onEvent({ type: "tool.call", id: "toolu_1", name: "lookup", args: { q: "solvent", limit: null } });
        return ok("anthropic", "claude-opus-4-6", "", { stopReason: "tool_calls", toolCalls: [{ id: "toolu_1", name: "lookup", args: { q: "solvent", limit: null } }], assistantTurn: { role: "assistant", content: [{ type: "tool_call", id: "toolu_1", name: "lookup", args: { q: "solvent", limit: null } }], raw: { provider: "anthropic", content: [{ type: "thinking", thinking: "…", signature: "s" }, { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "solvent", limit: null } }] } } });
      }
      onEvent({ type: "text.delta", delta: "Found 2 results." });
      return ok("anthropic", "claude-opus-4-6", "Found 2 results.", { usage: { input: 20, output: 8, total: 28, cacheRead: 12, cacheWrite: 0 } });
    });
    state.registry = registry([anthropic]);
    const events: AgentEvent[] = [];
    const executed: unknown[] = [];
    const lookup = defineTool<{ q: string; limit?: number }>({ name: "lookup", description: "test", parameters: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer" } }, required: ["q"] }, execute: async (args) => { executed.push(args); return { count: 2 }; } });
    const result = await runAgent({ instructions: "test", input: "find solvent", tools: [lookup as never], onEvent: (e) => events.push(e), previousResponseId: "resp_stale" });

    expect(executed).toEqual([{ q: "solvent" }]);
    expect(result.text).toBe("Found 2 results.");
    expect(result.responseId).toBeNull(); // no server-side continuation on Anthropic → the client keeps sending history
    expect(result.usage).toEqual({ input: 30, output: 13, total: 43, cacheRead: 12, cacheWrite: 0 });
    expect(result.toolCalls[0]).toMatchObject({ name: "lookup", result: { count: 2 } });
    expect(seen).toHaveLength(2);
    expect(seen[0].previousResponseId).toBeNull();
    expect(seen[0].cacheStablePrefix).toBe(true);
    expect(seen[0].store).toBe(true);
    expect(seen[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(seen[1].messages[1].raw?.content[0]).toEqual({ type: "thinking", thinking: "…", signature: "s" });
    expect(seen[1].messages[2].content).toEqual([{ type: "tool_result", callId: "toolu_1", content: JSON.stringify({ count: 2 }) }]);
    // tools.ts's runTool additionally emits `trace` events around each execution; they are pass-through here.
    const types = events.map((e) => e.type).filter((t) => t !== "trace");
    expect(types).toEqual(["start", "step", "tool.call", "tool.result", "step", "text.delta", "text.done", "done"]);
    expect(events.find((e) => e.type === "tool.call")).toMatchObject({ name: "lookup", args: { q: "solvent" }, label: "lookup" });
  });

  it("treats an unknown stop reason as failure and a refusal as an explicit status", async () => {
    const anthropic = fakeProvider("anthropic", [descriptor("anthropic", "claude-opus-4-6")], async () => ok("anthropic", "claude-opus-4-6", "partial", { stopReason: "unknown", rawStopReason: "new_thing" }));
    state.registry = registry([anthropic]);
    await expect(runAgent({ instructions: "x", input: "hi", onEvent: () => {} })).rejects.toMatchObject({ code: "incomplete" });
    const refusing = fakeProvider("anthropic", [descriptor("anthropic", "claude-opus-4-6")], async () => ok("anthropic", "claude-opus-4-6", "", { stopReason: "refusal", rawStopReason: "cyber" }));
    state.registry = registry([refusing]);
    const events: AgentEvent[] = [];
    const res = await runAgent({ instructions: "x", input: "hi", onEvent: (e) => events.push(e) });
    expect(res.text).toBe("");
    expect(events.find((e) => e.type === "status")).toMatchObject({ message: "Model refused: cyber" });
  });
});
