/**
 * Research lanes over the corpus: every id a lane is shown resolves in the reader (own finds, the run's known sources
 * and the sources other lanes handed over), tolerant spellings resolve exactly (never a closest match), unknown ids
 * fail with the list of valid ids, failed reads do not consume the read cap, read_source jumps to a page, corpus
 * judgments reach citing_references, and the coverage block reaches the lane's user turn.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/ai/agent";
import type { ToolDef } from "@/lib/ai/tools";
import { createReadRegistry } from "@/modules/search/engine/cache";
import { evidenceSourceId } from "@/modules/search/engine/evidence";
import type { EngineDeps } from "@/modules/search/engine/deps";
import { buildLaneTools, pageOffset, resolveLaneSource, runLane, textTag, unknownSourceError } from "@/modules/search/engine/lanes";
import { planLanes } from "@/modules/search/engine/planner";
import { resolvePolicy } from "@/modules/search/engine/runtime";
import { sourceFromHit } from "@/modules/search/engine/sources";
import type { ResearchLane, ResearchSource } from "@/modules/search/engine/types";
import { sanitizeSettings } from "@/modules/search/service";
import type { SearchHit } from "@/modules/search/types";

const SC_TEXT = "[p. 1]\n\nVIJAY SINGH v. STATE OF BIHAR\n\n[p. 6]\n\n12. Parity is a relevant consideration for anticipatory bail.\n\n[p. 7]\n\n13. Appeal allowed.";

const fullText = (id: string, title: string, cite: string): SearchHit => ({ id: `corpus:${id}`, source: "caselaw", title, cite, citations: [cite], courtId: "sci", court: "Supreme Court of India", date: "2024-09-25", authority: "binding", snippet: "parity anticipatory bail", india: { judgmentId: id, courtId: "sci", judges: [], neutralCitation: cite, provider: "corpus" }, readRef: { kind: "url", url: `corpus-text://${id}` } });
const metaOnly = (id: string, title: string, cite: string): SearchHit => ({ id: `corpus:${id}`, source: "caselaw", title, cite, citations: [cite], courtId: "sci", court: "Supreme Court of India", date: "2001-03-01", authority: "binding", snippet: "old bail case", india: { judgmentId: id, courtId: "sci", judges: [], neutralCitation: cite, provider: "corpus" } });

const VIJAY = fullText("sc:2024_10_108_125", "Vijay Singh v. State of Bihar", "2024 INSC 735");
const BROKEN = fullText("sc:2023_broken", "Broken v. Text", "2023 INSC 1");
const OLD = metaOnly("sc:S_2001_2_448_455", "Old v. Case", "2001 INSC 77");
const OTHER = fullText("sc:2022_peer", "Peer v. Lane", "2022 INSC 50");

const settings = sanitizeSettings({ sources: ["caselaw", "statutes"], jurisdiction: "hc-karnataka" });
const src = (h: SearchHit, lane = "l") => sourceFromHit(h, lane);

describe("lane source resolution", () => {
  const pools = [[src(VIJAY), src(OLD)], [src(OTHER, "other")]];
  it("resolves exact ids, the spelling without the corpus: prefix, and a citation only one source carries", () => {
    expect(resolveLaneSource("corpus:sc:2024_10_108_125", pools)?.id).toBe("corpus:sc:2024_10_108_125");
    expect(resolveLaneSource("sc:2024_10_108_125", pools)?.id).toBe("corpus:sc:2024_10_108_125");
    expect(resolveLaneSource(" `corpus:sc:2022_peer` ", pools)?.id).toBe("corpus:sc:2022_peer");
    expect(resolveLaneSource("2024 insc 735", pools)?.id).toBe("corpus:sc:2024_10_108_125");
    expect(resolveLaneSource("sc:2024_10_108_12", pools)).toBeUndefined(); // never the closest id
    const dup = [[src(VIJAY), { ...src(BROKEN), cite: "2024 INSC 735", hit: { ...BROKEN, citations: ["2024 INSC 735"] } }]];
    expect(resolveLaneSource("2024 INSC 735", dup)).toBeUndefined(); // two sources carry it: none chosen
  });
  it("the unknown-id error lists ids the lane can use, readable first, metadata-only marked", () => {
    const msg = unknownSourceError("corpus:sc:nope", pools).message;
    expect(msg).toMatch(/^Unknown source id corpus:sc:nope\. Use an id exactly as a search result listed it; valid ids include: corpus:sc:2024_10_108_125, corpus:sc:2022_peer, corpus:sc:S_2001_2_448_455 \(metadata only, not readable\)\.$/);
    expect(unknownSourceError("x", []).message).toMatch(/search first/);
  });
  it("corpus judgments carry a stable server-resolvable evidence source (full text and metadata records)", () => {
    expect(evidenceSourceId(src(VIJAY))).toBe("corpus://judgment/sc%3A2024_10_108_125");
    expect(evidenceSourceId(src(OLD))).toBe("corpus://judgment/sc%3AS_2001_2_448_455");
  });
  it("tags judgments by readability and finds page markers", () => {
    expect(textTag(src(VIJAY))).toBe(" [full text]");
    expect(textTag(src(OLD))).toBe(" [metadata only]");
    expect(pageOffset(SC_TEXT, 6)).toBe(SC_TEXT.indexOf("[p. 6]"));
    expect(pageOffset(SC_TEXT, 1)).toBe(0);
    expect(pageOffset(SC_TEXT, 60)).toBe(-1);
  });
});

describe("lane tools", () => {
  const lane: ResearchLane = { id: "lane_contrary_r1", kind: "contrary", name: "Adverse", brief: "", sources: ["caselaw"], tools: ["search_judgments", "read_judgment", "citing_references"], queries: ["q"], maxSteps: 3, maxReads: 3, round: 1 };
  const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
    hasKey: true, model: "m", fastModel: "f",
    retrieve: async () => ({ hits: [], total: 0 }),
    read: async () => ({ text: SC_TEXT, cached: true }),
    laneAgent: async () => ({ text: "", steps: 0 }),
    synthesize: async () => "",
    verify: async () => ({ verdicts: [], supported: 0, unsupported: 0, contradicted: 0, score: 0, status: "verified" }) as never,
    correct: async () => "",
    refine: async () => ({}),
    followUps: async () => [],
    verifyCitationsRemote: async () => [],
    ...over,
  });
  const ctx = (d: EngineDeps) => ({ question: "q", settings, matter: null, deps: d, emit: () => {}, texts: new Map<string, string>(), reads: createReadRegistry(), known: [] as ResearchSource[], policy: resolvePolicy("deep"), priors: [] });
  const tool = (tools: ToolDef<never, unknown>[], name: string) => tools.find((t) => t.name === name) as unknown as ToolDef<Record<string, unknown>, Record<string, unknown>>;
  const tctx = { emit: () => {}, state: {} };

  it("reads a source another lane handed over (the adverse lane's 'leading authority'), adopting it, and jumps to a page", async () => {
    const found = new Map<string, ResearchSource>([[src(VIJAY).id, src(VIJAY)]]);
    const recorded: ResearchSource[] = [];
    const tools = buildLaneTools(lane, ctx(deps()), { found, record: (xs) => { for (const s of xs) { recorded.push(s); found.set(s.id, s); } }, readOne: async () => SC_TEXT, peers: () => [src(OTHER, "lane_controlling_r1")] });
    const r = await tool(tools, "read_source").execute({ source_id: "sc:2022_peer", page: 6 }, tctx);
    expect(r.id).toBe("corpus:sc:2022_peer");
    expect(String(r.text).startsWith("[p. 6]\n\n12. Parity")).toBe(true);
    expect(recorded.map((s) => s.id)).toEqual(["corpus:sc:2022_peer"]);
    expect(recorded[0].laneIds).toEqual([lane.id]);
    await expect(Promise.resolve().then(() => tool(tools, "read_source").execute({ source_id: "corpus:sc:2024_10_108_125", page: 60 }, tctx))).rejects.toThrow(/No page 60 marker/);
    await expect(Promise.resolve().then(() => tool(tools, "read_source").execute({ source_id: "corpus:sc:ghost" }, tctx))).rejects.toThrow(/valid ids include: corpus:sc:2024_10_108_125, corpus:sc:2022_peer/);
    const para = await tool(tools, "read_judgment").execute({ source_id: "corpus:sc:2022_peer", start_paragraph: 1, count: 2 }, tctx);
    expect(para.id).toBe("corpus:sc:2022_peer");
  });

  it("a metadata-only judgment explains itself instead of failing as unknown", async () => {
    const found = new Map<string, ResearchSource>([[src(OLD).id, src(OLD)]]);
    const tools = buildLaneTools(lane, ctx(deps()), { found, record: () => {}, readOne: async () => SC_TEXT });
    await expect(Promise.resolve().then(() => tool(tools, "read_source").execute({ source_id: "corpus:sc:S_2001_2_448_455" }, tctx))).rejects.toThrow(/metadata only \(no readable full text\)/);
  });

  it("citing_references passes a corpus judgment's key to the corpus citing path", async () => {
    const seen: string[] = [];
    const d = deps({ citing: async (i) => { seen.push(String(i.judgmentId)); return { signal: "no_negative_signal", citingCount: 2, negativeCount: 0, examples: [], checkedAt: "", note: "No negative-treatment language found", basis: "corpus" }; } });
    const found = new Map<string, ResearchSource>([[src(OLD).id, src(OLD)]]);
    const tools = buildLaneTools(lane, ctx(d), { found, record: () => {}, readOne: async () => SC_TEXT });
    const r = await tool(tools, "citing_references").execute({ source_id: "sc:S_2001_2_448_455" }, tctx);
    expect(seen).toEqual(["sc:S_2001_2_448_455"]);
    expect(r).toMatchObject({ id: "corpus:sc:S_2001_2_448_455", citingCount: 2 });
  });
});

describe("runLane over corpus sources", () => {
  it("a failed read does not consume the read cap; the lane input carries coverage and full-text / metadata tags", async () => {
    let input = "";
    const reads: string[] = [];
    const d: EngineDeps = {
      hasKey: true, model: "m", fastModel: "f",
      retrieve: async () => ({ hits: [BROKEN, VIJAY, OLD, OTHER], total: 4 }),
      read: async (ref) => { const url = ref.kind === "url" ? ref.url : ""; reads.push(url); if (url.includes("broken")) throw new Error("No full text for judgment sc:2023_broken"); return { text: SC_TEXT, cached: true }; },
      laneAgent: async (i) => {
        input = i.input;
        const read = i.tools.find((t) => t.name === "read_source") as unknown as ToolDef<{ source_id: string }, unknown>;
        const out: string[] = [];
        for (const id of ["corpus:sc:2023_broken", "corpus:sc:2024_10_108_125", "corpus:sc:2022_peer", "corpus:sc:2024_10_108_125"]) {
          try { await read.execute({ source_id: id }, { emit: () => {}, state: {} }); out.push(`ok ${id}`); } catch (e) { out.push(`fail ${id}: ${(e as Error).message}`); }
        }
        i.onEvent({ type: "tool.call", id: "x", name: "read_source", label: "r", args: {} } as AgentEvent);
        return { text: out.join("\n"), steps: 4 };
      },
      synthesize: async () => "", verify: async () => ({}) as never, correct: async () => "", refine: async () => ({}), followUps: async () => [], verifyCitationsRemote: async () => [],
    };
    const lane: ResearchLane = { id: "lane_controlling_r1", kind: "controlling", name: "Binding", brief: "b", sources: ["caselaw"], tools: ["search_judgments", "read_judgment"], queries: ["parity bail"], maxSteps: 4, maxReads: 2, round: 1 };
    const texts = new Map<string, string>();
    const r = await runLane(lane, { question: "q", settings, matter: null, deps: d, emit: () => {}, texts, reads: createReadRegistry(texts), known: [], policy: resolvePolicy("deep"), priors: [], coverage: "Indian law corpus coverage (test block)" });
    expect(r.note.split("\n")).toEqual([
      "fail corpus:sc:2023_broken: No full text for judgment sc:2023_broken",
      "ok corpus:sc:2024_10_108_125",
      "ok corpus:sc:2022_peer", // the failed read did not use up one of the two reads
      "ok corpus:sc:2024_10_108_125", // re-reading is free
    ]);
    expect(r.read).toBe(2);
    expect(input).toContain("Indian law corpus coverage (test block)");
    expect(input).toContain("corpus:sc:S_2001_2_448_455 · ");
    expect(input).toMatch(/corpus:sc:S_2001_2_448_455 · [^\n]*\[metadata only\]/);
    expect(input).toMatch(/corpus:sc:2024_10_108_125 · [^\n]*\[full text\]/);
  });

  it("deep judgment and statute lanes have larger explicit read and step caps", () => {
    const lanes = planLanes({ question: "anticipatory bail parity", settings, mode: "deep", hasMatter: false });
    const caps = Object.fromEntries(lanes.map((l) => [l.kind, [l.maxReads, l.maxSteps]]));
    expect(caps).toMatchObject({ controlling: [8, 10], persuasive: [6, 9], contrary: [6, 10], statute: [6, 9] });
    expect(lanes.every((l) => l.maxReads <= 8 && l.maxSteps <= 10)).toBe(true);
  });
});
