import "server-only";
import os from "node:os";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { AIConfigError } from "@/lib/ai/config";
import { InferenceError } from "@/lib/ai/providers/types";
import type { Task, Workflow, WorkflowEdge, WorkflowFailureKind, WorkflowNode, WorkflowRunStep, WorkflowSkipReason, WorkflowStepTelemetry } from "@/lib/types/domain";
import { findNearDuplicateTask } from "@/lib/integrity/dedupe";
import { executionPlan, isLoopBackEdge, validateWorkflow, type ExecutionPlan } from "./graph";
import { EXECUTORS, StepError, TrustGateError, matterContext, stepProvenanceOf, type ExecContext, type ExecResult, type Executor, type RunTrustState } from "./executors";
import { AGENT_EXECUTORS } from "./executors-agents";
import { INTEL_EXECUTORS } from "./executors-intel";
import { OFFICIAL_EXECUTORS } from "./executors-official";
import { validateFrontendValues } from "./frontend";
import { audit } from "@/lib/integrity/audit";
import { resolveDateRule, resolveDeep, resolveTemplate, resolveText, type ResolveReport, type TemplateContext } from "./template-expr";
import { publishRunEvent } from "./events";
import { nodeSpec, type AnyNodeType } from "./registry";
import { validateUploadedFile } from "./output-files";
import {
  isTerminalStatus, TERMINAL_EVENT_FOR, WORKFLOW_CURRENT_USER,
  type EngineStepContext, type ExecResultTelemetry, type ExecutorEmit, type RunApproval, type RunArtifact, type RunBudget, type RunFollowUps, type RunHandoff, type RunIteration, type RunLease, type RunOutcome, type RunOutput, type RunStartRequest, type RunStopReason, type RunTerminalStatus, type RunUsage, type WorkflowRunRecord,
} from "./types";

/** Every executor the engine can run: the original catalogue plus the intelligence, steward, output, agent and official-sources steps. */
export const ALL_EXECUTORS: Record<AnyNodeType, Executor> = { ...EXECUTORS, ...(INTEL_EXECUTORS as Record<AnyNodeType, Executor>), ...(AGENT_EXECUTORS as Record<AnyNodeType, Executor>), ...(OFFICIAL_EXECUTORS as Record<AnyNodeType, Executor>) };

/**
 * Workflow engine: executes a validated DAG with dynamic scheduling (a node
 * starts as soon as every predecessor has settled, so independent branches run
 * in parallel), checkpoints the run record at every node boundary, streams
 * typed progress events, pauses on approvals, iterates loops, and applies the
 * runtime contract of the constitution: one of six terminal states (§14),
 * cancellation that reaches every executing node, per-node timeouts and
 * retries for transient failures only (§47), per-run token/cost/time budgets
 * with cost telemetry (§13, §36), and leases with recovery after a restart
 * (§39).
 */

type StopKind = "cancel" | "budget_tokens" | "budget_cost" | "budget_time" | "fail";
interface StopRequest { kind: StopKind; message: string; at: string; by?: string }

type ActiveRun = { controller: AbortController; promise: Promise<void>; stop: (req: Omit<StopRequest, "at">) => void };
type G = typeof globalThis & { __leclaudeWorkflowActive?: Map<string, ActiveRun>; __leclaudeWorkflowWorkerId?: string };

function activeRuns() {
  const g = globalThis as G;
  if (!g.__leclaudeWorkflowActive) g.__leclaudeWorkflowActive = new Map();
  return g.__leclaudeWorkflowActive;
}

/** Identity of this process for run leases (stable for the life of the process). */
export function workerId(): string {
  const g = globalThis as G;
  if (!g.__leclaudeWorkflowWorkerId) g.__leclaudeWorkflowWorkerId = `${os.hostname()}:${process.pid}:${nanoid(6)}`;
  return g.__leclaudeWorkflowWorkerId;
}

const MAX_LOOP_ITERATIONS = 50;
const STRING_CAP = 300_000;
const MAX_RETRIES = 3;

function envNum(key: string, fallback: number, min = 0): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Lease TTL; a run whose lease is older than this while its process is gone is recovered on boot. */
export function leaseTtlMs() { return envNum("WORKFLOW_LEASE_TTL_MS", 60_000, 1000); }
function heartbeatMs() { return Math.max(250, Math.floor(leaseTtlMs() / 3)); }
function retryBaseMs() { return envNum("WORKFLOW_RETRY_BASE_MS", 1000, 0); }
function retryMaxMs() { return envNum("WORKFLOW_RETRY_MAX_MS", 8000, 0); }

/** Default per-node timeouts by category, in seconds (override with WORKFLOW_TIMEOUT_<CATEGORY>_SEC or the node's `timeoutSec`). */
const DEFAULT_TIMEOUT_SEC: Record<string, number> = { trigger: 10, ai: 180, data: 60, intel: 600, review: 900, output: 120, logic: 60 * 60 * 24, action: 30 };

export function nodeTimeoutSec(nodeType: string, config: Record<string, unknown>): number {
  const category = nodeType.split(".")[0];
  const own = Number(config.timeoutSec);
  if (Number.isFinite(own) && own > 0) return own;
  return envNum(`WORKFLOW_TIMEOUT_${category.toUpperCase()}_SEC`, DEFAULT_TIMEOUT_SEC[category] ?? 60, 1);
}

/** Environment ceilings for run budgets. */
export function defaultBudget(): RunBudget {
  return { maxTokens: envNum("WORKFLOW_BUDGET_TOKENS", 1_500_000, 1), maxCostUsd: envNum("WORKFLOW_BUDGET_USD", 20, 0.0001), maxDurationMs: envNum("WORKFLOW_BUDGET_MS", 4 * 3600_000, 1000) };
}

/** A run's budget: the environment ceiling, narrowed by the trigger node's `budget` config and the start request. */
export function resolveBudget(workflow: Pick<Workflow, "nodes">, override?: Partial<RunBudget>): RunBudget {
  const ceiling = defaultBudget();
  const trigger = workflow.nodes.find((n) => n.type.startsWith("trigger."));
  const own = trigger?.config.budget && typeof trigger.config.budget === "object" ? (trigger.config.budget as Partial<RunBudget>) : {};
  const pick = (k: keyof RunBudget) => {
    const candidates = [override?.[k], own[k]].map(Number).filter((v) => Number.isFinite(v) && v > 0);
    return candidates.length ? Math.min(ceiling[k], ...candidates) : ceiling[k];
  };
  return { maxTokens: pick("maxTokens"), maxCostUsd: pick("maxCostUsd"), maxDurationMs: pick("maxDurationMs") };
}

/** Estimated USD per 1M tokens by model tier (override through env). */
function rates(tier: "primary" | "fast") {
  const env = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 ? n : d; };
  return tier === "fast" ? { input: env("WORKFLOW_COST_FAST_INPUT", 0.25), output: env("WORKFLOW_COST_FAST_OUTPUT", 2) } : { input: env("WORKFLOW_COST_PRIMARY_INPUT", 2.5), output: env("WORKFLOW_COST_PRIMARY_OUTPUT", 10) };
}

export function estimateCostUsd(usage: { input: number; output: number }, tier: "primary" | "fast"): number {
  const r = rates(tier);
  return (usage.input / 1e6) * r.input + (usage.output / 1e6) * r.output;
}

function capStrings<T>(v: T, cap = STRING_CAP): T {
  if (typeof v === "string") return (v.length > cap ? v.slice(0, cap) + "…[truncated]" : v) as T;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, cap)) as T;
  if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = capStrings(x, cap); return o as T; }
  return v;
}

function clone<T>(v: T): T { return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T); }

// ─────────────────────────── Failure model (constitution §47) ───────────────────────────

export interface FailureInfo {
  kind: WorkflowFailureKind;
  message: string;
  /** Legacy/step error code kept on the run record (`errorCode`) for existing consumers. */
  code?: string;
  /** Only transient failures are retried: rate limits, provider outages, timeouts. */
  retryable: boolean;
}

class TimeoutError extends Error { constructor(ms: number) { super(`Step timed out after ${Math.round(ms / 1000)}s`); this.name = "TimeoutError"; } }

const RETRYABLE_KINDS = new Set<WorkflowFailureKind>(["rate_limit", "provider_outage", "timeout"]);
const NO_API_KEY_MESSAGE = "OpenAI key required: add OPENAI_API_KEY to .env.local to run AI steps.";

function isAbort(e: unknown): boolean {
  return (e instanceof DOMException && e.name === "AbortError") || (e instanceof Error && e.name === "AbortError");
}

function inferenceKind(code: InferenceError["code"]): WorkflowFailureKind {
  switch (code) {
    case "not_configured": case "capability_unavailable": return "not_configured";
    case "privacy_boundary": case "auth": return "auth";
    case "rate_limited": return "rate_limit";
    case "provider_unavailable": return "provider_outage";
    case "timeout": return "timeout";
    case "cancelled": return "cancelled";
    case "malformed_output": return "malformed_output";
    case "incomplete": case "refusal": return "incomplete_model_result";
    default: return "unknown";
  }
}

/**
 * Classify a thrown error into one distinct failure kind. Configuration errors
 * are terminal (never retried); only rate limits, provider outages and timeouts
 * are transient. `InferenceError.retryable` is honoured when present.
 */
export function classifyFailure(e: unknown, opts: { timedOut?: boolean } = {}): FailureInfo {
  if (e instanceof AIConfigError) return { kind: "not_configured", message: NO_API_KEY_MESSAGE, code: "no_api_key", retryable: false };
  const ie = e instanceof InferenceError ? e : e instanceof Error && e.name === "InferenceError" && typeof (e as { code?: unknown }).code === "string" ? (e as InferenceError) : null;
  if (ie) {
    const kind = inferenceKind(ie.code);
    if (kind === "not_configured") return { kind, message: ie.code === "capability_unavailable" ? ie.message : `Model provider not configured (no API key): ${ie.message}`, code: ie.code === "capability_unavailable" ? "capability_unavailable" : "no_api_key", retryable: false };
    return { kind, message: ie.message, code: ie.code, retryable: kind === "cancelled" ? false : Boolean(ie.retryable) && RETRYABLE_KINDS.has(kind) };
  }
  if (opts.timedOut || e instanceof TimeoutError || (e instanceof Error && e.name === "TimeoutError")) return { kind: "timeout", message: e instanceof Error ? e.message : "Step timed out", code: "timeout", retryable: true };
  if (isAbort(e)) return { kind: "cancelled", message: "Cancelled", code: "cancelled", retryable: false };
  if (e instanceof StepError) {
    const code = e.code;
    if (code === "bad_json") return { kind: "malformed_output", message: e.message, code, retryable: false };
    if (code === "not_found" || code === "no_result" || code === "empty_result") return { kind: "no_result", message: e.message, code, retryable: false };
    if (code === "render_failed" || code === "source_failed") return { kind: "tool_failure", message: e.message, code, retryable: false };
    return { kind: "step_error", message: e.message, code, retryable: false };
  }
  if (e instanceof Error) {
    const status = (e as { status?: number }).status;
    const msg = e.message || String(e);
    if (status === 401 || status === 403) return { kind: "auth", message: status === 401 ? "The model provider rejected the API key (401)." : msg, code: "bad_api_key", retryable: false };
    if (status === 429) return { kind: "rate_limit", message: "Rate limited by the model provider (429).", code: "rate_limited", retryable: true };
    if (status === 408 || status === 504) return { kind: "timeout", message: msg, code: "timeout", retryable: true };
    if (status != null && status >= 500) return { kind: "provider_outage", message: msg, code: "provider_unavailable", retryable: true };
    if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up|network error|service unavailable/i.test(msg)) return { kind: "provider_outage", message: msg, code: "network", retryable: true };
    if (/timed? ?out|timeout/i.test(msg)) return { kind: "timeout", message: msg, code: "timeout", retryable: true };
    if (/rate limit/i.test(msg)) return { kind: "rate_limit", message: msg, code: "rate_limited", retryable: true };
    if (/cut off|incomplete|max_output_tokens|refused/i.test(msg)) return { kind: "incomplete_model_result", message: msg, code: "incomplete", retryable: false };
    if (/no JSON|valid JSON|Unexpected token|JSON at position/i.test(msg)) return { kind: "malformed_output", message: msg, code: "bad_json", retryable: false };
    if (/tool .*(failed|error)/i.test(msg)) return { kind: "tool_failure", message: msg, code: "tool_failed", retryable: false };
    return { kind: "unknown", message: msg, code: (e as { code?: string }).code, retryable: false };
  }
  return { kind: "unknown", message: String(e), retryable: false };
}

/** Verification steps: when one of these ends the run, the terminal state is `verification_failed`. */
const VERIFICATION_NODE_TYPES = new Set<string>(["ai.verify", "intel.verify", "logic.review"]);

/**
 * Node types whose execution has no external side effects (or side effects that
 * are safe to repeat): they may be re-executed after a restart. Everything that
 * creates records, files, notifications or child runs is not.
 */
export function isIdempotentNodeType(type: string): boolean {
  if (type === "review.auto" || type === "logic.schedule_after" || type === "logic.approval") return false;
  return /^(trigger|ai|data|logic)\./.test(type);
}

/** Skips caused by a failure (as opposed to a branch not taken or a reviewer's decision) make a run partial. */
function failureDrivenSkip(step: WorkflowRunStep | undefined): boolean {
  if (!step || step.status !== "skipped") return false;
  return step.skipReason != null && step.skipReason !== "inactive_path" && step.skipReason !== "trust_gate_rejected" && step.skipReason !== "approval_rejected";
}

function isSkippable(spec: ReturnType<typeof nodeSpec>) { return Boolean(spec); }

interface Frame {
  /** Step states visible for edge activation and templates (top-level or loop iteration). */
  steps: Map<string, WorkflowRunStep>;
  /** Extra template context (loop item…). */
  loop?: TemplateContext["loop"];
  /** Loop iteration metadata for events. */
  iteration?: RunIteration;
  /** Parent frame (for templates: outer steps stay visible). */
  parent?: Frame;
}

class RunExecution {
  private run: WorkflowRunRecord;
  private workflow: Workflow;
  private nodes: Map<string, WorkflowNode>;
  private edges: WorkflowEdge[];
  private plan: ExecutionPlan;
  private usage: RunUsage;
  private matter: Record<string, unknown> | null;
  private budget: RunBudget;
  private paused = false;
  private failed: (FailureInfo & { nodeId: string }) | null = null;
  private stop: StopRequest | null = null;
  /** Config patches applied by the steward when it re-runs a step (kept for the rest of the run). */
  private configOverrides = new Map<string, Record<string, unknown>>();
  private launchedAtMs = Date.now();
  private activeMsBefore: number;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private budgetTimer: ReturnType<typeof setTimeout> | null = null;
  private warned = new Set<string>();

  constructor(run: WorkflowRunRecord, workflow: Workflow, private controller: AbortController) {
    this.run = run;
    this.workflow = workflow;
    const nodes = run.snapshot?.nodes ?? workflow.nodes;
    const edges = run.snapshot?.edges ?? workflow.edges;
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
    this.edges = edges;
    this.plan = executionPlan(nodes, edges);
    this.usage = run.usage ?? { input: 0, output: 0, total: 0, calls: 0, costUsd: 0 };
    this.activeMsBefore = this.usage.activeMs ?? 0;
    this.budget = run.budget ?? resolveBudget({ nodes });
    this.matter = matterContext(run.matterId);
  }

  get signal() { return this.controller.signal; }

  /** Cancel or budget-stop the run: every executing node's signal aborts, the terminal state follows the request kind. */
  requestStop(req: Omit<StopRequest, "at">) {
    if (this.stop) return;
    this.stop = { ...req, at: new Date().toISOString() };
    this.controller.abort();
  }

  // ───────────── persistence, lease & events ─────────────

  private activeMs() { return this.activeMsBefore + (Date.now() - this.launchedAtMs); }

  private touchLease(): RunLease {
    const now = Date.now();
    const lease: RunLease = { owner: workerId(), acquiredAt: this.run.lease?.owner === workerId() ? this.run.lease.acquiredAt : new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + leaseTtlMs()).toISOString() };
    this.run.lease = lease;
    return lease;
  }

  /** Checkpoint: the whole run record is written at every node boundary (and on every heartbeat). */
  private persist() {
    const now = new Date().toISOString();
    this.run.updatedAt = now;
    this.run.checkpointAt = now;
    this.usage.activeMs = this.activeMs();
    this.run.usage = this.usage;
    if (this.run.status === "running" || this.run.status === "queued") this.touchLease();
    db().workflowRuns.put(this.run);
  }

  private topSteps(): Map<string, WorkflowRunStep> {
    const m = new Map<string, WorkflowRunStep>();
    for (const s of this.run.steps) m.set(s.nodeId, s);
    return m;
  }

  private syncSteps(map: Map<string, WorkflowRunStep>) {
    this.run.steps = Array.from(this.nodes.keys()).map((id) => map.get(id) ?? { nodeId: id, status: "pending" });
  }

  private setStep(frame: Frame, nodeId: string, patch: Partial<WorkflowRunStep>, opts: { persist?: boolean } = {}) {
    const cur = frame.steps.get(nodeId) ?? { nodeId, status: "pending" };
    const next: WorkflowRunStep = { ...cur, ...patch };
    if (next.startedAt && next.finishedAt && next.durationMs == null) next.durationMs = Math.max(0, new Date(next.finishedAt).getTime() - new Date(next.startedAt).getTime());
    frame.steps.set(nodeId, next);
    if (!frame.parent) this.syncSteps(frame.steps);
    else {
      // Mirror the latest iteration state on the top-level step so the canvas shows progress.
      const top = this.rootFrame(frame).steps;
      top.set(nodeId, { ...next, logs: [...(next.logs ?? [])] });
      this.syncSteps(top);
    }
    if (opts.persist !== false) this.persist();
    this.publishStep(nodeId, next, frame.iteration);
  }

  private publishStep(nodeId: string, step: WorkflowRunStep, iteration?: RunIteration) {
    const runId = this.run.id;
    switch (step.status) {
      case "running": publishRunEvent(runId, { type: "node.started", runId, nodeId, step, attempt: step.attempt ?? 1, iteration }); break;
      case "succeeded": publishRunEvent(runId, { type: "node.completed", runId, nodeId, step, iteration }); break;
      case "failed": publishRunEvent(runId, { type: "node.failed", runId, nodeId, step, failureKind: step.failureKind ?? "unknown", iteration }); break;
      case "skipped": publishRunEvent(runId, { type: "node.skipped", runId, nodeId, step, reason: step.skipReason ?? "inactive_path", iteration }); break;
      case "cancelled": publishRunEvent(runId, { type: "node.cancelled", runId, nodeId, step, iteration }); break;
      case "waiting_approval": publishRunEvent(runId, { type: "node.waiting", runId, nodeId, step }); break;
      default: publishRunEvent(runId, { type: "node.reset", runId, nodeId, step }); break;
    }
  }

  private rootFrame(frame: Frame): Frame { let f = frame; while (f.parent) f = f.parent; return f; }

  private log(frame: Frame, nodeId: string, line: string) {
    const step = frame.steps.get(nodeId) ?? { nodeId, status: "pending" as const };
    const logs = [...(step.logs ?? []), line].slice(-200);
    frame.steps.set(nodeId, { ...step, logs });
    if (!frame.parent) this.syncSteps(frame.steps);
    publishRunEvent(this.run.id, { type: "node.log", runId: this.run.id, nodeId, line, at: new Date().toISOString() });
  }

  private setRunning() {
    this.run.status = "running";
    this.persist();
  }

  /** Reach a terminal state exactly once: status, stop reason, failure kind, outcome, timestamps, audit and the terminal event. */
  private finish(status: RunTerminalStatus, extra: { stopReason: RunStopReason; failureKind?: WorkflowFailureKind; error?: string; errorCode?: string; stoppedAtNodeId?: string }, rootFrame: Frame) {
    const now = new Date().toISOString();
    this.run.status = status;
    this.run.terminalState = status;
    this.run.stopReason = extra.stopReason;
    this.run.failureKind = extra.failureKind;
    this.run.stoppedAtNodeId = extra.stoppedAtNodeId;
    if (extra.error !== undefined) this.run.error = extra.error;
    if (extra.errorCode !== undefined) this.run.errorCode = extra.errorCode;
    this.run.finishedAt = now;
    this.run.endedAt = now;
    this.run.durationMs = new Date(now).getTime() - new Date(this.run.startedAt).getTime();
    this.run.outcome = this.computeOutcome(rootFrame);
    this.run.lease = null;
    this.usage.activeMs = this.activeMs();
    this.run.usage = this.usage;
    this.run.budget = this.budget;
    audit("workflow.run", { kind: "workflowRun", id: this.run.id, label: `${this.workflow.name}: ${status}`, matterId: this.run.matterId }, { workflowId: this.workflow.id, status, stopReason: extra.stopReason, failureKind: extra.failureKind, error: this.run.error, errorCode: this.run.errorCode, durationMs: this.run.durationMs, usage: this.usage, artifacts: (this.run.artifacts ?? []).length, outcome: { completed: this.run.outcome.completed.length, failed: this.run.outcome.failed.length, skipped: this.run.outcome.skipped.length, cancelled: this.run.outcome.cancelled.length } });
    this.persist();
    if (extra.errorCode === "no_api_key") publishRunEvent(this.run.id, { type: "error", message: this.run.error ?? NO_API_KEY_MESSAGE, code: "no_api_key" });
    publishRunEvent(this.run.id, { type: TERMINAL_EVENT_FOR[status], runId: this.run.id, status, stopReason: extra.stopReason, failureKind: extra.failureKind, error: this.run.error, errorCode: this.run.errorCode, stoppedAtNodeId: extra.stoppedAtNodeId, endedAt: now, usage: this.usage, outcome: this.run.outcome });
    publishRunEvent(this.run.id, { type: "run.done", runId: this.run.id, status });
  }

  private computeOutcome(rootFrame: Frame): RunOutcome {
    const outcome: RunOutcome = { completed: [], failed: [], skipped: [], cancelled: [], notRun: [] };
    for (const id of this.plan.order) {
      const s = rootFrame.steps.get(id);
      switch (s?.status) {
        case "succeeded": outcome.completed.push(id); break;
        case "failed": outcome.failed.push(id); break;
        case "skipped": outcome.skipped.push(id); break;
        case "cancelled": outcome.cancelled.push(id); break;
        default: outcome.notRun.push(id); break;
      }
    }
    return outcome;
  }

  /** True when the graph reached its end but some work did not complete: the run is `partial`, never `succeeded`. */
  private hasIncompleteWork(rootFrame: Frame): boolean {
    for (const s of rootFrame.steps.values()) {
      if (s.status === "failed" || s.status === "cancelled" || failureDrivenSkip(s)) return true;
    }
    for (const iterations of Object.values(this.run.loopIterations ?? {})) {
      for (const it of iterations) {
        if (it.error) return true;
        for (const s of Object.values(it.steps ?? {})) if (s.status === "failed" || s.status === "cancelled" || failureDrivenSkip(s)) return true;
      }
    }
    return false;
  }

  private addArtifact(a: RunArtifact) {
    this.run.artifacts = [...(this.run.artifacts ?? []), a];
    publishRunEvent(this.run.id, { type: "artifact.created", runId: this.run.id, artifact: a });
  }

  private addHandoff(nodeId: string, h: Omit<RunHandoff, "at" | "nodeId"> & { at?: string }): RunHandoff {
    const handoff: RunHandoff = { ...h, at: h.at ?? new Date().toISOString(), nodeId };
    this.run.handoffs = [...(this.run.handoffs ?? []), handoff];
    audit("ai.apply", { kind: "workflowRun", id: this.run.id, label: `${this.workflow.name} › handoff ${handoff.from} → ${handoff.to}`, matterId: this.run.matterId }, { handoff: true, from: handoff.from, to: handoff.to, brief: handoff.brief.slice(0, 300), evidenceIds: handoff.evidenceIds?.slice(0, 20), nodeId, workflowId: this.workflow.id });
    publishRunEvent(this.run.id, { type: "handoff.created", runId: this.run.id, handoff });
    return handoff;
  }

  private addDeliverable(nodeId: string, o: Omit<RunOutput, "nodeId" | "at" | "id"> & { id?: string }): RunOutput {
    const output: RunOutput = { ...o, id: o.id ?? `out_${nanoid(8)}`, nodeId, at: new Date().toISOString() };
    this.run.deliverables = [...(this.run.deliverables ?? []).filter((d) => !(d.nodeId === nodeId && d.blobId && d.blobId === output.blobId && d.docId === output.docId)), output];
    publishRunEvent(this.run.id, { type: "output.created", runId: this.run.id, output });
    return output;
  }

  private async startChild(workflowId: string, opts: { inputs?: Record<string, unknown>; matterId?: string | null; wait?: boolean; event?: Record<string, unknown> }): Promise<{ id: string; status: string; workflowId: string; name: string }> {
    const target = db().workflows.get(workflowId);
    if (!target) throw new StepError(`Workflow ${workflowId} not found`, "not_found");
    if (target.isTemplate) throw new StepError(`"${target.name}" is a template; start your own copy of it instead`, "is_template");
    if (target.id === this.workflow.id) throw new StepError("A workflow cannot start itself", "self_start");
    const child = await startRun(target, { inputs: opts.inputs ?? {}, matterId: opts.matterId ?? undefined, triggeredBy: "event", triggeredById: this.run.triggeredById, parentRunId: this.run.id, event: { parentRunId: this.run.id, parentWorkflowId: this.workflow.id, parentWorkflowName: this.workflow.name, eventType: "workflow", ...(opts.event ?? {}) }, wait: opts.wait });
    this.run.childRunIds = [...(this.run.childRunIds ?? []), child.id];
    this.persist();
    return { id: child.id, status: child.status, workflowId: child.workflowId, name: target.name };
  }

  // ───────────── budgets (constitution §13) ─────────────

  private remainingBudget() {
    return {
      remainingTokens: Math.max(0, this.budget.maxTokens - this.usage.total),
      remainingCostUsd: Math.max(0, Number((this.budget.maxCostUsd - this.usage.costUsd).toFixed(6))),
      remainingMs: Math.max(0, this.budget.maxDurationMs - this.activeMs()),
      deadlineAt: new Date(Date.now() + Math.max(0, this.budget.maxDurationMs - this.activeMs())).toISOString(),
    };
  }

  private warnBudget(dimension: "tokens" | "cost" | "time", used: number, limit: number) {
    if (this.warned.has(dimension) || used < limit * 0.8) return;
    this.warned.add(dimension);
    publishRunEvent(this.run.id, { type: "budget.warning", runId: this.run.id, dimension, used, limit });
  }

  /** Request a stop when a budget is exhausted; returns true when the run must not start more work. */
  private checkBudget(): boolean {
    if (this.stop) return true;
    if (this.usage.total >= this.budget.maxTokens) { this.requestStop({ kind: "budget_tokens", message: `Token budget exhausted: ${this.usage.total.toLocaleString()} of ${this.budget.maxTokens.toLocaleString()} tokens used` }); return true; }
    if (this.usage.costUsd >= this.budget.maxCostUsd) { this.requestStop({ kind: "budget_cost", message: `Cost budget exhausted: $${this.usage.costUsd.toFixed(2)} of $${this.budget.maxCostUsd.toFixed(2)}` }); return true; }
    if (this.activeMs() >= this.budget.maxDurationMs) { this.requestStop({ kind: "budget_time", message: `Time budget exhausted after ${Math.round(this.activeMs() / 1000)}s (limit ${Math.round(this.budget.maxDurationMs / 1000)}s)` }); return true; }
    this.warnBudget("tokens", this.usage.total, this.budget.maxTokens);
    this.warnBudget("cost", this.usage.costUsd, this.budget.maxCostUsd);
    this.warnBudget("time", this.activeMs(), this.budget.maxDurationMs);
    return false;
  }

  private addUsage(result: ExecResult & ExecResultTelemetry, tier: "primary" | "fast", latencyMs: number, reported: { provider?: string; model?: string }, output: unknown): WorkflowStepTelemetry | undefined {
    const u = result.usage as (ExecResult["usage"] & { cacheRead?: number; cacheWrite?: number }) | undefined;
    if (!u) return undefined;
    const cost = Number(estimateCostUsd(u, tier).toFixed(6));
    this.usage.input += u.input; this.usage.output += u.output; this.usage.total += u.total;
    this.usage.calls += result.calls ?? 1;
    this.usage.costUsd = Number((this.usage.costUsd + cost).toFixed(6));
    if (u.cacheRead) this.usage.cacheRead = (this.usage.cacheRead ?? 0) + u.cacheRead;
    if (u.cacheWrite) this.usage.cacheWrite = (this.usage.cacheWrite ?? 0) + u.cacheWrite;
    const prov = stepProvenanceOf(output);
    const model = result.telemetry?.model ?? reported.model ?? prov?.model;
    const provider = result.telemetry?.provider ?? reported.provider;
    return { input: u.input, output: u.output, total: u.total, cacheRead: result.telemetry?.cacheRead ?? u.cacheRead, cacheWrite: result.telemetry?.cacheWrite ?? u.cacheWrite, calls: result.calls ?? 1, costUsd: cost, latencyMs, provider, model };
  }

  // ───────────── template context ─────────────

  private templateContext(frame: Frame): TemplateContext {
    const steps: Record<string, { output?: unknown; status?: string; label?: string; error?: string }> = {};
    const chain: Frame[] = [];
    for (let f: Frame | undefined = frame; f; f = f.parent) chain.unshift(f);
    for (const f of chain) for (const s of f.steps.values()) steps[s.nodeId] = { output: s.output, status: s.status, label: this.nodes.get(s.nodeId)?.label, error: s.error };
    return {
      inputs: this.run.inputs,
      steps,
      matter: this.matter,
      loop: frame.loop ?? frame.parent?.loop ?? null,
      run: { id: this.run.id, workflowId: this.workflow.id, workflowName: this.workflow.name, startedAt: this.run.startedAt, triggeredBy: this.run.triggeredBy, href: `/workflows/runs/${this.run.id}`, deliverables: (this.run.deliverables ?? []).map((d) => ({ id: d.id, title: d.title, format: d.format, href: d.href, downloadHref: d.downloadHref, docId: d.docId, libraryItemId: d.libraryItemId })), handoffs: this.run.handoffs ?? [] },
      user: { id: this.run.triggeredById ?? WORKFLOW_CURRENT_USER.id, name: db().people.get(this.run.triggeredById ?? WORKFLOW_CURRENT_USER.id)?.name ?? WORKFLOW_CURRENT_USER.name },
      now: new Date().toISOString(),
    };
  }

  // ───────────── edge activation ─────────────

  private incoming(nodeId: string) { return this.edges.filter((e) => e.target === nodeId && !isLoopBackEdge(e, this.nodes)); }

  private isEdgeActive(e: WorkflowEdge, frame: Frame): boolean {
    const src = frame.steps.get(e.source) ?? frame.parent?.steps.get(e.source);
    // The steward (review.auto) also runs after a step that failed with onError: continue.
    if (src?.status === "failed" && this.nodes.get(e.target)?.type === "review.auto") return true;
    if (!src || src.status !== "succeeded") return false;
    const type: string | undefined = this.nodes.get(e.source)?.type;
    const out = (src.output ?? {}) as Record<string, unknown>;
    switch (type) {
      case "logic.branch": return !e.sourceHandle || e.sourceHandle === out.matched;
      case "ai.route": return !e.sourceHandle || e.sourceHandle === out.matched || e.sourceHandle === "out";
      case "logic.approval": return out.approved ? !e.sourceHandle || e.sourceHandle === "approved" || e.sourceHandle === "out" : e.sourceHandle === "rejected";
      case "logic.review": return out.approved || out.trusted ? !e.sourceHandle || e.sourceHandle === "approved" || e.sourceHandle === "out" : e.sourceHandle === "rejected";
      case "logic.loop": return e.sourceHandle !== "each";
      default: return true;
    }
  }

  private settled(s?: WorkflowRunStep) { return !!s && (s.status === "succeeded" || s.status === "skipped" || s.status === "failed" || s.status === "cancelled"); }

  /** Reason a node with no active incoming edge is skipped: a failed predecessor (partial run) or simply a path not taken. */
  private skipReasonFor(sources: WorkflowEdge[], frame: Frame): WorkflowSkipReason {
    for (const e of sources) {
      const s = frame.steps.get(e.source) ?? frame.parent?.steps.get(e.source);
      if (!s) continue;
      if (s.status === "failed" || s.status === "cancelled" || failureDrivenSkip(s)) return "upstream_failed";
    }
    return "inactive_path";
  }

  private stopSkipReason(): WorkflowSkipReason {
    if (this.stop?.kind === "cancel") return "run_cancelled";
    if (this.stop && this.stop.kind !== "fail") return "budget_exhausted";
    return "run_failed";
  }

  // ───────────── scheduling ─────────────

  /** Execute a set of nodes with dynamic scheduling. Resolves when all settle, the run pauses, fails, stops or exhausts a budget. */
  private async runNodeSet(ids: string[], frame: Frame): Promise<void> {
    const pendingIds = new Set(ids.filter((id) => !this.settled(frame.steps.get(id)) && frame.steps.get(id)?.status !== "waiting_approval"));
    const inflight = new Map<string, Promise<void>>();
    const schedule = () => {
      if (this.paused || this.failed || this.stop || this.signal.aborted) return;
      if (this.checkBudget()) return;
      for (const id of Array.from(pendingIds)) {
        if (inflight.has(id)) continue;
        // Inside a loop body the edge from the loop's "each" handle is the entry edge: always ready and active.
        const loopId = frame.iteration?.loopId;
        const all = this.incoming(id);
        const entry = Boolean(loopId) && all.some((e) => e.source === loopId && e.sourceHandle === "each");
        const inc = all.filter((e) => e.source !== loopId && (ids.includes(e.source) || frame.parent?.steps.has(e.source)));
        const ready = inc.every((e) => this.settled(frame.steps.get(e.source) ?? frame.parent?.steps.get(e.source)));
        if (!ready) continue;
        pendingIds.delete(id);
        const active = inc.filter((e) => this.isEdgeActive(e, frame)).map((e) => e.source);
        if (entry) active.push(loopId!);
        if ((inc.length || all.length) && !active.length) {
          const reason = this.skipReasonFor(inc, frame);
          this.setStep(frame, id, { status: "skipped", finishedAt: new Date().toISOString(), skipReason: reason, logs: [reason === "upstream_failed" ? "Skipped: an earlier step failed" : "Skipped: no active incoming path"] });
          continue;
        }
        const p = this.execNode(id, frame, active).finally(() => inflight.delete(id));
        inflight.set(id, p);
      }
    };
    schedule();
    while (inflight.size) {
      await Promise.race(inflight.values());
      schedule();
    }
    // Anything still pending after a pause stays pending; after a failure, stop or budget exhaustion it is skipped with the reason.
    if (this.failed || this.stop || this.signal.aborted) {
      const reason = this.stopSkipReason();
      const line = reason === "run_cancelled" ? "Skipped: run stopped" : reason === "budget_exhausted" ? "Skipped: budget exhausted" : "Skipped: run failed";
      for (const id of pendingIds) this.setStep(frame, id, { status: "skipped", skipReason: reason, logs: [line] }, { persist: false });
      this.persist();
    }
  }

  private stepKey(frame: Frame, nodeId: string, attempt: number) {
    return `${this.run.id}:${nodeId}${frame.iteration ? `:i${frame.iteration.index}` : ""}:${attempt}`;
  }

  private async execNode(id: string, frame: Frame, activeSources: string[]): Promise<void> {
    const node = this.nodes.get(id)!;
    const spec = nodeSpec(node.type);
    if (!isSkippable(spec)) { this.fail({ kind: "step_error", message: `Unknown node type ${node.type}`, code: "unknown_type", retryable: false }, frame, id); return; }
    if (node.type === "logic.approval") return this.requestApproval(node, frame);
    if (node.type === "logic.loop") return this.runLoop(node, frame, activeSources);
    const report: ResolveReport = { missing: [], errors: [] };
    const override = this.configOverrides.get(id);
    const config = override ? { ...node.config, ...override } : node.config;
    const timeoutSec = nodeTimeoutSec(node.type, config);
    const retriable = Boolean(spec?.usesAI || spec?.usesNetwork);
    const maxAttempts = 1 + (retriable ? Math.min(MAX_RETRIES, Math.max(0, Number(config.retries ?? 1) || 0)) : 0);
    const continueOnError = config.onError === "continue";
    const tier = config.modelTier === "fast" ? "fast" : "primary";
    const priorAttempts = frame.steps.get(id)?.attempt ?? 0;
    let attempt = priorAttempts;
    let last: FailureInfo | null = null;
    const reported: { provider?: string; model?: string } = {};
    while (attempt < priorAttempts + maxAttempts) {
      attempt++;
      const stepKey = this.stepKey(frame, id, attempt);
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      // Re-executed nodes (a lifted trust gate, a steward re-run, a retry) keep the lines that explain why.
      this.setStep(frame, id, { status: "running", startedAt, finishedAt: undefined, durationMs: undefined, error: undefined, failureKind: undefined, skipReason: undefined, attempt, stepKey, logs: (frame.steps.get(id)?.logs ?? []).filter((l) => /^(Trust gate|Steward|Attempt|Resumed|Carried)/.test(l)) });
      if (this.stop || this.signal.aborted) { this.markStopped(frame, id, startedAt); return; }
      const stepController = new AbortController();
      const onAbort = () => stepController.abort();
      this.signal.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; stepController.abort(); }, timeoutSec * 1000);
      const engine: EngineStepContext = {
        stepKey, attempt, maxAttempts: priorAttempts + maxAttempts,
        budget: this.remainingBudget(),
        emit: (e: ExecutorEmit) => publishRunEvent(this.run.id, { ...e, runId: this.run.id, nodeId: id }),
        reportModel: (info) => { if (info.provider) reported.provider = info.provider; if (info.model) reported.model = info.model; },
      };
      const ctx: ExecContext & { engine: EngineStepContext } = {
        node, run: this.run, workflow: this.workflow, config, ctx: this.templateContext(frame), report,
        signal: stepController.signal,
        log: (line) => this.log(frame, id, line),
        progress: (label, value) => publishRunEvent(this.run.id, { type: "node.progress", runId: this.run.id, nodeId: id, label, value }),
        artifact: (a) => this.addArtifact({ ...a, nodeId: id }),
        handoff: (h) => this.addHandoff(id, h),
        deliver: (o) => this.addDeliverable(id, o),
        rerunStep: async (targetId, patch) => {
          if (targetId === id) throw new Error("A step cannot re-run itself");
          const targetNode = this.nodes.get(targetId);
          if (!targetNode) throw new Error(`Unknown step "${targetId}"`);
          if (this.plan.bodyNodeIds.has(targetId)) throw new Error(`"${targetNode.label}" runs inside a loop and cannot be re-run by the steward`);
          const root = this.rootFrame(frame);
          this.configOverrides.set(targetId, { ...(this.configOverrides.get(targetId) ?? {}), ...patch, onError: "continue" });
          const active = this.incoming(targetId).filter((e) => this.isEdgeActive(e, root)).map((e) => e.source);
          const prior = root.steps.get(targetId);
          root.steps.set(targetId, { nodeId: targetId, status: "pending", attempt: prior?.attempt, logs: [...(prior?.logs ?? []), `Steward re-run${Object.keys(patch).length ? ` with ${JSON.stringify(patch)}` : ""}`] });
          await this.execNode(targetId, root, active);
          return root.steps.get(targetId) ?? { nodeId: targetId, status: "failed", error: "The step did not execute" };
        },
        startWorkflow: (workflowId, opts) => this.startChild(workflowId, opts),
        activeSources,
        engine,
      };
      try {
        let result: ExecResult & ExecResultTelemetry;
        try {
          const exec = ALL_EXECUTORS[node.type as AnyNodeType];
          if (!exec) throw new StepError(`No executor for node type "${node.type}"`, "unknown_type");
          result = await exec(ctx);
        } catch (e) {
          if (timedOut && !this.signal.aborted && isAbort(e)) throw new TimeoutError(timeoutSec * 1000);
          throw e;
        } finally { clearTimeout(timer); this.signal.removeEventListener("abort", onAbort); }
        if (report.missing.length) this.log(frame, id, `Unresolved variables: ${Array.from(new Set(report.missing)).slice(0, 8).join(", ")}`);
        for (const err of report.errors.slice(0, 5)) this.log(frame, id, `Template: ${err}`);
        const latencyMs = Date.now() - startedMs;
        const telemetry = this.addUsage(result, tier, latencyMs, reported, result.output);
        const finishedAt = new Date().toISOString();
        this.setStep(frame, id, { status: "succeeded", finishedAt, output: capStrings(result.output), input: capStrings(summarizeInput(config, ctx.ctx), 2000), tokens: result.usage?.total, telemetry });
        this.checkBudget();
        return;
      } catch (e) {
        if (e instanceof TrustGateError) {
          if (frame.parent) {
            // Inside a loop body the run cannot pause; the action is skipped so nothing is created from untrusted output.
            this.setStep(frame, id, { status: "skipped", finishedAt: new Date().toISOString(), skipReason: "trust_gate", output: { gated: true, reason: e.message, reasons: e.reasons, stepIds: e.stepIds }, logs: [...(frame.steps.get(id)?.logs ?? []), `Trust gate: ${e.message}`] });
            return;
          }
          this.pauseForTrust(node, frame, e);
          return;
        }
        // A stop request (cancel, budget, or another node's fatal failure) aborted this node: it ends cancelled, not failed.
        if (this.stop || (this.signal.aborted && isAbort(e))) { this.markStopped(frame, id, startedAt); return; }
        last = classifyFailure(e, { timedOut });
        const retriesLeft = attempt < priorAttempts + maxAttempts;
        if (last.retryable && retriesLeft) {
          const delayMs = Math.min(retryMaxMs(), retryBaseMs() * 2 ** (attempt - priorAttempts - 1)) + Math.floor(Math.random() * Math.min(250, retryBaseMs() / 2 + 1));
          this.log(frame, id, `Attempt ${attempt} failed (${last.kind}: ${last.message}); retrying in ${(delayMs / 1000).toFixed(1)}s`);
          publishRunEvent(this.run.id, { type: "node.retrying", runId: this.run.id, nodeId: id, attempt, nextAttempt: attempt + 1, delayMs, failureKind: last.kind, message: last.message });
          const interrupted = await this.sleep(delayMs);
          if (interrupted) { this.markStopped(frame, id, startedAt); return; }
          continue;
        }
        break;
      }
    }
    const info = last ?? { kind: "unknown" as const, message: "The step did not execute", retryable: false };
    this.setStep(frame, id, { status: "failed", finishedAt: new Date().toISOString(), error: info.message, failureKind: info.kind });
    if (frame.parent) throw Object.assign(new Error(info.message), { code: info.code, kind: info.kind, nodeId: id });
    // onError: continue — the step stays failed, downstream steps that depend on it are skipped, a steward step may fix it, the run goes on.
    if (continueOnError && info.kind !== "cancelled" && !this.signal.aborted) {
      this.log(frame, id, `Failed (${info.kind}); the run continues (on failure: continue)`);
      this.run.logs = [...(this.run.logs ?? []), `"${node.label}" failed and the run continued: ${info.message}`];
      if (!(this.run.stewardship ?? []).some((s) => s.nodeId === id)) this.run.stewardship = [...(this.run.stewardship ?? []), { nodeId: id, code: info.code, fixed: false, escalated: false, note: info.message.slice(0, 300) }];
      return;
    }
    this.fail(info, frame, id);
  }

  /** A node aborted by a stop request ends `cancelled` with the reason that stopped the run (its artifacts so far are kept). */
  private markStopped(frame: Frame, id: string, startedAt: string) {
    const budget = this.stop && this.stop.kind !== "cancel" && this.stop.kind !== "fail";
    const message = this.stop?.kind === "fail" ? `Stopped: ${this.stop.message}` : this.stop?.message ?? "Cancelled";
    this.setStep(frame, id, { status: "cancelled", startedAt, finishedAt: new Date().toISOString(), error: message, failureKind: budget ? "budget_exhausted" : "cancelled", logs: [...(frame.steps.get(id)?.logs ?? []), message] });
  }

  /** Abortable backoff sleep; resolves true when the run was stopped meanwhile. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.signal.aborted) return resolve(true);
      const t = setTimeout(() => { this.signal.removeEventListener("abort", onAbort); resolve(false); }, ms);
      const onAbort = () => { clearTimeout(t); resolve(true); };
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ───────────── follow-ups (front end `after` settings) ─────────────

  private async runFollowUps(rootFrame: Frame) {
    const fe = this.workflow.frontend ?? this.run.snapshot?.frontend;
    const after = fe?.after;
    const notifyIds = fe?.output?.notifyPeopleIds ?? [];
    if (!after?.createTask?.title && !after?.triggerWorkflowIds?.length && !notifyIds.length) return;
    const follow: RunFollowUps = { taskIds: [], triggered: [], notified: [], notes: [] };
    const ctx = this.templateContext(rootFrame);
    const report: ResolveReport = { missing: [], errors: [] };
    const d = db();
    const now = new Date();
    if (after?.createTask?.title) {
      try {
        const title = resolveText(after.createTask.title, ctx, report).trim().slice(0, 200) || `Follow up: ${this.workflow.name}`;
        const matterId = this.run.matterId;
        const dup = findNearDuplicateTask(d.tasks.find((t) => t.status !== "done"), { title, matterId });
        if (dup) { follow.taskIds.push(dup.id); follow.notes.push(`Task "${dup.title}" already open; reused`); }
        else {
          const due = resolveDateRule(after.createTask.dueRule ?? "+3d", now);
          const assigneeId = after.createTask.assigneeId && d.people.has(after.createTask.assigneeId) ? after.createTask.assigneeId : (this.run.triggeredById ?? WORKFLOW_CURRENT_USER.id);
          const deliverables = (this.run.deliverables ?? []).slice(0, 6).map((o) => `- ${o.title}: ${o.href ?? o.downloadHref ?? ""}`).join("\n");
          const task: Task = { id: `t_${nanoid(10)}`, title, description: `From workflow "${this.workflow.name}" (run ${this.run.id}).${deliverables ? `\n\nOutputs:\n${deliverables}` : ""}`, matterId, assigneeId, createdById: this.run.triggeredById ?? WORKFLOW_CURRENT_USER.id, status: "todo", priority: "medium", dueAt: due ? due.toISOString().slice(0, 10) : undefined, createdAt: now.toISOString(), updatedAt: now.toISOString(), tags: ["workflow", "follow-up"], source: "workflow", links: [{ label: `Run · ${this.workflow.name}`, href: `/workflows/runs/${this.run.id}` }] };
          d.tasks.put(task);
          audit("create", { kind: "task", id: task.id, label: task.title, matterId }, { source: "workflow.after", runId: this.run.id, workflowId: this.workflow.id });
          follow.taskIds.push(task.id);
          this.addArtifact({ kind: "task", id: task.id, title: task.title, href: `/?task=${task.id}`, nodeId: "__after__", meta: { dueAt: task.dueAt, assignee: d.people.get(assigneeId)?.name } });
        }
      } catch (e) { follow.notes.push(`Follow-up task not created: ${(e as Error).message}`); }
    }
    for (const wid of after?.triggerWorkflowIds ?? []) {
      if (!wid || wid === this.workflow.id) continue;
      try {
        const inputs = { ...Object.fromEntries(Object.entries(this.run.inputs).filter(([k]) => k !== "__event")), parent_run_id: this.run.id, parent_workflow: this.workflow.name, parent_deliverables: (this.run.deliverables ?? []).map((o) => ({ id: o.id, title: o.title, format: o.format, href: o.href, downloadHref: o.downloadHref, docId: o.docId, libraryItemId: o.libraryItemId })) };
        const child = await this.startChild(wid, { inputs, matterId: this.run.matterId ?? null, event: { after: true } });
        follow.triggered.push({ workflowId: child.workflowId, runId: child.id, name: child.name });
      } catch (e) { follow.notes.push(`Could not start ${d.workflows.get(wid)?.name ?? wid}: ${(e as Error).message}`); }
    }
    if (notifyIds.length) {
      const deliverables = (this.run.deliverables ?? []);
      const message = `${this.workflow.name} finished${deliverables.length ? `: ${deliverables.map((o) => o.title).slice(0, 3).join(", ")}${deliverables.length > 3 ? ` (+${deliverables.length - 3})` : ""}` : ""}`;
      for (const userId of notifyIds) {
        if (!d.people.has(userId)) continue;
        const notif = { id: `wn_${nanoid(10)}`, runId: this.run.id, workflowId: this.workflow.id, nodeId: "__after__", channel: "in-app", recipientIds: [userId], message, href: `/workflows/runs/${this.run.id}`, createdAt: now.toISOString(), read: false };
        d.collection<typeof notif>("workflow_notifications").put(notif);
        follow.notified.push(userId);
      }
      if (follow.notified.length) this.addArtifact({ kind: "notification", id: `after_${this.run.id}`, title: message.slice(0, 120), href: `/workflows/runs/${this.run.id}`, nodeId: "__after__", meta: { recipients: follow.notified.map((id) => d.people.get(id)?.name ?? id) } });
    }
    this.run.followUps = follow;
    if (follow.notes.length) this.run.logs = [...(this.run.logs ?? []), ...follow.notes];
    this.persist();
  }

  /** A fatal step failure: remember it, stop every other executing node, skip what has not started. */
  private fail(info: FailureInfo, frame: Frame, nodeId: string) {
    if (this.failed) return;
    this.failed = { ...info, nodeId };
    const label = this.nodes.get(nodeId)?.label ?? nodeId;
    this.run.logs = [...(this.run.logs ?? []), `Failed at "${label}": ${info.message}`];
    if (frame.parent) this.setStep(frame, nodeId, { status: "failed", error: info.message, failureKind: info.kind }, { persist: false });
    if (info.kind === "cancelled") return;
    this.requestStop({ kind: "fail", message: `run failed at "${label}"` });
  }

  // ───────────── approvals ─────────────

  /** The approver id from the node config, template-resolved (`{{user.id}}` is the person who started the run). */
  private resolveApprover(node: WorkflowNode, ctx: TemplateContext): string | undefined {
    const raw = node.config.approverId ? String(node.config.approverId).trim() : "";
    if (!raw) return undefined;
    const id = raw.includes("{{") ? resolveText(raw, ctx, { missing: [], errors: [] }).trim() : raw;
    return id || undefined;
  }

  private async requestApproval(node: WorkflowNode, frame: Frame) {
    if (frame.parent) { this.fail({ kind: "step_error", message: "Approval steps inside a loop body are not supported.", code: "unsupported", retryable: false }, frame, node.id); return; }
    const ctx = this.templateContext(frame);
    const report: ResolveReport = { missing: [], errors: [] };
    const approval: RunApproval = {
      nodeId: node.id,
      title: resolveText(String(node.config.title ?? "Approval"), ctx, report),
      message: resolveText(String(node.config.message ?? ""), ctx, report),
      approverId: this.resolveApprover(node, ctx),
      requestedAt: new Date().toISOString(),
    };
    this.run.approvals = [...(this.run.approvals ?? []).filter((a) => a.nodeId !== node.id), approval];
    this.paused = true;
    this.setStep(frame, node.id, { status: "waiting_approval", startedAt: approval.requestedAt, output: { approved: null, title: approval.title, message: approval.message }, logs: [`Waiting for ${approval.approverId ? db().people.get(approval.approverId)?.name ?? approval.approverId : "approval"}`] });
    publishRunEvent(this.run.id, { type: "review.required", runId: this.run.id, approval });
  }

  /**
   * Trust gate: an action (or a logic.review node) refused to act on AI output
   * that is not trusted. The run pauses like an approval; the approval carries
   * kind "trust-gate", the reasons and the AI step ids so the run panel can
   * show exactly what failed verification.
   */
  private pauseForTrust(node: WorkflowNode, frame: Frame, e: TrustGateError) {
    const approverId = this.resolveApprover(node, this.templateContext(frame)) ?? this.run.triggeredById ?? WORKFLOW_CURRENT_USER.id;
    const title = (node.type as string) === "logic.review" ? String(node.config.title || `Trust review: ${node.label}`) : `Trust gate: ${node.label}`;
    const approval = { nodeId: node.id, title, message: e.message, approverId, requestedAt: new Date().toISOString(), kind: "trust-gate", reasons: e.reasons, stepIds: e.stepIds } as RunApproval;
    this.run.approvals = [...(this.run.approvals ?? []).filter((a) => a.nodeId !== node.id), approval];
    this.paused = true;
    this.run.logs = [...(this.run.logs ?? []), `Paused at "${node.label}": ${e.message}`];
    this.setStep(frame, node.id, { status: "waiting_approval", startedAt: approval.requestedAt, output: { approved: null, trusted: false, reasons: e.reasons, stepIds: e.stepIds, title, message: e.message }, logs: [...(frame.steps.get(node.id)?.logs ?? []), `Trust gate: ${e.message}`, `Waiting for ${db().people.get(approverId)?.name ?? approverId}`] });
    audit("workflow.approve", { kind: "workflowRun", id: this.run.id, label: `${this.workflow.name} › ${node.label}: trust gate`, matterId: this.run.matterId }, { requested: true, nodeId: node.id, reasons: e.reasons, stepIds: e.stepIds });
    publishRunEvent(this.run.id, { type: "review.required", runId: this.run.id, approval });
  }

  // ───────────── loops ─────────────

  private async runLoop(node: WorkflowNode, frame: Frame, activeSources: string[]) {
    const id = node.id;
    const startedAt = new Date().toISOString();
    const report: ResolveReport = { missing: [], errors: [] };
    const attempt = (frame.steps.get(id)?.attempt ?? 0) + 1;
    this.setStep(frame, id, { status: "running", startedAt, finishedAt: undefined, durationMs: undefined, error: undefined, failureKind: undefined, attempt, stepKey: this.stepKey(frame, id, attempt), logs: [] });
    const ctx = this.templateContext(frame);
    let items: unknown[] = [];
    try {
      const raw = resolveTemplate(String(node.config.over ?? ""), ctx, report);
      if (Array.isArray(raw)) items = raw;
      else if (typeof raw === "string" && raw.trim()) { try { const p = JSON.parse(raw); items = Array.isArray(p) ? p : raw.split(/\r?\n/).filter(Boolean); } catch { items = raw.split(/\r?\n/).filter(Boolean); } }
      else if (raw && typeof raw === "object") items = Object.values(raw as Record<string, unknown>);
    } catch (e) { const info = classifyFailure(e); this.setStep(frame, id, { status: "failed", finishedAt: new Date().toISOString(), error: info.message, failureKind: info.kind }); this.fail(info, frame, id); return; }
    const max = Math.min(MAX_LOOP_ITERATIONS, Math.max(1, Number(node.config.maxIterations) || MAX_LOOP_ITERATIONS));
    const total = items.length;
    if (total > max) this.log(frame, id, `${total} items; bounded to the first ${max}`);
    items = items.slice(0, max);
    const bodyPlan = this.plan.loops[id] ?? { body: [], bodyOrder: [] };
    const results: { index: number; item: unknown; steps: Record<string, unknown> }[] = [];
    const errors: { index: number; error: string }[] = [];
    const stopOnError = Boolean(node.config.stopOnError);
    const label = String(node.config.itemLabel || "item");
    this.run.loopIterations = { ...(this.run.loopIterations ?? {}), [id]: [] };
    this.log(frame, id, `${items.length} ${label}(s) to process`);
    void activeSources;
    for (let i = 0; i < items.length; i++) {
      if (this.signal.aborted || this.failed || this.stop) break;
      const item = items[i];
      const iterFrame: Frame = { steps: new Map(bodyPlan.body.map((b) => [b, { nodeId: b, status: "pending" as const }])), loop: { item, index: i, count: items.length, number: i + 1, label }, iteration: { loopId: id, index: i, count: items.length }, parent: frame };
      publishRunEvent(this.run.id, { type: "node.progress", runId: this.run.id, nodeId: id, label: `${label} ${i + 1} of ${items.length}`, value: i / items.length });
      let error: string | undefined;
      try {
        await this.runNodeSet(bodyPlan.bodyOrder, iterFrame);
        if (this.failed) break;
      } catch (e) {
        error = (e as Error).message;
        errors.push({ index: i, error });
        this.log(frame, id, `${label} ${i + 1}: ${error}`);
      }
      const stepOutputs: Record<string, unknown> = {};
      const stepRecords: Record<string, WorkflowRunStep> = {};
      for (const s of iterFrame.steps.values()) { stepOutputs[s.nodeId] = s.output; stepRecords[s.nodeId] = s; }
      results.push({ index: i, item, steps: stepOutputs });
      this.run.loopIterations[id].push({ index: i, item: capStrings(item, 4000), steps: stepRecords, error });
      if (error && stopOnError) { const info: FailureInfo = { kind: "step_error", message: `Loop stopped at ${label} ${i + 1}: ${error}`, code: "loop_error", retryable: false }; this.setStep(frame, id, { status: "failed", finishedAt: new Date().toISOString(), error: `Stopped at ${label} ${i + 1}: ${error}`, failureKind: info.kind }); this.fail(info, frame, id); return; }
    }
    if (this.failed || this.stop || this.signal.aborted) {
      if (this.failed) this.setStep(frame, id, { status: "failed", finishedAt: new Date().toISOString(), error: this.failed.message, failureKind: this.failed.kind });
      else this.markStopped(frame, id, startedAt);
      return;
    }
    this.setStep(frame, id, { status: "succeeded", finishedAt: new Date().toISOString(), output: capStrings({ count: results.length, total, results, errors, errorCount: errors.length }) });
  }

  // ───────────── main ─────────────

  async execute(): Promise<void> {
    const rootFrame: Frame = { steps: this.topSteps() };
    const resumed = this.run.steps.some((s) => s.status !== "pending");
    this.launchedAtMs = Date.now();
    this.run.budget = this.budget;
    this.touchLease();
    this.setRunning();
    this.heartbeat = setInterval(() => { try { this.touchLease(); this.persist(); } catch { /* the next checkpoint persists */ } }, heartbeatMs());
    (this.heartbeat as { unref?: () => void }).unref?.();
    const remainingMs = Math.max(0, this.budget.maxDurationMs - this.activeMs());
    this.budgetTimer = setTimeout(() => this.requestStop({ kind: "budget_time", message: `Time budget exhausted (limit ${Math.round(this.budget.maxDurationMs / 1000)}s)` }), remainingMs);
    (this.budgetTimer as { unref?: () => void }).unref?.();
    publishRunEvent(this.run.id, { type: "run.started", runId: this.run.id, at: new Date().toISOString(), resumed, budget: this.budget });
    publishRunEvent(this.run.id, { type: "plan.created", runId: this.run.id, order: this.plan.order, loops: Object.fromEntries(Object.entries(this.plan.loops).map(([k, v]) => [k, v.bodyOrder])), budget: this.budget });
    try {
      try {
        await this.runNodeSet(this.plan.order, rootFrame);
      } catch (e) {
        if (!this.failed) this.fail(classifyFailure(e), rootFrame, this.plan.order[0] ?? "");
      }
      if (this.stop?.kind === "cancel") {
        this.finish("cancelled", { stopReason: "cancelled_by_user", failureKind: "cancelled", error: this.stop.message, errorCode: "cancelled", stoppedAtNodeId: this.currentNodeId(rootFrame) }, rootFrame);
        return;
      }
      if (this.stop && this.stop.kind !== "fail") {
        const stopReason: RunStopReason = this.stop.kind === "budget_tokens" ? "budget_tokens" : this.stop.kind === "budget_cost" ? "budget_cost" : "budget_time";
        this.finish("budget_exhausted", { stopReason, failureKind: "budget_exhausted", error: this.stop.message, errorCode: "budget_exhausted", stoppedAtNodeId: this.currentNodeId(rootFrame) }, rootFrame);
        return;
      }
      if (this.failed) {
        const f = this.failed;
        if (f.kind === "cancelled") { this.finish("cancelled", { stopReason: "cancelled_by_user", failureKind: "cancelled", error: f.message, errorCode: "cancelled", stoppedAtNodeId: f.nodeId }, rootFrame); return; }
        const verification = f.kind === "verification_failed" || VERIFICATION_NODE_TYPES.has(this.nodes.get(f.nodeId)?.type ?? "");
        if (verification) { this.finish("verification_failed", { stopReason: "verification_failed", failureKind: "verification_failed", error: f.message, errorCode: f.code ?? "verification_failed", stoppedAtNodeId: f.nodeId }, rootFrame); return; }
        this.finish("failed", { stopReason: f.kind === "not_configured" ? "not_configured" : "step_failed", failureKind: f.kind, error: f.message, errorCode: f.code, stoppedAtNodeId: f.nodeId }, rootFrame);
        return;
      }
      if (this.paused) {
        this.run.status = "waiting_approval";
        this.run.lease = null;
        this.persist();
        const waitingId = this.run.steps.find((s) => s.status === "waiting_approval")?.nodeId ?? "";
        publishRunEvent(this.run.id, { type: "run.waiting", runId: this.run.id, nodeId: waitingId, usage: this.usage });
        publishRunEvent(this.run.id, { type: "run.done", runId: this.run.id, status: "waiting_approval" });
        return;
      }
      // Collect outputs of every succeeded step (triggers excluded).
      const outputs: Record<string, unknown> = {};
      for (const s of rootFrame.steps.values()) if (s.status === "succeeded" && !this.nodes.get(s.nodeId)?.type.startsWith("trigger.")) outputs[s.nodeId] = s.output;
      this.run.outputs = outputs;
      try { await this.runFollowUps(rootFrame); } catch (e) { this.run.logs = [...(this.run.logs ?? []), `Follow-ups failed: ${(e as Error).message}`]; }
      if (this.hasIncompleteWork(rootFrame)) {
        const failedIds = Array.from(rootFrame.steps.values()).filter((s) => s.status === "failed").map((s) => this.nodes.get(s.nodeId)?.label ?? s.nodeId);
        this.finish("partial", { stopReason: "completed_with_failures", error: failedIds.length ? `Completed with ${failedIds.length} failed step${failedIds.length > 1 ? "s" : ""}: ${failedIds.join(", ")}` : "Completed with failed or skipped work", errorCode: "partial" }, rootFrame);
        return;
      }
      this.finish("succeeded", { stopReason: "completed", error: undefined }, rootFrame);
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.budgetTimer) clearTimeout(this.budgetTimer);
    }
  }

  private currentNodeId(rootFrame: Frame): string | undefined {
    const running = Array.from(rootFrame.steps.values()).find((s) => s.status === "cancelled" || s.status === "running");
    return running?.nodeId;
  }
}

function summarizeInput(config: Record<string, unknown>, ctx: TemplateContext): Record<string, unknown> {
  // Store the resolved config for debugging, but keep it small.
  try { return resolveDeep(config, ctx); } catch { return config; }
}

// ─────────────────────────── Public API ───────────────────────────

export interface StartRunOptions extends RunStartRequest {
  /** Payload for event triggers (exposed as steps.<trigger>.output.*). */
  event?: Record<string, unknown>;
  triggeredById?: string;
  /** Run inline (await completion) — used by tests and the scheduler. */
  wait?: boolean;
}

export function createRunRecord(workflow: Workflow, opts: StartRunOptions): WorkflowRunRecord {
  const inputs: Record<string, unknown> = { ...(opts.inputs ?? {}) };
  if (opts.event) inputs.__event = opts.event;
  let matterId = opts.matterId ?? undefined;
  if (!matterId) {
    const matterInput = (workflow.inputs ?? []).find((i) => i.type === "matter");
    if (matterInput && typeof inputs[matterInput.key] === "string" && db().matters.has(inputs[matterInput.key] as string)) matterId = inputs[matterInput.key] as string;
  }
  if (!matterId) {
    const field = workflow.frontend?.fields?.find((f) => f.type === "matter");
    if (field && typeof inputs[field.key] === "string" && db().matters.has(inputs[field.key] as string)) matterId = inputs[field.key] as string;
  }
  const now = new Date().toISOString();
  return {
    id: `run_${nanoid(10)}`,
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowCategory: workflow.category,
    status: "queued",
    inputs,
    steps: workflow.nodes.map((n) => ({ nodeId: n.id, status: "pending" })),
    startedAt: now,
    updatedAt: now,
    triggeredBy: opts.triggeredBy ?? "manual",
    triggeredById: opts.triggeredById ?? WORKFLOW_CURRENT_USER.id,
    matterId,
    usage: { input: 0, output: 0, total: 0, calls: 0, costUsd: 0, activeMs: 0 },
    budget: resolveBudget(workflow, opts.budget),
    artifacts: [],
    approvals: [],
    handoffs: [],
    deliverables: [],
    childRunIds: [],
    parentRunId: opts.parentRunId,
    snapshot: { nodes: workflow.nodes, edges: workflow.edges, inputs: workflow.inputs, frontend: workflow.frontend },
  };
}

/**
 * Uploaded files referenced by the inputs (front-end file fields, event
 * payloads) are validated against the blob store before the run starts: the
 * blob must exist, stay within the size limit, carry an allowed type and match
 * its magic bytes; a client-supplied name never carries a path.
 */
export function validateRunFileInputs(inputs: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const visit = (v: unknown, path: string, depth: number) => {
    if (depth > 4 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.slice(0, 50).forEach((x, i) => visit(x, `${path}[${i}]`, depth + 1)); return; }
    const o = v as Record<string, unknown>;
    if (typeof o.blobId === "string" && o.blobId) {
      if (seen.has(o.blobId)) return;
      seen.add(o.blobId);
      const rec = db().blobs.get(o.blobId);
      if (!rec) { errors.push(`${path}: uploaded file ${o.blobId} was not found`); return; }
      const verdict = validateUploadedFile({ bytes: rec.bytes, name: typeof o.name === "string" ? o.name : rec.name, mime: typeof o.mime === "string" && o.mime ? o.mime : rec.mime });
      if (!verdict.ok) errors.push(`${path}: ${verdict.reason}`);
      return;
    }
    for (const [k, x] of Object.entries(o)) if (k !== "__event") visit(x, path ? `${path}.${k}` : k, depth + 1);
  };
  visit(inputs, "", 0);
  return errors;
}

/** Validate, persist and launch a run. Resolves with the run record immediately (or after completion when `wait`). */
export async function startRun(workflow: Workflow, opts: StartRunOptions = {}): Promise<WorkflowRunRecord> {
  const v = validateWorkflow(workflow.nodes, workflow.edges);
  if (!v.ok) throw new StepError(`Workflow is not runnable: ${v.issues.filter((i) => i.level === "error").map((i) => i.message).join("; ")}`, "invalid_workflow");
  const missing = (workflow.inputs ?? []).filter((i) => i.required && (opts.inputs?.[i.key] == null || opts.inputs?.[i.key] === "")).map((i) => i.label);
  if (missing.length) throw new StepError(`Missing required input${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`, "missing_inputs");
  // Front-end fields (required, accepted file types, options) are enforced for runs a person starts; scheduled and event runs carry preset payloads.
  if ((opts.triggeredBy ?? "manual") === "manual" && workflow.frontend?.fields?.length) {
    const errs = validateFrontendValues(workflow.frontend, opts.inputs ?? {});
    if (errs.length) {
      const label = (key: string) => workflow.frontend?.fields.find((f) => f.key === key)?.label ?? key;
      throw new StepError(`Invalid input${errs.length > 1 ? "s" : ""}: ${errs.map((e) => `${label(e.key)} — ${e.message}`).join("; ")}`, "invalid_inputs");
    }
  }
  const fileErrors = validateRunFileInputs(opts.inputs ?? {});
  if (fileErrors.length) throw new StepError(`Invalid upload${fileErrors.length > 1 ? "s" : ""}: ${fileErrors.join("; ")}`, "invalid_upload");
  const run = createRunRecord(workflow, opts);
  db().workflowRuns.put(run);
  db().workflows.update(workflow.id, (w) => ({ ...w, runsCount: (w.runsCount ?? 0) + 1, lastRunAt: run.startedAt }));
  audit("workflow.run", { kind: "workflowRun", id: run.id, label: `${workflow.name}: started`, matterId: run.matterId }, { workflowId: workflow.id, triggeredBy: run.triggeredBy, inputs: Object.keys(run.inputs).filter((k) => k !== "__event"), budget: run.budget }, { id: run.triggeredById ?? WORKFLOW_CURRENT_USER.id, name: db().people.get(run.triggeredById ?? WORKFLOW_CURRENT_USER.id)?.name ?? "Workflow" });
  const promise = launch(run, workflow);
  if (opts.wait) { await promise; return db().workflowRuns.get(run.id) as WorkflowRunRecord; }
  return run;
}

function launch(run: WorkflowRunRecord, workflow: Workflow): Promise<void> {
  const controller = new AbortController();
  const exec = new RunExecution(run, workflow, controller);
  const promise = exec.execute().catch((e) => { console.error(`[workflows] run ${run.id} crashed`, e); }).finally(() => { activeRuns().delete(run.id); });
  activeRuns().set(run.id, { controller, promise, stop: (req) => exec.requestStop(req) });
  return promise;
}

export function isRunActive(runId: string) { return activeRuns().has(runId); }

/** Resolves once the run is no longer executing in this process (tests and the scheduler). */
export async function waitForRun(runId: string): Promise<WorkflowRunRecord | null> {
  const active = activeRuns().get(runId);
  if (active) await active.promise;
  return db().workflowRuns.get(runId) as WorkflowRunRecord | null;
}

/**
 * Stop a run. An executing run gets a cancel request: every executing node's
 * signal aborts, nodes in flight end `cancelled`, nodes not yet started are
 * skipped, artifacts produced so far are kept and the run ends `cancelled`.
 * A run parked on an approval (or queued) is cancelled directly.
 */
export function cancelRun(runId: string, opts: { by?: string; reason?: string } = {}): WorkflowRunRecord | null {
  const d = db();
  const run = d.workflowRuns.get(runId) as WorkflowRunRecord | null;
  if (!run) return null;
  const active = activeRuns().get(runId);
  if (active) { active.stop({ kind: "cancel", message: opts.reason ?? "Cancelled by user", by: opts.by }); return run; }
  if (run.status === "waiting_approval" || run.status === "queued" || run.status === "running") {
    const now = new Date().toISOString();
    run.status = "cancelled"; run.terminalState = "cancelled"; run.stopReason = "cancelled_by_user"; run.failureKind = "cancelled";
    run.error = opts.reason ?? "Cancelled by user"; run.errorCode = "cancelled"; run.finishedAt = now; run.endedAt = now; run.updatedAt = now; run.lease = null;
    run.durationMs = new Date(now).getTime() - new Date(run.startedAt).getTime();
    run.steps = run.steps.map((s) => (s.status === "pending" ? { ...s, status: "skipped", skipReason: "run_cancelled", finishedAt: now, logs: [...(s.logs ?? []), "Skipped: run stopped"] } : s.status === "waiting_approval" || s.status === "running" ? { ...s, status: "cancelled", failureKind: "cancelled", finishedAt: now, error: run.error, logs: [...(s.logs ?? []), "Cancelled"] } : s));
    run.outcome = outcomeOf(run);
    d.workflowRuns.put(run);
    audit("workflow.run", { kind: "workflowRun", id: run.id, label: `${run.workflowName ?? run.workflowId}: cancelled`, matterId: run.matterId }, { workflowId: run.workflowId, status: "cancelled", stopReason: run.stopReason, by: opts.by });
    publishRunEvent(runId, { type: "run.cancelled", runId, status: "cancelled", stopReason: "cancelled_by_user", failureKind: "cancelled", error: run.error, errorCode: "cancelled", endedAt: now, usage: run.usage, outcome: run.outcome });
    publishRunEvent(runId, { type: "run.done", runId, status: "cancelled" });
  }
  return run;
}

function outcomeOf(run: WorkflowRunRecord): RunOutcome {
  const outcome: RunOutcome = { completed: [], failed: [], skipped: [], cancelled: [], notRun: [] };
  for (const s of run.steps) {
    switch (s.status) {
      case "succeeded": outcome.completed.push(s.nodeId); break;
      case "failed": outcome.failed.push(s.nodeId); break;
      case "skipped": outcome.skipped.push(s.nodeId); break;
      case "cancelled": outcome.cancelled.push(s.nodeId); break;
      default: outcome.notRun.push(s.nodeId); break;
    }
  }
  return outcome;
}

/** Record an approval decision and resume the run. */
export async function resumeRun(runId: string, decision: { approved: boolean; comment?: string; decidedBy?: string }, opts: { wait?: boolean } = {}): Promise<WorkflowRunRecord> {
  const d = db();
  const run = d.workflowRuns.get(runId) as WorkflowRunRecord | null;
  if (!run) throw new StepError("Run not found", "not_found");
  if (run.status !== "waiting_approval") throw new StepError(`Run is ${run.status}, not waiting for approval`, "not_waiting");
  const step = run.steps.find((s) => s.status === "waiting_approval");
  if (!step) throw new StepError("No approval step is pending", "not_waiting");
  const workflow = d.workflows.get(run.workflowId);
  if (!workflow) throw new StepError("Workflow no longer exists", "not_found");
  const now = new Date().toISOString();
  const decidedBy = decision.decidedBy ?? WORKFLOW_CURRENT_USER.id;
  const output = { approved: decision.approved, comment: decision.comment ?? "", decidedBy, decidedByName: d.people.get(decidedBy)?.name ?? decidedBy, decidedAt: now };
  const approval = (run.approvals ?? []).find((a) => a.nodeId === step.nodeId) as (RunApproval & { kind?: string; stepIds?: string[]; reasons?: string[] }) | undefined;
  const actor = { id: decidedBy, name: output.decidedByName };
  audit("workflow.approve", { kind: "workflowRun", id: run.id, label: `${workflow.name} › ${step.nodeId}: ${decision.approved ? "approved" : "rejected"}`, matterId: run.matterId }, { nodeId: step.nodeId, approved: decision.approved, comment: decision.comment, kind: approval?.kind ?? "approval", stepIds: approval?.stepIds }, actor);
  run.approvals = (run.approvals ?? []).map((a) => (a.nodeId === step.nodeId ? { ...a, approved: decision.approved, comment: decision.comment, decidedAt: now, decidedBy } : a));
  const publishStep = (s: WorkflowRunStep) => {
    if (s.status === "succeeded") publishRunEvent(runId, { type: "node.completed", runId, nodeId: s.nodeId, step: s });
    else if (s.status === "skipped") publishRunEvent(runId, { type: "node.skipped", runId, nodeId: s.nodeId, step: s, reason: s.skipReason ?? "trust_gate_rejected" });
    else publishRunEvent(runId, { type: "node.reset", runId, nodeId: s.nodeId, step: s });
  };
  if (approval?.kind === "trust-gate") {
    const node = (run.snapshot?.nodes ?? workflow.nodes).find((n) => n.id === step.nodeId);
    const trust = run as WorkflowRunRecord & RunTrustState;
    const log = `${decision.approved ? "Trust gate lifted" : "Trust gate rejected"} by ${output.decidedByName}${decision.comment ? `: ${decision.comment}` : ""}`;
    if (decision.approved) {
      // The reviewer vouched for the AI output: remember it for this run and re-execute the node with the gate lifted.
      trust.trustOverrides = Array.from(new Set([...(trust.trustOverrides ?? []), step.nodeId, ...(approval.stepIds ?? [])]));
      run.steps = run.steps.map((s) => (s.nodeId === step.nodeId ? { nodeId: s.nodeId, status: "pending", attempt: s.attempt, logs: [...(s.logs ?? []), log] } : s));
    } else if ((node?.type as string | undefined) === "logic.review") {
      run.steps = run.steps.map((s) => (s.nodeId === step.nodeId ? { ...s, status: "succeeded", finishedAt: now, output: { ...output, trusted: false, reasons: approval.reasons ?? [], steps: (approval.stepIds ?? []).map((id) => ({ id, trusted: false })) }, logs: [...(s.logs ?? []), log] } : s));
    } else {
      // An action was refused: it is skipped (nothing is created) and the rest of the run continues.
      run.steps = run.steps.map((s) => (s.nodeId === step.nodeId ? { ...s, status: "skipped", skipReason: "trust_gate_rejected", finishedAt: now, output: { gated: true, reasons: approval.reasons ?? [], ...output }, logs: [...(s.logs ?? []), log, "Skipped: reviewer rejected the AI output"] } : s));
    }
    run.logs = [...(run.logs ?? []), log];
    publishStep(run.steps.find((s) => s.nodeId === step.nodeId)!);
    run.status = "running"; run.updatedAt = now;
    d.workflowRuns.put(run);
    const promise = launch(run, workflow);
    if (opts.wait) { await promise; return d.workflowRuns.get(runId) as WorkflowRunRecord; }
    return run;
  }
  run.steps = run.steps.map((s) => (s.nodeId === step.nodeId ? { ...s, status: "succeeded", finishedAt: now, output, logs: [...(s.logs ?? []), `${decision.approved ? "Approved" : "Rejected"} by ${output.decidedByName}${decision.comment ? `: ${decision.comment}` : ""}`] } : s));
  const edges = run.snapshot?.edges ?? workflow.edges;
  const hasRejectedPath = edges.some((e) => e.source === step.nodeId && e.sourceHandle === "rejected");
  publishStep(run.steps.find((s) => s.nodeId === step.nodeId)!);
  if (!decision.approved && !hasRejectedPath) {
    run.status = "cancelled"; run.terminalState = "cancelled"; run.stopReason = "approval_rejected"; run.failureKind = "cancelled";
    run.error = `Rejected by ${output.decidedByName}${decision.comment ? `: ${decision.comment}` : ""}`; run.errorCode = "rejected"; run.finishedAt = now; run.endedAt = now; run.updatedAt = now; run.lease = null;
    run.durationMs = new Date(now).getTime() - new Date(run.startedAt).getTime();
    run.steps = run.steps.map((s) => (s.status === "pending" ? { ...s, status: "skipped", skipReason: "approval_rejected", logs: ["Skipped: approval rejected"] } : s));
    run.outcome = outcomeOf(run);
    d.workflowRuns.put(run);
    audit("workflow.run", { kind: "workflowRun", id: run.id, label: `${workflow.name}: cancelled`, matterId: run.matterId }, { workflowId: workflow.id, status: "cancelled", stopReason: "approval_rejected", nodeId: step.nodeId }, actor);
    publishRunEvent(runId, { type: "run.cancelled", runId, status: "cancelled", stopReason: "approval_rejected", failureKind: "cancelled", error: run.error, errorCode: "rejected", stoppedAtNodeId: step.nodeId, endedAt: now, usage: run.usage, outcome: run.outcome });
    publishRunEvent(runId, { type: "run.done", runId, status: "cancelled" });
    return run;
  }
  run.status = "running"; run.updatedAt = now;
  d.workflowRuns.put(run);
  const promise = launch(run, workflow);
  if (opts.wait) { await promise; return d.workflowRuns.get(runId) as WorkflowRunRecord; }
  return run;
}

// ─────────────────────────── Retry (re-run from the failed node) ───────────────────────────

const RETRYABLE_TERMINAL = new Set<RunTerminalStatus>(["failed", "partial", "cancelled", "budget_exhausted", "verification_failed"]);

/**
 * Where a retry can resume: the run reached a terminal state other than
 * success, at least one top-level step completed, at least one did not, and
 * the workflow's graph still matches the run's snapshot (same node ids and
 * types, so carried outputs stay meaningful). Loop bodies are carried as a
 * whole: a loop that did not complete re-runs from its first item.
 */
export function retryPlan(run: WorkflowRunRecord, workflow: Workflow): { from: "failed" | "start"; carry: string[]; restart: string[]; reason: string } {
  const terminal = run.terminalState ?? (isTerminalStatus(run.status) ? run.status : null);
  if (!terminal || !RETRYABLE_TERMINAL.has(terminal)) return { from: "start", carry: [], restart: [], reason: terminal === "succeeded" ? "the run succeeded" : "the run has not finished" };
  const snapshot = run.snapshot;
  if (!snapshot) return { from: "start", carry: [], restart: [], reason: "no graph snapshot" };
  const current = new Map(workflow.nodes.map((n) => [n.id, n.type]));
  const same = snapshot.nodes.length === workflow.nodes.length && snapshot.nodes.every((n) => current.get(n.id) === n.type);
  if (!same) return { from: "start", carry: [], restart: [], reason: "the workflow changed since this run" };
  const plan = executionPlan(snapshot.nodes, snapshot.edges);
  const steps = new Map(run.steps.map((s) => [s.nodeId, s]));
  const carry: string[] = [];
  const restart: string[] = [];
  for (const id of plan.order) {
    const s = steps.get(id);
    if (s?.status === "succeeded" || (s?.status === "skipped" && !failureDrivenSkip(s))) carry.push(id);
    else restart.push(id);
  }
  if (!carry.length || !restart.length) return { from: "start", carry: [], restart: [], reason: carry.length ? "every step completed" : "no step completed" };
  return { from: "failed", carry, restart, reason: `resume from ${restart.map((id) => snapshot.nodes.find((n) => n.id === id)?.label ?? id).slice(0, 3).join(", ")}` };
}

/**
 * Start a new run with the same inputs as an existing one. By default a failed,
 * partial, cancelled, budget-exhausted or verification-failed run is retried
 * from its failed node when the graph allows (completed steps are carried
 * over, with their outputs, artifacts and deliverables); otherwise, and for
 * `from: "start"`, the run starts from the beginning.
 */
export async function rerun(runId: string, opts: { wait?: boolean; from?: "auto" | "failed" | "start"; triggeredById?: string } = {}): Promise<WorkflowRunRecord> {
  const d = db();
  const prev = d.workflowRuns.get(runId) as WorkflowRunRecord | null;
  if (!prev) throw new StepError("Run not found", "not_found");
  const workflow = d.workflows.get(prev.workflowId);
  if (!workflow) throw new StepError("Workflow no longer exists", "not_found");
  if (activeRuns().has(runId)) throw new StepError("The run is still executing; stop it before retrying", "still_running");
  const inputs = { ...prev.inputs };
  const event = inputs.__event as Record<string, unknown> | undefined;
  delete inputs.__event;
  const plan = (opts.from ?? "auto") === "start" ? null : retryPlan(prev, workflow);
  if (!plan || plan.from === "start") {
    if (opts.from === "failed") throw new StepError(`Cannot retry from the failed step: ${plan?.reason ?? "retry from the start instead"}`, "cannot_resume");
    return startRun(workflow, { inputs, matterId: prev.matterId, triggeredBy: "manual", triggeredById: opts.triggeredById, parentRunId: prev.id, event, wait: opts.wait, budget: prev.budget });
  }
  const fileErrors = validateRunFileInputs(inputs);
  if (fileErrors.length) throw new StepError(`Invalid upload${fileErrors.length > 1 ? "s" : ""}: ${fileErrors.join("; ")}`, "invalid_upload");
  const run = createRunRecord(workflow, { inputs, matterId: prev.matterId, triggeredBy: "manual", triggeredById: opts.triggeredById, parentRunId: prev.id, event, budget: prev.budget });
  const carried = new Set(plan.carry);
  const prevSteps = new Map(prev.steps.map((s) => [s.nodeId, s]));
  run.retryOf = prev.id;
  run.trustOverrides = prev.trustOverrides ? [...prev.trustOverrides] : undefined;
  run.steps = run.steps.map((s) => {
    const p = prevSteps.get(s.nodeId);
    if (!carried.has(s.nodeId) || !p) return s;
    return clone({ ...p, logs: [...(p.logs ?? []), `Carried over from run ${prev.id}`] });
  });
  const loopIterations: NonNullable<WorkflowRunRecord["loopIterations"]> = {};
  for (const [loopId, iterations] of Object.entries(prev.loopIterations ?? {})) if (carried.has(loopId)) loopIterations[loopId] = clone(iterations);
  if (Object.keys(loopIterations).length) run.loopIterations = loopIterations;
  run.artifacts = clone((prev.artifacts ?? []).filter((a) => carried.has(a.nodeId)).map((a) => ({ ...a, meta: { ...(a.meta ?? {}), carriedFromRunId: prev.id } })));
  run.deliverables = clone((prev.deliverables ?? []).filter((o) => carried.has(o.nodeId)).map((o) => ({ ...o, meta: { ...(o.meta ?? {}), carriedFromRunId: prev.id } })));
  run.handoffs = clone((prev.handoffs ?? []).filter((h) => h.nodeId && carried.has(h.nodeId)));
  run.logs = [`Retry of run ${prev.id}: ${plan.reason}; ${plan.carry.length} completed step${plan.carry.length === 1 ? "" : "s"} carried over`];
  d.workflowRuns.put(run);
  d.workflows.update(workflow.id, (w) => ({ ...w, runsCount: (w.runsCount ?? 0) + 1, lastRunAt: run.startedAt }));
  audit("workflow.run", { kind: "workflowRun", id: run.id, label: `${workflow.name}: retry of ${prev.id}`, matterId: run.matterId }, { workflowId: workflow.id, retryOf: prev.id, carried: plan.carry, restart: plan.restart }, { id: run.triggeredById ?? WORKFLOW_CURRENT_USER.id, name: d.people.get(run.triggeredById ?? WORKFLOW_CURRENT_USER.id)?.name ?? "Workflow" });
  const promise = launch(run, workflow);
  if (opts.wait) { await promise; return d.workflowRuns.get(run.id) as WorkflowRunRecord; }
  return run;
}

// ─────────────────────────── Recovery after a restart (constitution §39) ───────────────────────────

export interface RecoveryReport { resumed: string[]; failed: string[]; checked: number }

function leaseExpired(run: WorkflowRunRecord, now: number): boolean {
  if (run.lease?.expiresAt) return new Date(run.lease.expiresAt).getTime() < now;
  // Records without a lease (written before leases existed, or queued and never launched): stale once older than a lease TTL.
  return now - new Date(run.updatedAt ?? run.startedAt).getTime() > leaseTtlMs();
}

/**
 * Recover runs whose lease expired while their process was down (called on
 * boot by the scheduler and on every tick). A run whose in-flight steps are
 * all idempotent resumes from its last checkpoint: completed steps are not
 * re-executed (their step keys are recorded), the interrupted steps run again
 * with a new attempt. A run with a non-idempotent step in flight is failed
 * with a clear reason rather than silently re-executed.
 */
export function recoverOrphanedRuns(opts: { now?: Date; resume?: boolean } = {}): RecoveryReport {
  const d = db();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const resume = opts.resume ?? process.env.WORKFLOW_RECOVER_RESUME !== "0";
  const report: RecoveryReport = { resumed: [], failed: [], checked: 0 };
  for (const run of d.workflowRuns.find((r) => (r.status === "running" || r.status === "queued") && !activeRuns().has(r.id)) as WorkflowRunRecord[]) {
    report.checked++;
    if (!leaseExpired(run, nowMs)) continue;
    const workflow = d.workflows.get(run.workflowId);
    const nodes = new Map((run.snapshot?.nodes ?? workflow?.nodes ?? []).map((n) => [n.id, n]));
    const plan = run.snapshot ? executionPlan(run.snapshot.nodes, run.snapshot.edges) : null;
    const inFlight = run.steps.filter((s) => s.status === "running");
    const idempotent = (s: WorkflowRunStep) => {
      const node = nodes.get(s.nodeId);
      if (!node) return false;
      if (node.type === "logic.loop") return (plan?.loops[node.id]?.body ?? []).every((b) => isIdempotentNodeType(nodes.get(b)?.type ?? ""));
      return isIdempotentNodeType(node.type);
    };
    const blocking = inFlight.filter((s) => !idempotent(s));
    const at = now.toISOString();
    if (resume && workflow && blocking.length === 0) {
      const resumedIds = inFlight.map((s) => s.nodeId);
      run.steps = run.steps.map((s) => (s.status === "running" ? { ...s, status: "pending", startedAt: undefined, finishedAt: undefined, error: undefined, logs: [...(s.logs ?? []), `Resumed after restart: attempt ${s.attempt ?? 1} (${s.stepKey ?? "no step key"}) did not complete; re-executing`] } : s));
      if (run.loopIterations) for (const id of resumedIds) delete run.loopIterations[id];
      run.recovery = { at, action: "resumed", reason: inFlight.length ? `${inFlight.length} idempotent step${inFlight.length > 1 ? "s were" : " was"} in flight when the process stopped` : "the run was queued when the process stopped", stepIds: resumedIds };
      run.logs = [...(run.logs ?? []), `Recovered after restart at ${at}: ${run.recovery.reason}`];
      run.status = "running"; run.updatedAt = at; run.lease = null;
      d.workflowRuns.put(run);
      audit("workflow.run", { kind: "workflowRun", id: run.id, label: `${run.workflowName ?? run.workflowId}: resumed after restart`, matterId: run.matterId }, { workflowId: run.workflowId, resumed: resumedIds });
      launch(run, workflow);
      report.resumed.push(run.id);
      continue;
    }
    const reason = blocking.length
      ? `${blocking.map((s) => `"${nodes.get(s.nodeId)?.label ?? s.nodeId}"`).join(", ")} ${blocking.length > 1 ? "were" : "was"} executing when the server stopped and ${blocking.length > 1 ? "are" : "is"} not idempotent (it creates records or files): not re-run automatically. Retry the run to execute it again.`
      : !workflow ? "The workflow no longer exists." : "Automatic resume is disabled (WORKFLOW_RECOVER_RESUME=0).";
    run.status = "failed"; run.terminalState = "failed"; run.stopReason = "interrupted"; run.failureKind = "interrupted";
    run.error = `Interrupted: the server restarted while this run was in progress. ${reason}`; run.errorCode = "interrupted";
    run.finishedAt = at; run.endedAt = at; run.updatedAt = at; run.lease = null;
    run.durationMs = new Date(at).getTime() - new Date(run.startedAt).getTime();
    run.stoppedAtNodeId = blocking[0]?.nodeId ?? inFlight[0]?.nodeId;
    run.steps = run.steps.map((s) => (s.status === "running" ? { ...s, status: "failed", failureKind: "interrupted", error: idempotent(s) ? "Interrupted by a restart" : "Interrupted by a restart; not re-run because this step is not idempotent", finishedAt: at } : s.status === "pending" ? { ...s, status: "skipped", skipReason: "interrupted", logs: [...(s.logs ?? []), "Skipped: run interrupted"] } : s));
    run.recovery = { at, action: "failed", reason, stepIds: blocking.map((s) => s.nodeId) };
    run.outcome = outcomeOf(run);
    d.workflowRuns.put(run);
    audit("workflow.run", { kind: "workflowRun", id: run.id, label: `${run.workflowName ?? run.workflowId}: interrupted`, matterId: run.matterId }, { workflowId: run.workflowId, status: "failed", stopReason: "interrupted", blocking: blocking.map((s) => s.nodeId) });
    publishRunEvent(run.id, { type: "run.failed", runId: run.id, status: "failed", stopReason: "interrupted", failureKind: "interrupted", error: run.error, errorCode: "interrupted", stoppedAtNodeId: run.stoppedAtNodeId, endedAt: at, usage: run.usage, outcome: run.outcome });
    publishRunEvent(run.id, { type: "run.done", runId: run.id, status: "failed" });
    report.failed.push(run.id);
  }
  return report;
}

/** @deprecated Use recoverOrphanedRuns; kept for callers that only need the old "mark failed" behaviour. */
export function reapOrphanedRuns() {
  return recoverOrphanedRuns({ resume: false });
}
