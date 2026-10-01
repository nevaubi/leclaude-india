/**
 * Prompts and tool descriptions steer the models to the right Indian law tool: routing blocks in the research lanes,
 * the chat system prompt and the legal personas; the coverage block reaches the planner, the lanes and chat; tool
 * descriptions say when to use each tool and which ids it accepts; corpus tools are gated by capability.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { INDIAN_LAW_TOOL_ROUTING, indiaRoutingFor, ROUTED_INDIA_TOOLS } from "@/lib/ai/india-guidance";
import { AGENT_PERSONAS, personaInstructions, toolsFor } from "@/lib/ai/agents/registry";
import { INDIA_TOOLS } from "@/lib/ai/toolkit/india";
import { getForumInfoTool } from "@/lib/ai/toolkit/india-forums";
import { chatInstructions } from "@/modules/chat/server/engine";
import { LANE_JUDGMENT_ROUTING, LANE_STATUTE_ROUTING, laneInstructions } from "@/modules/search/engine/prompts";
import { planContext, runResearch } from "@/modules/search/engine/run";
import { sanitizeSettings } from "@/modules/search/service";
import { indiaFakeDeps } from "../evals/india-research/fixtures";

beforeAll(() => { resetSqlite(); db(); });

const COVERAGE = "Indian law corpus coverage (use it to choose tools; it is not evidence and is never cited):\n- Full text with page numbers (search_judgment_text, then read_judgment_text; cite the page): Supreme Court of India 35.6k judgments (1950–2026).";
const desc = (name: string) => [...INDIA_TOOLS, getForumInfoTool].find((t) => t.name === name)!.description;

describe("tool descriptions make selection unambiguous", () => {
  it("every routed tool exists in the toolkit", () => {
    const names = new Set([...INDIA_TOOLS, getForumInfoTool].map((t) => t.name));
    for (const t of ROUTED_INDIA_TOOLS) expect(names.has(t), t).toBe(true);
  });
  it("say when to use each tool and which ids it accepts", () => {
    expect(desc("search_judgment_text")).toMatch(/PRIMARY tool for doctrine, holdings/);
    expect(desc("search_judgment_text")).toMatch(/read_judgment_text \(id \+ page\)/);
    expect(desc("read_judgment_text")).toMatch(/sc:…, hc:…/);
    expect(desc("read_judgment_text")).toMatch(/2024 INSC 735/);
    expect(desc("read_judgment_text")).toMatch(/KAHC010219082014@2014-09-09/);
    expect(desc("read_judgment_text")).toMatch(/Title, 2024 INSC 735, p\. 6/);
    expect(desc("search_judgment_index")).toMatch(/METADATA index \(corpus ids sc:… \/ hc:…\)/);
    expect(desc("search_judgment_index")).toMatch(/Metadata only means there is no judgment text here to read or quote/);
    expect(desc("search_judgments")).toMatch(/LOCAL STORE of ingested judgments \(ids ijdg_…/);
    expect(desc("search_judgments")).toMatch(/prefer search_judgment_text/);
    expect(desc("read_judgment")).toMatch(/does not accept sc:\/hc: ids or neutral citations: use read_judgment_text/);
    expect(desc("search_law")).toMatch(/PRIMARY statute search/);
    expect(desc("search_law")).toMatch(/read_law_section using the act_id and section/);
    expect(desc("read_law_section")).toMatch(/Section 303, Bharatiya Nyaya Sanhita, 2023/);
    expect(desc("read_law_section")).toMatch(/Does not accept ids from search_statutes/);
    expect(desc("search_statutes")).toMatch(/CURATED India Code store/);
    expect(desc("search_statutes")).toMatch(/prefer it for any statute question/);
    expect(desc("read_section")).toMatch(/read with read_law_section \(act_id \+ section\), not this tool/);
    expect(desc("list_law_instruments")).toMatch(/by TITLE/);
    expect(desc("citing_references")).toMatch(/sc:… \/ hc:…/);
    expect(desc("citing_references")).toMatch(/mentions \(text match\)/);
    expect(desc("citing_references")).toMatch(/ijdg_… id from search_judgments/);
  });
});

describe("routing blocks", () => {
  it("chat: routing and coverage with the law switch on, nothing without it; deterministic", () => {
    const names = ["search_law", "read_law_section", "search_judgment_text", "read_judgment_text", "get_forum_info"];
    const on = chatInstructions({ law: true, toolNames: names, coverage: COVERAGE });
    expect(on).toContain(INDIAN_LAW_TOOL_ROUTING);
    expect(on).toContain(COVERAGE);
    expect(on.indexOf(INDIAN_LAW_TOOL_ROUTING)).toBeLessThan(on.indexOf(COVERAGE)); // stable prefix first
    expect(on).toMatch(/Statute question[^\n]*search_law → read_law_section/);
    expect(on).toMatch(/Doctrine, holding[^\n]*search_judgment_text → read_judgment_text/);
    expect(on).toMatch(/Identify a case[^\n]*search_judgment_index/);
    expect(on).toMatch(/get_forum_info/);
    expect(on).toMatch(/IPC↔BNS[^\n]*map_criminal_section/);
    expect(on).toMatch(/Never cite a judgment or provision you did not read/);
    expect(chatInstructions({ law: true, toolNames: names, coverage: COVERAGE })).toBe(on);
    const off = chatInstructions({ law: false });
    expect(off).not.toContain("Indian law tool routing");
    expect(off).not.toContain("coverage");
    expect(chatInstructions({ law: true, toolNames: ["search_library"] })).not.toContain("Indian law tool routing");
    expect(indiaRoutingFor(["fetch_url"])).toBe("");
  });

  it("research lanes: judgment and statute routing, byte-stable per lane kind; non-law lanes carry none", () => {
    const c = laneInstructions("controlling", "Binding", "brief", "Firm", 5);
    expect(c).toContain(LANE_JUDGMENT_ROUTING);
    expect(c).toMatch(/"full text" \(readable\) or "metadata only"/);
    expect(c).toMatch(/Pass ids exactly as listed/);
    expect(c).toMatch(/MENTION the citation \(text match\)/);
    expect(c).toMatch(/Never cite or note a source you did not read/);
    expect(c).toMatch(/READ up to 5/);
    expect(laneInstructions("controlling", "Binding", "brief", "Firm", 5)).toBe(c);
    expect(laneInstructions("statute", "Statutes", "brief", "Firm", 4)).toContain(LANE_STATUTE_ROUTING);
    const rec = laneInstructions("record", "Record", "brief", "Firm", 4);
    expect(rec).not.toContain("Indian law tool routing");
    expect(rec).not.toMatch(/\n\n\n/);
  });

  it("personas: legal personas carry the routing; others do not; corpus tools only with the capability", () => {
    expect(personaInstructions(AGENT_PERSONAS.research)).toContain(INDIAN_LAW_TOOL_ROUTING);
    expect(personaInstructions(AGENT_PERSONAS.research, {}, { coverage: COVERAGE })).toContain(COVERAGE);
    expect(personaInstructions(AGENT_PERSONAS.reviewer)).toContain("Indian law tool routing");
    expect(personaInstructions(AGENT_PERSONAS.drafter)).not.toContain("Indian law tool routing");
    expect(personaInstructions(AGENT_PERSONAS.drafter, {}, { coverage: COVERAGE })).not.toContain(COVERAGE);
    expect(AGENT_PERSONAS.research.tools).toEqual(expect.arrayContaining(["search_law", "read_law_section", "list_law_instruments", "search_judgment_text", "read_judgment_text", "search_judgment_index", "get_forum_info"]));
    const without = toolsFor(AGENT_PERSONAS.research.tools, { from: "research", caps: { corpus: false, indianKanoon: false } });
    expect(without.unavailable).toEqual(expect.arrayContaining(["search_law", "read_judgment_text", "search_judgment_index", "indian_kanoon_search"]));
    expect(without.unknown).toEqual([]);
    expect(without.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_forum_info", "search_judgments", "citing_references"]));
    expect(without.tools.map((t) => t.name)).not.toContain("search_law");
    const withDb = toolsFor(AGENT_PERSONAS.research.tools, { from: "research", caps: { corpus: true, indianKanoon: false } });
    expect(withDb.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["search_law", "read_law_section", "list_law_instruments", "search_judgment_text", "read_judgment_text", "search_judgment_index"]));
  });
});

describe("coverage reaches the research planner and lanes", () => {
  it("planContext carries the coverage block, and a run hands it to the planner and every lane agent", async () => {
    const settings = sanitizeSettings({ sources: ["caselaw", "statutes"], jurisdiction: "hc-karnataka" });
    expect(planContext(settings, "No matter selected.", ["q1"], null, COVERAGE)).toContain(COVERAGE);
    expect(planContext(settings, "No matter selected.", ["q1"], null)).not.toContain("coverage");
    const deps = indiaFakeDeps({ plan: { subQuestions: ["What do the courts hold?"], queries: {} } });
    const contexts: string[] = [];
    const laneInputs: string[] = [];
    const plan = deps.planQueries!.bind(deps);
    deps.planQueries = async (i) => { contexts.push(i.context); return plan(i); };
    const agent = deps.laneAgent.bind(deps);
    deps.laneAgent = async (i) => { laneInputs.push(i.input); return agent(i); };
    deps.coverage = async () => COVERAGE;
    await runResearch({ question: "Can anticipatory bail be refused only because the offence is economic?", settings, runId: "run_cov_1" }, () => {}, undefined, deps);
    expect(contexts[0]).toContain(COVERAGE);
    expect(laneInputs.length).toBeGreaterThan(0);
    for (const x of laneInputs) expect(x).toContain(COVERAGE);
  });
});
