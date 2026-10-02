import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/agents-registry-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
});

import { db, resetSqlite } from "@/lib/db";
import { AIConfigError } from "@/lib/ai/config";
import type { AgentEmit } from "@/lib/ai/tools";
import { AGENT_ORDER, AGENT_PERSONAS, agentPersona, canHandoff, handoffTool, personaInstructions, runPersona, searchIntelTool, toolsFor, type AgentId, type HandoffRequest } from "@/lib/ai/agents/registry";
import { WORKFLOW_AGENTS } from "@/modules/workflows/types";

beforeAll(() => { resetSqlite(); db(); });

const IDS: AgentId[] = ["coordinator", "research", "drafter", "reviewer", "coder", "analyst", "steward"];

describe("agent personas", () => {
  it("defines the seven personas with purpose, instructions, tools, tier, contract and step limits", () => {
    expect(AGENT_ORDER).toEqual(IDS);
    for (const id of IDS) {
      const p = AGENT_PERSONAS[id];
      expect(p.id).toBe(id);
      expect(p.name.length).toBeGreaterThan(2);
      expect(p.purpose.length).toBeGreaterThan(20);
      expect(p.instructions.length).toBeGreaterThan(80);
      expect(p.tools.length).toBeGreaterThan(0);
      expect(["primary", "fast"]).toContain(p.model);
      expect(p.outputContract.length).toBeGreaterThan(10);
      expect(p.maxSteps).toBeGreaterThan(0);
      expect(agentPersona(id)).toBe(p);
    }
    expect(agentPersona("nope")).toBeUndefined();
    expect(AGENT_PERSONAS.coordinator.model).toBe("fast");
    expect(AGENT_PERSONAS.research.model).toBe("primary");
    expect(AGENT_PERSONAS.reviewer.outputContract).toMatch(/verdict/);
    expect(AGENT_PERSONAS.coder.outputContract).toMatch(/responsive/);
    // The workflow UI list mirrors the registry ids.
    expect(WORKFLOW_AGENTS.map((a) => a.id)).toEqual(IDS);
  });
  it("enforces handoff rules: coordinator → specialist → reviewer → back, never a cycle", () => {
    for (const to of IDS) expect(canHandoff("coordinator", to)).toBe(to !== "coordinator");
    expect(canHandoff("research", "drafter")).toBe(true);
    expect(canHandoff("research", "reviewer")).toBe(true);
    expect(canHandoff("research", "coordinator")).toBe(false);
    expect(canHandoff("reviewer", "research")).toBe(false);
    expect(canHandoff("reviewer", "drafter")).toBe(false);
    expect(canHandoff("steward", "research")).toBe(false);
    expect(canHandoff("coder", "coder")).toBe(false);
    expect(canHandoff("coder", "reviewer")).toBe(true);
    // No cycles through the handoff graph (the reviewer and steward are sinks).
    const visit = (id: AgentId, seen: AgentId[]): boolean => AGENT_PERSONAS[id].handoffs.every((n) => !seen.includes(n) && visit(n, [...seen, n]));
    for (const id of IDS) expect(visit(id, [id]), id).toBe(true);
    // Every persona that may hand off carries the handoff tool; sinks do not.
    for (const id of IDS) expect(AGENT_PERSONAS[id].tools.includes("handoff")).toBe(AGENT_PERSONAS[id].handoffs.length > 0);
  });
  it("assembles instructions with the contract, style rules, matter and run context", () => {
    const text = personaInstructions(AGENT_PERSONAS.drafter, { matter: { id: "m1", name: "Northgate v. Apex", shortName: "Northgate", client: "Northgate", clientSide: "plaintiff", court: "S.D.N.Y.", stage: "discovery" }, user: { id: "p1", name: "Arjun Mehra" }, workflowName: "Meet-and-confer letter", nodeId: "draft", extra: "Evidence ids: NG-000123" });
    expect(text).toContain("Drafter agent");
    expect(text).toContain("Output contract: Markdown document");
    expect(text).toContain("Matter context: Northgate v. Apex");
    expect(text).toContain("Requested by Arjun Mehra");
    expect(text).toContain('workflow "Meet-and-confer letter" (step draft)');
    expect(text).toContain("Evidence ids: NG-000123");
    expect(text).toContain("handoff tool, once");
    expect(personaInstructions(AGENT_PERSONAS.steward)).toContain("No matter is attached");
  });
});

describe("handoff tool and toolsets", () => {
  const ctx = () => { const events: AgentEmit[] = []; const state: Record<string, unknown> = {}; return { ctx: { emit: (e: AgentEmit) => events.push(e), state }, events, state }; };
  it("records an allowed handoff in the shared state and refuses others", async () => {
    const tool = handoffTool("research");
    expect(tool.name).toBe("handoff");
    expect((tool.parameters as { properties: { to: { enum: string[] } } }).properties.to.enum).toEqual(["drafter", "reviewer"]);
    const { ctx: c, events, state } = ctx();
    const ok = await tool.execute({ to: "reviewer", brief: "Check the memo", evidence_ids: ["idoc_1"] }, c);
    expect(ok.handoff).toEqual({ from: "research", to: "reviewer", brief: "Check the memo", evidenceIds: ["idoc_1"] });
    expect((state.handoffs as HandoffRequest[])).toHaveLength(1);
    expect(events.some((e) => e.type === "status" && /Handoff → reviewer/.test(e.message))).toBe(true);
    const refused = await tool.execute({ to: "coordinator", brief: "loop back" }, c);
    expect(refused.handoff.brief).toMatch(/^REFUSED/);
    expect((state.handoffs as HandoffRequest[])).toHaveLength(1);
    // Sinks expose an empty enum placeholder and cannot hand off at all.
    expect((handoffTool("reviewer").parameters as { properties: { to: { enum: string[] } } }).properties.to.enum).toEqual(["none"]);
  });
  it("resolves persona tool names into function tools and built-ins, skipping unknown names", () => {
    const r = toolsFor(AGENT_PERSONAS.research.tools, { from: "research" });
    const names = r.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_judgments", "read_judgment", "map_criminal_section", "search_statutes", "search_intel", "search_library", "get_matter_context", "fetch_url", "handoff"]));
    expect(r.builtinTools.length).toBe(1); // web_search
    expect(r.unknown).toEqual([]);
    const s = toolsFor(["search_intel", "search_intel", "made_up", "handoff"], { from: "reviewer" });
    expect(s.tools.map((t) => t.name)).toEqual(["search_intel"]); // deduped; the reviewer has no handoff targets
    expect(s.unknown).toEqual(["made_up"]);
    expect(searchIntelTool.name).toBe("search_intel");
  });
  it("searches the intelligence store from the tool (keyword-only, no key)", async () => {
    const { ctx: c, events } = ctx();
    const r = (await searchIntelTool.execute({ query: "Depo-Provera MDL 3140 Rodgers", kinds: ["mdl", "docket", "opinion", "bogus"], limit: 5 }, c)) as { count: number; results: Record<string, unknown>[] };
    expect(r.count).toBeGreaterThan(0);
    expect(r.results[0]).toMatchObject({ id: expect.stringMatching(/^idoc_/), kind: expect.any(String), title: expect.any(String) });
    expect(events.filter((e) => e.type === "citation").length).toBeGreaterThan(0);
  });
  it("runPersona fails with AIConfigError without a key and never audits a generation", async () => {
    const before = db().collection<{ id: string; action?: string }>("audit_log").all().length;
    await expect(runPersona("coordinator", "Draft a letter")).rejects.toBeInstanceOf(AIConfigError);
    await expect(runPersona("nope" as AgentId, "x")).rejects.toThrow(/Unknown agent persona/);
    expect(db().collection<{ id: string }>("audit_log").all().length).toBe(before);
  });
});
