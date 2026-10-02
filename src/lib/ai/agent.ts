import "server-only";
import type { ResponseInput, ResponseInputItem, Tool } from "openai/resources/responses/responses";
import { aiConfig, AIConfigError, type AIConfig } from "./config";
import { infer, routeRequest } from "./runtime";
import * as toolsModule from "./tools";
import { normalizeArgs, toolLabel, toStrictSchema, type AgentEmit, type ToolContext, type ToolDef } from "./tools";
import { InferenceError, type BuiltinToolSpec, type ContentPart, type InferenceEvent, type InferenceMessage, type InferenceRequest, type InferenceResult, type ModelDescriptor, type ModelRole, type PrivacyBoundary, type RoutingDecision, type SearchResultBlock, type TaskType, type ToolSpec } from "./providers/types";
import { estimateTokens, resolveContextBudget, type BudgetProfileId, type ResolvedBudget } from "./context-budget";

export { outputTokenBudget } from "./providers/openai-models";

/**
 * Agent runtime facade. Every model call in LeClaude goes through runAgent / generateText / generateJSON /
 * describeImage; they translate the historical OpenAI-shaped options into provider-neutral InferenceRequests and let
 * src/lib/ai/runtime.ts route them (Bedrock → Anthropic → OpenAI, or MODEL_PROVIDER). Public signatures and the
 * streamed AgentEvent vocabulary are unchanged; new options are additive.
 */

/** Extract the first JSON object/array from model text (tolerates code fences and prose). */
export function parseModelJSON<T = unknown>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t) as T; } catch { /* fall through */ }
  const start = Math.min(...[t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0));
  if (!Number.isFinite(start)) throw new Error("Model returned no JSON");
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  return JSON.parse(t.slice(start, end + 1)) as T;
}

export type AgentEvent =
  | { type: "start"; model: string }
  | { type: "text.delta"; delta: string }
  | { type: "text.done"; text: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "tool.call"; id: string; name: string; label: string; args: Record<string, unknown>; caller?: "direct" | "code_execution" }
  | { type: "tool.result"; id: string; name: string; ok: boolean; result?: unknown; error?: string; durationMs: number }
  | { type: "web_search"; status: "searching" | "completed"; query?: string }
  | { type: "step"; step: number }
  | { type: "done"; responseId: string | null; usage?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number }; text: string }
  | { type: "error"; message: string; code?: string }
  | AgentEmit;

export interface RunAgentOptions {
  /** Developer/system instructions. */
  instructions: string;
  /** Conversation input: string or Responses input items (messages, tool outputs). */
  input: string | ResponseInput;
  tools?: ToolDef<never, unknown>[];
  /** Built-in tools in OpenAI Tool shape (web_search, image_generation…); translated per provider. */
  builtinTools?: Tool[];
  model?: string;
  /** Route to the fast model role (short, single-intent turns); ignored when `model` names another model. */
  fast?: boolean;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  verbosity?: "low" | "medium" | "high";
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Shared state visible to tools. */
  state?: Record<string, unknown>;
  /** Continue a stored conversation (honoured on OpenAI only; other providers replay the local history). */
  previousResponseId?: string | null;
  /** Structured output: JSON schema for the final message. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  parallelToolCalls?: boolean;
  onEvent: (event: AgentEvent) => void;
  /** Where to emit tool progress; defaults to onEvent. */
  metadata?: Record<string, string>;
  // ---- additive routing / evidence options ----
  /** Coarse task type for routing and telemetry (default "chat"). */
  taskType?: TaskType;
  /** Data boundary of the request; "internal" (default) never reaches an external router. */
  privacy?: PrivacyBoundary;
  matterId?: string;
  /** Application-owned evidence, rendered as citation-native search_result blocks where supported. */
  evidence?: SearchResultBlock[];
  /** Mark instructions + tools as a stable prefix for prompt caching (default true: tool rounds reuse it). */
  cacheStablePrefix?: boolean;
  /** Run/trace ids propagated to tools and telemetry. */
  traceId?: string;
  runId?: string;
  /**
   * Context-budget profile (src/lib/ai/context-budget.ts), resolved against the model the router picks: supplies the
   * default `maxOutputTokens` and `maxSteps` and the input-token limit of the context guard.
   */
  budget?: BudgetProfileId;
}

export interface RunAgentResult {
  text: string;
  responseId: string | null;
  steps: number;
  toolCalls: { name: string; args: Record<string, unknown>; result?: unknown; error?: string }[];
  usage: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  json?: unknown;
  /** The resolved budget when `budget` was given. */
  budget?: ResolvedBudget;
  /** Earlier tool results the context guard elided (0 when the history fit). */
  elided?: number;
}

// ---------------------------------------------------------------------------
// Input conversion: OpenAI Responses items → provider-neutral messages.
// ---------------------------------------------------------------------------

function contentToParts(content: unknown): ContentPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (const c of content as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") continue;
    if ((c.type === "input_text" || c.type === "output_text") && typeof c.text === "string") parts.push({ type: "text", text: c.text });
    else if (c.type === "input_image") {
      const url = typeof c.image_url === "string" ? c.image_url : (c.image_url as { url?: string } | undefined)?.url;
      if (url) parts.push({ type: "image", url, detail: (c.detail as "low" | "high" | "auto" | undefined) ?? "auto" });
    } else if (c.type === "input_file" && typeof c.file_data === "string") {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(c.file_data);
      if (m) parts.push({ type: "document", mime: m[1], data: m[2], title: typeof c.filename === "string" ? c.filename : undefined });
    } else if (c.type === "refusal" && typeof c.refusal === "string") parts.push({ type: "text", text: c.refusal });
  }
  return parts;
}

/** Convert Responses input into messages. Each item keeps its original shape in `raw` so OpenAI replays it verbatim. */
export function toInferenceMessages(input: string | ResponseInput): { messages: InferenceMessage[]; extraInstructions: string[] } {
  if (typeof input === "string") return { messages: [{ role: "user", content: [{ type: "text", text: input }] }], extraInstructions: [] };
  const messages: InferenceMessage[] = [];
  const extraInstructions: string[] = [];
  for (const item of input as ResponseInputItem[]) {
    const it = item as unknown as Record<string, unknown>;
    const raw = { provider: "openai" as const, content: [item as unknown] };
    if (it.type === "function_call_output") {
      messages.push({ role: "tool", content: [{ type: "tool_result", callId: String(it.call_id), content: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "") }], raw });
      continue;
    }
    if (it.type === "function_call") {
      let args: Record<string, unknown> = {};
      try { args = it.arguments ? (JSON.parse(String(it.arguments)) as Record<string, unknown>) : {}; } catch { args = {}; }
      messages.push({ role: "assistant", content: [{ type: "tool_call", id: String(it.call_id), name: String(it.name), args }], raw });
      continue;
    }
    if (typeof it.role === "string" && (it.type == null || it.type === "message")) {
      if (it.role === "system" || it.role === "developer") {
        const text = contentToParts(it.content).filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("\n");
        if (text.trim()) extraInstructions.push(text);
        continue;
      }
      messages.push({ role: it.role === "assistant" ? "assistant" : "user", content: contentToParts(it.content), raw });
      continue;
    }
    // Other Responses item kinds (reasoning, web_search_call, …) only make sense on OpenAI: replay there, skip elsewhere.
    messages.push({ role: "user", content: [], raw });
  }
  return { messages, extraInstructions };
}

/** OpenAI-shaped built-in tools → provider-neutral specs (toolkit/web.ts builds the OpenAI shape today). */
export function builtinsFromOpenAITools(tools: Tool[] | undefined): BuiltinToolSpec[] {
  const out: BuiltinToolSpec[] = [];
  for (const t of tools ?? []) {
    const raw = t as unknown as Record<string, unknown>;
    if (raw.type === "web_search" || raw.type === "web_search_preview" || raw.type === "web_search_2025_08_26") {
      const filters = raw.filters as { allowed_domains?: string[] } | null | undefined;
      out.push({ type: "web_search", contextSize: raw.search_context_size as "low" | "medium" | "high" | undefined, allowedDomains: filters?.allowed_domains });
    } else if (raw.type === "code_interpreter") out.push({ type: "code_execution" });
    else if (raw.type === "image_generation") out.push({ type: "image_generation", size: raw.size as string | undefined, quality: raw.quality as string | undefined });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ToolDef ↔ provider tool spec / execution. Kept in one place so tools.ts's
// runTool / toProviderToolSpec (owned by another workstream) can take over.
// ---------------------------------------------------------------------------

/** tools.ts exports (owned by the tools workstream); detected at runtime so this loop works with or without them. */
type ToolsModuleExtras = {
  toProviderToolSpec?: (def: ToolDef<never, unknown>) => ToolSpec;
  runTool?: (def: ToolDef<never, unknown>, args: Record<string, unknown>, ctx: ToolContext) => Promise<{ ok: boolean; value: unknown; output: string; error?: { error: string; code: string } }>;
};
const toolsExtras = toolsModule as unknown as ToolsModuleExtras;

function toToolSpec(def: ToolDef<never, unknown>): ToolSpec {
  const extra = def as unknown as { examples?: Record<string, unknown>[]; callers?: ("direct" | "code_execution")[] };
  if (typeof toolsExtras.toProviderToolSpec === "function") return { ...toolsExtras.toProviderToolSpec(def), callers: extra.callers };
  return { name: def.name, description: def.description, parameters: def.parameters, strict: def.strict !== false, examples: extra.examples, callers: extra.callers };
}

/** Normalised tool outcome: `value` for the UI/result log, `output` for the model, `error` when it failed. */
interface ToolOutcome { ok: boolean; value?: unknown; output: string; error?: string }

async function executeTool(def: ToolDef<never, unknown>, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  if (typeof toolsExtras.runTool === "function") {
    // runTool applies authorize → timeout → bounded result → deterministic error shape and emits tool traces.
    const r = await toolsExtras.runTool(def, args, ctx);
    if (!r.ok) return { ok: false, value: r.value, output: r.output || JSON.stringify(r.error ?? { error: "tool failed" }), error: r.error?.error ?? "tool failed" };
    return { ok: true, value: r.value, output: r.output };
  }
  try {
    const value = await def.execute(args as never, ctx);
    return { ok: true, value, output: serializeToolOutput(value) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, output: JSON.stringify({ error }), error };
  }
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

/** A model id equal to the configured default for a role is a role hint (so capability routing can still pick the provider); anything else is explicit. */
function resolveTarget(model: string | undefined, fast: boolean | undefined, cfg: AIConfig): { explicitModel?: string; role: ModelRole } {
  if (!model) return { role: fast ? "fast" : "primary" };
  if (model === cfg.fastModel) return { role: "fast" };
  if (model === cfg.model) return { role: "primary" };
  return { explicitModel: model, role: fast ? "fast" : "primary" };
}

function mapConfigError(e: unknown): unknown {
  if (e instanceof InferenceError && e.code === "not_configured") return new AIConfigError(e.message);
  return e;
}

function citationEvent(e: Extract<InferenceEvent, { type: "citation" }>): AgentEmit {
  return { type: "citation", citation: { title: e.title ?? e.source, url: e.url, cite: e.url ? undefined : e.source, snippet: e.quote, source: e.url ? "web" : "evidence" } };
}

const MAX_TOOL_OUTPUT_CHARS = 60_000;

function serializeToolOutput(result: unknown): string {
  const s = typeof result === "string" ? result : JSON.stringify(result ?? null);
  return s.length > MAX_TOOL_OUTPUT_CHARS ? s.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n…[truncated]" : s;
}

/** Keep client-side tool result payloads small. */
function summarizeForClient(result: unknown): unknown {
  const s = typeof result === "string" ? result : JSON.stringify(result ?? null);
  if (s.length <= 4000) return result;
  return { preview: s.slice(0, 4000) + "…", truncated: true, length: s.length };
}

function tryParse(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Context guard: keep the replayed history inside the model's input budget
// ---------------------------------------------------------------------------

const ELIDED_PREFIX = "[elided ";

/** Estimated tokens of one message (typed content; provider-native replay content when larger). */
export function estimateMessageTokens(m: InferenceMessage): number {
  let t = 4;
  for (const p of m.content) {
    switch (p.type) {
      case "text": t += estimateTokens(p.text); break;
      case "tool_result": t += estimateTokens(p.content) + 6; break;
      case "tool_call": t += estimateTokens(JSON.stringify(p.args ?? {})) + estimateTokens(p.name) + 8; break;
      case "search_result": t += estimateTokens(p.title) + estimateTokens(p.source) + p.content.reduce((a, c) => a + estimateTokens(c), 0) + 8; break;
      case "image": t += 1_600; break;
      case "document": t += Math.ceil((p.data?.length ?? 0) / 40) + 500; break;
      default: break;
    }
  }
  if (m.raw && Array.isArray(m.raw.content) && m.role === "assistant") {
    let rawChars = 0;
    try { rawChars = JSON.stringify(m.raw.content).length; } catch { rawChars = 0; }
    t = Math.max(t, Math.ceil(rawChars / 3.5));
  }
  return t;
}

/** Tokens of the fixed part of a request: instructions, tool definitions, application evidence. */
export function estimateFixedTokens(req: Pick<InferenceRequest, "instructions" | "tools" | "evidence">): number {
  let t = estimateTokens(req.instructions ?? "");
  if (req.tools?.length) { try { t += estimateTokens(JSON.stringify(req.tools)); } catch { /* ignore */ } }
  for (const e of req.evidence ?? []) t += estimateTokens(e.title) + estimateTokens(e.source) + e.content.reduce((a, c) => a + estimateTokens(c), 0) + 8;
  return t;
}

export interface GuardResult {
  /** Tool results replaced by an elision note in this pass. */
  elided: number;
  /** Characters removed. */
  chars: number;
  /** Estimated input tokens after the pass. */
  tokens: number;
}

/**
 * Elide the OLDEST tool-result contents until the estimated input fits `maxTokens` (`aggressive`: 60% of the smaller of
 * it and the current estimate). The
 * latest tool turn is never touched (the model is acting on it), nor are user turns or application evidence. Each
 * elided result becomes `[elided N chars — re-read with <tool>]` so the model can fetch it again. Mutates `history`.
 */
export function guardHistory(history: InferenceMessage[], opts: { maxTokens: number; fixedTokens?: number; aggressive?: boolean; minChars?: number }): GuardResult {
  const sizes = history.map(estimateMessageTokens);
  let tokens = (opts.fixedTokens ?? 0) + sizes.reduce((a, b) => a + b, 0);
  // Aggressive (the provider rejected the request as too long, so the estimate was low): shrink to 60% of the smaller
  // of the budget and the current estimate, which elides every older tool result that is large enough to matter.
  const target = Math.max(1, Math.floor(opts.aggressive ? Math.min(opts.maxTokens, tokens) * 0.6 : opts.maxTokens));
  if (tokens <= target) return { elided: 0, chars: 0, tokens };
  let lastTool = -1;
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "tool") { lastTool = i; break; }
  const toolName = (callId: string): string => {
    for (const m of history) for (const p of m.content) if (p.type === "tool_call" && p.id === callId) return p.name;
    return "the tool that produced it";
  };
  let elided = 0, chars = 0;
  const minChars = opts.minChars ?? 1_200;
  for (let i = 0; i < history.length && tokens > target; i++) {
    const m = history[i];
    if (m.role !== "tool" || i === lastTool) continue;
    let changed = false;
    const content = m.content.map((p) => {
      if (tokens <= target || p.type !== "tool_result" || p.content.length < minChars || p.content.startsWith(ELIDED_PREFIX)) return p;
      const note = `${ELIDED_PREFIX}${p.content.length} chars — re-read with ${toolName(p.callId)}]`;
      tokens -= Math.max(0, estimateTokens(p.content) - estimateTokens(note));
      chars += p.content.length;
      elided++;
      changed = true;
      return { ...p, content: note };
    });
    // The provider-native copy (OpenAI function_call_output items) would replay the full text: render the typed content.
    if (changed) history[i] = { role: m.role, content };
  }
  return { elided, chars, tokens };
}

/** Input-token limit for the context guard: the budget's, else what the model accepts minus the output reservation. */
export function contextLimit(descriptor: Pick<ModelDescriptor, "contextWindow" | "maxOutput" | "maxInput"> | undefined, budget: ResolvedBudget | null, maxOutputTokens: number | undefined): number {
  if (budget) return budget.inputTokens;
  const window = descriptor?.contextWindow ?? 128_000;
  const maxInput = descriptor?.maxInput ?? window - (descriptor?.maxOutput ?? 16_000);
  return Math.max(8_000, Math.min(maxInput, window - (maxOutputTokens ?? 16_000)) - 8_000);
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * Streaming agent loop. Emits fine-grained events for text, tool calls and tool results, executes tools server-side
 * (in parallel per step) and continues until the model stops calling tools or maxSteps is reached. The conversation
 * is kept locally (assistant turns are replayed verbatim), so every provider works; OpenAI additionally continues
 * through previous_response_id.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const cfg = aiConfig();
  const emit = opts.onEvent;
  const toolMap = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const traceId = opts.traceId ?? `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const state: Record<string, unknown> = opts.state ?? {};
  state.traceId ??= traceId;
  if (opts.runId) state.runId ??= opts.runId;
  if (opts.matterId) state.matterId ??= opts.matterId;
  const ctx: ToolContext = { emit: (e) => emit(e), signal: opts.signal, state, ...({ traceId, runId: opts.runId } as Record<string, unknown>) } as ToolContext;

  const { messages: history, extraInstructions } = toInferenceMessages(opts.input);
  const target = resolveTarget(opts.model, opts.fast, cfg);
  const base: InferenceRequest = {
    instructions: [opts.instructions, ...extraInstructions].filter(Boolean).join("\n\n"),
    messages: history,
    tools: (opts.tools ?? []).map(toToolSpec),
    builtins: builtinsFromOpenAITools(opts.builtinTools),
    jsonSchema: opts.jsonSchema,
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    reasoningEffort: opts.reasoningEffort ?? cfg.reasoningEffort,
    reasoningSummary: true,
    verbosity: opts.verbosity,
    parallelToolCalls: opts.parallelToolCalls ?? true,
    store: true,
    metadata: opts.metadata,
    signal: opts.signal,
    taskType: opts.taskType ?? "chat",
    role: target.role,
    model: target.explicitModel,
    privacy: opts.privacy ?? "internal",
    matterId: opts.matterId,
    evidence: opts.evidence,
    cacheStablePrefix: opts.cacheStablePrefix ?? true,
    traceId,
  };

  let decision: RoutingDecision;
  try { decision = routeRequest(base); } catch (e) { throw mapConfigError(e); }
  const decisionModel = decision.model;
  // Budget: resolved against the model the router chose; it fills only what the caller left open.
  const budget = opts.budget ? resolveContextBudget(opts.budget, decision.descriptor) : null;
  if (budget && base.maxOutputTokens == null) base.maxOutputTokens = budget.maxOutputTokens;
  const maxSteps = opts.maxSteps ?? budget?.maxSteps ?? 12;
  const inputLimit = contextLimit(decision.descriptor, budget, base.maxOutputTokens);
  const fixedTokens = estimateFixedTokens(base);
  let historyEdited = false;
  /** This request must replay the whole local history on top of the base conversation (see the guard below). */
  let replayHistory = false;
  let contextRetried = false;
  let elidedTotal = 0;
  emit({ type: "start", model: decisionModel });

  // The caller's stored conversation (OpenAI): the local history holds only what came after it. `previousResponseId`
  // moves on to this run's responses; when it does, the server holds the local history up to the last assistant turn.
  const basePreviousId: string | null = opts.previousResponseId ?? null;
  let previousResponseId: string | null = basePreviousId;
  let containerId: string | undefined;
  let responseId: string | null = null;
  let fullText = "";
  let lastStepText = "";
  let lastResult: InferenceResult | null = null;
  const usage: RunAgentResult["usage"] = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
  const toolCalls: RunAgentResult["toolCalls"] = [];

  const forward = (e: InferenceEvent) => {
    switch (e.type) {
      case "text.delta": emit({ type: "text.delta", delta: e.delta }); break;
      case "reasoning.delta": emit({ type: "reasoning.delta", delta: e.delta }); break;
      case "web_search": emit({ type: "web_search", status: e.status, query: e.query }); break;
      case "citation": emit(citationEvent(e)); break;
      default: break; // tool.call is emitted with its label below; start/usage/done are folded into the loop.
    }
  };
  const onFallback: NonNullable<Parameters<typeof infer>[2]>["onFallback"] = ({ from, to, error }) => emit({ type: "status", message: `${from.provider} unavailable (${error.code}); retrying on ${to.provider}` });

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    emit({ type: "step", step });

    // Context guard: elide the oldest tool results (never the latest tool turn or the evidence) before the request
    // would exceed the input budget.
    const guard = guardHistory(history, { maxTokens: inputLimit, fixedTokens });
    if (guard.elided) {
      historyEdited = true;
      elidedTotal += guard.elided;
      // A server-side continuation (OpenAI previous_response_id) still holds the unelided items: the elisions only take
      // effect when the edited local history is replayed. Continue from the caller's base conversation instead.
      if (previousResponseId !== basePreviousId) { previousResponseId = basePreviousId; replayHistory = true; }
      emit({ type: "status", message: `Context budget: elided ${guard.elided} earlier tool result${guard.elided === 1 ? "" : "s"} (${guard.chars.toLocaleString("en-US")} chars); the agent can re-read them.` });
    }

    let res: InferenceResult;
    try {
      // A copy per round: the provider (and any SDK retry) must never see later mutations of the live history.
      res = await infer({ ...base, messages: history.slice(), previousResponseId, containerId, historyEdited: historyEdited || undefined, replayHistory: (replayHistory && previousResponseId != null) || undefined }, forward, { onFallback });
    } catch (e) {
      // One retry after aggressive elision when the provider says the context window was exceeded.
      if (e instanceof InferenceError && e.code === "context_length" && !contextRetried) {
        contextRetried = true;
        const again = guardHistory(history, { maxTokens: inputLimit, fixedTokens, aggressive: true, minChars: 400 });
        const chained = previousResponseId !== basePreviousId || replayHistory;
        if (again.elided || chained) {
          if (again.elided) { historyEdited = true; elidedTotal += again.elided; }
          // A server-side continuation cannot be shortened locally: replay the (elided) local history on top of the
          // caller's base conversation (never dropped silently; if that alone is too long the retry fails, typed).
          previousResponseId = basePreviousId;
          replayHistory = true;
          emit({ type: "status", message: `Context window exceeded; elided ${again.elided} earlier tool result${again.elided === 1 ? "" : "s"} and retrying once.` });
          step--;
          continue;
        }
      }
      throw mapConfigError(e);
    }
    replayHistory = false;
    lastResult = res;
    if (res.text) { fullText += (fullText ? "\n" : "") + res.text; lastStepText = res.text; emit({ type: "text.done", text: res.text }); }
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    usage.total += res.usage.total;
    usage.cacheRead = (usage.cacheRead ?? 0) + (res.usage.cacheRead ?? 0);
    usage.cacheWrite = (usage.cacheWrite ?? 0) + (res.usage.cacheWrite ?? 0);
    responseId = res.responseId;
    previousResponseId = res.responseId;
    if (res.containerId) containerId = res.containerId;
    if (res.assistantTurn && (res.assistantTurn.content.length || res.assistantTurn.raw)) history.push(res.assistantTurn);

    if (res.stopReason === "unknown") throw new InferenceError("incomplete", `${res.provider} stopped with an unrecognised stop reason "${res.rawStopReason ?? ""}"; the output is not complete.`, { provider: res.provider, retryable: false });
    if (res.stopReason === "refusal") { emit({ type: "status", message: `Model refused${res.rawStopReason ? `: ${res.rawStopReason}` : ""}` }); break; }
    if (res.stopReason === "max_tokens") emit({ type: "status", message: "Response incomplete: max_output_tokens" });
    if (res.stopReason === "pause_turn") continue; // server-side tool loop paused: resend the turn as-is

    const calls = res.toolCalls;
    if (!calls.length) break;

    // Execute tools (in parallel), stream results, then continue the loop with every result in ONE tool turn, in call order.
    const results: ContentPart[] = await Promise.all(
      calls.map(async (call): Promise<ContentPart> => {
        const def = toolMap.get(call.name);
        const args = normalizeArgs(call.args ?? {});
        const id = call.id;
        const label = def ? toolLabel(def, args) : call.name;
        emit({ type: "tool.call", id, name: call.name, label, args, caller: call.caller });
        const started = Date.now();
        if (!def) {
          const error = `Unknown tool: ${call.name}`;
          emit({ type: "tool.result", id, name: call.name, ok: false, error, durationMs: 0 });
          toolCalls.push({ name: call.name, args, error });
          return { type: "tool_result", callId: id, content: JSON.stringify({ error }), isError: true };
        }
        const outcome = await executeTool(def, args, ctx);
        const durationMs = Date.now() - started;
        if (!outcome.ok) {
          const error = outcome.error ?? "tool failed";
          emit({ type: "tool.result", id, name: call.name, ok: false, error, durationMs });
          toolCalls.push({ name: call.name, args, error });
          return { type: "tool_result", callId: id, content: outcome.output, isError: true };
        }
        emit({ type: "tool.result", id, name: call.name, ok: true, result: summarizeForClient(outcome.value), durationMs });
        toolCalls.push({ name: call.name, args, result: outcome.value });
        return { type: "tool_result", callId: id, content: outcome.output };
      }),
    );
    history.push({ role: "tool", content: results });
  }

  let json: unknown;
  if (opts.jsonSchema) json = lastResult?.json ?? tryParse(fullText) ?? tryParse(lastStepText);
  emit({ type: "done", responseId, usage, text: fullText });
  return { text: fullText, responseId, steps: toolCalls.length, toolCalls, usage, json, ...(budget ? { budget } : {}), elided: elidedTotal };
}

// ---------------------------------------------------------------------------
// Non-streaming helpers for background work (classification, summaries, extraction).
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  instructions?: string;
  input: string | ResponseInput;
  model?: string;
  fast?: boolean;
  reasoningEffort?: RunAgentOptions["reasoningEffort"];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Built-in tools in OpenAI Tool shape (web_search…); translated per provider. */
  tools?: Tool[];
  // ---- additive ----
  taskType?: TaskType;
  privacy?: PrivacyBoundary;
  matterId?: string;
  evidence?: SearchResultBlock[];
  cacheStablePrefix?: boolean;
  traceId?: string;
  metadata?: Record<string, string>;
  /** Context-budget profile: supplies the default `maxOutputTokens` for the model the router picks. */
  budget?: BudgetProfileId;
}

/** Usage in the OpenAI Responses shape callers already read (`input_tokens` …), whichever provider answered. */
export interface GenerateUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
}

function toGenerateUsage(u: InferenceResult["usage"]): GenerateUsage {
  return { input_tokens: u.input, output_tokens: u.output, total_tokens: u.total, input_tokens_details: { cached_tokens: u.cacheRead ?? 0, cache_write_tokens: u.cacheWrite ?? 0 }, output_tokens_details: { reasoning_tokens: 0 } };
}

function buildGenerateRequest(opts: GenerateOptions, cfg: AIConfig, jsonSchema?: InferenceRequest["jsonSchema"]): InferenceRequest {
  const { messages, extraInstructions } = toInferenceMessages(opts.input);
  const target = resolveTarget(opts.model, opts.fast, cfg);
  const hasImage = messages.some((m) => m.content.some((p) => p.type === "image"));
  return {
    instructions: [opts.instructions, ...extraInstructions].filter(Boolean).join("\n\n") || undefined,
    messages,
    builtins: builtinsFromOpenAITools(opts.tools),
    jsonSchema,
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    reasoningEffort: opts.reasoningEffort ?? (opts.fast ? "low" : cfg.reasoningEffort),
    store: false,
    signal: opts.signal,
    metadata: opts.metadata,
    taskType: opts.taskType ?? (hasImage ? "vision" : jsonSchema ? "extract" : opts.fast ? "summarize" : "synthesize"),
    role: target.role,
    model: target.explicitModel,
    privacy: opts.privacy ?? "internal",
    matterId: opts.matterId,
    evidence: opts.evidence,
    cacheStablePrefix: opts.cacheStablePrefix ?? false,
    traceId: opts.traceId,
  };
}

function assertComplete(res: InferenceResult, what: string) {
  if (res.stopReason === "max_tokens") throw new Error(`${what} was cut off (output token limit reached; the model's reasoning consumed the budget). Try a narrower scope or raise OPENAI_REASONING_EFFORT down / max tokens up.`);
  if (res.stopReason === "refusal") throw new Error(`Model refused${res.rawStopReason ? `: ${res.rawStopReason}` : ""}`);
  if (res.stopReason === "unknown") throw new Error(`${what} stopped with an unrecognised stop reason (${res.rawStopReason ?? "unknown"}).`);
}

/** Fill `maxOutputTokens` from the budget profile, resolved against the model the router picks for this request. */
function applyGenerateBudget(req: InferenceRequest, budget: BudgetProfileId | undefined): InferenceRequest {
  if (!budget || req.maxOutputTokens != null) return req;
  let descriptor: ModelDescriptor | undefined;
  try { descriptor = routeRequest(req).descriptor; } catch (e) { throw mapConfigError(e); }
  return { ...req, maxOutputTokens: resolveContextBudget(budget, descriptor).maxOutputTokens };
}

async function runInference(req: InferenceRequest): Promise<InferenceResult> {
  try { return await infer(req); } catch (e) {
    if (e instanceof InferenceError && e.code === "context_length") throw new InferenceError("context_length", `${e.message} — the input is larger than the model accepts; narrow the material or split it.`, { provider: e.provider, status: e.status, retryable: false });
    throw mapConfigError(e);
  }
}

export async function generateText(opts: GenerateOptions): Promise<{ text: string; responseId: string; usage?: GenerateUsage; stopReason?: InferenceResult["stopReason"] }> {
  const cfg = aiConfig();
  const res = await runInference(applyGenerateBudget(buildGenerateRequest(opts, cfg), opts.budget));
  if (!res.text?.trim()) assertComplete(res, "Generation");
  // `stopReason` (additive): a non-empty text can still be incomplete ("max_tokens"); callers that need complete output
  // (verbatim OCR) check it.
  return { text: res.text, responseId: res.responseId ?? res.messageId ?? "", usage: toGenerateUsage(res.usage), stopReason: res.stopReason };
}

export async function generateJSON<T = unknown>(opts: GenerateOptions & { schema: Record<string, unknown>; name?: string }): Promise<T> {
  const cfg = aiConfig();
  const res = await runInference(applyGenerateBudget(buildGenerateRequest(opts, cfg, { name: opts.name ?? "result", schema: strictJsonSchema(opts.schema) }), opts.budget));
  assertComplete(res, "Structured generation");
  if (res.json !== undefined && res.json !== null && typeof res.json === "object") return res.json as T;
  const text = res.text?.trim();
  if (!text) throw new Error("Model returned no structured output");
  try {
    return parseModelJSON<T>(text);
  } catch (e) {
    throw new Error(`Model returned malformed JSON (${(e as Error).message}); output began: ${text.slice(0, 200)}`);
  }
}

/** Same rules as function-tool strict mode. */
export function strictJsonSchema(schema: Record<string, unknown>) {
  return toStrictSchema(schema);
}

/** Vision helper: describe / transcribe an image (data URL or https URL). Routed to a vision-capable fast model. */
export async function describeImage(imageUrl: string, prompt = "Transcribe all text and describe the content of this image precisely.", opts: { fast?: boolean } = {}) {
  return generateText({
    fast: opts.fast ?? true,
    taskType: "vision",
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: imageUrl, detail: "high" }] }],
  });
}
