/**
 * India research recall and citation accuracy: query expansion (IPC↔BNS, CrPC↔BNSS, IEA↔BSA, Act names, citation
 * forms), the fast-mode adverse lane, the transition note, hybrid judgment retrieval (RRF order, honest keyword-only
 * fallback), the issue-level reranker (bounded, deterministic, falls back), judgment embeddings (tiers, on-access queue),
 * filters, the authority status table (unresolved never substituted; metadata-only never supported) and the citation
 * string extractor. Offline: fakes only.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { db, resetSqlite } from "@/lib/db";
import { expandIndianQuery, sectionFilter } from "@/lib/india/query-expansion";
import { transitionFactsFromText, transitionNote } from "@/lib/india/transition";
import { extractAuthorityCitations } from "@/lib/india/citation-strings";
import { planLanes, planSubQuestions, ADVERSE_SUBQUESTION_MARK, LANE_TIMEOUT } from "@/modules/search/engine/planner";
import { runResearch } from "@/modules/search/engine/run";
import { DEFAULT_POLICY, FAST_POLICY } from "@/modules/search/engine/runtime";
import { rerankOrder, rerankSources, RERANK_TOP_N, type RerankScorer } from "@/modules/search/engine/rerank";
import { buildAuthorityStatus } from "@/modules/search/engine/authority-status";
import { checkClaimEvidence } from "@/modules/search/engine/quotes";
import { numberSources, sourceFromHit } from "@/modules/search/engine/sources";
import { searchJudgmentTextHybrid, resetHybridCachesForTests } from "@/modules/india/corpus/hybrid";
import { priorityCourts, requestJudgmentEmbedding, runJudgmentEmbedding, tierFor } from "@/modules/india/corpus/embeddings";
import { corpusFilters } from "@/modules/india/corpus/search";
import { resetTextTableCacheForTests } from "@/modules/india/corpus/text";
import { sanitizeSettings } from "@/modules/search/service";
import type { ResearchSource } from "@/modules/search/engine/types";
import type { SearchHit, SearchSettings } from "@/modules/search/types";
import { indiaFakeDeps, SC_ADVERSE, SC_BAIL, KAR_HC } from "../evals/india-research/fixtures";

beforeAll(() => { resetSqlite(); db(); });

const settings = (over: Partial<SearchSettings> = {}) => sanitizeSettings({ sources: ["caselaw", "statutes"], jurisdiction: "hc-karnataka", ...over });

describe("Indian query expansion", () => {
  it("maps new code sections to the old ones and back (BNSS 482 ↔ CrPC 438, IPC 420 ↔ BNS 318(4), IEA 65B ↔ BSA 63)", () => {
    const a = expandIndianQuery("anticipatory bail under s.482 BNSS for an offence committed before 1 July 2024");
    expect(a.queries[0]).toBe("anticipatory bail under s.482 BNSS for an offence committed before 1 July 2024");
    expect(a.queries).toContain("anticipatory bail under Section 438 CrPC for an offence committed before 1 July 2024");
    expect(a.sections).toEqual([{ code: "BNSS", section: "482" }]);
    expect(expandIndianQuery("cheating 420 IPC").queries).toContain("cheating Section 318(4) BNS");
    expect(expandIndianQuery("cheating under Section 318(4) BNS").queries).toContain("cheating under Section 420 IPC");
    expect(expandIndianQuery("Section 65B Evidence Act certificate").queries).toContain("Section 63 BSA certificate");
  });
  it("returns every candidate of a split section and nothing for an unmapped one (never a guess)", () => {
    const split = expandIndianQuery("498A IPC general allegations");
    expect(split.queries).toEqual(expect.arrayContaining(["Section 85 BNS general allegations", "Section 86 BNS general allegations"]));
    expect(split.notes.every((n) => n.status === "split")).toBe(true);
    expect(expandIndianQuery("Section 999 IPC").queries).toEqual(["Section 999 IPC"]);
  });
  it("expands Act short names and citation formats", () => {
    expect(expandIndianQuery("dishonour Section 138 NI Act").queries).toContain("dishonour Section 138 Negotiable Instruments Act");
    expect(expandIndianQuery("NDPS bail commercial quantity").queries).toContain("Narcotic Drugs and Psychotropic Substances Act bail commercial quantity");
    expect(expandIndianQuery("Arnesh Kumar (2014) 8 SCC 273").queries).toContain("Arnesh Kumar 2014 8 SCC 273");
    expect(expandIndianQuery("2024 INSC 735 holding").queries).toContain("2024INSC735 holding");
  });
  it("the planner gives judgment and statute lanes the expanded queries (adverse lane: its adverse form)", () => {
    const lanes = planLanes({ question: "anticipatory bail under s.482 BNSS", settings: settings(), mode: "deep", hasMatter: false });
    const controlling = lanes.find((l) => l.kind === "controlling")!;
    expect(controlling.queries.some((q) => q.includes("Section 438 CrPC"))).toBe(true);
    expect(lanes.find((l) => l.kind === "statute")!.queries.some((q) => q.includes("Section 438 CrPC"))).toBe(true);
    expect(lanes.find((l) => l.kind === "contrary")!.queries.every((q) => q.includes("per incuriam"))).toBe(true);
  });
  it("section filters carry both codes as citator keys", () => {
    expect(sectionFilter("s.482 BNSS")).toEqual({ keys: ["BNSS 2023 s.482", "CrPC 1973 s.438"], phrases: ["Section 482 BNSS", "Section 438 CrPC"] });
    expect(sectionFilter("garbage").keys).toEqual([]);
  });
});

describe("fast mode searches adverse authority too", () => {
  it("plans a deterministic contrary lane and the adverse sub-question", () => {
    const lanes = planLanes({ question: "anticipatory bail economic offence", settings: settings({ fast: true }), mode: "fast", hasMatter: false });
    expect(lanes.map((l) => l.kind)).toEqual(["fast", "contrary"]);
    expect(lanes[1].agent).toBe(false);
    expect(planSubQuestions({ question: "q", settings: settings(), mode: "fast", hasMatter: false }).some((q) => q.includes(ADVERSE_SUBQUESTION_MARK))).toBe(true);
  });
  it("runs the contrary lane without an agent and finds the adverse judgment", async () => {
    const deps = indiaFakeDeps({ judgments: [SC_BAIL, SC_ADVERSE, KAR_HC] });
    const res = await runResearch({ question: "Can anticipatory bail be refused only because the offence is economic?", settings: settings({ fast: true, sources: ["caselaw"] }), runId: "run_fast_contrary" }, () => {}, undefined, deps);
    const contrary = res.message.lanes?.find((l) => l.kind === "contrary");
    expect(contrary?.status).toBe("done");
    expect(deps.calls.includes("agent")).toBe(false);
    expect(deps.queries.some((q) => q.includes("per incuriam"))).toBe(true);
    expect(res.message.subQuestions?.some((q) => q.includes(ADVERSE_SUBQUESTION_MARK))).toBe(true);
  });
});

describe("transition law note (BNS s.358 / BNSS s.531) from data", () => {
  it("offence date decides the substantive code; the proceeding date decides procedure; a missing date is never assumed", () => {
    expect(transitionNote({ question: "anticipatory bail under s.482 BNSS for an offence committed before 1 July 2024" })).toMatchObject({ applies: true, substantive: "IPC", procedure: "requires_review" });
    expect(transitionNote({ question: "Offence committed on 30.06.2024; bail application filed on 10 August 2024 — IPC or BNS?" })).toMatchObject({ substantive: "IPC", procedure: "BNSS" });
    expect(transitionNote({ question: "Trial pending before 1 July 2024 for an offence committed on 15.03.2023 under section 420 IPC" })).toMatchObject({ substantive: "IPC", procedure: "CrPC" });
    expect(transitionNote({ question: "Cheating offence committed on 2 August 2024 and FIR registered on 5 August 2024" })).toMatchObject({ substantive: "BNS", procedure: "BNSS" });
    expect(transitionNote({ question: "Does section 318(4) BNS or section 420 IPC apply?" })).toMatchObject({ substantive: "requires_review", procedure: "requires_review" });
    expect(transitionNote({ question: "What is the limitation for a civil suit for recovery?" }).applies).toBe(false);
    const n = transitionNote({ question: "offence committed before 1 July 2024, BNSS application" });
    expect(n.lines.some((l) => l.includes("BNS s.358"))).toBe(true);
    expect(n.lines.some((l) => l.includes("BNSS s.531"))).toBe(true);
    expect(transitionFactsFromText("an offence committed before 1 July 2024").offence).toEqual({ date: "2024-07-01", relation: "before" });
  });
  it("the run states the note to the synthesis and keeps it on the message; 'before 1 July 2024' is IPC, not BNS", async () => {
    const deps = indiaFakeDeps({ judgments: [SC_BAIL] });
    const res = await runResearch({ question: "anticipatory bail under s.482 BNSS for an offence committed before 1 July 2024", settings: settings(), runId: "run_transition" }, () => {}, undefined, deps);
    expect(res.message.offence?.substantive).toBe("IPC");
    expect(res.message.offence?.date).toBeNull();
    expect(res.message.transition).toMatchObject({ substantive: "IPC", procedure: "requires_review" });
    const input = JSON.stringify(deps.synth[0]?.input ?? "");
    expect(input).toContain("Transition law (deterministic");
    expect(input).toContain("BNSS s.531");
    expect(input).toContain("Date of offence: before 2024-07-01");
  });
});

// ---------------------------------------------------------------------------
// Hybrid judgment retrieval
// ---------------------------------------------------------------------------

function hybridStore(o: { vectorCol?: boolean; annRows?: Row[] } = {}) {
  const calls: SqlQuery[] = [];
  const kw: Row[] = [
    { neutral_citation: "2024 INSC 1", chunk_index: "0", page_start: "1", page_end: "1", rank: "0.9", passage: "A passage", id: "sc:a", title: "A v. State", decision_date: "2024-01-01", reporter_citation: null, judges: null, pdf_url: null },
    { neutral_citation: "2024 INSC 2", chunk_index: "0", page_start: "1", page_end: "1", rank: "0.5", passage: "B passage", id: "sc:b", title: "B v. State", decision_date: "2024-01-02", reporter_citation: null, judges: null, pdf_url: null },
  ];
  const store: RemoteStore = {
    async query(q) {
      calls.push(q);
      const sql = q.query;
      if (sql.includes("to_regclass('public.corpus_texts') IS NOT NULL AS ok,") && sql.includes("AS hc")) return [{ ok: "t", hc: "f" }];
      if (sql.includes("to_regclass")) return [{ ok: "t" }];
      if (sql.includes("information_schema.columns") && sql.includes("corpus_text_embeddings")) return o.vectorCol === false ? [] : [{ udt_name: "halfvec" }];
      if (sql.includes("pg_available_extensions")) return [];
      if (sql.includes("websearch_to_tsquery")) return kw;
      if (sql.includes("JOIN corpus_text_embeddings e ON e.chunk_id")) return [{ chunk_id: "c-chunk", neutral_citation: "2024 INSC 3", cnr: null, t_date: null, t_court: "sci", t_title: null, t_case_number: null, chunk_index: "4", page_start: "7", page_end: "7", passage: "C semantic passage", id: "sc:c", title: "C v. State", decision_date: "2024-01-03", reporter_citation: null, case_number: null, judges: null, pdf_url: null, j_neutral: "2024 INSC 3" }];
      return [];
    },
    async transaction(qs) { calls.push(...qs); return [[], [], o.annRows ?? []]; },
  };
  return { store, calls };
}

const embed = async (texts: string[]) => texts.map(() => new Float32Array(1024).fill(0.01));

describe("hybrid judgment text search", () => {
  beforeEach(() => { resetTextTableCacheForTests(); resetHybridCachesForTests(); });
  it("fuses keyword and semantic lists by reciprocal rank (B in both lists leads; semantic-only C is served with its passage)", async () => {
    const { store } = hybridStore({ annRows: [{ chunk_id: "b-chunk", text_key: "2024 INSC 2", dist: "0.20" }, { chunk_id: "c-chunk", text_key: "2024 INSC 3", dist: "0.30" }, { chunk_id: "far", text_key: "2024 INSC 9", dist: "0.95" }] });
    const r = await searchJudgmentTextHybrid("anticipatory bail", { limit: 5 }, store, { model: "embed-test", embed });
    expect(r.mode).toBe("hybrid");
    expect(r.note).toBeUndefined();
    expect(r.hits.map((h) => h.neutralCitation)).toEqual(["2024 INSC 2", "2024 INSC 1", "2024 INSC 3"]);
    expect(r.hits.map((h) => h.match)).toEqual(["both", "keyword", "semantic"]);
    expect(r.hits[2]).toMatchObject({ judgmentId: "sc:c", pageStart: 7, similarity: 0.7 });
    // Beyond the cosine cutoff a neighbour is not a match.
    expect(r.hits.some((h) => h.neutralCitation === "2024 INSC 9")).toBe(false);
  });
  it("never claims semantic results without embeddings: keyword-only with a coverage note", async () => {
    const none = await searchJudgmentTextHybrid("anticipatory bail", {}, hybridStore().store, { model: null, embed });
    expect(none.mode).toBe("keyword");
    expect(none.note).toMatch(/not configured/);
    expect(none.hits.every((h) => h.match === "keyword")).toBe(true);
    const empty = await searchJudgmentTextHybrid("anticipatory bail", {}, hybridStore({ annRows: [] }).store, { model: "embed-test", embed });
    expect(empty.mode).toBe("keyword");
    expect(empty.note).toMatch(/No judgment embeddings exist yet/);
    const noVector = await searchJudgmentTextHybrid("anticipatory bail", {}, hybridStore({ vectorCol: false }).store, { model: "embed-test", embed });
    expect(noVector.mode).toBe("keyword");
    expect(noVector.note).toMatch(/Semantic retrieval unavailable/);
  });
  it("applies bench / judge / disposal / section filters to the fused hits and says when the citator is missing", async () => {
    const { store, calls } = hybridStore({ annRows: [] });
    const orig = store.query.bind(store);
    store.query = async (q) => (q.query.includes("FROM corpus_judgments j WHERE j.id = ANY") ? (calls.push(q), [{ id: "sc:b" }]) : q.query.includes("to_regclass('public.corpus_citations')") ? [{ ok: "f" }] : orig(q));
    const r = await searchJudgmentTextHybrid("bail", { benchMin: 3, sectionKeys: ["BNSS 2023 s.482"] }, store, { model: null });
    expect(r.hits.map((h) => h.judgmentId)).toEqual(["sc:b"]);
    const sql = calls.find((c) => c.query.includes("FROM corpus_judgments j WHERE j.id = ANY"))!;
    expect(sql.query).toContain("bench_strength");
    expect(sql.query).not.toContain("corpus_citations");
    expect(r.filterNotes.join(" ")).toMatch(/Statute-section filter not applied/);
  });
  it("metadata corpus filters: bench strength and citator sections (only when the citator exists)", () => {
    const params: (string | number | null)[] = [];
    const sql = corpusFilters({ q: "x", benchMin: 3, sectionKeys: ["BNSS 2023 s.482"], citator: true }, params);
    expect(sql).toContain("coalesce(bench_strength, 0) >= $1");
    expect(sql).toContain("corpus_citations cc WHERE cc.citing_id = corpus_judgments.id");
    expect(corpusFilters({ q: "x", sectionKeys: ["BNSS 2023 s.482"], citator: false }, [])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Embedding queue
// ---------------------------------------------------------------------------

describe("judgment embeddings (tiered queue)", () => {
  it("tiers: Supreme Court first, then priority High Courts; others only on access", () => {
    expect(tierFor("sci", {})).toBe(1);
    expect(tierFor("hc-karnataka", {})).toBe(2);
    expect(tierFor("hc-delhi", {})).toBe(3);
    expect(priorityCourts({ JUDGMENT_EMBED_PRIORITY_COURTS: "hc-delhi, bogus" })).toEqual(["hc-delhi"]);
  });
  it("does nothing without an embedding model (never claims vectors)", async () => {
    const { store, calls } = hybridStore();
    expect(await runJudgmentEmbedding(store, { deadline: Date.now() + 60_000, model: null })).toMatchObject({ embedded: 0, error: expect.stringMatching(/not configured/) });
    expect(calls).toHaveLength(0);
    expect(await requestJudgmentEmbedding(store, "2024 INSC 1", "sci")).toBe(false); // no model in the test environment
  });
  it("claims a judgment, embeds only chunks without a current vector, records the model, and marks it done", async () => {
    const writes: SqlQuery[] = [];
    let claimed = false;
    const store: RemoteStore = {
      async query(q) {
        const sql = q.query;
        if (sql.includes("to_regclass('public.corpus_texts')")) return [{ ok: "t", hc: "t" }];
        if (sql.includes("information_schema.columns") && sql.includes("corpus_text_embeddings")) return [{ udt_name: "halfvec" }];
        if (sql.startsWith("WITH c AS") && sql.includes("INSERT INTO corpus_embed_queue")) return [{ n: "0" }];
        if (sql.startsWith("UPDATE corpus_embed_queue q SET status = 'running'")) { if (claimed) return []; claimed = true; return [{ text_key: "2024 INSC 735", court_id: "sci", attempts: "1" }]; }
        if (sql.includes("FROM corpus_texts t") && sql.includes("NOT EXISTS (SELECT 1 FROM corpus_text_embeddings")) return [{ id: "2024_INSC_735_000", chunk_index: "0", court_id: "sci", y: "2024", text: "chunk zero", sha: "s0" }, { id: "2024_INSC_735_001", chunk_index: "1", court_id: "sci", y: "2024", text: "chunk one", sha: "s1" }];
        if (sql.startsWith("INSERT INTO corpus_text_embeddings") || sql.startsWith("UPDATE corpus_embed_queue SET status = 'done'")) { writes.push(q); return []; }
        return [];
      },
      async transaction() { return []; },
    };
    const r = await runJudgmentEmbedding(store, { deadline: Date.now() + 120_000, model: "embed-test", embed: async (t) => t.map(() => new Float32Array(1024)) });
    expect(r).toMatchObject({ claimed: 1, judgments: 1, embedded: 2, vector: "halfvec", error: null });
    const ins = writes.find((w) => w.query.startsWith("INSERT INTO corpus_text_embeddings"))!;
    expect(ins.query).toContain("embedding_v");
    expect(ins.params?.[1]).toBe("embed-test");
    const rows = JSON.parse(String(ins.params?.[0])) as { chunk_id: string; sha: string }[];
    expect(rows.map((x) => [x.chunk_id, x.sha])).toEqual([["2024_INSC_735_000", "s0"], ["2024_INSC_735_001", "s1"]]);
    expect(writes.some((w) => w.query.startsWith("UPDATE corpus_embed_queue SET status = 'done'"))).toBe(true);
  });
  it("a provider returning the wrong dimensions stores nothing and reports the error", async () => {
    let claimed = false;
    const inserts: SqlQuery[] = [];
    const store: RemoteStore = {
      async query(q) {
        const sql = q.query;
        if (sql.includes("to_regclass('public.corpus_texts')")) return [{ ok: "t", hc: "f" }];
        if (sql.includes("information_schema.columns") && sql.includes("corpus_text_embeddings")) return [{ udt_name: "halfvec" }];
        if (sql.startsWith("UPDATE corpus_embed_queue q SET status = 'running'")) { if (claimed) return []; claimed = true; return [{ text_key: "2024 INSC 1", court_id: "sci", attempts: "1" }]; }
        if (sql.includes("NOT EXISTS (SELECT 1 FROM corpus_text_embeddings")) return [{ id: "x0", chunk_index: "0", court_id: "sci", y: "2024", text: "t", sha: "s" }];
        if (sql.startsWith("INSERT INTO corpus_text_embeddings")) inserts.push(q);
        if (sql.startsWith("WITH c AS")) return [{ n: "0" }];
        return [];
      },
      async transaction() { return []; },
    };
    const r = await runJudgmentEmbedding(store, { deadline: Date.now() + 120_000, model: "embed-test", embed: async (t) => t.map(() => new Float32Array(1536)) });
    expect(r.error).toMatch(/1536-dimensional/);
    expect(inserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reranker
// ---------------------------------------------------------------------------

const src = (id: string, o: Partial<ResearchSource> & { bench?: number } = {}): ResearchSource => ({ ...sourceFromHit({ id, source: "caselaw", title: `${id} v. State`, date: o.date ?? "2020-01-01", authority: o.authority ?? "persuasive", snippet: "s", india: { benchStrength: o.bench } } as SearchHit, "lane"), ...o });

describe("issue-level reranker", () => {
  const sources = Array.from({ length: 30 }, (_, i) => src(`j${String(i).padStart(2, "0")}`));
  it("is bounded: the scorer sees at most the top 20, the rest keep their order after them", async () => {
    let seen = 0;
    const scorer: RerankScorer = async (i) => { seen = i.candidates.length; return i.candidates.map((c, k) => ({ id: c.id, score: k === 5 ? 3 : 1 })); };
    const r = await rerankSources(sources, { question: "q", scorer, enabled: true });
    expect(seen).toBe(RERANK_TOP_N);
    expect(r.applied).toBe(true);
    expect(r.items[0].id).toBe("j05");
    expect(r.items.slice(20).map((s) => s.id)).toEqual(sources.slice(20).map((s) => s.id));
  });
  it("falls back to retrieval order when the model is unavailable, slow, off or returns garbage; unknown ids never bind", async () => {
    const failing: RerankScorer = async () => { throw new Error("no model configured"); };
    expect(await rerankSources(sources, { question: "q", scorer: failing, enabled: true })).toMatchObject({ applied: false, items: sources });
    const slow: RerankScorer = () => new Promise((r) => setTimeout(() => r([]), 200));
    expect((await rerankSources(sources, { question: "q", scorer: slow, enabled: true, timeoutMs: 20 })).applied).toBe(false);
    expect((await rerankSources(sources, { question: "q", scorer: failing, enabled: false })).reason).toMatch(/off/);
    expect((await rerankSources(sources, { question: "q", scorer: null, enabled: true })).reason).toMatch(/no reranking model/);
    const bogus: RerankScorer = async () => [{ id: "Totally Different v. Union", score: 3 }, { id: "j01", score: Number.NaN }];
    expect((await rerankSources(sources, { question: "q", scorer: bogus, enabled: true })).applied).toBe(false);
  });
  it("breaks ties deterministically: authority, bench, newer date, retrieval rank, id", () => {
    const order = rerankOrder([
      { item: "a", id: "a", score: 2, authority: "persuasive", bench: 1, date: "2020-01-01", rank: 0 },
      { item: "b", id: "b", score: 2, authority: "binding", bench: 1, date: "2010-01-01", rank: 1 },
      { item: "c", id: "c", score: 2, authority: "binding", bench: 3, date: "2001-01-01", rank: 2 },
      { item: "d", id: "d", score: 3, authority: "persuasive", bench: 1, date: "1990-01-01", rank: 3 },
      { item: "e", id: "e", score: null, authority: "binding", bench: 7, date: "2024-01-01", rank: 4 },
    ]);
    expect(order).toEqual(["d", "c", "b", "a", "e"]);
  });
  it("the lane uses it only when switched on and the deps provide it", async () => {
    const deps = indiaFakeDeps({ judgments: [SC_BAIL, SC_ADVERSE, KAR_HC] });
    const seen: number[] = [];
    deps.rerank = async (i) => { seen.push(i.candidates.length); return i.candidates.map((c) => ({ id: c.id, score: c.id.includes("kavitha") ? 3 : 1 })); };
    const events: { type: string; name?: string }[] = [];
    await runResearch({ question: "Can anticipatory bail be refused only because the offence is economic?", settings: settings({ sources: ["caselaw"] }), runId: "run_rerank_on", rerank: true }, (e) => events.push(e as never), undefined, deps);
    expect(seen.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "tool.completed" && e.name === "rerank")).toBe(true);
    seen.length = 0;
    await runResearch({ question: "Can anticipatory bail be refused only because the offence is economic?", settings: settings({ sources: ["caselaw"] }), runId: "run_rerank_off", rerank: false }, () => {}, undefined, deps);
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Citation accuracy
// ---------------------------------------------------------------------------

const judgment = (id: string, cite: string, text: boolean): SearchHit => ({ id: `corpus:${id}`, source: "caselaw", title: `${id} v. State of Karnataka`, cite, citations: [cite], courtId: "sci", court: "Supreme Court of India", date: "2023-03-14", authority: "binding", india: { judgmentId: id, courtId: "sci", reporterCitations: [cite], provider: "corpus" }, ...(text ? { readRef: { kind: "url" as const, url: `corpus-text://${id}` } } : {}) });

describe("authority status table", () => {
  const read = { ...sourceFromHit(judgment("sc:read", "(2023) 5 SCC 301", true), "l"), read: true };
  const meta = sourceFromHit(judgment("sc:meta", "(2019) 4 SCC 17", false), "l");
  const unread = sourceFromHit(judgment("sc:unread", "(2020) 7 SCC 1", true), "l");
  const numbered = numberSources([read, meta, unread]).sources;
  const texts: Record<string, string> = { "corpus:sc:read": "1. Facts.\n2. We hold that anticipatory bail cannot be refused only because the offence is economic." };
  const textOf = (s: ResearchSource) => texts[s.id];

  it("unresolved citations are never substituted with a near match; metadata-only records are never supported", () => {
    const answer = "Bail cannot be refused only because the offence is economic, (2023) 5 SCC 301 [1]. The IBC point rests on (2019) 4 SCC 17 [2]. See also (2023) 5 SCC 302 and 2099 INSC 1. And (2020) 7 SCC 1 [3].";
    const raw = [
      { claim: "Bail cannot be refused only because the offence is economic", status: "supported" as const, sourceN: 1, quote: "anticipatory bail cannot be refused only because the offence is economic" },
      { claim: "The IBC point", status: "supported" as const, sourceN: 2 },
      { claim: "Electronic evidence point", status: "supported" as const, sourceN: 3 },
    ];
    const checked = checkClaimEvidence(answer, raw, numbered, textOf);
    expect(checked.verdicts.map((v) => v.status)).toEqual(["supported", "unsupported", "unsupported"]);
    const t = buildAuthorityStatus({ answer, artifactHash: "h1", sources: numbered, verification: { artifactHash: "h1", verdicts: checked.verdicts }, remotelyKnown: new Set() });
    const by = (s: string) => t.rows.find((r) => r.authority.includes(s) || r.citations.includes(s));
    expect(by("(2023) 5 SCC 301")?.status).toBe("supported");
    expect(by("(2019) 4 SCC 17")?.status).toBe("text_not_available");
    expect(by("(2020) 7 SCC 1")?.status).toBe("found");
    const near = t.rows.find((r) => r.citations.includes("(2023) 5 SCC 302"))!;
    expect(near.status).toBe("unresolved");
    expect(near.sourceN).toBeUndefined();
    expect(near.recordId).toBeUndefined();
    expect(t.rows.find((r) => r.citations.includes("2099 INSC 1"))?.status).toBe("unresolved");
    expect(t.counts).toMatchObject({ supported: 1, text_not_available: 1, found: 1, unresolved: 2 });
  });
  it("a verifier saying 'supported' for a metadata-only record does not make it supported", () => {
    const answer = "The point (2019) 4 SCC 17 [2].";
    const t = buildAuthorityStatus({ answer, artifactHash: "h2", sources: numbered, verification: { artifactHash: "h2", verdicts: [{ claim: "The point", status: "supported", sourceN: 2 }] } });
    expect(t.rows[0].status).toBe("text_not_available");
    expect(t.rows[0].supportedClaims).toBe(0);
  });
  it("verification for another answer hash never yields 'supported'", () => {
    const answer = "Bail [1].";
    const t = buildAuthorityStatus({ answer, artifactHash: "new", sources: numbered, verification: { artifactHash: "old", verdicts: [{ claim: "Bail", status: "supported", sourceN: 1 }] } });
    expect(t.rows[0]).toMatchObject({ status: "read", note: expect.stringMatching(/changed after verification/) });
  });
  it("a citation the judgment index carries but no run source holds is 'found', not 'supported'", () => {
    const t = buildAuthorityStatus({ answer: "See (2014) 8 SCC 273.", artifactHash: "h", sources: numbered, remotelyKnown: new Set(["(2014)8scc273"]) });
    expect(t.rows[0]).toMatchObject({ status: "found", citations: ["(2014) 8 SCC 273"] });
  });
  it("the run attaches the table to the message, bound to the answer hash", async () => {
    const deps = indiaFakeDeps({ judgments: [SC_BAIL], readIds: 2 });
    const res = await runResearch({ question: "Can anticipatory bail be refused only because the offence is economic?", settings: settings({ sources: ["caselaw"] }), runId: "run_authorities" }, () => {}, undefined, deps);
    const t = res.message.authorities!;
    expect(t.artifactHash).toBe(res.message.artifactHash);
    expect(t.rows.some((r) => r.citations.includes("2023 INSC 212"))).toBe(true);
    expect(t.rows.every((r) => ["supported", "read", "found", "unresolved", "text_not_available"].includes(r.status))).toBe(true);
  });
});

describe("citation-string extractor", () => {
  it("types neutral (SC, HC), SCR, SCC (incl. Supp and bracketed volume), SCC OnLine, AIR (dotted) and Cri LJ citations", () => {
    const got = extractAuthorityCitations("2024 INSC 735; 2025:AHC-LKO:18131; [1950] SCR 88; (2014) 8 SCC 273; 2014 (8) SCC 273; 1992 Supp (1) SCC 335; 2023 SCC OnLine SC 123; A.I.R. 1961 S.C. 1808; 2006 Cri LJ 1234");
    expect(got.map((c) => [c.normalized, c.format])).toEqual([
      ["2024 INSC 735", "neutral_sc"], ["2025:AHC-LKO:18131", "neutral_hc"], ["[1950] SCR 88", "scr"], ["(2014) 8 SCC 273", "scc"],
      ["1992 Supp (1) SCC 335", "scc"], ["2023 SCC OnLine SC 123", "scc_online"], ["AIR 1961 SC 1808", "air"], ["2006 Cri LJ 1234", "cri_lj"],
    ]);
    expect(got.find((c) => c.format === "neutral_hc")?.courtId).toBe("hc-allahabad");
  });
});

describe("budgets", () => {
  it("lane and run time budgets were raised (fast mode keeps a smaller wall)", () => {
    expect(LANE_TIMEOUT.controlling).toBe(150_000);
    expect(LANE_TIMEOUT.fast).toBe(70_000);
    expect(DEFAULT_POLICY.laneTimeoutMs).toBe(150_000);
    expect(FAST_POLICY.runTimeMs).toBe(180_000);
  });
  it("filters survive sanitize (they were dropped before)", () => {
    expect(sanitizeSettings({ offenceDate: "2024-06-30", proceedingDate: "2024-08-10", benchMin: 3, judge: " Nagarathna ", disposal: "Allowed", section: "s.482 BNSS", answerLanguage: "kn" })).toMatchObject({ offenceDate: "2024-06-30", proceedingDate: "2024-08-10", benchMin: 3, judge: "Nagarathna", disposal: "Allowed", section: "s.482 BNSS", answerLanguage: "kn" });
    expect(sanitizeSettings({ offenceDate: "30.06.2024" as never, benchMin: 1 }).offenceDate).toBeUndefined();
  });
});

it('never exceeds its embedding chunk budget across a batch of four claimed judgments', async () => {
 let claimed=false;let sent=0;let released=0;
 const store: RemoteStore={async query(q){const s=q.query;if(s.includes("to_regclass('public.corpus_texts')"))return [{ok:'t',hc:'t'}];if(s.includes('information_schema.columns')&&s.includes('corpus_text_embeddings'))return [{udt_name:'halfvec'}];if(s.startsWith("UPDATE corpus_embed_queue q SET status = 'running'")){if(claimed)return [];claimed=true;return ['a','b','c','d'].map(text_key=>({text_key,court_id:'sci',attempts:'1'}));}if(s.includes('FROM corpus_texts t')&&s.includes('NOT EXISTS (SELECT 1 FROM corpus_text_embeddings'))return [{id:String(q.params?.[0]),chunk_index:'0',court_id:'sci',y:'2025',text:'A judgment passage',sha:'sha'}];if(s.startsWith('UPDATE corpus_embed_queue SET status = $2'))released++;if(s.startsWith('WITH c AS'))return [{n:'0'}];return [];},async transaction(){return [];}};
 const r=await runJudgmentEmbedding(store,{deadline:Date.now()+60000,maxChunks:1,model:'test-embed',embed:async(texts)=>{sent+=texts.length;return texts.map(()=>new Float32Array(1024));}});
 expect(sent).toBe(1);expect(r.embedded).toBe(1);expect(released).toBe(4);
});
