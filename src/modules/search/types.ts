/**
 * Search module contracts. This file is client-safe (no server imports) and is
 * shared by the API routes, the seed, the React components and the tests.
 */
import type { CodingDecision } from "@/lib/types/domain";
import type { Provenance } from "@/lib/integrity/types";
import type { FailureKind, ResearchStopState, RunMetrics, RunTerminalState } from "@/lib/ai/events";
import type { TrustState } from "@/lib/evidence/types";
import type { AnswerBanner, ResearchMode, ResearchSource, RunStats } from "./engine/types";

export type SearchSource = "caselaw" | "statutes" | "regulations" | "federal_register" | "dockets" | "web" | "library" | "ediscovery";

/**
 * LeClaude India: "caselaw" is the Supreme Court and High Court judgment corpus (plus Indian Kanoon when configured) and
 * "statutes" is India Code. The US providers ("regulations", "federal_register", "dockets") stay in the type so the US
 * toolkit keeps compiling, but they are not offered in this fork (sanitizeSettings drops them).
 */
export const ALL_SOURCES: SearchSource[] = ["caselaw", "statutes", "web", "library", "ediscovery"];

export const SOURCE_LABEL: Record<SearchSource, string> = {
  caselaw: "Judgments (SC & High Courts)",
  statutes: "India Code",
  regulations: "Regulations",
  federal_register: "Gazette notifications",
  dockets: "Case status",
  web: "Web",
  library: "Firm library",
  ediscovery: "Matter documents",
};

export const SOURCE_SHORT: Record<SearchSource, string> = {
  caselaw: "Judgments",
  statutes: "Statutes",
  regulations: "Rules",
  federal_register: "Gazette",
  dockets: "Case status",
  web: "Web",
  library: "Library",
  ediscovery: "Matter docs",
};

export type SearchOrder = "score" | "date";
export type DatePreset = "any" | "1y" | "5y" | "10y" | "custom";
export type Authority = "binding" | "persuasive" | "n/a";

/** Where the reader drawer loads full text from. */
export type ReadRef =
  | { kind: "opinion"; id: number }
  | { kind: "cfr"; title: number; section: string }
  | { kind: "fr"; id: string }
  | { kind: "url"; url: string }
  | { kind: "library"; id: string }
  | { kind: "edoc"; id: string }
  | { kind: "statute"; url: string; id?: string }
  /** A judgment in the local SC/HC corpus (intel document id). */
  | { kind: "judgment"; id: string }
  /** An India Code section in the store. */
  | { kind: "section"; id: string }
  /** A section of the statutes corpus in Postgres (Open India Law parse): exact act id, section number and variant. */
  | { kind: "law"; actId: string; section: string; variant: number };

/** Indian authority metadata carried on a hit (court identity from the registry; never guessed). */
export interface IndianHitMeta {
  judgmentId?: string;
  /** Registry court id; null when the court did not resolve. */
  courtId?: string | null;
  unresolvedCourt?: string;
  benchId?: string;
  benchStrength?: number;
  judges?: string[];
  neutralCitation?: string;
  reporterCitations?: string[];
  caseNumber?: string;
  caseType?: string;
  /** Language of the text of record. */
  language?: string;
  translations?: { language: string; origin: string }[];
  statutes?: string[];
  /** Treatment recorded in the corpus (overruled / doubted / referred…), only from sources. */
  corpusTreatment?: { status: string; by?: string; note?: string }[];
  /** Statute hits: enactment and section. */
  enactment?: string;
  section?: string;
  replacedBy?: string;
  provider?: string;
}

/** One normalized result, regardless of provider. */
export interface SearchHit {
  id: string;
  source: SearchSource;
  title: string;
  subtitle?: string;
  cite?: string;
  citations?: string[];
  court?: string;
  courtId?: string;
  date?: string;
  status?: string;
  citeCount?: number;
  snippet?: string;
  url?: string;
  score?: number;
  authority?: Authority;
  readRef?: ReadRef;
  // case law
  opinionId?: number;
  clusterId?: number;
  docketNumber?: string;
  judge?: string;
  // dockets
  docketId?: number;
  parties?: string[];
  attorneys?: string[];
  natureOfSuit?: string;
  cause?: string;
  assignedTo?: string;
  dateTerminated?: string | null;
  // regulations
  cfr?: { title?: string; part?: string; section?: string; heading?: string; partHeading?: string; effective?: string };
  // federal register
  fr?: { documentNumber: string; type?: string; agencies?: string[]; effectiveOn?: string; commentsCloseOn?: string; docketIds?: string[]; pdfUrl?: string };
  // statutes
  statute?: { packageId?: string; granuleId?: string; collection?: string; textUrl?: string; pdfUrl?: string };
  // library
  library?: { type: string; tags?: string[]; practiceArea?: string; officeDocId?: string; description?: string };
  // India (judgments / India Code)
  india?: IndianHitMeta;
  // e-discovery
  edoc?: { bates: string; custodian: string; type: string; from?: string; to?: string[]; aiScore?: number; coding?: CodingDecision };
}

export interface SearchSettings {
  sources: SearchSource[];
  jurisdiction: string; // forum key from JURISDICTIONS ("matter-forum", "hc-karnataka", "hc-telangana", "hc-andhra", "sci", "all-india", …)
  courts?: string; // registry court ids (space separated) that narrow judgment retrieval; binding/persuasive still follows the forum
  datePreset: DatePreset;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  order: SearchOrder;
  matterId?: string | null;
  fast: boolean;
  /** Language the answer is written in (quotations stay in the judgment's original language). Default: the query's language. */
  answerLanguage?: string;
  /** Date of the offence (YYYY-MM-DD) for the IPC/BNS transition; also read from the question when stated there. */
  offenceDate?: string;
}

export const DEFAULT_SETTINGS: SearchSettings = {
  sources: ["caselaw", "statutes", "library"],
  jurisdiction: "matter-forum",
  courts: "",
  datePreset: "any",
  limit: 15,
  order: "score",
  matterId: null,
  fast: false,
};

/** Request body for POST /api/search/run (compatible with useAgent's body). */
export interface SearchRunRequest extends SearchSettings {
  message: string;
  runId?: string;
  threadId?: string | null;
  savedSearchId?: string;
  history?: unknown[];
  previousResponseId?: string | null;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  settings: SearchSettings;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  runCount?: number;
  pinned?: boolean;
  tags?: string[];
  notes?: string;
  matterId?: string | null;
}

export interface SourceError { source: SearchSource; message: string; durationMs?: number }

export interface SearchRun {
  id: string;
  /** Research thread this run belongs to (new engine). Seeded/legacy runs may omit it. */
  threadId?: string;
  query: string;
  settings: SearchSettings;
  createdAt: string;
  durationMs: number;
  counts: Partial<Record<SearchSource, number>>;
  totals?: Partial<Record<SearchSource, number>>;
  errors?: SourceError[];
  synthesis?: string;
  topHits?: SearchHit[];
  ownerId: string;
  matterId?: string | null;
  savedSearchId?: string;
  aiStatus?: "ok" | "no_api_key" | "error" | "skipped";
  // --- research engine fields ---
  mode?: ResearchMode;
  stats?: RunStats;
  verification?: { status: "verified" | "partially-verified" | "unverified" | "contradicted"; supported: number; unsupported: number; contradicted: number; score: number; checkedAt: string };
  provenance?: Provenance;
  banner?: Exclude<AnswerBanner, null>;
  followUps?: string[];
  sources?: ResearchSource[];
  // --- run outcome (constitution §14, §23, §25, §36); never reduced to "done" ---
  terminal?: RunTerminalState;
  stop?: ResearchStopState;
  failure?: FailureKind;
  metrics?: RunMetrics;
  /** sha256 of the persisted answer text; verification on the run binds to it. */
  artifactHash?: string;
  trust?: TrustState;
}

/** SSE events emitted by /api/search/run: see engine/types.ts (ResearchStreamEvent) plus the agent's text/tool events. */
export type { ResearchStreamEvent as SearchStreamEvent } from "./engine/types";

export interface ReadResult {
  kind: ReadRef["kind"];
  title: string;
  cite?: string;
  url?: string;
  text: string;
  length: number;
  meta?: Record<string, unknown>;
}

export interface CitationCheck {
  citation: string;
  resolved: boolean;
  status: number;
  error?: string;
  matches?: { case_name?: string; date_filed?: string; url?: string }[];
}

export interface MemoSource {
  hit: SearchHit;
  note?: string; // holding / relevance as entered by the user
  addedAt: number;
}
