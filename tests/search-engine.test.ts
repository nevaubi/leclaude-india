import { annotateAnswer } from "@/modules/search/engine/trust";
import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { listAudit } from "@/lib/integrity/audit";
import type { ToolDef } from "@/lib/ai/tools";
import { planLanes, retrievalQuery, contraryQuery } from "@/modules/search/engine/planner";
import { mergeSources, numberSources, sourceFromHit, sourceKey, normalizeUrl, toProvenanceSources, renderSourcesForPrompt } from "@/modules/search/engine/sources";
import { crossCheckCitations, markUnverifiedCitations, normCite } from "@/modules/search/engine/citecheck";
import { decideCoverage, broaden, claimToQuery } from "@/modules/search/engine/coverage";
import { assembleProvenance } from "@/modules/search/engine/provenance";
import { runResearch, fallbackFollowUps, questionTopic } from "@/modules/search/engine/run";
import { getProvenance } from "@/lib/integrity/store";
import { getThread, listThreadSummaries, setThreadPins } from "@/modules/search/engine/threads";
import { cacheKey, getCached, putCached, sweepCache } from "@/modules/search/engine/cache";
import type { EngineDeps } from "@/modules/search/engine/deps";
import type { ResearchSource, ResearchStreamEvent, VerificationSummary } from "@/modules/search/engine/types";
import { sanitizeSettings, searchRuns } from "@/modules/search/service";
import { SEARCH_SEED_IDS, citeMapFromSynthesis } from "@/modules/search/seed";
import type { SearchHit, SearchSettings } from "@/modules/search/types";
import type { AgentEvent } from "@/lib/ai/agent";
import { BNSS_482, BOM_HC, forHit, KAR_HC, SC_BAIL, TEXTS, TS_HC } from "../evals/india-research/fixtures";

beforeAll(() => { resetSqlite(); db(); });

const settings = (over: Partial<SearchSettings> = {}) => sanitizeSettings({ sources: ["caselaw", "statutes", "library"], jurisdiction: "hc-karnataka", ...over });

// ---- fixtures (fictional judgments; see evals/india-research/fixtures.ts) -------------

const sc = forHit(SC_BAIL, "hc-karnataka");
const kar = forHit(KAR_HC, "hc-karnataka");
const ts = forHit(TS_HC, "hc-karnataka");
const bom = forHit(BOM_HC, "hc-karnataka");
const section = BNSS_482;

function fakeDeps(over: Partial<EngineDeps> & { hasKey?: boolean; answer?: string; verdicts?: VerificationSummary["verdicts"] } = {}): EngineDeps & { calls: string[] } {
  const calls: string[] = [];
  const answer = over.answer ?? `## Answer\nAnticipatory bail cannot be refused only because the offence is economic [1]. Parity with a co-accused is relevant [2]. But see Fictional v. State, (2021) 9 SCC 999.\n\n## Analysis\nThe court weighs the accusation [1]. Section 482 BNSS governs [3].\n\n## Sources\n[1] Meera Nair v. State of Karnataka, 2023 INSC 212 : (2023) 5 SCC 301\n[2] Ravi Kumar v. State of Karnataka, 2024:KHC:5123\n[3] Section 482 of the Bharatiya Nagarik Suraksha Sanhita, 2023`;
  const deps: EngineDeps & { calls: string[] } = {
    calls,
    hasKey: over.hasKey ?? true,
    model: "gpt-test",
    fastModel: "gpt-test-mini",
    async retrieve(source, query, s) {
      calls.push(`retrieve:${source}:${query.slice(0, 20)}`);
      if (source === "caselaw") {
        const courts = (s.courts ?? "").split(" ").filter(Boolean);
        const hits = [sc, kar].filter((h) => !courts.length || courts.includes(h.india?.courtId ?? ""));
        return { hits, total: hits.length };
      }
      if (source === "statutes") return { hits: [section], total: 1 };
      if (source === "library") throw new Error("fetch failed");
      return { hits: [], total: 0 };
    },
    async read(ref) {
      calls.push(`read:${cacheKey(ref)}`);
      const text = TEXTS[cacheKey(ref)];
      if (!text) throw new Error("ENOTFOUND");
      return { text, cached: false };
    },
    async laneAgent(input) {
      calls.push(`agent:${input.maxSteps}`);
      // Read the first two found sources through the lane's read_source tool, like the model would.
      const read = input.tools.find((t) => t.name === "read_source") as ToolDef<{ source_id: string }, unknown> | undefined;
      const ids = Array.from(input.input.matchAll(/^(\S+) · /gm)).map((m) => m[1]).slice(0, 2);
      for (const id of ids) { try { await read!.execute({ source_id: id }, { emit: () => {}, state: {} }); } catch { /* cap or missing */ } }
      input.onEvent({ type: "tool.call", id: "x", name: "read_source", label: "Reading", args: {} } as AgentEvent);
      return { text: `- ${ids[0] ?? "none"} — read\nGaps: none`, steps: 2 };
    },
    async synthesize(input) { calls.push("synthesize"); for (const chunk of answer.match(/.{1,40}/gs) ?? []) input.onDelta(chunk); return answer; },
    async verify() {
      calls.push("verify");
      const verdicts = over.verdicts ?? [
        { claim: "Anticipatory bail cannot be refused only because the offence is economic", status: "supported", sourceIndex: 0, quote: "anticipatory bail cannot be refused only because the offence is economic in nature" },
        { claim: "Parity with a co-accused is relevant", status: "supported", sourceIndex: 1 },
        { claim: "Section 482 BNSS governs", status: "supported", sourceIndex: 2 },
        { claim: "Fictional v. State holds otherwise", status: "unsupported", sourceIndex: null, note: "not in any source" },
      ].map((v) => ({ claim: v.claim, status: v.status as "supported" | "unsupported", sourceIndex: (v as { sourceIndex: number | null }).sourceIndex, quote: (v as { quote?: string }).quote, note: (v as { note?: string }).note }));
      const supported = verdicts.filter((v) => v.status === "supported").length;
      const contradicted = verdicts.filter((v) => v.status === "contradicted").length;
      const unsupported = verdicts.length - supported - contradicted;
      const score = supported / (verdicts.length || 1);
      return { verdicts: verdicts.map((v) => ({ ...v, sourceIndex: (v as { sourceIndex: number | null }).sourceIndex ?? null })), supported, unsupported, contradicted, score, status: contradicted ? "contradicted" : score >= 0.9 ? "verified" : "partially-verified", sourceBacked: true, checkedAt: new Date().toISOString() } as never;
    },
    async correct(input) { calls.push("correct"); return input.input.split("ANSWER:\n")[1].split("\n\nSOURCES")[0].replace("But see Fictional v. State, (2021) 9 SCC 999.", "Contrary authority was not located among the sources read."); },
    async refine() { calls.push("refine"); return { controlling: ["anticipatory bail economic offence parity"] }; },
    async followUps() { calls.push("followups"); return ["Has a larger bench of the Supreme Court considered parity in anticipatory bail?", "How has the Dharwad Bench applied Meera Nair?", "Does Section 482 BNSS change the conditions that may be imposed?"]; },
    async verifyCitationsRemote() { calls.push("remote"); throw new Error("fetch failed"); },
    ...over,
  };
  return deps;
}

function collect() {
  const events: (ResearchStreamEvent | AgentEvent)[] = [];
  return { events, send: (e: ResearchStreamEvent | AgentEvent) => { events.push(e); }, types: () => events.map((e) => e.type) };
}

// ---- planner ------------------------------------------------------------------

describe("lane planner", () => {
  it("plans binding, persuasive, adverse and statute lanes from the scope and drops lanes whose providers are off", () => {
    const lanes = planLanes({ question: "Is a co-accused entitled to anticipatory bail on parity in an economic offence?", settings: settings(), mode: "deep", hasMatter: false });
    expect(lanes.map((l) => l.kind)).toEqual(["controlling", "persuasive", "contrary", "statute", "secondary"]);
    expect(lanes.every((l) => l.maxSteps > 0 && l.maxReads > 0 && l.queries.length >= 1)).toBe(true);
    expect(lanes[0].tools).toContain("search_judgments");
    expect(lanes[0].courtFilter).toEqual(["sci", "hc-karnataka"]); // binding for a Karnataka forum, from the registry
    expect(lanes[1].courtFilter).not.toContain("hc-karnataka");
    expect(lanes[1].courtFilter).toContain("hc-telangana");
    expect(lanes[2].courtFilter).toBeUndefined(); // adverse lane searches every court
    expect(lanes[3].tools).toEqual(expect.arrayContaining(["search_statutes", "read_section", "map_criminal_section"]));
    expect(lanes[4].tools).not.toContain("web_search");
    const withMatter = planLanes({ question: "q", settings: settings({ sources: ["caselaw", "ediscovery", "web"] }), mode: "deep", hasMatter: true });
    expect(withMatter.map((l) => l.kind)).toEqual(["controlling", "persuasive", "contrary", "record", "secondary"]);
    expect(withMatter.find((l) => l.kind === "record")?.sources).toEqual(["ediscovery"]);
    expect(withMatter.find((l) => l.kind === "secondary")?.tools).toContain("web_search");
    const noMatter = planLanes({ question: "q", settings: settings({ sources: ["ediscovery"] }), mode: "deep", hasMatter: false });
    expect(noMatter.map((l) => l.kind)).toEqual(["controlling"]); // fallback: never zero lanes
    const telangana = planLanes({ question: "q", settings: settings({ jurisdiction: "hc-telangana" }), mode: "deep", hasMatter: false });
    expect(telangana[0].courtFilter).toEqual(["sci", "hc-telangana"]);
  });
  it("fast mode is a single lane with one deterministic read pass", () => {
    const lanes = planLanes({ question: "q", settings: settings({ fast: true, sources: ["caselaw", "web"] }), mode: "fast", hasMatter: false });
    expect(lanes.length).toBe(1);
    expect(lanes[0].kind).toBe("fast");
    expect(lanes[0].sources).toEqual(["caselaw"]);
  });
  it("round 2 re-runs only lanes with refinements and uses the refined queries", () => {
    const lanes = planLanes({ question: "q", settings: settings(), mode: "deep", hasMatter: false, round: 2, refinements: { statute: ["Section 482 BNSS conditions"] } });
    expect(lanes.map((l) => l.kind)).toEqual(["statute"]);
    expect(lanes[0].queries).toEqual(["Section 482 BNSS conditions"]);
    expect(lanes[0].id).toBe("lane_statute_r2");
  });
  it("turns natural language into retrieval terms, keeps boolean queries and searches translated terms when given", () => {
    expect(retrievalQuery("Is a co-accused entitled to anticipatory bail on parity under Section 438 CrPC?")).toBe("co-accused entitled anticipatory bail parity Section 438 CrPC");
    expect(retrievalQuery('"anticipatory bail" AND parity /s co-accused')).toBe('"anticipatory bail" AND "parity co-accused"~15');
    expect(contraryQuery("x")).toContain("per incuriam");
    const lanes = planLanes({ question: "ಸಹ ಆರೋಪಿಗೆ ನಿರೀಕ್ಷಣಾ ಜಾಮೀನು?", settings: settings(), mode: "deep", hasMatter: false, searchQuery: "anticipatory bail parity co-accused" });
    expect(lanes[0].queries[0]).toBe("anticipatory bail parity co-accused");
  });
});

// ---- sources ------------------------------------------------------------------

describe("source dedupe and numbering", () => {
  it("keys by provider id or normalised url and merges lanes/read state", () => {
    expect(sourceKey(sc)).toBe("judgment:j_sc_meera_nair");
    expect(sourceKey({ id: "web:0", source: "web", title: "India Code", url: "https://www.indiacode.nic.in/handle/1/?utm_source=x#top" })).toBe("web:indiacode.nic.in/handle/1");
    expect(sourceKey({ id: "web:1", source: "web", title: "India Code", url: "https://indiacode.gov.in/handle/123456789/496413/?utm_source=x#top" })).toBe("web:indiacode.gov.in/handle/123456789/496413");
    expect(normalizeUrl("https://WWW.Example.com/a/b/")).toBe("example.com/a/b");
    const a = sourceFromHit(sc, "lane_a", 1);
    const b = { ...sourceFromHit(sc, "lane_b", 2), read: true, chars: 500, excerpt: "text" };
    const merged = mergeSources([a], [b, sourceFromHit(kar, "lane_a", 3)]);
    expect(merged.length).toBe(2);
    expect(merged[0].laneIds).toEqual(["lane_a", "lane_b"]);
    expect(merged[0].read).toBe(true);
    expect(merged[0].chars).toBe(500);
    expect(merged[0].foundAt).toBe(1);
  });
  it("numbers read and binding sources first (Supreme Court and larger benches first) and maps provenance kinds", () => {
    const list = [sourceFromHit(section, "l", 1), sourceFromHit(ts, "l", 2), sourceFromHit(kar, "l", 3), sourceFromHit(sc, "l", 4), { ...sourceFromHit(bom, "l", 5), read: true }];
    const { sources, citeMap } = numberSources(list);
    expect(sources.map((s) => s.id)).toEqual(["judgment:j_bom_anil_patil", "judgment:j_sc_meera_nair", "judgment:j_kar_ravi_kumar", "judgment:j_ts_syed_imran", "section:bnss-2023:482"]);
    expect(citeMap[2]).toBe("judgment:j_sc_meera_nair");
    const prov = toProvenanceSources(sources);
    expect(prov.map((p) => p.kind)).toEqual(["case-law", "case-law", "case-law", "case-law", "regulation"]);
    expect(prov[1].cite).toBe("2023 INSC 212");
    const prompt = renderSourcesForPrompt(sources, new Map([["judgment:j_bom_anil_patil", "FULL TEXT"]]));
    expect(prompt).toContain("[2] Meera Nair v. State of Karnataka, 2023 INSC 212 : (2023) 5 SCC 301 (binding)");
    expect(prompt).toContain("[4] Syed Imran v. State of Telangana, 2022:TSHC:3301 (persuasive)");
    expect(prompt).toContain("FULL TEXT");
    expect(prompt).toContain("(not read — snippet only)");
  });
});

// ---- citation cross-check -----------------------------------------------------

describe("citation cross-check", () => {
  const read: ResearchSource[] = [{ ...sourceFromHit(sc, "l"), n: 1, read: true }, { ...sourceFromHit(kar, "l"), n: 2, read: false }];
  it("matches Indian neutral and reporter citations to read sources and flags the rest", () => {
    const answer = "See Meera Nair, (2023) 5 SCC 301 [1]; Ravi Kumar, 2024:KHC:5123 [2]; Fictional v. State, (2021) 9 SCC 999.";
    const r = crossCheckCitations(answer, read);
    expect(r.checks).toEqual([
      { citation: "(2023) 5 SCC 301", matched: true, sourceN: 1 },
      { citation: "2024:KHC:5123", matched: false, sourceN: 2 },
      { citation: "(2021) 9 SCC 999", matched: false },
    ]);
    expect(r.unmatched.map((c) => c.citation)).toEqual(["(2021) 9 SCC 999"]);
    expect(r.unreadCitedNs).toEqual([2]);
    const marked = markUnverifiedCitations(answer, r);
    expect(marked).toContain("2024:KHC:5123 [VERIFY]");
    expect(marked).toContain("(2021) 9 SCC 999 [VERIFY]");
    expect(marked).not.toContain("(2023) 5 SCC 301 [VERIFY]");
    expect(marked).toContain("> **Citation check.**");
    expect(marked).toContain("was found but not read");
    // idempotent: never doubles a marker
    expect(markUnverifiedCitations(marked, crossCheckCitations(marked, read)).match(/\[VERIFY\] \[VERIFY\]/)).toBeNull();
    expect(normCite("550 U.S. 544, 555")).toBe("550u.s.544");
    expect(normCite("(2023) 5 SCC 301")).toBe(normCite("(2023)  5  SCC 301"));
  });
  it("returns the answer untouched when every citation is backed", () => {
    const answer = "Meera Nair, 2023 INSC 212 [1].";
    const r = crossCheckCitations(answer, read);
    expect(markUnverifiedCitations(answer, r)).toBe(answer);
  });
});

// ---- coverage -----------------------------------------------------------------

describe("coverage decision", () => {
  const lanes = planLanes({ question: "q", settings: settings(), mode: "deep", hasMatter: false });
  const good: VerificationSummary = { status: "verified", supported: 5, unsupported: 0, contradicted: 0, score: 1, checkedAt: "x", verdicts: [] };
  it("completes when sources, reads and verification are adequate", () => {
    const sources = [{ ...sourceFromHit(sc, "l"), read: true, n: 1 }, sourceFromHit(kar, "l"), sourceFromHit(section, "l")];
    const d = decideCoverage({ round: 1, maxRounds: 3, sources, answer: "x [1]", verification: good, lanes });
    expect(d.complete).toBe(true);
    expect(d.reason).toContain("coverage adequate");
  });
  it("asks for another round with refinements when thin, and stops at the cap", () => {
    const thin: VerificationSummary = { status: "unverified", supported: 1, unsupported: 3, contradicted: 0, score: 0.25, checkedAt: "x", verdicts: [{ claim: "Parity requires an identical role of the co-accused", status: "unsupported", sourceN: null }, { claim: "Conditions under Section 482 BNSS are mandatory", status: "unsupported", sourceN: null }] };
    const d = decideCoverage({ round: 1, maxRounds: 3, sources: [sourceFromHit(sc, "l")], answer: "x", verification: thin, lanes, emptyLaneIds: ["lane_statute_r1"] });
    expect(d.complete).toBe(false);
    expect(d.reason).toContain("only 1 source");
    expect(d.refinements.controlling?.length).toBeGreaterThan(0);
    expect(d.refinements.persuasive?.length).toBeGreaterThan(0);
    expect(d.refinements.statute).toBeTruthy();
    expect(d.gaps.length).toBe(2);
    const capped = decideCoverage({ round: 3, maxRounds: 3, sources: [], answer: "", verification: null, lanes });
    expect(capped.complete).toBe(true);
    expect(capped.reason).toContain("stopping after round 3");
  });
  it("broadens boolean queries and turns claims into queries", () => {
    expect(broaden('"anticipatory bail" AND parity AND co-accused NOT murder')).toBe('"anticipatory bail" AND (parity OR co-accused)');
    expect(claimToQuery("The court held that parity requires an identical role [1].")).toBe("parity requires identical role");
  });
});

// ---- provenance ---------------------------------------------------------------

describe("provenance assembly", () => {
  it("uses the verification score as confidence and records mismatches", () => {
    const sources = [{ ...sourceFromHit(sc, "l"), n: 1, read: true }, { ...sourceFromHit(section, "l"), read: true }];
    const v: VerificationSummary = { status: "partially-verified", supported: 3, unsupported: 1, contradicted: 0, score: 0.75, checkedAt: "2026-09-24T00:00:00Z", verdicts: [] };
    const p = assembleProvenance({ sources, verification: v, question: "q", instructions: "i", model: "m", citationMismatches: 1 });
    expect(p.surface).toBe("research");
    expect(p.confidence).toBe(0.75);
    expect(p.sources.length).toBe(1); // only cited sources
    expect(p.verification?.status).toBe("partially-verified");
    expect(p.verification?.notes).toContain("1 citation(s) not matched");
    expect(p.promptHash).toBeTruthy();
    expect(p.model).toBe("m");
    const none = assembleProvenance({ sources: [], verification: null, question: "q" });
    expect(none.confidence).toBe(0);
    expect(none.review?.status).toBe("pending");
    const unverified = assembleProvenance({ sources, verification: null, question: "q", citationMismatches: 2 });
    expect(unverified.confidence).toBe(0.5);
    expect(unverified.verification?.method).toBe("citations");
  });
});

// ---- cache --------------------------------------------------------------------

describe("source cache", () => {
  it("stores external reads for 24h and skips local records (matter documents, corpus judgments, India Code)", () => {
    const ref = { kind: "url" as const, url: "https://indiacode.gov.in/handle/123456789/424242" };
    expect(getCached(ref)).toBeNull();
    putCached(ref, { title: "X", text: "hello" });
    expect(getCached(ref)?.text).toBe("hello");
    expect(getCached(ref)?.hits).toBe(1);
    putCached({ kind: "edoc", id: "DOC-1" }, { text: "local" });
    expect(getCached({ kind: "edoc", id: "DOC-1" })).toBeNull();
    putCached({ kind: "judgment", id: "j_x" }, { text: "local judgment" });
    expect(getCached({ kind: "judgment", id: "j_x" })).toBeNull();
    expect(getCached(ref, Date.now() + 25 * 3600 * 1000)).toBeNull();
    expect(sweepCache()).toBe(0);
  });
});

// ---- full run with fakes ------------------------------------------------------

describe("research run (fakes, no key needed)", () => {
  it("plans, runs lanes, synthesizes, verifies, corrects, cross-checks citations and persists with provenance + audit", async () => {
    const deps = fakeDeps();
    const c = collect();
    const res = await runResearch({ question: "Is a co-accused entitled to anticipatory bail on parity before the Karnataka High Court?", settings: settings(), runId: "run_t_1" }, c.send, undefined, deps);
    const types = c.types();
    for (const t of ["run.started", "plan.created", "lane.started", "source.found", "lane.completed", "synthesis.started", "answer.delta", "artifact.created", "verification.started", "verification.completed", "correction.started", "round.completed"]) expect(types, t).toContain(t);
    expect(types.some((t) => t === "run.completed" || t === "run.partial")).toBe(true);
    expect(res.aborted).toBe(false);
    expect(res.stats.rounds).toBe(1);
    expect(res.stats.sources).toBe(3);
    expect(res.stats.read).toBeGreaterThanOrEqual(3);
    expect(res.stats.agents).toBeGreaterThanOrEqual(6); // lane agents + synthesis + verifier (+ corrector)
    // library provider failed → surfaced as a lane step, never fatal
    const errLanes = c.events.filter((e): e is Extract<ResearchStreamEvent, { type: "lane.completed" }> => e.type === "lane.completed" && (e.status === "error" || !!e.error || !!e.failure));
    expect(errLanes.length).toBeGreaterThan(0);
    // correction replaced the unsupported sentence; citation integrity marked nothing else
    const msg = res.message;
    expect(msg.content).toContain("Contrary authority was not located among the sources read.");
    expect(msg.content).not.toContain("(2021) 9 SCC 999");
    expect(msg.content).not.toContain("[VERIFY]");
    expect(msg.verification?.status).toBe("partially-verified");
    expect(msg.provenance?.surface).toBe("research");
    expect(msg.provenance?.confidence).toBe(0.75);
    expect(msg.provenance?.sources.length).toBe(3);
    expect(msg.banner).toBeNull();
    expect(msg.followUps?.length).toBe(3);
    expect(msg.forum).toBe("hc-karnataka");
    expect(msg.answerLanguage).toBe("en");
    expect(Object.keys(msg.citeMap ?? {})).toEqual(["1", "2", "3"]);
    expect(deps.calls).toContain("correct");
    expect(deps.calls.filter((x) => x === "synthesize").length).toBe(1);
    // persisted: thread, run history, audit
    const thread = getThread(res.threadId)!;
    expect(thread.messages.length).toBe(2);
    expect(thread.sources.length).toBe(3);
    expect(thread.runIds).toEqual(["run_t_1"]);
    expect(listThreadSummaries(5)[0].id).toBe(res.threadId);
    const run = searchRuns().get("run_t_1")!;
    expect(run.threadId).toBe(res.threadId);
    expect(run.aiStatus).toBe("ok");
    expect(run.stats?.sources).toBe(3);
    expect(run.provenance?.verification?.supported).toBe(3);
    const au = listAudit({ action: "ai.generate", targetId: "run_t_1" });
    expect(au.length).toBe(1);
    expect(au[0].meta?.sources).toBe(3);
    expect((au[0].meta?.verification as { status: string }).status).toBe("partially-verified");
  });

  it("marks unread citations [VERIFY] when the correction pass changes nothing and keeps the conversation in the thread", async () => {
    const first = await runResearch({ question: "First question about parity", settings: settings({ sources: ["caselaw"] }), runId: "run_t_2a" }, () => {}, undefined, fakeDeps({ answer: "## Answer\nMeera Nair [1]. See Fictional v. State, (2021) 9 SCC 999.\n\n## Sources\n[1] Meera Nair v. State of Karnataka, 2023 INSC 212", correct: async (i) => i.input.split("ANSWER:\n")[1].split("\n\nSOURCES")[0] }));
    // The stored answer stays the verified text (bound to its hash); markers are derived for display and export.
    const shown = annotateAnswer(first.message, getThread(first.threadId)?.sources ?? []);
    expect(shown).toContain("(2021) 9 SCC 999 [VERIFY]");
    expect(shown).toContain("Citation check");
    expect(first.message.citations?.some((c) => c.citation === "(2021) 9 SCC 999" && !c.matched)).toBe(true);
    const c = collect();
    const second = await runResearch({ question: "And the conditions that may be imposed?", settings: settings({ sources: ["caselaw"] }), threadId: first.threadId, runId: "run_t_2b" }, c.send, undefined, fakeDeps());
    expect(second.threadId).toBe(first.threadId);
    const thread = getThread(first.threadId)!;
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(thread.runIds).toEqual(["run_t_2a", "run_t_2b"]);
    expect(setThreadPins(first.threadId, [{ id: "pin1", kind: "source", sourceId: "judgment:j_sc_meera_nair", hit: sc, addedAt: 1 }])?.pins.length).toBe(1);
  });

  it("runs a second round when coverage is thin, capped at three", async () => {
    let n = 0;
    const deps = fakeDeps({
      async retrieve(source) { n++; return source === "caselaw" ? { hits: [sc], total: 1 } : { hits: [], total: 0 }; },
      answer: "## Answer\nMeera Nair says something [1]. Parity needs an identical role. Conditions are mandatory.\n\n## Sources\n[1] Meera Nair v. State of Karnataka, 2023 INSC 212",
    });
    deps.verify = async () => ({ verdicts: [{ claim: "Meera Nair says something", status: "supported", sourceIndex: 0 }, { claim: "Parity needs an identical role", status: "unsupported", sourceIndex: null }, { claim: "Conditions are mandatory", status: "unsupported", sourceIndex: null }, { claim: "Something else entirely", status: "unsupported", sourceIndex: null }], supported: 1, unsupported: 3, contradicted: 0, score: 0.25, status: "unverified", sourceBacked: true, checkedAt: "x" });
    const c = collect();
    const res = await runResearch({ question: "thin question", settings: settings({ sources: ["caselaw", "statutes"] }), runId: "run_t_3" }, c.send, undefined, deps);
    expect(res.stats.rounds).toBe(3);
    const rounds = c.events.filter((e): e is Extract<ResearchStreamEvent, { type: "round.completed" }> => e.type === "round.completed");
    expect(rounds.map((r) => r.complete)).toEqual([false, false, true]);
    expect(rounds[0].reason).toContain("verification score 25%");
    expect(rounds[2].reason).toContain("stopping after round 3");
    expect(deps.calls.filter((x) => x === "refine").length).toBe(2);
    expect(c.events.filter((e) => e.type === "plan.created").length).toBe(3);
    expect(n).toBeGreaterThan(2);
  });

  it("degrades to retrieval-only with an explicit no-key banner and still records the run", async () => {
    const deps = fakeDeps({ hasKey: false });
    const c = collect();
    const res = await runResearch({ question: "no key question", settings: settings({ sources: ["caselaw", "statutes"] }), runId: "run_t_4" }, c.send, undefined, deps);
    expect(res.message.banner).toBe("no-api-key");
    expect(res.message.content).toBe("");
    expect(res.stats.sources).toBe(3);
    expect(res.stats.read).toBeGreaterThanOrEqual(2); // deterministic reads keep the run source-backed
    expect(res.stats.agents).toBe(0);
    expect(res.message.followUps?.length).toBe(3);
    expect(deps.calls).not.toContain("synthesize");
    expect(c.types()).not.toContain("synthesis.start");
    expect(searchRuns().get("run_t_4")?.aiStatus).toBe("no_api_key");
    expect(fallbackFollowUps("Is parity a ground for anticipatory bail?", settings(), null)[0]).toContain("the High Court of Karnataka");
  });

  it("keeps retrieval-only turns out of the review queue and re-reads prior-turn sources before a follow-up", async () => {
    const deps = fakeDeps({ hasKey: false });
    const res = await runResearch({ question: "no key provenance", settings: settings({ sources: ["caselaw"] }), runId: "run_t_7" }, () => {}, undefined, deps);
    expect(res.message.content).toBe("");
    expect(res.message.provenance).toBeUndefined(); // nothing to attest, so no TrustBadge and no queue entry
    expect(getProvenance("research", "run_t_7")).toBeNull();
    expect(res.stats.read).toBeGreaterThanOrEqual(2);
    // Follow-up in the same thread with a key, scoped to statutes only: the judgments read last turn are
    // rehydrated through deps.read even though no lane touches judgments this time.
    const deps2 = fakeDeps();
    const res2 = await runResearch({ question: "follow up", settings: settings({ sources: ["statutes"] }), runId: "run_t_8", threadId: res.threadId }, () => {}, undefined, deps2);
    expect(deps2.calls).toContain("read:judgment:j_sc_meera_nair");
    expect(deps2.calls).toContain("read:judgment:j_kar_ravi_kumar");
    expect(res2.message.provenance?.surface).toBe("research");
    expect(getProvenance("research", "run_t_8")?.model).toBe("gpt-test");
  });

  it("writes readable deterministic follow-ups bound to the forum", () => {
    expect(questionTopic("Is a co-accused entitled to anticipatory bail on parity?")).toBe("co-accused entitled to anticipatory bail on parity");
    expect(questionTopic("What is the test for anticipatory bail after Meera Nair?")).toBe("test for anticipatory bail after Meera Nair");
    expect(questionTopic("Does Section 482 BNSS apply?")).toBe("Section 482 BNSS apply");
    const f = fallbackFollowUps("Is X barred?", settings({ jurisdiction: "all-india" }), null);
    expect(f[0]).toBe("Is there a larger-bench or later Supreme Court judgment that doubts or overrules the leading authority on X barred before courts across India (no forum selected)?");
    expect(f[1]).toMatch(/^Which provisions of India Code govern X barred/);
    expect(fallbackFollowUps("Is X barred?", settings({ jurisdiction: "hc-telangana" }), null)[0]).toContain("the High Court for the State of Telangana");
    expect(fallbackFollowUps("Is X barred?", settings({ jurisdiction: "ka-subordinate" }), null)[0]).toContain("the courts in Karnataka");
  });

  it("shows the not-source-backed banner when nothing was retrieved", async () => {
    const deps = fakeDeps({ async retrieve() { return { hits: [], total: 0 }; }, answer: "**General practice (not source-backed).** Courts generally require [VERIFY].\n\n## Sources\n" });
    const res = await runResearch({ question: "nothing found", settings: settings({ sources: ["caselaw"] }), runId: "run_t_5" }, () => {}, undefined, deps);
    expect(res.message.banner).toBe("not-source-backed");
    expect(res.message.provenance?.sources.length).toBe(0);
    expect(res.message.provenance?.confidence).toBe(0);
    expect(deps.calls).not.toContain("verify");
  });

  it("aborts everything on the client signal without persisting", async () => {
    const ctrl = new AbortController();
    const deps = fakeDeps({ async retrieve() { ctrl.abort(); return { hits: [sc], total: 1 }; } });
    const c = collect();
    const res = await runResearch({ question: "abort me", settings: settings({ sources: ["caselaw"] }), runId: "run_t_6" }, c.send, ctrl.signal, deps);
    expect(res.aborted).toBe(true);
    expect(c.types()).not.toContain("answer.final");
    expect(searchRuns().get("run_t_6")).toBeNull();
    expect(deps.calls).not.toContain("synthesize");
  });
});

// ---- seeds --------------------------------------------------------------------

describe("seeded threads", () => {
  it("derives one thread per cached run with citation numbers mapped to hits", () => {
    const t = getThread("thr_seed_pfas_ftw_01")!;
    expect(t).toBeTruthy();
    expect(t.messages.length).toBe(2);
    expect(t.sources.length).toBe(7);
    expect(t.messages[1].citeMap?.[2]).toBe("caselaw:112120");
    expect(t.messages[1].provenance?.surface).toBe("research");
    expect(SEARCH_SEED_IDS.threads).toContain("thr_seed_mcl_08");
    expect(searchRuns().get("run_seed_pfas_ftw_01")?.threadId).toBe("thr_seed_pfas_ftw_01");
    const hit: SearchHit = { ...sc };
    expect(citeMapFromSynthesis("## Sources\n[1] Meera Nair v. State of Karnataka, 2023 INSC 212\n[2] nothing", [hit])).toEqual({ 1: "judgment:j_sc_meera_nair" });
  });
});
