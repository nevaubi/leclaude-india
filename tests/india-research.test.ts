/**
 * LeClaude India research: the Indian toolkit over the real source-layer store (judgments, India Code, citing
 * references, citation resolution, capability gating) and the engine's multilingual, forum and offence-date paths
 * (fakes; fictional judgments). No network.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import type { ToolContext } from "@/lib/ai/tools";
import { ingestDocument } from "@/modules/intel/store";
import { replaceSections, upsertEnactment, upsertJudgment } from "@/modules/india/sources/store";
import type { StoredJudgment } from "@/modules/india/sources";
import {
  citingReferences, citingReferencesTool, indiaCapabilities, indiaResearchTools, INDIA_TOOLS, mapCriminalSectionTool, readJudgmentTool, readSectionTool, resolveIndianCitation, searchJudgmentsTool, searchStatutesIndiaTool,
} from "@/lib/ai/toolkit/india";
import { researchToolset } from "@/lib/ai/toolkit";
import { runResearch } from "@/modules/search/engine/run";
import { answerLanguageLine, offenceDateFromText, questionLanguage, resolveAnswerLanguage, setPreferredAnswerLanguageHook } from "@/modules/search/engine/india-context";
import { sanitizeSettings } from "@/modules/search/service";
import { readSource } from "@/modules/search/service";
import type { ResearchStreamEvent } from "@/modules/search/engine/types";
import type { SearchSettings } from "@/modules/search/types";
import { indiaFakeDeps, KAN_HC, KAN_HC_TEXT, SC_BAIL, verification } from "../evals/india-research/fixtures";

const settings = (over: Partial<SearchSettings> = {}) => sanitizeSettings({ sources: ["caselaw", "statutes"], jurisdiction: "hc-karnataka", ...over });
const ctx = (state: Record<string, unknown> = {}): ToolContext => ({ emit: () => {}, state });
const MATTER_A = "m_india_test_a";
const MATTER_B = "m_india_test_b";

async function seedJudgment(o: { ext: string; source?: "sci-open-data" | "hc-open-data"; courtId: string | null; unresolvedCourt?: string; title: string; text: string; neutral?: string; reporters?: string[]; bench: number; date: string; language?: string; matterIds?: string[]; statutes?: string[]; benchId?: string }): Promise<StoredJudgment> {
  const source = o.source ?? (o.courtId === "sci" ? "sci-open-data" : "hc-open-data");
  const r = await ingestDocument({ sourceId: "isrc_test_india", adapter: source, kind: "opinion", title: o.title, caseName: o.title, courtId: o.courtId ?? undefined, citation: o.neutral ?? o.reporters?.[0], dates: { decided: o.date }, text: o.text, externalId: `${source}:${o.ext}`, matterIds: o.matterIds, meta: { india: true, courtId: o.courtId, benchStrength: o.bench, neutralCitation: o.neutral, language: o.language ?? "en" } }, { embed: false });
  return upsertJudgment({
    source, externalId: o.ext, courtId: o.courtId, unresolvedCourt: o.unresolvedCourt, benchId: o.benchId, title: o.title,
    citations: [...(o.neutral ? [{ raw: o.neutral, kind: "neutral" as const, neutral: o.neutral }] : []), ...(o.reporters ?? []).map((raw) => ({ raw, kind: "reporter" as const }))],
    neutralCitation: o.neutral, judges: Array.from({ length: o.bench }, (_, i) => `Justice ${String.fromCharCode(65 + i)}`), benchStrength: o.bench, decisionDate: o.date, language: (o.language ?? "en") as "en", translations: [], statutes: o.statutes ?? [], retrievedAt: "2026-09-01T00:00:00Z", intelDocId: r.doc.id,
  });
}

let SC: StoredJudgment, KAR: StoredJudgment, LATER: StoredJudgment, TS: StoredJudgment, UNRES: StoredJudgment, PRIVATE: StoredJudgment, DUP1: StoredJudgment;

beforeAll(async () => {
  resetSqlite();
  db();
  SC = await seedJudgment({ ext: "t_sc_1", courtId: "sci", title: "Meera Nair v. State of Karnataka", neutral: "2023 INSC 212", reporters: ["(2023) 5 SCC 301"], bench: 3, date: "2023-03-14", statutes: ["CrPC 1973 s.438"], text: "Meera Nair v. State of Karnataka\nSupreme Court of India\n1. Leave granted.\n2. The refusal rested only on the economic nature of the offence.\n3. We hold that anticipatory bail cannot be refused only because the offence is economic in nature." });
  KAR = await seedJudgment({ ext: "t_kar_1", courtId: "hc-karnataka", benchId: "kar-dharwad", title: "Ravi Kumar v. State of Karnataka", neutral: "2024:KHC-D:5123", bench: 1, date: "2024-02-10", statutes: ["CrPC 1973 s.438"], text: "Ravi Kumar v. State of Karnataka\nHigh Court of Karnataka\n1. The petitioner seeks anticipatory bail.\n2. Following Meera Nair v. State of Karnataka, 2023 INSC 212, parity with the co-accused is granted." });
  LATER = await seedJudgment({ ext: "t_sc_2", courtId: "sci", title: "Union of India v. Kavitha Reddy", neutral: "2024 INSC 390", bench: 3, date: "2024-05-06", text: "Union of India v. Kavitha Reddy\nSupreme Court of India\n1. The view in Meera Nair v. State of Karnataka, (2023) 5 SCC 301 is doubted and the question is referred to a larger bench for economic offences involving public money.\n2. Anticipatory bail in such cases is the exception." });
  TS = await seedJudgment({ ext: "t_ts_1", courtId: "hc-telangana", title: "Syed Imran v. State of Telangana", neutral: "2022:TSHC:3301", bench: 2, date: "2022-08-19", text: "Syed Imran v. State of Telangana\n1. Custodial interrogation is necessary; anticipatory bail is refused." });
  UNRES = await seedJudgment({ ext: "t_unres_1", courtId: null, unresolvedCourt: "99_9", title: "Unknown Court Judgment on anticipatory bail", bench: 1, date: "2021-01-01", text: "Unknown court.\n1. Anticipatory bail discussed." });
  PRIVATE = await seedJudgment({ ext: "t_priv_1", courtId: "hc-karnataka", title: "Sealed order in anticipatory bail", neutral: "2024:KHC:9999", bench: 1, date: "2024-06-01", matterIds: [MATTER_A], text: "Sealed order.\n1. Anticipatory bail granted in a sealed matter." });
  DUP1 = await seedJudgment({ ext: "t_dup_1", courtId: "hc-karnataka", title: "Duplicate report one", reporters: ["2020 SCC OnLine Kar 100"], bench: 1, date: "2020-01-01", text: "Duplicate one." });
  await seedJudgment({ ext: "t_dup_2", courtId: "hc-karnataka", title: "Duplicate report two", reporters: ["2020 SCC OnLine Kar 100"], bench: 1, date: "2020-01-02", text: "Duplicate two." });
  const bnss = upsertEnactment({ source: "india-code", externalId: "bnss-2023", title: "The Bharatiya Nagarik Suraksha Sanhita, 2023", shortTitle: "Bharatiya Nagarik Suraksha Sanhita", year: 2023, jurisdiction: "central", language: "en", sections: 2, retrievedAt: "2026-09-01T00:00:00Z", inForceFrom: "2024-07-01" });
  replaceSections(bnss.id, [
    { number: "482", heading: "Direction for grant of bail to person apprehending arrest", text: "482. (1) When any person has reason to believe that he may be arrested on accusation of having committed a non-bailable offence, he may apply to the High Court or the Court of Session for a direction under this section.", order: 482 },
    { number: "483", heading: "Special powers of High Court or Court of Session regarding bail", text: "483. (1) A High Court or Court of Session may direct that any person accused of an offence and in custody be released on bail.", order: 483 },
  ]);
});

// ---- tools over the store ---------------------------------------------------------

describe("search_judgments / read_judgment over the ingested corpus", () => {
  it("filters by court, bench strength, language and year; an unresolved court never matches a court filter", async () => {
    const all = (await searchJudgmentsTool.execute({ query: "anticipatory bail", limit: 25 }, ctx({ matterId: MATTER_B }))) as { results: { id: string; court_id: string | null; source: string; bench_strength?: number; neutral_citation?: string; treatment: unknown }[] };
    const ids = all.results.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([SC.id, KAR.id, LATER.id, TS.id, UNRES.id]));
    expect(ids).not.toContain(PRIVATE.id); // matter-linked record outside the caller's matter
    const sc = all.results.find((r) => r.id === SC.id)!;
    expect(sc.source).toBe(`judgment://sci/${SC.id}`);
    expect(sc.bench_strength).toBe(3);
    expect(sc.neutral_citation).toBe("2023 INSC 212");
    expect(sc.treatment).toBe("treatment not checked");
    expect(all.results.find((r) => r.id === UNRES.id)?.source).toBe(`judgment://unresolved/${UNRES.id}`);
    const kar = (await searchJudgmentsTool.execute({ query: "anticipatory bail", courts: ["hc-karnataka"], limit: 25 }, ctx({ matterId: MATTER_B }))) as { results: { id: string }[] };
    expect(kar.results.map((r) => r.id)).toEqual([KAR.id]);
    const large = (await searchJudgmentsTool.execute({ query: "anticipatory bail", min_bench: 2, year_from: 2023 }, ctx())) as { results: { id: string }[] };
    expect(large.results.map((r) => r.id).sort()).toEqual([SC.id, LATER.id].sort());
    const dharwad = (await searchJudgmentsTool.execute({ query: "parity", bench: "Dharwad" }, ctx())) as { results: { id: string }[] };
    expect(dharwad.results.map((r) => r.id)).toEqual([KAR.id]);
    const inMatter = (await searchJudgmentsTool.execute({ query: "sealed anticipatory bail", courts: ["hc-karnataka"] }, ctx({ matterId: MATTER_A }))) as { results: { id: string }[] };
    expect(inMatter.results.map((r) => r.id)).toContain(PRIVATE.id);
    const none = (await searchJudgmentsTool.execute({ query: "zebra crossing liability", courts: ["hc-andhra"] }, ctx())) as { count: number; note?: string };
    expect(none.count).toBe(0);
    expect(none.note).toMatch(/Do not cite authority that was not found/);
  });

  it("reads a judgment in paragraph windows with per-paragraph sources; the reader endpoint returns the same text of record", async () => {
    const r = (await readJudgmentTool.execute({ id: SC.id, start_paragraph: 4, count: 2 }, ctx())) as { source: string; content: string[]; paragraphs: { n: number; source: string; judgment_para?: string }[]; total_paragraphs: number };
    expect(r.source).toBe(`judgment://sci/${SC.id}`);
    expect(r.paragraphs.map((p) => p.n)).toEqual([4, 5]);
    expect(r.paragraphs[1]).toMatchObject({ source: `judgment://sci/${SC.id}/para/5`, judgment_para: "3" });
    expect(r.content[1]).toContain("¶5 [para 3] 3. We hold that anticipatory bail cannot be refused");
    expect(() => readJudgmentTool.execute({ id: "ijdg_missing" }, ctx())).toThrow(/No judgment/);
    expect(() => readJudgmentTool.execute({ id: PRIVATE.id }, ctx({ matterId: MATTER_B }))).toThrow(/not available in the current matter scope/);
    const reader = await readSource({ kind: "judgment", id: SC.id });
    expect(reader.text.split("\n")[4]).toContain("We hold that anticipatory bail");
    expect(reader.meta?.benchStrength).toBe(3);
  });
});

describe("citing references and citation resolution within the corpus", () => {
  it("finds later judgments citing a judgment by its parsed citations and flags negative language; resolves what it cites", async () => {
    const r = await citingReferences(SC.id, "*");
    const ids = r.citing.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([KAR.id, LATER.id]));
    expect(ids).not.toContain(TS.id);
    expect(r.citing.find((c) => c.id === LATER.id)?.phrase).toBe("doubted");
    expect(r.citing.find((c) => c.id === KAR.id)?.phrase).toBeUndefined();
    const out = (await citingReferencesTool.execute({ id: SC.id }, ctx())) as { note: string; citing: { negative_language: string | null }[] };
    expect(out.note).toMatch(/Possibly negative treatment/);
    const kar = await citingReferences(KAR.id, "*");
    expect(kar.cited).toEqual([{ raw: "2023 INSC 212", resolvedId: SC.id, state: "resolved" }]);
  });

  it("resolves one match, reports several as ambiguous without choosing, and leaves the rest unresolved", () => {
    expect(resolveIndianCitation("(2023) 5 SCC 301")).toMatchObject({ state: "resolved", id: SC.id, source: `judgment://sci/${SC.id}` });
    expect(resolveIndianCitation("2023 INSC 212")).toMatchObject({ state: "resolved", id: SC.id });
    const amb = resolveIndianCitation("2020 SCC OnLine Kar 100");
    expect(amb.state).toBe("ambiguous");
    expect("id" in amb).toBe(false);
    expect(resolveIndianCitation("(2021) 9 SCC 999")).toMatchObject({ state: "unresolved" });
    expect(resolveIndianCitation("not a citation")).toMatchObject({ state: "unresolved", reason: "not a recognised neutral or reporter citation" });
    void DUP1;
  });
});

describe("India Code and the criminal-code correspondence", () => {
  it("searches sections and reads one exactly; an absent section is never replaced by a neighbour", async () => {
    const s = (await searchStatutesIndiaTool.execute({ query: "anticipatory bail apprehending arrest" }, ctx())) as { results: { id: string; source: string; section: string; enactment: string }[] };
    expect(s.results[0]).toMatchObject({ section: "482", enactment: "Bharatiya Nagarik Suraksha Sanhita" });
    expect(s.results[0].source).toMatch(/^statute:\/\/ienact_[0-9a-f]+\/s\/482$/);
    const exact = (await searchStatutesIndiaTool.execute({ query: "section 483 bail" }, ctx())) as { results: { section: string }[] };
    expect(exact.results.map((r) => r.section)).toEqual(["483"]);
    const read = readSectionTool.execute({ id: s.results[0].id }, ctx()) as { title: string; content: string[] };
    expect(read.title).toContain("s. 482");
    expect(() => readSectionTool.execute({ id: s.results[0].id.replace(/:482$/, ":481") }, ctx())).toThrow(/No India Code section/);
  });

  it("maps IPC/BNS both ways and reports requires_review / unmapped as they are", () => {
    expect(mapCriminalSectionTool.execute({ code: "IPC", section: "420", offence_date: "2024-03-15" }, ctx())).toMatchObject({ status: "mapped", direction: "old_to_new", candidates: [{ code: "BNS", section: "318(4)" }], applicable: { code: "IPC" } });
    expect(mapCriminalSectionTool.execute({ code: "IPC", section: "420", offence_date: "2024-08-02" }, ctx())).toMatchObject({ applicable: { code: "BNS" } });
    expect(mapCriminalSectionTool.execute({ code: "IPC", section: "420" }, ctx())).toMatchObject({ applicable: { code: "requires_review" } });
    expect(mapCriminalSectionTool.execute({ code: "BNSS", section: "482" }, ctx())).toMatchObject({ direction: "new_to_old", candidates: [{ code: "CrPC", section: "438" }], applicable: { family: "procedure", code: "requires_review" } });
    expect((mapCriminalSectionTool.execute({ code: "IPC", section: "9999" }, ctx()) as { status: string }).status).toBe("unmapped");
    expect(mapCriminalSectionTool.execute({ code: "XYZ", section: "1" }, ctx())).toMatchObject({ error: expect.stringContaining("Unknown code") });
  });
});

describe("capability registry and the default toolset", () => {
  it("offers Indian Kanoon only when its connector is ready; the default toolset is Indian, never US", () => {
    expect(indiaCapabilities({}).indianKanoon).toBe(false);
    expect(indiaResearchTools({ indianKanoon: false }).map((t) => t.name)).not.toContain("indian_kanoon_search");
    expect(indiaResearchTools({ indianKanoon: true }).map((t) => t.name)).toEqual(expect.arrayContaining(["indian_kanoon_search", "indian_kanoon_doc"]));
    const names = researchToolset({ web: false, internal: false }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_judgments", "read_judgment", "citing_references", "search_statutes", "read_section", "map_criminal_section"]));
    for (const us of ["search_case_law", "search_cfr", "search_federal_register", "search_dockets", "get_opinion_text"]) expect(names).not.toContain(us);
    expect(researchToolset({ web: false, internal: false, legal: false, us: true }).tools.map((t) => t.name)).toContain("search_case_law");
    for (const t of INDIA_TOOLS) { expect(t.examples?.length, t.name).toBeGreaterThan(0); expect(t.timeoutMs, t.name).toBeGreaterThan(0); expect(t.access, t.name).toBe("read"); }
  });
});

// ---- engine: multilingual, forum, offence date --------------------------------------

function collect() {
  const events: ResearchStreamEvent[] = [];
  return { events, send: (e: ResearchStreamEvent) => { events.push(e); } };
}

const KN_QUESTION = "ಸಹ ಆರೋಪಿಗೆ ನಿರೀಕ್ಷಣಾ ಜಾಮೀನು ನೀಡಿದ್ದರೆ ಅರ್ಜಿದಾರನಿಗೆ ಸಮಾನತೆಯ ಆಧಾರದ ಮೇಲೆ ಜಾಮೀನು ಸಿಗುತ್ತದೆಯೇ?";
const KN_QUOTE = "ಸಹ ಆರೋಪಿಗೆ ನಿರೀಕ್ಷಣಾ ಜಾಮೀನು ನೀಡಲಾಗಿದ್ದರೆ ಅರ್ಜಿದಾರನಿಗೂ ಸಮಾನತೆಯ ಆಧಾರದ ಮೇಲೆ ಜಾಮೀನು ನೀಡಬಹುದು";

describe("multilingual research", () => {
  it("detects the script, resolves the answer language and tells the model to keep quotes in the source language", () => {
    expect(questionLanguage(KN_QUESTION)).toMatchObject({ script: "Kannada", language: "kn", needsTranslation: true });
    expect(questionLanguage("anticipatory bail parity")).toMatchObject({ language: "en", needsTranslation: false });
    expect(questionLanguage("ముందస్తు బెయిల్").language).toBe("te");
    expect(resolveAnswerLanguage({ question: KN_QUESTION })).toBe("kn");
    expect(resolveAnswerLanguage({ question: KN_QUESTION, requested: "en" })).toBe("en");
    setPreferredAnswerLanguageHook(() => "te");
    expect(resolveAnswerLanguage({ question: "anticipatory bail" })).toBe("te");
    setPreferredAnswerLanguageHook(null);
    expect(resolveAnswerLanguage({ question: "x", requested: "zz" })).toBe("en");
    expect(answerLanguageLine("kn")).toContain("Kannada (ಕನ್ನಡ)");
    expect(answerLanguageLine("kn")).toContain("(translation)");
  });

  it("translates a Kannada question into English search terms (matter-bound → the privacy-checked path), searches both, answers in Kannada with a verified Kannada quote", async () => {
    const matter = db().matters.all()[0];
    const seen: { matterId?: string | null; language: string }[] = [];
    const answer = `## Question Presented\nಸಮಾನತೆ.\n\n## Short Answer\nಹೌದು [2 ¶3].\n\n## Analysis\n“${KN_QUOTE}” [2 ¶3] — If anticipatory bail was granted to the co-accused, the petitioner may also be granted bail on parity (translation).\n\n## Contrary Authority\nNo contrary authority was found among the sources reviewed.\n\n## Open Issues\n- None.\n\n## Sources\n[2] ${KAN_HC.title}, 2023:KHC-D:8801`;
    const deps = indiaFakeDeps({
      judgments: [SC_BAIL, KAN_HC],
      answer,
      translate: async (i) => { seen.push({ matterId: i.matterId, language: i.language }); return { query: "anticipatory bail parity co-accused" }; },
      verify: async () => verification([{ claim: "Bail may be granted on parity", status: "supported", sourceIndex: 1, quote: KN_QUOTE }]),
    });
    const c = collect();
    const res = await runResearch({ question: KN_QUESTION, settings: settings({ matterId: matter.id }), runId: "run_kn_1" }, c.send, undefined, deps);
    expect(seen).toEqual([{ matterId: matter.id, language: "Kannada" }]);
    expect(res.message.queryLanguage).toBe("kn");
    expect(res.message.answerLanguage).toBe("kn");
    expect(res.message.searchQuery).toBe("anticipatory bail parity co-accused");
    expect(deps.queries.some((q) => q.endsWith("|anticipatory bail parity co-accused"))).toBe(true);
    expect(deps.queries.some((q) => q.endsWith(`|${KN_QUESTION}`))).toBe(true); // the question's own words are searched too
    expect(c.events.some((e) => e.type === "tool.completed" && e.name === "translate_query")).toBe(true);
    const input = JSON.stringify(deps.synth[0].input);
    expect(input).toContain("Answer language: Kannada (ಕನ್ನಡ)");
    expect(input).toContain("English search terms used: anticipatory bail parity co-accused");
    expect(res.message.verification?.supported).toBe(1);
    expect(res.message.verification?.verdicts?.some((v) => v.quoteVerified === true && v.paragraph === 3)).toBe(true);
    expect(res.message.verification?.verdicts?.some((v) => /translation|language/.test(v.note ?? ""))).toBe(false);
    void KAN_HC_TEXT;
  });

  it("flags a translation presented as the court's words (quoted English attributed to a Kannada judgment)", async () => {
    const answer = `## Short Answer\nThe Court said “if anticipatory bail was granted to the co-accused, the petitioner may also get bail on parity” [2 ¶3].\n\n## Sources\n[2] ${KAN_HC.title}`;
    const deps = indiaFakeDeps({ judgments: [SC_BAIL, KAN_HC], answer, verify: async () => verification([{ claim: "Parity", status: "supported", sourceIndex: 1 }]), correct: async (i) => i.input.split("ANSWER:\n")[1].split("\n\nSOURCES")[0] });
    const res = await runResearch({ question: "Is parity a ground for anticipatory bail?", settings: settings(), runId: "run_kn_2" }, () => {}, undefined, deps);
    const flagged = res.message.verification?.verdicts?.find((v) => v.claim.startsWith("Quotation attributed to [2]"));
    expect(flagged?.status).toBe("unsupported");
    expect(flagged?.note).toContain("not in the language of source [2]");
  });

  it("without a model provider the regional-language question is searched in its own words and the translation step says so", async () => {
    const deps = indiaFakeDeps({ hasKey: false, judgments: [KAN_HC] });
    const c = collect();
    const res = await runResearch({ question: KN_QUESTION, settings: settings(), runId: "run_kn_3" }, c.send, undefined, deps);
    const failed = c.events.find((e) => e.type === "tool.failed" && e.name === "translate_query");
    expect(failed && "error" in failed ? failed.error : "").toMatch(/own words/);
    expect(res.message.searchQuery).toBeNull();
    expect(deps.queries.some((q) => q.includes("ನಿರೀಕ್ಷಣಾ"))).toBe(true);
    expect(res.stats.sources).toBeGreaterThan(0);
  });
});

describe("forum from the matter and the IPC/BNS date rule", () => {
  it("uses the matter's court as the forum when \"Matter's court\" is selected; an explicit forum wins", async () => {
    const now = new Date().toISOString();
    db().matters.put({ id: "m_india_forum_ts", slug: "ts-forum", name: "Test v. State of Telangana", shortName: "TS forum test", client: "Test", clientSide: "petitioner", practiceArea: "Litigation", court: "High Court for the State of Telangana at Hyderabad", status: "active", openedAt: now, teamIds: [] });
    const deps = indiaFakeDeps();
    const res = await runResearch({ question: "parity", settings: settings({ jurisdiction: "matter-forum", matterId: "m_india_forum_ts" }), runId: "run_forum_1" }, () => {}, undefined, deps);
    expect(res.message.forum).toBe("hc-telangana");
    expect(deps.queries.some((q) => q.startsWith("caselaw|sci hc-telangana|"))).toBe(true);
    const ev = new Map(deps.synth[0].evidence.map((e) => [e.source, e.title]));
    expect(ev.get("judgment://hc-telangana/j_ts_syed_imran")).toContain("BINDING on the forum");
    const explicit = await runResearch({ question: "parity", settings: settings({ jurisdiction: "hc-karnataka", matterId: "m_india_forum_ts" }), runId: "run_forum_2" }, () => {}, undefined, indiaFakeDeps());
    expect(explicit.message.forum).toBe("hc-karnataka");
  });

  it("reads the offence date from the question and applies the shared transition rule (requires_review without a date)", async () => {
    expect(offenceDateFromText("Accused of cheating under Section 420 IPC for an offence committed on 15.03.2024")).toBe("2024-03-15");
    expect(offenceDateFromText("The FIR alleges the offence occurred on 2 August 2024.")).toBe("2024-08-02");
    expect(offenceDateFromText("Hearing on 01.02.2025 and judgment of 03.04.2019")).toBeNull();
    const before = indiaFakeDeps();
    const r1 = await runResearch({ question: "Accused of cheating under Section 420 IPC for an offence committed on 15.03.2024: which code applies?", settings: settings(), runId: "run_offence_1" }, () => {}, undefined, before);
    expect(r1.message.offence).toEqual({ date: "2024-03-15", substantive: "IPC" });
    expect(JSON.stringify(before.synth[0].input)).toContain("Substantive code under the transition rule: IPC");
    const after = indiaFakeDeps();
    const r2 = await runResearch({ question: "Cheating offence committed on 2 August 2024 — IPC or BNS?", settings: settings(), runId: "run_offence_2" }, () => {}, undefined, after);
    expect(r2.message.offence).toEqual({ date: "2024-08-02", substantive: "BNS" });
    const none = indiaFakeDeps();
    const r3 = await runResearch({ question: "Is anticipatory bail available for an offence under Section 420 IPC?", settings: settings(), runId: "run_offence_3" }, () => {}, undefined, none);
    expect(r3.message.offence).toBeUndefined();
    expect(JSON.stringify(none.synth[0].input)).toContain("Substantive code under the transition rule: requires_review");
  });
});
