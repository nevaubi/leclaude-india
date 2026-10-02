/**
 * Litigation desk contracts (client-safe): tracked case identifiers per matter, manual hearings, official listings,
 * orders → action items (with verbatim quotes checked in code), hearing briefs and the diary.
 *
 * Invariants
 * - Listings and orders are matched to a matter only by exact identifiers (normalized case number, diary number; NCLT
 *   numbers bench-qualified); nothing is matched by party name or by similarity. CNRs are kept for reference only:
 *   cause lists and order metadata do not carry them, so they are reported as not checkable, never as "not listed".
 *   Unparsed cause-list entries never reach a matter.
 * - Cause lists are published by the courts and are not authoritative online: every listing carries when it was
 *   published / fetched and the source document it was read from.
 * - Action items extracted from an order are bound to the order's SHA-256, version and the hash of the text read; a
 *   deadline is computed only when the item's own verified quote states the period or the date, and nothing becomes a
 *   task until a reviewer confirms it.
 */
import type { CauseListEntry, MatterCaseIdentifier, SourceDocument } from "@/modules/official/types";

export type { CauseListEntry, MatterCaseIdentifier } from "@/modules/official/types";

export type TrackedIdentifierKind = MatterCaseIdentifier["kind"];

/** A tracked identifier: the normalized value used for exact matching plus the form the user typed / the court printed. */
export interface TrackedIdentifier extends MatterCaseIdentifier {
  printed: string;
}

/**
 * Stored per matter in the `matter_tracking` collection (id = matterId). Never inside `matter.india`. Advocate names
 * are watched per user in the Diary, not per matter. `updatedAt` is the version a PUT must name (expectedUpdatedAt).
 */
export interface MatterTracking {
  id: string;
  matterId: string;
  identifiers: TrackedIdentifier[];
  updatedAt: string;
  updatedBy: string;
}

/** A hearing entered by hand (for courts whose lists are not parsed). Stored in `matter_hearings`. */
export interface ManualHearing {
  id: string;
  matterId: string;
  /** ISO date of the hearing. */
  date: string;
  /** "10:30" (24h, IST) when known. */
  time?: string;
  court?: string;
  courtNo?: string;
  itemNo?: string;
  bench?: string;
  purpose?: string;
  note?: string;
  createdAt: string;
  createdBy: string;
}

export interface ManualHearingInput {
  date?: unknown;
  time?: unknown;
  court?: unknown;
  courtNo?: unknown;
  itemNo?: unknown;
  bench?: unknown;
  purpose?: unknown;
  note?: unknown;
}

/** State of the official corpus as seen by a desk surface. */
export type OfficialState = "ok" | "not_configured" | "not_available" | "error";

/** A listing for a matter, exactly as matched by the official-sources facade. */
export interface MatterListing {
  /** Cause-list entry id (stable per entry). */
  id: string;
  matterId: string;
  entry: CauseListEntry;
  matchedOn: MatterCaseIdentifier;
  /** The published cause list the entry was read from (null when its record could not be read). */
  source: ListingSource | null;
}

export interface ListingSource {
  url: string;
  title: string;
}

export interface ListingsResponse {
  from: string;
  to: string;
  state: OfficialState;
  message?: string;
  /** No identifier the official sources can match is tracked, so nothing was looked up. */
  untracked?: boolean;
  /** Tracked identifiers kept for reference but never looked up (CNRs; NCLT numbers without a bench code). */
  unmatchable: TrackedIdentifier[];
  listings: MatterListing[];
  /** Tracked forums whose cause lists are not parsed (manual hearings apply there). */
  uncoveredForums: string[];
}

/** An order / judgment found for a matter's identifiers, plus the latest action extraction bound to it (if any). */
export interface MatterOrder {
  document: SourceDocument;
  actions: OrderActionSetSummary | null;
}

export interface OrdersResponse {
  state: OfficialState;
  message?: string;
  /** No identifier the official sources can match is tracked, so nothing was looked up. */
  untracked?: boolean;
  /** Tracked identifiers kept for reference but never looked up (see ListingsResponse). */
  unmatchable: TrackedIdentifier[];
  orders: MatterOrder[];
}

// ---- order actions ------------------------------------------------------------------------------------------------

/** Where a verbatim quote was found in the order text (chunk pages; null when not found). */
export interface QuoteCheck {
  /** The quote occurs in the order text (after whitespace / quote-mark normalization). */
  quoteFound: boolean;
  /** The page the model gave lies within the pages where the quote was found. */
  pageVerified: boolean;
  /** Page range of the text where the quote was found. */
  foundPages: { start: number | null; end: number | null } | null;
}

export type DeadlineBasis = "period" | "stated_date";

/** A deadline computed deterministically from what the order states. */
export interface ComputedDeadline {
  date: string;
  basis: DeadlineBasis;
  /** Order date the period runs from (period basis only). */
  from?: string;
  /** Verbatim period / date text from the order. */
  text: string;
  /** How the date was computed, in words. */
  rule: string;
}

/** Why no deadline was computed (shown, never hidden). */
export type DeadlineGap =
  | "no_period" // the order states no period or date for this task
  | "period_not_in_text" // the period or date the model gave is not in the item's own quote
  | "runs_from_event" // the period runs from receipt / service / another event whose date is unknown
  | "unparsed_period" // a period is stated but could not be parsed deterministically
  | "no_order_date" // the publisher did not print the order date
  | "quote_not_found"; // the item's quote is not in the order text, so nothing is computed for it

export interface OrderActionItem {
  id: string;
  kind: "direction" | "next_date" | "compliance";
  /** Short statement of the direction / task (model-written; checked only through its quote). */
  text: string;
  /** Party who must act, as the order names it (compliance only). */
  party: string | null;
  quote: string;
  /** Page the model cited. */
  page: number | null;
  check: QuoteCheck;
  /** Verbatim period text ("within four weeks from today"), when the order states one. */
  period: string | null;
  /** Verbatim date text ("15.10.2026"), when the order states one. */
  statedDate: string | null;
  deadline: ComputedDeadline | null;
  deadlineGap: DeadlineGap | null;
  /** True when the item cannot be relied on as extracted (quote not found or page mismatch). */
  flagged: boolean;
}

export interface OrderActionReviewDecision {
  itemId: string;
  create: boolean;
  /** Due date the reviewer confirmed (may differ from the computed deadline); null for none. */
  dueAt: string | null;
  taskId?: string;
}

export interface OrderActionSet {
  id: string;
  matterId: string;
  documentId: string;
  /** Hash and version of the order file, and SHA-256 of the extracted text the items were read from. */
  documentSha256: string | null;
  documentVersion: number;
  /** Absent on sets extracted before text binding: those must be extracted again before review. */
  textSha256?: string;
  documentTitle: string;
  documentUrl: string;
  orderDate: string | null;
  /** Characters of order text read, and whether the whole order was read. */
  textChars: number;
  coverage: "complete" | "partial";
  items: OrderActionItem[];
  status: "pending_review" | "reviewed";
  createdAt: string;
  createdBy: string;
  review?: { reviewerId: string; reviewedAt: string; decisions: OrderActionReviewDecision[] };
}

export interface OrderActionSetSummary {
  id: string;
  status: OrderActionSet["status"];
  documentSha256: string | null;
  createdAt: string;
  items: number;
  flagged: number;
  /** The order changed after extraction (file hash or version differs; the text hash is re-checked at review). */
  stale: boolean;
}

// ---- the matter's latest order (exact selection) --------------------------------------------------------------------

/**
 * Outcome of choosing "the latest order" of a matter in code. Only `found` carries an order; every other state says
 * exactly why none was chosen (never another case's order in its place):
 * - not_found: the matter's identifiers were looked up and no order or judgment carries one of them;
 * - ambiguous: more than one order shares the latest date, or the exact matches carry no date (name one with orderRef);
 * - not_linked: the order named by orderRef is not among the matter's exact matches;
 * - untracked: the matter tracks no case or diary number the official sources can match;
 * - not_tracked: the case number given is not one of the matter's tracked identifiers;
 * - unparsed_identifier: the case number given does not normalize (nothing was looked up);
 * - not_indexed: the chosen order's text has not been extracted yet;
 * - not_available: the official-sources corpus is not configured or not wired on this deployment.
 */
export type LatestOrderStatus = "found" | "not_found" | "ambiguous" | "not_linked" | "untracked" | "not_tracked" | "unparsed_identifier" | "not_indexed" | "not_available";

export interface LatestOrderCandidate {
  id: string;
  /** Stable src:// reference of the document. */
  ref: string;
  title: string;
  date: string | null;
  kind: string;
  url: string;
}

export interface LatestOrderResult {
  status: LatestOrderStatus;
  /** One sentence for the person running it (what was checked, what was or was not found). */
  message: string;
  order: (LatestOrderCandidate & { fileUrl: string | null; sha256: string | null; version: number; sourceId: string; ocr: boolean; ocrPages: number[] }) | null;
  /** The tracked identifier the chosen order carries (exact match). */
  matchedOn: TrackedIdentifier | null;
  /** Printed forms of the identifiers that were looked up. */
  identifiers: string[];
  /** Exact matches, newest first (at most 10); for `ambiguous`, the orders to choose from. */
  candidates: LatestOrderCandidate[];
  /** Number of exact matches (orders and judgments). */
  matches: number;
  /** Order text with [Page N] markers ("" unless found). */
  text: string;
  /** False when the read stopped at its character bound before the end of the order. */
  complete: boolean;
  chars: number;
  /** SHA-256 of the text read (pages and chunk text), null unless found. */
  textSha256: string | null;
}

// ---- hearing brief ------------------------------------------------------------------------------------------------

/** Evidence states kept apart (constitution §23): found by a search, read in full, or supplied from the matter. */
export type BriefSourceState = "supplied" | "read" | "found" | "unresolved";

export interface BriefSource {
  ref: string;
  title: string;
  url: string | null;
  state: BriefSourceState;
}

export interface BriefClaim {
  section: "summary" | "points" | "authorities" | "questions";
  text: string;
  /** Refs the claim relies on (all in `sources` when resolved). */
  sources: string[];
  /** source_linked: every ref resolved to a supplied or read source; partial: some resolved; unsupported: none. */
  status: "source_linked" | "partial" | "unsupported";
}

export interface HearingBrief {
  id: string;
  matterId: string;
  version: number;
  /** SHA-256 of `markdown` (the brief is bound to this hash; any edit is a new version). */
  hash: string;
  listingId: string | null;
  listingDate: string | null;
  markdown: string;
  claims: BriefClaim[];
  sources: BriefSource[];
  /**
   * succeeded: every section produced from fully checked inputs; partial: the research step failed or hit its time
   * budget, or cause lists / orders could not be checked or an order's text could not be read (the notes say which).
   */
  status: "succeeded" | "partial";
  notes: string[];
  createdAt: string;
  createdBy: string;
}

export type BriefStreamEvent =
  | { type: "stage"; stage: "context" | "orders" | "research" | "verify" | "saved"; label: string }
  | { type: "tool"; name: string; label: string; ok?: boolean }
  | { type: "brief"; brief: HearingBrief }
  | { type: "error"; message: string; code?: string };

// ---- diary --------------------------------------------------------------------------------------------------------

export type DiaryEntry =
  | { kind: "listing"; id: string; matterId: string; matterName: string; date: string; entry: CauseListEntry; matchedOn: MatterCaseIdentifier; source: ListingSource | null; /** The tracked identifier as the user entered it. */ printed?: string }
  | { kind: "manual"; id: string; matterId: string; matterName: string; date: string; hearing: ManualHearing }
  | { kind: "particulars"; id: string; matterId: string; matterName: string; date: string; purpose?: string; courtHall?: string; item?: number };

export interface DiaryResponse {
  from: string;
  to: string;
  /** Matters the principal can see (open ones) and how many carry tracked identifiers. */
  matters: number;
  tracked: number;
  entries: DiaryEntry[];
  official: { state: OfficialState; message?: string; uncoveredForums: string[] };
}

export interface AdvocateMatches {
  name: string;
  state: OfficialState;
  message?: string;
  entries: CauseListEntry[];
}

export interface AdvocateListsResponse {
  names: string[];
  from: string;
  to: string;
  results: AdvocateMatches[];
}
