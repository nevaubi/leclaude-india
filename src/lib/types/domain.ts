/**
 * Shared domain model for the platform. Every module persists these shapes
 * through `@/lib/db` collections; keep additions backwards compatible.
 */

import type { Provenance } from "@/lib/integrity/types";

export type ID = string;
export type ISODate = string; // ISO-8601

export type PracticeArea = "Litigation" | "Products Liability" | "Commercial" | "Corporate / M&A" | "Employment" | "Regulatory" | "IP" | "Real Estate";

export interface Person {
  id: ID;
  name: string;
  email?: string;
  title?: string; // e.g. "Partner", "Associate", "Paralegal", "VP Operations"
  organization?: string; // firm or client/company
  role: "attorney" | "paralegal" | "staff" | "client" | "custodian" | "witness" | "expert" | "opposing" | "judge" | "other";
  avatarColor?: string;
  tags?: string[];
}

export interface Matter {
  id: ID;
  slug: string;
  name: string; // "Valsara Textile Park Ltd. v. Meridian Fine Chemicals Ltd."
  shortName: string; // "Valsara v. Meridian"
  caption?: string; // "Arb. Ref. 14/2024 (seat: New Delhi)"
  client: string;
  clientSide: "plaintiff" | "defendant" | "petitioner" | "respondent" | "buyer" | "seller" | "other";
  practiceArea: PracticeArea;
  court?: string;
  jurisdiction?: string;
  judge?: string;
  status: "active" | "on hold" | "closed" | "pre-suit";
  stage?: string; // "Discovery", "Motion practice", "Diligence"
  openedAt: ISODate;
  teamIds: ID[];
  leadAttorneyId?: ID;
  description?: string;
  keyDates?: { label: string; date: ISODate }[];
  tags?: string[];
}

export interface Task {
  id: ID;
  title: string;
  description?: string;
  matterId?: ID;
  assigneeId?: ID;
  createdById?: ID;
  status: "todo" | "in_progress" | "review" | "done";
  priority: "low" | "medium" | "high" | "urgent";
  dueAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
  tags?: string[];
  source?: "manual" | "workflow" | "agent" | "docket";
  links?: { label: string; href: string }[];
}

export interface CalendarEvent {
  id: ID;
  title: string;
  matterId?: ID;
  startsAt: ISODate;
  endsAt?: ISODate;
  allDay?: boolean;
  kind: "deadline" | "hearing" | "deposition" | "meeting" | "filing" | "internal" | "cle" | "other";
  location?: string;
  attendeeIds?: ID[];
  notes?: string;
  ruleSource?: string; // "FRCP 26(f)", "Local Rule 7.1"
}

export interface NewsItem {
  id: ID;
  title: string;
  summary: string;
  source: string; // "Federal Register", "Fourth Circuit", "Firm"
  url?: string;
  publishedAt: ISODate;
  category: "court" | "regulatory" | "legislative" | "industry" | "firm" | "client";
  practiceAreas?: PracticeArea[];
  matterIds?: ID[];
  relevance?: number; // 0-100 AI relevance to firm matters
}

export interface TeamUpdate {
  id: ID;
  authorId: ID;
  body: string;
  matterId?: ID;
  createdAt: ISODate;
  kind: "update" | "win" | "announcement" | "question";
  reactions?: Record<string, number>;
  attachments?: { label: string; href: string }[];
}

// ---------------- E-Discovery ----------------

export type DocType = "Email" | "Memo" | "Report" | "Presentation" | "Spreadsheet" | "Letter" | "Contract" | "Chat" | "Note" | "Image" | "Transcript" | "Other";

export interface CodingDecision {
  responsive?: boolean | null;
  privileged?: boolean | null;
  privilegeBasis?: "attorney-client" | "work-product" | "common-interest" | "joint-defense";
  hot?: boolean;
  confidentiality?: "public" | "confidential" | "highly confidential" | "AEO";
  issues?: string[]; // issue codes
  notes?: string;
  reviewerId?: ID;
  reviewedAt?: ISODate;
}

export interface EDocument {
  id: ID;
  matterId: ID;
  bates: string; // "MFC-0041877"
  batesEnd?: string;
  date: ISODate;
  custodianId: ID;
  custodianName: string;
  type: DocType;
  subject: string;
  from?: string;
  to?: string[];
  cc?: string[];
  text: string; // full extracted text
  pages?: number;
  family?: { parentId?: ID; threadId?: ID; attachmentIds?: ID[] };
  hash?: string;
  aiScore?: number; // 0-100 predicted responsiveness
  aiSummary?: string;
  aiIssues?: string[];
  aiProvenance?: Provenance;
  entities?: { people: string[]; orgs: string[]; places: string[]; chemicals?: string[] };
  coding: CodingDecision;
  isDuplicateOf?: ID;
  nearDuplicateIds?: ID[];
  /** Estimated Jaccard similarity per near-duplicate id (MinHash over word shingles), 0..1. */
  nearDuplicateScores?: Record<ID, number>;
  source?: string; // collection source
  tags?: string[];
}

export interface DepositionQA {
  page: number;
  line: number;
  question: string;
  answer: string;
  objection?: { by: string; basis: string; text?: string };
  exhibit?: string;
  flags?: ("admission" | "contradiction" | "evasive" | "key" | "privilege" | "objection")[];
  note?: string;
}

export interface Deposition {
  id: ID;
  matterId: ID;
  witnessId: ID;
  witnessName: string;
  witnessTitle?: string;
  date: ISODate;
  takenBy: string; // attorney name / side
  defendingBy?: string;
  location?: string;
  volume?: number;
  pages: number;
  transcript: DepositionQA[];
  exhibits?: { id: string; description: string; bates?: string }[];
  aiDigest?: { summary: string; keyAdmissions: string[]; themes: string[]; credibilityNotes?: string[]; followUps?: string[]; provenance?: Provenance };
  status: "scheduled" | "transcribed" | "reviewed";
}

export interface TimelineEvent {
  id: ID;
  matterId: ID;
  date: ISODate;
  dateEnd?: ISODate;
  precision?: "day" | "month" | "year";
  title: string;
  description?: string;
  category: "corporate" | "scientific" | "regulatory" | "communication" | "litigation" | "testimony" | "product" | "other";
  significance: 1 | 2 | 3 | 4 | 5;
  sources: { kind: "document" | "deposition" | "external"; id?: ID; bates?: string; cite?: string; excerpt?: string }[];
  personIds?: ID[];
  disputed?: boolean;
  createdBy: "ai" | "user";
  verified?: boolean;
  provenance?: Provenance;
}

export interface Relationship {
  id: ID;
  matterId: ID;
  fromId: ID;
  toId: ID;
  kind: "reports_to" | "emailed" | "cc" | "meeting" | "same_org" | "supervises" | "retained" | "represents" | "testified_about" | "authored" | "received" | "other";
  weight: number;
  evidence?: { bates?: string; excerpt?: string; docId?: ID }[];
  label?: string;
}

export interface Conflict {
  id: ID;
  matterId: ID;
  title: string;
  kind: "testimony_vs_document" | "testimony_vs_testimony" | "document_vs_document" | "date_inconsistency" | "position_inconsistency";
  severity: "low" | "medium" | "high";
  sides: { label: string; sourceKind: "document" | "deposition"; sourceId: ID; cite: string; excerpt: string }[];
  analysis: string;
  status: "open" | "resolved" | "dismissed";
  createdBy: "ai" | "user";
  provenance?: Provenance;
}

export interface IssueCode {
  id: ID;
  matterId: ID;
  code: string; // "TOX-01"
  label: string;
  description?: string;
  color?: string;
  parentId?: ID;
  count?: number;
}

export interface PrivilegeLogEntry {
  id: ID;
  matterId: ID;
  docId: ID;
  bates: string;
  date: ISODate;
  author: string;
  recipients: string[];
  docType: DocType;
  basis: string;
  description: string; // privilege-safe description
  /** Workflow: draft (generated / first pass) → review (second-level check) → final (served). */
  status: "draft" | "review" | "final";
  /** Description template applied when the entry was drafted (see ediscovery/privilege.ts DESCRIPTION_TEMPLATES). */
  templateId?: string;
}

// ---------------- E-Discovery review workflow (batches, saved searches, layouts, redactions, productions) ----------------

/** Where a document set came from (a saved query or an explicit selection), so it can be re-run or audited. */
export interface DocSetSource {
  kind: "search" | "selection" | "all";
  q?: string;
  view?: string;
  filters?: Record<string, string[]>;
  savedSearchId?: ID;
}

export interface ReviewBatchQcDecision {
  reviewerId: ID;
  at: ISODate;
  /** Coding as the QC reviewer saw it before deciding (first-pass call). */
  firstPass: Pick<CodingDecision, "responsive" | "privileged" | "hot" | "issues" | "reviewerId">;
  /** The QC reviewer's call. */
  qc: Pick<CodingDecision, "responsive" | "privileged" | "hot" | "issues">;
  agree: boolean;
}

export interface ReviewBatch {
  id: ID;
  matterId: ID;
  name: string;
  description?: string;
  docIds: ID[];
  source: DocSetSource;
  assigneeId?: ID;
  priority: "low" | "normal" | "high";
  dueAt?: ISODate;
  status: "open" | "in_progress" | "qc" | "complete";
  /** Percent of the batch sampled for quality control (0 = no QC). */
  qcSamplePercent: number;
  /** Deterministic sample drawn when the batch was created (or when QC started). */
  qcSampleIds: ID[];
  /** Second-pass batches re-review documents another reviewer already coded. */
  secondPass: boolean;
  qcDecisions: Record<ID, ReviewBatchQcDecision>;
  createdBy: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
  completedAt?: ISODate;
}

export interface SavedSearchRecord {
  id: ID;
  matterId: ID;
  name: string;
  description?: string;
  q: string;
  view?: string;
  filters?: Record<string, string[]>;
  sort?: string;
  dir?: "asc" | "desc";
  semantic?: boolean;
  ownerId: ID;
  /** Shared with the matter team (otherwise private to the owner). */
  shared: boolean;
  lastRunCount?: number;
  lastRunAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** A saved review-grid layout (column set, widths, density) per user. */
export interface ReviewLayout {
  id: ID;
  userId: ID;
  matterId?: ID;
  name: string;
  hiddenColumns: string[];
  columnWidths: Record<string, number>;
  density: "compact" | "comfortable";
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type RedactionReason = "privilege" | "pii" | "phi" | "confidential" | "trade-secret" | "non-responsive" | "other";

export interface Redaction {
  id: ID;
  matterId: ID;
  docId: ID;
  /** `text`: a character range in the extracted text; `page`: a rectangle (0..1 normalised) on a page. */
  kind: "text" | "page";
  start?: number;
  end?: number;
  page?: number;
  rect?: { x: number; y: number; w: number; h: number };
  reason: RedactionReason;
  /** Text burned into the box ("REDACTED — PRIVILEGED"). */
  label: string;
  note?: string;
  /** The redacted text, kept so the log can be reviewed before production (never exported). */
  quote?: string;
  createdBy: ID;
  createdAt: ISODate;
}

export interface ProductionQcReport {
  ranAt: ISODate;
  privilegedInSet: { docId: ID; bates: string }[];
  missingFamily: { docId: ID; bates: string; missingId: ID; missingBates: string }[];
  unredactedPii: { docId: ID; bates: string; pattern: string; sample: string }[];
  uncoded: { docId: ID; bates: string }[];
  redactedDocs: number;
  ok: boolean;
}

export interface ProductionSet {
  id: ID;
  matterId: ID;
  name: string;
  /** Volume label written into the load files ("VOL001"). */
  volume: string;
  status: "draft" | "qc" | "final";
  prefix: string;
  padding: number;
  startNumber: number;
  /** Confidentiality stamp burned into every page (empty = none). */
  stampText: string;
  /** Frozen document set, in production order. */
  docIds: ID[];
  /** Production Bates assignment per document. */
  bates: Record<ID, { begin: string; end: string; pages: number }>;
  source: DocSetSource;
  qc?: ProductionQcReport;
  createdBy: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
  finalizedAt?: ISODate;
  notes?: string;
}

export interface SearchTermReportRow {
  term: string;
  /** Total hits (occurrences) across matching documents. */
  hits: number;
  uniqueDocs: number;
  /** Documents including family members of the hits. */
  withFamilies: number;
  families: number;
  warnings?: string[];
}

export interface SearchTermReport {
  id?: ID;
  matterId: ID;
  ranAt: ISODate;
  rows: SearchTermReportRow[];
  totalUnique: number;
  totalWithFamilies: number;
  corpus: number;
}

// ---------------- Workflows ----------------

export type WorkflowNodeType =
  | "trigger.manual" | "trigger.schedule" | "trigger.document_added" | "trigger.docket_update" | "trigger.email"
  | "ai.prompt" | "ai.extract" | "ai.classify" | "ai.summarize" | "ai.draft" | "ai.review" | "ai.research"
  | "data.search_library" | "data.search_ediscovery" | "data.fetch_url" | "data.legal_search"
  | "ai.verify" | "data.dedupe"
  | "logic.branch" | "logic.loop" | "logic.merge" | "logic.approval" | "logic.delay" | "logic.review"
  | "action.create_task" | "action.create_event" | "action.save_document" | "action.notify" | "action.export" | "action.update_coding"
  | "intel.fetch" | "intel.extract" | "intel.index" | "intel.entities" | "intel.analyze" | "intel.verify" | "intel.publish"
  | "review.auto" | "data.query" | "output.file" | "logic.schedule_after" | "ai.route" | "ai.agent";

export interface WorkflowNode {
  id: ID;
  type: WorkflowNodeType;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkflowEdge { id: ID; source: ID; target: ID; sourceHandle?: string; targetHandle?: string; label?: string }

export type WorkflowCategory = "intake" | "discovery" | "drafting" | "research" | "compliance" | "transactional" | "operations" | "automation";

/** Field of a workflow's one-page front end (the manual-start form). Values arrive as `inputs.<key>`. */
export interface WorkflowFrontendField {
  key: string;
  label: string;
  type:
    | "file"
    | "files"
    | "text"
    | "textarea"
    | "select"
    | "multiselect"
    | "toggle"
    | "date"
    | "number"
    | "matter"
    | "person"
    | "library-folder"
    | "bates-prefix"
    | "output-format"
    | "label";
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: string[];
  /** Accepted file extensions / MIME types for file fields. */
  accept?: string[];
  default?: unknown;
  /** Group heading rendered above this field. */
  group?: string;
}

/** The per-template front end: what a user fills in to start the workflow, and what happens with the output. */
export interface WorkflowFrontend {
  title: string;
  intro?: string;
  fields: WorkflowFrontendField[];
  submitLabel?: string;
  output?: {
    formats?: ("docx" | "xlsx" | "pdf" | "csv" | "md" | "pptx")[];
    defaultFormat?: "docx" | "xlsx" | "pdf" | "csv" | "md" | "pptx";
    /** Template for the output label, e.g. "Privilege log — {{matter.shortName}} — {{now | date:date}}". */
    defaultLabel?: string;
    libraryFolderId?: ID;
    notifyPeopleIds?: ID[];
  };
  after?: {
    /** Workflows to start with this run's outputs as inputs. */
    triggerWorkflowIds?: ID[];
    createTask?: { title: string; assigneeId?: ID; dueRule?: string };
  };
}

export interface Workflow {
  id: ID;
  name: string;
  description?: string;
  category: WorkflowCategory;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  inputs?: { key: string; label: string; type: "text" | "textarea" | "file" | "matter" | "select" | "number" | "date"; required?: boolean; options?: string[]; placeholder?: string }[];
  /** One-page start form and output settings (templates ship with one; users customize it). */
  frontend?: WorkflowFrontend;
  status: "draft" | "active" | "archived";
  ownerId?: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
  isTemplate?: boolean;
  /** System workflows power the platform's own background automation (scheduled, shown under Automation). */
  system?: boolean;
  runsCount?: number;
  lastRunAt?: ISODate;
  tags?: string[];
}

/**
 * Terminal states of a workflow run (constitution §14). Identical to
 * `RunTerminalState` in src/lib/ai/providers/types.ts; the workflows module
 * asserts the two unions stay equal at compile time.
 */
export type WorkflowRunTerminalStatus = "succeeded" | "partial" | "budget_exhausted" | "verification_failed" | "cancelled" | "failed";
export type WorkflowRunStatus = "queued" | "running" | "waiting_approval" | WorkflowRunTerminalStatus;

/** Distinct failure kinds recorded on steps and runs (constitution §47). */
export type WorkflowFailureKind =
  | "no_result" | "provider_outage" | "rate_limit" | "timeout" | "cancelled" | "auth" | "malformed_output" | "incomplete_model_result"
  | "tool_failure" | "verification_failed" | "budget_exhausted" | "not_configured" | "step_error" | "interrupted" | "unknown";

/** Why a step was skipped: only failure-driven skips make a run `partial`. */
export type WorkflowSkipReason = "inactive_path" | "upstream_failed" | "run_failed" | "run_cancelled" | "budget_exhausted" | "trust_gate" | "trust_gate_rejected" | "approval_rejected" | "interrupted";

/** Per-step cost and latency telemetry (constitution §36, §42). Tokens come from the executor's model calls; cache counts when the provider exposes them. */
export interface WorkflowStepTelemetry {
  input: number;
  output: number;
  total: number;
  cacheRead?: number;
  cacheWrite?: number;
  calls: number;
  costUsd: number;
  latencyMs?: number;
  provider?: string;
  model?: string;
}

export interface WorkflowRunStep {
  nodeId: ID;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "waiting_approval" | "cancelled";
  startedAt?: ISODate;
  finishedAt?: ISODate;
  input?: unknown;
  output?: unknown;
  error?: string;
  logs?: string[];
  tokens?: number;
  /** Wall-clock time of the last attempt (startedAt → finishedAt). */
  durationMs?: number;
  /** 1-based attempt number of the last execution. */
  attempt?: number;
  /** Idempotency key of the last attempt: `<runId>:<nodeId>[:i<iteration>]:<attempt>`. */
  stepKey?: string;
  failureKind?: WorkflowFailureKind;
  skipReason?: WorkflowSkipReason;
  telemetry?: WorkflowStepTelemetry;
}

export interface WorkflowRun {
  id: ID;
  workflowId: ID;
  status: WorkflowRunStatus;
  inputs: Record<string, unknown>;
  steps: WorkflowRunStep[];
  outputs?: Record<string, unknown>;
  startedAt: ISODate;
  finishedAt?: ISODate;
  /** Same instant as `finishedAt`; set when the run reaches a terminal state. */
  endedAt?: ISODate;
  triggeredBy: "manual" | "schedule" | "event" | "api";
  matterId?: ID;
}

// ---------------- Office & Library ----------------

export type OfficeKind = "word" | "sheet" | "slides" | "pdf";

export interface OfficeDocument {
  id: ID;
  kind: OfficeKind;
  title: string;
  matterId?: ID;
  folderId?: ID;
  /** Editor-specific content model (TipTap JSON, workbook JSON, deck JSON, PDF ops + base64 reference). */
  content: unknown;
  contentVersion: number;
  createdAt: ISODate;
  updatedAt: ISODate;
  createdById?: ID;
  updatedById?: ID;
  templateId?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  /** Byte size of the serialized content, for the library view. */
  size?: number;
}

export interface OfficeVersion {
  id: ID;
  docId: ID;
  version: number;
  label?: string; // "Before partner review"
  summary?: string; // "Agent edit: …"
  authorId?: ID;
  authorName?: string;
  createdAt: ISODate;
  content: unknown;
  changedFields?: number;
}

export interface OfficeComment {
  id: ID;
  docId: ID;
  anchor: string; // paragraph id / cell ref / slide id / page+rect
  quote?: string;
  body: string;
  authorId?: ID;
  authorName: string;
  createdAt: ISODate;
  resolved?: boolean;
  replies?: { id: ID; body: string; authorName: string; createdAt: ISODate }[];
  source?: "user" | "agent";
}

export type LibraryItemType = "folder" | "docx" | "xlsx" | "pptx" | "pdf" | "template" | "clause" | "link" | "note";

export interface LibraryItem {
  id: ID;
  parentId: ID | null; // null = root
  name: string;
  type: LibraryItemType;
  matterId?: ID;
  officeDocId?: ID; // for editable office documents
  description?: string;
  size?: number;
  tags?: string[];
  ownerId?: ID;
  sharedWith?: ("firm" | "matter-team" | "private")[];
  createdAt: ISODate;
  updatedAt: ISODate;
  starred?: boolean;
  content?: string; // for notes/clauses/text
  url?: string; // for links
  practiceArea?: PracticeArea;
  version?: number;
  status?: "draft" | "approved" | "archived";
}
