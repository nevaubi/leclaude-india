/**
 * Typed run-event vocabulary for orchestrated runs (constitution §14, §36, §46, §47).
 *
 * Client-safe: types, constants and small pure helpers only. Every orchestrated run
 * (research today; workflows and analysis runs as they adopt it) streams these events so
 * the frontend never parses status out of prose, and every run ends in one explicit
 * terminal state — never a generic "done".
 *
 * The §46 vocabulary is the core set. A few `started/completed` pairs that §46 leaves
 * implicit are added so a consumer can close every phase it opened:
 * `lane.completed`, `verification.completed`, `verification.unavailable`,
 * `correction.completed`, `citation.checked`.
 */
import type { RunTerminalState } from "@/lib/ai/providers/types";

export type { RunTerminalState };

/** Why a research loop stopped gathering evidence (constitution §25). Distinct from the terminal state. */
export type ResearchStopState = "coverage_sufficient" | "budget_exhausted" | "verification_unavailable" | "source_unavailable" | "hard_limit" | "cancelled";

export const RUN_TERMINAL_STATES: readonly RunTerminalState[] = ["succeeded", "partial", "budget_exhausted", "verification_failed", "cancelled", "failed"];
export const RESEARCH_STOP_STATES: readonly ResearchStopState[] = ["coverage_sufficient", "budget_exhausted", "verification_unavailable", "source_unavailable", "hard_limit", "cancelled"];

/** Failure model (constitution §47). Only the transient kinds are ever retried. */
export type FailureKind =
  | "no_result"
  | "provider_outage"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "auth_failure"
  | "not_configured"
  | "malformed_output"
  | "incomplete_result"
  | "tool_failure"
  | "verification_failure"
  | "budget_exhausted"
  | "unknown";

export const TRANSIENT_FAILURES: ReadonlySet<FailureKind> = new Set<FailureKind>(["provider_outage", "rate_limit", "timeout"]);

export function isTransientFailure(kind: FailureKind): boolean {
  return TRANSIENT_FAILURES.has(kind);
}

export function isAbortError(e: unknown): boolean {
  return Boolean(e) && typeof e === "object" && (e as { name?: string }).name === "AbortError";
}

/** Map an error to the failure model. Deterministic, message-based; never guesses "success". */
export function classifyFailure(e: unknown): FailureKind {
  if (isAbortError(e)) return "cancelled";
  const err = (e ?? {}) as { name?: string; message?: string; status?: number; code?: string };
  const msg = `${err.message ?? (typeof e === "string" ? e : "")}`;
  if (err.name === "AIConfigError" || err.code === "no_api_key" || err.code === "not_configured") return "not_configured";
  if (err.status === 404 || err.status === 410 || err.code === "no_result") return "no_result";
  if (err.status === 429 || err.code === "rate_limit" || /\b429\b|rate limit/i.test(msg)) return "rate_limit";
  if (err.code === "timeout" || /\btimeout\b|timed out|ETIMEDOUT/i.test(msg)) return "timeout";
  if (err.status === 401 || err.status === 403 || err.status === 407 || /\b(401|403|407)\b|unauthorized|forbidden|invalid api key|authentication/i.test(msg)) return "auth_failure";
  if ((err.status != null && err.status >= 500) || /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|network|unreachable|overloaded|unavailable|\b5\d\d\b/i.test(msg)) return "provider_outage";
  if (/malformed|no JSON|no structured output|invalid json/i.test(msg)) return "malformed_output";
  if (/incomplete|cut off|max_output_tokens/i.test(msg)) return "incomplete_result";
  if (err.code === "tool_failure" || /^Unknown tool|tool failed/i.test(msg)) return "tool_failure";
  return "unknown";
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

/**
 * Per-run performance metrics (constitution §36). Times are milliseconds measured from
 * `requestedAt`; `null` means the milestone was never reached in this run.
 */
export interface RunMetrics {
  requestedAt: number;
  /** request → run.started */
  acknowledgedMs: number | null;
  /** → first source found */
  firstEvidenceMs: number | null;
  /** → first full-text read */
  firstReadMs: number | null;
  /** → first answer token */
  firstModelTokenMs: number | null;
  /** → first answer text carrying a citation that maps to a numbered source */
  firstSourceBackedMs: number | null;
  /** → final answer text */
  finalAnswerMs: number | null;
  /** → verdict bound to the final answer hash */
  verifiedAnswerMs: number | null;
  totalMs: number;
  /** Cumulative provider/tool execution time (overlapping calls add up). */
  toolTimeMs: number;
  /** Cumulative model call time (overlapping calls add up). */
  modelTimeMs: number;
  toolCalls: number;
  modelCalls: number;
  /** Time lanes spent waiting for a concurrency slot (cumulative). */
  queueWaitMs: number;
  tokens: TokenUsage & { reportedCalls: number };
}

export function emptyMetrics(requestedAt: number): RunMetrics {
  return { requestedAt, acknowledgedMs: null, firstEvidenceMs: null, firstReadMs: null, firstModelTokenMs: null, firstSourceBackedMs: null, finalAnswerMs: null, verifiedAnswerMs: null, totalMs: 0, toolTimeMs: 0, modelTimeMs: 0, toolCalls: 0, modelCalls: 0, queueWaitMs: 0, tokens: { input: 0, output: 0, total: 0, reportedCalls: 0 } };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Every event carries the run id, a wall-clock stamp and a per-run monotonic sequence number. */
export interface RunEventBase {
  runId: string;
  at: number;
  seq: number;
}

export interface PlannedLaneSummary {
  id: string;
  name: string;
  kind: string;
  /** Lane ids that must settle before this lane starts. */
  dependsOn?: string[];
  timeoutMs?: number;
}

export type ArtifactStage = "draft" | "revised" | "final";

/** Terminal states that `run.partial` can carry: the run produced something, but not everything it set out to. */
export type PartialTerminalState = Extract<RunTerminalState, "partial" | "budget_exhausted" | "verification_failed">;

export type RunEventPayload =
  | { type: "run.started"; threadId?: string; question: string; mode: string; startedAt: number; requestedAt: number; threadReplaced?: boolean }
  | { type: "plan.created"; round: number; reason?: string; lanes: PlannedLaneSummary[] }
  | { type: "lane.started"; laneId: string; round: number; queuedMs: number }
  | { type: "lane.completed"; laneId: string; status: string; durationMs: number; sources: number; read: number; error?: string; failure?: FailureKind; note?: string }
  | { type: "source.found"; laneId: string; sourceId: string; title: string; cite?: string; kind: string }
  | { type: "source.read_started"; laneId: string; sourceId: string; title: string }
  | { type: "source.read"; laneId: string; sourceId: string; chars: number; cached: boolean; durationMs: number }
  | { type: "tool.started"; laneId?: string; toolId: string; name: string; label: string }
  | { type: "tool.completed"; laneId?: string; toolId: string; name: string; label: string; durationMs: number }
  | { type: "tool.failed"; laneId?: string; toolId: string; name: string; label: string; error: string; failure: FailureKind; durationMs: number; retrying: boolean }
  | { type: "synthesis.started"; round: number; sources: number; read: number }
  | { type: "answer.delta"; delta: string }
  | { type: "artifact.created"; artifactId: string; artifactHash: string; version: number; stage: ArtifactStage; kind: string }
  | { type: "verification.started"; artifactHash: string; sources: number; pass: number }
  | { type: "claim.supported"; artifactHash: string; claim: string; sourceN: number | null; quote?: string }
  | { type: "claim.unsupported"; artifactHash: string; claim: string; sourceN: number | null; note?: string }
  | { type: "claim.contradicted"; artifactHash: string; claim: string; sourceN: number | null; quote?: string; note?: string }
  | { type: "verification.completed"; artifactHash: string; status: string; supported: number; unsupported: number; contradicted: number; score: number; pass: number }
  | { type: "verification.unavailable"; artifactHash: string; reason: string; failure: FailureKind }
  | { type: "correction.started"; artifactHash: string; unsupported: number; contradicted: number }
  | { type: "correction.completed"; artifactHash: string; changed: boolean; note: string; newArtifactHash?: string }
  | { type: "citation.checked"; artifactHash: string; resolved: number; unresolved: number; requiresReview: number }
  | { type: "coverage.gap"; round: number; reason: string; gaps: string[]; refinements: Record<string, string[]> }
  | { type: "round.completed"; round: number; complete: boolean; reason: string }
  | { type: "review.required"; artifactHash: string; reason: string }
  | { type: "run.partial"; threadId?: string; terminal: PartialTerminalState; stop: ResearchStopState; reason: string; metrics: RunMetrics }
  | { type: "run.completed"; threadId?: string; terminal: "succeeded"; stop: "coverage_sufficient"; metrics: RunMetrics }
  | { type: "run.failed"; threadId?: string; terminal: "failed"; failure: FailureKind; error: string; stop?: ResearchStopState; metrics: RunMetrics }
  | { type: "run.cancelled"; threadId?: string; terminal: "cancelled"; stop: "cancelled"; partial: boolean; metrics: RunMetrics };

export type RunEvent = RunEventPayload & RunEventBase;
export type RunEventType = RunEventPayload["type"];

export const RUN_EVENT_TYPES: readonly RunEventType[] = [
  "run.started", "plan.created", "lane.started", "lane.completed",
  "source.found", "source.read_started", "source.read",
  "tool.started", "tool.completed", "tool.failed",
  "synthesis.started", "answer.delta", "artifact.created",
  "verification.started", "claim.supported", "claim.unsupported", "claim.contradicted", "verification.completed", "verification.unavailable",
  "correction.started", "correction.completed", "citation.checked",
  "coverage.gap", "round.completed", "review.required",
  "run.partial", "run.completed", "run.failed", "run.cancelled",
];

const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUN_EVENT_TYPES);

export const TERMINAL_EVENT_TYPES: readonly RunEventType[] = ["run.partial", "run.completed", "run.failed", "run.cancelled"];

export type TerminalRunEvent = Extract<RunEvent, { type: "run.partial" | "run.completed" | "run.failed" | "run.cancelled" }>;

export function isRunEventType(type: unknown): type is RunEventType {
  return typeof type === "string" && RUN_EVENT_TYPE_SET.has(type);
}

export function isRunEvent(e: unknown): e is RunEvent {
  if (!e || typeof e !== "object") return false;
  const x = e as Partial<RunEvent>;
  return isRunEventType(x.type) && typeof x.runId === "string" && typeof x.at === "number" && typeof x.seq === "number";
}

export function isTerminalEvent(e: { type: string }): e is TerminalRunEvent {
  return e.type === "run.partial" || e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled";
}

/** The terminal state a stream of events ended in, or null when no terminal event was seen. */
export function terminalStateOf(events: readonly { type: string; terminal?: RunTerminalState }[]): RunTerminalState | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (isTerminalEvent(e)) return (e as TerminalRunEvent).terminal;
  }
  return null;
}

/** The distributed omit used by emitters: engine code supplies the payload, the emitter stamps runId/at/seq. */
export type EventInput<E extends RunEventBase = RunEvent> = E extends RunEventBase ? Omit<E, keyof RunEventBase> : never;

/**
 * Create an emitter that stamps `runId`, `at` and a monotonic `seq` on every event before
 * handing it to `send`. Pure apart from the sequence counter.
 */
export function createEmitter<E extends RunEventBase>(runId: string, send: (e: E) => void, now: () => number = Date.now): { emit: (e: EventInput<E>) => E; seq: () => number } {
  let seq = 0;
  return {
    emit: (e) => {
      const stamped = { ...(e as object), runId, at: now(), seq: ++seq } as E;
      send(stamped);
      return stamped;
    },
    seq: () => seq,
  };
}

/** Human labels that never overstate what happened (constitution §34). */
export const TERMINAL_LABEL: Record<RunTerminalState, string> = {
  succeeded: "Completed",
  partial: "Partial",
  budget_exhausted: "Budget exhausted",
  verification_failed: "Verification failed",
  cancelled: "Stopped",
  failed: "Failed",
};

export const STOP_LABEL: Record<ResearchStopState, string> = {
  coverage_sufficient: "coverage sufficient",
  budget_exhausted: "round budget exhausted",
  verification_unavailable: "verification unavailable",
  source_unavailable: "sources unavailable",
  hard_limit: "hard limit reached",
  cancelled: "cancelled",
};

export const FAILURE_LABEL: Record<FailureKind, string> = {
  no_result: "no result",
  provider_outage: "provider unreachable",
  rate_limit: "rate limited",
  timeout: "timed out",
  cancelled: "cancelled",
  auth_failure: "provider refused the request",
  not_configured: "model provider not configured",
  malformed_output: "malformed model output",
  incomplete_result: "incomplete model result",
  tool_failure: "tool failed",
  verification_failure: "verification failed",
  budget_exhausted: "budget exhausted",
  unknown: "failed",
};
