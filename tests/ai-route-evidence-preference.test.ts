import { afterEach, describe, expect, it, vi } from "vitest";
import { routeRequest } from "@/lib/ai/runtime";
import { resetProviderRegistry } from "@/lib/ai/providers/registry";
import type { InferenceRequest } from "@/lib/ai/providers/types";

/** MODEL_PROVIDER wins over the citation-native preference for evidence (evidence then goes as numbered text). */
const BASE = { OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-5.4", OPENAI_FAST_MODEL: "gpt-5.4-mini", ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_MODEL: "claude-opus-4-6", ANTHROPIC_FAST_MODEL: "claude-haiku-4-5" };
const req = {
  messages: [{ role: "user", content: [{ type: "text", text: "What is the rent?" }] }],
  taskType: "synthesize", role: "primary", privacy: "internal",
  evidence: [{ type: "search_result", source: "docs://s/f/p/2#0", title: "[1] lease.pdf, page 2", content: ["The monthly rent is Rs. 45,000."] }],
} as unknown as InferenceRequest;

function withEnv(env: Record<string, string>) {
  for (const k of ["MODEL_PROVIDER", ...Object.keys(BASE)]) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries({ ...BASE, ...env })) vi.stubEnv(k, v);
  resetProviderRegistry();
}

afterEach(() => { vi.unstubAllEnvs(); resetProviderRegistry(); });

describe("routing requests that carry evidence", () => {
  it("uses the preferred provider even without search_result blocks", () => {
    withEnv({ MODEL_PROVIDER: "openai" });
    expect(routeRequest(req).provider).toBe("openai");
  });
  it("still prefers citation-native blocks when no provider is preferred", () => {
    withEnv({});
    expect(routeRequest(req).provider).toBe("anthropic");
  });
});
