/**
 * Client-safe types for the e-discovery analysis module (depositions,
 * cross-analysis, chronology, people graph, conflicts). No server imports.
 */
import type { Conflict, Deposition, DepositionQA, Relationship, TimelineEvent } from "@/lib/types/domain";
import type { Provenance } from "@/lib/integrity/types";

/** Prop contract shared by the five analysis tabs (fixed by review-page.tsx). */
export interface AnalysisTabProps {
  matterId: string;
  onOpenDocument?: (docId: string) => void;
}

export type QAFlag = NonNullable<DepositionQA["flags"]>[number];
export const QA_FLAGS: { id: QAFlag; label: string; hint: string }[] = [
  { id: "admission", label: "Admission", hint: "Concession useful to our side or damaging to the witness" },
  { id: "contradiction", label: "Contradiction", hint: "Inconsistent with a document or other testimony" },
  { id: "evasive", label: "Evasive", hint: "Non-responsive or memory failure on a key point" },
  { id: "key", label: "Key", hint: "Important testimony for motions or trial" },
  { id: "privilege", label: "Privilege", hint: "Instruction not to answer / privilege assertion" },
];

export const OBJECTION_BASES = ["form", "foundation", "speculation", "privilege", "asked-and-answered", "compound", "relevance", "argumentative", "mischaracterizes", "hearsay"] as const;
export type ObjectionBasis = (typeof OBJECTION_BASES)[number];

/** Deposition list row (transcript omitted for the list endpoint). */
export interface DepositionSummary extends Omit<Deposition, "transcript"> {
  qaCount: number;
  flagCounts: Record<QAFlag, number>;
  objectionCount: number;
  exhibitCount: number;
  designationCount: number;
  hasDigest: boolean;
}

/** Full-text hit across transcripts. */
export interface TranscriptHit {
  depositionId: string;
  witnessName: string;
  index: number; // index into transcript[]
  page: number;
  line: number;
  field: "question" | "answer" | "objection" | "note";
  snippet: string;
  score: number;
}

/** A page:line designation range on a deposition. */
export interface Designation {
  id: string;
  matterId: string;
  depositionId: string;
  startPage: number;
  startLine: number;
  endPage: number;
  endLine: number;
  purpose: "affirmative" | "counter" | "impeachment" | "objection";
  note?: string;
  /** For counter-designations: the designation this one answers. */
  counterTo?: string;
  /** Objection lodged against the designation (by the other side), with the court's ruling when entered. */
  objection?: { basis: string; note?: string; ruling?: "pending" | "sustained" | "overruled" };
  /** Party offering the designation. */
  party?: "plaintiff" | "defendant";
  createdAt: string;
  createdBy: string;
}

export type ObjectionRuling = "sustained" | "overruled" | "pending";
export const OBJECTION_RULINGS: { id: ObjectionRuling; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "sustained", label: "Sustained" },
  { id: "overruled", label: "Overruled" },
];

/** A court ruling on an objection, keyed by deposition and Q/A index (module-private store). */
export interface ObjectionRulingRecord {
  id: string; // `${depositionId}:${index}`
  matterId: string;
  depositionId: string;
  index: number;
  ruling: ObjectionRuling;
  note?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ObjectionSummary {
  total: number;
  byBasis: { basis: string; count: number }[];
  byAttorney: { attorney: string; count: number }[];
  /** Counts of rulings entered from the Objections panel; everything else is pending. */
  rulings: { sustained: number; overruled: number; pending: number };
}

export interface CrossExcerpt {
  kind: "deposition" | "document";
  id: string; // deposition id or edoc id
  label: string; // witness name or subject
  cite: string; // "Voss 84:12" or Bates
  date?: string;
  text: string;
  score: number;
  index?: number; // qa index for deposition excerpts
  flags?: QAFlag[];
}

export interface CrossAnalysisResponse {
  topic: string;
  witnessId?: string;
  testimony: CrossExcerpt[];
  documents: CrossExcerpt[];
  otherTestimony: CrossExcerpt[];
  conflicts: Conflict[];
  aiConfigured: boolean;
}

export interface FactMatrix {
  id: string;
  matterId: string;
  topic: string;
  createdAt: string;
  createdBy: "ai" | "user";
  topics: string[];
  sources: { id: string; kind: "document" | "deposition"; label: string; cite: string }[];
  cells: { topic: string; sourceId: string; position: string; cite: string; stance: "supports" | "contradicts" | "neutral" | "silent" }[];
  /** Generation record: verification status and the cites that did not resolve against the record. */
  provenance?: Provenance;
}

export type TimelineCategory = TimelineEvent["category"];
export const TIMELINE_CATEGORIES: { id: TimelineCategory; label: string; color: string }[] = [
  { id: "scientific", label: "Scientific", color: "chart-1" },
  { id: "regulatory", label: "Regulatory", color: "chart-2" },
  { id: "corporate", label: "Corporate", color: "chart-3" },
  { id: "communication", label: "Communication", color: "chart-4" },
  { id: "product", label: "Product", color: "chart-5" },
  { id: "litigation", label: "Litigation", color: "primary" },
  { id: "testimony", label: "Testimony", color: "info" },
  { id: "other", label: "Other", color: "muted" },
];

export interface TimelineFilters {
  categories?: TimelineCategory[];
  personId?: string;
  minSignificance?: number;
  from?: string;
  to?: string;
  sourceKind?: "document" | "deposition" | "external";
  q?: string;
  disputedOnly?: boolean;
  unverifiedOnly?: boolean;
}

export type TimelineEventInput = Omit<TimelineEvent, "id" | "matterId" | "createdBy"> & { id?: string; createdBy?: TimelineEvent["createdBy"] };

export interface GraphNode {
  id: string;
  label: string;
  kind: "person" | "org";
  role?: string;
  organization?: string;
  title?: string;
  docCount: number; // documents authored or received
  authored: number;
  received: number;
  depositions: number;
  /** Q/A pairs across the matter's transcripts in which this person testified or is named. */
  testimony?: number;
  cluster: string; // organization key
  color: string; // token name
  degree: number;
}

/** One piece of evidence behind an edge; `date`, `kind`, `cite` and `depositionId` are resolved server-side from the Bates / page:line. */
export interface GraphEvidence {
  bates?: string;
  docId?: string;
  excerpt?: string;
  kind?: "document" | "deposition";
  date?: string;
  /** Witness page:line when the evidence is testimony ("Voss 43:02"). */
  cite?: string;
  depositionId?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: Relationship["kind"];
  weight: number;
  label?: string;
  evidence: GraphEvidence[];
  /** Earliest / latest dated evidence, when any evidence carries a date. */
  firstDate?: string;
  lastDate?: string;
}

export interface GraphOrg {
  id: string;
  label: string;
  memberIds: string[];
  docCount: number;
  testimony: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: { id: string; label: string; color: string; size: number }[];
  /** Organizations in the matter with their members (derived from Person.organization; not invented edges). */
  orgs?: GraphOrg[];
}

export interface PersonDetail {
  person: { id: string; name: string; title?: string; organization?: string; role: string; email?: string };
  authored: { id: string; bates: string; date: string; subject: string; type: string }[];
  received: { id: string; bates: string; date: string; subject: string; type: string }[];
  counts: { authored: number; received: number; cc: number; mentioned: number };
  depositions: { id: string; date: string; witnessName: string; pages: number; status: string; mentions: number }[];
  timeline: { id: string; date: string; title: string; category: string; significance: number }[];
  relationships: { id: string; otherId: string; otherName: string; kind: string; direction: "out" | "in"; weight: number; label?: string; evidence: { bates?: string; docId?: string; excerpt?: string }[] }[];
  conflicts: { id: string; title: string; severity: string; status: string }[];
}

export interface KnowledgeMap {
  id: string;
  matterId: string;
  topic: string;
  createdAt: string;
  entries: { personId?: string; personName: string; knew: string; firstKnownDate: string; confidence: "high" | "medium" | "low"; cites: { cite: string; sourceKind: "document" | "deposition"; sourceId?: string }[] }[];
  narrative: string;
  provenance?: Provenance;
  /** An earlier map on the same topic this one repeats. */
  duplicateOf?: string;
}

export interface ConflictNote {
  id: string;
  conflictId: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface ConflictRow extends Conflict {
  witnessNames: string[];
  noteCount: number;
  updatedAt?: string;
}

export interface AnalysisOverview {
  matterId: string;
  aiConfigured: boolean;
  depositions: number;
  transcribed: number;
  events: number;
  relationships: number;
  conflicts: { open: number; resolved: number; dismissed: number };
}

export const CONFLICT_KINDS: { id: Conflict["kind"]; label: string }[] = [
  { id: "testimony_vs_document", label: "Testimony vs. document" },
  { id: "testimony_vs_testimony", label: "Testimony vs. testimony" },
  { id: "document_vs_document", label: "Document vs. document" },
  { id: "date_inconsistency", label: "Date inconsistency" },
  { id: "position_inconsistency", label: "Position inconsistency" },
];

export function formatPageLine(page: number, line: number) {
  return `${page}:${String(line).padStart(2, "0")}`;
}

export function formatRange(d: Pick<Designation, "startPage" | "startLine" | "endPage" | "endLine">) {
  return `${formatPageLine(d.startPage, d.startLine)}–${formatPageLine(d.endPage, d.endLine)}`;
}

// ---------------------------------------------------------------------------
// Phase 3: transcript import, cross references, stories, intelligence panels
// ---------------------------------------------------------------------------

/** "indian": deposition sheets with chief-examination (often by affidavit), cross- and re-examination segments. */
export type TranscriptFormat = "page-line" | "page-numbered" | "loose" | "indian";

export interface ParseIssue {
  /** Where the issue was seen (page:line when known, otherwise the raw line number). */
  at: string;
  kind: "unnumbered" | "out-of-order" | "line-overflow" | "answer-without-question" | "unknown-speaker" | "no-page-markers" | "orphan-objection" | "empty";
  message: string;
  /** Raw source line for the preview. */
  sample?: string;
}

export interface ParsedTranscript {
  format: TranscriptFormat;
  transcript: DepositionQA[];
  pages: number;
  firstPage: number;
  /** 0..1 — how much of the record carried explicit page:line numbering and parsed cleanly. */
  confidence: number;
  issues: ParseIssue[];
  speakers: { label: string; count: number; role: "examiner" | "defender" | "witness" | "reporter" | "other" }[];
  exhibits: { id: string; description: string; bates?: string }[];
  meta: { witnessName?: string; date?: string; takenBy?: string; defendingBy?: string; volume?: number; caseCaption?: string };
  stats: { questions: number; answers: number; objections: number; colloquy: number; rawLines: number; numberedLines: number };
}

/** Record of an import (module-private collection `ediscovery_transcript_imports`). */
export interface TranscriptImportRecord {
  id: string;
  matterId: string;
  depositionId: string;
  sourceName?: string;
  sourceKind: "txt" | "ptx" | "docx" | "paste";
  format: TranscriptFormat;
  confidence: number;
  issues: ParseIssue[];
  qaCount: number;
  pages: number;
  importedAt: string;
  importedBy: string;
}

/** A document referenced in testimony: by Bates, by exhibit number, or by a distinctive subject match. */
export interface CrossReference {
  index: number;
  page: number;
  line: number;
  kind: "bates" | "exhibit" | "subject" | "date";
  docId?: string;
  bates?: string;
  label: string;
  /** What in the testimony triggered the match. */
  match: string;
  confidence: number;
}

export type StoryEvidence =
  | { kind: "document"; docId?: string; bates: string; excerpt?: string }
  | { kind: "testimony"; depositionId: string; witness?: string; page: number; line: number; endPage?: number; endLine?: number; excerpt?: string }
  | { kind: "intel"; docId: string; title?: string; url?: string; excerpt?: string }
  | { kind: "event"; eventId: string; title?: string };

export interface StoryFact {
  id: string;
  order: number;
  date: string; // ISO date
  dateEnd?: string;
  precision?: "day" | "month" | "year";
  text: string;
  evidence: StoryEvidence[];
  confidence: number; // 0..1
  disputed?: boolean;
  /** Where the fact came from when it was built rather than typed. */
  origin?: "timeline" | "testimony" | "intel" | "user" | "ai";
  originId?: string;
  personIds?: string[];
  tags?: string[];
  verified?: boolean;
}

export interface Story {
  id: string;
  matterId: string;
  title: string;
  theme?: string;
  facts: StoryFact[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** Latest AI narrative draft, with its provenance (verified, cite-checked, gated). */
  narrative?: { text: string; provenance?: unknown; generatedAt: string };
  meta?: { seeded?: boolean; [k: string]: unknown };
}

export interface StorySummary extends Omit<Story, "facts" | "narrative"> {
  factCount: number;
  disputed: number;
  unverified: number;
  from?: string;
  to?: string;
  hasNarrative: boolean;
}

export interface StoryCiteReport {
  storyId: string;
  checked: number;
  resolved: number;
  unresolved: { factId: string; cite: string; reason: string }[];
}

/** Intelligence for a matter, aggregated for the analysis views (empty states when sources are off). */
export interface MatterIntelPanel {
  matterId: string;
  available: boolean;
  sources: { enabled: number; total: number; disabled: string[] };
  judge: null | { id: string; name: string; court?: string; documents: number; tendencies: { motion: string; label: string; total: number; grantRate: number | null }[]; recent: { id: string; title: string; date?: string; kind: string; url?: string }[]; href: string };
  docket: { id: string; title: string; date?: string; kind: string; docketNumber?: string; url?: string; confidence: number; flagged: boolean }[];
  regulatory: { at: string; title: string; kind?: string; confidence: number; docIds: string[] }[];
  mdl: null | { id: string; name: string; number?: string; court?: string; status?: string; detail?: string; updatedAt?: string; href: string; flagged: boolean };
  chronology: { entries: number; merged: number; alreadyOnTimeline: number };
  generatedAt: string;
}

export function formatCite(e: StoryEvidence): string {
  if (e.kind === "document") return e.bates;
  if (e.kind === "testimony") return `${e.witness ? `${e.witness.split(" ").pop()} ` : ""}${formatPageLine(e.page, e.line)}${e.endPage != null && e.endLine != null && (e.endPage !== e.page || e.endLine !== e.line) ? `–${formatPageLine(e.endPage, e.endLine)}` : ""}`;
  if (e.kind === "intel") return e.title ?? e.docId;
  return e.title ?? e.eventId;
}
