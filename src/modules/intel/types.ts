/**
 * Intelligence layer — client-safe types.
 *
 * The intel layer ingests authoritative outside data (case law, dockets, court rules, judges, regulations,
 * Federal Register notices, FDA recalls, MDLs, attorney and firm data, news) and the firm's own document
 * corpora into one normalized, chunked, embedded and entity-linked store, then derives sourced insights
 * (chronologies, profiles, trends, clusters, alerts) that the rest of the platform reads.
 *
 * Every record carries provenance and confidence; low-confidence or contradicted records are flagged, never
 * silently promoted. Background jobs are durable, retried, repaired by the steward and escalated only when
 * repair fails.
 */
import type { ID, ISODate } from "@/lib/types/domain";
import type { Provenance } from "@/lib/integrity/types";

// ---------------- Sources and adapters ----------------

export type IntelAdapterId =
  | "courtlistener-opinions"
  | "courtlistener-dockets"
  | "courtlistener-judges"
  | "ecfr"
  | "federal-register"
  | "govinfo"
  | "openfda-recalls"
  | "jpml-mdls"
  | "court-rules"
  | "news"
  | "local-corpus"
  | "web-list"
  // LeClaude India sources (src/modules/india/sources)
  | "sci-open-data"
  | "hc-open-data"
  | "indian-kanoon"
  | "india-code"
  | "scc-online"
  | "manupatra";

export type IntelEvery = "10m" | "1h" | "6h" | "daily" | "weekly" | "manual";

export interface IntelSchedule {
  every: IntelEvery;
  /** "HH:MM" local time for daily/weekly runs. */
  at?: string;
  /** 0 (Sunday) – 6 for weekly runs. */
  weekday?: number;
}

export interface IntelScope {
  matterIds?: ID[];
  jurisdictions?: string[];
  courts?: string[];
  queries?: string[];
  /** Adapter-specific: docket numbers, MDL numbers, product names, URLs, folder paths… */
  targets?: string[];
}

export interface IntelSourceHealth {
  ok: boolean;
  lastError?: string;
  consecutiveFailures: number;
  lastSuccessAt?: ISODate;
}

export interface IntelSourceStats {
  documents: number;
  chunks: number;
  entities: number;
  /** Documents added by the most recent run. */
  lastAdded: number;
  lastDurationMs?: number;
}

export interface IntelSource {
  id: ID;
  adapter: IntelAdapterId;
  name: string;
  description?: string;
  /** Adapter-specific configuration validated by the adapter's configSchema. */
  config: Record<string, unknown>;
  schedule: IntelSchedule;
  enabled: boolean;
  scope?: IntelScope;
  status: "idle" | "running" | "error" | "disabled";
  health: IntelSourceHealth;
  lastRunAt?: ISODate;
  nextRunAt?: ISODate;
  /** Opaque incremental cursor the adapter returned last time (e.g. last modified date). */
  cursor?: string;
  stats: IntelSourceStats;
  /** System sources ship with the platform; users cannot delete them, only disable. */
  system?: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ---------------- Documents and chunks ----------------

export type IntelDocumentKind =
  | "opinion"
  | "docket"
  | "docket_entry"
  | "court_rule"
  | "regulation"
  | "register_notice"
  | "recall"
  | "adverse_event"
  | "mdl"
  | "judge"
  | "attorney"
  | "firm"
  | "news"
  | "local_file"
  | "web_page"
  | "statute"
  | "expert";

export type IntelFlagKind =
  | "low_confidence"
  | "unverified"
  | "contradicted"
  | "stale"
  | "parse_error"
  | "duplicate"
  | "needs_review"
  | "broken_link";

export interface IntelFlag {
  kind: IntelFlagKind;
  note?: string;
  at: ISODate;
  /** Who raised it: an adapter, the steward, a sweep, a reviewer. */
  by?: string;
}

export interface IntelDates {
  filed?: ISODate;
  decided?: ISODate;
  published?: ISODate;
  effective?: ISODate;
  /** Generic event date for recalls, docket entries, news. */
  event?: ISODate;
  modified?: ISODate;
}

export interface IntelDocument {
  id: ID;
  sourceId: ID;
  adapter: IntelAdapterId;
  kind: IntelDocumentKind;
  title: string;
  summary?: string;
  jurisdiction?: string;
  court?: string;
  /** Provider court id (e.g. CourtListener "cand"). */
  courtId?: string;
  docketNumber?: string;
  caseName?: string;
  citation?: string;
  judgeIds: ID[];
  attorneyIds: ID[];
  firmIds: ID[];
  partyIds: ID[];
  mdlId?: ID;
  productIds: ID[];
  agencies: string[];
  dates: IntelDates;
  url?: string;
  externalId?: string;
  /** Content hash of the normalized text (dedupe key). */
  hash: string;
  /** Full text lives in the blob store; the document row stays small. */
  textBlobId?: string;
  textLength: number;
  chunkCount: number;
  /** Matters this document is linked to (watches, matter dockets, local folders mapped to matters). */
  matterIds: ID[];
  tags: string[];
  flags: IntelFlag[];
  /** 0–1: extraction/metadata confidence (not legal significance). */
  confidence: number;
  provenance?: Provenance;
  /** Adapter-specific structured fields (parties, entries, recall classification…). */
  meta?: Record<string, unknown>;
  fetchedAt: ISODate;
  updatedAt: ISODate;
}

export interface IntelChunk {
  id: ID;
  docId: ID;
  idx: number;
  text: string;
  section?: string;
  page?: number;
  startChar: number;
  endChar: number;
  hash: string;
}

// ---------------- Entities and relations ----------------

export type IntelEntityType =
  | "judge"
  | "attorney"
  | "firm"
  | "party"
  | "court"
  | "mdl"
  | "product"
  | "agency"
  | "regulation"
  | "statute"
  | "expert";

export interface IntelEntitySourceRef {
  docId: ID;
  chunkId?: ID;
  quote?: string;
  url?: string;
}

export interface IntelEntity {
  id: ID;
  type: IntelEntityType;
  /** Display name. */
  name: string;
  /** Normalized key used for alias resolution (lowercase, punctuation-free). */
  canonical: string;
  aliases: string[];
  /** Typed per kind: court, title, appointedBy, bar, firmId, transfereeCourt, mdlNumber, manufacturer, cfrCite… */
  attributes: Record<string, unknown>;
  mentionCount: number;
  /** Capped list of the most recent linked documents. */
  docIds: ID[];
  sources: IntelEntitySourceRef[];
  /** Provider ids (CourtListener person id, JPML number…). */
  externalIds?: Record<string, string>;
  flags?: IntelFlag[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type IntelRelationType =
  | "presides"
  | "appears_in"
  | "member_of"
  | "represents"
  | "opposes"
  | "cites"
  | "regulates"
  | "recalled"
  | "transferred_to"
  | "co_counsel"
  | "before_judge"
  | "employed_by"
  | "manufactures"
  | "mentions";

export interface IntelRelation {
  id: ID;
  from: ID;
  to: ID;
  type: IntelRelationType;
  evidence: IntelEntitySourceRef[];
  confidence: number;
  firstSeen: ISODate;
  lastSeen: ISODate;
  /** Number of independent documents supporting the edge. */
  weight: number;
}

// ---------------- Insights ----------------

export type IntelInsightKind = "trend" | "cluster" | "pattern" | "chronology" | "profile" | "anomaly" | "alert" | "digest";

export interface IntelInsightScope {
  matterId?: ID;
  userId?: ID;
  teamId?: ID;
  entityIds: ID[];
  jurisdiction?: string;
  court?: string;
  period?: { from: ISODate; to: ISODate };
}

export interface IntelEvidence {
  docId: ID;
  chunkId?: ID;
  quote?: string;
  url?: string;
  /** Optional link into the platform (e-discovery doc, docket entry, library item). */
  href?: string;
}

/** Chart-ready series used by trend and anomaly insights. */
export interface IntelSeries {
  label: string;
  points: { t: string; v: number }[];
}

export interface IntelTimelineEntry {
  at: ISODate;
  title: string;
  detail?: string;
  kind?: string;
  evidence: IntelEvidence[];
  confidence: number;
}

export interface IntelInsight {
  id: ID;
  kind: IntelInsightKind;
  scope: IntelInsightScope;
  title: string;
  summary: string;
  /** Kind-specific payload: { series } | { clusters } | { timeline } | { graph } | { profile } | { table }. */
  data: Record<string, unknown>;
  evidence: IntelEvidence[];
  provenance: Provenance;
  confidence: number;
  status: "draft" | "verified" | "flagged" | "published" | "dismissed";
  flags: IntelFlag[];
  /** Ranking hint for "For you" lists (recency × relevance × confidence). */
  score?: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ---------------- Jobs and the steward ----------------

export type IntelJobKind =
  | "source.run"
  | "doc.extract"
  | "doc.index"
  | "entities.resolve"
  | "analysis.run"
  | "insight.verify"
  | "sweep"
  | "workflow.tick"
  | "scan.run";

export type IntelJobStatus = "queued" | "running" | "succeeded" | "failed" | "fixed" | "escalated" | "cancelled";

export type IntelErrorCode =
  | "rate_limited"
  | "network"
  | "not_configured"
  | "parse"
  | "schema_drift"
  | "empty"
  | "low_confidence"
  | "duplicate"
  | "timeout"
  | "cancelled"
  | "unknown";

export interface IntelJobLogLine {
  at: ISODate;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  data?: Record<string, unknown>;
}

export type StewardAction =
  | "retry"
  | "backoff"
  | "switch_provider"
  | "narrow_query"
  | "rechunk"
  | "reembed"
  | "quarantine"
  | "flag"
  | "disable_source"
  | "escalate"
  | "none";

export interface IntelJobFix {
  at: ISODate;
  action: StewardAction;
  by: "steward" | "model" | "human";
  note: string;
}

export interface IntelJob {
  id: ID;
  kind: IntelJobKind;
  sourceId?: ID;
  payload: Record<string, unknown>;
  status: IntelJobStatus;
  /** 1 (highest) – 9. */
  priority: number;
  attempts: number;
  maxAttempts: number;
  log: IntelJobLogLine[];
  /** Milliseconds after which a running job with no heartbeat is considered orphaned. */
  heartbeatAt?: ISODate;
  runAfter?: ISODate;
  startedAt?: ISODate;
  finishedAt?: ISODate;
  error?: { code: IntelErrorCode; message: string };
  fixes: IntelJobFix[];
  escalation?: { reason: string; reviewId?: string; at: ISODate };
  result?: Record<string, unknown>;
  /** Optional idempotency key: while a job with the same key is queued or running, enqueue returns it instead of adding another. */
  dedupeKey?: string;
  /** Worker id that claimed the job (diagnostics). */
  workerId?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ---------------- Watches ----------------

export type IntelWatchKind = "judge" | "docket" | "mdl" | "product" | "regulation" | "attorney" | "firm" | "query" | "court";

export interface IntelWatch {
  id: ID;
  userId: ID;
  kind: IntelWatchKind;
  /** Entity id, or the query string for kind "query". */
  target: string;
  label: string;
  matterId?: ID;
  channels: ("home" | "digest" | "task")[];
  lastNotifiedAt?: ISODate;
  createdAt: ISODate;
}

// ---------------- Search ----------------

export interface IntelSearchQuery {
  q: string;
  kinds?: IntelDocumentKind[];
  jurisdiction?: string;
  court?: string;
  dateFrom?: ISODate;
  dateTo?: ISODate;
  entityIds?: ID[];
  matterId?: ID;
  sourceIds?: ID[];
  limit?: number;
}

export interface IntelSearchHit {
  doc: Pick<IntelDocument, "id" | "kind" | "title" | "court" | "jurisdiction" | "citation" | "docketNumber" | "caseName" | "url" | "dates" | "confidence" | "flags">;
  chunk: Pick<IntelChunk, "id" | "idx" | "text" | "section" | "page">;
  score: number;
}

// ---------------- Health ----------------

export interface IntelHealth {
  sources: { total: number; enabled: number; erroring: number; running: number };
  jobs: { queued: number; running: number; failed24h: number; fixed24h: number; escalated: number };
  documents: number;
  chunks: number;
  entities: number;
  insights: { total: number; flagged: number; pendingVerification: number };
  lastSweepAt?: ISODate;
  background: "inline" | "cron" | "off";
}

export const INTEL_COLLECTIONS = {
  sources: "intel_sources",
  documents: "intel_documents",
  chunks: "intel_chunks",
  entities: "intel_entities",
  relations: "intel_relations",
  insights: "intel_insights",
  jobs: "intel_jobs",
  watches: "intel_watches",
  httpCache: "intel_http_cache",
} as const;

/** Vector namespace for intel chunks. */
export const INTEL_VECTOR_NAMESPACE = "intel";

/** Records older than this (per kind) are marked stale by the sweep. */
export const INTEL_STALE_AFTER_DAYS: Record<IntelDocumentKind, number> = {
  opinion: 3650,
  docket: 7,
  docket_entry: 3650,
  court_rule: 90,
  regulation: 30,
  register_notice: 3650,
  recall: 30,
  adverse_event: 30,
  mdl: 14,
  judge: 90,
  attorney: 180,
  firm: 180,
  news: 30,
  local_file: 30,
  web_page: 30,
  statute: 90,
  expert: 180,
};

// ---------------- Adapter and provider contracts (additive, client-safe) ----------------

/** A structured error an adapter or provider reported; `fatal: false` errors do not fail the run. */
export interface AdapterError {
  code: IntelErrorCode;
  message: string;
  retryable: boolean;
  fatal?: boolean;
  provider?: string;
  at?: ISODate;
  data?: Record<string, unknown>;
}

/** What one adapter run produced. Stored on the job (`result`) and folded into the source stats. */
export interface AdapterResult {
  added: number;
  updated: number;
  skipped: number;
  errors: AdapterError[];
  nextCursor?: string;
  /** Human-readable notes ("Tavily key not configured", "fallback list used"). */
  notes?: string[];
  /** Ids of documents touched by this run (capped). */
  docIds?: ID[];
  chunks?: number;
  durationMs?: number;
}

/** Deterministic entity-name stub placed in `IntelDocument.meta.entities` for the analysis layer to resolve. */
export interface IntelEntityMention {
  type: IntelEntityType;
  name: string;
  role?: string;
  externalId?: string;
}

export interface IntelProviderStatus {
  id: "openai" | "courtlistener" | "govinfo" | "firecrawl" | "tavily" | "openfda" | "ecfr" | "federal-register" | "jpml" | "web"
    | "sci-open-data" | "hc-open-data" | "indian-kanoon" | "india-code" | "scc-online" | "manupatra";
  name: string;
  /** True when the provider can be used (public endpoints count as configured). */
  configured: boolean;
  /** True when a key is present (vs. anonymous/DEMO access). */
  keyed: boolean;
  envVar?: string;
  note?: string;
}

export interface IntelAdapterInfo {
  id: IntelAdapterId;
  name: string;
  description: string;
  kinds: IntelDocumentKind[];
  /** Providers the adapter needs; a source is "not configured" when one is missing. */
  requires: IntelProviderStatus["id"][];
  configured: boolean;
  defaults: Record<string, unknown>;
}

export interface IntelConfigView {
  background: IntelHealth["background"];
  corpusDirs: string[];
  providers: IntelProviderStatus[];
  adapters: IntelAdapterInfo[];
  staleAfterDays: Record<IntelDocumentKind, number>;
  jobs: { concurrency: number; tickMs: number; orphanAfterMs: number };
  /** Set when the instrumentation loop is running in this process. */
  loop?: { startedAt: ISODate; lastTickAt?: ISODate; ticks: number; lastError?: string };
}

export interface IntelSweepReport {
  at: ISODate;
  durationMs: number;
  insightsChecked: number;
  insightsFlagged: number;
  staleFlagged: number;
  contradictions: number;
  brokenLinks: number;
  urlsChecked: number;
  orphanedEntities: number;
  notes: string[];
}

export interface IntelRunDueResult {
  enqueued: number;
  ran: number;
  succeeded: number;
  failed: number;
  fixed: number;
  escalated: number;
  reaped: number;
  durationMs: number;
  jobIds: ID[];
}
