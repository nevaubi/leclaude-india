import "server-only";
/**
 * Model runtime entry point (constitution §14–§17, §47): route a provider-neutral InferenceRequest over the
 * configured providers, call the chosen provider, fall back to the next eligible model only on retryable failures
 * that happened before any output was streamed, and record telemetry for every attempt.
 *
 * Derived needs keep capability failures at routing time rather than at the wire: a request with server web search
 * never reaches Bedrock; a structured-output request never reaches a provider without it; evidence prefers
 * `search_result` blocks but degrades to numbered text on providers without them.
 */
import { randomUUID } from "node:crypto";
import { satisfies } from "./capabilities";
import { renderEvidenceAsText } from "./providers/anthropic-wire";
import { isAbortError } from "./providers/http";
import { getRegistry } from "./providers/registry";
import { InferenceError, type CapabilityProfile, type ContentPart, type InferenceEvent, type InferenceRequest, type InferenceResult, type ModelDescriptor, type ProviderId, type RoutingDecision } from "./providers/types";
import { routeModel } from "./router";
import { recordTrace } from "./telemetry";

export { InferenceError };

/** Capabilities a request requires, derived from its shape. */
export function deriveNeeds(req: InferenceRequest): Partial<CapabilityProfile> {
  const needs: Partial<CapabilityProfile> = {};
  if (req.jsonSchema) needs.structuredOutput = true;
  for (const b of req.builtins ?? []) {
    if (b.type === "web_search") needs.serverWebSearch = true;
    if (b.type === "web_fetch") needs.serverWebFetch = true;
    if (b.type === "code_execution") needs.codeExecution = true;
    if (b.type === "image_generation") needs.imageGeneration = true;
  }
  if (req.messages.some((m) => m.content.some((p) => p.type === "image"))) needs.vision = true;
  return needs;
}

function routerOptions() {
  const reg = getRegistry();
  return { available: reg.models, preferred: reg.preferred, allowExternalForMatterData: reg.allowExternalForMatterData };
}

/** Route a request. Evidence prefers citation-native `search_result` blocks but does not require them. */
export function routeRequest(req: InferenceRequest): RoutingDecision {
  const base = { taskType: req.taskType ?? "chat", role: req.role, privacy: req.privacy ?? "internal", explicitModel: req.model, explicitProvider: req.provider } as const;
  const needs = deriveNeeds(req);
  const opts = routerOptions();
  // The operator's provider choice (MODEL_PROVIDER) wins over the citation-native preference: when the preferred
  // provider can serve the request but has no search_result blocks, the evidence goes to it as numbered text.
  let preferredWithoutBlocks = false;
  if (req.evidence?.length && opts.preferred) {
    try {
      const plain = routeModel({ ...base, needs }, opts);
      preferredWithoutBlocks = plain.provider === opts.preferred && !plain.descriptor.capabilities.searchResultBlocks;
    } catch { preferredWithoutBlocks = false; }
  }
  if (req.evidence?.length && !preferredWithoutBlocks) {
    try {
      return routeModel({ ...base, needs: { ...needs, searchResultBlocks: true, citations: true } }, opts);
    } catch (e) {
      if (!(e instanceof InferenceError) || e.code !== "capability_unavailable") throw e;
    }
  }
  try {
    return routeModel({ ...base, needs }, opts);
  } catch (e) {
    if (e instanceof InferenceError && e.code === "capability_unavailable" && (needs.serverWebSearch || needs.serverWebFetch || needs.codeExecution)) {
      throw new InferenceError("capability_unavailable", `${e.message} Server web search/fetch and code execution are not available on Amazon Bedrock; configure Anthropic or OpenAI for this request, or run it without those built-in tools.`, { provider: e.provider });
    }
    throw e;
  }
}

/** Adapt a request to the chosen model: drop what the provider cannot express instead of failing at the wire. */
export function prepareForProvider(req: InferenceRequest, descriptor: ModelDescriptor): InferenceRequest {
  const caps = descriptor.capabilities;
  const out: InferenceRequest = { ...req, model: descriptor.id, provider: descriptor.provider };
  if (!caps.previousResponseId) out.previousResponseId = null;
  if (!caps.programmaticToolCalling && out.tools?.some((t) => t.callers)) out.tools = out.tools.map((t) => ({ ...t, callers: undefined }));
  if (out.evidence?.length && !caps.searchResultBlocks) {
    const block: ContentPart = { type: "text", text: `SOURCES (cite by number):\n${renderEvidenceAsText(out.evidence)}` };
    const messages = out.messages.map((m) => ({ ...m }));
    let attached = false;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { messages[i] = { ...messages[i], content: [block, ...messages[i].content], raw: undefined }; attached = true; break; }
    if (!attached) messages.push({ role: "user", content: [block] });
    out.messages = messages;
    out.evidence = undefined;
  }
  return out;
}

export interface InferOptions {
  /** Called when a retryable failure moves the request to the next eligible model. */
  onFallback?: (info: { from: { provider: ProviderId; model: string }; to: { provider: ProviderId; model: string }; error: InferenceError }) => void;
  /** How many fallback models to try after the first (default 2). */
  maxFallbacks?: number;
}

const OUTPUT_EVENTS = new Set<InferenceEvent["type"]>(["text.delta", "reasoning.delta", "tool.call", "citation"]);

/**
 * Run one inference. Fallback happens only on retryable InferenceErrors (rate limit, provider outage, timeout) and
 * only while nothing has been streamed to the consumer; capability, privacy, auth and malformed-output errors fail
 * closed immediately. Every attempt is traced.
 */
export async function infer(req: InferenceRequest, onEvent?: (e: InferenceEvent) => void, options: InferOptions = {}): Promise<InferenceResult> {
  const reg = getRegistry();
  const decision = routeRequest(req);
  const needs = deriveNeeds(req);
  const traceId = req.traceId ?? randomUUID();
  const targets = [{ provider: decision.provider, model: decision.model }, ...decision.fallbacks.slice(0, options.maxFallbacks ?? 2)];
  let emitted = false;
  const guarded = (e: InferenceEvent) => { if (OUTPUT_EVENTS.has(e.type)) emitted = true; onEvent?.(e); };
  let fallbackFrom: { provider: ProviderId; model: string } | undefined;
  let lastError: InferenceError | null = null;

  for (const target of targets) {
    const provider = reg.providers.get(target.provider);
    const descriptor = reg.models.find((m) => m.provider === target.provider && m.id === target.model);
    if (!provider || !descriptor || !satisfies(descriptor.capabilities, needs)) continue;
    const prepared = prepareForProvider({ ...req, traceId }, descriptor);
    const started = Date.now();
    const common = { traceId, provider: target.provider, model: target.model, taskType: req.taskType, role: req.role, surface: req.metadata?.surface, matterId: req.matterId, fallbackFrom };
    try {
      const res = await provider.infer(prepared, guarded);
      recordTrace({ ...common, model: res.model || target.model, latencyMs: res.latencyMs || Date.now() - started, usage: res.usage, cacheRead: res.usage.cacheRead, cacheWrite: res.usage.cacheWrite, stopReason: res.stopReason });
      return res;
    } catch (e) {
      if (isAbortError(e)) {
        recordTrace({ ...common, latencyMs: Date.now() - started, error: { code: "cancelled", message: "cancelled by caller" } });
        throw e;
      }
      const ie = e instanceof InferenceError ? e : new InferenceError("unknown", e instanceof Error ? e.message : String(e), { provider: target.provider, retryable: false });
      recordTrace({ ...common, latencyMs: Date.now() - started, error: { code: ie.code, message: ie.message } });
      lastError = ie;
      if (!ie.retryable || emitted) throw ie;
      const next = targets[targets.indexOf(target) + 1];
      if (next) options.onFallback?.({ from: target, to: next, error: ie });
      fallbackFrom = target;
    }
  }
  throw lastError ?? new InferenceError("not_configured", "No provider could serve the request.");
}
