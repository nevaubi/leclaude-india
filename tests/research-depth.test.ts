import { beforeAll, describe, expect, it } from "vitest";
import { classifyFailure } from "@/lib/ai/events";
import { db, resetSqlite } from "@/lib/db";
import { createReadRegistry } from "@/modules/search/engine/cache";
import { runLane } from "@/modules/search/engine/lanes";
import { runResearch } from "@/modules/search/engine/run";
import { resolvePolicy } from "@/modules/search/engine/runtime";
import { synthesisInstructions, laneInstructions } from "@/modules/search/engine/prompts";
import { resolveContextBudget } from "@/lib/ai/context-budget";
import { sanitizeSettings } from "@/modules/search/service";
import type { ResearchLane, ResearchStreamEvent } from "@/modules/search/engine/types";
import type { SearchHit } from "@/modules/search/types";
import { indiaFakeDeps } from "../evals/india-research/fixtures";

beforeAll(() => { resetSqlite(); db(); });
const settings = sanitizeSettings({ sources: ["library"], jurisdiction: "hc-karnataka" });
const hit = (n: number): SearchHit => ({ id: `library:depth${n}`, source: "library", title: `Limitation analysis ${n}`, snippet: "limitation exceptions and procedural requirements", readRef: { kind: "library", id: `depth${n}` } });
const lane: ResearchLane = { id: "lane_secondary_r1", kind: "secondary", name: "Secondary", brief: "Read the relevant library", sources: ["library"], tools: ["search_library"], queries: ["limitation exceptions"], maxReads: 8, maxSteps: 10, round: 1 };

describe("research depth regression", () => {
  it("reads a broad evidence set even when the lane model stops without calling a reader", async () => {
    const deps = indiaFakeDeps();
    deps.retrieve = async () => ({ hits: Array.from({ length: 14 }, (_, i) => hit(i)), total: 14 });
    deps.read = async (ref) => ({ text: `Full source ${JSON.stringify(ref)}. Limitation exceptions require an explanation of the delay.`, cached: false });
    let agentInput = "";
    deps.laneAgent = async (i) => { agentInput = i.input; return { text: "Gaps: none", steps: 1 }; };
    const texts = new Map<string, string>();
    const result = await runLane(lane, { question: "Analyze limitation exceptions in depth", settings, matter: null, deps, emit: () => {}, texts, reads: createReadRegistry(texts), known: [], policy: resolvePolicy("deep"), priors: [] });
    expect(result.read).toBeGreaterThanOrEqual(6);
    expect(result.read).toBeLessThanOrEqual(lane.maxReads);
    expect(agentInput).toContain("Prefetched source passages");
    expect(agentInput).toContain("Limitation exceptions require");
  });

  it("never marks an empty response as a successfully read source", async () => {
    const deps = indiaFakeDeps();
    deps.retrieve = async () => ({ hits: [hit(1)], total: 1 });
    deps.read = async () => ({ text: "   ", cached: false });
    const texts = new Map<string, string>();
    const result = await runLane({ ...lane, kind: "fast", maxReads: 2 }, { question: "limitation", settings, matter: null, deps, emit: () => {}, texts, reads: createReadRegistry(texts), known: [], policy: resolvePolicy("fast"), priors: [] });
    expect(result.read).toBe(0);
    expect(result.sources.every((s) => !s.read)).toBe(true);
  });

  it("reuses a completed read, not only an in-flight fetch", async () => {
    const registry = createReadRegistry(); let calls = 0;
    const fetch = async () => { calls++; return { text: "source text", cached: false }; };
    await registry.read("one", fetch);
    const second = await registry.read("one", fetch);
    expect(calls).toBe(1);
    expect(second.shared).toBe(true);
  });

  it("fills a specific research gap before spending time on the final draft", async () => {
    const deps = indiaFakeDeps(); let filled = false; const order: string[] = [];
    deps.retrieve = async (_s, q) => { if (q.includes("special limitation exception")) filled = true; return { hits: [hit(filled ? 99 : 1), hit(2), hit(3)], total: 3 }; };
    deps.read = async (ref) => ({ text: `Limitation source ${JSON.stringify(ref)}. The exception must be established by evidence.`, cached: false });
    deps.laneAgent = async () => ({ text: filled ? "Gaps: none" : "Gaps: The special limitation exception remains unresolved.", steps: 1 });
    deps.refine = async () => { order.push("refine"); return { secondary: ["special limitation exception"] }; };
    deps.synthesize = async (i) => { order.push("synthesize"); const text = "## Analysis\nThe exception requires evidence [1]."; i.onDelta(text); return text; };
    deps.verify = async () => ({ verdicts: [{ claim: "The exception requires evidence", status: "supported", sourceIndex: 0 }], supported: 1, unsupported: 0, contradicted: 0, score: 1, status: "verified", sourceBacked: true, checkedAt: new Date().toISOString() });
    const events: ResearchStreamEvent[] = [];
    await runResearch({ question: "Detailed analysis of limitation exceptions", settings, runId: "run_depth_gap" }, (e) => events.push(e), undefined, deps);
    expect(order.indexOf("refine")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("refine")).toBeLessThan(order.indexOf("synthesize"));
    expect(order.filter((x) => x === "synthesize")).toHaveLength(1);
    expect(events.filter((e) => e.type === "plan.created").length).toBeGreaterThanOrEqual(2);
  });

  it("allows 32 substantive sources while keeping the existing bounded input", () => {
    const b = resolveContextBudget("deep_research_synthesis", { contextWindow: 1_000_000, maxInput: 960_000, maxOutput: 48_000 }, {});
    expect(b.maxFullSources).toBe(32);
    expect(b.inputTokens).toBeLessThanOrEqual(240_000);
    expect(synthesisInstructions("deep", "Firm")).toContain("issue-by-issue");
    expect(laneInstructions("controlling", "Binding", "Read binding law", "Firm", 8)).not.toContain("under 250 words");
  });
});

describe("bounded shared reading", () => {
  it("caps combined lane fetches at six in flight and reuses their results", async () => {
    const registry = createReadRegistry(); let active = 0; let peak = 0; let count = 0;
    const read = async (id: string) => { active++; count++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return { text: "Source " + id, cached: false }; };
    await Promise.all(Array.from({ length: 20 }, (_, i) => registry.read(String(i), () => read(String(i)))));
    await registry.read("0", () => read("0"));
    expect(peak).toBe(6); expect(count).toBe(20);
  });
  it("does not start a queued network read after its lane is cancelled", async () => {
    const registry = createReadRegistry(); const controller = new AbortController(); let queuedStarted = false;
    const busy = Array.from({ length: 6 }, (_, i) => registry.read(String(i), async () => { await new Promise((r) => setTimeout(r, 10)); return { text: "read" }; }));
    const queued = registry.read("cancelled", async () => { queuedStarted = true; return { text: "should not load" }; }, controller.signal);
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected; await Promise.all(busy);
    expect(queuedStarted).toBe(false);
  });
});

it("does not retry a permanently missing source as a provider outage", () => {
  expect(classifyFailure(Object.assign(new Error("Text unavailable"), { status: 404 }))).toBe("no_result");
  expect(classifyFailure(Object.assign(new Error("Text unavailable"), { status: 503 }))).toBe("provider_outage");
});
