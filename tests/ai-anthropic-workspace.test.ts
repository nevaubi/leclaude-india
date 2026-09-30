import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "@/lib/ai/providers/anthropic";
import { readRuntimeEnv } from "@/lib/ai/providers/env";
import { providerError } from "@/lib/ai/providers/http";
import type { InferenceRequest } from "@/lib/ai/providers/types";

/** Organisation-level (unscoped) Anthropic keys need the workspace header; the misconfiguration is reported as auth. */
describe("anthropic workspace", () => {
  const req = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], taskType: "chat", role: "primary", model: "claude-test", privacy: "internal" } as unknown as InferenceRequest;

  it("sends anthropic-workspace-id only when ANTHROPIC_WORKSPACE_ID is set", () => {
    const withWs = readRuntimeEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-test", ANTHROPIC_WORKSPACE_ID: "wrkspc_123" }).anthropic;
    const without = readRuntimeEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-test" }).anthropic;
    expect(new AnthropicProvider(withWs, []).prepare(req).headers["anthropic-workspace-id"]).toBe("wrkspc_123");
    expect(new AnthropicProvider(without, []).prepare(req).headers["anthropic-workspace-id"]).toBeUndefined();
  });

  it("classifies the unscoped-key 400 as an auth error (not a generic failure)", () => {
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use." } });
    expect(providerError("anthropic", 400, body).code).toBe("auth");
    expect(providerError("anthropic", 400, JSON.stringify({ error: { type: "invalid_request_error", message: "messages: field required" } })).code).toBe("unknown");
  });
});
