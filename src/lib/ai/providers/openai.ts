import "server-only";
/**
 * OpenAI Responses API provider: the wire logic that used to live in agent.ts (streaming tool loop, strict function
 * tools, json_schema structured output, previous_response_id continuation, web_search / code_interpreter /
 * image_generation built-ins, reasoning effort, usage incl. cached tokens) behind the ModelProvider contract.
 */
import type { Response, ResponseInput, ResponseInputItem, ResponseStreamEvent, Tool } from "openai/resources/responses/responses";
import { getOpenAI } from "../openai";
import { toStrictSchema } from "../tools";
import type { OpenAIEnv } from "./env";
import { abortError, isAbortError, isContextLengthError } from "./http";
export { isContextLengthError } from "./http";
import { isReasoningModel, outputTokenBudget } from "./openai-models";
import { renderEvidenceAsText } from "./anthropic-wire";
import { InferenceError, type ContentPart, type EmbedOptions, type ImageOptions, type InferenceEvent, type InferenceMessage, type InferenceRequest, type InferenceResult, type ModelDescriptor, type ModelProvider, type StopReason } from "./types";

type CreateParams = Parameters<ReturnType<typeof getOpenAI>["responses"]["create"]>[0];

/** LeClaude India: web search results are localised to India (approximate location, no city). */
const USER_LOCATION = { type: "approximate", country: "IN" } as const;

// ---------------- Input rendering ----------------

function textPartsToOpenAI(parts: ContentPart[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const p of parts) {
    if (p.type === "text") out.push({ type: "input_text", text: p.text });
    else if (p.type === "image") {
      const url = p.url ?? (p.data ? `data:${p.mime ?? "image/png"};base64,${p.data}` : null);
      if (url) out.push({ type: "input_image", image_url: url, detail: p.detail ?? "auto" });
    } else if (p.type === "document") out.push({ type: "input_file", filename: p.title ?? "document", file_data: `data:${p.mime};base64,${p.data}` });
    else if (p.type === "search_result") out.push({ type: "input_text", text: renderEvidenceAsText([p]) });
  }
  return out;
}

/**
 * Messages → Responses input items. With `previousResponseId` only the items after the last assistant turn are new
 * (the server holds the rest), unless `replayAll` says the local history was edited after that point and must be
 * replayed in full on top of `previousResponseId`.
 */
export function renderOpenAIInput(messages: InferenceMessage[], previousResponseId?: string | null, opts: { replayAll?: boolean } = {}): ResponseInput {
  let start = 0;
  if (previousResponseId && !opts.replayAll) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") { start = i + 1; break; }
  }
  const items: ResponseInputItem[] = [];
  for (const m of messages.slice(start)) {
    if (m.raw?.provider === "openai" && Array.isArray(m.raw.content)) { items.push(...(m.raw.content as ResponseInputItem[])); continue; }
    if (m.role === "tool") {
      for (const p of m.content) if (p.type === "tool_result") items.push({ type: "function_call_output", call_id: p.callId, output: p.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("");
      if (text.trim()) items.push({ role: "assistant", content: text } as ResponseInputItem);
      for (const p of m.content) if (p.type === "tool_call") items.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.args) });
      continue;
    }
    const parts = textPartsToOpenAI(m.content);
    if (!parts.length) continue;
    if (parts.length === 1 && parts[0].type === "input_text") items.push({ role: "user", content: String(parts[0].text) } as ResponseInputItem);
    else items.push({ role: "user", content: parts } as unknown as ResponseInputItem);
  }
  return detachReplayedOutputs(items);
}

/**
 * Replayed model outputs without their reasoning items: an output item that keeps its server id (`fc_…`, `msg_…`) is
 * bound to the reasoning item that preceded it, and the API rejects it when that reasoning item is not sent along (or
 * finds it a duplicate of a stored item). When the input carries no reasoning item, replayed function calls drop their
 * id (call_id stays) and assistant output messages become plain assistant messages. Inputs that do carry reasoning items
 * are sent exactly as given.
 */
function detachReplayedOutputs(items: ResponseInputItem[]): ResponseInputItem[] {
  const raw = items as unknown as Array<Record<string, unknown>>;
  if (raw.some((it) => it?.type === "reasoning")) return items;
  return raw.map((it) => {
    if (it?.type === "function_call" && "id" in it) {
      const { id: _id, status: _status, ...rest } = it;
      void _id; void _status;
      return rest;
    }
    if (it?.type === "message" && it.role === "assistant" && "id" in it) {
      const content = Array.isArray(it.content) ? (it.content as Array<Record<string, unknown>>).map((c) => (c?.type === "output_text" && typeof c.text === "string" ? c.text : c?.type === "refusal" && typeof c.refusal === "string" ? c.refusal : "")).join("") : String(it.content ?? "");
      return { role: "assistant", content };
    }
    return it;
  }) as unknown as ResponseInputItem[];
}

/** Built-in tool specs → OpenAI tool objects (the same shapes toolkit/web.ts builds). */
export function renderOpenAIBuiltins(req: InferenceRequest): Tool[] {
  const out: Tool[] = [];
  for (const b of req.builtins ?? []) {
    if (b.type === "web_search") out.push({ type: "web_search", search_context_size: b.contextSize ?? "medium", ...(b.allowedDomains?.length ? { filters: { allowed_domains: b.allowedDomains } } : {}), user_location: USER_LOCATION } as Tool);
    else if (b.type === "code_execution") out.push({ type: "code_interpreter", container: { type: "auto" } } as Tool);
    else if (b.type === "image_generation") out.push({ type: "image_generation", ...(b.size ? { size: b.size } : {}), ...(b.quality ? { quality: b.quality } : {}) } as Tool);
    else if (b.type === "web_fetch") throw new InferenceError("capability_unavailable", "OpenAI has no server web fetch tool; use the fetch_url tool.", { provider: "openai" });
  }
  return out;
}

export function buildOpenAIParams(req: InferenceRequest, model: string, cfg: Pick<OpenAIEnv, "reasoningEffort">, limits: { maxOutput?: number } = {}): CreateParams {
  const tools: Tool[] = [
    ...(req.tools ?? []).map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.strict !== false ? toStrictSchema(t.parameters) : t.parameters, strict: t.strict !== false })),
    ...renderOpenAIBuiltins(req),
  ];
  const messages = req.evidence?.length && !req.messages.some((m) => m.content.some((p) => p.type === "search_result"))
    ? withEvidenceText(req.messages, req.evidence)
    : req.messages;
  const params: CreateParams = {
    model,
    instructions: req.instructions,
    input: renderOpenAIInput(messages, req.previousResponseId, { replayAll: req.replayHistory }),
    tools: tools.length ? tools : undefined,
    previous_response_id: req.previousResponseId ?? undefined,
    max_output_tokens: outputTokenBudget(model, req.maxOutputTokens, limits.maxOutput),
    store: req.store ?? false,
    metadata: req.metadata,
    stream: true,
  };
  // No `truncation: "auto"`: the API would silently drop the oldest items (the task, the SOURCES block, early reads).
  // Overflow fails as a typed context_length error instead, and the runtime retries once with the elided local history
  // replayed (agent.ts), so whatever is left out is stated, never silent.
  if (req.parallelToolCalls != null) params.parallel_tool_calls = req.parallelToolCalls;
  if (req.toolChoice) params.tool_choice = typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", name: req.toolChoice.name };
  if (isReasoningModel(model)) {
    params.reasoning = { effort: req.reasoningEffort ?? cfg.reasoningEffort, ...(req.reasoningSummary ? { summary: "auto" as const } : {}) };
    if (req.verbosity) params.text = { ...(params.text ?? {}), verbosity: req.verbosity };
  } else if (req.temperature != null) {
    params.temperature = req.temperature;
  }
  if (req.jsonSchema) {
    params.text = { ...(params.text ?? {}), format: { type: "json_schema", name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true } };
  }
  return params;
}

function withEvidenceText(messages: InferenceMessage[], evidence: NonNullable<InferenceRequest["evidence"]>): InferenceMessage[] {
  const block: ContentPart = { type: "text", text: `SOURCES (cite by number):\n${renderEvidenceAsText(evidence)}` };
  const copy = messages.map((m) => ({ ...m }));
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === "user") { copy[i] = { role: "user", content: [block, ...copy[i].content] }; return copy; }
  }
  copy.push({ role: "user", content: [block] });
  return copy;
}

// ---------------- Provider ----------------

interface PendingCall { callId: string; name: string; args: string }

export class OpenAIProvider implements ModelProvider {
  readonly id = "openai" as const;
  constructor(private cfg: OpenAIEnv, private descriptors: ModelDescriptor[]) {}

  models(): ModelDescriptor[] { return this.descriptors; }
  isConfigured(): boolean { return Boolean(this.cfg.apiKey); }

  async infer(req: InferenceRequest, onEvent: (e: InferenceEvent) => void = () => {}): Promise<InferenceResult> {
    const model = req.model ?? this.cfg.model;
    const client = getOpenAI();
    const params = buildOpenAIParams(req, model, this.cfg, { maxOutput: this.descriptors.find((d) => d.id === model)?.maxOutput });
    const started = Date.now();
    onEvent({ type: "start", provider: "openai", model });

    let stream: AsyncIterable<ResponseStreamEvent>;
    try {
      stream = (await client.responses.create(params as CreateParams & { stream: true }, { signal: req.signal })) as AsyncIterable<ResponseStreamEvent>;
    } catch (e) {
      throw mapOpenAIError(e, req.signal);
    }

    const pending = new Map<string, PendingCall>();
    let text = "";
    let completed: Response | null = null;
    let incompleteReason: string | undefined;
    const citations: InferenceResult["citations"] = [];
    try {
      for await (const ev of stream) {
        switch (ev.type) {
          case "response.output_text.delta":
            text += ev.delta;
            onEvent({ type: "text.delta", delta: ev.delta });
            break;
          case "response.reasoning_summary_text.delta":
            onEvent({ type: "reasoning.delta", delta: ev.delta });
            break;
          case "response.output_item.added":
            if (ev.item.type === "function_call") pending.set(ev.item.id ?? ev.item.call_id, { callId: ev.item.call_id, name: ev.item.name, args: "" });
            if (ev.item.type === "web_search_call") onEvent({ type: "web_search", status: "searching" });
            break;
          case "response.function_call_arguments.done": {
            const p = pending.get(ev.item_id);
            if (p) p.args = ev.arguments;
            break;
          }
          case "response.output_item.done":
            if (ev.item.type === "function_call") {
              const p = pending.get(ev.item.id ?? ev.item.call_id) ?? { callId: ev.item.call_id, name: ev.item.name, args: "" };
              p.args = ev.item.arguments || p.args;
              pending.set(ev.item.id ?? ev.item.call_id, p);
            }
            if (ev.item.type === "web_search_call") {
              const action = (ev.item as { action?: { query?: string } }).action;
              onEvent({ type: "web_search", status: "completed", query: action?.query });
            }
            break;
          case "response.output_text.annotation.added": {
            const a = (ev as { annotation?: { type?: string; url?: string; title?: string } }).annotation;
            if (a?.type === "url_citation" && a.url) {
              const c = { source: a.url, url: a.url, title: a.title ?? a.url };
              citations.push(c);
              onEvent({ type: "citation", ...c });
            }
            break;
          }
          case "response.completed":
            completed = ev.response;
            break;
          case "response.failed": {
            const err = ev.response.error as { code?: string; message?: string } | null | undefined;
            throw new InferenceError(isContextLengthError(err?.code, err?.message) ? "context_length" : "provider_unavailable", err?.message ?? "Model response failed", { provider: "openai", retryable: false });
          }
          case "response.incomplete":
            completed = ev.response;
            incompleteReason = ev.response.incomplete_details?.reason ?? "unknown";
            break;
          case "error":
            throw new InferenceError("provider_unavailable", (ev as { message?: string }).message ?? "Stream error", { provider: "openai", retryable: false });
          default:
            break;
        }
      }
    } catch (e) {
      throw mapOpenAIError(e, req.signal);
    }

    const toolCalls: InferenceResult["toolCalls"] = [];
    for (const call of pending.values()) {
      if (!call.name) continue;
      let args: Record<string, unknown> = {};
      try { args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {}; } catch { args = {}; }
      toolCalls.push({ id: call.callId, name: call.name, args });
      onEvent({ type: "tool.call", id: call.callId, name: call.name, args });
    }

    const refusal = completed?.output?.flatMap((o) => (o.type === "message" ? o.content : [])).find((c) => c.type === "refusal") as { refusal?: string } | undefined;
    let stopReason: StopReason = toolCalls.length ? "tool_calls" : "end";
    if (incompleteReason) stopReason = incompleteReason === "max_output_tokens" ? "max_tokens" : "unknown";
    if (refusal?.refusal) stopReason = "refusal";

    const u = completed?.usage;
    const usage = { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, total: u?.total_tokens ?? 0, cacheRead: u?.input_tokens_details?.cached_tokens ?? 0 };
    onEvent({ type: "usage", usage });
    onEvent({ type: "done", stopReason });

    // Replayable assistant turn: message and function_call output items only (reasoning items reference server state).
    const rawItems = (completed?.output ?? []).filter((o) => o.type === "message" || o.type === "function_call");
    const parts: ContentPart[] = [];
    if (text.trim()) parts.push({ type: "text", text });
    for (const c of toolCalls) parts.push({ type: "tool_call", id: c.id, name: c.name, args: c.args });
    let json: unknown;
    if (req.jsonSchema && text) { try { json = JSON.parse(text); } catch { /* caller parses leniently */ } }

    return {
      provider: "openai",
      model: completed?.model ?? model,
      text: refusal?.refusal ? "" : text,
      json,
      toolCalls,
      citations,
      usage,
      stopReason,
      rawStopReason: stopReason === "unknown" ? incompleteReason : refusal?.refusal,
      responseId: completed?.id ?? null,
      messageId: completed?.id ?? undefined,
      latencyMs: Date.now() - started,
      assistantTurn: { role: "assistant", content: parts, raw: rawItems.length ? { provider: "openai", content: rawItems } : undefined },
    };
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const client = getOpenAI();
    const model = opts.model ?? this.cfg.embeddingModel;
    const out: Float32Array[] = [];
    try {
      for (let i = 0; i < texts.length; i += 96) {
        const slice = texts.slice(i, i + 96).map((t) => t.slice(0, 24_000));
        const res = await client.embeddings.create({ model, input: slice, encoding_format: "float", ...(opts.dimensions ? { dimensions: opts.dimensions } : {}) }, { signal: opts.signal });
        for (const d of res.data) out.push(Float32Array.from(d.embedding));
      }
    } catch (e) {
      throw mapOpenAIError(e, opts.signal);
    }
    return out;
  }

  async generateImage(prompt: string, opts: ImageOptions = {}): Promise<{ bytes: Uint8Array; mime: string; model: string }> {
    const client = getOpenAI();
    const model = this.cfg.imageModel;
    let res;
    try {
      res = await client.images.generate({ model, prompt: prompt.slice(0, 4000), size: (opts.size ?? "1024x1024") as "1024x1024", quality: (opts.quality ?? "medium") as "medium", n: 1 }, { signal: opts.signal });
    } catch (e) {
      throw mapOpenAIError(e, opts.signal);
    }
    const item = res.data?.[0];
    let bytes: Uint8Array | null = null;
    if (item?.b64_json) bytes = Uint8Array.from(Buffer.from(item.b64_json, "base64"));
    else if (item?.url) { const r = await fetch(item.url, { signal: opts.signal }); bytes = new Uint8Array(await r.arrayBuffer()); }
    if (!bytes) throw new InferenceError("malformed_output", "Image generation returned no image data", { provider: "openai" });
    return { bytes, mime: "image/png", model };
  }
}

/** OpenAI SDK errors → InferenceError; caller aborts stay AbortErrors. */
export function mapOpenAIError(e: unknown, signal?: AbortSignal): Error {
  if (e instanceof InferenceError) return e;
  if (isAbortError(e) || signal?.aborted) return abortError();
  const err = e as { status?: number; message?: string; name?: string; code?: string };
  const status = typeof err.status === "number" ? err.status : undefined;
  const message = `openai: ${err.message ?? String(e)}`;
  if (err.name === "APIConnectionTimeoutError") return new InferenceError("timeout", message, { provider: "openai", retryable: true });
  if (err.name === "APIConnectionError") return new InferenceError("provider_unavailable", message, { provider: "openai", retryable: true });
  if (status === 401 || status === 403) return new InferenceError("auth", message, { provider: "openai", status });
  if (status === 429) return new InferenceError("rate_limited", message, { provider: "openai", status });
  if ((status === 400 || status === 413) && isContextLengthError(err.code, err.message)) return new InferenceError("context_length", message, { provider: "openai", status, retryable: false });
  if (status != null && status >= 500) return new InferenceError("provider_unavailable", message, { provider: "openai", status });
  if (status != null) return new InferenceError("unknown", message, { provider: "openai", status, retryable: false });
  return e instanceof Error ? e : new Error(String(e));
}
