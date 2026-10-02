import "server-only";
/**
 * Amazon Bedrock provider (constitution §19): Anthropic models through `InvokeModelWithResponseStream` on
 * bedrock-runtime, signed with SigV4 (static or temporary credentials) or a Bedrock API key (bearer token), the
 * response decoded from the AWS event stream and fed to the shared Anthropic stream parser. Embeddings through
 * `InvokeModel` for Titan (v2) and Cohere embedding models.
 *
 * Bedrock has no Files API, server web tools, code execution or programmatic tool calling and rejects top-level
 * automatic prompt caching; the capability matrix and the wire builder encode that so the router never sends such
 * a request here.
 */
import { AnthropicStreamParser, buildAnthropicRequest, type AnthropicWireRequest } from "./anthropic-wire";
import { CAPABILITIES } from "../capabilities";
import type { BedrockEnv } from "./env";
import { EventStreamDecoder, decodeBedrockEvent } from "./eventstream";
import { abortError, backoffMs, byteChunks, fetchWithRetry, isAbortError, isContextLengthError, sleep, toInferenceError } from "./http";
import { signV4 } from "./sigv4";
import { InferenceError, type EmbedOptions, type InferenceErrorCode, type InferenceEvent, type InferenceRequest, type InferenceResult, type ModelDescriptor, type ModelProvider } from "./types";

export const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";
const STREAM_TIMEOUT_MS = 600_000;
const MAX_STREAM_ATTEMPTS = 3;
const EMBED_TIMEOUT_MS = 60_000;

export function bedrockEndpoint(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

export function bedrockModelPath(modelId: string, action: "invoke" | "invoke-with-response-stream"): string {
  return `/model/${encodeURIComponent(modelId)}/${action}`;
}

/** Bedrock exception names (HTTP `x-amzn-ErrorType` or event-stream `:exception-type`) → runtime error codes. */
export function mapBedrockException(name: string, message?: string): { code: InferenceErrorCode; retryable: boolean; status: number } {
  const n = name.replace(/:.*$/, "").toLowerCase();
  if (n.startsWith("validation") && isContextLengthError(null, message)) return { code: "context_length", retryable: false, status: 400 };
  if (n.startsWith("throttling") || n.includes("toomanyrequests")) return { code: "rate_limited", retryable: true, status: 429 };
  if (n.startsWith("modeltimeout")) return { code: "timeout", retryable: true, status: 504 };
  if (n.startsWith("modelstreamerror") || n.startsWith("internalserver") || n.startsWith("serviceunavailable") || n.startsWith("modelnotready") || n.startsWith("modelerror")) return { code: "provider_unavailable", retryable: true, status: 503 };
  if (n.startsWith("accessdenied") || n.startsWith("unrecognizedclient") || n.startsWith("invalidsignature") || n.startsWith("expiredtoken")) return { code: "auth", retryable: false, status: 403 };
  if (n.startsWith("validation") || n.startsWith("resourcenotfound") || n.startsWith("servicequotaexceeded")) return { code: "unknown", retryable: false, status: 400 };
  return { code: "unknown", retryable: false, status: 400 };
}

export class BedrockProvider implements ModelProvider {
  readonly id = "bedrock" as const;
  constructor(private cfg: BedrockEnv, private descriptors: ModelDescriptor[]) {}

  models(): ModelDescriptor[] { return this.descriptors; }
  isConfigured(): boolean { return Boolean(this.cfg.region && this.hasCredentials() && (this.cfg.model || this.cfg.embeddingModel)); }
  private hasCredentials() { return Boolean(this.cfg.bearerToken || (this.cfg.accessKeyId && this.cfg.secretAccessKey)); }

  /** Body for a chat request (exported for tests). */
  prepare(req: InferenceRequest): { model: string; wire: AnthropicWireRequest; body: Record<string, unknown> } {
    const model = req.model ?? this.cfg.model;
    if (!model) throw new InferenceError("not_configured", "BEDROCK_MODEL is not configured.", { provider: "bedrock" });
    const wire = buildAnthropicRequest(req, { platform: "bedrock", model, capabilities: CAPABILITIES.bedrock, defaultMaxTokens: this.cfg.maxOutputTokens, thinkingBudget: this.cfg.thinkingBudget, toolExamples: false, structuredOutput: this.cfg.structuredOutput, maxOutputLimit: this.descriptors.find((d) => d.id === model)?.maxOutput });
    const body: Record<string, unknown> = { anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...wire.body };
    if (wire.betas.length) body.anthropic_beta = wire.betas;
    return { model, wire, body };
  }

  /** Signed (or bearer) headers for a bedrock-runtime call. Recomputed per attempt because SigV4 embeds the timestamp. */
  private authorize(path: string, body: string, accept: string): { url: string; headers: Record<string, string> } {
    const region = this.cfg.region;
    if (!region) throw new InferenceError("not_configured", "AWS_REGION is not configured.", { provider: "bedrock" });
    const host = `bedrock-runtime.${region}.amazonaws.com`;
    const base: Record<string, string> = { host, "content-type": "application/json", accept };
    if (this.cfg.bearerToken) {
      return { url: `${bedrockEndpoint(region)}${path}`, headers: { ...base, authorization: `Bearer ${this.cfg.bearerToken}` } };
    }
    if (!this.cfg.accessKeyId || !this.cfg.secretAccessKey) throw new InferenceError("not_configured", "AWS credentials are not configured (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_BEARER_TOKEN_BEDROCK).", { provider: "bedrock" });
    const signed = signV4({ method: "POST", path, headers: base, body }, { region, service: "bedrock", credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, sessionToken: this.cfg.sessionToken } });
    return { url: `${bedrockEndpoint(region)}${path}`, headers: signed.headers };
  }

  async infer(req: InferenceRequest, onEvent: (e: InferenceEvent) => void = () => {}): Promise<InferenceResult> {
    const { model, wire, body } = this.prepare(req);
    const path = bedrockModelPath(model, "invoke-with-response-stream");
    const json = JSON.stringify(body);
    const started = Date.now();
    let lastError: InferenceError | null = null;
    for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
      if (req.signal?.aborted) throw abortError();
      const parser = new AnthropicStreamParser(onEvent, { provider: "bedrock", structuredToolName: wire.structuredToolName });
      onEvent({ type: "start", provider: "bedrock", model });
      const { res, clear } = await fetchWithRetry(
        this.authorize(path, json, "application/vnd.amazon.eventstream").url,
        () => ({ method: "POST", headers: this.authorize(path, json, "application/vnd.amazon.eventstream").headers, body: json }),
        { provider: "bedrock", signal: req.signal, timeoutMs: STREAM_TIMEOUT_MS, maxRetries: 2 },
      );
      try {
        if (!res.body) throw new InferenceError("provider_unavailable", "bedrock: empty response body", { provider: "bedrock", retryable: true });
        const decoder = new EventStreamDecoder();
        for await (const chunk of byteChunks(res.body, req.signal)) {
          for (const frame of decoder.push(chunk)) {
            const ev = decodeBedrockEvent(frame);
            if (ev.kind === "chunk") parser.handle(ev.event);
            else if (ev.kind === "exception") {
              const m = mapBedrockException(ev.exceptionType, ev.message);
              throw new InferenceError(m.code, `bedrock stream exception ${ev.exceptionType}: ${ev.message}`, { provider: "bedrock", status: m.status, retryable: m.retryable && !parser.emitted });
            } else if (ev.kind === "error") {
              throw new InferenceError("provider_unavailable", `bedrock stream error ${ev.errorCode}: ${ev.message}`, { provider: "bedrock", retryable: !parser.emitted });
            }
          }
        }
        if (decoder.pending) throw new InferenceError("provider_unavailable", "bedrock: truncated event stream frame", { provider: "bedrock", retryable: !parser.emitted });
        const parsed = parser.finish();
        if (!parsed.complete && !parsed.rawStopReason) throw new InferenceError("provider_unavailable", "bedrock: stream ended before message_stop", { provider: "bedrock", retryable: !parser.emitted });
        onEvent({ type: "usage", usage: parsed.usage });
        onEvent({ type: "done", stopReason: parsed.stopReason });
        return {
          provider: "bedrock",
          model,
          text: parsed.text,
          json: parsed.json,
          toolCalls: parsed.toolCalls,
          citations: parsed.citations,
          usage: parsed.usage,
          stopReason: parsed.stopReason,
          rawStopReason: parsed.stopReason === "unknown" ? parsed.rawStopReason : undefined,
          responseId: null,
          messageId: parsed.messageId,
          latencyMs: Date.now() - started,
          assistantTurn: parsed.assistantTurn,
        };
      } catch (e) {
        if (isAbortError(e) || req.signal?.aborted) throw abortError();
        lastError = toInferenceError(e, "bedrock");
        if (!lastError.retryable || parser.emitted || attempt === MAX_STREAM_ATTEMPTS - 1) throw lastError;
        await sleep(backoffMs(attempt), req.signal);
      } finally {
        clear();
      }
    }
    throw lastError ?? new InferenceError("unknown", "bedrock: request failed", { provider: "bedrock" });
  }

  // ---------------- Embeddings ----------------

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
    const model = opts.model ?? this.cfg.embeddingModel;
    if (!model) throw new InferenceError("not_configured", "BEDROCK_EMBEDDING_MODEL is not configured.", { provider: "bedrock" });
    if (!texts.length) return [];
    const kind = embeddingKind(model);
    if (kind === "cohere") {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 96) {
        const slice = texts.slice(i, i + 96).map((t) => t.slice(0, 24_000));
        const body = { texts: slice, input_type: opts.inputType === "query" ? "search_query" : "search_document", embedding_types: ["float"], ...(opts.dimensions ? { output_dimension: opts.dimensions } : {}) };
        const res = await this.invokeJson<{ embeddings?: { float?: number[][] } | number[][] }>(model, body, opts.signal);
        const vectors = Array.isArray(res.embeddings) ? res.embeddings : res.embeddings?.float;
        if (!vectors || vectors.length !== slice.length) throw new InferenceError("malformed_output", "bedrock: Cohere embedding response did not match the batch", { provider: "bedrock" });
        for (const v of vectors) out.push(Float32Array.from(v));
      }
      return out;
    }
    // Titan embeds one text per call: keep a small concurrency pool.
    const out: Float32Array[] = new Array(texts.length);
    const pool = 4;
    let next = 0;
    const worker = async () => {
      while (next < texts.length) {
        const i = next++;
        if (opts.signal?.aborted) throw abortError();
        const res = await this.invokeJson<{ embedding?: number[] }>(model, { inputText: texts[i].slice(0, 24_000), normalize: true, ...(opts.dimensions ? { dimensions: opts.dimensions } : {}) }, opts.signal);
        if (!res.embedding) throw new InferenceError("malformed_output", "bedrock: Titan embedding response has no embedding", { provider: "bedrock" });
        out[i] = Float32Array.from(res.embedding);
      }
    };
    await Promise.all(Array.from({ length: Math.min(pool, texts.length) }, worker));
    return out;
  }

  private async invokeJson<T>(model: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const path = bedrockModelPath(model, "invoke");
    const json = JSON.stringify(body);
    const { url } = this.authorize(path, json, "application/json");
    const { res, clear } = await fetchWithRetry(url, () => ({ method: "POST", headers: this.authorize(path, json, "application/json").headers, body: json }), { provider: "bedrock", signal, timeoutMs: EMBED_TIMEOUT_MS, maxRetries: 3 });
    try { return (await res.json()) as T; } finally { clear(); }
  }
}

/** Request/response format is chosen by the model id prefix: `cohere.embed-*` vs Amazon Titan (`amazon.titan-embed-*`). */
export function embeddingKind(modelId: string): "titan" | "cohere" {
  const id = modelId.toLowerCase();
  return /(^|[./:])cohere\./.test(id) ? "cohere" : "titan";
}
