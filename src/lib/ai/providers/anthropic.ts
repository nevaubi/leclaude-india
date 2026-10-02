import "server-only";
/**
 * Anthropic Messages API provider over fetch (no SDK): streaming SSE, prompt caching, search_result evidence,
 * server web search / fetch, programmatic tool calling, structured outputs and extended thinking. The wire format
 * lives in ./anthropic-wire.ts (shared with Bedrock); this file only does HTTP.
 */
import { AnthropicStreamParser, buildAnthropicRequest, type AnthropicWireRequest } from "./anthropic-wire";
import { CAPABILITIES } from "../capabilities";
import type { AnthropicEnv } from "./env";
import { SSEParser, abortError, backoffMs, fetchWithRetry, isAbortError, sleep, textChunks, toInferenceError } from "./http";
import { InferenceError, type InferenceEvent, type InferenceRequest, type InferenceResult, type ModelDescriptor, type ModelProvider } from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";
const STREAM_TIMEOUT_MS = 600_000;
const MAX_STREAM_ATTEMPTS = 3;

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  constructor(private cfg: AnthropicEnv, private descriptors: ModelDescriptor[]) {}

  models(): ModelDescriptor[] { return this.descriptors; }
  isConfigured(): boolean { return Boolean(this.cfg.apiKey && this.cfg.model); }

  /** Request body + headers for a request (exported for tests; never logs the key). */
  prepare(req: InferenceRequest): { url: string; headers: Record<string, string>; wire: AnthropicWireRequest; model: string } {
    if (!this.cfg.apiKey) throw new InferenceError("not_configured", "ANTHROPIC_API_KEY is not configured.", { provider: "anthropic" });
    const model = req.model ?? this.cfg.model;
    if (!model) throw new InferenceError("not_configured", "ANTHROPIC_MODEL is not configured.", { provider: "anthropic" });
    const wire = buildAnthropicRequest(req, { platform: "anthropic", model, capabilities: CAPABILITIES.anthropic, defaultMaxTokens: this.cfg.maxOutputTokens, thinkingBudget: this.cfg.thinkingBudget, toolExamples: this.cfg.toolExamples, structuredOutput: this.cfg.structuredOutput, maxOutputLimit: this.descriptors.find((d) => d.id === model)?.maxOutput });
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", "x-api-key": this.cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION };
    if (wire.betas.length) headers["anthropic-beta"] = wire.betas.join(",");
    if (this.cfg.workspaceId) headers["anthropic-workspace-id"] = this.cfg.workspaceId;
    return { url: `${this.cfg.baseURL}/v1/messages`, headers, wire, model };
  }

  async infer(req: InferenceRequest, onEvent: (e: InferenceEvent) => void = () => {}): Promise<InferenceResult> {
    const { url, headers, wire, model } = this.prepare(req);
    const started = Date.now();
    const body = JSON.stringify(wire.body);
    let lastError: InferenceError | null = null;
    for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
      if (req.signal?.aborted) throw abortError();
      const parser = new AnthropicStreamParser(onEvent, { provider: "anthropic", structuredToolName: wire.structuredToolName });
      onEvent({ type: "start", provider: "anthropic", model });
      const { res, clear } = await fetchWithRetry(url, { method: "POST", headers, body }, { provider: "anthropic", signal: req.signal, timeoutMs: STREAM_TIMEOUT_MS, maxRetries: 2 });
      try {
        if (!res.body) throw new InferenceError("provider_unavailable", "anthropic: empty response body", { provider: "anthropic", retryable: true });
        const sse = new SSEParser();
        for await (const chunk of textChunks(res.body, req.signal)) {
          for (const msg of sse.push(chunk)) parser.handle(safeJson(msg.data));
        }
        for (const msg of sse.end()) parser.handle(safeJson(msg.data));
        const parsed = parser.finish();
        if (!parsed.complete && !parsed.rawStopReason) throw new InferenceError("provider_unavailable", "anthropic: stream ended before message_stop", { provider: "anthropic", retryable: !parser.emitted });
        const usage = parsed.usage;
        onEvent({ type: "usage", usage });
        onEvent({ type: "done", stopReason: parsed.stopReason });
        return {
          provider: "anthropic",
          model: parsed.model ?? model,
          text: parsed.text,
          json: parsed.json,
          toolCalls: parsed.toolCalls,
          citations: parsed.citations,
          usage,
          stopReason: parsed.stopReason,
          rawStopReason: parsed.stopReason === "unknown" ? parsed.rawStopReason : undefined,
          responseId: null,
          messageId: parsed.messageId,
          containerId: parsed.containerId,
          latencyMs: Date.now() - started,
          assistantTurn: parsed.assistantTurn,
        };
      } catch (e) {
        if (isAbortError(e) || req.signal?.aborted) throw abortError();
        lastError = toInferenceError(e, "anthropic");
        if (!lastError.retryable || parser.emitted || attempt === MAX_STREAM_ATTEMPTS - 1) throw lastError;
        await sleep(backoffMs(attempt), req.signal);
      } finally {
        clear();
      }
    }
    throw lastError ?? new InferenceError("unknown", "anthropic: request failed", { provider: "anthropic" });
  }
}

function safeJson(data: string): unknown {
  try { return JSON.parse(data); } catch { return null; }
}
