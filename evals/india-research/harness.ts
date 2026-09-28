/**
 * India research evals: one deterministic executor per case in evals/india-research/cases. Executors run the real
 * research engine (planner, lanes, evidence blocks, code-checked quotes, citation checks, the court registry and the
 * criminal-code correspondence) against fakes for retrieval and models (fictional judgments in ./fixtures.ts), and
 * grade in code. No network, no model.
 */
import fs from "node:fs";
import path from "node:path";
import { applicableCode } from "@/lib/india/criminal-code-map";
import { mapCriminalSection } from "@/lib/ai/toolkit/india-criminal-map";
import { extractCitations } from "@/lib/india/citations";
import { runResearch } from "@/modules/search/engine/run";
import { planLanes } from "@/modules/search/engine/planner";
import { ADVERSE_SUBQUESTION_MARK } from "@/modules/search/engine/planner";
import { citedNumbers } from "@/modules/search/engine/markers";
import { NO_ANSWER_SENTENCE } from "@/modules/search/engine/prompts";
import type { ResearchStreamEvent } from "@/modules/search/engine/types";
import { classifyAuthority } from "@/modules/search/jurisdictions";
import { sanitizeSettings } from "@/modules/search/service";
import type { SearchHit, SearchSettings } from "@/modules/search/types";
import { ALL_JUDGMENTS, forHit, indiaFakeDeps, KAN_HC, SC_BAIL, verification } from "./fixtures";

export interface IndiaEvalCase { id: string; category: string; title: string; constitution: string; input: Record<string, unknown>; expected: string; passCriteria: string[]; grading: "code"; requiresModel: boolean }
export interface IndiaEvalCheck { name: string; ok: boolean; actual?: string }
export interface IndiaEvalResult { id: string; title: string; status: "pass" | "fail"; checks: IndiaEvalCheck[]; durationMs: number; metrics?: Record<string, number | null> }

export const INDIA_CASES_DIR = path.join(__dirname, "cases");

export function loadIndiaCases(): IndiaEvalCase[] {
  return fs.readdirSync(INDIA_CASES_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(INDIA_CASES_DIR, f), "utf8")) as IndiaEvalCase);
}

class Checks {
  list: IndiaEvalCheck[] = [];
  check(name: string, ok: boolean, actual?: unknown) { this.list.push({ name, ok, actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual) }); }
}

const settingsFor = (over: Partial<SearchSettings>) => sanitizeSettings({ sources: ["caselaw", "statutes"], jurisdiction: "hc-karnataka", ...over });
const byId = (ids: unknown): SearchHit[] => (Array.isArray(ids) ? ids : []).map((id) => ALL_JUDGMENTS.find((h) => h.india?.judgmentId === id)).filter((h): h is SearchHit => Boolean(h));

type Executor = (c: IndiaEvalCase, k: Checks) => Promise<Record<string, number | null> | void>;

const EXECUTORS: Record<string, Executor> = {
  async "india-adverse-controlling-sc"(c, k) {
    const adverseId = String(c.input.adverse);
    const deps = indiaFakeDeps({ judgments: byId(c.input.corpus), readIds: 3 });
    const events: ResearchStreamEvent[] = [];
    const res = await runResearch({ question: String(c.input.question), settings: settingsFor({ jurisdiction: String(c.input.forum), sources: ["caselaw"] }), runId: `eval_${c.id}` }, (e) => events.push(e), undefined, deps);
    const contraryLane = res.message.lanes?.find((l) => l.kind === "contrary");
    k.check("adverse lane ran and completed", contraryLane?.status === "done", contraryLane);
    const found = events.filter((e): e is Extract<ResearchStreamEvent, { type: "source.found" }> => e.type === "source.found" && e.laneId.startsWith("lane_contrary"));
    k.check("adverse lane found the adverse Supreme Court judgment", found.some((e) => e.sourceId === `judgment:${adverseId}`));
    const block = deps.synth[0]?.evidence.find((e) => e.source === `judgment://sci/${adverseId}`);
    for (const needle of ["BINDING on the forum", "3-judge bench", "decided 6 May 2024", "2024 INSC 390", "court: SC"]) k.check(`evidence title states ${needle}`, Boolean(block?.title.includes(needle)), block?.title);
    const courts = (deps.synth[0]?.evidence ?? []).filter((e) => e.source.startsWith("judgment://")).map((e) => e.source.split("/")[2]);
    const firstHc = courts.findIndex((x) => x !== "sci");
    k.check("Supreme Court sources are numbered before High Court sources", firstHc === -1 || courts.lastIndexOf("sci") < firstHc, courts);
    k.check("adverse sub-question kept", Boolean(res.message.subQuestions?.some((q) => q.includes(ADVERSE_SUBQUESTION_MARK))), res.message.subQuestions);
    return { firstEvidenceMs: res.metrics.firstEvidenceMs, verifiedAnswerMs: res.metrics.verifiedAnswerMs };
  },

  async "india-forum-karnataka-vs-telangana"(c, k) {
    const hits = byId(c.input.corpus);
    const label = (id: string, forum: string) => { const h = hits.find((x) => x.india?.judgmentId === id)!; return classifyAuthority(h.india?.courtId, forum, undefined, h.date); };
    const expect: [string, string, string][] = [
      ["j_kar_ravi_kumar", "hc-karnataka", "binding"], ["j_kar_ravi_kumar", "ka-subordinate", "binding"], ["j_kar_ravi_kumar", "hc-telangana", "persuasive"],
      ["j_ts_syed_imran", "hc-telangana", "binding"], ["j_ts_syed_imran", "hc-karnataka", "persuasive"],
      ["j_hyd_venkata_rao", "hc-telangana", "persuasive"], ["j_hyd_venkata_rao", "hc-karnataka", "persuasive"],
      ["j_bom_anil_patil", "hc-karnataka", "persuasive"], ["j_bom_anil_patil", "hc-telangana", "persuasive"],
    ];
    for (const [id, forum, want] of expect) k.check(`${id} is ${want} for ${forum}`, label(id, forum) === want, label(id, forum));
    for (const forum of ["hc-karnataka", "hc-telangana"]) {
      const lanes = planLanes({ question: "parity in anticipatory bail", settings: settingsFor({ jurisdiction: forum }), mode: "deep", hasMatter: false });
      k.check(`binding lane for ${forum} searches only sci + ${forum}`, JSON.stringify(lanes[0].courtFilter) === JSON.stringify(["sci", forum]), lanes[0].courtFilter);
      const deps = indiaFakeDeps({ judgments: hits, readIds: 4 });
      await runResearch({ question: "parity in anticipatory bail", settings: settingsFor({ jurisdiction: forum, sources: ["caselaw"] }), runId: `eval_${c.id}_${forum}` }, () => {}, undefined, deps);
      for (const h of hits) {
        const want = label(h.india!.judgmentId!, forum) === "binding" ? "BINDING on the forum" : "PERSUASIVE for the forum";
        const title = deps.synth[0]?.evidence.find((e) => e.source === `judgment://${h.india!.courtId}/${h.india!.judgmentId}`)?.title;
        k.check(`evidence for ${h.india!.judgmentId} in ${forum} says ${want}`, Boolean(title?.includes(want)), title);
      }
    }
  },

  async "india-ipc-bns-boundary"(c, k) {
    const m = mapCriminalSection({ code: "IPC", section: "420" });
    k.check("IPC 420 maps to BNS 318(4)", "status" in m && m.status === "mapped" && m.candidates[0]?.code === "BNS" && m.candidates[0]?.section === "318(4)", m);
    const want: [unknown, string][] = [["2024-06-30", "IPC"], ["2024-07-01", "BNS"], [null, "requires_review"], [{ from: "2024-06-15", to: "2024-07-10" }, "requires_review"]];
    for (const [d, code] of want) { const a = applicableCode(d as never); k.check(`offence ${JSON.stringify(d)} → ${code}`, a.substantive === code, a); }
    const qs = c.input.questions as string[];
    const expectCodes = ["IPC", "BNS"];
    for (let i = 0; i < qs.length; i++) {
      const deps = indiaFakeDeps({ judgments: [SC_BAIL] });
      const res = await runResearch({ question: qs[i], settings: settingsFor({}), runId: `eval_${c.id}_${i}` }, () => {}, undefined, deps);
      k.check(`engine reads the date and applies the rule (${expectCodes[i]})`, res.message.offence?.substantive === expectCodes[i], res.message.offence);
      k.check("synthesis input states the rule", JSON.stringify(deps.synth[0]?.input ?? "").includes(`Substantive code under the transition rule: ${expectCodes[i]}`));
    }
  },

  async "india-kannada-query"(c, k) {
    const question = String(c.input.question);
    const quote = "ಸಹ ಆರೋಪಿಗೆ ನಿರೀಕ್ಷಣಾ ಜಾಮೀನು ನೀಡಲಾಗಿದ್ದರೆ ಅರ್ಜಿದಾರನಿಗೂ ಸಮಾನತೆಯ ಆಧಾರದ ಮೇಲೆ ಜಾಮೀನು ನೀಡಬಹುದು";
    const translations: { matterId?: string | null }[] = [];
    const answer = `## Short Answer\nಹೌದು [2 ¶3].\n\n## Analysis\n“${quote}” [2 ¶3] — the petitioner may be granted bail on parity (translation).\n\n## Sources\n[2] ${KAN_HC.title}`;
    const deps = indiaFakeDeps({ judgments: byId(c.input.corpus), answer, translate: async (i) => { translations.push({ matterId: i.matterId }); return { query: "anticipatory bail parity co-accused" }; }, verify: async () => verification([{ claim: "Parity", status: "supported", sourceIndex: 1, quote }]) });
    const res = await runResearch({ question, settings: settingsFor({ jurisdiction: String(c.input.forum), matterId: "m_eval_kn" }), runId: `eval_${c.id}` }, () => {}, undefined, deps);
    k.check("query and answer language are Kannada", res.message.queryLanguage === "kn" && res.message.answerLanguage === "kn", [res.message.queryLanguage, res.message.answerLanguage]);
    k.check("translation called once with the matter id (privacy-checked path)", translations.length === 1 && translations[0].matterId === "m_eval_kn", translations);
    k.check("searched with English terms", deps.queries.some((q) => q.endsWith("|anticipatory bail parity co-accused")));
    k.check("searched with the Kannada question", deps.queries.some((q) => q.endsWith(`|${question}`)));
    k.check("Kannada quotation verified in code at ¶3", Boolean(res.message.verification?.verdicts?.some((v) => v.quoteVerified === true && v.paragraph === 3)), res.message.verification?.verdicts);
    const bad = indiaFakeDeps({ judgments: byId(c.input.corpus), answer: `## Short Answer\nThe Court said “the petitioner may also get bail on parity with the co-accused” [2 ¶3].`, verify: async () => verification([{ claim: "Parity", status: "supported", sourceIndex: 1 }]), correct: async (i) => i.input.split("ANSWER:\n")[1].split("\n\nSOURCES")[0] });
    const r2 = await runResearch({ question, settings: settingsFor({ jurisdiction: String(c.input.forum) }), runId: `eval_${c.id}_bad` }, () => {}, undefined, bad);
    const flag = r2.message.verification?.verdicts?.find((v) => v.claim.startsWith("Quotation attributed to [2]"));
    k.check("translated quote presented as the court's words is flagged", flag?.status === "unsupported" && /not in the language of source/.test(flag?.note ?? ""), flag);
    return { firstEvidenceMs: res.metrics.firstEvidenceMs, verifiedAnswerMs: res.metrics.verifiedAnswerMs };
  },

  async "india-no-answer-in-corpus"(c, k) {
    const deps = indiaFakeDeps({ judgments: [], statutes: [] });
    const res = await runResearch({ question: String(c.input.question), settings: settingsFor({ jurisdiction: String(c.input.forum) }), runId: `eval_${c.id}` }, () => {}, undefined, deps);
    k.check("no synthesis call", !deps.calls.includes("synthesize"), deps.calls);
    k.check("noAnswer set and the sentence stated", res.message.noAnswer === true && res.message.content.includes(NO_ANSWER_SENTENCE));
    k.check("no citation markers", citedNumbers(res.message.content).size === 0);
    k.check("no Indian citation invented", extractCitations(res.message.content).filter((x) => x.kind === "neutral" || x.kind === "reporter").length === 0);
    k.check("broadened twice before stopping", res.stats.rounds === 3, res.stats.rounds);
    k.check("terminal partial / source_unavailable", res.terminal === "partial" && res.stop === "source_unavailable", [res.terminal, res.stop]);
  },
};

export async function runIndiaResearchEvals(ids: string[] = []): Promise<IndiaEvalResult[]> {
  const cases = loadIndiaCases().filter((c) => !ids.length || ids.includes(c.id));
  const out: IndiaEvalResult[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    const k = new Checks();
    let metrics: Record<string, number | null> | undefined;
    const exec = EXECUTORS[c.id];
    if (!exec) k.check("executor exists", false, c.id);
    else {
      try { metrics = (await exec(c, k)) ?? undefined; } catch (e) { k.check("executor ran", false, (e as Error).stack ?? String(e)); }
    }
    out.push({ id: c.id, title: c.title, status: k.list.every((x) => x.ok) && k.list.length > 0 ? "pass" : "fail", checks: k.list, durationMs: Date.now() - t0, metrics });
  }
  return out;
}

void forHit;
