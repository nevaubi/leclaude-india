import "server-only";
import type { AgentEvent } from "@/lib/ai/agent";
import { AGENT_PERSONAS, runPersona, type AgentId } from "@/lib/ai/agents/registry";
import { contentHash } from "@/lib/integrity/hash";
import type { AnyNodeType } from "./registry";
import { StepError, callModel, clipToBudget, evidenceFor, firmPreamble, num, recordStep, resolveConfig, stepBudget, storeStepProvenance, str, verifyNarrativeStep, verifyStructuredStep, type Executor, type ModelResult } from "./executors";

/**
 * Agent steps: `ai.route` (the coordinator classifies the input against the
 * configured branches and records a handoff) and `ai.agent` (a persona runs
 * over a brief with its toolset; provenance is recorded like every AI step
 * and every handoff the agent makes lands on the run).
 */

interface RouteBranch { id: string; label?: string; description?: string; agent?: string }

const aiRoute: Executor = async (x) => {
  const c = resolveConfig(x);
  const input = str(c.input);
  if (!input.trim()) throw new StepError("Nothing to route: the input resolved to an empty string.", "empty_prompt");
  const branches = (Array.isArray(c.branches) ? (c.branches as RouteBranch[]) : []).filter((b) => b && typeof b === "object" && b.id);
  if (!branches.length) throw new StepError("No branches configured.", "no_branches");
  const persona = AGENT_PERSONAS.coordinator;
  const schema = {
    type: "object",
    properties: {
      branch: { type: "string", enum: [...branches.map((b) => b.id), "else"], description: "The branch that should handle the request, or else" },
      confidence: { type: "number", description: "0..1" },
      rationale: { type: "string", description: "One sentence quoting the decisive part of the request" },
      brief: { type: "string", description: "The brief for the specialist: goal, matter, constraints, deliverable" },
    },
    required: ["branch", "confidence", "rationale", "brief"],
  };
  const instructions = `${firmPreamble(x)}\n\n${persona.instructions}\n\nBranches:\n${branches.map((b) => `- ${b.id}: ${b.label ?? b.id}${b.description ? ` — ${b.description}` : ""}${b.agent ? ` (handled by the ${b.agent} agent)` : ""}`).join("\n")}\n- else: none of the above\n\nPick exactly one branch and write the brief the specialist will receive.${c.instructions ? `\nAdditional guidance: ${str(c.instructions)}` : ""}`;
  const tier = c.modelTier === "primary" ? "primary" : "fast";
  const r = await callModel(x, { instructions, input: `REQUEST:\n"""\n${clipToBudget(x, input, stepBudget("workflow_step", tier), "Request", { fixed: [instructions, JSON.stringify(schema)] })}\n"""`, tier, json: { name: "route", schema }, taskType: "route" });
  const j = (r.json ?? {}) as { branch?: string; confidence?: number; rationale?: string; brief?: string };
  const branch = branches.find((b) => b.id === j.branch);
  const matched = branch ? branch.id : "else";
  const confidence = Math.max(0, Math.min(1, num(j.confidence, 0)));
  const brief = str(j.brief).trim() || input.slice(0, 500);
  const handoff = branch?.agent ? x.handoff({ from: "coordinator", to: branch.agent, brief, meta: { branch: matched, confidence } }) : undefined;
  const provenance = storeStepProvenance(x, recordStep(x, r, { confidence, sources: [{ kind: "internal", title: "routed request", cite: contentHash(input).slice(0, 12) }], meta: { matched, agent: branch?.agent, persona: persona.id } }));
  x.log(`Routed to "${branch?.label ?? "Unmatched"}"${branch?.agent ? ` → ${branch.agent}` : ""} (${Math.round(confidence * 100)}%)`);
  return { output: { matched, label: branch?.label ?? "Unmatched", agent: branch?.agent ?? null, confidence, rationale: str(j.rationale), brief, handoff: handoff ?? null, _provenance: provenance }, usage: r.usage, calls: r.calls };
};

const aiAgent: Executor = async (x) => {
  const c = resolveConfig(x);
  const agentId = str(c.agent) as AgentId;
  const persona = AGENT_PERSONAS[agentId];
  if (!persona) throw new StepError(`Unknown agent "${agentId}".`, "bad_agent");
  const brief = str(c.brief);
  if (!brief.trim()) throw new StepError("The brief is empty.", "empty_prompt");
  const context = str(c.context);
  const wantsJson = c.output === "json";
  let schema: Record<string, unknown> | undefined;
  if (wantsJson) {
    const raw = c.jsonSchema;
    if (typeof raw === "string" && raw.trim()) { try { schema = JSON.parse(raw); } catch { throw new StepError("JSON schema is not valid JSON.", "bad_schema"); } }
    else if (raw && typeof raw === "object") schema = raw as Record<string, unknown>;
    else schema = { type: "object", properties: { result: { type: "string" } }, required: ["result"] };
  }
  const extraTools = Array.isArray(c.tools) ? (c.tools as unknown[]).map(String).filter(Boolean) : [];
  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "tool.call": x.progress(e.label); x.log(`tool: ${e.label}`); break;
      case "tool.result": if (!e.ok) x.log(`tool error: ${e.name}: ${e.error}`); break;
      case "web_search": if (e.status === "completed") x.log(`web search: ${e.query ?? "(query)"}`); break;
      case "status": x.log(e.message); break;
      case "step": if (e.step > 1) x.progress(`${persona.name} (step ${e.step})`); break;
      default: break;
    }
  };
  const tier = c.modelTier === "fast" ? "fast" : c.modelTier === "primary" ? "primary" : undefined;
  const agentBudget = stepBudget(persona.id === "drafter" ? "litigation_draft" : "workflow_agent", tier ?? persona.model);
  // The context takes at most half of the agent's input budget after its brief and instructions; the rest holds the
  // tool definitions and the results it reads.
  const input = `BRIEF:\n${brief}${context.trim() ? `\n\nCONTEXT:\n${clipToBudget(x, context, agentBudget, "Context", { fixed: [persona.instructions, brief] })}` : ""}`;
  const res = await runPersona(persona, input, { onEvent, signal: x.signal, context: { matter: x.ctx.matter, user: x.ctx.user as { id: string; name: string }, runId: x.run.id, nodeId: x.node.id, workflowName: x.workflow.name }, tools: extraTools, jsonSchema: schema ? { name: "agent_output", schema } : undefined, maxSteps: c.maxSteps != null && c.maxSteps !== "" ? num(c.maxSteps, persona.maxSteps) : undefined, model: tier, metadata: { workflowRunId: x.run.id, nodeId: x.node.id }, matterId: x.run.matterId ?? undefined, budget: agentBudget.profile });
  const handoffs = res.handoffs.map((h) => x.handoff({ from: h.from, to: h.to, brief: h.brief, evidenceIds: h.evidenceIds }));
  let json: unknown = res.json;
  if (wantsJson && json === undefined) { try { json = JSON.parse(res.text); } catch { throw new StepError("The agent did not return valid JSON for the requested schema.", "bad_json"); } }
  const r: ModelResult = { text: res.text, json, usage: res.usage, calls: 1 + res.steps, citations: res.citations, toolCalls: res.toolCalls, evidence: res.evidence, model: res.model, instructions: res.instructions, input: res.input };
  const sourceBacked = res.citations.length > 0 || res.evidence.length > 0;
  let provenance = recordStep(x, r, { surface: `workflow.ai.agent.${persona.id}`, meta: { persona: persona.id, toolCalls: res.toolCalls, handoffs: handoffs.map((h) => h.to) } });
  if (wantsJson && schema) {
    const third = Math.max(40_000, Math.floor(stepBudget("verify", "fast").totalEvidenceChars / 3));
    const checked = await verifyStructuredStep(x, provenance, `${persona.name} output`, json, `BRIEF:\n${brief.slice(0, third)}\n\nCONTEXT:\n${context.slice(0, third)}\n\n${res.evidence.map((e) => e.text).join("\n\n").slice(0, third)}`, schema);
    provenance = storeStepProvenance(x, checked.provenance);
    return { output: { agent: persona.id, ...(checked.output as Record<string, unknown>), json: checked.output, text: res.text, citations: res.citations, toolCalls: res.toolCalls, handoffs, sourceBacked, _provenance: provenance }, usage: res.usage, calls: r.calls };
  }
  const verified = await verifyNarrativeStep(x, provenance, res.text, evidenceFor(r, [{ title: "Brief", text: brief }, { title: "Context", text: context }]), { maxClaims: 30 });
  provenance = storeStepProvenance(x, verified.provenance);
  if (!sourceBacked) x.log("Not source-backed: the agent answered without reading any source.");
  if (handoffs.length) x.log(`Handoff → ${handoffs.map((h) => h.to).join(", ")}`);
  return { output: { agent: persona.id, text: verified.text, citations: res.citations, toolCalls: res.toolCalls, handoffs, sourceBacked, _provenance: provenance }, usage: res.usage, calls: r.calls };
};

export const AGENT_EXECUTORS: Partial<Record<AnyNodeType, Executor>> = {
  "ai.route": aiRoute,
  "ai.agent": aiAgent,
};
