/**
 * Litigation desk contracts (client-safe): tracked case identifiers per matter, manual hearings, official listings,
 * orders → action items (with verbatim quotes checked in code), hearing briefs and the diary.
 *
 * Invariants
 * - Listings and orders are matched to a matter only by exact identifiers (normalized case number, diary number, CNR);
 *   nothing is matched by party name or by similarity. Unparsed cause-list entries never reach a matter.
 * - Cause lists are published by the courts and are not authoritative online: every listing carries when it was
 *   published / fetched and the source document it was read from.
 * - Action items extracted from an order are bound to the order's SHA-256 and version; a deadline is computed only
 *   when the order states a period or a date, and nothing becomes a task until a reviewer confirms it.
 */
import type { CauseListEntry, MatterCaseIdentifier, SourceDocument } from "@/modules/official/types";

export type { CauseListEntry, MatterCaseIdentifier } from "@/modules/official/types";

export type TrackedIdentifierKind = MatterCaseIdentifier["kind"];

/** A tracked identifier: the normalized value used for exact matching plus the form the user typed / the court printed. */
export interface TrackedIdentifier extends MatterCaseIdentifier {
  printed: string;
}

/** Stored per matter in the `matter_tracking` collection (id = matterId). Never inside `matter.india`. */
export interface MatterTracking {
  id: string;
  matterId: string;
  identifiers: TrackedIdentifier[];
  /** Advocate names to watch in parsed lists (exact token match, never fuzzy). */
  advocateNames?: string[];
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
  /** No identifiers are tracked for the matter, so nothing can be matched. */
  untracked?: boolean;
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
  untracked?: boolean;
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
  | "period_not_in_text" // the period the model gave is not in the order text
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
  /** Hash and version of the order text the items were read from. */
  documentSha256: string | null;
  documentVersion: number;
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
  /** The order changed after extraction (hash differs): the items must be re-extracted before review. */
  stale: boolean;
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
  section: "points" | "authorities" | "questions";
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
  /** succeeded: all sections produced; partial: research step failed or hit its budget (deterministic parts kept). */
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
