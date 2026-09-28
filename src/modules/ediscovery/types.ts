/**
 * Client-safe types for the e-discovery review workspace. Nothing here
 * imports server-only modules; the API routes and React components share it.
 */
import type { CodingDecision, DocType, EDocument, IssueCode, PrivilegeLogEntry, ProductionSet, Redaction, ReviewBatch, ReviewLayout, SavedSearchRecord, SearchTermReport } from "@/lib/types/domain";
import type { BatchProgress, DisagreementReport } from "./batch-pure";
import type { IndiaDocMeta } from "./india";

export type ReviewTab = "review" | "batches" | "depositions" | "cross" | "timeline" | "story" | "people" | "conflicts" | "productions" | "codes";

export const REVIEW_TABS: { id: ReviewTab; label: string }[] = [
  { id: "review", label: "Review" },
  { id: "batches", label: "Batches" },
  { id: "depositions", label: "Depositions" },
  { id: "cross", label: "Cross-analysis" },
  { id: "timeline", label: "Timeline" },
  { id: "story", label: "Story" },
  { id: "people", label: "People & graph" },
  { id: "conflicts", label: "Conflicts" },
  { id: "productions", label: "Productions" },
  { id: "codes", label: "Codes & privilege" },
];

/** Built-in saved-search views on the left rail. */
export type SavedView = "all" | "needs_review" | "hot" | "privileged" | "ai_responsive" | "recent";

export const SAVED_VIEWS: { id: SavedView; label: string; hint: string }[] = [
  { id: "all", label: "All documents", hint: "Every document collected for this matter" },
  { id: "needs_review", label: "Needs review", hint: "No responsiveness decision yet" },
  { id: "hot", label: "Hot documents", hint: "Flagged hot by a reviewer" },
  { id: "privileged", label: "Privileged", hint: "Coded privileged (any basis)" },
  { id: "ai_responsive", label: "AI: likely responsive", hint: "AI responsiveness score of 70 or higher" },
  { id: "recent", label: "Recently viewed", hint: "Last 25 documents you opened" },
];

export type CodingStatus = "responsive" | "non_responsive" | "needs_review" | "privileged" | "hot";
export type ScoreBucket = "90+" | "70-89" | "50-69" | "<50" | "unscored";

export const SCORE_BUCKETS: { id: ScoreBucket; label: string }[] = [
  { id: "90+", label: "90 – 100" },
  { id: "70-89", label: "70 – 89" },
  { id: "50-69", label: "50 – 69" },
  { id: "<50", label: "Below 50" },
  { id: "unscored", label: "Unscored" },
];

export type SortKey = "date" | "bates" | "exhibit" | "custodian" | "type" | "subject" | "aiScore" | "relevance" | "from" | "pages" | "size" | "family" | "thread" | "reviewed";

/** Row grouping in the review grid: families, email threads or near-duplicate clusters stay contiguous. */
export type GroupBy = "none" | "family" | "thread" | "neardup";

export interface SearchFilters {
  custodians?: string[]; // custodianId
  types?: DocType[];
  statuses?: CodingStatus[];
  issues?: string[]; // issue codes ("TOX-01")
  scores?: ScoreBucket[];
  years?: string[]; // "2001"
  /** "2001-03" — set by the date histogram when it is showing months. */
  months?: string[];
}

export interface SearchRequest {
  matterId: string;
  q?: string;
  semantic?: boolean;
  view?: SavedView;
  filters?: SearchFilters;
  sort?: SortKey;
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
  /** 1-based page (alternative to offset). */
  page?: number;
  /** Restrict to a review batch (batch review mode); `qc` narrows to its QC sample. */
  batchId?: string;
  qc?: boolean;
  /** Restrict to an explicit id list (selection-based batches and productions). */
  ids?: string[];
  groupBy?: GroupBy;
}

export interface FacetBucket { value: string; label: string; count: number }
export interface DateBucket { year: string; count: number }

export interface Facets {
  custodian: FacetBucket[];
  type: FacetBucket[];
  status: FacetBucket[];
  issues: FacetBucket[];
  score: FacetBucket[];
  years: DateBucket[];
  /** Month histogram (YYYY-MM) of the current result set, for the date chart. */
  months: DateBucket[];
}

export interface FamilyInfo {
  isParent: boolean;
  isAttachment: boolean;
  attachmentCount: number;
  inThread: boolean;
  threadSize: number;
  isDuplicate: boolean;
  nearDuplicateCount: number;
}

/** Lightweight row for the review table (no full text). */
export type DocRow = Omit<EDocument, "text" | "entities" | "aiSummary"> & {
  family2: FamilyInfo;
  score?: number; // semantic/keyword relevance 0..1
  snippet?: string;
  textLength: number;
  /** One-line rationale behind the AI suggestion (from the cached analysis or the batch prediction). */
  aiRationale?: string;
  /** Model confidence in the suggestion (0..1) when recorded. */
  aiConfidence?: number;
  /** Group key when the search was grouped (family root id, thread id or near-dup cluster id). */
  groupKey?: string;
  /** Position inside the group (0 = group head). */
  groupIndex?: number;
  groupSize?: number;
  /** Number of redactions on the document. */
  redactions?: number;
  /** Indian record metadata (record class, exhibit mark, witness marked through, language / translation). */
  india?: IndiaDocMeta;
};

export interface SearchResponse {
  hits: DocRow[];
  total: number; // matches for query+filters
  totalWorkspace: number; // all docs in the matter
  offset: number;
  limit: number;
  facets: Facets;
  parsed: ParsedQuerySummary;
  tookMs: number;
  semantic: boolean;
  page: number;
  pages: number;
  groupBy?: GroupBy;
}

export interface ParsedQuerySummary {
  terms: string[]; // highlight terms
  fields: { field: string; value: string }[];
  bates: { start: string; end: string }[];
  warnings: string[];
}

export interface MatterStats {
  matterId: string;
  total: number;
  reviewed: number;
  pctReviewed: number;
  needsReview: number;
  responsive: number;
  nonResponsive: number;
  privileged: number;
  hot: number;
  aiScored: number;
  custodians: number;
  productionDeadline?: { label: string; date: string; daysLeft: number } | null;
  indexed: { docs: number; chunks: number; embedded: number };
}

export interface SavedViewCounts { view: SavedView; count: number }

/** Batch as listed by the API: the record plus derived progress and names. */
export type ReviewBatchSummary = ReviewBatch & { progress: BatchProgress; assigneeName?: string; createdByName?: string };

export interface BatchCreateInput {
  matterId: string;
  name: string;
  description?: string;
  /** Explicit ids (selection) or a query to snapshot. */
  ids?: string[];
  q?: string;
  view?: SavedView;
  filters?: SearchFilters;
  savedSearchId?: string;
  /** Split into several batches of at most this many documents. */
  size?: number;
  assigneeId?: string;
  priority?: ReviewBatch["priority"];
  dueAt?: string;
  qcSamplePercent?: number;
  secondPass?: boolean;
  /** Only documents that still need a decision (default true). */
  uncodedOnly?: boolean;
}

export type SavedSearchInput = Pick<SavedSearchRecord, "name" | "q"> & Partial<Pick<SavedSearchRecord, "description" | "view" | "filters" | "sort" | "dir" | "semantic" | "shared">> & { matterId: string };

export type ReviewLayoutInput = Pick<ReviewLayout, "name" | "hiddenColumns" | "columnWidths" | "density"> & { matterId?: string };

export type RedactionInput = Pick<Redaction, "docId" | "kind" | "reason"> & Partial<Pick<Redaction, "start" | "end" | "page" | "rect" | "label" | "note">>;

export interface ProductionCreateInput {
  matterId: string;
  name: string;
  volume?: string;
  prefix: string;
  padding?: number;
  startNumber?: number;
  stampText?: string;
  /** Explicit ids, a query, or (default) every production-ready document. */
  ids?: string[];
  q?: string;
  view?: SavedView;
  filters?: SearchFilters;
  savedSearchId?: string;
  notes?: string;
}

export type ProductionSummary2 = ProductionSet & { docCount: number; pageCount: number; batesRange: { begin: string; end: string } | null; redactedDocs: number; createdByName?: string };

export interface SearchTermReportRequest { matterId: string; terms: string[]; view?: SavedView; filters?: SearchFilters }

export type { ReviewBatch, SavedSearchRecord, ReviewLayout, Redaction, ProductionSet, SearchTermReport, BatchProgress, DisagreementReport };

/** Audit history row for one document (from the hash-chained audit log). */
export interface DocHistoryEntry {
  id: string;
  ts: string;
  actorId: string;
  actorName: string;
  action: string;
  summary: string;
  fields?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export type CodingPatch = Partial<CodingDecision>;

export interface BulkCodingRequest {
  ids: string[];
  patch: CodingPatch;
  addIssues?: string[];
  removeIssues?: string[];
  reviewerId?: string;
  /** Also code the parents and attachments of the listed documents (families travel together). */
  includeFamilies?: boolean;
  /** Compute the effect without writing anything (the confirmation summary). */
  dryRun?: boolean;
}

/** What a bulk coding request would change, shown to the reviewer before it is applied. */
export interface BulkPreview {
  /** Final id list (selection plus family members when requested). */
  ids: string[];
  total: number;
  /** Family members that were added to the selection. */
  addedFamily: number;
  /** Documents already carrying every requested value (nothing changes for them). */
  unchanged: number;
  fields: { field: string; label: string; to: string; changed: number }[];
  /** Coded documents whose responsiveness call would be overwritten with a different one. */
  overwrites: number;
}

/** A verbatim excerpt the model offered in support of its suggestion, checked against the document text. */
export interface AnalysisQuote {
  text: string;
  /** True when the excerpt was found verbatim (whitespace/quote-insensitive) in the document. */
  verified: boolean;
  /** Character offset in `doc.text` when verified. */
  start?: number;
  end?: number;
}

export interface AIAnalysis {
  summary: string;
  keyIssues: string[];
  entities: { people: string[]; orgs: string[]; places: string[]; chemicals?: string[] };
  suggestedCoding: {
    responsive: boolean;
    responsiveConfidence: number; // 0-100
    privileged: boolean;
    privilegedConfidence: number;
    privilegeBasis?: CodingDecision["privilegeBasis"];
    hot: boolean;
    issues: string[]; // issue codes
    rationale: string;
  };
  /** Supporting excerpts, each verified against the text (absent for analyses made before quotes were collected). */
  quotes?: AnalysisQuote[];
  privilegeRisk?: string;
  generatedAt: string;
  model: string;
}

export interface SimilarDoc {
  id: string;
  bates: string;
  subject: string;
  date: string;
  custodianName: string;
  type: DocType;
  score: number;
  passage: string;
  reason: "semantic" | "keyword" | "duplicate" | "near-duplicate" | "thread" | "family";
}

export interface PredictProgressEvent {
  type: "start" | "progress" | "doc" | "done" | "error";
  total?: number;
  done?: number;
  scored?: number;
  docId?: string;
  bates?: string;
  aiScore?: number;
  message?: string;
  code?: string;
  summary?: { scored: number; likelyResponsive: number; likelyNonResponsive: number; uncertain: number; tookMs: number };
}

export interface ProductionSummary {
  matterId: string;
  responsive: number;
  privilegedWithheld: number;
  produced: number;
  batesRanges: { start: string; end: string; count: number }[];
  byCustodian: { custodian: string; count: number }[];
  byType: { type: string; count: number }[];
}

export type IssueCodeInput = Pick<IssueCode, "code" | "label" | "description" | "color" | "parentId">;

export type PrivilegeLogRow = PrivilegeLogEntry & { subject: string; custodianName: string };

export const ISSUE_COLORS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "info", "warning", "destructive", "success", "primary"] as const;

export const PRIVILEGE_BASES: { id: NonNullable<CodingDecision["privilegeBasis"]>; label: string }[] = [
  // Indian wording (BSA 2023 ss.132–134 / IEA 1872 ss.126–129); ids unchanged so stored coding keeps working.
  { id: "attorney-client", label: "Advocate–client (BSA s.132)" },
  { id: "work-product", label: "Legal adviser (BSA s.134)" },
  { id: "common-interest", label: "Common interest" },
  { id: "joint-defense", label: "Joint defence" },
];

export const CONFIDENTIALITY_LEVELS: { id: NonNullable<CodingDecision["confidentiality"]>; label: string }[] = [
  { id: "public", label: "Public" },
  { id: "confidential", label: "Confidential" },
  { id: "highly confidential", label: "Highly Confidential" },
  { id: "AEO", label: "Attorneys' Eyes Only" },
];
