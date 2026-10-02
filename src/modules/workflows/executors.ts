import "server-only";
import { nanoid } from "nanoid";
import type { ResponseInput } from "openai/resources/responses/responses";
import { db } from "@/lib/db";
import { runAgent, strictJsonSchema, type AgentEvent } from "@/lib/ai/agent";
import { aiBudget, aiConfig } from "@/lib/ai/config";
import { charsForTokens, clipWithMarker, estimateTokens, type BudgetProfileId, type ResolvedBudget } from "@/lib/ai/context-budget";
import type { TaskType } from "@/lib/ai/providers/types";
import { indiaRoutingFor } from "@/lib/ai/india-guidance";
import { evidenceFromToolCalls } from "@/lib/ai/agents/registry";
import { researchToolset, searchEdiscoveryTool, getLibraryItemTool, searchLibraryTool, fetchUrlTool, LEGAL_TOOLS, extractPlainText } from "@/lib/ai/toolkit";
import type { ToolContext, ToolDef } from "@/lib/ai/tools";
import { FIRM_NAME, LEGAL_STYLE_RULES, RESEARCH_METHOD, todayLine } from "@/lib/ai/prompts";
import type { CalendarEvent, EDocument, LibraryItem, Task, TeamUpdate, Workflow, WorkflowNode } from "@/lib/types/domain";
import { applyCiteCheck, applyVerification, crossCheckCitations, extractRecordCites, safeSelfCorrect, safeVerifyClaims, type VerifySource } from "@/lib/ai/verify";
import { audit } from "@/lib/integrity/audit";
import { findNearDuplicateEvent, findNearDuplicateTask, itemHash, normalizeTitle, tokenSimilarity } from "@/lib/integrity/dedupe";
import { contentHash } from "@/lib/integrity/hash";
import { gateReview, isTrusted, makeProvenance, trustReason } from "@/lib/integrity/provenance";
import { putProvenance } from "@/lib/integrity/store";
import { CONFIDENCE_GATE, type Provenance, type ProvenanceSource } from "@/lib/integrity/types";
import { referencedStepIds } from "./template-expr";
import type { AnyNodeType } from "./registry";
import { createOfficeDoc } from "@/modules/office/shared/docs-service";
import { markdownToDoc } from "@/modules/office/shared/markdown-doc";
import { evaluateBranch, type BranchRule } from "./conditions";
import { markdownTable, resolveDateRule, resolveDeep, resolveTemplate, stringify, type ResolveReport, type TemplateContext } from "./template-expr";
import type { RunArtifact, RunHandoff, RunOutput, WorkflowRunRecord } from "./types";
import { WORKFLOW_CURRENT_USER } from "./types";
import { workbookFromTable } from "@/modules/office/sheet/from-rows";
import type { WorkflowRunStep } from "@/lib/types/domain";

// ─────────────────────────── Context ───────────────────────────

export interface ExecContext {
  node: WorkflowNode;
  run: WorkflowRunRecord;
  workflow: Workflow;
  ctx: TemplateContext;
  config: Record<string, unknown>;
  report: ResolveReport;
  signal: AbortSignal;
  log: (line: string) => void;
  progress: (label: string, value?: number) => void;
  artifact: (a: Omit<RunArtifact, "nodeId">) => void;
  /** Record an agent handoff on the run (ai.route, ai.agent). */
  handoff: (h: Omit<RunHandoff, "at" | "nodeId"> & { at?: string }) => RunHandoff;
  /** Record a deliverable (file / document / library item / insight) on the run. */
  deliver: (o: Omit<RunOutput, "nodeId" | "at" | "id"> & { id?: string }) => RunOutput;
  /** Re-execute an earlier step of this run with a config patch (the steward's fixes). Resolves with the step's final state. */
  rerunStep: (nodeId: string, patch: Record<string, unknown>) => Promise<WorkflowRunStep>;
  /** Start another workflow as a child run of this one. */
  startWorkflow: (workflowId: string, opts: { inputs?: Record<string, unknown>; matterId?: string | null; wait?: boolean }) => Promise<{ id: string; status: string; workflowId: string; name: string }>;
  /** Incoming edge sources that were active for this node (for merge). */
  activeSources: string[];
}

export interface ExecResult {
  output: unknown;
  usage?: { input: number; output: number; total: number };
  calls?: number;
}

export type Executor = (x: ExecContext) => Promise<ExecResult>;

export class StepError extends Error {
  constructor(message: string, public code?: string) { super(message); this.name = "StepError"; }
}

/**
 * Thrown by an executor when it would act on AI output that is not trusted.
 * The engine turns it into a pause (an approval of kind "trust-gate") instead
 * of a failure; approving re-runs the node with the gate lifted.
 */
export class TrustGateError extends Error {
  constructor(message: string, public reasons: string[], public stepIds: string[]) { super(message); this.name = "TrustGateError"; }
}

/** Run-record extension kept by the engine (JSON, backwards compatible). */
export interface RunTrustState {
  /** Node ids whose trust gate a person lifted (action nodes and reviewed AI steps). */
  trustOverrides?: string[];
}

export interface StepTrust { id: string; label?: string; trusted: boolean; reason: string; confidence?: number; provenance?: Provenance }

/** Provenance of a step output as the executors record it (`_provenance` on AI outputs, `provenance` on verify steps). */
export function stepProvenanceOf(output: unknown): Provenance | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  return (o._provenance ?? o.provenance) as Provenance | undefined;
}

/**
 * Trust of the AI steps a node's config references. `ai.verify` and
 * `logic.review` outputs count as trusted when they say so; steps a person
 * approved through a trust gate are trusted for the rest of the run.
 */
export function upstreamTrust(x: ExecContext, opts: { minConfidence?: number; stepIds?: string[] } = {}): StepTrust[] {
  const overrides = new Set(((x.run as WorkflowRunRecord & RunTrustState).trustOverrides ?? []));
  const ids = opts.stepIds ?? referencedStepIds(x.config);
  const out: StepTrust[] = [];
  for (const id of ids) {
    const node = x.workflow.nodes.find((n) => n.id === id) ?? x.run.snapshot?.nodes.find((n) => n.id === id);
    const type: string = node?.type ?? "";
    if (!type.startsWith("ai.") && type !== "logic.review") continue;
    const step = x.ctx.steps?.[id];
    const output = (step?.output ?? {}) as Record<string, unknown>;
    if (overrides.has(id)) { out.push({ id, label: node?.label, trusted: true, reason: "approved by reviewer" }); continue; }
    // A step that ran inside a loop has one output per iteration: every iteration must be trusted.
    const iterations = Object.values(x.run.loopIterations ?? {}).flat().filter((it) => it.steps?.[id]?.status === "succeeded");
    if (iterations.length && !(step && step.status === "succeeded" && !iterations.some((it) => it.steps[id]?.output === step.output))) {
      const bad = iterations.filter((it) => { const o = (it.steps[id]?.output ?? {}) as Record<string, unknown>; return type === "ai.verify" ? !o.trusted : !isTrusted(stepProvenanceOf(o)); });
      const first = bad[0] ? ((bad[0].steps[id]?.output ?? {}) as Record<string, unknown>) : undefined;
      const reason = bad.length ? `${bad.length} of ${iterations.length} ${type === "ai.verify" ? "verified items" : "generated items"} failed verification${first ? ` (e.g. ${type === "ai.verify" ? String(first.reason ?? "not trusted") : trustReason(stepProvenanceOf(first))})` : ""}` : `all ${iterations.length} items trusted`;
      out.push({ id, label: node?.label, trusted: bad.length === 0, reason });
      continue;
    }
    if (type === "logic.review") { const ok = Boolean(output.trusted || output.approved); out.push({ id, label: node?.label, trusted: ok, reason: ok ? "passed trust review" : "trust review rejected" }); continue; }
    const p = stepProvenanceOf(output);
    if (type === "ai.verify") { const ok = Boolean(output.trusted); out.push({ id, label: node?.label, trusted: ok, reason: ok ? "verified against sources" : String(output.reason ?? trustReason(p)), confidence: p?.confidence, provenance: p }); continue; }
    if (!p) { out.push({ id, label: node?.label, trusted: false, reason: step ? "no provenance recorded for this step" : "step did not run" }); continue; }
    const min = opts.minConfidence ?? CONFIDENCE_GATE;
    const lowConf = p.confidence != null && p.confidence < min;
    const trusted = isTrusted(p) && !lowConf;
    out.push({ id, label: node?.label, trusted, reason: lowConf && p.confidence != null ? `confidence ${(p.confidence * 100).toFixed(0)}% is below the ${(min * 100).toFixed(0)}% gate` : trustReason(p), confidence: p.confidence, provenance: p });
  }
  return out;
}

/** Throw a TrustGateError when any referenced AI step is untrusted (unless the node opted out or a reviewer lifted the gate). */
export function assertTrusted(x: ExecContext, what: string) {
  if (x.config.requireTrusted === false) return;
  const overrides = new Set(((x.run as WorkflowRunRecord & RunTrustState).trustOverrides ?? []));
  if (overrides.has(x.node.id)) return;
  const trust = upstreamTrust(x);
  const bad = trust.filter((t) => !t.trusted);
  if (!bad.length) return;
  const reasons = bad.map((t) => `"${t.label ?? t.id}": ${t.reason}`);
  throw new TrustGateError(`${what} paused: ${bad.length} AI step${bad.length > 1 ? "s" : ""} not trusted — ${reasons.join("; ")}`, reasons, bad.map((t) => t.id));
}

export function str(v: unknown): string { return stringify(v); }
export function num(v: unknown, d: number): number { const n = Number(v); return Number.isFinite(n) ? n : d; }
export function bool(v: unknown): boolean { return typeof v === "string" ? ["true", "yes", "1", "on"].includes(v.toLowerCase()) : Boolean(v); }
function person(id: unknown) { return id ? db().people.get(String(id)) : null; }
export function personName(id: unknown) { return person(id)?.name ?? "Unassigned"; }
/** An array from a config value: arrays as-is, JSON arrays parsed, otherwise comma / newline separated ids. */
export function idList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? String((x as Record<string, unknown>).id ?? (x as Record<string, unknown>).docId ?? "") : String(x ?? ""))).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") { const t = v.trim(); if (!t) return []; if (t.startsWith("[")) { try { return idList(JSON.parse(t)); } catch { /* fall through */ } } return t.split(/[,\n]/).map((s) => s.trim()).filter(Boolean); }
  if (v && typeof v === "object") return idList(Object.values(v as Record<string, unknown>));
  return [];
}

/** Resolve every string in the node config against the template context. */
export function resolveConfig(x: ExecContext): Record<string, unknown> {
  return resolveDeep(x.config, x.ctx, x.report);
}

function toolCtx(x: ExecContext): ToolContext {
  return {
    emit: (e) => { if (e.type === "citation") x.log(`cite: ${e.citation.title}${e.citation.cite ? ` (${e.citation.cite})` : ""}`); else if (e.type === "status") x.log(e.message); else if (e.type === "progress") x.progress(e.label, e.value); },
    signal: x.signal,
    state: { runId: x.run.id, nodeId: x.node.id, matterId: x.run.matterId },
  };
}

// ─────────────────────────── Matter context ───────────────────────────

/** Rich matter object exposed to templates as {{matter.*}}. */
export function matterContext(matterId?: string | null): Record<string, unknown> | null {
  if (!matterId) return null;
  const d = db();
  const m = d.matters.get(matterId);
  if (!m) return null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...m,
    team: m.teamIds.map((id) => d.people.get(id)).filter(Boolean).map((p) => ({ id: p!.id, name: p!.name, title: p!.title, email: p!.email })),
    leadAttorney: m.leadAttorneyId ? personName(m.leadAttorneyId) : undefined,
    openTasks: d.tasks.find((t) => t.matterId === m.id && t.status !== "done").sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9")).slice(0, 25).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueAt: t.dueAt, assignee: personName(t.assigneeId) })),
    upcomingEvents: d.events.find((e) => e.matterId === m.id && e.startsAt.slice(0, 10) >= today).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 15).map((e) => ({ id: e.id, title: e.title, kind: e.kind, startsAt: e.startsAt, location: e.location, ruleSource: e.ruleSource })),
    recentUpdates: d.updates.find((u) => u.matterId === m.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8).map((u) => ({ author: personName(u.authorId), body: u.body, createdAt: u.createdAt, kind: u.kind })),
    documentCount: d.edocs.count((x) => x.matterId === m.id),
  };
}

// ─────────────────────────── Model helper ───────────────────────────

export interface ModelCall {
  instructions: string;
  input: string | ResponseInput;
  tier?: "fast" | "primary";
  json?: { name: string; schema: Record<string, unknown> };
  research?: { web?: boolean; legal?: boolean; internal?: boolean };
  maxSteps?: number;
  reasoningEffort?: "low" | "medium" | "high";
  /** Context-budget profile (default workflow_step): output size, context guard and evidence capture follow it. */
  budget?: BudgetProfileId;
  /** Routing / telemetry task type (default: research for research steps, else the runtime default). */
  taskType?: TaskType;
  /** Explicit output cap (otherwise the budget's). */
  maxOutputTokens?: number;
}

export interface ModelResult { text: string; json?: unknown; usage: { input: number; output: number; total: number }; calls: number; citations: { title: string; url?: string; cite?: string; source?: string }[]; toolCalls: number; /** Tool results the model read (research evidence for verification). */ evidence: VerifySource[]; model: string; instructions: string; input: string | ResponseInput; /** The budget the step ran under. */ budget?: ResolvedBudget }

/** The budget a step runs under, resolved for its model tier (pure lookups; no model call). */
export function stepBudget(profile: BudgetProfileId, tier?: "fast" | "primary"): ResolvedBudget {
  return aiBudget(profile, tier ? { fast: tier === "fast" } : {});
}

/** Largest share of a step's input budget one piece of step input may take (the rest: instructions, tools, results). */
export const STEP_INPUT_SHARE = 0.5;

/** Tokens one piece of step input may use: `share` (≤ 50%) of the step's input budget left after the fixed prompt. */
export function stepInputTokens(budget: Pick<ResolvedBudget, "inputTokens">, fixed: string[] = [], share = STEP_INPUT_SHARE): number {
  const s = Math.min(STEP_INPUT_SHARE, Math.max(0.05, share));
  const fixedTokens = fixed.reduce((a, t) => a + estimateTokens(t), 0);
  return Math.max(500, Math.floor((budget.inputTokens - fixedTokens) * s));
}

/**
 * Clip step input to `stepInputTokens` (counted with the script-aware estimator, so Indic text gets fewer characters
 * than English, and the model's real limit wins over the character floors steps used before budgets). Never silent: the
 * cut is logged on the run and marked in the text.
 */
export function clipToBudget(x: Pick<ExecContext, "log">, text: string, budget: Pick<ResolvedBudget, "inputTokens">, what: string, opts: { fixed?: string[]; share?: number } = {}): string {
  const maxTokens = stepInputTokens(budget, opts.fixed, opts.share);
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;
  const n = charsForTokens(text, maxTokens);
  x.log(`${what}: ${text.length.toLocaleString("en-US")} characters (~${tokens.toLocaleString("en-US")} tokens); the first ${n.toLocaleString("en-US")} (~${maxTokens.toLocaleString("en-US")} tokens, at most half of the step's input budget) were given to the model.`);
  return clipWithMarker(text, n, what);
}

export async function callModel(x: ExecContext, call: ModelCall): Promise<ModelResult> {
  const cfg = aiConfig();
  const model = call.tier === "fast" ? cfg.fastModel : cfg.model;
  const research = call.research ?? {};
  const wantsResearch = Boolean(research.web || research.legal || research.internal);
  const toolset = wantsResearch ? researchToolset({ web: Boolean(research.web), legal: Boolean(research.legal), internal: Boolean(research.internal), webContextSize: "medium" }) : { tools: [] as ToolDef<never, unknown>[], builtinTools: [] };
  const profile: BudgetProfileId = call.budget ?? "workflow_step";
  const budget = stepBudget(profile, call.tier);
  // Indian law tool routing (and the corpus coverage block) whenever the step holds Indian law tools.
  let instructions = call.instructions;
  const routing = indiaRoutingFor(toolset.tools.map((t) => t.name));
  if (routing) {
    let coverage = "";
    try { coverage = await (await import("@/modules/india/corpus/coverage")).coveragePromptBlock({ waitMs: 1_500 }); } catch { coverage = ""; }
    instructions = [call.instructions, routing, coverage].filter(Boolean).join("\n\n");
  }
  const citations: { title: string; url?: string; cite?: string; source?: string }[] = [];
  let toolCalls = 0;
  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "tool.call": toolCalls++; x.progress(e.label); x.log(`tool: ${e.label}`); break;
      case "tool.result": if (!e.ok) x.log(`tool error: ${e.name}: ${e.error}`); break;
      case "web_search": if (e.status === "completed") { toolCalls++; x.log(`web search: ${e.query ?? "(query)"}`); } break;
      case "citation": citations.push(e.citation); break;
      case "status": x.log(e.message); break;
      case "step": if (e.step > 1) x.progress(`Reasoning (step ${e.step})`); break;
      default: break;
    }
  };
  const res = await runAgent({
    instructions,
    input: call.input,
    model,
    tools: toolset.tools,
    builtinTools: toolset.builtinTools,
    maxSteps: call.maxSteps ?? (wantsResearch ? budget.maxSteps : 1),
    reasoningEffort: call.reasoningEffort ?? (call.tier === "fast" ? "low" : cfg.reasoningEffort === "none" ? "medium" : cfg.reasoningEffort),
    signal: x.signal,
    jsonSchema: call.json ? { name: call.json.name, schema: strictJsonSchema(call.json.schema) } : undefined,
    metadata: { workflowRunId: x.run.id, nodeId: x.node.id },
    onEvent,
    budget: profile,
    maxOutputTokens: call.maxOutputTokens,
    taskType: call.taskType ?? (wantsResearch ? "research" : undefined),
    matterId: x.run.matterId ?? undefined,
    runId: x.run.id,
  });
  let json: unknown = res.json;
  if (call.json && json === undefined) {
    try { json = JSON.parse(res.text); } catch { throw new StepError("The model did not return valid JSON for the requested schema.", "bad_json"); }
  }
  // Evidence for verification: the FULL tool results the model read (not the client previews), bounded by the budget.
  const evidence = evidenceFromToolCalls(res.toolCalls, { maxSources: budget.maxFullSources, maxChars: budget.toolResultChars });
  if (res.elided) x.log(`Context budget: ${res.elided} earlier tool result(s) were elided from the model's context.`);
  return { text: res.text, json, usage: res.usage, calls: 1 + res.steps, citations: dedupe(citations), toolCalls, evidence, model, instructions, input: call.input, budget };
}

// ─────────────────────────── Provenance for AI steps ───────────────────────────

function citationSources(citations: ModelResult["citations"]): ProvenanceSource[] {
  return citations.map((c) => ({ kind: (c.source === "web" ? "web" : c.source === "case-law" || /courtlistener|opinion/i.test(c.url ?? "") ? "case-law" : c.source === "regulation" ? "regulation" : c.source === "docket" ? "docket" : c.cite && /^[A-Z]{2,}[-_]\d{4,}/.test(c.cite) ? "document" : "internal") as ProvenanceSource["kind"], cite: c.cite, url: c.url, title: c.title }));
}

/** Sources referenced in the *inputs* of a step (Bates numbers in the resolved config), so drafts built on e-discovery hits are source-backed. */
function inputSources(c: Record<string, unknown>): ProvenanceSource[] {
  const text = JSON.stringify(c).slice(0, 200_000);
  const cites = extractRecordCites(text);
  return cites.bates.slice(0, 40).map((b) => ({ kind: "document" as const, cite: b }));
}

/**
 * Build, gate and record the provenance of an AI step: model, prompt hash,
 * sources (citations the model read + record cites in its inputs), confidence
 * and usage. Audited as ai.generate with the run and node ids.
 */
export function recordStep(x: ExecContext, r: ModelResult, extra: { confidence?: number; sources?: ProvenanceSource[]; surface?: string; meta?: Record<string, unknown> } = {}): Provenance {
  const sources = [...(extra.sources ?? []), ...citationSources(r.citations), ...inputSources(resolveConfig(x))];
  const p = gateReview(makeProvenance({ surface: extra.surface ?? `workflow.${x.node.type}`, instructions: r.instructions, input: typeof r.input === "string" ? r.input : JSON.stringify(r.input), sources, confidence: extra.confidence, model: r.model, usage: r.usage }));
  audit("ai.generate", { kind: "workflow.step", id: `${x.run.id}:${x.node.id}`, label: `${x.workflow.name} › ${x.node.label}`, matterId: x.run.matterId }, { surface: p.surface, model: r.model, tokens: r.usage.total, toolCalls: r.toolCalls, sources: p.sources.slice(0, 10).map((s) => s.cite ?? s.url ?? s.title), confidence: p.confidence, workflowId: x.workflow.id, runId: x.run.id, nodeId: x.node.id, ...(extra.meta ?? {}) });
  return p;
}

export function storeStepProvenance(x: ExecContext, p: Provenance, title?: string) {
  putProvenance({ kind: "workflow.step", recordId: `${x.run.id}:${x.node.id}`, matterId: x.run.matterId, title: title ?? `${x.workflow.name} › ${x.node.label}`, href: `/workflows/runs/${x.run.id}`, provenance: p });
  if (p.verification) x.log(`Verification: ${p.verification.status} (${p.verification.supported} supported, ${p.verification.unsupported} unsupported, ${p.verification.contradicted} contradicted)${p.verification.unresolvedCites?.length ? `; unresolved cites: ${p.verification.unresolvedCites.slice(0, 5).join(", ")}` : ""}`);
  if (p.review?.status === "pending") x.log(`Needs review: ${p.review.note ?? "below confidence gate"}`);
  return p;
}

/** Evidence set for narrative verification: what the model read (tool results) plus text the step was given. */
export function evidenceFor(r: ModelResult, given: { title: string; text: string }[]): VerifySource[] {
  // Given material and what the model read, bounded by the verifier's budget (never below 20,000 chars / 24 sources).
  const v = stepBudget("verify", "fast");
  const perGiven = Math.max(20_000, v.perSourceChars);
  return [...given.filter((g) => g.text.trim()).map((g) => ({ title: g.title, text: g.text.slice(0, perGiven) })), ...r.evidence].slice(0, Math.max(24, v.maxFullSources));
}

/** Characters of evidence a structured self-correction may see (never below the 60,000 / 40,000 it always had). */
function verifyEvidenceChars(): number {
  return Math.max(60_000, stepBudget("verify", "fast").totalEvidenceChars);
}

/** Narrative verification (fail-soft): claims against evidence + record-cite cross-check; returns the text with [VERIFY] marks. */
export async function verifyNarrativeStep(x: ExecContext, p: Provenance, text: string, sources: VerifySource[], opts: { maxClaims?: number } = {}): Promise<{ provenance: Provenance; text: string }> {
  const verify = x.config.verify !== false;
  const cites = extractRecordCites(sources.map((s) => `${s.cite ?? ""} ${s.text}`).join("\n"));
  let provenance = p;
  let out = text;
  if (cites.bates.length || cites.pageLines.length) {
    const check = crossCheckCitations(text, { bates: cites.bates, pageLines: cites.pageLines });
    out = check.text;
    provenance = applyCiteCheck(provenance, check);
  }
  if (!sources.length) return { provenance: gateReview({ ...provenance, verification: provenance.verification ?? { status: "unverified", checkedAt: new Date().toISOString(), method: "claims", supported: 0, unsupported: 0, contradicted: 0, notes: "no sources available to verify against" } }), text: out };
  const v = await safeVerifyClaims({ answer: text, sources, verify, signal: x.signal, maxClaims: opts.maxClaims });
  const merged = applyVerification(provenance, v, "claims");
  provenance = gateReview({ ...merged, verification: merged.verification ? { ...merged.verification, unresolvedCites: provenance.verification?.unresolvedCites } : merged.verification });
  if (v.verdicts.length) audit("ai.verify", { kind: "workflow.step", id: `${x.run.id}:${x.node.id}`, label: `${x.workflow.name} › ${x.node.label}`, matterId: x.run.matterId }, { method: "claims", status: v.status, supported: v.supported, unsupported: v.unsupported, contradicted: v.contradicted, score: Number(v.score.toFixed(2)) });
  return { provenance, text: out };
}

/** Structured verification (fail-soft): self-correct rows against the evidence; records dropped/changed rows. */
export async function verifyStructuredStep<T>(x: ExecContext, p: Provenance, label: string, output: T, evidence: string, schema: Record<string, unknown>): Promise<{ provenance: Provenance; output: T; changes: string[] }> {
  const r = await safeSelfCorrect<T>({ label, output, evidence, schema, verify: x.config.verify !== false, signal: x.signal });
  const checkedAt = new Date().toISOString();
  const count = (v: unknown) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v as object).length : 1);
  if (!r.ran) return { provenance: gateReview({ ...p, verification: { status: "unverified", checkedAt, method: "schema", supported: 0, unsupported: 0, contradicted: 0, notes: r.error === "skipped" ? "verification skipped by caller" : `self-correction did not run (${r.error ?? "unknown"})` } }), output, changes: [] };
  const before = count(output), after = count(r.corrected), dropped = Math.max(0, before - after);
  const status: NonNullable<Provenance["verification"]>["status"] = dropped === 0 && !r.changes.length ? "verified" : dropped < before ? "partially-verified" : "contradicted";
  if (r.changes.length || dropped) audit("ai.verify", { kind: "workflow.step", id: `${x.run.id}:${x.node.id}`, label: `${x.workflow.name} › ${x.node.label}`, matterId: x.run.matterId }, { method: "self-correct", before, after, dropped, changes: r.changes.slice(0, 20) });
  return { provenance: gateReview({ ...p, verification: { status, checkedAt, method: "schema", supported: after, unsupported: dropped, contradicted: 0, notes: r.changes.length ? `${r.changes.length} correction(s): ${r.changes.slice(0, 5).join(" | ")}`.slice(0, 600) : undefined, changes: r.changes.slice(0, 40) } }), output: r.corrected, changes: r.changes };
}


export function dedupe<T extends { title: string; url?: string; cite?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((c) => { const k = c.url ?? c.cite ?? c.title; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function firmPreamble(x: ExecContext) {
  const m = x.ctx.matter as Record<string, unknown> | null;
  return [
    `You are a workflow step of ${FIRM_NAME}'s internal legal AI platform, running inside the workflow "${x.workflow.name}" (step "${x.node.label}"). ${todayLine()}`,
    m ? `Matter context: ${m.name} (${m.caption ?? m.shortName}); client ${m.client} (${m.clientSide}); ${m.court ?? "no court"}; stage: ${m.stage ?? "n/a"}.` : "No matter is attached to this run.",
    "Output is consumed by later workflow steps and by lawyers; be precise, complete and free of filler. Never invent facts, citations or record cites.",
  ].join("\n");
}

const JSON_TYPES: Record<string, Record<string, unknown>> = {
  string: { type: "string" },
  text: { type: "string" },
  number: { type: "number" },
  integer: { type: "integer" },
  boolean: { type: "boolean" },
  date: { type: "string", description: "ISO 8601 date (YYYY-MM-DD) or empty string when unknown" },
  "string[]": { type: "array", items: { type: "string" } },
  "number[]": { type: "array", items: { type: "number" } },
  object: { type: "object", properties: {}, additionalProperties: true },
  "object[]": { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
};

function fieldsToSchema(fields: { name: string; type?: string; description?: string; required?: boolean }[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f.name) continue;
    const key = f.name.trim().replace(/[^a-zA-Z0-9_]/g, "_");
    const base = JSON_TYPES[(f.type ?? "string").toLowerCase()] ?? JSON_TYPES.string;
    properties[key] = { ...base, description: f.description ?? f.name };
  }
  properties._evidence = { type: "array", description: "For each field, the quote or location that supports the value", items: { type: "object", properties: { field: { type: "string" }, quote: { type: "string" }, confidence: { type: "number" } }, required: ["field", "quote", "confidence"] } };
  return { type: "object", properties, required: Object.keys(properties) };
}

// ─────────────────────────── Executors ───────────────────────────

const trigger: Executor = async (x) => {
  const c = resolveConfig(x);
  const payload = (x.run.inputs.__event as Record<string, unknown> | undefined) ?? {};
  return { output: { inputs: x.run.inputs, startedAt: x.run.startedAt, triggeredBy: x.run.triggeredBy, matterId: x.run.matterId ?? null, note: c.note ?? undefined, ...payload } };
};

const aiPrompt: Executor = async (x) => {
  const c = resolveConfig(x);
  const instructions = `${firmPreamble(x)}\n\n${LEGAL_STYLE_RULES}\n\nStep instructions:\n${str(c.instructions)}`;
  const prompt = str(c.prompt);
  if (!prompt.trim()) throw new StepError("Prompt resolved to an empty string.", "empty_prompt");
  const wantsJson = c.output === "json";
  let schema: Record<string, unknown> | undefined;
  if (wantsJson) {
    const raw = c.jsonSchema;
    if (typeof raw === "string" && raw.trim()) { try { schema = JSON.parse(raw); } catch { throw new StepError("JSON schema is not valid JSON.", "bad_schema"); } }
    else if (raw && typeof raw === "object") schema = raw as Record<string, unknown>;
    else schema = { type: "object", properties: { result: { type: "string" } }, required: ["result"] };
  }
  const r = await callModel(x, { instructions, input: prompt, tier: c.modelTier === "fast" ? "fast" : "primary", json: schema ? { name: "step_output", schema } : undefined, research: c.research as ModelCall["research"] });
  const j = wantsJson ? (r.json as Record<string, unknown>) : undefined;
  const modelConfidence = j && typeof j.confidence === "number" ? j.confidence : undefined;
  let provenance = recordStep(x, r, { confidence: modelConfidence, meta: { output: wantsJson ? "json" : "text" } });
  if (wantsJson && schema) {
    const sourceText = str(c.prompt);
    const ev = verifyEvidenceChars();
    const checked = await verifyStructuredStep(x, provenance, "structured step output", j, `PROMPT CONTEXT:\n${sourceText.slice(0, Math.floor(ev * 0.6))}\n\n${r.evidence.map((e) => e.text).join("\n\n").slice(0, Math.floor(ev * 0.4))}`, schema);
    provenance = storeStepProvenance(x, checked.provenance);
    return { output: { ...(checked.output as Record<string, unknown>), _citations: r.citations.length ? r.citations : undefined, _provenance: provenance }, usage: r.usage, calls: r.calls };
  }
  const verified = await verifyNarrativeStep(x, provenance, r.text, evidenceFor(r, [{ title: "Prompt context", text: prompt }]));
  provenance = storeStepProvenance(x, verified.provenance);
  return { output: { text: verified.text, citations: r.citations, toolCalls: r.toolCalls, _provenance: provenance }, usage: r.usage, calls: r.calls };
};

const aiExtract: Executor = async (x) => {
  const c = resolveConfig(x);
  const source = str(c.source);
  if (!source.trim()) throw new StepError("Source text is empty; nothing to extract.", "empty_source");
  const fields = Array.isArray(c.fields) ? (c.fields as { name: string; type?: string; description?: string }[]) : [];
  if (!fields.length) throw new StepError("No fields configured.", "no_fields");
  const schema = fieldsToSchema(fields);
  const instructions = `${firmPreamble(x)}\n\nExtract the requested fields from the source document exactly as they appear; normalize dates to YYYY-MM-DD and amounts to numbers. Use empty values (\"\", 0, false, []) when a field is genuinely absent — never guess. For every field add an _evidence entry quoting the supporting language.\n${c.instructions ? `Additional guidance: ${str(c.instructions)}` : ""}`;
  const tier = c.modelTier === "fast" ? "fast" : "primary";
  const b = stepBudget("workflow_step", tier);
  const r = await callModel(x, { instructions, input: `SOURCE DOCUMENT:\n"""\n${clipToBudget(x, source, b, "Source document", { fixed: [instructions, JSON.stringify(schema)] })}\n"""`, tier, json: { name: "extraction", schema }, taskType: "extract" });
  x.log(`Extracted ${fields.length} field(s)`);
  const j = (r.json ?? {}) as Record<string, unknown>;
  const ev = Array.isArray(j._evidence) ? (j._evidence as { confidence?: number }[]).map((e) => Number(e.confidence)).filter((n) => Number.isFinite(n)) : [];
  const confidence = ev.length ? Math.max(0, Math.min(1, ev.reduce((a, b) => a + b, 0) / ev.length)) : undefined;
  let provenance = recordStep(x, r, { confidence, meta: { fields: fields.map((f) => f.name) } });
  const checked = await verifyStructuredStep(x, provenance, "field extraction", j, source.slice(0, verifyEvidenceChars()), schema);
  provenance = storeStepProvenance(x, checked.provenance);
  return { output: { ...(checked.output as Record<string, unknown>), _provenance: provenance }, usage: r.usage, calls: r.calls };
};

const aiClassify: Executor = async (x) => {
  const c = resolveConfig(x);
  const source = str(c.source);
  if (!source.trim()) throw new StepError("Source text is empty; nothing to classify.", "empty_source");
  const labels = (Array.isArray(c.labels) ? (c.labels as { label: string; description?: string }[]) : []).filter((l) => l.label);
  if (!labels.length) throw new StepError("No labels configured.", "no_labels");
  const multi = bool(c.multi);
  const enumValues = labels.map((l) => l.label);
  const schema = multi
    ? { type: "object", properties: { labels: { type: "array", items: { type: "object", properties: { label: { type: "string", enum: enumValues }, confidence: { type: "number" }, rationale: { type: "string" } }, required: ["label", "confidence", "rationale"] } } }, required: ["labels"] }
    : { type: "object", properties: { label: { type: "string", enum: enumValues }, confidence: { type: "number", description: "0..1" }, rationale: { type: "string", description: "One or two sentences citing the decisive language" } }, required: ["label", "confidence", "rationale"] };
  const instructions = `${firmPreamble(x)}\n\nClassify the text into ${multi ? "one or more" : "exactly one"} of these labels:\n${labels.map((l) => `- ${l.label}: ${l.description ?? ""}`).join("\n")}\nGive a calibrated confidence between 0 and 1 and a short rationale that quotes the decisive language.\n${c.instructions ? `Additional guidance: ${str(c.instructions)}` : ""}`;
  const tier = c.modelTier === "fast" ? "fast" : "primary";
  const r = await callModel(x, { instructions, input: `TEXT:\n"""\n${clipToBudget(x, source, stepBudget("workflow_step", tier), "Text", { fixed: [instructions] })}\n"""`, tier, json: { name: "classification", schema }, taskType: "classify" });
  const j = r.json as Record<string, unknown>;
  const output = multi ? { labels: j.labels, label: (j.labels as { label: string }[])?.[0]?.label ?? "", confidence: (j.labels as { confidence: number }[])?.[0]?.confidence ?? 0, rationale: (j.labels as { rationale: string }[])?.map((l) => l.rationale).join(" ") } : { ...j, labels: [{ label: j.label, confidence: j.confidence, rationale: j.rationale }] };
  x.log(`Label: ${str(output.label)} (${Math.round(num(output.confidence, 0) * 100)}%)`);
  const provenance = storeStepProvenance(x, recordStep(x, r, { confidence: num(output.confidence, 0), sources: [{ kind: "internal", title: "classified text", cite: contentHash(source).slice(0, 12) }], meta: { label: output.label } }));
  return { output: { ...output, _provenance: provenance }, usage: r.usage, calls: r.calls };
};

const aiSummarize: Executor = async (x) => {
  const c = resolveConfig(x);
  const source = str(c.source);
  if (!source.trim()) throw new StepError("Source text is empty; nothing to summarize.", "empty_source");
  const words = { short: 150, medium: 400, long: 900 }[str(c.length) as "short" | "medium" | "long"] ?? 400;
  const styles: Record<string, string> = {
    bullets: "Write tight bullet points grouped under short bold headings.",
    paragraphs: "Write flowing narrative paragraphs.",
    executive: "Write an executive summary: one-paragraph bottom line, then key points, then risks and next steps.",
    issues: "Produce an issues list: each issue with a heading, the relevant facts, and why it matters.",
    qa: "Produce a deposition-style digest: for each key exchange give page:line, the question, the answer in substance, and a flag (admission, contradiction, evasive, key).",
  };
  const instructions = `${firmPreamble(x)}\n\n${LEGAL_STYLE_RULES}\n\nSummarize the source in Markdown. ${styles[str(c.style)] ?? styles.bullets} Target about ${words} words.${c.focus ? ` Focus on: ${str(c.focus)}.` : ""} Preserve names, dates, Bates numbers, page:line cites and dollar figures exactly.`;
  const tier = c.modelTier === "fast" ? "fast" : "primary";
  const r = await callModel(x, { instructions, input: `SOURCE:\n"""\n${clipToBudget(x, source, stepBudget("workflow_step", tier), "Source", { fixed: [instructions] })}\n"""`, tier, taskType: "summarize" });
  const verified = await verifyNarrativeStep(x, recordStep(x, r, { sources: [{ kind: "internal", title: "summarized source", cite: contentHash(source).slice(0, 12) }] }), r.text, [{ title: "Source", text: source.slice(0, verifyEvidenceChars()) }], { maxClaims: 30 });
  const provenance = storeStepProvenance(x, verified.provenance);
  return { output: { text: verified.text, wordCount: verified.text.split(/\s+/).filter(Boolean).length, _provenance: provenance }, usage: r.usage, calls: r.calls };
};

const aiDraft: Executor = async (x) => {
  const c = resolveConfig(x);
  const brief = str(c.brief);
  if (!brief.trim()) throw new StepError("Drafting brief is empty.", "empty_prompt");
  const kinds: Record<string, string> = {
    memo: "an internal legal memorandum (heading block: TO / FROM / DATE / RE; sections: Question Presented, Short Answer, Background, Analysis, Recommendation)",
    letter: "a formal letter on firm letterhead conventions (date, addressee block, Re: line, salutation, body, closing, signature block)",
    email: "a concise professional email (subject line first as '# Subject: …', then the body)",
    checklist: "a checklist with grouped items, owners and deadlines where known, formatted as Markdown task lists",
    clause: "contract language: the clause itself in numbered sub-sections, followed by a short drafting note",
    brief_section: "a section of a court brief with headings, argument and record/authority cites",
    report: "a client-facing status report (Summary, Recent developments, Upcoming deadlines, Decisions needed, Budget/next steps)",
    chronology: "a chronology: a Markdown table with Date | Event | Source (Bates / cite) | Significance, sorted by date, followed by gaps and open questions",
  };
  const tones: Record<string, string> = { formal: "formal and precise", plain: "plain English, short sentences", persuasive: "persuasive but measured", neutral: "neutral and analytical" };
  const audiences: Record<string, string> = { partner: "a supervising partner", client: "the client (a sophisticated general counsel)", opposing: "opposing counsel", court: "the court", team: "the case team" };
  const instructions = `${firmPreamble(x)}\n\n${LEGAL_STYLE_RULES}\n\nDraft ${kinds[str(c.kind)] ?? kinds.memo}. Tone: ${tones[str(c.tone)] ?? tones.formal}. Audience: ${audiences[str(c.audience)] ?? audiences.partner}. Output Markdown only. Start with a single H1 title line. Use [VERIFY] for any fact or authority you could not confirm. Do not add commentary outside the document.`;
  const tier = c.modelTier === "fast" ? "fast" : "primary";
  const draftBudget = stepBudget("litigation_draft", tier);
  const input = `DRAFTING BRIEF:\n${brief}${c.context ? `\n\nADDITIONAL CONTEXT:\n${clipToBudget(x, str(c.context), draftBudget, "Drafting context", { fixed: [instructions, brief] })}` : ""}`;
  const r = await callModel(x, { instructions, input, tier, research: c.research as ModelCall["research"], maxSteps: draftBudget.maxSteps, budget: "litigation_draft", taskType: "draft" });
  const title = r.text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? `${x.workflow.name} — ${str(c.kind)}`;
  const verified = await verifyNarrativeStep(x, recordStep(x, r, { meta: { kind: str(c.kind), title } }), r.text, evidenceFor(r, [{ title: "Drafting brief", text: brief }, { title: "Additional context", text: c.context ? str(c.context) : "" }]), { maxClaims: 30 });
  const provenance = storeStepProvenance(x, verified.provenance, title);
  return { output: { title, text: verified.text, wordCount: verified.text.split(/\s+/).filter(Boolean).length, citations: r.citations, _provenance: provenance }, usage: r.usage, calls: r.calls };
};

const aiReview: Executor = async (x) => {
  const c = resolveConfig(x);
  const source = str(c.source);
  if (!source.trim()) throw new StepError("Document text is empty; nothing to review.", "empty_source");
  const checklist = (Array.isArray(c.checklist) ? (c.checklist as unknown[]).map(str) : str(c.checklist).split("\n")).map((s) => s.trim()).filter(Boolean);
  if (!checklist.length) throw new StepError("Checklist is empty.", "no_checklist");
  const schema = {
    type: "object",
    properties: {
      findings: { type: "array", items: { type: "object", properties: { item: { type: "string" }, status: { type: "string", enum: ["pass", "fail", "unclear", "n/a"] }, severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"] }, note: { type: "string" }, quote: { type: "string", description: "Exact supporting language from the document, or empty" } }, required: ["item", "status", "severity", "note", "quote"] } },
      summary: { type: "string" },
      score: { type: "number", description: "0..100 overall compliance score" },
    },
    required: ["findings", "summary", "score"],
  };
  const instructions = `${firmPreamble(x)}\n\nReview the document against each checklist item. For each item report pass / fail / unclear / n/a, a severity, a one-sentence note and the exact quote you relied on. Then give a two-sentence summary and an overall score (100 = every item passes).\n${c.instructions ? `Additional guidance: ${str(c.instructions)}` : ""}`;
  const tier = c.modelTier === "fast" ? "fast" : "primary";
  const checklistText = checklist.map((i, n) => `${n + 1}. ${i}`).join("\n");
  const r = await callModel(x, { instructions, input: `CHECKLIST:\n${checklistText}\n\nDOCUMENT:\n"""\n${clipToBudget(x, source, stepBudget("workflow_step", tier), "Document", { fixed: [instructions, checklistText, JSON.stringify(schema)] })}\n"""`, tier, json: { name: "review", schema }, taskType: "review" });
  const j = r.json as { findings: { status: string }[]; summary: string; score: number };
  const failed = (j.findings ?? []).filter((f) => f.status === "fail").length;
  x.log(`${failed} failing item(s), score ${Math.round(num(j.score, 0))}`);
  // Confidence: share of findings that quote the document (a finding without a quote is an opinion, not a check).
  const quoted = (j.findings as { quote?: string }[] | undefined)?.filter((f) => f.quote?.trim()).length ?? 0;
  const confidence = j.findings?.length ? Math.max(0.3, quoted / j.findings.length) : undefined;
  let provenance = recordStep(x, r, { confidence, sources: [{ kind: "internal", title: "reviewed document", cite: contentHash(source).slice(0, 12) }], meta: { failed, score: j.score } });
  const checked = await verifyStructuredStep(x, provenance, "checklist review findings", j.findings ?? [], source.slice(0, verifyEvidenceChars()), schema.properties.findings as Record<string, unknown>);
  provenance = storeStepProvenance(x, checked.provenance);
  const findings = Array.isArray(checked.output) ? checked.output : (j.findings ?? []);
  return { output: { ...j, findings, failed: findings.filter((f) => f.status === "fail").length, passed: findings.filter((f) => f.status === "pass").length, _provenance: provenance }, usage: r.usage, calls: r.calls };
};

const aiResearch: Executor = async (x) => {
  const c = resolveConfig(x);
  const question = str(c.question);
  if (!question.trim()) throw new StepError("Research question is empty.", "empty_prompt");
  const sources = (c.sources as { web?: boolean; legal?: boolean; internal?: boolean }) ?? { web: true, legal: true, internal: true };
  const depth = str(c.depth) || "standard";
  const maxSteps = depth === "quick" ? 4 : depth === "deep" ? 14 : 8;
  const instructions = `${firmPreamble(x)}\n\n${RESEARCH_METHOD}\n\n${LEGAL_STYLE_RULES}\n\n${c.jurisdiction ? `Jurisdiction focus: ${str(c.jurisdiction)}. Prefer authority binding in that forum (the Supreme Court, then that High Court) and pass its registry court ids (e.g. sci, hc-karnataka) to the judgment search tools' courts filter; say when an authority is only persuasive.` : ""}\nDepth: ${depth}. ${depth === "deep" ? "Open and read the controlling opinions before quoting them." : depth === "quick" ? "Use at most four tool calls and answer from the search results." : ""}\nDeliver a research memo in Markdown: **Bottom line**, **Analysis** (with citations), **Authorities relied on** (bulleted with citations and one-line parentheticals), **Open questions / next steps**. Mark unverified points [VERIFY].\n${c.instructions ? `Additional guidance: ${str(c.instructions)}` : ""}`;
  const r = await callModel(x, { instructions, input: question, tier: c.modelTier === "fast" ? "fast" : "primary", research: sources, maxSteps, reasoningEffort: depth === "deep" ? "high" : "medium", budget: depth === "deep" ? "workflow_agent" : "workflow_step", taskType: "research" });
  // Research is verified against what the agent actually read (tool results); an answer with no sources is not source-backed.
  const verified = await verifyNarrativeStep(x, recordStep(x, r, { surface: "workflow.ai.research", meta: { depth, toolCalls: r.toolCalls } }), r.text, evidenceFor(r, []), { maxClaims: 30 });
  const provenance = storeStepProvenance(x, verified.provenance);
  if (!r.citations.length && !r.evidence.length) x.log("Not source-backed: the model answered without reading any source.");
  return { output: { text: verified.text, citations: r.citations, toolCalls: r.toolCalls, sourceBacked: r.citations.length > 0 || r.evidence.length > 0, _provenance: provenance }, usage: r.usage, calls: r.calls };
};

// ───────────── Data ─────────────

interface LibraryHit { id: string; name: string; type: string; description?: string; tags?: string[]; practice_area?: string; office_doc_id?: string; passage: string; score: number; content?: string }

const dataSearchLibrary: Executor = async (x) => {
  const c = resolveConfig(x);
  const query = str(c.query).trim();
  if (!query) throw new StepError("Query is empty.", "empty_query");
  const res = (await searchLibraryTool.execute({ query, type: c.type ? str(c.type) : undefined, matter_id: c.matterId ? str(c.matterId) : undefined, limit: num(c.limit, 8) }, toolCtx(x))) as { count: number; results: LibraryHit[] };
  const results = res.results ?? [];
  if (bool(c.includeContent)) {
    for (const r of results) {
      try { const full = (await getLibraryItemTool.execute({ id: r.id, max_chars: 20_000 }, toolCtx(x))) as { content?: string }; r.content = full.content; } catch (e) { x.log(`could not read ${r.id}: ${(e as Error).message}`); }
    }
  }
  x.log(`${results.length} library hit(s) for "${query}"`);
  const text = results.map((r, i) => `${i + 1}. **${r.name}** (${r.type}${r.practice_area ? `, ${r.practice_area}` : ""})\n${r.content ? r.content.slice(0, 4000) : r.passage}`).join("\n\n");
  return { output: { count: results.length, query, results, text } };
};

interface EdocHit { id: string; bates: string; date: string; custodian: string; type: string; subject: string; from?: string; to?: string[]; passage: string; score: number; ai_score?: number; coding: EDocument["coding"] }

const dataSearchEdiscovery: Executor = async (x) => {
  const c = resolveConfig(x);
  const query = str(c.query).trim();
  const matterId = c.matterId ? str(c.matterId) : undefined;
  const limit = Math.min(num(c.limit, 10), 50);
  const filters = (doc: EDocument) =>
    (!matterId || doc.matterId === matterId) &&
    (!c.custodian || doc.custodianName.toLowerCase().includes(str(c.custodian).toLowerCase())) &&
    (!c.docType || doc.type.toLowerCase() === str(c.docType).toLowerCase()) &&
    (!c.dateAfter || doc.date >= str(c.dateAfter)) &&
    (!c.dateBefore || doc.date <= str(c.dateBefore)) &&
    (!bool(c.privilegedOnly) || doc.coding?.privileged === true) &&
    (!bool(c.hotOnly) || doc.coding?.hot === true) &&
    (!bool(c.responsiveOnly) || doc.coding?.responsive === true);
  let results: EdocHit[];
  if (!query || query === "*") {
    results = db().edocs.find(filters).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit).map((doc) => ({ id: doc.id, bates: doc.bates, date: doc.date, custodian: doc.custodianName, type: doc.type, subject: doc.subject, from: doc.from, to: doc.to, passage: doc.text.slice(0, 900), score: 1, ai_score: doc.aiScore, coding: doc.coding }));
  } else {
    const res = (await searchEdiscoveryTool.execute({ query, matter_id: matterId, custodian: c.custodian ? str(c.custodian) : undefined, doc_type: c.docType ? str(c.docType) : undefined, date_after: c.dateAfter ? str(c.dateAfter) : undefined, date_before: c.dateBefore ? str(c.dateBefore) : undefined, limit: Math.min(limit * 2, 25) }, toolCtx(x))) as { count: number; results: EdocHit[] };
    results = (res.results ?? []).filter((r) => { const doc = db().edocs.get(r.id); return doc ? filters(doc) : true; }).slice(0, limit);
  }
  x.log(`${results.length} document(s)${query ? ` for "${query}"` : ""}`);
  const text = results.map((r) => `**${r.bates}** · ${r.date} · ${r.custodian} · ${r.type} — ${r.subject}${r.coding?.privileged ? " · PRIVILEGED" : ""}${r.coding?.hot ? " · HOT" : ""}\n> ${r.passage.replace(/\s+/g, " ").slice(0, 600)}`).join("\n\n");
  return { output: { count: results.length, query, results, batesNumbers: results.map((r) => r.bates), text } };
};

function relativeDate(v: unknown): string | undefined {
  const s = str(v).trim();
  if (!s) return undefined;
  const d = resolveDateRule(s);
  return d ? d.toISOString().slice(0, 10) : s;
}

const LEGAL_TOOL_MAP = Object.fromEntries(LEGAL_TOOLS.map((t) => [t.name, t as ToolDef<Record<string, unknown>, unknown>]));

const dataLegalSearch: Executor = async (x) => {
  const c = resolveConfig(x);
  const source = str(c.source) || "case_law";
  const limit = Math.min(num(c.limit, 10), 20);
  const tc = toolCtx(x);
  const citations: { title: string; url?: string; cite?: string; source?: string }[] = [];
  tc.emit = (e) => { if (e.type === "citation") citations.push(e.citation); };
  let raw: unknown;
  let text = "";
  const query = str(c.query).trim();
  switch (source) {
    case "case_law": {
      if (!query) throw new StepError("Query is empty.", "empty_query");
      raw = await LEGAL_TOOL_MAP.search_case_law.execute({ query, jurisdiction: c.jurisdiction ? str(c.jurisdiction) : undefined, courts: c.courts ? str(c.courts) : undefined, filed_after: relativeDate(c.after), limit }, tc);
      const r = raw as { total: number; results: { case_name?: string; citations?: string[]; court?: string; date_filed?: string; snippet?: string; url?: string }[] };
      text = r.results.map((o) => `- **${o.case_name}**${o.citations?.[0] ? `, ${o.citations[0]}` : ""} (${o.court ?? ""} ${o.date_filed ?? ""})${o.url ? ` — ${o.url}` : ""}\n  ${o.snippet ?? ""}`).join("\n");
      break;
    }
    case "dockets": {
      if (!query) throw new StepError("Query is empty.", "empty_query");
      raw = await LEGAL_TOOL_MAP.search_dockets.execute({ query, courts: c.courts ? str(c.courts) : undefined, filed_after: relativeDate(c.after), limit }, tc);
      const r = raw as { total: number; results: { case_name?: string; docket_number?: string; court?: string; date_filed?: string; assigned_to?: string; url?: string }[] };
      text = r.results.map((o) => `- **${o.case_name}** · ${o.docket_number ?? ""} · ${o.court ?? ""} · filed ${o.date_filed ?? "?"}${o.assigned_to ? ` · ${o.assigned_to}` : ""}${o.url ? ` — ${o.url}` : ""}`).join("\n");
      break;
    }
    case "docket_entries": {
      const docketId = num(c.docketId, 0);
      if (!docketId) throw new StepError("Docket id is required.", "empty_query");
      raw = await LEGAL_TOOL_MAP.get_docket_entries.execute({ docket_id: docketId, limit }, tc);
      const r = raw as { entries: { entry?: number; date?: string; description?: string }[] };
      text = r.entries.map((e) => `- #${e.entry ?? "?"} (${e.date ?? "?"}): ${e.description ?? ""}`).join("\n");
      break;
    }
    case "cfr": {
      if (!query) throw new StepError("Query is empty.", "empty_query");
      raw = await LEGAL_TOOL_MAP.search_cfr.execute({ query, limit }, tc);
      const r = raw as { total: number; results: { cite: string; heading?: string; excerpt?: string; url?: string }[] };
      text = r.results.map((o) => `- **${o.cite}** — ${o.heading ?? ""}${o.url ? ` (${o.url})` : ""}\n  ${o.excerpt ?? ""}`).join("\n");
      break;
    }
    case "federal_register": {
      if (!query) throw new StepError("Query is empty.", "empty_query");
      raw = await LEGAL_TOOL_MAP.search_federal_register.execute({ query, agency: c.agency ? str(c.agency) : undefined, document_type: c.documentType ? str(c.documentType) : undefined, published_after: relativeDate(c.after), limit }, tc);
      const r = raw as { total: number; results: { title: string; type: string; agencies?: string[]; published: string; citation?: string; abstract?: string; url: string; comments_close_on?: string }[] };
      text = r.results.map((o) => `- **${o.title}** (${o.type}; ${(o.agencies ?? []).join(", ")}; ${o.published}${o.citation ? `; ${o.citation}` : ""}${o.comments_close_on ? `; comments close ${o.comments_close_on}` : ""}) — ${o.url}\n  ${o.abstract ?? ""}`).join("\n");
      break;
    }
    case "statutes": {
      if (!query) throw new StepError("Query is empty.", "empty_query");
      raw = await LEGAL_TOOL_MAP.search_statutes.execute({ query, limit }, tc);
      const r = raw as { total: number; results: { title?: string; date?: string; url?: string; teaser?: string }[] };
      text = r.results.map((o) => `- **${o.title}** (${o.date ?? ""})${o.url ? ` — ${o.url}` : ""}\n  ${o.teaser ?? ""}`).join("\n");
      break;
    }
    case "verify_citations": {
      const body = str(c.text);
      if (!body.trim()) throw new StepError("No text to check.", "empty_query");
      raw = await LEGAL_TOOL_MAP.verify_citations.execute({ text: body }, tc);
      const r = raw as { citations: { citation: string; resolved: boolean; matches?: { case_name?: string; url?: string }[]; error?: string }[] };
      const bad = r.citations.filter((k) => !k.resolved);
      text = `${r.citations.length} citation(s) checked, ${bad.length} unresolved.\n\n${r.citations.map((k) => `- ${k.resolved ? "✓" : "✗"} ${k.citation}${k.matches?.[0]?.case_name ? ` — ${k.matches[0].case_name}` : ""}${k.error ? ` (${k.error})` : ""}`).join("\n")}`;
      const out = { ...r, total: r.citations.length, unresolved: bad, unresolvedCount: bad.length, results: r.citations, text };
      x.log(text.split("\n")[0]);
      return { output: out };
    }
    default:
      throw new StepError(`Unknown legal source "${source}".`, "bad_source");
  }
  const rawObj = raw as Record<string, unknown>;
  const results = (rawObj.results ?? rawObj.entries ?? []) as unknown[];
  x.log(`${results.length} result(s) from ${source}`);
  return { output: { ...rawObj, source, query, results, text, citations: dedupe(citations) } };
};

const dataFetchUrl: Executor = async (x) => {
  const c = resolveConfig(x);
  const url = str(c.url).trim();
  if (!url) throw new StepError("URL is empty.", "empty_query");
  const r = (await fetchUrlTool.execute({ url, max_chars: num(c.maxChars, 30_000) }, toolCtx(x))) as { url: string; title?: string; text: string; contentType?: string };
  x.log(`Fetched ${r.url} (${r.text.length.toLocaleString()} chars)`);
  return { output: r };
};

// ───────────── Logic ─────────────

const logicBranch: Executor = async (x) => {
  const rules = (Array.isArray(x.config.rules) ? x.config.rules : []) as BranchRule[];
  const res = evaluateBranch(rules, x.ctx, x.report);
  x.log(`Matched "${res.label}"`);
  return { output: res };
};

const logicMerge: Executor = async (x) => {
  const branches: Record<string, unknown> = {};
  const succeeded: string[] = [];
  const skipped: string[] = [];
  const steps = x.ctx.steps ?? {};
  for (const e of x.workflow.edges.filter((e) => e.target === x.node.id)) {
    const s = steps[e.source];
    if (s && s.status === "succeeded" && x.activeSources.includes(e.source)) { branches[e.source] = s.output; succeeded.push(e.source); } else skipped.push(e.source);
  }
  return { output: { branches, succeeded, skipped, mode: x.config.mode ?? "all" } };
};

const logicDelay: Executor = async (x) => {
  const c = resolveConfig(x);
  const requestedMs = Math.max(0, num(c.minutes, 0)) * 60_000;
  const cap = num(process.env.WORKFLOW_MAX_DELAY_MS, 120_000);
  const waitMs = Math.min(requestedMs, cap);
  if (requestedMs > cap) x.log(`Delay of ${num(c.minutes, 0)} min capped to ${Math.round(cap / 1000)}s (WORKFLOW_MAX_DELAY_MS).`);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, waitMs);
    x.signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
  return { output: { waitedMs: waitMs, requestedMs, capped: requestedMs > cap } };
};

// ───────────── Actions ─────────────

export function href(kind: RunArtifact["kind"], id: string, docKind?: string) {
  switch (kind) {
    case "task": return `/?task=${id}`;
    case "event": return `/?event=${id}`;
    case "document": return docKind === "sheet" ? `/office/sheet/${id}` : docKind === "slides" ? `/office/slides/${id}` : docKind === "pdf" ? `/office/pdf/${id}` : `/office/word/${id}`;
    case "library": return `/library?item=${id}`;
    case "file": return `/api/blobs/${id}`;
    default: return undefined;
  }
}

/** Provenance of the last AI step feeding an action, so the records it creates stay traceable (TrustBadge on run artifacts). */
export function upstreamProvenance(x: ExecContext): Provenance | undefined {
  const list = upstreamTrust(x).map((t) => t.provenance).filter((p): p is Provenance => !!p);
  return list.length ? list[list.length - 1] : undefined;
}

const actionCreateTask: Executor = async (x) => {
  assertTrusted(x, "Task creation");
  const c = resolveConfig(x);
  const title = str(c.title).trim();
  if (!title) throw new StepError("Task title is empty.", "empty_title");
  const now = new Date();
  // Cross-context: an open task with the same title on the same matter (from an earlier run or a person) is reused.
  const dupMatter = c.matterId ? str(c.matterId) : x.run.matterId;
  const existing = findNearDuplicateTask(db().tasks.find((t) => t.status !== "done"), { title: title.slice(0, 200), matterId: dupMatter || undefined });
  if (existing && c.allowDuplicate !== true) {
    x.log(`Task "${existing.title}" already open (${existing.id}); not creating a duplicate`);
    audit("ai.verify", { kind: "task", id: existing.id, label: existing.title, matterId: existing.matterId }, { method: "dedupe", runId: x.run.id, nodeId: x.node.id, requestedTitle: title });
    x.artifact({ kind: "task", id: existing.id, title: existing.title, href: href("task", existing.id), meta: { dueAt: existing.dueAt, assignee: personName(existing.assigneeId), duplicateOf: existing.id } });
    return { output: { taskId: existing.id, title: existing.title, dueAt: existing.dueAt, assigneeId: existing.assigneeId, assignee: personName(existing.assigneeId), href: href("task", existing.id), duplicateOf: existing.id, created: false } };
  }
  const due = resolveDateRule(c.dueRule, now);
  const matterId = c.matterId ? str(c.matterId) : x.run.matterId;
  const assigneeId = c.assigneeId ? str(c.assigneeId) : undefined;
  const task: Task = {
    id: `t_${nanoid(10)}`,
    title: title.slice(0, 200),
    description: c.description ? str(c.description).slice(0, 4000) : undefined,
    matterId: matterId || undefined,
    assigneeId: assigneeId && db().people.has(assigneeId) ? assigneeId : (x.run.triggeredById ?? WORKFLOW_CURRENT_USER.id),
    createdById: x.run.triggeredById ?? WORKFLOW_CURRENT_USER.id,
    status: "todo",
    priority: (["low", "medium", "high", "urgent"].includes(str(c.priority)) ? str(c.priority) : "medium") as Task["priority"],
    dueAt: due ? due.toISOString().slice(0, 10) : undefined,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    tags: Array.isArray(c.tags) ? (c.tags as unknown[]).map(str).filter(Boolean) : undefined,
    source: "workflow",
    links: [{ label: `Run · ${x.workflow.name}`, href: `/workflows/runs/${x.run.id}` }],
  };
  db().tasks.put(task);
  audit("create", { kind: "task", id: task.id, label: task.title, matterId: task.matterId }, { source: "workflow", runId: x.run.id, nodeId: x.node.id });
  x.artifact({ kind: "task", id: task.id, title: task.title, href: href("task", task.id), meta: { dueAt: task.dueAt, assignee: personName(task.assigneeId), provenance: upstreamProvenance(x) } });
  x.log(`Task "${task.title}" → ${personName(task.assigneeId)}${task.dueAt ? `, due ${task.dueAt}` : ""}`);
  return { output: { taskId: task.id, title: task.title, dueAt: task.dueAt, assigneeId: task.assigneeId, assignee: personName(task.assigneeId), href: href("task", task.id), created: true } };
};

const actionCreateEvent: Executor = async (x) => {
  assertTrusted(x, "Calendar event creation");
  const c = resolveConfig(x);
  const title = str(c.title).trim();
  if (!title) throw new StepError("Event title is empty.", "empty_title");
  const start = resolveDateRule(c.startsAt) ?? new Date(Date.now() + 86_400_000);
  const evMatter = c.matterId ? str(c.matterId) : x.run.matterId;
  const sameDay = db().events.find((e) => (e.matterId ?? "") === (evMatter ?? "") && e.startsAt.slice(0, 10) === start.toISOString().slice(0, 10));
  const dupEvent = findNearDuplicateEvent(sameDay.map((e) => ({ id: e.id, date: e.startsAt, title: e.title })), { date: start.toISOString(), title });
  if (dupEvent && c.allowDuplicate !== true) {
    const ex = db().events.get(dupEvent.id)!;
    x.log(`Event "${ex.title}" already on the calendar for ${ex.startsAt.slice(0, 10)} (${ex.id}); not creating a duplicate`);
    audit("ai.verify", { kind: "event", id: ex.id, label: ex.title, matterId: ex.matterId }, { method: "dedupe", runId: x.run.id, nodeId: x.node.id, requestedTitle: title });
    x.artifact({ kind: "event", id: ex.id, title: ex.title, href: href("event", ex.id), meta: { startsAt: ex.startsAt, kind: ex.kind, duplicateOf: ex.id } });
    return { output: { eventId: ex.id, title: ex.title, startsAt: ex.startsAt, kind: ex.kind, href: href("event", ex.id), duplicateOf: ex.id, created: false } };
  }
  const duration = num(c.durationMinutes, 60);
  const end = new Date(start.getTime() + duration * 60_000);
  const attendeeIds = (Array.isArray(c.attendeeIds) ? (c.attendeeIds as unknown[]).map(str) : []).filter((id) => db().people.has(id));
  const ev: CalendarEvent = {
    id: `ev_${nanoid(10)}`,
    title: title.slice(0, 200),
    matterId: c.matterId ? str(c.matterId) : x.run.matterId,
    startsAt: start.toISOString(),
    endsAt: duration > 0 ? end.toISOString() : undefined,
    allDay: duration === 0,
    kind: (["deadline", "hearing", "deposition", "meeting", "filing", "internal", "cle", "other"].includes(str(c.kind)) ? str(c.kind) : "other") as CalendarEvent["kind"],
    location: c.location ? str(c.location) : undefined,
    attendeeIds: attendeeIds.length ? attendeeIds : [x.run.triggeredById ?? WORKFLOW_CURRENT_USER.id],
    notes: c.notes ? `${str(c.notes)}\n\nCreated by workflow "${x.workflow.name}" (run ${x.run.id}).` : `Created by workflow "${x.workflow.name}" (run ${x.run.id}).`,
    ruleSource: c.ruleSource ? str(c.ruleSource) : undefined,
  };
  db().events.put(ev);
  audit("create", { kind: "event", id: ev.id, label: ev.title, matterId: ev.matterId }, { source: "workflow", runId: x.run.id, nodeId: x.node.id });
  x.artifact({ kind: "event", id: ev.id, title: ev.title, href: href("event", ev.id), meta: { startsAt: ev.startsAt, kind: ev.kind, provenance: upstreamProvenance(x) } });
  x.log(`Event "${ev.title}" on ${ev.startsAt.slice(0, 16).replace("T", " ")}`);
  return { output: { eventId: ev.id, title: ev.title, startsAt: ev.startsAt, kind: ev.kind, href: href("event", ev.id), created: true } };
};

/** Build a workbook content model from rows (array of objects / arrays), CSV or a Markdown table. */
/** Build the Sheet editor's workbook model from rows (array of objects/arrays, JSON, markdown table or CSV text). */
export function workbookFromRows(sheetName: string, rowsInput: unknown) {
  const t = tableFromRows(sheetName, rowsInput);
  const sheet = t.sheets[0];
  return workbookFromTable(sheet.name, sheet.header, sheet.rows.slice(1));
}

export function tableFromRows(sheetName: string, rowsInput: unknown): { version: number; sheets: { name: string; columns: { key: string; title: string; width: number }[]; rows: unknown[][]; header: string[] }[] } {
  let rows: unknown[] = [];
  if (Array.isArray(rowsInput)) rows = rowsInput;
  else if (typeof rowsInput === "string") {
    const t = rowsInput.trim();
    if (t.startsWith("[")) { try { rows = JSON.parse(t); } catch { rows = []; } }
    else if (t.startsWith("|")) {
      const lines = t.split("\n").filter((l) => l.trim().startsWith("|"));
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());
      const header = cells(lines[0]);
      rows = lines.slice(1).filter((l) => !/^\|?\s*:?-{2,}/.test(l)).map((l) => Object.fromEntries(cells(l).map((v, i) => [header[i] ?? `col${i + 1}`, v])));
    } else if (t) {
      const lines = t.split("\n").filter(Boolean);
      const parse = (l: string) => { const out: string[] = []; let cur = ""; let q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()); };
      const header = parse(lines[0]);
      rows = lines.slice(1).map((l) => Object.fromEntries(parse(l).map((v, i) => [header[i] ?? `col${i + 1}`, v])));
    }
  }
  const objs = rows.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null));
  const header = objs.every(Boolean)
    ? Array.from(objs.reduce((s, o) => { Object.keys(o!).forEach((k) => s.add(k)); return s; }, new Set<string>()))
    : Array.from({ length: Math.max(0, ...rows.map((r) => (Array.isArray(r) ? r.length : 1))) }, (_, i) => `Column ${i + 1}`);
  const data = rows.map((r) => (Array.isArray(r) ? r : r && typeof r === "object" ? header.map((h) => { const v = (r as Record<string, unknown>)[h]; return v != null && typeof v === "object" ? JSON.stringify(v) : (v ?? ""); }) : [r]));
  return { version: 1, sheets: [{ name: sheetName.slice(0, 31) || "Sheet1", header, columns: header.map((h) => ({ key: h, title: h.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()), width: Math.min(60, Math.max(12, h.length + 6)) })), rows: [header, ...data] }] };
}

const actionSaveDocument: Executor = async (x) => {
  assertTrusted(x, "Saving the document");
  const c = resolveConfig(x);
  const kind = c.kind === "sheet" ? "sheet" : "word";
  const title = str(c.title).trim() || `${x.workflow.name} — ${new Date().toISOString().slice(0, 10)}`;
  const matterId = c.matterId ? str(c.matterId) : x.run.matterId;
  let content: unknown;
  if (kind === "word") {
    const md = str(c.content);
    if (!md.trim()) throw new StepError("Document content is empty.", "empty_content");
    content = markdownToDoc(md.startsWith("#") ? md : md, md.startsWith("#") ? {} : { title });
  } else {
    const rowsRaw = c.rows ?? c.content;
    const table = tableFromRows(title, rowsRaw).sheets[0];
    if (table.rows.length <= 1) throw new StepError("Rows resolved to an empty table.", "empty_content");
    x.log(`${table.rows.length - 1} row(s), ${table.header.length} column(s)`);
    content = workbookFromTable(table.name, table.header, table.rows.slice(1));
  }
  // Provenance of the AI steps that fed this document travels with it (TrustBadge on the office doc / library item).
  const trust = upstreamTrust(x);
  const stepProvenance = trust.map((t) => t.provenance).filter((p): p is Provenance => !!p);
  const docProvenance: Provenance | undefined = stepProvenance.length ? { ...stepProvenance[stepProvenance.length - 1], surface: "workflow.document", sources: stepProvenance.flatMap((p) => p.sources).slice(0, 60) } : undefined;
  const bodyHash = contentHash(typeof content === "string" ? content : JSON.stringify(content));
  const twin = db().officeDocs.findOne((o) => o.kind === kind && (o.matterId ?? "") === (matterId ?? "") && (o.meta?.contentHash === bodyHash));
  if (twin && c.allowDuplicate !== true) {
    x.log(`Identical ${kind === "sheet" ? "workbook" : "document"} already saved as "${twin.title}" (${twin.id}); reusing it`);
    audit("ai.verify", { kind: "officeDoc", id: twin.id, label: twin.title, matterId: twin.matterId }, { method: "dedupe", runId: x.run.id, nodeId: x.node.id });
    const link = href("document", twin.id, kind);
    x.artifact({ kind: "document", id: twin.id, title: twin.title, href: link, meta: { kind, duplicateOf: twin.id } });
    return { output: { docId: twin.id, kind, title: twin.title, href: link, size: twin.size, duplicateOf: twin.id, created: false, provenance: docProvenance } };
  }
  const doc = createOfficeDoc({ kind, title, content, matterId: matterId || undefined, tags: Array.isArray(c.tags) ? (c.tags as unknown[]).map(str) : ["workflow"], meta: { source: "workflow", workflowId: x.workflow.id, runId: x.run.id, nodeId: x.node.id, contentHash: bodyHash, provenance: docProvenance } });
  audit("create", { kind: "officeDoc", id: doc.id, label: doc.title, matterId: doc.matterId }, { source: "workflow", runId: x.run.id, nodeId: x.node.id, kind, provenance: docProvenance ? { surface: docProvenance.surface, verification: docProvenance.verification?.status, confidence: docProvenance.confidence } : undefined });
  let libraryItemId: string | undefined;
  if (c.addToLibrary !== false) {
    const now = new Date().toISOString();
    const item: LibraryItem = { id: `lib_${nanoid(10)}`, parentId: null, name: doc.title, type: kind === "sheet" ? "xlsx" : "docx", matterId: doc.matterId, officeDocId: doc.id, createdAt: now, updatedAt: now, size: doc.size, ownerId: WORKFLOW_CURRENT_USER.id, sharedWith: ["matter-team"], tags: doc.tags, description: `Generated by workflow "${x.workflow.name}"`, status: "draft" };
    db().library.put(item);
    libraryItemId = item.id;
    x.artifact({ kind: "library", id: item.id, title: item.name, href: href("library", item.id), meta: { provenance: docProvenance } });
  }
  const link = href("document", doc.id, kind);
  x.artifact({ kind: "document", id: doc.id, title: doc.title, href: link, meta: { kind, provenance: docProvenance } });
  x.deliver({ kind: "document", format: kind === "sheet" ? "xlsx" : "docx", title: doc.title, href: link, docId: doc.id, libraryItemId, matterId: doc.matterId, size: doc.size, meta: { provenance: docProvenance, source: "action.save_document" } });
  x.log(`Saved ${kind === "sheet" ? "workbook" : "document"} "${doc.title}"`);
  return { output: { docId: doc.id, kind, title: doc.title, href: link, libraryItemId, size: doc.size, created: true, provenance: docProvenance } };
};

const actionNotify: Executor = async (x) => {
  const c = resolveConfig(x);
  const message = str(c.message).trim();
  if (!message) throw new StepError("Message is empty.", "empty_content");
  const recipients = (Array.isArray(c.recipientIds) ? (c.recipientIds as unknown[]).map(str) : []).filter((id) => db().people.has(id));
  const now = new Date().toISOString();
  const update: TeamUpdate = {
    id: `tu_${nanoid(10)}`,
    authorId: x.run.triggeredById ?? WORKFLOW_CURRENT_USER.id,
    body: `${message}${recipients.length ? `\n\ncc: ${recipients.map(personName).join(", ")}` : ""}`,
    matterId: c.matterId ? str(c.matterId) : x.run.matterId,
    createdAt: now,
    kind: (["update", "win", "announcement", "question"].includes(str(c.kind)) ? str(c.kind) : "update") as TeamUpdate["kind"],
    attachments: [{ label: `Workflow run · ${x.workflow.name}`, href: `/workflows/runs/${x.run.id}` }],
  };
  db().updates.put(update);
  const notif = { id: `wn_${nanoid(10)}`, runId: x.run.id, workflowId: x.workflow.id, nodeId: x.node.id, channel: "in-app", recipientIds: recipients, message, createdAt: now, read: false, updateId: update.id };
  db().collection<typeof notif>("workflow_notifications").put(notif);
  x.artifact({ kind: "notification", id: notif.id, title: message.split("\n")[0].slice(0, 80), href: "/", meta: { recipients: recipients.map(personName) } });
  x.log(`Notified ${recipients.length ? recipients.map(personName).join(", ") : "the team"}`);
  return { output: { notificationId: notif.id, updateId: update.id, recipients, channel: "in-app" } };
};

export function toCsv(v: unknown): string {
  const rows = Array.isArray(v) ? v : typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : null;
  if (!Array.isArray(rows)) return str(v);
  const wb = tableFromRows("export", rows);
  const esc = (c: unknown) => { const s = c == null ? "" : typeof c === "object" ? JSON.stringify(c) : String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return wb.sheets[0].rows.map((r) => r.map(esc).join(",")).join("\n");
}

const actionExport: Executor = async (x) => {
  const c = resolveConfig(x);
  const format = str(c.format) || "markdown";
  const source = c.source;
  const ext = { markdown: "md", json: "json", csv: "csv", text: "txt" }[format] ?? "txt";
  const mime = { markdown: "text/markdown", json: "application/json", csv: "text/csv", text: "text/plain" }[format] ?? "text/plain";
  const body = format === "json" ? JSON.stringify(source ?? null, null, 2) : format === "csv" ? toCsv(source) : str(source);
  if (!body.trim()) throw new StepError("Nothing to export.", "empty_content");
  const base = (str(c.filename).trim() || `${x.workflow.name}-${Date.now()}`).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
  const filename = base.endsWith(`.${ext}`) ? base : `${base}.${ext}`;
  const rec = db().blobs.put(new TextEncoder().encode(body), mime, { name: filename, meta: { workflowId: x.workflow.id, runId: x.run.id, nodeId: x.node.id } });
  const url = href("file", rec.id)!;
  let libraryItemId: string | undefined;
  if (c.addToLibrary !== false) {
    const now = new Date().toISOString();
    const item: LibraryItem = { id: `lib_${nanoid(10)}`, parentId: null, name: filename, type: format === "markdown" || format === "text" ? "note" : "link", matterId: c.matterId ? str(c.matterId) : x.run.matterId, createdAt: now, updatedAt: now, size: rec.size, ownerId: WORKFLOW_CURRENT_USER.id, sharedWith: ["matter-team"], tags: ["workflow", "export"], url, content: format === "markdown" || format === "text" ? body.slice(0, 200_000) : undefined, description: `Exported by workflow "${x.workflow.name}"` };
    db().library.put(item);
    libraryItemId = item.id;
  }
  x.artifact({ kind: "file", id: rec.id, title: filename, href: url, meta: { size: rec.size, format } });
  x.deliver({ kind: "file", format: ext, title: filename, downloadHref: url, blobId: rec.id, libraryItemId, matterId: c.matterId ? str(c.matterId) : x.run.matterId, mime, size: rec.size, meta: { source: "action.export" } });
  x.log(`Exported ${filename} (${rec.size.toLocaleString()} bytes)`);
  return { output: { blobId: rec.id, url, size: rec.size, filename, format, libraryItemId } };
};

const actionUpdateCoding: Executor = async (x) => {
  const c = resolveConfig(x);
  // Coding from AI output only applies when the AI step is trusted; otherwise the suggestion is written to the
  // reviewer notes with a NEEDS REVIEW marker and nothing else changes (no pause: the reviewer sees it in the queue).
  const trust = upstreamTrust(x);
  const untrusted = trust.filter((t) => !t.trusted);
  const overrides = new Set(((x.run as WorkflowRunRecord & RunTrustState).trustOverrides ?? []));
  const suggestionOnly = untrusted.length > 0 && c.requireTrusted !== false && !overrides.has(x.node.id);
  if (suggestionOnly) x.log(`Untrusted AI input (${untrusted.map((t) => `${t.label ?? t.id}: ${t.reason}`).join("; ")}) — writing suggestions to notes for review instead of coding`);
  const docsRaw = c.documents;
  const ids = (Array.isArray(docsRaw) ? docsRaw : str(docsRaw).split(/[,\n]/)).map((v) => (v && typeof v === "object" ? String((v as Record<string, unknown>).id ?? (v as Record<string, unknown>).bates ?? "") : String(v ?? ""))).map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new StepError("No documents resolved.", "empty_content");
  const field = str(c.field);
  const valueRaw = c.value;
  const now = new Date().toISOString();
  const updated: string[] = [];
  const skipped: string[] = [];
  const d = db();
  for (const key of ids) {
    const doc = d.edocs.get(key) ?? d.edocs.findOne((e) => e.bates.toLowerCase() === key.toLowerCase());
    if (!doc) { skipped.push(key); continue; }
    if (suggestionOnly) {
      const before = doc.coding;
      d.edocs.update(doc.id, (cur) => ({ ...cur, coding: { ...cur.coding, notes: `${cur.coding.notes ? cur.coding.notes + "\n" : ""}[${now.slice(0, 10)}] NEEDS REVIEW — workflow "${x.workflow.name}" suggests ${field} = ${str(valueRaw)} (${untrusted.map((t) => t.reason).join("; ")})${c.note ? ` · ${str(c.note)}` : ""}` } }));
      audit("coding.change", { kind: "edoc", id: doc.id, label: doc.bates, matterId: doc.matterId }, { source: "workflow", runId: x.run.id, nodeId: x.node.id, applied: false, needsReview: true, field, value: valueRaw, before: before.notes });
      updated.push(doc.id);
      continue;
    }
    const before = doc.coding;
    d.edocs.update(doc.id, (cur) => {
      const coding = { ...cur.coding, reviewerId: WORKFLOW_CURRENT_USER.id, reviewedAt: now };
      switch (field) {
        case "responsive": coding.responsive = bool(valueRaw); break;
        case "privileged": coding.privileged = bool(valueRaw); if (coding.privileged && !coding.privilegeBasis) coding.privilegeBasis = "attorney-client"; break;
        case "hot": coding.hot = bool(valueRaw); break;
        case "confidentiality": { const v = str(valueRaw).toLowerCase(); coding.confidentiality = (["public", "confidential", "highly confidential", "aeo"].includes(v) ? (v === "aeo" ? "AEO" : v) : "confidential") as EDocument["coding"]["confidentiality"]; break; }
        case "issues": coding.issues = Array.from(new Set([...(coding.issues ?? []), ...(Array.isArray(valueRaw) ? (valueRaw as unknown[]).map(str) : str(valueRaw).split(",")).map((s) => s.trim()).filter(Boolean)])); break;
        case "notes": coding.notes = `${coding.notes ? coding.notes + "\n" : ""}${str(valueRaw)}`; break;
        default: throw new StepError(`Unknown coding field "${field}".`, "bad_field");
      }
      if (c.note) coding.notes = `${coding.notes ? coding.notes + "\n" : ""}[${now.slice(0, 10)}] ${str(c.note)}`;
      return { ...cur, coding };
    });
    audit("coding.change", { kind: "edoc", id: doc.id, label: doc.bates, matterId: doc.matterId }, { source: "workflow", runId: x.run.id, nodeId: x.node.id, applied: true, field, value: valueRaw, before: (before as Record<string, unknown>)[field], trusted: trust.map((t) => ({ id: t.id, trusted: t.trusted })) });
    updated.push(doc.id);
  }
  x.artifact({ kind: "coding", id: x.node.id, title: suggestionOnly ? `${updated.length} document(s) flagged NEEDS REVIEW (${field} = ${str(valueRaw)})` : `${updated.length} document(s) coded ${field} = ${str(valueRaw)}`, href: x.run.matterId ? `/ediscovery?matter=${x.run.matterId}` : "/ediscovery", meta: { needsReview: suggestionOnly } });
  x.log(`${suggestionOnly ? "Flagged" : "Updated"} ${updated.length}, skipped ${skipped.length}`);
  return { output: { updated: suggestionOnly ? 0 : updated.length, flaggedForReview: suggestionOnly ? updated.length : 0, needsReview: suggestionOnly, documentIds: updated, skipped, field, value: valueRaw, trust } };
};

// ───────────── Integrity: verify, dedupe, trust review ─────────────

function asSources(v: unknown): VerifySource[] {
  if (v == null) return [];
  if (typeof v === "string") return v.trim() ? [{ title: "Sources", text: v.slice(0, 40_000) }] : [];
  if (Array.isArray(v)) return v.slice(0, 24).map((item, i) => { if (typeof item === "string") return { title: `Source ${i + 1}`, text: item.slice(0, 8000) }; const o = (item ?? {}) as Record<string, unknown>; const text = String(o.text ?? o.passage ?? o.content ?? o.snippet ?? JSON.stringify(o)); return { title: String(o.subject ?? o.title ?? o.name ?? o.case_name ?? `Source ${i + 1}`), cite: o.bates ? String(o.bates) : o.cite ? String(o.cite) : undefined, url: o.url ? String(o.url) : undefined, text: text.slice(0, 8000) }; });
  if (typeof v === "object") { const o = v as Record<string, unknown>; if (typeof o.text === "string") return [{ title: String(o.title ?? "Sources"), text: o.text.slice(0, 40_000) }]; if (Array.isArray(o.results)) return asSources(o.results); return [{ title: "Sources", text: JSON.stringify(o).slice(0, 40_000) }]; }
  return [];
}

const aiVerify: Executor = async (x) => {
  const c = resolveConfig(x);
  const output = c.output;
  const sources = asSources(c.sources);
  const stepId = c.stepId ? str(c.stepId) : referencedStepIds(x.config.output)[0];
  const stepOutput = stepId ? (x.ctx.steps?.[stepId]?.output as Record<string, unknown> | undefined) : undefined;
  const prior = stepProvenanceOf(stepOutput) ?? makeProvenance({ surface: `workflow.${x.node.type}`, sources: [] });
  if (output == null || (typeof output === "string" && !output.trim())) throw new StepError("Nothing to verify: the output template resolved to an empty value.", "empty_source");
  if (!sources.length) throw new StepError("No sources to verify against.", "empty_source");
  const mode = str(c.mode) === "structured" || (typeof output === "object" && output !== null) ? "structured" : "claims";
  const cites = extractRecordCites(sources.map((s) => `${s.cite ?? ""} ${s.text}`).join("\n"));
  let provenance: Provenance = { ...prior, sources: prior.sources.length ? prior.sources : sources.map((s) => ({ kind: (s.cite && /^[A-Z]{2,}[-_]\d{4,}/.test(s.cite) ? "document" : s.url ? "web" : "internal") as ProvenanceSource["kind"], cite: s.cite, url: s.url, title: s.title })) };
  let result: Record<string, unknown>;
  if (mode === "structured") {
    const rows = typeof output === "string" ? (() => { try { return JSON.parse(output); } catch { return output; } })() : output;
    const schema = Array.isArray(rows) ? { type: "array", items: { type: "object", properties: {}, additionalProperties: true } } : { type: "object", properties: {}, additionalProperties: true };
    const evidence = sources.map((s) => `[${s.cite ?? s.title ?? "source"}]\n${s.text}`).join("\n\n");
    const checked = await verifyStructuredStep(x, provenance, "structured output", rows, evidence, schema);
    const citeText = JSON.stringify(checked.output);
    const check = crossCheckCitations(citeText, { bates: cites.bates, pageLines: cites.pageLines });
    provenance = gateReview(applyCiteCheck(checked.provenance, check));
    const v = provenance.verification!;
    result = { status: v.status, trusted: isTrusted(provenance), reason: trustReason(provenance), supported: v.supported, unsupported: v.unsupported, contradicted: v.contradicted, score: v.supported + v.unsupported ? Number((v.supported / (v.supported + v.unsupported)).toFixed(2)) : 0, unresolvedCites: check.unresolved, verdicts: [], corrected: checked.output, changes: checked.changes, mode };
  } else {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const check = crossCheckCitations(text, { bates: cites.bates, pageLines: cites.pageLines });
    const v = await safeVerifyClaims({ answer: text, sources, verify: x.config.verify !== false, signal: x.signal, maxClaims: num(c.maxClaims, 25) });
    provenance = applyVerification(applyCiteCheck(provenance, check), v, "claims");
    provenance = gateReview({ ...provenance, verification: provenance.verification ? { ...provenance.verification, unresolvedCites: check.unresolved } : provenance.verification });
    if (v.verdicts.length) audit("ai.verify", { kind: "workflow.step", id: `${x.run.id}:${stepId ?? x.node.id}`, label: `${x.workflow.name} › ${x.node.label}`, matterId: x.run.matterId }, { method: "claims", status: v.status, supported: v.supported, unsupported: v.unsupported, contradicted: v.contradicted, score: Number(v.score.toFixed(2)), error: v.error });
    result = { status: v.status, trusted: isTrusted(provenance), reason: v.error && v.error !== "skipped" ? `verification did not run (${v.error})` : trustReason(provenance), supported: v.supported, unsupported: v.unsupported, contradicted: v.contradicted, score: Number(v.score.toFixed(2)), unresolvedCites: check.unresolved, verdicts: v.verdicts.slice(0, 60), corrected: check.text, changes: [], mode, error: v.error };
  }
  // The verified step's own provenance is updated so later trust gates see the verdict.
  if (stepId && stepOutput && stepProvenanceOf(stepOutput)) { const key = stepOutput._provenance !== undefined ? "_provenance" : "provenance"; stepOutput[key] = provenance; putProvenance({ kind: "workflow.step", recordId: `${x.run.id}:${stepId}`, matterId: x.run.matterId, title: `${x.workflow.name} › ${stepId}`, href: `/workflows/runs/${x.run.id}`, provenance }); }
  storeStepProvenance(x, provenance);
  x.log(`${String(result.status)}: ${result.supported} supported, ${result.unsupported} unsupported, ${result.contradicted} contradicted${(result.unresolvedCites as string[]).length ? `; ${(result.unresolvedCites as string[]).length} unresolved cite(s)` : ""} → ${result.trusted ? "trusted" : "not trusted"}`);
  return { output: { ...result, verifiedStep: stepId, provenance } };
};

const dataDedupe: Executor = async (x) => {
  const c = resolveConfig(x);
  const raw = c.items;
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim().startsWith("[") ? (() => { try { return JSON.parse(raw) as unknown[]; } catch { return []; } })() : typeof raw === "string" && raw.trim() ? raw.split(/\r?\n/).filter(Boolean) : [];
  const collection = str(c.collection) || "self";
  const keyFields = str(c.keyFields).split(",").map((k) => k.trim()).filter(Boolean);
  const matterId = c.matterId ? str(c.matterId) : x.run.matterId;
  const d = db();
  const seen = new Set<string>();
  const kept: unknown[] = [];
  const droppedItems: { item: unknown; duplicateOf: string; reason: string }[] = [];
  const hashes: string[] = [];
  const field = (item: unknown, names: string[]) => { if (!item || typeof item !== "object") return ""; const o = item as Record<string, unknown>; for (const n of names) if (o[n] != null && o[n] !== "") return String(o[n]); return ""; };
  for (const item of items) {
    const h = itemHash(item, keyFields);
    if (seen.has(h)) { droppedItems.push({ item, duplicateOf: `list#${h.slice(0, 8)}`, reason: "repeated in the list" }); continue; }
    let dup: { id: string; reason: string } | null = null;
    if (collection === "timeline" && typeof item === "object" && item) {
      const date = field(item, ["date", "startsAt"]).slice(0, 10), title = field(item, ["title", "event", "name", "text"]);
      if (date && title) { const hit = findNearDuplicateEvent(d.timeline.find((e) => e.matterId === matterId), { date, title, sources: [{ bates: field(item, ["bates", "source", "cite"]) }] }); if (hit) dup = { id: hit.id, reason: `matches timeline event "${hit.title}" (${hit.date})` }; }
    } else if (collection === "conflicts" && typeof item === "object" && item) {
      const title = field(item, ["title", "name"]);
      const hit = title ? d.conflicts.find((k) => k.matterId === matterId).find((k) => tokenSimilarity(k.title, title) >= 0.75) : null;
      if (hit) dup = { id: hit.id, reason: `matches conflict "${hit.title}"` };
    } else if (collection === "tasks") {
      const title = typeof item === "string" ? item : field(item, ["title", "name", "text"]);
      const hit = title ? findNearDuplicateTask(d.tasks.find((t) => t.status !== "done"), { title, matterId: matterId ?? undefined }) : null;
      if (hit) dup = { id: hit.id, reason: `open task "${hit.title}"` };
    } else if (collection === "edocs" && typeof item === "object" && item) {
      const bates = field(item, ["bates", "id"]).toUpperCase();
      const text = field(item, ["text", "passage"]);
      const hit = d.edocs.find((e) => !matterId || e.matterId === matterId).find((e) => e.bates.toUpperCase() === bates || (text.length > 80 && (e.hash ?? contentHash(e.text)) === contentHash(text)));
      if (hit) dup = { id: hit.id, reason: `document ${hit.bates} already in the review set` };
    } else if (collection === "library") {
      const name = typeof item === "string" ? item : field(item, ["name", "title", "filename"]);
      const hit = name ? d.library.find((l) => l.type !== "folder" && (!matterId || l.matterId === matterId)).find((l) => normalizeTitle(l.name) === normalizeTitle(name)) : null;
      if (hit) dup = { id: hit.id, reason: `library item "${hit.name}"` };
    }
    if (dup) { droppedItems.push({ item, duplicateOf: dup.id, reason: dup.reason }); continue; }
    seen.add(h);
    hashes.push(h);
    kept.push(item);
  }
  if (droppedItems.length) audit("ai.verify", { kind: "workflow.step", id: `${x.run.id}:${x.node.id}`, label: `${x.workflow.name} › ${x.node.label}`, matterId }, { method: "dedupe", collection, dropped: droppedItems.length, kept: kept.length, reasons: droppedItems.slice(0, 10).map((r) => r.reason) });
  x.log(`${kept.length} kept, ${droppedItems.length} dropped (${collection})`);
  return { output: { items: kept, kept: kept.length, dropped: droppedItems.length, droppedItems: droppedItems.slice(0, 200), hashes, collection } };
};

const logicReview: Executor = async (x) => {
  const c = resolveConfig(x);
  const ids = str(c.steps).split(",").map((s) => s.trim()).filter(Boolean);
  const overrides = new Set(((x.run as WorkflowRunRecord & RunTrustState).trustOverrides ?? []));
  const trust = upstreamTrust(x, { stepIds: ids.length ? ids : undefined, minConfidence: c.minConfidence != null && c.minConfidence !== "" ? num(c.minConfidence, CONFIDENCE_GATE) : undefined });
  const bad = trust.filter((t) => !t.trusted);
  // "Always ask a person": no automatic pass, however the steps verified (high-risk output such as dates and tasks).
  const requireHuman = bool(c.requireHuman);
  if (overrides.has(x.node.id) || (!bad.length && !requireHuman)) {
    const steps = trust.map(({ provenance: _p, ...rest }) => { void _p; return rest; });
    x.log(overrides.has(x.node.id) ? (bad.length ? `Gate lifted by reviewer for ${bad.map((t) => t.label ?? t.id).join(", ")}` : "Approved by reviewer") : `All ${trust.length} AI step(s) trusted`);
    return { output: { trusted: true, approved: true, reasons: [], steps, decidedBy: overrides.has(x.node.id) ? "reviewer" : "automatic", comment: "" } };
  }
  const reasons = bad.map((t) => `"${t.label ?? t.id}": ${t.reason}`);
  if (requireHuman) {
    // Approving lifts the gate for every reviewed step (the engine records them as vouched for by the reviewer).
    const note = str(c.message).trim();
    const status = bad.length ? `${bad.length} of ${trust.length} AI step${trust.length > 1 ? "s" : ""} did not verify — ${reasons.join("; ")}` : trust.length ? `${trust.length} AI step${trust.length === 1 ? "" : "s"} verified; a person must still confirm before the workflow acts.` : "A person must confirm before the workflow acts.";
    throw new TrustGateError(`${note ? `${note}\n\n` : ""}${status}`, bad.length ? reasons : ["A person must confirm this output before the workflow acts on it."], trust.map((t) => t.id));
  }
  throw new TrustGateError(`${bad.length} of ${trust.length} AI step${trust.length > 1 ? "s" : ""} failed the trust review — ${reasons.join("; ")}`, reasons, bad.map((t) => t.id));
};

const notDirect = (what: string): Executor => async () => { throw new StepError(`${what} is executed by the engine, not as a plain step.`, "engine_only"); };
/** Placeholder until the node type's executor lands (the registry does not expose the type yet, so no workflow can reach it). */
const notImplemented = (type: string): Executor => async () => { throw new StepError(`Node type "${type}" is not available yet.`, "not_implemented"); };

export const EXECUTORS: Record<AnyNodeType, Executor> = {
  "trigger.manual": trigger,
  "trigger.schedule": trigger,
  "trigger.document_added": trigger,
  "trigger.docket_update": trigger,
  "trigger.email": trigger,
  "ai.prompt": aiPrompt,
  "ai.extract": aiExtract,
  "ai.classify": aiClassify,
  "ai.summarize": aiSummarize,
  "ai.draft": aiDraft,
  "ai.review": aiReview,
  "ai.research": aiResearch,
  "data.search_library": dataSearchLibrary,
  "data.search_ediscovery": dataSearchEdiscovery,
  "data.fetch_url": dataFetchUrl,
  "data.legal_search": dataLegalSearch,
  "logic.branch": logicBranch,
  "logic.loop": notDirect("Loop"),
  "logic.merge": logicMerge,
  "logic.approval": notDirect("Approval"),
  "logic.delay": logicDelay,
  "action.create_task": actionCreateTask,
  "action.create_event": actionCreateEvent,
  "action.save_document": actionSaveDocument,
  "action.notify": actionNotify,
  "action.export": actionExport,
  "action.update_coding": actionUpdateCoding,
  "ai.verify": aiVerify,
  "data.dedupe": dataDedupe,
  "logic.review": logicReview,
  "intel.fetch": notImplemented("intel.fetch"),
  "intel.extract": notImplemented("intel.extract"),
  "intel.index": notImplemented("intel.index"),
  "intel.entities": notImplemented("intel.entities"),
  "intel.analyze": notImplemented("intel.analyze"),
  "intel.verify": notImplemented("intel.verify"),
  "intel.publish": notImplemented("intel.publish"),
  "review.auto": notImplemented("review.auto"),
  "data.query": notImplemented("data.query"),
  "output.file": notImplemented("output.file"),
  "logic.schedule_after": notImplemented("logic.schedule_after"),
  "ai.route": notImplemented("ai.route"),
  "ai.agent": notImplemented("ai.agent"),
  "data.official_order": notImplemented("data.official_order"),
};

/** Plain-text digest helpers exposed to the engine for run outputs. */
export { markdownTable, extractPlainText, resolveTemplate };
