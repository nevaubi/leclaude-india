/**
 * Research agent (LeClaude India): speed (concurrent lanes, planning and translation off the critical path),
 * accuracy (read-before-characterize, code-checked quotes in the original language, adverse lane, explicit no-answer),
 * tools (resolve_citation, fetch allowlist, build_citation, compare_authorities, read_judgment) and output (memo, TOA,
 * Send to Word). Fakes only (fictional judgments from evals/india-research/fixtures.ts); no network model calls.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import type { ToolDef } from "@/lib/ai/tools";
import { isIndianLegalFetchHost } from "@/lib/ai/toolkit/india";
import { runResearch, mergeSubQuestions, researchWallMs } from "@/modules/search/engine/run";
import { planLanes, planSubQuestions, contraryQuery, ADVERSE_SUBQUESTION_MARK } from "@/modules/search/engine/planner";
import { buildLaneTools, rankForReading } from "@/modules/search/engine/lanes";
import { createReadRegistry, cacheKey } from "@/modules/search/engine/cache";
import { resolvePolicy } from "@/modules/search/engine/runtime";
import { sourceFromHit } from "@/modules/search/engine/sources";
import { checkClaimEvidence, answerQuotations } from "@/modules/search/engine/quotes";
import { focusParagraphs, splitParagraphs, quoteExists, paragraphOfQuote } from "@/modules/search/engine/paragraphs";
import { parseCiteMarkers, citedNumbers } from "@/modules/search/engine/markers";
import { buildEvidenceBlocks, evidenceSourceId } from "@/modules/search/engine/evidence";
import { classifyTreatment, currentnessOf, INDIAN_NEGATIVE_TREATMENT_PHRASES } from "@/modules/search/engine/treatment";
import { compareAuthorities, tableOfAuthorities } from "@/modules/search/engine/authorities";
import { NO_ANSWER_SENTENCE, synthesisInstructions } from "@/modules/search/engine/prompts";
import { messageTrustState, sourceTrustState } from "@/modules/search/engine/trust";
import type { EngineDeps, ResearchPlan } from "@/modules/search/engine/deps";
import type { AuthorityTreatment, ResearchLane, ResearchSource, ResearchStreamEvent } from "@/modules/search/engine/types";
import { buildResearchMemo, sourcesForMessage } from "@/modules/search/memo";
import { sendResearchToWord, researchToaMarkdown } from "@/modules/search/export";
import { getThread } from "@/modules/search/engine/threads";
import { sanitizeSettings } from "@/modules/search/service";
import type { SearchHit, SearchSettings } from "@/modules/search/types";
import { BNSS_482, BOM_HC, forHit, indiaFakeDeps, IPC_420, KAR_HC, SC_BAIL, SC_BAIL_TEXT, TEXTS, TS_HC, verification } from "../evals/india-research/fixtures";

beforeAll(() => { resetSqlite(); db(); });

const settings = (over: Partial<SearchSettings> = {}) => sanitizeSettings({ sources: ["caselaw", "statutes", "library"], jurisdiction: "hc-karnataka", ...over });
const fakeDeps = indiaFakeDeps;
const sc = forHit(SC_BAIL, "hc-karnataka");
const kar = forHit(KAR_HC, "hc-karnataka");
const bom = forHit(BOM_HC, "hc-karnataka");

function collect() {
  const t0 = Date.now();
  const events: { t: number; e: ResearchStreamEvent }[] = [];
  return { events, send: (e: ResearchStreamEvent) => { events.push({ t: Date.now() - t0, e }); }, of: <T extends ResearchStreamEvent["type"]>(type: T) => events.filter((x) => x.e.type === type) as { t: number; e: Extract<ResearchStreamEvent, { type: T }> }[] };
}

// ---- planning -------------------------------------------------------------------

describe("planner: adverse lane and forum-aware sub-questions", () => {
  it("always plans an adverse lane in deep mode that starts at once (soft dependency), not after the binding lane", () => {
    const lanes = planLanes({ question: "Can anticipatory bail be refused only because the offence is economic?", settings: settings(), mode: "deep", hasMatter: false });
    const contrary = lanes.find((l) => l.kind === "contrary")!;
    expect(contrary).toBeTruthy();
    expect(contrary.queries[0]).toBe(contraryQuery(lanes[0].queries[0]));
    expect(contrary.after).toEqual(["lane_controlling_r1"]);
    expect(contrary.dependsOn).toBeUndefined();
    expect(contrary.tools).toEqual(expect.arrayContaining(["citing_references", "read_judgment", "resolve_citation"]));
  });
  it("writes forum-aware sub-questions that include adverse authority, and keeps it when the model plan drops it", () => {
    const qs = planSubQuestions({ question: "Is a co-accused entitled to anticipatory bail on parity?", settings: settings(), mode: "deep", hasMatter: false });
    expect(qs[0]).toContain("the High Court of Karnataka");
    expect(qs[0]).toContain("bench strength");
    expect(qs.some((q) => q.includes(ADVERSE_SUBQUESTION_MARK))).toBe(true);
    expect(qs.some((q) => /BNS\/BNSS\/BSA/.test(q))).toBe(true);
    const merged = mergeSubQuestions(qs, ["What test governs parity in anticipatory bail before the Karnataka High Court?", "Does Section 482 BNSS permit conditions?"]);
    expect(merged.some((q) => q.includes(ADVERSE_SUBQUESTION_MARK))).toBe(true);
    // Fast mode asks the adverse-authority question too (a fast answer is not exempt from contrary authority).
    const fastQs = planSubQuestions({ question: "q", settings: settings(), mode: "fast", hasMatter: false });
    expect(fastQs).toHaveLength(2);
    expect(fastQs[1]).toContain(ADVERSE_SUBQUESTION_MARK);
  });
});

// ---- speed: concurrency, planning off the critical path, metrics -------------------

describe("run speed (fake latency)", () => {
  it("starts every lane at once, keeps planning off the critical path, uses plan queries, targets the binding lane's judgments, and records the §36 metrics", async () => {
    const plan: ResearchPlan = { subQuestions: ["What do the Supreme Court and the Karnataka High Court hold on refusing anticipatory bail for economic offences?", "Which judgments distinguish or doubt Meera Nair?"], queries: { controlling: ["anticipatory bail parity economic offence"] } };
    const deps = fakeDeps({ latency: { retrieve: 120, read: 80, agent: 150, plan: 260, synth: 60 }, plan });
    const c = collect();
    const res = await runResearch({ question: "Can anticipatory bail be refused only because the offence is economic?", settings: settings(), runId: "run_speed_1" }, c.send, undefined, deps);
    const starts = c.of("lane.started").map((x) => x.t);
    expect(starts.length).toBe(5);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(60); // the adverse lane does not wait for the binding lane
    const done = c.of("lane.completed");
    const sumLaneMs = done.reduce((a, x) => a + x.e.durationMs, 0);
    const window = Math.max(...done.map((x) => x.t)) - Math.min(...starts);
    expect(window).toBeLessThan(sumLaneMs * 0.6); // lanes overlap
    // planning ran on the side: the first evidence arrived before the plan finished
    const planDone = c.of("tool.completed").find((x) => x.e.name === "plan_research")!;
    const firstFound = c.of("source.found")[0];
    expect(firstFound.t).toBeLessThan(planDone.t);
    expect(deps.queries).toContain("caselaw|sci hc-karnataka|anticipatory bail parity economic offence");
    // the adverse lane's second wave targets what the binding lane found
    expect(deps.queries.some((q) => q.startsWith("caselaw||\"Meera Nair v. State of Karnataka\" AND (distinguish*"))).toBe(true);
    // the binding lane only searched binding courts; the persuasive lane only other High Courts
    expect(deps.queries.filter((q) => q.startsWith("caselaw|sci hc-karnataka|")).length).toBeGreaterThan(0);
    expect(deps.queries.some((q) => /^caselaw\|[^|]*hc-telangana[^|]*\|/.test(q) && !q.includes("hc-karnataka"))).toBe(true);
    const m = res.metrics;
    for (const k of ["acknowledgedMs", "firstEvidenceMs", "firstReadMs", "firstModelTokenMs", "firstSourceBackedMs", "finalAnswerMs", "verifiedAnswerMs"] as const) expect(m[k], k).not.toBeNull();
    expect(m.firstEvidenceMs!).toBeLessThanOrEqual(m.firstModelTokenMs!);
    expect(m.firstModelTokenMs!).toBeLessThanOrEqual(m.finalAnswerMs!);
    expect(m.modelCalls).toBeGreaterThanOrEqual(3);
    expect(res.message.subQuestions?.[0]).toBe(plan.subQuestions[0]);
    expect(res.message.subQuestions?.some((q) => /distinguish or doubt/.test(q))).toBe(true);
  });

  it("keeps the synthesis prefix byte-stable across questions, forums and matters and passes citation-native evidence with stable ids", async () => {
    const a = fakeDeps();
    const originalRead = a.read.bind(a);
    // The deterministic reader now fills skipped reads. Simulate a genuinely unavailable text instead.
    a.read = async (ref, opts) => { if (ref.kind === "judgment" && ref.id === "j_bom_anil_patil") throw Object.assign(new Error("Text unavailable"), { status: 404 }); return originalRead(ref, opts); };
    await runResearch({ question: "First question about parity", settings: settings(), runId: "run_cache_a" }, () => {}, undefined, a);
    const matter = db().matters.all()[0];
    const b = fakeDeps();
    await runResearch({ question: "A different question entirely?", settings: settings({ matterId: matter?.id ?? null, jurisdiction: "hc-telangana" }), runId: "run_cache_b" }, () => {}, undefined, b);
    expect(a.synth[0].instructions).toBe(b.synth[0].instructions);
    expect(a.synth[0].instructions).toContain("## Question Presented");
    expect(a.synth[0].instructions).toContain("Art. 141");
    expect(a.synth[0].instructions).not.toMatch(/Bluebook|U\.S\.C\.|circuit/i);
    expect(synthesisInstructions("fast", "Firm")).not.toBe(synthesisInstructions("deep", "Firm"));
    expect(a.synth[0].instructions).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no date in the cached prefix
    const ev = a.synth[0].evidence;
    const bySource = new Map(ev.map((e) => [e.source, e]));
    expect(bySource.has("judgment://sci/j_sc_meera_nair")).toBe(true);
    expect(bySource.has("statute://bnss-2023/s/482")).toBe(true);
    ev.forEach((e, i) => expect(e.title.startsWith(`Source ${i + 1} — `)).toBe(true));
    const scBlock = bySource.get("judgment://sci/j_sc_meera_nair")!;
    expect(scBlock.title).toContain("READ IN FULL");
    expect(scBlock.title).toContain("court: SC");
    expect(scBlock.title).toContain("3-judge bench");
    expect(scBlock.title).toContain("decided 14 March 2023");
    expect(scBlock.title).toContain("2023 INSC 212 : (2023) 5 SCC 301");
    expect(scBlock.title).toContain("BINDING on the forum");
    expect(scBlock.title).toContain("treatment not checked");
    expect(scBlock.content.join("\n")).toContain(`¶6 ${splitParagraphs(SC_BAIL_TEXT)[5]}`);
    const tsBlock = bySource.get("judgment://hc-telangana/j_ts_syed_imran")!;
    expect(tsBlock.title).toContain("PERSUASIVE for the forum");
    const bomBlock = bySource.get("judgment://hc-bombay/j_bom_anil_patil")!;
    expect(bomBlock.title).toContain("NOT READ — SEARCH SNIPPET ONLY");
    expect(bomBlock.content[0]).toMatch(/^\(not read — search snippet only/);
    // for the Telangana forum, the Karnataka judgment is persuasive and the Telangana one binding
    const tsForum = new Map(b.synth[0].evidence.map((e) => [e.source, e]));
    expect(tsForum.get("judgment://hc-karnataka/j_kar_ravi_kumar")?.title).toContain("PERSUASIVE for the forum");
    expect(tsForum.get("judgment://hc-telangana/j_ts_syed_imran")?.title).toContain("BINDING on the forum");
    // documents first (runtime prepends evidence), forum and answer language in the user turn, question last
    const text = JSON.stringify(a.synth[0].input);
    expect(text).toContain("Forum: High Court of Karnataka");
    expect(text).toContain("Answer language: English.");
    expect(text.lastIndexOf("Research question: First question about parity")).toBeGreaterThan(text.indexOf("Today's date"));
  });
});

// ---- accuracy ----------------------------------------------------------------------

describe("read before characterize and code-checked quotes", () => {
  const read = (h: SearchHit, n: number): ResearchSource => ({ ...sourceFromHit(h, "l"), n, read: true });
  const unread = (h: SearchHit, n: number): ResearchSource => ({ ...sourceFromHit(h, "l"), n, read: false });
  const textOf = (s: ResearchSource) => TEXTS[cacheKey(s.hit.readRef!)];

  it("only read sources can support a claim; a quote not in the source is demoted; answer quotations are checked", () => {
    const sources = [read(sc, 1), unread(kar, 2)];
    const r = checkClaimEvidence(
      "Meera Nair holds that “anticipatory bail cannot be refused only because the offence is economic in nature” [1 ¶6]. The Court said “economic offenders are always entitled to bail” [1]. Ravi Kumar held “parity is automatic for every co-accused” [2].",
      [
        { claim: "Anticipatory bail cannot be refused only because the offence is economic", status: "supported", sourceN: 1, quote: "anticipatory bail cannot be refused only because the offence is economic in nature" },
        { claim: "Economic offenders are always entitled to bail", status: "supported", sourceN: 1, quote: "economic offenders are always entitled to bail" },
        { claim: "Parity is automatic", status: "supported", sourceN: 2, quote: "entitled to parity" },
      ],
      sources,
      textOf,
    );
    expect(r.verdicts[0].status).toBe("supported");
    expect(r.verdicts[0].quoteVerified).toBe(true);
    expect(r.verdicts[0].paragraph).toBe(6);
    expect(r.verdicts[1].status).toBe("unsupported");
    expect(r.verdicts[1].note).toContain("does not appear");
    expect(r.verdicts[2].status).toBe("unsupported");
    expect(r.verdicts[2].note).toContain("not read in full");
    expect(r.demoted).toBe(2);
    expect(r.misquotes).toBe(2); // "always entitled" (not in [1]) and the quotation from unread [2]
    expect(answerQuotations("He wrote “one two three four” [3].")).toEqual([{ quote: "one two three four", n: 3 }]);
    expect(quoteExists(SC_BAIL_TEXT, "[A]nticipatory bail cannot be refused … economic in nature")).toBe(true);
    expect(paragraphOfQuote(SC_BAIL_TEXT, "We hold that anticipatory bail")).toBe(6);
  });

  it("demotes a misquote during the run, corrects the answer and re-verifies the revised hash", async () => {
    const answer = "## Short Answer\nMeera Nair holds that “anticipatory bail cannot be refused only because the offence is economic in nature” [1 ¶6].\n\n## Analysis\nThe Court said “economic offenders are always entitled to bail” [1].";
    let pass = 0;
    const deps = fakeDeps({
      answer,
      verify: async () => { pass++; return verification(pass === 1 ? [{ claim: "Anticipatory bail cannot be refused only because the offence is economic", status: "supported", sourceIndex: 0, quote: "anticipatory bail cannot be refused only because the offence is economic in nature" }, { claim: "Economic offenders are always entitled to bail", status: "supported", sourceIndex: 0, quote: "economic offenders are always entitled to bail" }] : [{ claim: "Anticipatory bail cannot be refused only because the offence is economic", status: "supported", sourceIndex: 0, quote: "anticipatory bail cannot be refused only because the offence is economic in nature" }]); },
      correct: async (i) => i.input.split("ANSWER:\n")[1].split("\n\nSOURCES")[0].replace("The Court said “economic offenders are always entitled to bail” [1].", "The Court required the accusation and the antecedents to be weighed [1 ¶6]."),
    });
    const c = collect();
    const res = await runResearch({ question: "Misquote test", settings: settings({ sources: ["caselaw"] }), runId: "run_quote_1" }, c.send, undefined, deps);
    const unsupported = c.of("claim.unsupported").map((x) => x.e);
    expect(unsupported.some((u) => /does not appear/.test(u.note ?? ""))).toBe(true);
    expect(c.of("correction.started").length).toBe(1);
    expect(res.message.content).not.toContain("always entitled");
    expect(res.message.verification?.pass).toBe(2);
    expect(res.message.verification?.artifactHash).toBe(res.message.artifactHash);
    expect(res.message.verification?.unsupported).toBe(0);
    expect(res.message.verification?.verdicts?.[0].paragraph).toBe(6);
  });

  it("citation exists but does not support the proposition → resolved citation, unsupported claim, never 'verified'", async () => {
    const answer = "## Short Answer\nMeera Nair v. State of Karnataka, (2023) 5 SCC 301 [1], holds that anticipatory bail is barred in every cheating case.";
    const deps = fakeDeps({ answer, verify: async () => verification([{ claim: "Meera Nair holds that anticipatory bail is barred in every cheating case", status: "unsupported", sourceIndex: 0, note: "Meera Nair says the opposite for economic offences" }]) });
    const res = await runResearch({ question: "Is anticipatory bail barred in cheating cases?", settings: settings({ sources: ["caselaw"] }), runId: "run_nosupport_1" }, () => {}, undefined, deps);
    const m = res.message;
    expect(m.citations?.find((x) => x.citation === "(2023) 5 SCC 301")?.state).toBe("resolved");
    expect(m.verification?.unsupported).toBe(1);
    expect(m.trust).not.toBe("verified");
    const thread = getThread(res.threadId)!;
    const numbered = sourcesForMessage(m, thread.sources);
    const b = numbered.find((s) => s.id === "judgment:j_sc_meera_nair")!;
    expect(sourceTrustState(b, { artifactHash: m.artifactHash, verification: m.verification })).toBe("claim_checked");
    expect(messageTrustState(m, numbered)).not.toBe("verified");
    expect(buildResearchMemo({ question: "q", message: m, sources: thread.sources })).toContain("Unsupported: Meera Nair holds that anticipatory bail is barred in every cheating case [1]");
  });

  it("no answer in the record → explicit 'do not establish' answer, no model synthesis, no invented authority", async () => {
    const matter = db().matters.all()[0];
    const deps = fakeDeps({ retrieve: async () => ({ hits: [], total: 0 }) });
    const res = await runResearch({ question: "Did the Tahsildar approve the 2019 mutation entry?", settings: settings({ sources: ["ediscovery"], matterId: matter.id, fast: true }), runId: "run_noanswer_1" }, () => {}, undefined, deps);
    expect(res.message.noAnswer).toBe(true);
    expect(res.message.content).toContain(NO_ANSWER_SENTENCE);
    expect(res.message.content).toContain(`the ${matter.shortName} record`);
    expect(deps.calls).not.toContain("synthesize");
    expect(citedNumbers(res.message.content).size).toBe(0);
    expect(res.terminal).toBe("partial");
    expect(res.stop).toBe("source_unavailable");
    expect(res.message.banner).toBe("not-source-backed");
    const deep = fakeDeps({ retrieve: async () => ({ hits: [], total: 0 }) });
    const r2 = await runResearch({ question: "Is there any authority on drone trespass over agricultural land?", settings: settings({ sources: ["caselaw"] }), runId: "run_noanswer_2" }, () => {}, undefined, deep);
    expect(r2.stats.rounds).toBe(3); // broadened twice before saying so
    expect(r2.message.noAnswer).toBe(true);
    expect(r2.message.content).toContain("the Supreme Court and High Court judgment corpus");
  });
});

// ---- treatment, currentness, evidence ------------------------------------------------

describe("authority treatment and currentness", () => {
  it("classifies negative citing language (Indian vocabulary) as 'possibly negative, review' and never as good law", () => {
    const neg = classifyTreatment({ citing: [{ title: "X v. Y", snippet: "Meera Nair was held per incuriam on this point." }], citingCount: 12 }, undefined, { basis: "corpus", phrases: INDIAN_NEGATIVE_TREATMENT_PHRASES });
    expect(neg.signal).toBe("possibly_negative");
    expect(neg.basis).toBe("corpus");
    expect(neg.note).toMatch(/^Treatment: possibly negative, review/);
    expect(neg.note).toContain("citing judgment");
    const none = classifyTreatment({ citing: [{ title: "A v. B", snippet: "Following Meera Nair, the petition is allowed." }], citingCount: 1 }, undefined, { basis: "corpus", phrases: INDIAN_NEGATIVE_TREATMENT_PHRASES });
    expect(none.signal).toBe("no_negative_signal");
    expect(none.note).toContain("not a citator");
    expect(`${neg.note} ${none.note}`).not.toMatch(/good law(?! )/);
    const now = Date.UTC(2026, 8, 28);
    expect(currentnessOf({ kind: "caselaw", date: "1980-04-09", hit: sc }, now).flag).toBe("dated");
    expect(currentnessOf({ kind: "caselaw", date: sc.date, hit: sc }, now).flag).toBe("current");
    const ipc = currentnessOf({ kind: "statutes", date: IPC_420.date, hit: IPC_420 }, now);
    expect(ipc.flag).toBe("dated");
    expect(ipc.label).toContain("Bharatiya Nyaya Sanhita");
    expect(currentnessOf({ kind: "statutes", date: BNSS_482.date, hit: BNSS_482 }, now).flag).toBe("current");
  });

  it("checks treatment of read judgments while lanes run and labels the evidence the model sees", async () => {
    const t: AuthorityTreatment = classifyTreatment({ citing: [{ title: "Union of India v. Kavitha Reddy", snippet: "Meera Nair was doubted and referred to a larger bench" }] }, undefined, { basis: "corpus", phrases: INDIAN_NEGATIVE_TREATMENT_PHRASES });
    const seen: string[] = [];
    const deps = fakeDeps({ citing: async ({ judgmentId }) => { seen.push(judgmentId ?? ""); return judgmentId === "j_sc_meera_nair" ? t : classifyTreatment({ citing: [] }); } });
    const res = await runResearch({ question: "Treatment test", settings: settings({ sources: ["caselaw"] }), runId: "run_treat_1" }, () => {}, undefined, deps);
    expect(seen).toContain("j_sc_meera_nair");
    const b = res.sources.find((s) => s.id === "judgment:j_sc_meera_nair")!;
    expect(b.treatment?.signal).toBe("possibly_negative");
    expect(deps.synth[0].evidence.find((e) => e.source === "judgment://sci/j_sc_meera_nair")?.title).toContain("TREATMENT: POSSIBLY NEGATIVE, REVIEW");
  });

  it("focuses long sources on the paragraphs that match, keeping reader numbering; stable evidence ids", () => {
    const text = Array.from({ length: 60 }, (_, i) => (i === 36 ? "Parity requires an identical role of the co-accused." : `Paragraph ${i + 1} about procedure and unrelated background facts that fill space.`.repeat(3))).join("\n");
    const focused = focusParagraphs(text, ["parity", "co-accused"], { maxChars: 1200 });
    expect(focused.map((p) => p.n)).toContain(37);
    expect(focused[0].n).toBe(1);
    const blocks = buildEvidenceBlocks([{ ...sourceFromHit(sc, "l"), n: 1, read: true }], () => text, { terms: ["parity"], maxCharsPerSource: 1200 });
    expect(blocks[0].content.join("\n")).toContain("¶37 Parity requires");
    expect(evidenceSourceId({ ...sourceFromHit({ id: "ediscovery:D1", source: "ediscovery", title: "memo", readRef: { kind: "edoc", id: "D1" } }, "l") }, { matterId: "m_1" })).toBe("matter://m_1/document/D1");
    expect(evidenceSourceId(sourceFromHit(sc, "l"))).toBe("judgment://sci/j_sc_meera_nair");
    expect(evidenceSourceId(sourceFromHit(BNSS_482, "l"))).toBe("statute://bnss-2023/s/482");
    expect(evidenceSourceId(sourceFromHit({ id: "judgment:u1", source: "caselaw", title: "x", readRef: { kind: "judgment", id: "u1" }, india: { courtId: null, unresolvedCourt: "99_9" } }, "l"))).toBe("judgment://unresolved/u1");
    expect(evidenceSourceId(sourceFromHit({ id: "ik:123", source: "caselaw", title: "x", readRef: { kind: "url", url: "ik://123" } }, "l"))).toBe("authority://indiankanoon/doc/123");
    // Official publications keep their own stable, server-resolvable reference.
    expect(evidenceSourceId(sourceFromHit({ id: "official:sebi-orders_9f3a1c2b7e#p3", source: "regulations", title: "SEBI order", readRef: { kind: "url", url: "src://sebi-orders_9f3a1c2b7e#p3" } }, "l"))).toBe("src://sebi-orders_9f3a1c2b7e#p3");
  });

  it("parses plain and pinpoint markers", () => {
    expect(parseCiteMarkers("See [1 ¶12] and [2, ¶3-4] and [3].").map((m) => [m.n, m.paragraph])).toEqual([[1, 12], [2, 3], [3, undefined]]);
  });
});

// ---- tools --------------------------------------------------------------------------

describe("research tools", () => {
  const laneCtx = (deps: EngineDeps, s: SearchSettings = settings()) => ({ question: "q", settings: s, matter: null, deps, emit: () => {}, texts: new Map<string, string>(), reads: createReadRegistry(), known: [], policy: resolvePolicy("deep"), priors: [] });
  const lane = (kind: ResearchLane["kind"], tools: string[]): ResearchLane => ({ id: `lane_${kind}_r1`, kind, name: kind, brief: "", sources: ["caselaw"], tools, queries: ["q"], maxSteps: 3, maxReads: 3, round: 1 });

  it("lane tools: unresolved citations are returned as such, the Indian fetch allowlist holds without web scope, matter tools need a matter", async () => {
    const deps = fakeDeps();
    deps.resolveCitation = async (citation) => ({ citation, state: "unresolved", reason: "no judgment in the corpus carries this citation" });
    const record = vi.fn();
    const tools = buildLaneTools(lane("controlling", ["resolve_citation", "fetch_url", "build_citation", "compare_authorities", "search_matter_documents", "read_judgment", "map_criminal_section"]), laneCtx(deps), { found: new Map([[sc.id, { ...sourceFromHit(sc, "l"), read: true }]]), record, readOne: async () => SC_BAIL_TEXT });
    const byName = new Map(tools.map((t) => [t.name, t as unknown as ToolDef<Record<string, unknown>, unknown>]));
    expect(byName.has("search_matter_documents")).toBe(false);
    expect(await byName.get("resolve_citation")!.execute({ citation: "(2021) 9 SCC 999" }, { emit: () => {}, state: {} })).toMatchObject({ state: "unresolved" });
    expect(record).not.toHaveBeenCalled();
    await expect(Promise.resolve().then(() => byName.get("fetch_url")!.execute({ url: "https://example.com/blog" }, { emit: () => {}, state: {} }))).rejects.toThrow(/not an allowlisted official legal source/);
    await expect(Promise.resolve().then(() => byName.get("fetch_url")!.execute({ url: "https://www.scconline.com/x" }, { emit: () => {}, state: {} }))).rejects.toThrow(/not an allowlisted/); // subscription services are never read
    expect(isIndianLegalFetchHost("https://www.indiacode.nic.in/handle/1")).toBe(true);
    // India Code moved to indiacode.gov.in (DSpace 9); both hosts are official and allowlisted.
    expect(isIndianLegalFetchHost("https://indiacode.gov.in/handle/123456789/496413")).toBe(true);
    expect(isIndianLegalFetchHost("https://evil-indiacode.gov.in.example.com/")).toBe(false);
    expect(isIndianLegalFetchHost("https://judgments.ecourts.gov.in/x")).toBe(true);
    expect(isIndianLegalFetchHost("https://evil-indiacode.nic.in.example.com/")).toBe(false);
    expect(isIndianLegalFetchHost("ftp://indiacode.nic.in/x")).toBe(false);
    const para = (await byName.get("read_judgment")!.execute({ source_id: sc.id, start_paragraph: 5, count: 2 }, { emit: () => {}, state: {} })) as { paragraphs: { n: number; text: string }[] };
    expect(para.paragraphs.map((p) => p.n)).toEqual([5, 6]);
    expect(await byName.get("build_citation")!.execute({ fields: { type: "case", caseName: "Meera Nair vs State of Karnataka", neutral: "2023 INSC 212", reporters: ["(2023) 5 SCC 301"], pinpoint: 3 } }, { emit: () => {}, state: {} })).toMatchObject({ citation: "Meera Nair v. State of Karnataka, 2023 INSC 212 : (2023) 5 SCC 301, para 3", short: "Meera Nair (supra)" });
    expect(((await byName.get("build_citation")!.execute({ fields: { type: "case", caseName: "A v. B", reporters: ["(2023) 99 XYZ 1"] } }, { emit: () => {}, state: {} })) as { citation: string | null }).citation).toBeNull();
    expect(await byName.get("build_citation")!.execute({ fields: { type: "statute", enactment: "Bharatiya Nagarik Suraksha Sanhita", year: 2023, sections: ["482"] } }, { emit: () => {}, state: {} })).toMatchObject({ citation: "Section 482 of the Bharatiya Nagarik Suraksha Sanhita, 2023" });
    expect(await byName.get("map_criminal_section")!.execute({ code: "IPC", section: "420", offence_date: "2024-03-15" }, { emit: () => {}, state: {} })).toMatchObject({ status: "mapped", candidates: [{ code: "BNS", section: "318(4)" }], applicable: { family: "substantive", code: "IPC" } });
  });

  it("compare_authorities states holdings only for sources read in full, and reading ranks binding and larger benches first", () => {
    const rows = compareAuthorities([{ ...sourceFromHit(sc, "l"), n: 1, read: true }, { ...sourceFromHit(bom, "l"), n: 2, read: false }], () => SC_BAIL_TEXT);
    expect(rows[0].holdings[0]).toMatchObject({ paragraph: 6 });
    expect(rows[0].court).toBe("SC");
    expect(rows[0].weight).toBe("binding");
    expect(rows[1].holdings).toEqual([]);
    expect(rows[1].note).toContain("Not read");
    expect(rankForReading([sourceFromHit(bom, "l"), sourceFromHit(kar, "l"), sourceFromHit(sc, "l")], ["bail"]).map((s) => s.id)).toEqual(["judgment:j_sc_meera_nair", "judgment:j_kar_ravi_kumar", "judgment:j_bom_anil_patil"]);
  });
});

// ---- output ---------------------------------------------------------------------------

describe("memo, table of authorities and Send to Word", () => {
  it("builds the memo and the Indian-style TOA from the stored answer and creates a Word document bound to the answer hash", async () => {
    const deps = fakeDeps({ judgments: [SC_BAIL], answer: "## Question Presented\nWhether economic nature alone justifies refusal.\n\n## Short Answer\nNo [1 ¶6].\n\n## Analysis\nThe Supreme Court held that “anticipatory bail cannot be refused only because the offence is economic in nature” [1 ¶6]. Section 482 BNSS governs [2].\n\n## Contrary Authority\nNo contrary authority was found among the sources reviewed.\n\n## Open Issues\n- None.\n\n## Sources\n[1] Meera Nair v. State of Karnataka, 2023 INSC 212 : (2023) 5 SCC 301\n[2] Section 482 of the Bharatiya Nagarik Suraksha Sanhita, 2023" });
    const res = await runResearch({ question: "Can anticipatory bail be refused only because the offence is economic?", settings: settings({ sources: ["caselaw", "statutes"] }), runId: "run_word_1" }, () => {}, undefined, deps);
    const thread = getThread(res.threadId)!;
    const memo = buildResearchMemo({ question: "Can anticipatory bail be refused only because the offence is economic?", message: res.message, sources: thread.sources, jurisdictionLabel: "High Court of Karnataka" });
    for (const h of ["## Question Presented", "## Short Answer", "## Analysis", "## Contrary Authority", "## Open Issues", "## Sources", "## Table of Authorities", "### Supreme Court of India", "### Constitution and statutes", "### Pinpoints used in this answer"]) expect(memo, h).toContain(h);
    expect(memo).toContain("**Forum:** High Court of Karnataka");
    expect(memo).not.toMatch(/Bluebook|U\.S\. /);
    expect(memo).toMatch(/\| 1 \| Meera Nair v\. State of Karnataka, 2023 INSC 212 : \(2023\) 5 SCC 301.*\| (Verified|Claim-checked|Source-backed) \|/);
    expect(memo).toContain("- Meera Nair v. State of Karnataka, 2023 INSC 212 : (2023) 5 SCC 301");
    expect(memo).toContain("Bharatiya Nagarik Suraksha Sanhita, 2023 — s. 482");
    expect(memo).toContain("[1] ¶6");
    const toa = tableOfAuthorities(res.message.content, sourcesForMessage(res.message, thread.sources));
    expect(toa.map((e) => e.group)).toEqual(["Cases", "Statutes"]);
    expect(researchToaMarkdown(res.threadId)).toContain("Authorities cited");
    const { doc } = sendResearchToWord({ threadId: res.threadId });
    const stored = db().officeDocs.get(doc.id)!;
    expect(stored.kind).toBe("word");
    expect(stored.meta?.artifactHash).toBe(res.message.artifactHash);
    expect(JSON.stringify(stored.content)).toContain("Question Presented");
    expect(JSON.stringify(stored.content)).toContain("Table of Authorities");
    expect(() => sendResearchToWord({ threadId: "thr_missing" })).toThrow(/Thread not found/);
    void TS_HC;
  });
});

// ---- time budget -------------------------------------------------------------------

describe("run wall (serverless limit)", () => {
  /** A synthesis that streams part of the answer and then stalls until its stage signal fires. */
  const stalling = (partial: string): EngineDeps["synthesize"] => async (input) => {
    input.onDelta(partial);
    await new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (input.signal?.aborted) fail();
      input.signal?.addEventListener("abort", fail, { once: true });
    });
    return partial;
  };
  const QUESTION = "Can anticipatory bail be refused only because the offence is economic?";

  it("defaults under the 300s function limit and honours RESEARCH_WALL_MS only when sane", () => {
    expect(researchWallMs({})).toBe(280_000);
    expect(researchWallMs({})).toBeLessThan(300_000);
    expect(researchWallMs({ RESEARCH_WALL_MS: "600000" })).toBe(600_000);
    expect(researchWallMs({ RESEARCH_WALL_MS: "5000" })).toBe(280_000);
    expect(researchWallMs({ RESEARCH_WALL_MS: "abc" })).toBe(280_000);
  });

  it("keeps a streamed partial answer when synthesis hits its deadline and ends as budget_exhausted, not failed", async () => {
    const deps = Object.assign(fakeDeps(), { wallMs: 2_000 });
    deps.synthesize = stalling("## Short Answer\nThe gravity of an economic offence is one factor, not a bar [1].");
    const t0 = Date.now();
    const res = await runResearch({ question: QUESTION, settings: settings(), runId: "run_wall_partial" }, () => {}, undefined, deps);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(res.message.content).toContain("one factor, not a bar");
    expect(res.message.content).toContain("cut short by the run's time limit");
    expect(res.terminal).toBe("budget_exhausted");
    expect(res.stop).toBe("hard_limit");
  });

  it("reports a timeout failure when synthesis produced nothing before the deadline", async () => {
    const deps = Object.assign(fakeDeps(), { wallMs: 1_500 });
    deps.synthesize = stalling("");
    const res = await runResearch({ question: QUESTION, settings: settings(), runId: "run_wall_empty" }, () => {}, undefined, deps);
    expect(res.terminal).toBe("failed");
    expect(res.failure).toBe("timeout");
  });

  it("a client cancel during synthesis is still a cancel, not a timeout", async () => {
    const deps = fakeDeps();
    deps.synthesize = stalling("Partial");
    const ctrl = new AbortController();
    const res = await runResearch({ question: QUESTION, settings: settings(), runId: "run_wall_cancel" }, (e) => { if (e.type === "answer.delta") ctrl.abort(); }, ctrl.signal, deps);
    expect(res.terminal).toBe("cancelled");
  });
});
