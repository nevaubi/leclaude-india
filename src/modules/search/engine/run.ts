import "server-only";
import { nanoid } from "nanoid";
import type { ResponseInput, ResponseInputItem } from "openai/resources/responses/responses";
import { db } from "@/lib/db";
import { AIConfigError } from "@/lib/ai/config";
import { classifyFailure, createEmitter, isAbortError, STOP_LABEL, type FailureKind, type ResearchStopState, type RunMetrics, type RunTerminalState } from "@/lib/ai/events";
import { LEGAL_STYLE_RULES, todayLine } from "@/lib/ai/prompts";
import { firmLabel } from "../firm";
import { coverageNote, verifierCapacity, type VerificationResult } from "@/lib/ai/verify";
import type { ResolvedBudget } from "@/lib/ai/context-budget";
import { audit } from "@/lib/integrity/audit";
import { attachProvenance } from "@/lib/integrity/record";
import type { Matter } from "@/lib/types/domain";
import { applicableCode } from "@/lib/india/criminal-code-map";
import { transitionFactsFromText, transitionNote } from "@/lib/india/transition";
import { languageInfo } from "@/lib/india/languages";
import { bindingCourtIds, effectiveJurisdiction, jurisdictionByKey, resolveCourts } from "../jurisdictions";
import { formatBluebook } from "../normalize";
import { datePresetRange } from "../query-builder";
import { providerMessage, researchPrincipalId, savedSearches, searchRuns, updateSavedSearch } from "../service";
import { ALL_SOURCES, type SearchHit, type SearchRun, type SearchSettings, type SearchSource } from "../types";
import { configuredTenantId } from "@/lib/ai/vector-store";
import { answerArtifactId, answerHash } from "./binding";
import { buildAuthorityStatus } from "./authority-status";
import { createReadRegistry, sweepCache } from "./cache";
import { buildCitationCheck, crossCheckCitations, normCite, withCitationStates } from "./citecheck";
import { decideCoverage, type CoverageDecision } from "./coverage";
import { defaultDeps, type EngineDeps, type ResearchPlan } from "./deps";
import { buildEvidenceBlocks, evidenceSourceId, evidenceText } from "./evidence";
import { runLane, type LaneResult } from "./lanes";
import { citedNumbers, hasCiteMarker } from "./markers";
import { focusTerms } from "./paragraphs";
import { answerLanguageLine, offenceDateFromText, questionLanguage, resolveAnswerLanguage, setPreferredAnswerLanguageHook } from "./india-context";
import { preferredAnswerLanguage } from "@/lib/i18n/preferences";
import { ADVERSE_SUBQUESTION_MARK, forumPhrase, laneReadBoost, planLanes, planSubQuestions, questionTopic } from "./planner";
import { CORRECTION_INSTRUCTIONS, LANE_NOTE_HEADER, NO_ANSWER_SENTENCE, synthesisInstructions } from "./prompts";
import { assembleProvenance } from "./provenance";
import { checkClaimEvidence, recountVerification } from "./quotes";
import { createLaneBoard, MetricsRecorder, resolvePolicy, scheduleLanes, settleWithin, timedModelCall, withRetry, type RunPolicy } from "./runtime";
import { compactSource, mergeSources, numberSources, renderSourcesForPrompt } from "./sources";
import { appendToThread, createThread, deleteThreadIfEmpty, getThread } from "./threads";
import { currentnessOf } from "./treatment";
import { messageTrustState } from "./trust";
import type { AnswerBanner, AuthorityTreatment, CoverageSummary, LaneKind, LaneSummary, ResearchEventInput, ResearchLane, ResearchMessage, ResearchMode, ResearchSource, ResearchStreamEvent, ResearchThread, RunStats, VerificationSummary } from "./types";

// The signed-in user's answer-language preference (user → workspace; "auto" means the question's own language).
setPreferredAnswerLanguageHook(() => {
  const pref = preferredAnswerLanguage();
  return pref === "auto" ? null : pref;
});

export { questionTopic };

export interface RunResearchInput {
  question: string;
  settings: SearchSettings;
  threadId?: string | null;
  runId?: string;
  savedSearchId?: string;
  /** When the HTTP request was received (for the request → acknowledgement metric). Defaults to the run start. */
  requestedAt?: number;
  /** Overrides for concurrency, timeouts, retries and budgets (tests pass tiny backoffs). */
  policy?: Partial<RunPolicy>;
  /** Issue-level reranking switch for this run (default: RESEARCH_RERANK). Evals compare both. */
  rerank?: boolean;
}

export interface RunResearchResult {
  runId: string;
  threadId: string;
  message: ResearchMessage;
  sources: ResearchSource[];
  stats: RunStats;
  aborted: boolean;
  terminal: RunTerminalState;
  stop?: ResearchStopState;
  failure?: FailureKind;
  metrics: RunMetrics;
}

type Send = (e: ResearchStreamEvent) => void;

const MAX_ROUNDS_DEEP = 3;

/**
 * Hard wall for one research run, under the serverless function limit (300s): past it the platform kills the function
 * and nothing is saved. Every stage below is sized against the time left so the run always reaches its terminal event
 * and persistence. RESEARCH_WALL_MS overrides it on hosts with longer limits.
 */
export function researchWallMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const v = Number(env.RESEARCH_WALL_MS);
  return Number.isFinite(v) && v >= 60_000 ? v : DEFAULT_WALL_MS;
}
/** 280s of the 300s function limit (before: 265s); the last 20s cover persistence, audit and the terminal event. */
export const DEFAULT_WALL_MS = 280_000;
/** Time kept back from the lanes for synthesis and verification. */
const RESERVE_AFTER_LANES_MS = 120_000;
/** A later round only starts with at least this much time left (lanes + synthesis + verification). */
const MIN_ROUND_MS = 150_000;

/** Inputs to the terminal/stop decision, kept explicit so the mapping is testable on its own. */
export interface OutcomeInput {
  aborted: boolean;
  answer: string;
  noKey: boolean;
  failure?: FailureKind;
  failureMessage?: string;
  coverage: CoverageDecision | null;
  timeExceeded: boolean;
  verification: VerificationSummary | null;
  verificationCurrent: boolean;
  verificationUnavailable: string | null;
  sourcesFound: number;
  lanes: LaneSummary[];
}

export interface Outcome {
  terminal: RunTerminalState;
  stop?: ResearchStopState;
  failure?: FailureKind;
  reason: string;
}

/**
 * Map what happened to one explicit terminal state and one stop state (constitution §14, §25).
 * Order: cancelled → failed → not configured → verification failed → budgets → partial reasons → succeeded.
 * The stop state says why evidence gathering stopped; the terminal state says what the run delivered.
 */
export function decideOutcome(i: OutcomeInput): Outcome {
  if (i.aborted) return { terminal: "cancelled", stop: "cancelled", failure: "cancelled", reason: i.answer ? "Stopped by the user; the partial answer is kept" : "Stopped by the user before an answer was produced" };
  if (!i.answer) {
    if (i.noKey) return { terminal: "partial", stop: "hard_limit", failure: "not_configured", reason: "No model provider is configured; the lanes retrieved and read sources but no answer was written" };
    const failure = i.failure ?? "no_result";
    return { terminal: "failed", stop: i.sourcesFound ? undefined : "source_unavailable", failure, reason: i.failureMessage ?? (i.sourcesFound ? "The answer could not be written" : "No sources were retrieved and no answer was written") };
  }
  if (i.verification && i.verificationCurrent && i.verification.contradicted > 0) {
    return { terminal: "verification_failed", stop: i.coverage?.exhausted ? "budget_exhausted" : "coverage_sufficient", failure: "verification_failure", reason: `${i.verification.contradicted} claim${i.verification.contradicted === 1 ? "" : "s"} contradicted by the sources read remain in the answer` };
  }
  if (i.coverage?.exhausted) return { terminal: "budget_exhausted", stop: "budget_exhausted", reason: i.coverage.reason };
  if (i.timeExceeded) return { terminal: "budget_exhausted", stop: "hard_limit", reason: "The run's time budget was spent before coverage was adequate" };
  if (i.sourcesFound === 0) return { terminal: "partial", stop: "source_unavailable", reason: "No sources were retrieved; the answer states general practice and is not source-backed" };
  if (i.verificationUnavailable) return { terminal: "partial", stop: "verification_unavailable", reason: i.verificationUnavailable };
  if (i.verification && !i.verificationCurrent) return { terminal: "partial", stop: "verification_unavailable", reason: "The answer was revised after verification and the revised text was not re-verified" };
  if (!i.verification) return { terminal: "partial", stop: "verification_unavailable", reason: "No claim was checked against a source read in full" };
  // The verifier did not see everything (a source cut short or not shown, answer text beyond its budget, the claim cap).
  if (i.verification.partial) return { terminal: "partial", stop: "coverage_sufficient", reason: coverageNote({ coverage: i.verification.coverage }) || "Verification was partial: not every claim or source was checked" };
  const failed = i.lanes.filter((l) => l.status === "error" || l.status === "timeout" || l.status === "skipped");
  const degraded = i.lanes.filter((l) => l.status === "done" && l.error);
  if (failed.length) return { terminal: "partial", stop: "coverage_sufficient", reason: `${failed.length} of ${i.lanes.length} lanes ${failed.length === 1 ? "did not finish" : "did not finish"}: ${failed.map((l) => `${l.name} (${l.status === "timeout" ? "timed out" : l.error ?? l.status})`).join("; ")}` };
  if (degraded.length) return { terminal: "partial", stop: "coverage_sufficient", reason: `Provider failures inside ${degraded.length === 1 ? "a lane" : `${degraded.length} lanes`}: ${degraded.map((l) => `${l.name} — ${l.error}`).join("; ")}` };
  return { terminal: "succeeded", stop: "coverage_sufficient", reason: i.coverage?.reason ?? "coverage adequate" };
}

/**
 * The research run: plan lanes → schedule them (bounded, dependency-aware) → synthesize
 * from the lane sources only → verify claims against the answer hash → correct and
 * re-verify → cross-check citations → decide whether another round is needed →
 * follow-ups → persist with an explicit terminal state + audit.
 * Streams the §46 event vocabulary; aborts everything on the client's signal.
 */
export async function runResearch(input: RunResearchInput, send: Send, signal: AbortSignal | undefined, deps: EngineDeps = defaultDeps()): Promise<RunResearchResult> {
  const startedAt = Date.now();
  const requestedAt = input.requestedAt ?? startedAt;
  const runId = input.runId ?? `run_${nanoid(10)}`;
  const question = input.question.trim();
  const matter: Matter | null = input.settings.matterId ? db().matters.get(input.settings.matterId) : null;
  // The forum is deterministic: an explicit forum as chosen, "Matter's court" from the matter's court (never the model).
  const settings: SearchSettings = { ...input.settings, jurisdiction: effectiveJurisdiction(input.settings.jurisdiction, matter?.court) };
  const mode: ResearchMode = settings.fast ? "fast" : "deep";
  const policy = resolvePolicy(mode, input.policy);
  const maxRounds = mode === "fast" ? 1 : MAX_ROUNDS_DEEP;
  const qLang = questionLanguage(question);
  const answerLanguage = resolveAnswerLanguage({ requested: settings.answerLanguage, question });
  const offenceDate = settings.offenceDate ?? offenceDateFromText(question);
  // Transition law from data (BNS s.358, BNSS s.531): offence date → substantive code; proceeding date → procedure.
  // "Committed before 1 July 2024" fixes the side of the boundary without an exact date.
  const transition = transitionNote({ question, offenceDate, proceedingDate: settings.proceedingDate });
  const offenceRule = transition.substantive !== "requires_review" ? { substantive: transition.substantive, notes: [] as string[] } : applicableCode(offenceDate ?? null);
  // A relational statement ("committed before 1 July 2024") is not a date of offence: it is shown as the relation.
  const offenceRelation = settings.offenceDate ? "on" : transitionFactsFromText(question).offence?.relation ?? "on";
  const offenceIsExact = Boolean(offenceDate) && offenceRelation === "on";
  const existing = input.threadId ? getThread(input.threadId) : null;
  const threadReplaced = Boolean(input.threadId && !existing);
  const thread: ResearchThread = existing ?? createThread({ question, settings });
  const createdThread = !existing;
  const aborted = () => Boolean(signal?.aborted);
  const metrics = new MetricsRecorder(requestedAt);
  const wallMs = Math.min(policy.runTimeMs, deps.wallMs ?? researchWallMs());
  const wallAt = startedAt + wallMs;
  const remaining = () => wallAt - Date.now();
  /** Stage budgets below are written for the default wall and scale with the effective one (1:1 in production). */
  const scale = Math.min(1, wallMs / DEFAULT_WALL_MS);
  const ms = (n: number) => n * scale;
  /** A stage signal: the client's signal plus a stage deadline; `timedOut` tells a deadline from a client abort. */
  const stage = (budget: number) => {
    const timer = AbortSignal.timeout(Math.round(Math.max(ms(1_000), budget)));
    return { signal: signal ? AbortSignal.any([signal, timer]) : timer, timedOut: () => timer.aborted && !aborted() };
  };

  const emitter = createEmitter<ResearchStreamEvent>(runId, send);
  // Treatment checks start the moment a case is read (in parallel with the other lanes), bounded in number and time.
  const treatments = new Map<string, Promise<AuthorityTreatment | null>>();
  const MAX_TREATMENT_CHECKS = 4;
  const emit = (e: ResearchEventInput) => {
    if (e.type === "source.found") metrics.mark("firstEvidence");
    if (e.type === "source.read") {
      metrics.mark("firstRead");
      const src = e.source;
      // Local-store judgments by id; corpus judgments read in full by their corpus key (mentions of their citation).
      const judgmentId = src.hit.readRef?.kind === "judgment" ? src.hit.readRef.id : src.hit.india?.provider === "corpus" && src.hit.readRef ? src.hit.india.judgmentId : undefined;
      const opinionId = src.hit.readRef?.kind === "opinion" ? src.hit.readRef.id : src.hit.opinionId;
      if (deps.citing && mode === "deep" && src.kind === "caselaw" && (judgmentId || opinionId != null) && !treatments.has(src.id) && treatments.size < MAX_TREATMENT_CHECKS) {
        const t0 = Date.now();
        treatments.set(src.id, deps.citing(judgmentId ? { judgmentId, signal } : { opinionId, signal }).then((t) => { metrics.addToolTime(Date.now() - t0); return t; }, () => null));
      }
    }
    if (e.type === "answer.delta") metrics.mark("firstModelToken");
    emitter.emit(e as never);
  };

  metrics.mark("acknowledged");
  emit({ type: "run.started", threadId: thread.id, question, mode, startedAt, requestedAt, threadReplaced: threadReplaced || undefined });

  const texts = new Map<string, string>();
  const reads = createReadRegistry(texts);
  // Sources from earlier turns in the thread stay citable (their excerpts stand in for text); new reads replace them.
  let pool: ResearchSource[] = thread.sources.map((s) => ({ ...s, laneIds: [] }));
  for (const s of pool) if (s.read && s.excerpt) texts.set(s.id, s.excerpt);
  // Prior-turn sources are stored without their text. Re-read them through the 24h cache (in parallel with the
  // lanes) so a follow-up answer is verified against full text rather than a 600-character excerpt.
  const rehydration = deps.hasKey ? rehydratePriorSources(pool, texts, deps, signal) : Promise.resolve(0);
  const laneSummaries: LaneSummary[] = [];
  let agents = 0;
  let rounds = 0;
  let answer = "";
  let artifactVersion = 0;
  let artifactHash = "";
  let citeMap: Record<number, string> = {};
  let numbered: ResearchSource[] = [];
  let verification: VerificationSummary | null = null;
  let verificationUnavailable: string | null = null;
  let verifiedAt: number | null = null;
  let citationChecks: ResearchMessage["citations"] = [];
  let citationCheck: ResearchMessage["citationCheck"];
  let banner: AnswerBanner = null;
  let authorities: ResearchMessage["authorities"];
  let synthesisInstructionsText = "";
  let refinements: Partial<Record<LaneKind, string[]>> | undefined;
  let noKey = !deps.hasKey;
  let failure: FailureKind | undefined;
  let failureMessage: string | undefined;
  let coverage: CoverageDecision | null = null;
  let timeExceeded = false;
  const laneNotes: string[] = [];
  const board = createLaneBoard<ResearchSource[]>();
  let noAnswer = false;
  const tenantId = safeTenantId();
  const textOf = (s: ResearchSource) => texts.get(s.id) ?? s.excerpt;
  let searchQuery: string | null = null;
  let subQuestions: string[] = [];
  let plan: Promise<ResearchPlan | null> | undefined;
  // Indian law corpus coverage (cached server-side; bounded wait) for the planner and the lanes: which courts and years
  // have full text and which only metadata, so the lanes reach for the right material.
  const lawScope = settings.sources.includes("caselaw") || settings.sources.includes("statutes");
  const coverageText = lawScope && deps.coverage ? deps.coverage(signal).catch(() => "") : Promise.resolve("");
  let coverageBlock = "";

  const matterLine = matter
    ? `Active matter: ${matter.name} (${matter.caption ?? matter.shortName}); client ${matter.client} (${matter.clientSide}); ${matter.court ?? ""}; stage: ${matter.stage ?? "n/a"}. ${matter.description ?? ""}`
    : "No matter selected.";

  const modelRetry = { retries: policy.modelRetries, baseMs: policy.retryBaseMs, maxMs: policy.retryMaxMs, signal };

  /** Publish a new version of the answer text; every verdict from here on binds to its hash. */
  const publishVersion = (text: string, stage: "draft" | "revised") => {
    artifactVersion++;
    artifactHash = answerHash(text);
    emit({ type: "artifact.created", artifactId: answerArtifactId(runId, artifactVersion), artifactHash, version: artifactVersion, stage, kind: "research.answer", text, citeMap });
  };

  const verifiableSources = () => numbered.filter((s) => s.read && (texts.get(s.id) ?? s.excerpt));
  // Context budgets resolved against the configured models (real deps); fakes without `budget` keep the fixed bounds.
  const synthBudget = deps.budget?.("deep_research_synthesis") ?? null;
  const laneBudget = deps.budget?.("research_lane") ?? null;
  // Verification is never weaker than synthesis: the synthesis evidence is capped at what one verifier call can show
  // (in characters and script-aware tokens), so the verifier sees every passage the synthesis saw, whole.
  const verifierCap = synthBudget ? (() => { const vb = deps.budget?.("verify"); return vb ? verifierCapacity(vb) : null; })() : null;
  const correctionChars = synthBudget ? Math.max(5_000, Math.min(synthBudget.perSourceChars, 20_000)) : 5_000;
  let terms: string[] = focusTerms([question]);
  let evidence: ReturnType<typeof buildEvidenceBlocks> = [];
  // The verifier sees the same focused, paragraph-numbered passages the synthesis cited (not an arbitrary prefix).
  const verifyInput = (list: ResearchSource[]) => list.map((s) => {
    const block = evidence[(s.n ?? 0) - 1];
    return { title: s.title, cite: s.cite ?? formatBluebook(s.hit), url: s.url, text: block ? evidenceText(block) : textOf(s) ?? "" };
  });

  /** One verification pass over the current answer text, bound to its hash; quotes and read-state are then checked in code. */
  const runVerification = async (pass: number, verifiable: ResearchSource[], stageSignal: AbortSignal | undefined = signal): Promise<VerificationSummary> => {
    const hash = artifactHash;
    emit({ type: "verification.started", artifactHash: hash, sources: verifiable.length, pass });
    const sources = verifyInput(verifiable);
    // The verifier's reach per source is at least what the synthesis was given for any source (budgeted runs).
    const reach = synthBudget ? sources.reduce((m, x) => Math.max(m, x.text.length), 0) : undefined;
    const v = await timedModelCall(metrics, () => withRetry(() => deps.verify({ answer, sources, signal: stageSignal, ...(reach ? { perSourceChars: reach } : {}) }), { ...modelRetry, signal: stageSignal }));
    agents++;
    const raw = toSummary(v, verifiable, hash, pass);
    const checked = checkClaimEvidence(answer, raw.verdicts, numbered, textOf);
    const summary = checked.demoted || checked.misquotes || checked.verdicts.some((x) => x.paragraph != null) ? recountVerification({ ...raw, verdicts: checked.verdicts }) : raw;
    for (const x of summary.verdicts) {
      if (x.status === "supported") emit({ type: "claim.supported", artifactHash: hash, claim: x.claim, sourceN: x.sourceN, quote: x.quote });
      else if (x.status === "contradicted") emit({ type: "claim.contradicted", artifactHash: hash, claim: x.claim, sourceN: x.sourceN, quote: x.quote, note: x.note });
      else emit({ type: "claim.unsupported", artifactHash: hash, claim: x.claim, sourceN: x.sourceN, note: x.note });
    }
    emit({ type: "verification.completed", artifactHash: hash, status: summary.status, supported: summary.supported, unsupported: summary.unsupported, contradicted: summary.contradicted, score: summary.score, pass, verification: summary });
    verifiedAt = Date.now();
    return summary;
  };

  try {
    // A question in an Indian language is searched with English terms (the corpus is predominantly English) AND its own
    // words (regional-language judgments). Translation runs on the fast router role when policy allows, bounded in time.
    if (qLang.needsTranslation) {
      const toolId = `${runId}:translate`;
      const t0 = Date.now();
      const langName = languageInfo(qLang.language)?.name ?? qLang.language;
      emit({ type: "tool.started", toolId, name: "translate_query", label: `Translating the ${langName} question into search terms` });
      if (deps.hasKey && deps.translateQuery) {
        const translate = deps.translateQuery.bind(deps);
        try {
          const r = await timedModelCall(metrics, () => settleWithin(translate({ question, language: langName, matterId: settings.matterId ?? null, signal }), policy.translateWaitMs, signal));
          searchQuery = r?.query?.trim() || null;
        } catch (e) {
          if (isAbortError(e)) throw e;
          searchQuery = null;
        }
      }
      if (searchQuery) emit({ type: "tool.completed", toolId, name: "translate_query", label: `Search terms: ${searchQuery}`, durationMs: Date.now() - t0 });
      else emit({ type: "tool.failed", toolId, name: "translate_query", label: "Translating the question", error: deps.hasKey ? "Translation unavailable; searching with the question's own words only" : "No model provider is configured; searching with the question's own words only", failure: deps.hasKey ? "unknown" : "not_configured", durationMs: Date.now() - t0, retrying: false });
    }
    coverageBlock = (await settleWithin(coverageText, policy.coverageWaitMs ?? 2_500, signal)) ?? "";
    subQuestions = planSubQuestions({ question, settings, mode, hasMatter: Boolean(matter), matterName: matter?.shortName, topic: searchQuery ? questionTopic(searchQuery) : undefined });
    for (let round = 1; round <= maxRounds && !aborted(); round++) {
      if (round > 1 && (Date.now() - startedAt > policy.runTimeMs || remaining() < ms(MIN_ROUND_MS))) { timeExceeded = true; break; }
      rounds = round;
      const planned: ResearchLane[] = planLanes({ question, settings, mode, hasMatter: Boolean(matter), round, refinements, searchQuery: searchQuery ?? undefined, readBoost: laneReadBoost(laneBudget) });
      // Regional-language question: every lane also searches the question's own words (judgments in that language).
      const regional: ResearchLane[] = searchQuery && round === 1 ? planned.map((l) => ({ ...l, queries: Array.from(new Set([...l.queries, l.kind === "contrary" ? l.queries[0] : question.slice(0, 200)])).slice(0, 3) })) : planned;
      // Lanes get what is left after keeping time back for synthesis and verification (never below 25s).
      const laneCap = Math.max(ms(25_000), remaining() - ms(RESERVE_AFTER_LANES_MS));
      const lanes: ResearchLane[] = regional.map((l) => ({ ...l, timeoutMs: Math.min(l.timeoutMs ?? policy.laneTimeoutMs, laneCap) }));
      emit({ type: "plan.created", round, reason: round === 1 ? undefined : "coverage was thin; refined queries", lanes });
      // Fast-model planning runs concurrently with the first retrieval wave (lanes start on deterministic queries).
      if (round === 1 && mode === "deep" && deps.hasKey && deps.planQueries) {
        const planner = deps.planQueries.bind(deps);
        const planToolId = `${runId}:plan`;
        const planStarted = Date.now();
        emit({ type: "tool.started", toolId: planToolId, name: "plan_research", label: "Planning sub-questions and queries" });
        plan = timedModelCall(metrics, () => planner({ question, context: planContext(settings, matterLine, subQuestions, searchQuery, coverageBlock), laneKinds: lanes.map((l) => l.kind), signal }))
          .then((p) => {
            subQuestions = mergeSubQuestions(subQuestions, p.subQuestions);
            emit({ type: "tool.completed", toolId: planToolId, name: "plan_research", label: `Planned ${subQuestions.length} sub-questions`, durationMs: Date.now() - planStarted });
            return p;
          }, (e) => {
            if (!isAbortError(e)) emit({ type: "tool.failed", toolId: planToolId, name: "plan_research", label: "Planning sub-questions", error: `Planner unavailable (${providerMessage(e)}); deterministic queries used`, failure: classifyFailure(e), durationMs: Date.now() - planStarted, retrying: false });
            return null;
          });
      }

      // --- lanes: bounded concurrency, dependency-aware, per-lane timeouts ------
      const known = pool;
      const laneResults = await scheduleLanes<ResearchLane, LaneResult>(
        lanes,
        (lane, slot) => runLane(lane, { question, settings, matter, deps, emit, signal: slot.signal, runSignal: signal, timedOut: slot.timedOut, texts, reads, known, policy, metrics, priors: slot.priors, board, plan: round === 1 ? plan : undefined, coverage: coverageBlock || undefined, issues: subQuestions, ...(input.rerank !== undefined ? { rerank: input.rerank } : {}) }, { queuedMs: slot.queuedMs }),
        {
          concurrency: policy.laneConcurrency,
          signal,
          defaultTimeoutMs: Math.min(policy.laneTimeoutMs, laneCap),
          onQueueWait: (ms) => metrics.addQueueWait(ms),
          skipped: (lane) => {
            emit({ type: "lane.completed", laneId: lane.id, status: "skipped", durationMs: 0, sources: 0, read: 0, failure: "cancelled" });
            return { laneId: lane.id, status: "skipped", sources: [], read: 0, note: "", agentRan: false, durationMs: 0, failure: "cancelled", failures: [] };
          },
        },
      );
      const results: LaneResult[] = lanes.map((l) => laneResults.get(l.id)!).filter(Boolean);
      for (const r of results) {
        pool = mergeSources(pool, r.sources);
        if (r.agentRan) agents++;
        const lane = lanes.find((l) => l.id === r.laneId)!;
        if (r.note) laneNotes.push(`### ${lane.name}\n${r.note}`);
        laneSummaries.push({ id: lane.id, name: lane.name, kind: lane.kind, status: r.status, sources: r.sources.length, read: r.read, durationMs: r.durationMs, round, error: r.error, failure: r.failure });
      }
      if (aborted()) break;

      // --- treatment signals (started when cases were read; bounded wait) and currentness flags ----
      if (treatments.size) {
        const settled = await settleWithin(Promise.all(Array.from(treatments.entries()).map(async ([id, p]) => [id, await p] as const)), policy.treatmentWaitMs, signal);
        const byId = new Map((settled ?? []).filter(([, t]) => t).map(([id, t]) => [id, t!] as const));
        pool = pool.map((s) => {
          const t = byId.get(s.id);
          if (!t || s.treatment) return s;
          const next = { ...s, treatment: t };
          emit({ type: "source.found", laneId: s.laneIds[0] ?? "treatment", sourceId: s.id, title: s.title, cite: s.cite, kind: s.kind, source: next });
          return next;
        });
      }
      pool = pool.map((s) => ({ ...s, currentness: s.currentness ?? currentnessOf(s), evidenceId: s.evidenceId ?? evidenceSourceId(s, { matterId: settings.matterId, tenantId }) }));

      const n = numberSources(pool);
      numbered = n.sources;
      citeMap = n.citeMap;

      // --- synthesis (primary model, lane sources only) ----------------------
      if (noKey) break;
      if (!numbered.length) {
        // Nothing retrieved: broaden and retry while rounds remain; then say so explicitly instead of writing from memory (§44).
        if (round < maxRounds && !timeExceeded) {
          coverage = decideCoverage({ round, maxRounds, sources: pool, answer: "", verification: null, lanes, emptyLaneIds: results.map((r) => r.laneId) });
          emit({ type: "coverage.gap", round, reason: coverage.reason, gaps: coverage.gaps, refinements: coverage.refinements as Record<string, string[]> });
          emit({ type: "round.completed", round, complete: false, reason: coverage.reason });
          refinements = coverage.refinements;
          continue;
        }
        answer = noAnswerMemo(question, settings, matter, subQuestions, searchQuery);
        noAnswer = true;
        emit({ type: "answer.delta", delta: answer });
        publishVersion(answer, "draft");
        verificationUnavailable = "No sources were retrieved, so no claim could be checked";
        emit({ type: "verification.unavailable", artifactHash, reason: verificationUnavailable, failure: "no_result" });
        coverage = { complete: true, exhausted: false, reason: "no sources were retrieved; the answer states that the sources reviewed do not establish the point", refinements: {}, gaps: [] };
        emit({ type: "round.completed", round, complete: true, reason: coverage.reason });
        break;
      }
      await rehydration;
      emit({ type: "synthesis.started", round, sources: numbered.length, read: numbered.filter((s) => s.read).length });
      const j = jurisdictionByKey(settings.jurisdiction);
      const courts = resolveCourts(settings.jurisdiction, settings.courts);
      const range = datePresetRange(settings.datePreset, { from: settings.dateFrom, to: settings.dateTo });
      const offenceLine = offenceDate || /\b(IPC|BNS|CrPC|BNSS|offen[cs]e|FIR|bail|accused)\b/i.test(searchQuery ?? question)
        ? `Date of offence: ${offenceDate ? (offenceIsExact ? offenceDate : `${offenceRelation === "before" ? "before" : "on or after"} ${offenceDate}`) : "not stated"}. Substantive code under the transition rule: ${offenceRule.substantive}${offenceRule.notes.length ? ` (${offenceRule.notes.join(" ")})` : ""}.`
        : "";
      // The deterministic transition note (coded savings provisions), stated to the model and kept on the message.
      const transitionBlock = transition.applies ? `Transition law (deterministic, from the coded savings provisions; state it in the answer and do not contradict it):\n${transition.lines.map((l) => `- ${l}`).join("\n")}` : "";
      // Byte-stable per mode: the cacheable prefix. Date, matter, jurisdiction and the question travel in the user turn.
      synthesisInstructionsText = synthesisInstructions(mode, firmLabel(), LEGAL_STYLE_RULES);
      terms = focusTerms([question, ...lanes.flatMap((l) => l.queries), ...subQuestions]);
      // With a budget (real deps), the top read sources go in full up to the synthesis budget (12 × up to ~40k characters
      // on a large-context model, focused ≤2k-character blocks) — capped at what the verifier can show, shared evenly over
      // the sources given in full; the rest carry their snippets. Fakes keep the old bounds.
      evidence = buildEvidenceBlocks(numbered, textOf, { terms, matterId: settings.matterId, tenantId, ...(synthBudget ? synthesisEvidenceLimits(synthBudget, verifierCap, numbered.filter((s) => s.read).length) : {}) });
      const priorAnswerChars = synthBudget ? Math.max(2_500, Math.floor(synthBudget.historyChars / 2)) : 2_500;
      const prior = thread.messages.slice(-4).filter((m) => m.content).map((m) => `${m.role === "user" ? "Earlier question" : "Earlier answer"}: ${m.content.slice(0, m.role === "user" ? 600 : priorAnswerChars)}`).join("\n\n");
      const context = [
        todayLine(),
        matterLine,
        `Forum: ${j.label}. Binding: ${bindingCourtIds(j.key).join(", ")} (computed from the court registry)${courts ? `; retrieval limited to ${courts}` : ""}.${range.from ? ` Date range from ${range.from}.` : ""}${range.to ? ` Through ${range.to}.` : ""}`,
        offenceLine,
        transitionBlock,
        searchQuery ? `The question was asked in ${languageInfo(qLang.language)?.name ?? qLang.language}; English search terms used: ${searchQuery}.` : "",
        answerLanguageLine(answerLanguage),
        subQuestions.length ? `Sub-questions to cover:\n${subQuestions.map((q) => `- ${q}`).join("\n")}` : "",
      ].filter(Boolean).join("\n");
      // Documents first (the evidence blocks are prepended by the runtime), then notes and context, question last.
      const synthInput: ResponseInput = [{
        role: "user",
        content: [{ type: "input_text", text: [prior ? `Conversation so far:\n${prior}` : "", laneNotes.length ? `${LANE_NOTE_HEADER}\n${laneNotes.join("\n\n")}` : "", context, `Before writing, identify the exact passages in the numbered sources that answer each sub-question; quote them verbatim in the Analysis with [n ¶k] pinpoints. Where the sources are silent, write "${NO_ANSWER_SENTENCE}"`, `Research question: ${question}`].filter(Boolean).join("\n\n") }],
      } as ResponseInputItem];
      let draft = "";
      let streamed = "";
      let tail = "";
      const sourceCount = numbered.length;
      // Synthesis keeps ~45s back for verification; past its deadline the streamed text is kept as a partial answer.
      const synthStage = stage(Math.max(ms(30_000), remaining() - ms(45_000)));
      try {
        const res = await timedModelCall(metrics, () => deps.synthesize({
          instructions: synthesisInstructionsText,
          input: synthInput,
          evidence,
          signal: synthStage.signal,
          onDelta: (d) => {
            streamed += d;
            emit({ type: "answer.delta", delta: d });
            if (!metrics.has("firstSourceBacked")) {
              tail = (tail + d).slice(-20);
              if (hasCiteMarker(tail, sourceCount)) metrics.mark("firstSourceBacked");
            }
          },
        }), (r) => (typeof r === "string" ? undefined : r.usage));
        draft = typeof res === "string" ? res : res.text;
        agents++;
      } catch (e) {
        if (synthStage.timedOut()) {
          timeExceeded = true;
          if (!streamed.trim()) { failure = "timeout"; failureMessage = "Synthesis did not finish within the run's time budget"; break; }
          draft = `${streamed.trimEnd()}\n\n_The answer was cut short by the run's time limit; the part above is what was written from the sources._`;
          agents++;
        } else if (isAbortError(e)) break;
        else {
          if (e instanceof AIConfigError) { noKey = true; break; }
          failure = classifyFailure(e);
          failureMessage = `Synthesis failed: ${providerMessage(e)}`;
          break;
        }
      }
      answer = draft.trim();
      publishVersion(answer, "draft");
      if (aborted()) break;

      // --- verification loop (hash-bound) ----------------------------------------
      verificationUnavailable = null;
      const verifiable = verifiableSources();
      if (verifiable.length && answer && remaining() < ms(25_000)) {
        timeExceeded = true;
        verificationUnavailable = "Verification was skipped because the run's time budget was spent; the claims are not checked";
        emit({ type: "verification.unavailable", artifactHash, reason: verificationUnavailable, failure: "timeout" });
      } else if (verifiable.length && answer) {
        const verifyStage = stage(Math.max(ms(20_000), remaining() - ms(15_000)));
        try {
          const first = await runVerification(1, verifiable, verifyStage.signal);
          verification = first;
          if (!aborted() && first.unsupported + first.contradicted > 0 && remaining() < ms(60_000)) {
            emit({ type: "correction.completed", artifactHash, changed: false, note: "Not enough time was left for a correction pass; unsupported claims are flagged in the verdicts." });
          } else if (!aborted() && first.unsupported + first.contradicted > 0) {
            const draftHash = artifactHash;
            emit({ type: "correction.started", artifactHash: draftHash, unsupported: first.unsupported, contradicted: first.contradicted });
            try {
              const correctionInput = `ANSWER:\n${answer}\n\nSOURCES (read):\n${verifiable.map((s) => { const b = evidence[(s.n ?? 0) - 1]; return b ? `[${s.n}] ${b.title}\n${evidenceText(b).slice(0, correctionChars)}` : renderSourcesForPrompt([s], texts, { maxCharsPerSource: Math.max(4_000, correctionChars - 1_000) }); }).join("\n\n")}\n\nVERDICTS:\n${first.verdicts.map((x) => `- [${x.status}] ${x.claim}${x.sourceN ? ` (source [${x.sourceN}])` : ""}${x.quote ? ` — "${x.quote}"` : ""}${x.note ? ` — ${x.note}` : ""}`).join("\n")}`;
              const correctStage = stage(Math.max(ms(20_000), remaining() - ms(40_000)));
              const revisedRaw = await timedModelCall(metrics, () => withRetry(() => deps.correct({ instructions: CORRECTION_INSTRUCTIONS, input: correctionInput, signal: correctStage.signal }), { ...modelRetry, signal: correctStage.signal }));
              agents++;
              const revised = revisedRaw.trim();
              const changed = revised.length > 0 && revised !== answer;
              if (changed) {
                answer = revised;
                publishVersion(answer, "revised");
                emit({ type: "correction.completed", artifactHash: draftHash, changed: true, note: `${first.unsupported + first.contradicted} claim(s) revised or flagged after verification`, newArtifactHash: artifactHash });
                // The answer changed, so the verdicts for the draft hash no longer count: re-verify the revised text.
                if (!aborted()) {
                  try {
                    const reverify = stage(Math.max(ms(15_000), remaining() - ms(10_000)));
                    verification = await runVerification(2, verifiable, reverify.signal);
                  } catch (e) {
                    if (isAbortError(e) && aborted()) break;
                    verificationUnavailable = `The revised answer could not be re-verified (${providerMessage(e)}); the verdicts shown are for the earlier draft`;
                    emit({ type: "verification.unavailable", artifactHash, reason: verificationUnavailable, failure: classifyFailure(e) });
                  }
                }
              } else {
                emit({ type: "correction.completed", artifactHash: draftHash, changed: false, note: "Verification flagged claims but the correction pass made no changes; unsupported claims remain marked in the verdicts." });
              }
            } catch (e) {
              if (isAbortError(e) && aborted()) break;
              emit({ type: "correction.completed", artifactHash: draftHash, changed: false, note: `Correction pass unavailable (${isAbortError(e) ? "time budget spent" : providerMessage(e)}); unsupported claims are flagged in the verdicts.` });
            }
          }
        } catch (e) {
          if (isAbortError(e) && aborted()) break;
          if (verifyStage.timedOut()) timeExceeded = true;
          verificationUnavailable = `Verification unavailable: ${verifyStage.timedOut() ? "the run's time budget was spent" : providerMessage(e)}`;
          emit({ type: "verification.unavailable", artifactHash, reason: verificationUnavailable, failure: classifyFailure(e) });
        }
      } else if (answer) {
        verificationUnavailable = numbered.length ? "No source was read in full, so no claim could be checked against its text" : "No sources were retrieved, so no claim could be checked";
        emit({ type: "verification.unavailable", artifactHash, reason: verificationUnavailable, failure: "no_result" });
      }
      if (aborted()) break;

      // --- coverage decision -------------------------------------------------
      const emptyLaneIds = results.filter((r) => r.sources.length === 0).map((r) => r.laneId);
      coverage = decideCoverage({ round, maxRounds, sources: pool, answer, verification, lanes, emptyLaneIds });
      if (!coverage.complete || coverage.exhausted) emit({ type: "coverage.gap", round, reason: coverage.reason, gaps: coverage.gaps, refinements: coverage.refinements as Record<string, string[]> });
      emit({ type: "round.completed", round, complete: coverage.complete, reason: coverage.reason });
      if (coverage.complete) break;
      refinements = coverage.refinements;
      if (remaining() < ms(MIN_ROUND_MS)) { timeExceeded = true; break; }
      if (coverage.gaps.length) {
        try {
          const refineStage = stage(ms(15_000));
          const modelRefinements = await timedModelCall(metrics, () => deps.refine({ question, gaps: coverage!.gaps, laneKinds: lanes.map((l) => l.kind), signal: refineStage.signal }));
          for (const [k, qs] of Object.entries(modelRefinements) as [LaneKind, string[]][]) if (qs?.length) refinements[k] = Array.from(new Set([...(refinements[k] ?? []), ...qs])).slice(0, 3);
        } catch (e) {
          if (isAbortError(e) && aborted()) break;
          /* deterministic refinements are enough (also when the refine call ran out of time) */
        }
      }
    }
  } catch (e) {
    if (!isAbortError(e)) { failure = classifyFailure(e); failureMessage = providerMessage(e); }
  }

  // --- citation integrity (structured; the answer text itself is not rewritten) ----
  if (answer && !aborted()) {
    const cross = crossCheckCitations(answer, numbered);
    let remote = new Set<string>();
    if (cross.unmatched.length) {
      if (remaining() > ms(12_000)) {
        const citeStage = stage(Math.min(ms(12_000), remaining() - ms(8_000)));
        try { remote = new Set((await deps.verifyCitationsRemote(cross.unmatched.map((c) => c.citation).join("; "), citeStage.signal)).map(normCite)); } catch { /* offline or out of time: everything stays unresolved/requires review */ }
      }
    }
    citationChecks = withCitationStates(cross.checks, remote);
    citationCheck = buildCitationCheck(artifactHash, citationChecks);
    emit({ type: "citation.checked", artifactHash, resolved: citationCheck.resolved, unresolved: citationCheck.unresolved, requiresReview: citationCheck.requiresReview, checks: citationChecks, citationCheck });
    // Authority status: every authority in the answer resolved to a corpus record (or shown unresolved), and "supported"
    // only where a claim attributed to it was checked against its read text for this answer hash.
    let citedBy: Map<string, number> | undefined;
    if (deps.citedBy && remaining() > ms(8_000)) {
      const citedNs = citedNumbers(answer);
      const targets = numbered.filter((s) => s.kind === "caselaw" && s.n != null && citedNs.has(s.n) && s.hit.readRef).slice(0, 8);
      if (targets.length) {
        const cbStage = stage(Math.min(ms(6_000), remaining() - ms(5_000)));
        try { citedBy = await deps.citedBy(targets.map((s) => ({ id: s.id, citations: [s.hit.india?.neutralCitation, ...(s.hit.india?.reporterCitations ?? []), s.cite].filter((x): x is string => Boolean(x)) })), cbStage.signal); } catch { citedBy = undefined; }
      }
    }
    authorities = buildAuthorityStatus({ answer, artifactHash, sources: numbered, verification, checks: citationChecks, remotelyKnown: remote, citedBy });
  }

  // --- banner -----------------------------------------------------------------
  const cited = citedNumbers(answer);
  if (noKey) banner = "no-api-key";
  else if (answer && (cited.size === 0 || numbered.length === 0)) banner = "not-source-backed";

  if (answer && !aborted()) {
    emit({ type: "artifact.created", artifactId: answerArtifactId(runId, artifactVersion), artifactHash, version: artifactVersion, stage: "final", kind: "research.answer", text: answer, citeMap });
    metrics.mark("finalAnswer");
  }
  const verificationCurrent = Boolean(verification && verification.artifactHash === artifactHash);
  if (verificationCurrent && verifiedAt != null) metrics.markAt("verifiedAnswer", verifiedAt);

  // --- follow-ups ---------------------------------------------------------------
  let followUps: string[] = [];
  if (!aborted()) {
    if (!noKey && answer) {
      if (remaining() > ms(10_000)) {
        const followStage = stage(Math.min(ms(10_000), remaining() - ms(5_000)));
        try { followUps = await timedModelCall(metrics, () => deps.followUps({ question, answer, matterLine, signal: followStage.signal })); } catch { followUps = []; }
      }
    }
    if (!followUps.length) followUps = fallbackFollowUps(question, settings, matter);
  }

  // --- outcome -------------------------------------------------------------------
  const wasAborted = aborted();
  const outcome = decideOutcome({ aborted: wasAborted, answer, noKey, failure, failureMessage, coverage, timeExceeded, verification, verificationCurrent, verificationUnavailable, sourcesFound: pool.length, lanes: laneSummaries });

  // --- provenance, persistence, audit --------------------------------------------
  const finalNumbered = numbered.map((s) => (cited.has(s.n ?? -1) ? s : { ...s, n: undefined }));
  // Provenance describes an answer. A retrieval-only turn (no key, synthesis failed) has nothing to attest or review,
  // so it carries no provenance and never lands in the review queue.
  const provenance = answer && !noKey ? assembleProvenance({ sources: finalNumbered, verification: verificationCurrent ? verification : null, instructions: synthesisInstructionsText || undefined, question, model: deps.model, citationMismatches: citationChecks?.filter((c) => !c.matched).length ?? 0 }) : undefined;
  if (provenance && !wasAborted) {
    try { attachProvenance({ kind: "research", recordId: runId, matterId: settings.matterId ?? undefined, title: question.slice(0, 140), href: `/search?thread=${thread.id}`, provenance }); } catch (e) { console.warn("[research] provenance sidecar failed", (e as Error).message); }
    if (provenance.review?.status === "pending") emit({ type: "review.required", artifactHash, reason: provenance.review.note ?? "Below the confidence gate" });
  }
  const stats: RunStats = { sources: pool.length, read: pool.filter((s) => s.read).length, rounds, agents, durationMs: Date.now() - startedAt };
  const finalMetrics = metrics.snapshot();
  const coverageSummary: CoverageSummary | undefined = coverage ? { complete: coverage.complete && !coverage.exhausted, reason: coverage.reason, gaps: coverage.gaps } : undefined;
  const message: ResearchMessage = {
    id: `msg_${nanoid(8)}`,
    role: "assistant",
    content: answer,
    createdAt: new Date().toISOString(),
    runId,
    stats,
    verification: verification ? { ...verification, verdicts: verification.verdicts.slice(0, 40) } : undefined,
    citations: citationChecks?.length ? citationChecks : undefined,
    citationCheck,
    provenance,
    banner,
    followUps,
    citeMap: Object.fromEntries(Object.entries(citeMap).filter(([n]) => cited.has(Number(n)))),
    lanes: laneSummaries,
    artifactHash: answer ? artifactHash : undefined,
    artifactVersion: answer ? artifactVersion : undefined,
    terminal: outcome.terminal,
    stop: outcome.stop,
    failure: outcome.failure,
    failureMessage: outcome.terminal === "failed" || outcome.terminal === "cancelled" ? outcome.reason : failureMessage,
    metrics: finalMetrics,
    coverage: coverageSummary,
    mode,
    subQuestions: subQuestions.length ? subQuestions : undefined,
    noAnswer: noAnswer || undefined,
    forum: settings.jurisdiction,
    queryLanguage: qLang.language,
    answerLanguage,
    searchQuery: qLang.needsTranslation ? searchQuery : undefined,
    offence: offenceDate || offenceRule.substantive !== "requires_review" ? { date: offenceIsExact ? offenceDate ?? null : null, substantive: offenceRule.substantive } : undefined,
    transition: transition.applies ? { substantive: transition.substantive, procedure: transition.procedure, lines: transition.lines, source: transition.source } : undefined,
    authorities: authorities?.rows.length ? authorities : undefined,
  };
  message.trust = answer ? messageTrustState(message, finalNumbered) : "generated";
  const compact = pool.map(compactSource);
  // A cancelled run keeps its partial answer; one that was stopped before any answer leaves no trace (and no empty thread).
  const persist = !wasAborted || Boolean(answer);
  if (persist) {
    appendToThread(thread.id, { question, answer: message, sources: compact, runId, settings });
    recordResearchRun({ id: runId, threadId: thread.id, question, settings, startedAt, sources: compact, message, mode, savedSearchId: input.savedSearchId, noKey });
    audit("ai.generate", { kind: "research", id: runId, label: question.slice(0, 120), matterId: settings.matterId ?? undefined }, {
      threadId: thread.id, mode, terminal: outcome.terminal, stop: outcome.stop ?? null, failure: outcome.failure ?? null, sources: stats.sources, read: stats.read, rounds: stats.rounds, agents: stats.agents, durationMs: stats.durationMs,
      verification: verification ? { status: verification.status, supported: verification.supported, unsupported: verification.unsupported, contradicted: verification.contradicted, score: verification.score, artifactHash: verification.artifactHash, current: verificationCurrent, partial: verification.partial ?? false } : null,
      citationsUnmatched: citationChecks?.filter((c) => !c.matched).length ?? 0, banner, model: noKey ? null : deps.model, artifactHash: message.artifactHash ?? null, trust: message.trust,
      metrics: { acknowledgedMs: finalMetrics.acknowledgedMs, firstEvidenceMs: finalMetrics.firstEvidenceMs, firstModelTokenMs: finalMetrics.firstModelTokenMs, firstSourceBackedMs: finalMetrics.firstSourceBackedMs, finalAnswerMs: finalMetrics.finalAnswerMs, verifiedAnswerMs: finalMetrics.verifiedAnswerMs, totalMs: finalMetrics.totalMs, toolTimeMs: finalMetrics.toolTimeMs, modelTimeMs: finalMetrics.modelTimeMs, tokens: finalMetrics.tokens.total },
    });
    try { sweepCache(); } catch { /* best effort */ }
  } else if (createdThread) {
    deleteThreadIfEmpty(thread.id);
  }

  const outcomePayload = { threadId: thread.id, message, sources: compact, metrics: finalMetrics };
  if (outcome.terminal === "cancelled") emit({ type: "run.cancelled", ...outcomePayload, terminal: "cancelled", stop: "cancelled", partial: Boolean(answer) });
  else if (outcome.terminal === "failed") emit({ type: "run.failed", ...outcomePayload, terminal: "failed", failure: outcome.failure ?? "unknown", error: outcome.reason, stop: outcome.stop });
  else if (outcome.terminal === "succeeded") emit({ type: "run.completed", ...outcomePayload, terminal: "succeeded", stop: "coverage_sufficient" });
  else emit({ type: "run.partial", ...outcomePayload, terminal: outcome.terminal, stop: outcome.stop ?? "hard_limit", reason: outcome.reason });

  return { runId, threadId: thread.id, message, sources: compact, stats, aborted: wasAborted, terminal: outcome.terminal, stop: outcome.stop, failure: outcome.failure, metrics: finalMetrics };
}

/** Tenant for evidence ids (library://, intel://); tolerant of environments without a configured tenant. */
function safeTenantId(): string {
  try { return configuredTenantId(); } catch { return "firm"; }
}

/** Volatile planning context (user turn; the planner instructions stay byte-stable). */
export function planContext(settings: SearchSettings, matterLine: string, subQuestions: string[], searchQuery: string | null, coverage = ""): string {
  const j = jurisdictionByKey(settings.jurisdiction);
  return [todayLine(), matterLine, `Forum: ${j.label}. Binding: ${bindingCourtIds(j.key).join(", ")}. Sources in scope: ${settings.sources.join(", ")}.`, searchQuery ? `English search terms for the question: ${searchQuery}` : "", coverage, `Draft sub-questions:\n${subQuestions.map((q) => `- ${q}`).join("\n")}`].filter(Boolean).join("\n");
}

/** Model sub-questions replace the deterministic ones but the adverse-authority question is always kept. */
export function mergeSubQuestions(base: string[], model: string[]): string[] {
  const clean = model.map((q) => q.trim()).filter((q) => q.length > 8);
  if (!clean.length) return base;
  const adverse = base.find((q) => q.includes(ADVERSE_SUBQUESTION_MARK));
  const hasAdverse = clean.some((q) => /contrar|advers|reject|distinguish|limit|split|declin|overrul|doubt|incuriam|larger bench/i.test(q));
  return Array.from(new Set([...clean, ...(adverse && !hasAdverse ? [adverse] : [])])).slice(0, 6);
}

/** Deterministic memo when nothing was retrieved (§44 "no answer in record"): no model call, no invented authority. */
export function noAnswerMemo(question: string, settings: SearchSettings, matter: Matter | null, subQuestions: string[], searchQuery?: string | null): string {
  const labels: Partial<Record<SearchSource, string>> = { caselaw: "the Supreme Court and High Court judgment corpus", statutes: "India Code", web: "the web", library: "the firm library", ediscovery: matter ? `the ${matter.shortName} record` : "matter documents" };
  const searched = settings.sources.map((s) => labels[s]).filter(Boolean).join(", ");
  return [
    "## Question Presented",
    question.trim(),
    "",
    "## Short Answer",
    `${NO_ANSWER_SENTENCE} No source was retrieved from ${searched || "the selected sources"} for ${forumPhrase(settings)}${searchQuery ? ` (searched with the English terms "${searchQuery}" and the question's own words)` : ""}, so nothing in this answer is source-backed and no authority is cited.`,
    "",
    "## Open Issues",
    ...subQuestions.map((q) => `- Not established: ${q}`),
    `- Broaden the query (fewer terms, the section and Act by name), widen the date range or the courts, or add sources such as judgments or India Code${matter ? "" : ", or select a matter to search its record"}. The corpus holds only the judgments ingested so far; an authority missing here may still exist.`,
  ].join("\n");
}

function toSummary(v: VerificationResult, sources: ResearchSource[], artifactHash: string, pass: number): VerificationSummary {
  return {
    status: v.status,
    supported: v.supported,
    unsupported: v.unsupported,
    contradicted: v.contradicted,
    score: v.score,
    checkedAt: v.checkedAt,
    artifactHash,
    pass,
    verdicts: v.verdicts.map((x) => ({ claim: x.claim, status: x.status, sourceN: x.sourceIndex != null ? sources[x.sourceIndex]?.n ?? null : null, quote: x.quote, note: x.note })),
    // What the verifier saw travels with the verdicts to the message (and the UI): a partial check is never "verified".
    ...(v.coverage ? { coverage: v.coverage } : {}),
    ...(v.partial ? { partial: true } : {}),
  };
}

/** Share of the verifier's capacity the synthesis evidence may fill (room for block markers and a source's first block). */
const EVIDENCE_MARGIN = 0.9;

/**
 * Evidence limits for the synthesis: its own budget, capped at the verifier's capacity (characters and tokens) so the
 * verifier can be shown every passage whole; the per-source size is an even share of that total over the sources
 * given in full (never above the synthesis per-source budget). Pure.
 */
export function synthesisEvidenceLimits(synth: Pick<ResolvedBudget, "perSourceChars" | "totalEvidenceChars" | "blockChars" | "maxFullSources" | "inputTokens">, verifier: { totalChars: number; totalTokens: number } | null, readSources: number): { maxCharsPerSource: number; maxTotalChars: number; maxBlockChars: number; maxFullSources: number; maxTotalTokens: number } {
  // Margins: the character bound counts paragraph text (the "¶k " markers and line breaks come on top) and the token
  // bound lets a source keep its first block; the verifier must still be able to show every block whole.
  const maxTotalChars = verifier ? Math.min(synth.totalEvidenceChars, Math.floor(verifier.totalChars * EVIDENCE_MARGIN)) : synth.totalEvidenceChars;
  const maxTotalTokens = verifier ? Math.min(Math.floor(synth.inputTokens * 0.8), Math.floor(verifier.totalTokens * EVIDENCE_MARGIN)) : Math.floor(synth.inputTokens * 0.8);
  const full = Math.max(1, Math.min(synth.maxFullSources, readSources || synth.maxFullSources));
  const maxCharsPerSource = verifier ? Math.min(synth.perSourceChars, Math.max(Math.min(6_000, maxTotalChars), Math.floor(maxTotalChars / full))) : synth.perSourceChars;
  return { maxCharsPerSource, maxTotalChars, maxBlockChars: synth.blockChars, maxFullSources: synth.maxFullSources, maxTotalTokens };
}

/** Deterministic follow-ups when the model is unavailable: bound to the forum and matter. */
export function fallbackFollowUps(question: string, settings: SearchSettings, matter: Matter | null): string[] {
  const where = forumPhrase(settings);
  const topic = questionTopic(question);
  const out = [
    `Is there a larger-bench or later Supreme Court judgment that doubts or overrules the leading authority on ${topic} before ${where}?`,
    matter ? `How does the record in ${matter.shortName} (pleadings, exhibits and depositions) bear on ${topic}?` : `Which provisions of India Code govern ${topic}, and did the BNS/BNSS/BSA transition change them?`,
    `How have other High Courts decided ${topic}, and is there a conflict the Supreme Court has not yet resolved?`,
  ];
  return out.map((s) => (s.length > 220 ? s.slice(0, 219) + "…" : s));
}

/** Re-read prior-turn sources (cached reads are instant; misses keep the stored excerpt). Returns how many were rehydrated. */
async function rehydratePriorSources(pool: ResearchSource[], texts: Map<string, string>, deps: EngineDeps, signal: AbortSignal | undefined, limit = 8): Promise<number> {
  const stale = pool.filter((s) => s.read && s.hit.readRef && (texts.get(s.id)?.length ?? 0) <= 600).slice(0, limit);
  let n = 0;
  await Promise.all(stale.map(async (s) => {
    try {
      const r = await deps.read(s.hit.readRef!, { title: s.title, signal });
      if (r.text && r.text.length > (texts.get(s.id)?.length ?? 0)) { texts.set(s.id, r.text); n++; }
    } catch { /* keep the excerpt */ }
  }));
  return n;
}

/** Persist the run in `search_runs` (history), keeping the legacy fields the seeds and history UI rely on. */
export function recordResearchRun(input: { id: string; threadId: string; question: string; settings: SearchSettings; startedAt: number; sources: ResearchSource[]; message: ResearchMessage; mode: ResearchMode; savedSearchId?: string; noKey: boolean }): SearchRun {
  const counts: Partial<Record<SearchSource, number>> = {};
  const topHits: SearchHit[] = [];
  for (const s of ALL_SOURCES) {
    const list = input.sources.filter((x) => x.kind === s);
    if (list.length) { counts[s] = list.length; topHits.push(...list.slice(0, 3).map((x) => x.hit)); }
  }
  const m = input.message;
  const run: SearchRun = {
    id: input.id,
    threadId: input.threadId,
    query: input.question,
    settings: input.settings,
    createdAt: new Date(input.startedAt).toISOString(),
    durationMs: Date.now() - input.startedAt,
    counts,
    synthesis: m.content ? m.content.slice(0, 16_000) : undefined,
    topHits: topHits.slice(0, 12),
    ownerId: researchPrincipalId(),
    matterId: input.settings.matterId ?? null,
    savedSearchId: input.savedSearchId,
    aiStatus: input.noKey ? "no_api_key" : m.content ? "ok" : "error",
    mode: input.mode,
    stats: m.stats,
    verification: m.verification ? { status: m.verification.status, supported: m.verification.supported, unsupported: m.verification.unsupported, contradicted: m.verification.contradicted, score: m.verification.score, checkedAt: m.verification.checkedAt } : undefined,
    provenance: m.provenance,
    banner: m.banner ?? undefined,
    followUps: m.followUps,
    sources: input.sources.slice(0, 40),
    terminal: m.terminal,
    stop: m.stop,
    failure: m.failure,
    metrics: m.metrics,
    artifactHash: m.artifactHash,
    trust: m.trust,
  };
  searchRuns().put(run);
  if (input.savedSearchId) updateSavedSearch(input.savedSearchId, { lastRunAt: run.createdAt, runCount: (savedSearches().get(input.savedSearchId)?.runCount ?? 0) + 1 });
  const all = searchRuns().list({ sortBy: "createdAt", direction: "desc" });
  for (const old of all.slice(250)) searchRuns().delete(old.id);
  return run;
}

/** Human-readable stop reason for logs and the UI. */
export function describeStop(stop: ResearchStopState | undefined): string {
  return stop ? STOP_LABEL[stop] : "";
}
