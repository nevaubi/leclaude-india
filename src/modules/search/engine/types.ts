/**
 * Research engine contracts. Client-safe: shared by the server orchestrator,
 * the SSE route, the React hook/components, the seed and the tests.
 */
import type { FailureKind, ResearchStopState, RunEvent, RunEventBase, RunMetrics, RunTerminalState } from "@/lib/ai/events";
import type { CitationCheck as EvidenceCitationCheck, CitationState, TrustState } from "@/lib/evidence/types";
import type { Provenance } from "@/lib/integrity/types";
import type { VerificationCoverage } from "@/lib/ai/verify";
import type { Authority, SearchHit, SearchSettings, SearchSource } from "../types";
import type { AuthorityStatusTable } from "./authority-status";

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/**
 * LeClaude India lanes: "controlling" = binding authority (Supreme Court + the forum High Court, larger benches first),
 * "persuasive" = other High Courts and the erstwhile common High Court at Hyderabad, "contrary" = adverse authority,
 * "statute" = India Code (with the IPC/BNS, CrPC/BNSS, IEA/BSA transition). "regulatory" is kept for US compatibility.
 */
export type LaneKind = "controlling" | "persuasive" | "contrary" | "statute" | "regulatory" | "record" | "secondary" | "fast";

/**
 * Where a lane retrieves from: the structured providers, or the firm's
 * intelligence corpus ("intel"), whose hits are normalized onto the lane's
 * provider kinds (opinion → caselaw, CFR → regulations, docket entries →
 * dockets…) so sources, citations and reading stay uniform.
 */
export type RetrievalSource = SearchSource | "intel";

export interface ResearchLane {
  /** Also feed the lane from the intelligence corpus (default true for provider lanes). */
  intel?: boolean;
  /** One-line note shown under the lane card ("Also searches the intelligence corpus"). */
  note?: string;
  id: string;
  kind: LaneKind;
  name: string;
  /** One-line purpose shown on the lane card. */
  brief: string;
  /** Structured providers this lane queries before (and while) the agent reads. */
  sources: SearchSource[];
  /** Toolkit tool names the lane agent may call. */
  tools: string[];
  /** Queries run against the structured providers (round-specific). */
  queries: string[];
  /** Agent loop bound. */
  maxSteps: number;
  /** Cap on full-text reads per lane. */
  maxReads: number;
  round: number;
  /** Registry court ids this lane's judgment retrieval is limited to (deterministic, from the forum); absent = all courts. */
  courtFilter?: string[];
  /** Lanes whose results this lane waits for and builds on (dependency-aware scheduling). */
  dependsOn?: string[];
  /** Wall-clock budget for the lane; the scheduler aborts it past this. */
  timeoutMs?: number;
  /** false: read deterministically (best hits, no lane agent), as fast lanes do. Default: deep lanes run an agent. */
  agent?: boolean;
  /**
   * Soft dependencies: the lane starts immediately and, after its own first retrieval wave, waits (bounded)
   * for these lanes' retrieval results to build targeted queries (e.g. the contrary lane targets the cases the
   * controlling lane found). Unlike `dependsOn`, it never delays the lane's first evidence.
   */
  after?: string[];
}

export type LaneStatus = "queued" | "retrieving" | "reading" | "done" | "error" | "stopped" | "skipped" | "timeout";

/** Compact per-lane outcome kept on the persisted message. */
export interface LaneSummary {
  id: string;
  name: string;
  kind: LaneKind;
  status: LaneStatus;
  sources: number;
  read?: number;
  durationMs: number;
  round: number;
  /** Set when the lane ended in error/timeout, or completed with a partial failure inside it. */
  error?: string;
  failure?: FailureKind;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** One authority/page/document the engine found or read, deduped across lanes and rounds. */
export interface ResearchSource {
  /** Stable key (hit id, or url for web pages). */
  id: string;
  /** Citation number in the answer, assigned at synthesis. */
  n?: number;
  kind: SearchSource;
  title: string;
  cite?: string;
  url?: string;
  court?: string;
  date?: string;
  authority?: Authority;
  snippet?: string;
  /** True when the full text was retrieved and handed to the synthesis/verification steps. */
  read: boolean;
  chars?: number;
  readMs?: number;
  cached?: boolean;
  laneIds: string[];
  /** First ~600 characters of the text that was read (for the UI and thread history). */
  excerpt?: string;
  /** Normalized hit for the reader sheet, pins and library. */
  hit: SearchHit;
  /** Whether the source is part of the matter record (documents/depositions) or outside authority. */
  scope: "record" | "authority" | "internal" | "web";
  foundAt: number;
  /** Stable, server-resolvable evidence id handed to the model (authority://…, matter://…, library://…, or a canonical URL). */
  evidenceId?: string;
  /** Citing-reference signal where the provider exposes one. Never an assertion of good law. */
  treatment?: AuthorityTreatment;
  /** Date/currentness flag computed from the source's date and kind. */
  currentness?: Currentness;
}

export interface AuthorityTreatment {
  /** Where the signal came from: the judgment corpus (citing judgments / recorded treatment) or a provider's citing search. */
  basis?: "corpus" | "provider";
  /** "possibly_negative": citing opinions use negative-treatment language — review before relying. */
  signal: "possibly_negative" | "no_negative_signal" | "unavailable";
  citingCount?: number;
  negativeCount?: number;
  examples?: { title: string; cite?: string; date?: string; url?: string; phrase?: string }[];
  checkedAt: string;
  note: string;
}

export interface Currentness {
  flag: "current" | "dated" | "proposed" | "undated";
  label: string;
  /** Age in whole years when the date is known. */
  years?: number;
}

export interface ClaimVerdictView {
  claim: string;
  status: "supported" | "unsupported" | "contradicted";
  /** Citation number of the supporting/contradicting source (1-based), or null. */
  sourceN: number | null;
  quote?: string;
  note?: string;
  /** Set by the code-side quote check: true when the quote literally appears in the read source text. */
  quoteVerified?: boolean;
  /** 1-based paragraph (reader numbering) where the quote was found, for pinpoint click-through. */
  paragraph?: number;
}

export interface VerificationSummary {
  status: "verified" | "partially-verified" | "unverified" | "contradicted";
  supported: number;
  unsupported: number;
  contradicted: number;
  score: number;
  checkedAt: string;
  verdicts: ClaimVerdictView[];
  /** sha256 of the exact answer text these verdicts were computed against (constitution §23). */
  artifactHash?: string;
  /** Which verification pass produced it (1 = draft, 2 = after correction). */
  pass?: number;
  /** What the verifier was shown (sources given / checked / cut short, answer characters checked, claim cap). */
  coverage?: VerificationCoverage;
  /** True when anything was not checked (a source cut short or not shown, answer text beyond the budget, the claim cap). Never "verified". */
  partial?: boolean;
}

export interface CitationCrossCheck {
  citation: string;
  /** Matched to a source the lanes read. */
  matched: boolean;
  sourceN?: number;
  /** Resolved on CourtListener (network) even though no lane read it. */
  resolvedRemotely?: boolean;
  /** Evidence-contract state: resolved (read source), requires_review (found/resolved but not read), unresolved (nowhere). */
  state?: CitationState;
}

export interface RunStats {
  sources: number;
  read: number;
  rounds: number;
  agents: number;
  durationMs: number;
}

export type ResearchMode = "deep" | "fast";

export type AnswerBanner = "not-source-backed" | "no-api-key" | null;

export interface CoverageSummary {
  complete: boolean;
  reason: string;
  /** Claims that still lack support when the loop stopped. */
  gaps: string[];
}

// ---------------------------------------------------------------------------
// Threads and messages
// ---------------------------------------------------------------------------

export interface ResearchMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runId?: string;
  stats?: RunStats;
  verification?: Omit<VerificationSummary, "verdicts"> & { verdicts?: ClaimVerdictView[] };
  citations?: CitationCrossCheck[];
  provenance?: Provenance;
  banner?: AnswerBanner;
  followUps?: string[];
  /** Citation numbers → source ids for this answer. */
  citeMap?: Record<number, string>;
  lanes?: LaneSummary[];
  // --- run outcome (constitution §14, §23, §25, §36) ---
  /** sha256 of `content` (canonical whitespace). Verification and citation checks bind to it. */
  artifactHash?: string;
  /** Answer text version within the run (1 = draft, +1 per rewrite). */
  artifactVersion?: number;
  terminal?: RunTerminalState;
  stop?: ResearchStopState;
  failure?: FailureKind;
  failureMessage?: string;
  metrics?: RunMetrics;
  coverage?: CoverageSummary;
  /** Evidence-contract citation check bound to `artifactHash`. */
  citationCheck?: EvidenceCitationCheck;
  /** Trust state derived at persist time from what was actually established for `artifactHash`. */
  trust?: TrustState;
  mode?: ResearchMode;
  /** Jurisdiction-aware sub-questions the planner derived (fast model when available, deterministic otherwise). */
  subQuestions?: string[];
  /** True when no evidence was retrieved and the answer states that the sources reviewed do not establish the point. */
  noAnswer?: boolean;
  // --- LeClaude India ---
  /** Forum key the run used (the matter's court resolved when "Matter's court" was selected). */
  forum?: string;
  /** Language the question was asked in (deterministic from its script). */
  queryLanguage?: string;
  /** Language the answer was written in. */
  answerLanguage?: string;
  /** English search terms used when the question was not in English (router/fast model), or null when translation was unavailable. */
  searchQuery?: string | null;
  /** Date of offence used for the IPC/BNS rule (settings or the question) and the code the shared rule chose ("requires_review" shown as is). */
  offence?: { date: string | null; substantive: string };
  /** Deterministic transition-law note (BNS s.358 / BNSS s.531) when the question concerns the 1 July 2024 change. */
  transition?: { substantive: string; procedure: string; lines: string[]; source: string };
  /** Authority status table (found / read / supported / unresolved / text not available) bound to `artifactHash`. */
  authorities?: AuthorityStatusTable;
}

export interface ResearchPin {
  id: string;
  kind: "source" | "passage";
  sourceId?: string;
  hit?: SearchHit;
  text?: string;
  note?: string;
  addedAt: number;
}

export interface ResearchThread {
  id: string;
  title: string;
  matterId: string | null;
  settings: SearchSettings;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  messages: ResearchMessage[];
  /** Deduped sources across every run in the thread (text is not stored; excerpts are). */
  sources: ResearchSource[];
  pins: ResearchPin[];
  runIds: string[];
}

// ---------------------------------------------------------------------------
// Stream events: the §46 vocabulary (src/lib/ai/events.ts) specialised with the
// research payloads the UI renders (full sources, the answer text, verdict summaries).
// ---------------------------------------------------------------------------

type Specialise<T extends RunEvent["type"], Extra> = Extract<RunEvent, { type: T }> & Extra;

export interface RunOutcomePayload {
  message: ResearchMessage;
  sources: ResearchSource[];
}

export type ResearchStreamEvent =
  | Specialise<"plan.created", { lanes: ResearchLane[] }>
  | Specialise<"source.found", { source: ResearchSource }>
  | Specialise<"source.read", { source: ResearchSource }>
  | Specialise<"lane.completed", { note?: string }>
  | Specialise<"artifact.created", { text: string; citeMap: Record<number, string> }>
  | Specialise<"verification.completed", { verification: VerificationSummary }>
  | Specialise<"citation.checked", { checks: CitationCrossCheck[]; citationCheck: EvidenceCitationCheck }>
  | Specialise<"run.partial", RunOutcomePayload>
  | Specialise<"run.completed", RunOutcomePayload>
  | Specialise<"run.failed", RunOutcomePayload>
  | Specialise<"run.cancelled", RunOutcomePayload>
  | Exclude<RunEvent, { type: "plan.created" | "source.found" | "source.read" | "lane.completed" | "artifact.created" | "verification.completed" | "citation.checked" | "run.partial" | "run.completed" | "run.failed" | "run.cancelled" }>;

/** What engine code hands to the emitter (runId/at/seq are stamped for it). */
export type ResearchEventInput = ResearchStreamEvent extends infer E ? (E extends RunEventBase ? Omit<E, keyof RunEventBase> : never) : never;

export type ResearchTerminalEvent = Extract<ResearchStreamEvent, { type: "run.partial" | "run.completed" | "run.failed" | "run.cancelled" }>;
