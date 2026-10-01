/**
 * Document review (discovery) contract, shared by client and server (no server imports).
 *
 * A review runs over one document set with a practice-area playbook (or custom columns). For every file it records:
 * the document type, a short summary, relevance to each issue in the playbook, a privilege screen and one value per
 * review column. Every cell, issue reason and privilege basis that rests on the document carries a quote and page that
 * are checked against the stored text in code (`quoteFound`); nothing is re-bound to another file or page when a quote
 * is not found. Model output is a suggestion: the reviewer's coding decision is stored separately, bound to the row's
 * `rowHash`, and marked stale when the row is re-run.
 *
 * API (all under /api/documents, authorization = the set's matter policy or owner, exactly as for sets):
 *   GET    /playbooks                                      → { playbooks: ReviewPlaybook[] }
 *   GET    /sets/:id/reviews                               → { reviews: DocReview[] }
 *   POST   /sets/:id/reviews            CreateReviewInput  → { review: DocReview }                      (write)
 *   GET    /sets/:id/reviews/:rid                          → { review: DocReview }
 *   PATCH  /sets/:id/reviews/:rid       { name?, columns?, issues?, questions? } → { review }        (write; changed
 *                                                            columns/issues bump `version` and make rows pending)
 *   DELETE /sets/:id/reviews/:rid                          → { ok: true }                           (delete)
 *   POST   /sets/:id/reviews/:rid/run   { max? }           → ReviewProgress (≈200 s per call; call until remaining 0)
 *   GET    /sets/:id/reviews/:rid/rows  RowQuery params    → { rows: DocReviewRow[]; total: number; facets: ReviewFacets }
 *   PATCH  /sets/:id/reviews/:rid/rows/:fileId  CodingInput → { row: DocReviewRow }                  (write)
 *   POST   /sets/:id/reviews/:rid/report { questions? }    → text/event-stream of ReportEvent; the final report is stored
 *   GET    /sets/:id/reviews/:rid/report                   → { report: ReviewReport | null }
 *   GET    /sets/:id/reviews/:rid/export?format=csv|xlsx   → file download (cells, quotes, pages, coding)
 */

import type { DocCitation } from "./types";

// ---- playbooks ------------------------------------------------------------------------------------------------------

export type PracticeAreaId =
  | "general"
  | "commercial-arbitration"
  | "insolvency-banking"
  | "real-estate"
  | "employment"
  | "criminal"
  | "family"
  | "tax-gst"
  | "ip"
  | "consumer"
  | "motor-accident"
  | "service-constitutional"
  | "competition-regulatory";

export type ColumnKind = "text" | "date" | "amount" | "yes_no" | "choice" | "list" | "party";

export interface ReviewColumn {
  /** Stable within the review: lowercase letters, digits and underscores, ≤ 40 chars. */
  id: string;
  label: string;
  /** What to extract, as an instruction to the reviewer model ("Seat of arbitration as stated in the clause"). */
  prompt: string;
  kind: ColumnKind;
  /** For kind "choice": the allowed answers. */
  choices?: string[];
}

export interface ReviewIssue {
  id: string;
  label: string;
  /** What makes a document relevant to this issue. */
  description: string;
}

export interface ReviewPlaybook {
  id: string;
  area: PracticeAreaId;
  name: string;
  /** One or two sentences: when to use it. */
  description: string;
  /** Statutes and rules the playbook is built around, by short title ("Arbitration and Conciliation Act, 1996"). */
  statutes: string[];
  /** Document types the classifier chooses from (plus "Other"). */
  docTypes: string[];
  issues: ReviewIssue[];
  columns: ReviewColumn[];
  /** Questions run across the whole set for the review report. */
  questions: string[];
}

// ---- reviews --------------------------------------------------------------------------------------------------------

export interface DocReview {
  id: string;
  setId: string;
  name: string;
  /** Playbook the review started from; null for a fully custom review. */
  playbookId: string | null;
  area: PracticeAreaId;
  docTypes: string[];
  issues: ReviewIssue[];
  columns: ReviewColumn[];
  questions: string[];
  /** Bumped when columns, issues or docTypes change; rows reviewed under an older version are pending again. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  counts: ReviewCounts;
}

export interface ReviewCounts {
  files: number;
  /** Fully read and reviewed. */
  done: number;
  /** Reviewed, but only part of the file was read (status "partial"); not included in `done`. */
  partial: number;
  pending: number;
  failed: number;
  /** Rows with a reviewer decision bound to the current row hash. */
  coded: number;
  /** Rows whose decision refers to an older row hash (row re-run since). */
  stale: number;
  privilegeFlags: number;
}

export interface CreateReviewInput {
  name?: string;
  playbookId?: string | null;
  /** Overrides / additions; when no playbook is given these define the review (at least one column or issue). */
  columns?: ReviewColumn[];
  issues?: ReviewIssue[];
  docTypes?: string[];
  questions?: string[];
}

// ---- rows -----------------------------------------------------------------------------------------------------------

/** Where a value comes from in the document. `quoteFound` is checked in code against the file's stored text. */
export interface ReviewEvidence {
  quote: string;
  page: number | null;
  quoteFound: boolean;
}

export type CellStatus =
  | "found" // a value whose quote is found verbatim in the file and (for date/amount/party columns) contains the value
  | "unverified" // a value whose quote was not found, is too short to support it, or does not contain the value
  | "conflict" // different parts of the file give different supported values; see `alternatives` — requires review
  | "not_read" // nothing found in the part that was read, but part of the file was not read (scanned pages, length cap)
  | "not_stated"; // every page was read and the document does not state it

export interface ReviewCell extends ReviewEvidence {
  value: string | null;
  status: CellStatus;
  /** Other supported values found later in the file (status "conflict"); first value stays in `value`. */
  alternatives?: (ReviewEvidence & { value: string })[];
}

export type Relevance = "high" | "medium" | "low" | "none";

export interface IssueAssessment extends ReviewEvidence {
  issueId: string;
  relevance: Relevance;
  reason: string;
}

export type PrivilegeFlag = "none" | "possible" | "likely";

/**
 * Privilege / confidentiality screen (Bharatiya Sakshya Adhiniyam 2023 ss. 132-134, formerly Indian Evidence Act ss.
 * 126-129, and litigation privilege). A suggestion only: an advocate merely copied on a business communication is not
 * privilege by itself, and the flag never decides anything without a reviewer.
 */
export interface PrivilegeScreen extends ReviewEvidence {
  flag: PrivilegeFlag;
  basis: string;
}

export type Coding = "key" | "relevant" | "not_relevant" | "privileged" | "needs_review";

export interface CodingDecision {
  coding: Coding;
  /** Issue ids the reviewer tagged (may differ from the model's). */
  issues: string[];
  note: string | null;
  reviewer: string;
  reviewerName: string | null;
  at: string;
  /** rowHash of the row the reviewer saw; when the row changes the decision is `stale`. */
  rowHash: string;
}

/**
 * pending: not yet reviewed under the current review version and file text (rows never expose results from an older
 * version or text: cells, issues and privilege are empty until re-run); done: every page read; partial: reviewed but
 * part of the file could not be read (see coverage); failed: the review of this file failed (reason in `error`).
 */
export type RowStatus = "pending" | "done" | "partial" | "failed";

export interface DocReviewRow {
  reviewId: string;
  setId: string;
  fileId: string;
  fileName: string;
  pages: number;
  status: RowStatus;
  docType: string | null;
  /** Two or three sentences on what the document is and why it matters; empty until done. */
  summary: string;
  /** Model's 1-5 importance for the matter (5 = likely key document). */
  importance: number | null;
  issues: IssueAssessment[];
  privilege: PrivilegeScreen | null;
  /** Keyed by ReviewColumn.id. */
  cells: Record<string, ReviewCell>;
  /** SHA-256 over (review version, text hash, model output) — what a decision binds to. */
  rowHash: string | null;
  decision: CodingDecision | null;
  /** True when `decision.rowHash !== rowHash`. */
  decisionStale: boolean;
  /**
   * Characters of the file the review read vs its total; read < total means the row covers only part of the file.
   * `unreadPages`: pages with no text (scanned, awaiting OCR) that the review therefore could not read.
   */
  coverage: { read: number; total: number; unreadPages: number[] };
  error: string | null;
  updatedAt: string | null;
}

export interface RowQuery {
  q?: string;
  issue?: string;
  /** Minimum relevance for `issue` (default "low"). */
  minRelevance?: Relevance;
  docType?: string;
  privilege?: PrivilegeFlag;
  coding?: Coding | "uncoded" | "stale";
  status?: RowStatus;
  sort?: "importance" | "name" | "updated";
  offset?: number;
  limit?: number;
}

export interface ReviewFacets {
  docTypes: { value: string; count: number }[];
  issues: { issueId: string; high: number; medium: number; low: number }[];
  privilege: { possible: number; likely: number };
  coding: Partial<Record<Coding | "uncoded" | "stale", number>>;
}

export interface CodingInput {
  coding: Coding | null; // null clears the decision
  issues?: string[];
  note?: string | null;
  /** The rowHash the reviewer looked at; a mismatch is a 409 (row changed since it was shown). */
  rowHash: string;
}

export interface ReviewProgress {
  processed: number;
  failed: number;
  remaining: number;
  errors: { fileId: string; name: string; error: string }[];
}

// ---- report (bulk questions across the set) ------------------------------------------------------------------------

export interface ReportAnswer {
  question: string;
  answer: string;
  citations: DocCitation[];
  unresolved: number[];
  noEvidence: boolean;
}

export interface ReviewReport {
  reviewId: string;
  /** "partial" when any question failed; failed questions are listed, never silently dropped. */
  status: "complete" | "partial";
  answers: ReportAnswer[];
  failed: { index: number; question: string; error: string }[];
  generatedAt: string;
  generatedBy: string;
  /** Files in the set when the report ran. */
  fileCount: number;
}

export type ReportEvent =
  | { type: "report.started"; total: number }
  | { type: "question.started"; index: number; question: string }
  | { type: "question.completed"; index: number; answer: ReportAnswer }
  | { type: "question.failed"; index: number; question: string; error: string }
  | { type: "report.completed"; report: ReviewReport }
  | { type: "report.failed"; error: string };

// ---- shared helpers -------------------------------------------------------------------------------------------------

export const RELEVANCE_RANK: Record<Relevance, number> = { none: 0, low: 1, medium: 2, high: 3 };

export const CODING_LABEL: Record<Coding, string> = {
  key: "Key document",
  relevant: "Relevant",
  not_relevant: "Not relevant",
  privileged: "Privileged",
  needs_review: "Needs review",
};

export const PRACTICE_AREA_LABEL: Record<PracticeAreaId, string> = {
  general: "General litigation",
  "commercial-arbitration": "Commercial disputes & arbitration",
  "insolvency-banking": "Insolvency, banking & recovery",
  "real-estate": "Real estate, land & RERA",
  employment: "Employment & labour",
  criminal: "Criminal",
  family: "Family & matrimonial",
  "tax-gst": "Tax & GST",
  ip: "Intellectual property",
  consumer: "Consumer protection",
  "motor-accident": "Motor accident claims",
  "service-constitutional": "Service & writ matters",
  "competition-regulatory": "Competition & regulatory",
};

export const REVIEW_LIMITS = {
  maxColumns: 25,
  maxIssues: 15,
  maxQuestions: 12,
  maxDocTypes: 30,
  /** Characters of a file the per-file review reads, in page-marked windows; longer files report partial coverage. */
  maxCharsPerFile: 240_000,
} as const;

/** Column ids: lowercase letters, digits and underscores. */
export function isColumnId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(id);
}
