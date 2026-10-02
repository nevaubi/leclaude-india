/**
 * Provider-neutral model runtime contracts (constitution §15, §53.5).
 *
 * Every model call in LeClaude goes through a ModelProvider chosen by the ModelRouter.
 * Providers translate one InferenceRequest into their wire format (OpenAI Responses API,
 * Anthropic Messages API, Amazon Bedrock InvokeModelWithResponseStream, OpenRouter chat
 * completions) and stream back the same InferenceEvent vocabulary. Nothing outside
 * src/lib/ai/providers may reference a provider SDK or a raw model id.
 *
 * Client-safe: types and constants only.
 */
import type { JSONSchema } from "../tools";

export type ProviderId = "openai" | "anthropic" | "bedrock" | "openrouter";

/** What a model is used for. The router maps roles to configured models. */
export type ModelRole = "primary" | "fast" | "router" | "embedding" | "image" | "vision";

/** Coarse task types drive routing (constitution §15, §16, §17). */
export type TaskType =
  | "route"
  | "classify"
  | "extract"
  | "summarize"
  | "synthesize"
  | "draft"
  | "review"
  | "verify"
  | "research"
  | "code"
  | "embed"
  | "image"
  | "vision"
  | "chat";

/** Data-eligibility boundary: matter data may only travel to "internal" providers unless policy allows. */
export type PrivacyBoundary = "internal" | "external";

/** Coded provider capability matrix (constitution §53.5). Routing consults this; nobody "remembers" it. */
export interface CapabilityProfile {
  messages: boolean;
  streaming: boolean;
  thinking: boolean;
  promptCaching: boolean;
  /** Model-native citations over supplied evidence blocks. */
  citations: boolean;
  /** `search_result` content blocks (citation-native internal RAG). */
  searchResultBlocks: boolean;
  filesApi: boolean;
  serverWebSearch: boolean;
  serverWebFetch: boolean;
  codeExecution: boolean;
  browserToolset: boolean;
  computerUse: boolean;
  memoryTool: boolean;
  textEditorTool: boolean;
  bashTool: boolean;
  mcpConnector: boolean;
  programmaticToolCalling: boolean;
  agentSkills: boolean;
  embeddings: boolean;
  imageGeneration: boolean;
  vision: boolean;
  /** Schema-constrained JSON output (native or via a forced tool call). */
  structuredOutput: boolean;
  strictTools: boolean;
  toolUseExamples: boolean;
  deferredTools: boolean;
  /** Server-side conversation continuation (OpenAI previous_response_id). */
  previousResponseId: boolean;
}

export interface ModelDescriptor {
  id: string;
  provider: ProviderId;
  roles: ModelRole[];
  capabilities: CapabilityProfile;
  privacy: PrivacyBoundary;
  reasoning: boolean;
  /** Total tokens the model accepts (coded per family in providers/model-limits.ts; env overrides clamp it). */
  contextWindow?: number;
  /** Largest output the model accepts (reasoning / thinking tokens count against it). */
  maxOutput?: number;
  /** Largest input the model accepts (publisher-stated, else contextWindow − maxOutput). */
  maxInput?: number;
  /** 1 = cheapest tier, 3 = most expensive. */
  costTier: 1 | 2 | 3;
}

// ---------------- Request ----------------

export interface SearchResultBlock {
  type: "search_result";
  /** Stable, server-resolvable identifier (matter://…, depo://…, authority://…) or canonical URL. */
  source: string;
  title: string;
  /** Focused text blocks; citation boundaries are per block. */
  content: string[];
  citationsEnabled?: boolean;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; data?: string; mime?: string; detail?: "low" | "high" | "auto" }
  | { type: "document"; data: string; mime: string; title?: string }
  | SearchResultBlock
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean };

export interface InferenceMessage {
  role: "user" | "assistant" | "tool";
  content: ContentPart[];
  /**
   * Provider-native content for byte-faithful replay on the SAME provider (OpenAI Responses items, Anthropic content
   * blocks including thinking blocks with their signatures). A provider that does not match `raw.provider` renders
   * the typed `content` instead and drops what it cannot express.
   */
  raw?: { provider: ProviderId; content: unknown[] };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
  strict?: boolean;
  /** Concrete usage examples (Tool Use Examples); providers that support them send them. */
  examples?: Record<string, unknown>[];
  /** Loaded on demand by providers with deferred tools; always loaded elsewhere. */
  defer?: boolean;
  /**
   * Programmatic tool calling: who may invoke the tool. "code_execution" lets the model call it from inside the
   * server-side code execution container (first-party Anthropic only); other providers ignore it.
   */
  callers?: ("direct" | "code_execution")[];
}

export type BuiltinToolSpec =
  | { type: "web_search"; contextSize?: "low" | "medium" | "high"; allowedDomains?: string[] }
  | { type: "web_fetch" }
  | { type: "code_execution" }
  | { type: "image_generation"; size?: string; quality?: string };

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface InferenceRequest {
  /** Explicit model id; otherwise the router resolves one from role/taskType. */
  model?: string;
  provider?: ProviderId;
  role?: ModelRole;
  taskType?: TaskType;
  privacy?: PrivacyBoundary;
  instructions?: string;
  messages: InferenceMessage[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  builtins?: BuiltinToolSpec[];
  /** Application-owned evidence rendered as search_result blocks (or numbered sources where unsupported). */
  evidence?: SearchResultBlock[];
  jsonSchema?: { name: string; schema: JSONSchema };
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  parallelToolCalls?: boolean;
  /** Mark the instructions + tools prefix as stable so providers can cache it. */
  cacheStablePrefix?: boolean;
  previousResponseId?: string | null;
  signal?: AbortSignal;
  metadata?: Record<string, string>;
  matterId?: string;
  traceId?: string;
  /** Let the provider retain the response server-side for continuation (OpenAI `store`). Default false. */
  store?: boolean;
  /** Stream reasoning summaries / thinking text (OpenAI reasoning summaries, Anthropic `thinking.display`). */
  reasoningSummary?: boolean;
  /** Output verbosity hint (OpenAI `text.verbosity`); ignored by providers without an equivalent. */
  verbosity?: "low" | "medium" | "high";
  /** Code execution container to reuse (programmatic tool calling continuation). */
  containerId?: string;
  /**
   * Set when the runtime elided earlier tool results (context guard). Providers whose thinking blocks are bound to the
   * conversation prefix then ask the API to drop the invalidated blocks instead of rejecting the request.
   */
  historyEdited?: boolean;
  /**
   * Render every message even though `previousResponseId` is set (OpenAI): the local history was edited after the
   * server-side continuation point, so this request continues from `previousResponseId` (the caller's base
   * conversation) with the whole edited local history replayed. Ignored without `previousResponseId`.
   */
  replayHistory?: boolean;
}

// ---------------- Events and results ----------------

export type InferenceEvent =
  | { type: "start"; provider: ProviderId; model: string }
  | { type: "text.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "tool.call"; id: string; name: string; args: Record<string, unknown>; caller?: "direct" | "code_execution" }
  | { type: "citation"; source: string; title?: string; quote?: string; url?: string; blockIndex?: number }
  | { type: "web_search"; status: "searching" | "completed"; query?: string }
  | { type: "usage"; usage: InferenceUsage }
  | { type: "done"; stopReason: StopReason }
  | { type: "error"; message: string; code?: InferenceErrorCode };

/**
 * "pause_turn": a server-side tool loop paused and the assistant turn must be sent back as-is to continue.
 * "unknown": the provider reported a stop reason this runtime does not recognise; terminal, never success.
 */
export type StopReason = "end" | "tool_calls" | "max_tokens" | "refusal" | "error" | "cancelled" | "pause_turn" | "unknown";

export type InferenceErrorCode =
  | "not_configured"
  | "capability_unavailable"
  | "privacy_boundary"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "cancelled"
  | "auth"
  | "malformed_output"
  | "incomplete"
  | "refusal"
  /** The request exceeded the model's context window (retryable only after the history is shortened). */
  | "context_length"
  | "unknown";

/**
 * `input` is the whole context the request paid for (uncached + cache reads + cache writes); `cacheRead`/`cacheWrite`
 * are the subsets served from / written to the prompt cache. Never add them to `input` again.
 */
export interface InferenceUsage {
  input: number;
  output: number;
  total: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface InferenceCitation {
  source: string;
  title?: string;
  quote?: string;
  url?: string;
  blockIndex?: number;
}

export interface InferenceResult {
  provider: ProviderId;
  model: string;
  text: string;
  json?: unknown;
  toolCalls: { id: string; name: string; args: Record<string, unknown>; caller?: "direct" | "code_execution" }[];
  citations: InferenceCitation[];
  usage: InferenceUsage;
  stopReason: StopReason;
  /** Server-side continuation id (OpenAI response id); null for providers without server-side conversation state. */
  responseId: string | null;
  latencyMs: number;
  /** Provider-native assistant turn to append when continuing a conversation without server state. */
  assistantTurn?: InferenceMessage;
  /** Provider message id (informational; Anthropic `msg_…`, OpenAI `resp_…`). */
  messageId?: string;
  /** Code execution container id to pass back on the next turn (programmatic tool calling). */
  containerId?: string;
  /** Raw provider stop reason when `stopReason` is "unknown". */
  rawStopReason?: string;
}

export class InferenceError extends Error {
  status: number;
  code: InferenceErrorCode;
  provider?: ProviderId;
  retryable: boolean;
  constructor(code: InferenceErrorCode, message: string, opts: { status?: number; provider?: ProviderId; retryable?: boolean } = {}) {
    super(message);
    this.name = "InferenceError";
    this.code = code;
    this.status = opts.status ?? (code === "not_configured" || code === "capability_unavailable" ? 503 : code === "rate_limited" ? 429 : code === "auth" ? 401 : 502);
    this.provider = opts.provider;
    this.retryable = opts.retryable ?? (code === "rate_limited" || code === "provider_unavailable" || code === "timeout");
  }
}

// ---------------- Provider and router ----------------

export interface EmbedOptions {
  model?: string;
  signal?: AbortSignal;
  dimensions?: number;
  /** Cohere-style asymmetric embeddings: index-time "document" vs search-time "query". Providers without the notion ignore it. */
  inputType?: "document" | "query";
}

export interface ImageOptions { size?: string; quality?: string; signal?: AbortSignal }

export interface ModelProvider {
  id: ProviderId;
  /** Models this provider is configured to serve (from configuration, never guessed). */
  models(): ModelDescriptor[];
  isConfigured(): boolean;
  infer(req: InferenceRequest, onEvent?: (e: InferenceEvent) => void): Promise<InferenceResult>;
  embed?(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
  generateImage?(prompt: string, opts?: ImageOptions): Promise<{ bytes: Uint8Array; mime: string; model: string }>;
}

export interface RouterInput {
  taskType: TaskType;
  role?: ModelRole;
  privacy: PrivacyBoundary;
  needs?: Partial<CapabilityProfile>;
  explicitModel?: string;
  explicitProvider?: ProviderId;
  latency?: "interactive" | "background";
  risk?: "low" | "high";
  contextTokens?: number;
}

export interface RoutingDecision {
  provider: ProviderId;
  model: string;
  descriptor: ModelDescriptor;
  reason: string;
  fallbacks: { provider: ProviderId; model: string }[];
}

/** Terminal states for orchestrated runs (constitution §14). Never reduce these to "done". */
export type RunTerminalState = "succeeded" | "partial" | "budget_exhausted" | "verification_failed" | "cancelled" | "failed";
