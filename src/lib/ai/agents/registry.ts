import "server-only";
import type { Tool } from "openai/resources/responses/responses";
import { runAgent, strictJsonSchema, type AgentEvent } from "../agent";
import { aiConfig } from "../config";
import { FIRM_NAME, LEGAL_STYLE_RULES, todayLine } from "../prompts";
import { defineTool, type ToolDef } from "../tools";
import { fetchUrlTool, INDIA_TOOLS, INTERNAL_TOOLS, LEGAL_TOOLS, webSearchTool } from "../toolkit";
import type { VerifySource } from "../verify";
import { audit } from "@/lib/integrity/audit";
import { searchIntel } from "@/modules/intel/store";
import type { IntelDocumentKind } from "@/modules/intel/types";
import { AGENT_PERSONAS, canHandoff, type AgentId, type AgentPersona, type AgentToolName, type HandoffRequest } from "./personas";
import { forumContextLine } from "@/modules/courts/context";
import type { IndianCaseInfo } from "@/modules/matters/india";

const matterForumLine = (m: Record<string, unknown>): string => { const line = forumContextLine(m.india as IndianCaseInfo | undefined); return line ? ` ${line}` : ""; };

export { AGENT_PERSONAS, AGENT_ORDER, agentPersona, canHandoff } from "./personas";
export type { AgentId, AgentPersona, AgentToolName, HandoffRequest } from "./personas";

/**
 * Platform agent registry: personas (./personas.ts) plus the runtime — the
 * toolsets they may use, the explicit `handoff` tool and `runPersona()`, a
 * wrapper over `runAgent` that assembles the instructions, records handoffs
 * and audits the generation under the persona id.
 */

const INTEL_KINDS: IntelDocumentKind[] = ["opinion", "docket", "docket_entry", "court_rule", "regulation", "register_notice", "recall", "adverse_event", "mdl", "judge", "attorney", "firm", "news", "local_file", "web_page", "statute", "expert"];

/** Hybrid search over the intelligence store (case law, dockets, rules, regulations, recalls, MDLs, judges, counsel, news, local files). */
export const searchIntelTool = defineTool<{ query: string; kinds?: string[]; matter_id?: string; court?: string; date_from?: string; date_to?: string; limit?: number }>({
  name: "search_intel",
  description: "Search the firm's intelligence store: ingested opinions, dockets and docket entries, court rules, regulations, Federal Register notices, FDA recalls, MDLs, judge and counsel profiles, news and local documents. Returns the best passages with document ids, citations and dates. Use document ids as evidence ids.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for" },
      kinds: { type: "array", items: { type: "string", enum: INTEL_KINDS }, description: "Restrict to document kinds" },
      matter_id: { type: "string", description: "Only documents linked to this matter" },
      court: { type: "string", description: "Court id or name fragment (e.g. dsc)" },
      date_from: { type: "string", description: "YYYY-MM-DD" },
      date_to: { type: "string", description: "YYYY-MM-DD" },
      limit: { type: "integer", description: "1–25 (default 8)" },
    },
    required: ["query"],
  },
  label: (a) => `Searching intelligence: ${a.query}`,
  async execute(args, ctx) {
    const hits = await searchIntel({ q: args.query, kinds: args.kinds?.filter((k): k is IntelDocumentKind => (INTEL_KINDS as string[]).includes(k)), matterId: args.matter_id, court: args.court, dateFrom: args.date_from, dateTo: args.date_to, limit: Math.max(1, Math.min(25, args.limit ?? 8)) });
    for (const h of hits.slice(0, 5)) ctx.emit({ type: "citation", citation: { title: h.doc.title, url: h.doc.url, cite: h.doc.citation ?? h.doc.docketNumber, source: h.doc.kind, snippet: h.chunk.text.slice(0, 200) } });
    return { count: hits.length, results: hits.map((h) => ({ id: h.doc.id, kind: h.doc.kind, title: h.doc.title, court: h.doc.court, citation: h.doc.citation, docket_number: h.doc.docketNumber, case_name: h.doc.caseName, date: h.doc.dates.decided ?? h.doc.dates.filed ?? h.doc.dates.published ?? h.doc.dates.event, url: h.doc.url, confidence: h.doc.confidence, flags: h.doc.flags.map((f) => f.kind), passage: h.chunk.text.slice(0, 1200), score: Number(h.score.toFixed(3)) })) };
  },
});

/** The explicit handoff tool: an agent asks the caller to route the brief to another persona. Recorded on run logs and in the audit trail by the caller. */
export function handoffTool(from: AgentId): ToolDef<{ to: string; brief: string; evidence_ids?: string[] }, { handoff: HandoffRequest }> {
  const targets = AGENT_PERSONAS[from]?.handoffs ?? [];
  return defineTool<{ to: string; brief: string; evidence_ids?: string[] }, { handoff: HandoffRequest }>({
    name: "handoff",
    description: `Hand the work to another agent (${targets.join(", ") || "none available"}) with a precise brief. Call it at most once, then finish your reply with one line naming the agent and the brief.`,
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", enum: targets.length ? targets : ["none"], description: "The agent to hand off to" },
        brief: { type: "string", description: "What the agent must do: goal, matter, constraints, deliverable" },
        evidence_ids: { type: "array", items: { type: "string" }, description: "Document, Bates or insight ids the agent should start from" },
      },
      required: ["to", "brief"],
    },
    label: (a) => `Handing off to ${a.to}`,
    execute(args, ctx) {
      const to = args.to as AgentId;
      if (!canHandoff(from, to)) return { handoff: { from, to, brief: `REFUSED: ${from} may not hand off to ${args.to}` } };
      const handoff: HandoffRequest = { from, to, brief: args.brief.slice(0, 4000), evidenceIds: args.evidence_ids?.slice(0, 50) };
      const list = (ctx.state.handoffs as HandoffRequest[] | undefined) ?? [];
      list.push(handoff);
      ctx.state.handoffs = list;
      ctx.emit({ type: "status", message: `Handoff → ${to}: ${handoff.brief.slice(0, 120)}` });
      return { handoff };
    },
  });
}

const NAMED_TOOLS: Record<string, ToolDef<never, unknown>> = Object.fromEntries([...LEGAL_TOOLS, ...INTERNAL_TOOLS, ...INDIA_TOOLS, fetchUrlTool, searchIntelTool].map((t) => [t.name, t as ToolDef<never, unknown>]));

/** Resolve tool names into runAgent tools (function tools + OpenAI built-ins). Unknown names are ignored. */
export function toolsFor(names: Iterable<AgentToolName | string>, opts: { from?: AgentId; webContextSize?: "low" | "medium" | "high" } = {}): { tools: ToolDef<never, unknown>[]; builtinTools: Tool[]; unknown: string[] } {
  const tools: ToolDef<never, unknown>[] = [];
  const builtinTools: Tool[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = String(raw);
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === "web_search") { builtinTools.push(webSearchTool({ contextSize: opts.webContextSize ?? "medium" })); continue; }
    if (name === "handoff") { if (opts.from && AGENT_PERSONAS[opts.from]?.handoffs.length) tools.push(handoffTool(opts.from) as ToolDef<never, unknown>); continue; }
    const t = NAMED_TOOLS[name];
    if (t) tools.push(t); else unknown.push(name);
  }
  return { tools, builtinTools, unknown };
}

export interface RunPersonaContext {
  matter?: Record<string, unknown> | null;
  user?: { id: string; name: string } | Record<string, unknown> | null;
  /** Free text appended to the instructions (evidence ids, constraints, run details). */
  extra?: string;
  runId?: string;
  nodeId?: string;
  workflowName?: string;
}

export interface RunPersonaOptions {
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  context?: RunPersonaContext;
  /** Extra tool names added to the persona's toolset. */
  tools?: (AgentToolName | string)[];
  /** Structured output for the final message. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxSteps?: number;
  /** Override the persona's model tier. */
  model?: "primary" | "fast";
  reasoningEffort?: AgentPersona["reasoningEffort"];
  metadata?: Record<string, string>;
  /** Shared state for tools (handoffs are collected under state.handoffs). */
  state?: Record<string, unknown>;
}

export interface RunPersonaResult {
  agent: AgentId;
  text: string;
  json?: unknown;
  usage: { input: number; output: number; total: number };
  steps: number;
  toolCalls: number;
  citations: { title: string; url?: string; cite?: string; source?: string }[];
  /** Tool results the agent read (evidence for verification). */
  evidence: VerifySource[];
  handoffs: HandoffRequest[];
  model: string;
  instructions: string;
  input: string;
}

/** Assemble the system instructions for a persona run. */
export function personaInstructions(persona: AgentPersona, context: RunPersonaContext = {}): string {
  const m = context.matter as Record<string, unknown> | null | undefined;
  const parts = [
    `You are the ${persona.name} agent of ${FIRM_NAME}'s legal AI platform. ${persona.purpose} ${todayLine()}`,
    persona.instructions,
    `Output contract: ${persona.outputContract}`,
    LEGAL_STYLE_RULES,
    m ? `Matter context: ${m.name} (${m.caption ?? m.shortName ?? ""}); client ${m.client ?? "n/a"} (${m.clientSide ?? "n/a"}); ${m.court ?? "no court"}; stage: ${m.stage ?? "n/a"}.${matterForumLine(m)}` : "No matter is attached to this request.",
    context.user && typeof context.user === "object" && "name" in context.user ? `Requested by ${(context.user as { name: string }).name}.` : "",
    context.workflowName ? `This run is a step of the workflow "${context.workflowName}"${context.nodeId ? ` (step ${context.nodeId})` : ""}; later steps consume your output verbatim.` : "",
    context.extra ?? "",
    "Never invent facts, citations or record cites. When you hand off, do it through the handoff tool, once.",
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Run a persona over an input with its toolset; records the audit event `ai.generate` under the persona id. */
export async function runPersona(personaOrId: AgentPersona | AgentId, input: string, opts: RunPersonaOptions = {}): Promise<RunPersonaResult> {
  const persona = typeof personaOrId === "string" ? AGENT_PERSONAS[personaOrId] : personaOrId;
  if (!persona) throw new Error(`Unknown agent persona "${String(personaOrId)}"`);
  const cfg = aiConfig();
  const tier = opts.model ?? persona.model;
  const model = tier === "fast" ? cfg.fastModel : cfg.model;
  const { tools, builtinTools } = toolsFor([...persona.tools, ...(opts.tools ?? [])], { from: persona.id });
  const instructions = personaInstructions(persona, opts.context);
  const citations: RunPersonaResult["citations"] = [];
  const evidence: VerifySource[] = [];
  let toolCalls = 0;
  const state: Record<string, unknown> = opts.state ?? {};
  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "tool.call": toolCalls++; break;
      case "tool.result":
        if (e.ok && e.result != null && e.name !== "handoff" && evidence.length < 24) { const text = typeof e.result === "string" ? e.result : JSON.stringify(e.result); if (text.length > 40) evidence.push({ title: `tool ${e.name}`, text: text.slice(0, 8000) }); }
        break;
      case "web_search": if (e.status === "completed") toolCalls++; break;
      case "citation": citations.push(e.citation); break;
      default: break;
    }
    opts.onEvent?.(e);
  };
  const res = await runAgent({
    instructions,
    input,
    model,
    tools,
    builtinTools,
    maxSteps: opts.maxSteps ?? persona.maxSteps,
    reasoningEffort: opts.reasoningEffort ?? (cfg.reasoningEffort === "none" ? "low" : persona.reasoningEffort),
    signal: opts.signal,
    state,
    jsonSchema: opts.jsonSchema ? { name: opts.jsonSchema.name, schema: strictJsonSchema(opts.jsonSchema.schema) } : undefined,
    metadata: { agent: persona.id, ...(opts.metadata ?? {}) },
    onEvent,
  });
  const handoffs = ((state.handoffs as HandoffRequest[] | undefined) ?? []).filter((h) => !h.brief.startsWith("REFUSED"));
  const seen = new Set<string>();
  const uniqueCitations = citations.filter((c) => { const k = c.url ?? c.cite ?? c.title; if (seen.has(k)) return false; seen.add(k); return true; });
  audit("ai.generate", { kind: "agent", id: persona.id, label: `${persona.name} agent${opts.context?.workflowName ? ` · ${opts.context.workflowName}` : ""}`, matterId: (opts.context?.matter as { id?: string } | null | undefined)?.id }, { persona: persona.id, model, tokens: res.usage.total, steps: res.steps, toolCalls, handoffs: handoffs.map((h) => ({ to: h.to, brief: h.brief.slice(0, 200) })), runId: opts.context?.runId, nodeId: opts.context?.nodeId, sources: uniqueCitations.slice(0, 10).map((c) => c.cite ?? c.url ?? c.title) });
  return { agent: persona.id, text: res.text, json: res.json, usage: res.usage, steps: res.steps, toolCalls, citations: uniqueCitations, evidence, handoffs, model, instructions, input };
}
