/**
 * Anthropic Messages API wire format, shared by the first-party provider (SSE over fetch) and Amazon Bedrock
 * (InvokeModelWithResponseStream, same JSON events inside an AWS event stream). Pure: no I/O.
 *
 * Request rules encoded here (constitution §25, §37; coordinator addendum):
 * - prefix order is tools → system → messages; with `cacheStablePrefix` one explicit `cache_control` breakpoint goes
 *   on the last system block, plus top-level automatic caching on Anthropic. Bedrock rejects the top-level field, so
 *   there the second breakpoint is the last tool_result block of the current turn. Never more than 4 breakpoints,
 *   never on volatile content; `ttl: "1h"` when `metadata.cacheTtl === "1h"`.
 * - application evidence is rendered as `search_result` blocks with citations enabled (all-or-none per request);
 *   with structured output the sources are rendered as numbered text instead (citations and `output_config.format`
 *   are incompatible).
 * - structured output uses `output_config.format` (json_schema) on models that support it; older models fall back to
 *   a forced tool call named after the schema. Forced tool use is rejected on Fable / Mythos / Opus 5.5.
 * - thinking follows the model family: adaptive (+ `output_config.effort`) on 4.6+, `budget_tokens` on older models.
 * - assistant turns are replayed verbatim (including thinking blocks and signatures) via `InferenceMessage.raw`.
 */
import { toStrictSchema, type JSONSchema } from "../tools";
import { CODE_EXECUTION_TOOL_VERSION, TOOL_EXAMPLES_BETA, claudeFamily, effortLevelsFor, normalizeClaudeModelId, supportsForcedToolChoice, supportsNativeStructuredOutput, webToolVersions } from "./claude-models";
import { modelLimits } from "./model-limits";
import { InferenceError, type CapabilityProfile, type ContentPart, type InferenceCitation, type InferenceEvent, type InferenceMessage, type InferenceRequest, type InferenceUsage, type ProviderId, type ReasoningEffort, type SearchResultBlock, type StopReason } from "./types";

export type AnthropicPlatform = "anthropic" | "bedrock";

export interface AnthropicWireOptions {
  platform: AnthropicPlatform;
  model: string;
  capabilities: CapabilityProfile;
  /** `max_tokens` when the request does not name one. */
  defaultMaxTokens: number;
  /** Legacy `budget_tokens` for budget-family models; 0 = no extended thinking there. */
  thinkingBudget: number;
  /** Send `input_examples` (feature flag ANTHROPIC_TOOL_EXAMPLES). */
  toolExamples: boolean;
  structuredOutput: "auto" | "native" | "tool";
  /** The model's maximum output (descriptor.maxOutput); defaults to the coded family limit. `max_tokens` never exceeds it. */
  maxOutputLimit?: number;
}

/** Beta that lets a request ask the API to drop thinking blocks invalidated by an edited history (preserved thinking). */
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

export interface AnthropicWireRequest {
  body: Record<string, unknown>;
  /** Beta flags: `anthropic-beta` header on Anthropic, `anthropic_beta` body field on Bedrock. */
  betas: string[];
  /** Set when structured output is delivered through a forced tool call. */
  structuredToolName?: string;
  thinkingEnabled: boolean;
}

const EFFORT_ORDER: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const effortAtLeast = (e: ReasoningEffort | undefined, floor: ReasoningEffort) => EFFORT_ORDER.indexOf(e ?? "medium") >= EFFORT_ORDER.indexOf(floor);

// ---------------- Schemas ----------------

/**
 * Anthropic strict tools / structured outputs need `additionalProperties: false` and `required` on every object and do
 * not document JSON-Schema type arrays; reuse the strict-mode transform and express nullable types as `anyOf`.
 */
export function toAnthropicSchema(schema: JSONSchema): JSONSchema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const n = { ...(node as Record<string, unknown>) };
    if (Array.isArray(n.type)) {
      const types = n.type as string[];
      const nonNull = types.filter((t) => t !== "null");
      if (types.includes("null") && nonNull.length === 1) {
        const { type: _t, description, ...rest } = n;
        void _t;
        return { anyOf: [walk({ ...rest, type: nonNull[0] }), { type: "null" }], ...(description ? { description } : {}) };
      }
    }
    for (const key of ["properties", "items", "anyOf", "allOf", "oneOf", "$defs", "definitions"] as const) {
      if (n[key] == null) continue;
      if (key === "properties" || key === "$defs" || key === "definitions") {
        n[key] = Object.fromEntries(Object.entries(n[key] as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
      } else n[key] = walk(n[key]);
    }
    return n;
  };
  return walk(toStrictSchema(schema)) as JSONSchema;
}

// ---------------- Thinking ----------------

export interface ThinkingPlan {
  thinking?: Record<string, unknown>;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Sampling parameters are accepted only without thinking on the families that still take them. */
  allowsTemperature: boolean;
}

export function thinkingConfig(model: string, effort: ReasoningEffort | undefined, budget: number, summarized: boolean): ThinkingPlan {
  const family = claudeFamily(model);
  const wantsThinking = effort !== "none" && effort !== "minimal";
  const display = summarized ? { display: "summarized" } : {};
  const mapEffort = (): "low" | "medium" | "high" | "xhigh" | "max" => {
    const levels = effortLevelsFor(model) ?? ["low", "medium", "high", "xhigh", "max"];
    const e = effort ?? "medium";
    if (e === "none" || e === "minimal" || e === "low") return "low";
    if (e === "medium") return "medium";
    if (e === "high") return "high";
    return levels.includes("xhigh") ? "xhigh" : "max";
  };
  if (family === "adaptive-always") {
    // Thinking cannot be turned off; depth is controlled by effort. Never send `disabled` or `budget_tokens`.
    return { thinking: wantsThinking ? { type: "adaptive", ...display } : undefined, effort: mapEffort(), allowsTemperature: false };
  }
  if (family === "adaptive") {
    const is46 = /^claude-(opus|sonnet)-4-6$/.test(normalizeClaudeModelId(model));
    if (!wantsThinking) return { effort: "low", allowsTemperature: is46 };
    return { thinking: { type: "adaptive", ...display }, effort: mapEffort(), allowsTemperature: false };
  }
  if (family === "budget") {
    if (wantsThinking && budget > 0 && effortAtLeast(effort, "medium")) return { thinking: { type: "enabled", budget_tokens: Math.max(1024, budget) }, allowsTemperature: false };
    return { allowsTemperature: true };
  }
  return { allowsTemperature: true };
}

// ---------------- Content rendering ----------------

function dataUrlToSource(url: string): { media_type: string; data: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1];
  const payload = m[3];
  const data = m[2] ? payload : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64");
  return { media_type: mime, data };
}

export function renderSearchResult(block: SearchResultBlock, citationsEnabled: boolean): Record<string, unknown> {
  return {
    type: "search_result",
    source: block.source,
    title: block.title,
    content: block.content.filter((t) => t.trim()).map((text) => ({ type: "text", text })),
    citations: { enabled: citationsEnabled },
  };
}

/** Numbered plain-text rendering of evidence for requests that cannot carry `search_result` blocks. */
export function renderEvidenceAsText(evidence: SearchResultBlock[]): string {
  return evidence.map((e, i) => `[${i + 1}] ${e.title}\nsource: ${e.source}\n${e.content.join("\n")}`).join("\n\n");
}

function renderPart(part: ContentPart, platform: AnthropicPlatform, citationsEnabled: boolean): Record<string, unknown> | null {
  switch (part.type) {
    case "text":
      return part.text.trim() ? { type: "text", text: part.text } : null;
    case "image": {
      if (part.data) return { type: "image", source: { type: "base64", media_type: part.mime ?? "image/png", data: part.data } };
      if (part.url?.startsWith("data:")) {
        const src = dataUrlToSource(part.url);
        return src ? { type: "image", source: { type: "base64", ...src } } : null;
      }
      if (part.url) {
        if (platform === "bedrock") throw new InferenceError("capability_unavailable", "Amazon Bedrock does not accept URL image sources; supply the image as base64 (data URL).", { provider: "bedrock" });
        return { type: "image", source: { type: "url", url: part.url } };
      }
      return null;
    }
    case "document":
      return { type: "document", source: { type: "base64", media_type: part.mime, data: part.data }, ...(part.title ? { title: part.title } : {}) };
    case "search_result":
      return renderSearchResult(part, citationsEnabled);
    case "tool_call":
      return { type: "tool_use", id: part.id, name: part.name, input: part.args };
    case "tool_result":
      return { type: "tool_result", tool_use_id: part.callId, ...(part.content ? { content: part.content } : {}), ...(part.isError ? { is_error: true } : {}) };
    default:
      return null;
  }
}

interface RenderedMessage { role: "user" | "assistant"; content: unknown[] }

function renderMessages(req: InferenceRequest, platform: AnthropicPlatform, citationsEnabled: boolean): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  for (const m of req.messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (m.raw?.provider === platform && Array.isArray(m.raw.content) && m.raw.content.length) {
      out.push({ role, content: m.raw.content });
      continue;
    }
    const content = m.content.map((p) => renderPart(p, platform, citationsEnabled)).filter((b): b is Record<string, unknown> => b != null);
    if (!content.length) continue;
    out.push({ role, content });
  }
  if (out.length && out[0].role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "(conversation continues)" }] });
  return out;
}

/**
 * Evidence goes with the current question: the last user turn that is not a tool-result turn, so it stays in the same
 * prefix position across tool rounds (stable cache, stable citation indexes) and never precedes `tool_result` blocks,
 * which the API requires at the start of their message.
 */
function attachEvidence(messages: RenderedMessage[], evidence: SearchResultBlock[], asText: boolean): void {
  const blocks: unknown[] = asText ? [{ type: "text", text: `SOURCES (cite by number):\n${renderEvidenceAsText(evidence)}` }] : evidence.map((e) => renderSearchResult(e, true));
  const isToolResult = (b: unknown) => (b as { type?: string })?.type === "tool_result";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user" || messages[i].content.some(isToolResult)) continue;
    messages[i] = { role: "user", content: [...blocks, ...messages[i].content] };
    return;
  }
  // Only tool-result turns (or nothing) to attach to: keep tool_result blocks first.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const content = messages[i].content;
    const firstOther = content.findIndex((b) => !isToolResult(b));
    const at = firstOther < 0 ? content.length : firstOther;
    messages[i] = { role: "user", content: [...content.slice(0, at), ...blocks, ...content.slice(at)] };
    return;
  }
  messages.push({ role: "user", content: blocks });
}

// ---------------- Request builder ----------------

export function buildAnthropicRequest(req: InferenceRequest, opts: AnthropicWireOptions): AnthropicWireRequest {
  const betas = new Set<string>();
  const caps = opts.capabilities;
  const body: Record<string, unknown> = {};
  const ttl = req.metadata?.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const structured = req.jsonSchema ? (opts.structuredOutput === "auto" ? (supportsNativeStructuredOutput(opts.model) ? "native" : "tool") : opts.structuredOutput) : null;
  const evidenceAsText = Boolean(req.jsonSchema) || !caps.searchResultBlocks || !caps.citations;

  if (opts.platform === "anthropic") { body.model = opts.model; body.stream = true; }

  // System prompt (stable prefix) — the only place a cache breakpoint is guaranteed.
  if (req.instructions?.trim()) {
    body.system = [{ type: "text", text: req.instructions, ...(req.cacheStablePrefix ? { cache_control: ttl } : {}) }];
  }

  // Messages
  const messages = renderMessages(req, opts.platform, !evidenceAsText);
  if (req.evidence?.length) attachEvidence(messages, req.evidence, evidenceAsText);
  if (!messages.length) throw new InferenceError("unknown", "Anthropic request has no renderable messages.", { provider: opts.platform, status: 400 });
  if (req.cacheStablePrefix && opts.platform === "bedrock") {
    // No automatic caching on Bedrock: mark the last tool_result of the current turn so long tool loops keep hitting.
    const last = messages[messages.length - 1];
    if (last.role === "user") {
      const lastBlock = last.content[last.content.length - 1] as Record<string, unknown> | undefined;
      if (lastBlock?.type === "tool_result") last.content[last.content.length - 1] = { ...lastBlock, cache_control: ttl };
    }
  }
  body.messages = messages;

  // Tools: custom function tools, then server tools.
  const tools: Record<string, unknown>[] = [];
  const codeExecution = (req.builtins ?? []).some((b) => b.type === "code_execution");
  const ptc = caps.programmaticToolCalling && caps.codeExecution && codeExecution;
  for (const t of req.tools ?? []) {
    const strict = caps.strictTools && t.strict !== false;
    const def: Record<string, unknown> = { name: t.name, description: t.description, input_schema: strict ? toAnthropicSchema(t.parameters) : t.parameters };
    if (strict) def.strict = true;
    if (opts.toolExamples && caps.toolUseExamples && t.examples?.length) { def.input_examples = t.examples; betas.add(TOOL_EXAMPLES_BETA); }
    if (ptc && t.callers?.length) def.allowed_callers = t.callers.map((c) => (c === "code_execution" ? CODE_EXECUTION_TOOL_VERSION : "direct"));
    tools.push(def);
  }
  const web = webToolVersions(opts.model);
  for (const b of req.builtins ?? []) {
    if (b.type === "web_search") {
      if (!caps.serverWebSearch) throw new InferenceError("capability_unavailable", `${opts.platform} has no server web search; route this request to a provider with serverWebSearch.`, { provider: opts.platform });
      tools.push({ type: web.search, name: "web_search", ...(b.allowedDomains?.length ? { allowed_domains: b.allowedDomains } : {}), user_location: { type: "approximate", country: "IN" } });
      for (const beta of web.betas) betas.add(beta);
    } else if (b.type === "web_fetch") {
      if (!caps.serverWebFetch) throw new InferenceError("capability_unavailable", `${opts.platform} has no server web fetch.`, { provider: opts.platform });
      tools.push({ type: web.fetch, name: "web_fetch" });
      for (const beta of web.betas) betas.add(beta);
    } else if (b.type === "code_execution") {
      if (!caps.codeExecution) throw new InferenceError("capability_unavailable", `${opts.platform} has no server code execution.`, { provider: opts.platform });
      tools.push({ type: CODE_EXECUTION_TOOL_VERSION, name: "code_execution" });
    } else if (b.type === "image_generation") {
      throw new InferenceError("capability_unavailable", `${opts.platform} has no image generation tool.`, { provider: opts.platform });
    }
  }

  // Thinking / effort
  const plan = thinkingConfig(opts.model, req.reasoningEffort, opts.thinkingBudget, Boolean(req.reasoningSummary));
  const outputConfig: Record<string, unknown> = {};
  if (plan.effort) outputConfig.effort = plan.effort;

  // Structured output
  let structuredToolName: string | undefined;
  let toolChoice: Record<string, unknown> | undefined;
  if (req.jsonSchema && structured === "native") {
    outputConfig.format = { type: "json_schema", schema: toAnthropicSchema(req.jsonSchema.schema) };
  } else if (req.jsonSchema && structured === "tool") {
    if (!supportsForcedToolChoice(opts.model)) throw new InferenceError("capability_unavailable", `Model "${opts.model}" rejects forced tool use; set ${opts.platform === "bedrock" ? "BEDROCK" : "ANTHROPIC"}_STRUCTURED_OUTPUT=native.`, { provider: opts.platform });
    structuredToolName = req.jsonSchema.name;
    tools.push({ name: structuredToolName, description: "Record the final answer. Call this exactly once with the complete result when you are done.", input_schema: toAnthropicSchema(req.jsonSchema.schema) });
    toolChoice = tools.length > 1 ? { type: "any" } : { type: "tool", name: structuredToolName };
    // Forced tool use is incompatible with manual thinking; Bedrock additionally requires it to be disabled explicitly.
    plan.thinking = opts.platform === "bedrock" ? { type: "disabled" } : undefined;
    plan.allowsTemperature = false;
  }
  if (!toolChoice && tools.length && req.toolChoice) {
    const tc = req.toolChoice;
    toolChoice = tc === "auto" ? { type: "auto" } : tc === "none" ? { type: "none" } : tc === "required" ? { type: "any" } : { type: "tool", name: tc.name };
  }
  if (tools.length && req.parallelToolCalls === false) toolChoice = { ...(toolChoice ?? { type: "auto" }), disable_parallel_tool_use: true };
  if (tools.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (plan.thinking) body.thinking = plan.thinking;
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if (req.temperature != null && plan.allowsTemperature) body.temperature = req.temperature;

  // max_tokens: thinking tokens count against it, so give reasoning requests the same headroom the OpenAI path has,
  // and never ask for more than the model can produce (a 400, not a longer answer).
  const limit = opts.maxOutputLimit && opts.maxOutputLimit > 0 ? opts.maxOutputLimit : modelLimits(opts.platform, opts.model).maxOutput;
  const requested = Math.max(1, Math.min(req.maxOutputTokens ?? opts.defaultMaxTokens, limit));
  let maxTokens = requested;
  const budgetThinking = plan.thinking && (plan.thinking as { type?: string }).type === "enabled";
  if (budgetThinking) maxTokens = Math.max(requested, opts.thinkingBudget + Math.max(1024, requested));
  else if (plan.thinking) maxTokens = Math.max(requested * 3, requested + 16_000);
  maxTokens = Math.max(1, Math.floor(Math.min(maxTokens, limit)));
  if (budgetThinking) {
    // budget_tokens must stay below max_tokens (and at least 1024): shrink it under a small limit, or drop thinking.
    const budget = Number((plan.thinking as { budget_tokens?: number }).budget_tokens ?? 0);
    if (budget >= maxTokens) {
      const fitted = Math.min(budget, maxTokens - 1024);
      if (fitted >= 1024) body.thinking = { ...(plan.thinking as Record<string, unknown>), budget_tokens: fitted };
      else delete body.thinking;
    }
  }
  body.max_tokens = maxTokens;

  // Preserved thinking: after the runtime elided earlier tool results, thinking blocks produced over the old prefix no
  // longer match. Ask the API to drop them (this request only; the runtime keeps sending it for the rest of the run).
  if (req.historyEdited && body.thinking && (body.thinking as { type?: string }).type !== "disabled") {
    body.thinking = { ...(body.thinking as Record<string, unknown>), block_binding: { prefix_mismatch_behavior: "drop_block" } };
    betas.add(THINKING_BINDING_BETA);
  } else if (req.historyEdited && !body.thinking && claudeFamily(opts.model) === "adaptive-always") {
    // Thinking is always on for this family; `{type: "adaptive"}` is equivalent to omitting it and carries the binding.
    body.thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } };
    betas.add(THINKING_BINDING_BETA);
  }

  if (opts.platform === "anthropic") {
    if (req.cacheStablePrefix) body.cache_control = ttl;
    if (req.containerId && ptc) body.container = req.containerId;
  }

  return { body, betas: Array.from(betas), structuredToolName, thinkingEnabled: Boolean(body.thinking && (body.thinking as { type?: string }).type !== "disabled") };
}

// ---------------- Stream parser ----------------

export interface ParsedAnthropicMessage {
  messageId?: string;
  model?: string;
  containerId?: string;
  stopReason: StopReason;
  rawStopReason?: string;
  text: string;
  json?: unknown;
  toolCalls: { id: string; name: string; args: Record<string, unknown>; caller?: "direct" | "code_execution" }[];
  citations: InferenceCitation[];
  usage: InferenceUsage;
  /** Assistant content blocks exactly as received (thinking blocks keep their signatures). */
  blocks: Record<string, unknown>[];
  assistantTurn: InferenceMessage;
  complete: boolean;
}

interface BlockState { block: Record<string, unknown>; json: string }

function mapStopReason(raw: string | null | undefined, hasClientToolCalls: boolean): StopReason {
  switch (raw) {
    case "end_turn": case "stop_sequence": return hasClientToolCalls ? "tool_calls" : "end";
    case "tool_use": return hasClientToolCalls ? "tool_calls" : "end";
    case "max_tokens": case "model_context_window_exceeded": return "max_tokens";
    case "refusal": return "refusal";
    case "pause_turn": return "pause_turn";
    case null: case undefined: return "error";
    default: return "unknown";
  }
}

export function mapAnthropicErrorType(type: string | undefined): { code: InferenceError["code"]; retryable: boolean; status: number } {
  switch (type) {
    case "overloaded_error": return { code: "provider_unavailable", retryable: true, status: 529 };
    case "api_error": return { code: "provider_unavailable", retryable: true, status: 500 };
    case "rate_limit_error": return { code: "rate_limited", retryable: true, status: 429 };
    case "authentication_error": case "permission_error": return { code: "auth", retryable: false, status: 401 };
    case "not_found_error": return { code: "unknown", retryable: false, status: 404 };
    case "request_too_large": return { code: "context_length", retryable: false, status: 413 };
    case "billing_error": return { code: "auth", retryable: false, status: 402 };
    case "timeout_error": return { code: "timeout", retryable: true, status: 504 };
    default: return { code: "unknown", retryable: false, status: 400 };
  }
}

/**
 * Consumes Messages API stream events (`message_start` … `message_stop`) and emits provider-neutral InferenceEvents.
 * Works for the direct SSE stream and for the JSON events Bedrock wraps in its event stream.
 */
export class AnthropicStreamParser {
  private blocks = new Map<number, BlockState>();
  private order: number[] = [];
  private serverToolQueries = new Map<string, string>();
  private messageId?: string;
  private model?: string;
  private containerId?: string;
  private rawStop: string | null | undefined;
  private usage: InferenceUsage = { input: 0, output: 0, total: 0 };
  private uncachedInput = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private stopped = false;
  private _emitted = false;

  constructor(private onEvent: (e: InferenceEvent) => void, private opts: { provider: ProviderId; structuredToolName?: string }) {}

  /** True once any user-visible output (text, reasoning, tool call, citation) was emitted — retries must not restart then. */
  get emitted(): boolean { return this._emitted; }

  private emit(e: InferenceEvent) {
    if (e.type === "text.delta" || e.type === "reasoning.delta" || e.type === "tool.call" || e.type === "citation") this._emitted = true;
    this.onEvent(e);
  }

  handle(ev: unknown): void {
    if (!ev || typeof ev !== "object") return;
    const e = ev as Record<string, unknown>;
    switch (e.type) {
      case "message_start": {
        const message = (e.message ?? {}) as Record<string, unknown>;
        this.messageId = typeof message.id === "string" ? message.id : undefined;
        this.model = typeof message.model === "string" ? message.model : undefined;
        const container = message.container as { id?: string } | undefined;
        if (container?.id) this.containerId = container.id;
        this.applyUsage(message.usage as Record<string, unknown> | undefined);
        break;
      }
      case "content_block_start": {
        const index = Number(e.index);
        const src = (e.content_block ?? {}) as Record<string, unknown>;
        const block: Record<string, unknown> = { ...src };
        if (block.type === "text") block.text = typeof block.text === "string" ? block.text : "";
        if (block.type === "thinking") { block.thinking = typeof block.thinking === "string" ? block.thinking : ""; if (block.signature == null) block.signature = ""; }
        if ((block.type === "tool_use" || block.type === "server_tool_use") && (block.input == null || typeof block.input !== "object")) block.input = {};
        this.blocks.set(index, { block, json: "" });
        this.order.push(index);
        if (block.type === "server_tool_use" && block.name === "web_search") this.emit({ type: "web_search", status: "searching" });
        if (block.type === "web_search_tool_result") this.emit({ type: "web_search", status: "completed", query: this.serverToolQueries.get(String(block.tool_use_id ?? "")) });
        break;
      }
      case "content_block_delta": {
        const state = this.blocks.get(Number(e.index));
        const delta = (e.delta ?? {}) as Record<string, unknown>;
        if (!state) break;
        switch (delta.type) {
          case "text_delta": {
            const text = String(delta.text ?? "");
            state.block.text = String(state.block.text ?? "") + text;
            if (text) this.emit({ type: "text.delta", delta: text });
            break;
          }
          case "input_json_delta":
            state.json += String(delta.partial_json ?? "");
            break;
          case "thinking_delta": {
            const t = String(delta.thinking ?? "");
            state.block.thinking = String(state.block.thinking ?? "") + t;
            if (t) this.emit({ type: "reasoning.delta", delta: t });
            break;
          }
          case "signature_delta":
            state.block.signature = String(delta.signature ?? "");
            break;
          case "citations_delta": {
            const c = (delta.citation ?? {}) as Record<string, unknown>;
            const list = Array.isArray(state.block.citations) ? (state.block.citations as unknown[]) : [];
            list.push(c);
            state.block.citations = list;
            const mapped = mapCitation(c);
            if (mapped) this.emit({ type: "citation", ...mapped });
            break;
          }
          default:
            break;
        }
        break;
      }
      case "content_block_stop": {
        const state = this.blocks.get(Number(e.index));
        if (!state) break;
        const b = state.block;
        if (b.type === "tool_use" || b.type === "server_tool_use") {
          if (state.json.trim()) {
            try { b.input = JSON.parse(state.json) as Record<string, unknown>; } catch { b.input = { _malformed_json: state.json.slice(0, 2000) }; }
          }
          if (b.type === "server_tool_use") {
            const q = (b.input as { query?: unknown })?.query;
            if (typeof q === "string") this.serverToolQueries.set(String(b.id), q);
          } else if (b.name !== this.opts.structuredToolName) {
            this.emit({ type: "tool.call", id: String(b.id), name: String(b.name), args: (b.input as Record<string, unknown>) ?? {}, caller: callerOf(b) });
          }
        }
        break;
      }
      case "message_delta": {
        const delta = (e.delta ?? {}) as Record<string, unknown>;
        if (delta.stop_reason !== undefined) this.rawStop = delta.stop_reason as string | null;
        const container = delta.container as { id?: string } | undefined;
        if (container?.id) this.containerId = container.id;
        this.applyUsage(e.usage as Record<string, unknown> | undefined);
        break;
      }
      case "message_stop":
        this.stopped = true;
        break;
      case "error": {
        const err = (e.error ?? {}) as { type?: string; message?: string };
        const m = mapAnthropicErrorType(err.type);
        throw new InferenceError(m.code, `${this.opts.provider} stream error${err.type ? ` (${err.type})` : ""}: ${err.message ?? "unknown"}`, { provider: this.opts.provider, status: m.status, retryable: m.retryable && !this._emitted });
      }
      default:
        break;
    }
  }

  private applyUsage(u: Record<string, unknown> | undefined) {
    if (!u) return;
    if (typeof u.input_tokens === "number") this.uncachedInput = u.input_tokens;
    if (typeof u.cache_read_input_tokens === "number") this.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") this.cacheWrite = u.cache_creation_input_tokens;
    if (typeof u.output_tokens === "number") this.usage.output = u.output_tokens;
  }

  finish(): ParsedAnthropicMessage {
    const blocks = this.order.map((i) => this.blocks.get(i)!.block);
    const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    const structured = this.opts.structuredToolName ? toolUses.find((b) => b.name === this.opts.structuredToolName) : undefined;
    const toolCalls = toolUses.filter((b) => b !== structured).map((b) => ({ id: String(b.id), name: String(b.name), args: ((b.input as Record<string, unknown>) ?? {}), caller: callerOf(b) }));
    const citations: InferenceCitation[] = [];
    for (const b of blocks) if (b.type === "text" && Array.isArray(b.citations)) for (const c of b.citations as Record<string, unknown>[]) { const m = mapCitation(c); if (m) citations.push(m); }
    const input = this.uncachedInput + this.cacheRead + this.cacheWrite;
    const usage: InferenceUsage = { input, output: this.usage.output, total: input + this.usage.output, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite };
    const json = structured ? structured.input : undefined;
    const stopReason = mapStopReason(this.stopped ? this.rawStop : this.rawStop ?? null, toolCalls.length > 0);
    const parts: ContentPart[] = [];
    for (const b of blocks) {
      if (b.type === "text" && String(b.text ?? "").trim()) parts.push({ type: "text", text: String(b.text) });
      if (b.type === "tool_use" && b !== structured) parts.push({ type: "tool_call", id: String(b.id), name: String(b.name), args: ((b.input as Record<string, unknown>) ?? {}) });
    }
    return {
      messageId: this.messageId,
      model: this.model,
      containerId: this.containerId,
      stopReason,
      rawStopReason: this.rawStop ?? undefined,
      text: text || (json !== undefined ? JSON.stringify(json) : ""),
      json,
      toolCalls,
      citations,
      usage,
      blocks,
      assistantTurn: { role: "assistant", content: parts, raw: { provider: this.opts.provider, content: blocks } },
      complete: this.stopped,
    };
  }
}

function callerOf(b: Record<string, unknown>): "direct" | "code_execution" | undefined {
  const caller = b.caller as { type?: string } | undefined;
  if (!caller?.type) return undefined;
  return caller.type === "direct" ? "direct" : "code_execution";
}

function mapCitation(c: Record<string, unknown>): Omit<Extract<InferenceEvent, { type: "citation" }>, "type"> | null {
  const quote = typeof c.cited_text === "string" ? c.cited_text : undefined;
  switch (c.type) {
    case "search_result_location":
      return { source: String(c.source ?? ""), title: typeof c.title === "string" ? c.title : undefined, quote, blockIndex: typeof c.search_result_index === "number" ? c.search_result_index : undefined };
    case "web_search_result_location":
      return { source: String(c.url ?? ""), url: typeof c.url === "string" ? c.url : undefined, title: typeof c.title === "string" ? c.title : undefined, quote };
    case "char_location": case "page_location": case "content_block_location":
      return { source: `document:${typeof c.document_index === "number" ? c.document_index : 0}`, title: typeof c.document_title === "string" ? c.document_title : undefined, quote, blockIndex: typeof c.document_index === "number" ? c.document_index : undefined };
    default:
      return null;
  }
}
