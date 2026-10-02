/**
 * Lane planner: a pure function that turns a question + scope into 1–5
 * bounded research lanes. Deterministic so the UI can preview lanes before a
 * run starts and tests can pin the behaviour.
 */
import type { SearchSettings, SearchSource } from "../types";
import { bindingCourtIds, forumCourt, jurisdictionByKey, persuasiveCourtIds, resolveCourts } from "../jurisdictions";
import { toCourtListenerSyntax } from "../query-builder";
import type { LaneKind, ResearchLane, ResearchMode, ResearchSource } from "./types";

export interface PlanInput {
  question: string;
  settings: SearchSettings;
  mode: ResearchMode;
  hasMatter: boolean;
  round?: number;
  /** Refined queries from a previous round's coverage decision (per lane kind). */
  refinements?: Partial<Record<LaneKind, string[]>>;
  /** English search terms when the question was asked in another language (legal terms preserved). */
  searchQuery?: string;
  /**
   * Extra reads (and steps) per deep lane, from the `research_lane` budget of the configured fast model (see
   * laneReadBoost: 0 when the lane's context holds only the base reads). Bounded: at most +3; each extra read adds
   * READ_BOOST_MS to the lane's timeout (the run still caps every lane at the time it has left).
   */
  readBoost?: number;
}

const LANE_TOOLS: Record<LaneKind, string[]> = {
  controlling: ["search_judgments", "read_judgment", "citing_references", "resolve_citation", "compare_authorities", "build_citation", "search_statutes", "verify_citations"],
  persuasive: ["search_judgments", "read_judgment", "citing_references", "compare_authorities", "build_citation"],
  contrary: ["search_judgments", "read_judgment", "citing_references", "resolve_citation", "compare_authorities", "verify_citations"],
  statute: ["search_statutes", "read_section", "map_criminal_section", "search_official_sources", "fetch_url", "build_citation"],
  regulatory: ["search_statutes", "read_section", "map_criminal_section", "search_official_sources", "fetch_url", "build_citation"],
  record: ["search_matter_documents", "read_matter_document", "get_matter_context", "search_official_sources"],
  secondary: ["web_search", "fetch_url", "search_library"],
  fast: ["search_judgments", "search_statutes", "search_library"],
};

const LANE_NAME: Record<LaneKind, { name: string; brief: string }> = {
  controlling: { name: "Binding authority", brief: "Supreme Court and forum High Court judgments, larger benches first" },
  persuasive: { name: "Persuasive authority", brief: "Other High Courts and the erstwhile common High Court at Hyderabad" },
  contrary: { name: "Adverse authority", brief: "The strongest judgments against the answer: distinguished, doubted, overruled, per incuriam, referred to a larger bench" },
  statute: { name: "Statutes (India Code)", brief: "Governing provisions, including the IPC/CrPC/Evidence Act → BNS/BNSS/BSA transition" },
  regulatory: { name: "Statutes (India Code)", brief: "Governing provisions and rules" },
  record: { name: "Matter record", brief: "Matter documents, pleadings and depositions" },
  secondary: { name: "Secondary & web", brief: "Firm library, official pages and the open web" },
  fast: { name: "Fast answer", brief: "One pass over the judgment corpus and India Code" },
};

/** Lanes fed by the intelligence corpus and the note shown on their card. */
const INTEL_LANE_NOTE: Record<LaneKind, string> = {
  controlling: "Searches Supreme Court and High Court judgments: full text where loaded, otherwise the metadata index",
  persuasive: "Searches High Court judgments: full text where loaded, otherwise the metadata index",
  contrary: "Searches the judgment corpus (full text and metadata index)",
  statute: "Searches the statutes corpus and the India Code store",
  regulatory: "Searches the statutes corpus and the India Code store",
  record: "Searches the selected matter only",
  secondary: "Also searches indexed news, official pages and local folders",
  fast: "Searches the judgment corpus and India Code",
};

/** Shown on a lane when the matter record was requested without a selected matter (never widened to all matters). */
export const MATTER_SKIPPED_NOTE = "Matter documents skipped: no matter is selected.";

/** Whether a lane should also retrieve from the intelligence corpus (every provider-backed lane does). */
export function intelFeeds(kind: LaneKind, sources: SearchSource[]): boolean {
  void kind;
  return sources.some((s) => s !== "web" && s !== "ediscovery");
}

/** Clean the natural-language question into a boolean-ish retrieval query. Non-Latin scripts keep their words. */
export function retrievalQuery(question: string): string {
  const q = question.trim().replace(/\s+/g, " ");
  // Already boolean/quoted → keep the operators, just normalise Westlaw-style connectors.
  if (/\b(AND|OR|NOT)\b|"|\/[sp]\b|\/\d+/.test(q)) return toCourtListenerSyntax(q);
  // Natural language → drop stop words and interrogatives, keep the terms of art (section numbers and Acts included).
  const stop = new Set(["is", "a", "an", "the", "of", "to", "in", "on", "for", "under", "against", "does", "do", "did", "can", "may", "what", "which", "when", "how", "are", "was", "were", "be", "by", "with", "and", "or", "at", "from", "that", "this", "it", "its", "as", "after", "before", "whether", "any", "there", "we", "our", "their", "than", "into", "about"]);
  const words = q.replace(/[?!,;:()।॥]/g, " ").replace(/\.(?=\s|$)/g, " ").split(/\s+/).filter((w) => w && !stop.has(w.toLowerCase()));
  return words.slice(0, 14).join(" ");
}

/** Query variant that surfaces authority against the proposition (Indian treatment vocabulary). */
export function contraryQuery(base: string): string {
  return `${base} AND (distinguish* OR "per incuriam" OR overrul* OR doubted OR "larger bench" OR "not good law" OR "cannot be accepted" OR dissent*)`;
}

/** Base read cap of the widest deep lane (controlling); a lane's context must hold more than this before reads are added. */
const BASE_DEEP_READS = 5;
/** Lane time added per extra read (a read plus the agent step that uses it). */
export const READ_BOOST_MS = 8_000;

/**
 * Extra reads per deep lane that the lane model's context can hold (0–3): how many full reads (the reader's result
 * size, as lanes.ts sizes read_source) fit in 75% of the lane's input budget, beyond the base five. A 128K-window or
 * 400K mini model gets none; a 1M-window fast model gets the full +3. Pure.
 */
export function laneReadBoost(b: { inputTokens: number; perSourceChars: number; toolResultChars: number } | null | undefined): number {
  if (!b) return 0;
  const readDefault = Math.max(30_000, b.perSourceChars);
  const readChars = Math.max(32_000, Math.min(b.toolResultChars, readDefault + 4_000));
  const perRead = Math.ceil(readChars / 3);
  const fit = Math.floor((b.inputTokens * 0.75) / perRead);
  return Math.max(0, Math.min(3, fit - BASE_DEEP_READS));
}

/** Per-lane wall-clock budgets (ms). Deep lanes run a bounded agent; later rounds are narrower. */
const LANE_TIMEOUT: Record<LaneKind, number> = { controlling: 110_000, persuasive: 90_000, contrary: 90_000, statute: 75_000, regulatory: 75_000, record: 90_000, secondary: 90_000, fast: 40_000 };

export function planLanes(input: PlanInput): ResearchLane[] {
  const round = input.round ?? 1;
  const base = retrievalQuery(input.searchQuery?.trim() || input.question);
  const s = input.settings;
  const has = (src: SearchSource) => s.sources.includes(src);
  const lanes: ResearchLane[] = [];
  const boost = input.mode === "fast" ? 0 : Math.max(0, Math.min(3, Math.floor(input.readBoost ?? 0)));
  const mk = (kind: LaneKind, sources: SearchSource[], queries: string[], baseSteps: number, baseReads: number, courtFilter?: string[]): ResearchLane => {
    const maxSteps = baseSteps + boost;
    const maxReads = baseReads + boost;
    return {
    id: `lane_${kind}_r${round}`,
    kind,
    ...LANE_NAME[kind],
    sources,
    tools: LANE_TOOLS[kind].filter((t) => t !== "web_search" || has("web")),
    queries: Array.from(new Set((input.refinements?.[kind]?.length ? input.refinements[kind]! : queries).map((q) => q.trim()).filter(Boolean))).slice(0, 3),
    maxSteps,
    maxReads,
    round,
    intel: intelFeeds(kind, sources),
    note: intelFeeds(kind, sources) || kind === "record" ? INTEL_LANE_NOTE[kind] : undefined,
    timeoutMs: (round > 1 ? Math.min(LANE_TIMEOUT[kind], 75_000) : LANE_TIMEOUT[kind]) + boost * READ_BOOST_MS,
    ...(courtFilter?.length ? { courtFilter } : {}),
    };
  };

  if (input.mode === "fast") {
    const sources = s.sources.filter((x) => x !== "web");
    return [mk("fast", sources.length ? sources : ["caselaw"], [base], 1, 2)];
  }

  // Court filters are deterministic from the forum (never from the model). A free-text court override narrows every judgment lane.
  const override = resolveCourts(s.jurisdiction, s.courts).split(" ").filter(Boolean);
  const narrow = (ids: string[]) => (override.length ? ids.filter((id) => override.includes(id)) : ids);
  const binding = narrow(bindingCourtIds(s.jurisdiction));
  const persuasive = narrow(persuasiveCourtIds(s.jurisdiction));
  // Read caps: full judgment text now exists for the Supreme Court and three High Courts, and a failed read no longer
  // counts, so judgment and statute lanes read one more source each (still bounded by maxSteps and the lane timeout).
  if (has("caselaw")) {
    lanes.push(mk("controlling", ["caselaw"], [base], 7, 5, binding.length ? binding : undefined));
    if (persuasive.length || !override.length) lanes.push(mk("persuasive", ["caselaw"], [base], 6, 4, persuasive.length ? persuasive : undefined));
    lanes.push(mk("contrary", ["caselaw"], [contraryQuery(base)], 6, 4, override.length ? override : undefined));
  }
  if (has("statutes")) lanes.push(mk("statute", ["statutes"], [base], 6, 4));
  if (input.hasMatter && has("ediscovery")) lanes.push(mk("record", ["ediscovery"], [base], 6, 4));
  if (has("web") || has("library")) lanes.push(mk("secondary", (["web", "library"] as SearchSource[]).filter(has), [base], 5, 3));

  if (!lanes.length) lanes.push(mk("controlling", ["caselaw"], [base], 7, 5, binding.length ? binding : undefined));
  // Later rounds only re-run lanes that received refinements (the thin ones); round 1 keeps everything.
  const planned = round > 1 && input.refinements ? lanes.filter((l) => input.refinements?.[l.kind]?.length) : lanes;
  const out = (planned.length ? planned : lanes).slice(0, 6);
  // The adverse lane builds on what the binding lane found (authority that doubts, distinguishes or overrules it).
  const controlling = out.find((l) => l.kind === "controlling");
  const contrary = out.find((l) => l.kind === "contrary");
  // Soft dependency: it starts at once (its own adverse queries) and, after its first wave, targets what the binding lane found.
  if (controlling && contrary) contrary.after = [controlling.id];
  // Matter documents were requested but no matter is selected: say so on the lane that would have read them.
  if (has("ediscovery") && !input.hasMatter && out.length) {
    const host = out.find((l) => l.kind === "record") ?? out[0];
    host.note = `${MATTER_SKIPPED_NOTE}${host.note ? ` ${host.note}` : ""}`;
  }
  return out;
}

const CASE_TITLE_RE = /\s(?:v|vs|versus)\.?\s/i;

/**
 * Extra queries a dependent lane runs once its dependencies have settled. The adverse lane targets the leading
 * judgments the binding lane read: decisions that distinguish, doubt or overrule them are what a litigator must see.
 */
export function priorQueries(lane: Pick<ResearchLane, "kind">, priors: { sources: Pick<ResearchSource, "kind" | "title" | "read" | "authority">[] }[]): string[] {
  if (lane.kind !== "contrary") return [];
  const cases = priors.flatMap((p) => p.sources).filter((s) => s.kind === "caselaw" && CASE_TITLE_RE.test(s.title));
  const ranked = [...cases].sort((a, b) => Number(b.read) - Number(a.read) || Number(b.authority === "binding") - Number(a.authority === "binding"));
  const out: string[] = [];
  for (const c of ranked) {
    const name = c.title.replace(/[",]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
    if (!name) continue;
    const q = `"${name}" AND (distinguish* OR overrul* OR "per incuriam" OR doubted OR "larger bench" OR "not good law")`;
    if (!out.includes(q)) out.push(q);
    if (out.length >= 2) break;
  }
  return out;
}

/** Tools relevant to a lane, filtered against what the toolkit exposes. */
export function laneToolNames(lane: ResearchLane): string[] {
  return lane.tools;
}

/** Ordinary legal words that read better lower-cased mid-sentence (a capitalised first word that is not on this list is treated as a name or acronym). */
const LOWERCASE_LEAD = new Set(["the", "a", "an", "government", "federal", "state", "court", "courts", "manufacturer", "manufacturers", "plaintiff", "plaintiffs", "defendant", "defendants", "removal", "preemption", "standard", "statute", "statutes", "regulation", "regulations", "consequential", "punitive", "strict", "comparative", "joint", "class", "expert", "discovery", "deposition", "privilege", "attorney", "work", "damages", "liability", "negligence", "breach", "contract", "warranty", "design", "failure", "product", "products", "jurisdiction", "venue", "choice", "forum", "collateral", "summary", "motion", "motions", "rule", "rules", "evidence", "testimony", "notice", "reporting", "liability"]);

/** The proposition inside a question, for deterministic follow-ups ("Is X available in Y?" → "X available in Y"). */
export function questionTopic(question: string): string {
  let t = question.replace(/\s+/g, " ").replace(/[?!.\s]+$/, "").trim();
  t = t.replace(/^(is|are|was|were|does|do|did|can|could|may|might|must|should|would|will|has|have|had)\s+(?:(?:a|an|the)\s+)?/i, "");
  t = t.replace(/^(what|which|when|how|whether|why|where|who)\s+(?:(?:is|are|does|do|did|can|must|should|would|will)\s+)?(?:(?:the|a|an)\s+)?/i, "");
  if (!t) return question.trim();
  // Lower-case a leading ordinary word ("Removal…" → "removal…") but leave acronyms and case names alone ("TSCA", "PAGA", "Boyle v.").
  if (/^[A-Z][a-z]+\s/.test(t) && !/^[A-Z][a-z]+\s+v\.\s/.test(t) && LOWERCASE_LEAD.has(t.split(" ")[0].toLowerCase())) t = t.charAt(0).toLowerCase() + t.slice(1);
  return t.length > 140 ? t.slice(0, 139).trimEnd() + "…" : t;
}


/** Phrase every adverse-authority sub-question carries (the model plan must keep one). */
export const ADVERSE_SUBQUESTION_MARK = "rejects, distinguishes or limits";

/** Forum wording for prompts and follow-ups ("the High Court of Karnataka", "any court in India"). */
export function forumPhrase(settings: Pick<SearchSettings, "jurisdiction">): string {
  const j = jurisdictionByKey(settings.jurisdiction);
  const f = forumCourt(settings.jurisdiction);
  if (!f) return "courts across India (no forum selected)";
  return j.key.endsWith("-subordinate") ? j.label.split(" (")[0].replace(/^Courts/, "the courts") : `the ${f.name}`;
}

/**
 * Deterministic, forum-aware sub-questions (the fast-model plan refines them when available).
 * Always includes the adverse-authority question in deep mode.
 */
export function planSubQuestions(input: { question: string; settings: SearchSettings; mode: ResearchMode; hasMatter: boolean; matterName?: string; topic?: string }): string[] {
  const where = forumPhrase(input.settings);
  const topic = input.topic ?? questionTopic(input.question);
  const has = (s: SearchSource) => input.settings.sources.includes(s);
  const out = [`What do the Supreme Court and the decisions binding on ${where} hold on ${topic}, and what was the bench strength (larger benches first)?`];
  if (input.mode === "fast") return out;
  if (has("caselaw")) out.push(`What authority ${ADVERSE_SUBQUESTION_MARK} that position (overruled, doubted, per incuriam, referred to a larger bench), and do other High Courts take a different view?`);
  if (has("statutes")) out.push(`Which provisions of India Code govern ${topic}, and which version applies on the relevant date (including the IPC/CrPC/Evidence Act → BNS/BNSS/BSA transition of 1 July 2024)?`);
  if (input.hasMatter && has("ediscovery")) out.push(`What does the record in ${input.matterName ?? "the matter"} show on ${topic}?`);
  return out;
}
