/**
 * Fixtures and fakes for the Indian research engine tests and evals.
 *
 * Every judgment below is FICTIONAL (invented parties, invented but well-formed neutral and reporter citations) so
 * that no real authority is misdescribed; the court registry, the citation parser and the binding rules they exercise
 * are the real ones. Fakes return these as search hits and texts; no network, no model.
 */
import type { AgentEvent } from "@/lib/ai/agent";
import type { ToolDef } from "@/lib/ai/tools";
import type { VerificationResult } from "@/lib/ai/verify";
import { cacheKey } from "@/modules/search/engine/cache";
import type { EngineDeps, ResearchPlan } from "@/modules/search/engine/deps";
import { classifyAuthority } from "@/modules/search/jurisdictions";
import type { SearchHit, SearchSettings } from "@/modules/search/types";

type JudgmentSeed = { id: string; title: string; courtId: string | null; unresolvedCourt?: string; bench: number; date: string; neutral?: string; reporters?: string[]; language?: string; judges: string[]; snippet: string; caseNumber?: string };

/** A judgment search hit as the engine's retrieval produces it (authority computed per forum by `forHit`). */
export function judgmentHit(j: JudgmentSeed): SearchHit {
  return {
    id: `judgment:${j.id}`,
    source: "caselaw",
    title: j.title,
    cite: j.neutral ?? j.reporters?.[0],
    citations: [j.neutral, ...(j.reporters ?? [])].filter((x): x is string => Boolean(x)),
    court: j.courtId ?? undefined,
    courtId: j.courtId ?? undefined,
    date: j.date,
    snippet: j.snippet,
    judge: j.judges.join(", "),
    docketNumber: j.caseNumber,
    authority: "n/a",
    readRef: { kind: "judgment", id: j.id },
    india: { judgmentId: j.id, courtId: j.courtId, unresolvedCourt: j.unresolvedCourt, benchStrength: j.bench, judges: j.judges, neutralCitation: j.neutral, reporterCitations: j.reporters, caseNumber: j.caseNumber, language: j.language ?? "en" },
  };
}

/** The hit with its binding/persuasive label for a forum (deterministic, as the real retrieval computes it). */
export function forHit(h: SearchHit, jurisdiction: string): SearchHit {
  return h.source === "caselaw" ? { ...h, authority: classifyAuthority(h.india?.courtId ?? h.courtId, jurisdiction, undefined, h.date) } : h;
}

export const SC_BAIL = judgmentHit({ id: "j_sc_meera_nair", title: "Meera Nair v. State of Karnataka", courtId: "sci", bench: 3, date: "2023-03-14", neutral: "2023 INSC 212", reporters: ["(2023) 5 SCC 301"], judges: ["A. Justice", "B. Justice", "C. Justice"], snippet: "anticipatory bail cannot be refused only because the offence is economic" });
export const SC_ADVERSE = judgmentHit({ id: "j_sc_kavitha_reddy", title: "Union of India v. Kavitha Reddy", courtId: "sci", bench: 3, date: "2024-05-06", neutral: "2024 INSC 390", reporters: ["(2024) 7 SCC 88"], judges: ["D. Justice", "E. Justice", "F. Justice"], snippet: "in grave economic offences anticipatory bail is the exception" });
export const KAR_HC = judgmentHit({ id: "j_kar_ravi_kumar", title: "Ravi Kumar v. State of Karnataka", courtId: "hc-karnataka", bench: 1, date: "2024-02-10", neutral: "2024:KHC:5123", judges: ["G. Justice"], snippet: "parity with co-accused granted anticipatory bail", caseNumber: "Crl.P. No. 1234 of 2024" });
export const TS_HC = judgmentHit({ id: "j_ts_syed_imran", title: "Syed Imran v. State of Telangana", courtId: "hc-telangana", bench: 2, date: "2022-08-19", neutral: "2022:TSHC:3301", judges: ["H. Justice", "I. Justice"], snippet: "a Division Bench declined anticipatory bail where custodial interrogation was necessary" });
export const AP_COMBINED = judgmentHit({ id: "j_hyd_venkata_rao", title: "K. Venkata Rao v. State of Andhra Pradesh", courtId: "hc-telangana", bench: 2, date: "2016-07-12", reporters: ["2016 (4) ALT 112"], judges: ["J. Justice", "K. Justice"], snippet: "the erstwhile common High Court on parity in anticipatory bail" });
export const BOM_HC = judgmentHit({ id: "j_bom_anil_patil", title: "Anil Patil v. State of Maharashtra", courtId: "hc-bombay", bench: 1, date: "2021-11-02", reporters: ["2021 SCC OnLine Bom 4512"], judges: ["L. Justice"], snippet: "parity is not a rule of thumb" });
export const KAN_HC = judgmentHit({ id: "j_kar_srinivasa_kn", title: "ಶ್ರೀನಿವಾಸ ವಿರುದ್ಧ ಕರ್ನಾಟಕ ರಾಜ್ಯ", courtId: "hc-karnataka", bench: 1, date: "2023-09-01", neutral: "2023:KHC-D:8801", language: "kn", judges: ["M. Justice"], snippet: "ನಿರೀಕ್ಷಣಾ ಜಾಮೀನು" });
export const BNSS_482: SearchHit = { id: "section:bnss-2023:482", source: "statutes", title: "Bharatiya Nagarik Suraksha Sanhita, s. 482 — Direction for grant of bail to person apprehending arrest", cite: "Bharatiya Nagarik Suraksha Sanhita, s. 482", date: "2024-07-01", snippet: "When any person has reason to believe that he may be arrested on an accusation of having committed a non-bailable offence", authority: "n/a", readRef: { kind: "section", id: "bnss-2023:482" }, india: { enactment: "Bharatiya Nagarik Suraksha Sanhita", section: "482", provider: "india-code" } };
export const IPC_420: SearchHit = { id: "section:ipc-1860:420", source: "statutes", title: "Indian Penal Code, s. 420 — Cheating and dishonestly inducing delivery of property", cite: "Indian Penal Code, s. 420", date: "1860-10-06", snippet: "Whoever cheats and thereby dishonestly induces the person deceived", authority: "n/a", readRef: { kind: "section", id: "ipc-1860:420" }, india: { enactment: "Indian Penal Code", section: "420", replacedBy: "Bharatiya Nyaya Sanhita, 2023", provider: "india-code" } };
export const FIRM_MEMO: SearchHit = { id: "library:lib_bail_note", source: "library", title: "Anticipatory bail practice note (Bengaluru)", snippet: "parity and economic offences", authority: "n/a", readRef: { kind: "library", id: "lib_bail_note" }, url: "/library?item=lib_bail_note" };

export const SC_BAIL_TEXT = [
  "Meera Nair v. State of Karnataka",
  "Supreme Court of India",
  "Neutral citation: 2023 INSC 212",
  "1. Leave granted. The appellant challenges the refusal of anticipatory bail by the High Court.",
  "2. The only reason given for refusal was that the offence alleged is an economic offence.",
  "3. We hold that anticipatory bail cannot be refused only because the offence is economic in nature; the court must weigh the nature of the accusation, the antecedents of the applicant and the possibility of the applicant fleeing from justice.",
  "4. The appeal is allowed.",
].join("\n");
export const SC_ADVERSE_TEXT = [
  "Union of India v. Kavitha Reddy",
  "Supreme Court of India",
  "Neutral citation: 2024 INSC 390",
  "1. The question is whether anticipatory bail should ordinarily be granted in economic offences involving public money.",
  "2. We are of the considered view that in grave economic offences affecting the public exchequer, anticipatory bail is the exception and not the rule, because custodial interrogation is often necessary to trace the money.",
  "3. Meera Nair v. State of Karnataka, 2023 INSC 212, is distinguished; it did not concern public money.",
].join("\n");
export const KAR_HC_TEXT = ["Ravi Kumar v. State of Karnataka", "High Court of Karnataka", "Neutral citation: 2024:KHC:5123", "1. The petitioner seeks anticipatory bail under Section 438 of the Code of Criminal Procedure.", "2. The co-accused with an identical role has been granted anticipatory bail; the petitioner is entitled to parity.", "3. The petition is allowed."].join("\n");
export const TS_HC_TEXT = ["Syed Imran v. State of Telangana", "High Court for the State of Telangana", "Neutral citation: 2022:TSHC:3301", "1. The petitioners seek anticipatory bail.", "2. Custodial interrogation is necessary to recover the documents; parity with a co-accused whose role differs cannot be claimed.", "3. The petition is dismissed."].join("\n");
export const AP_COMBINED_TEXT = ["K. Venkata Rao v. State of Andhra Pradesh", "High Court of Judicature at Hyderabad", "1. Parity is a relevant consideration in anticipatory bail where the roles are identical.", "2. The petition is allowed."].join("\n");
export const BOM_HC_TEXT = ["Anil Patil v. State of Maharashtra", "High Court of Bombay", "1. Parity is not a rule of thumb; the role of each accused must be examined.", "2. The application is rejected."].join("\n");
/** Kannada judgment text of record (fictional). ¶3 is the sentence quoted in the multilingual eval. */
export const KAN_HC_TEXT = ["ಶ್ರೀನಿವಾಸ ವಿರುದ್ಧ ಕರ್ನಾಟಕ ರಾಜ್ಯ", "ಕರ್ನಾಟಕ ಉಚ್ಚ ನ್ಯಾಯಾಲಯ", "3. ಸಹ ಆರೋಪಿಗೆ ನಿರೀಕ್ಷಣಾ ಜಾಮೀನು ನೀಡಲಾಗಿದ್ದರೆ ಅರ್ಜಿದಾರನಿಗೂ ಸಮಾನತೆಯ ಆಧಾರದ ಮೇಲೆ ಜಾಮೀನು ನೀಡಬಹುದು.", "4. ಅರ್ಜಿಯನ್ನು ಪುರಸ್ಕರಿಸಲಾಗಿದೆ."].join("\n");
export const BNSS_482_TEXT = "482. (1) When any person has reason to believe that he may be arrested on an accusation of having committed a non-bailable offence, he may apply to the High Court or the Court of Session for a direction under this section; and that Court may, if it thinks fit, direct that in the event of such arrest, he shall be released on bail.";
export const IPC_420_TEXT = "420. Whoever cheats and thereby dishonestly induces the person deceived to deliver any property to any person shall be punished with imprisonment of either description for a term which may extend to seven years, and shall also be liable to fine.";

export const TEXTS: Record<string, string> = {
  "judgment:j_sc_meera_nair": SC_BAIL_TEXT,
  "judgment:j_sc_kavitha_reddy": SC_ADVERSE_TEXT,
  "judgment:j_kar_ravi_kumar": KAR_HC_TEXT,
  "judgment:j_ts_syed_imran": TS_HC_TEXT,
  "judgment:j_hyd_venkata_rao": AP_COMBINED_TEXT,
  "judgment:j_bom_anil_patil": BOM_HC_TEXT,
  "judgment:j_kar_srinivasa_kn": KAN_HC_TEXT,
  "section:bnss-2023:482": BNSS_482_TEXT,
  "section:ipc-1860:420": IPC_420_TEXT,
  "library:lib_bail_note": "Practice note: parity arguments succeed when roles are identical.",
};

export const ALL_JUDGMENTS = [SC_BAIL, SC_ADVERSE, KAR_HC, TS_HC, AP_COMBINED, BOM_HC, KAN_HC];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function verification(verdicts: VerificationResult["verdicts"]): VerificationResult {
  const supported = verdicts.filter((v) => v.status === "supported").length;
  const contradicted = verdicts.filter((v) => v.status === "contradicted").length;
  const score = verdicts.length ? supported / verdicts.length : 0;
  return { verdicts, supported, unsupported: verdicts.length - supported - contradicted, contradicted, score, status: contradicted ? "contradicted" : score >= 0.9 ? "verified" : "partially-verified", sourceBacked: supported > 0, checkedAt: new Date().toISOString() };
}

export interface IndiaFakeOpts {
  hasKey?: boolean;
  latency?: { retrieve?: number; read?: number; agent?: number; plan?: number; synth?: number; translate?: number };
  answer?: string;
  judgments?: SearchHit[];
  statutes?: SearchHit[];
  library?: SearchHit[];
  verify?: EngineDeps["verify"];
  correct?: EngineDeps["correct"];
  retrieve?: EngineDeps["retrieve"];
  plan?: ResearchPlan | null;
  citing?: EngineDeps["citing"];
  translate?: EngineDeps["translateQuery"] | null;
  /** Source ids the fake lane agent never reads (snippet-only sources). */
  skipRead?: string[];
  readIds?: number;
  failStatutes?: boolean;
  failLibrary?: boolean;
}

/**
 * Fake engine dependencies over the fixtures. Retrieval honours the lane's court filter (`settings.courts`), so the
 * binding / persuasive / adverse lanes see what the real retrieval would give them, and every hit carries the
 * deterministic binding label for the run's forum.
 */
export function indiaFakeDeps(o: IndiaFakeOpts = {}) {
  const calls: string[] = [];
  const queries: string[] = [];
  const synth: { instructions: string; evidence: NonNullable<Parameters<EngineDeps["synthesize"]>[0]["evidence"]>; input: unknown }[] = [];
  const lat = o.latency ?? {};
  const judgments = o.judgments ?? [SC_BAIL, KAR_HC, TS_HC, BOM_HC];
  const answer = o.answer ?? "## Question Presented\nWhether parity supports anticipatory bail.\n\n## Short Answer\nAnticipatory bail cannot be refused only because the offence is economic [1 ¶6].\n\n## Analysis\nThe Supreme Court (3-judge bench, 14 March 2023, 2023 INSC 212, binding) held that “anticipatory bail cannot be refused only because the offence is economic in nature” [1 ¶6]. Treatment not checked.\n\n## Contrary Authority\nNo contrary authority was found among the sources reviewed.\n\n## Open Issues\n- None.\n\n## Sources\n[1] Meera Nair v. State of Karnataka, 2023 INSC 212 : (2023) 5 SCC 301";
  const deps: EngineDeps = {
    hasKey: o.hasKey ?? true,
    model: "primary-test",
    fastModel: "fast-test",
    async retrieve(source, query, s, signal) {
      if (o.retrieve) return o.retrieve(source, query, s, signal);
      calls.push(`retrieve:${source}`);
      queries.push(`${source}|${s.courts ?? ""}|${query}`);
      if (lat.retrieve) await sleep(lat.retrieve);
      if (source === "caselaw") {
        const courts = (s.courts ?? "").split(" ").filter(Boolean);
        const hits = judgments.filter((h) => !courts.length || courts.includes(h.india?.courtId ?? "")).map((h) => forHit(h, s.jurisdiction));
        return { hits, total: hits.length };
      }
      if (source === "statutes") { if (o.failStatutes) throw new Error("fetch failed"); const hits = o.statutes ?? [BNSS_482]; return { hits, total: hits.length }; }
      if (source === "library") { if (o.failLibrary) throw new Error("fetch failed"); const hits = o.library ?? [FIRM_MEMO]; return { hits, total: hits.length }; }
      return { hits: [], total: 0 };
    },
    async read(ref) {
      calls.push(`read:${cacheKey(ref)}`);
      if (lat.read) await sleep(lat.read);
      const text = TEXTS[cacheKey(ref)];
      if (!text) throw new Error("ENOTFOUND");
      return { text, cached: false };
    },
    async laneAgent(input) {
      calls.push("agent");
      if (lat.agent) await sleep(lat.agent);
      const read = input.tools.find((t) => t.name === "read_source") as unknown as ToolDef<{ source_id: string }, unknown>;
      const ids = Array.from(input.input.matchAll(/^(\S+) · /gm)).map((m) => m[1]).filter((id) => !(o.skipRead ?? []).includes(id)).slice(0, o.readIds ?? 2);
      await Promise.all(ids.map((id) => Promise.resolve(read.execute({ source_id: id }, { emit: () => {}, state: {} })).catch(() => null)));
      input.onEvent({ type: "tool.call", id: "x", name: "read_source", label: "Reading", args: {} } as AgentEvent);
      return { text: `- ${ids[0] ?? "none"} — read\nGaps: none`, steps: 1 };
    },
    async synthesize(input) {
      calls.push("synthesize");
      synth.push({ instructions: input.instructions, evidence: input.evidence ?? [], input: input.input });
      if (lat.synth) await sleep(lat.synth);
      for (const chunk of answer.match(/.{1,40}/gs) ?? []) input.onDelta(chunk);
      return answer;
    },
    verify: o.verify ?? (async () => { calls.push("verify"); return verification([{ claim: "Anticipatory bail cannot be refused only because the offence is economic", status: "supported", sourceIndex: 0, quote: "anticipatory bail cannot be refused only because the offence is economic in nature" }]); }),
    correct: o.correct ?? (async (i) => { calls.push("correct"); return i.input.split("ANSWER:\n")[1].split("\n\nSOURCES")[0]; }),
    async refine() { calls.push("refine"); return {}; },
    async followUps() { calls.push("followups"); return ["a?", "b?", "c?"]; },
    async verifyCitationsRemote() { calls.push("remote"); throw new Error("offline"); },
  };
  if (o.plan !== undefined) deps.planQueries = async () => { calls.push("plan"); if (lat.plan) await sleep(lat.plan); if (!o.plan) throw new Error("planner down"); return o.plan; };
  if (o.citing) deps.citing = o.citing;
  if (o.translate !== null) deps.translateQuery = o.translate ?? (async (i) => { calls.push(`translate:${i.language}`); if (lat.translate) await sleep(lat.translate); return { query: "anticipatory bail parity co-accused", model: "router" }; });
  return Object.assign(deps, { calls, queries, synth });
}

export const indiaSettings = (sanitize: (s: Partial<SearchSettings>) => SearchSettings) => (over: Partial<SearchSettings> = {}) => sanitize({ sources: ["caselaw", "statutes", "library"], jurisdiction: "hc-karnataka", ...over });
