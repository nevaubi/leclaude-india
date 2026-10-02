/**
 * Official-sources corpus contract (client-safe: no server imports).
 *
 * Indian court, tribunal, regulator, gazette and Parliament documents fetched from the publisher, turned into
 * page-marked markdown (text layer, Firecrawl PDF parse or OCR), chunked and indexed for hybrid retrieval, and offered to
 * agents and workflows as citable evidence. The official document stays the text of record: every document keeps its
 * canonical source URL, the SHA-256 of the bytes that were read, when it was fetched, and how its text was obtained.
 *
 * Invariants
 * - Identity: a document id is derived from (sourceId, canonical URL); the same URL re-fetched with different bytes
 *   becomes a new `version` of the same document (old text is replaced, the previous hash is kept in `history`).
 * - Nothing is invented: a field the publisher did not print stays null. A cause-list entry, order or circular that
 *   cannot be parsed is stored as text with `parsed: false`; it is never matched to a matter by guesswork.
 * - Text provenance is explicit (`extraction`): text_layer | html | firecrawl_pdf | ocr_model | dataset. OCR text is
 *   marked as such and quotes from it must be checked against the PDF before filing.
 * - Retrieval returns stable, server-resolvable source ids: `src://<documentId>#p<page>` (or `#c<chunk>`).
 */

/** Registry ids of the sources (definitions live with each adapter; see ./registry.ts). */
export type SourceId =
  | "sci-causelist" // Supreme Court cause lists (advance, daily main/supplementary, weekly) — api.sci.gov.in/jonew/cl
  | "sci-orders" // Supreme Court latest judgments (homepage) and daily orders (/latest-orders/) via /sci-get-pdf/
  | "sci-calendar" // Supreme Court calendar and holidays (/calendar/ HTML table + year PDFs)
  | "hc-calendars" // High Court holiday calendars (Delhi, Karnataka; others when an open PDF exists)
  | "dhc-causelist" // Delhi High Court cause lists (main, supplementary, advance, pronouncements)
  | "nclt" // NCLT cause lists (per bench), weekly registry defect lists, calendar
  | "nclat" // NCLAT daily cause lists, latest judgments and daily orders (display-board PDFs), calendar
  | "ibbi" // IBBI: NCLT / NCLAT / SC / HC IBC orders mirrored by IBBI, IBBI orders, public announcements
  | "sebi-orders" // SEBI enforcement orders (adjudication, WTM, settlement, courts, ...) incl. SAT orders mirrored by SEBI
  | "sat-orders" // Securities Appellate Tribunal portal (CAPTCHA-gated: registered disabled; SAT orders come via sebi-orders)
  | "cci-orders" // Competition Commission antitrust and combination orders
  | "ngt-orders" // National Green Tribunal judgments and orders
  | "egazette" // e-Gazette of India (extraordinary and weekly)
  | "cbic" // CBIC notifications and circulars (GST, Customs, Central Excise, Service Tax) via its JSON API
  | "gst-council" // GST Council meeting agenda and minutes
  | "cbdt" // Income-tax circulars and notifications (Income-tax Act 1961 and 2025)
  | "mca-master" // MCA company / LLP master data (data.gov.in, GODL-India)
  | "sansad"; // Parliament: Lok Sabha / Rajya Sabha questions, debates, committee reports (sansad.in, elibrary.sansad.in)

/** Every registered source id, in display order. */
export const SOURCE_IDS: readonly SourceId[] = [
  "sci-causelist", "sci-orders", "sci-calendar", "hc-calendars", "dhc-causelist", "nclt", "nclat", "ibbi", "sebi-orders",
  "sat-orders", "cci-orders", "ngt-orders", "egazette", "cbic", "gst-council", "cbdt", "mca-master", "sansad",
];

export function isSourceId(v: unknown): v is SourceId {
  return typeof v === "string" && (SOURCE_IDS as readonly string[]).includes(v);
}

export type SourceKind =
  | "cause_list"
  | "order"
  | "judgment"
  | "defect_list"
  | "calendar"
  | "regulation"
  | "circular"
  | "notification"
  | "gazette"
  | "minutes"
  | "parliament_question"
  | "parliament_debate"
  | "committee_report"
  | "company_record"
  | "dataset";

/** How the bytes are fetched. Indian government sites often answer only requests from India: `firecrawl_in`. */
export type FetchMethod = "direct" | "firecrawl_in" | "dataset_push";

/** How a document's bytes were actually obtained (recorded per document; Firecrawl's IN location can fall back to US). */
export interface FetchProvenance {
  via: "direct" | "firecrawl";
  proxy?: string | null;
  timezone?: string | null;
  status: number;
  finalUrl: string;
}

export type ExtractionMethod = "text_layer" | "html" | "firecrawl_pdf" | "ocr_model" | "dataset";

export type DocumentStatus =
  | "discovered" // listed by the adapter, not fetched yet
  | "fetched" // bytes fetched and hashed, text not extracted yet
  | "extracted" // text extracted, not chunked/indexed yet
  | "ocr_needed" // no usable text layer; waiting for OCR
  | "indexed" // chunks stored (and embedded when embeddings are available)
  | "failed" // last attempt failed (see `error`; retried while attempts remain)
  | "excluded"; // deliberately not ingested (wrong type, duplicate, out of scope) — reason in `error`

export interface SourceDef {
  id: SourceId;
  name: string;
  /** Publisher as it should be credited ("Supreme Court of India", "Securities and Exchange Board of India"). */
  publisher: string;
  kinds: SourceKind[];
  /** Court / tribunal / regulator registry key where one applies (e.g. "sci", "hc-delhi", "nclt", "sebi"). */
  forum: string | null;
  homepage: string;
  fetch: FetchMethod;
  /** How often the discovery step should run, in minutes (cause lists: hourly; regulators: daily). */
  cadenceMinutes: number;
  /** Shown with every result from this source. */
  attribution: string;
  /** Terms / licence note as found; "Government publication; verify against the official copy" when none is stated. */
  terms: string;
  /** False when the adapter is registered but disabled (blocked, needs credentials, awaiting review). */
  enabled: boolean;
  /** Why it is disabled, or caveats users must see. */
  notes?: string[];
}

/** One item an adapter found on a listing page / feed / dataset. */
export interface DiscoveredDoc {
  sourceId: SourceId;
  kind: SourceKind;
  /** Canonical page or file URL at the publisher (absolute, http/https). */
  url: string;
  /** Direct file URL when different from `url` (the PDF behind a listing row). */
  fileUrl?: string | null;
  title: string;
  /** Date of the document as printed (ISO date), e.g. order date, list date, notification date. */
  docDate?: string | null;
  /** Free metadata as printed by the publisher (case number, bench, parties, notification number, ...). */
  meta?: Record<string, string | string[] | number | boolean | null>;
  /** Text already provided by the listing/dataset (dataset_push sources); skips fetching. */
  text?: string | null;
  /** MIME type when known in advance. */
  mime?: string | null;
}

export interface SourceDocument {
  id: string;
  sourceId: SourceId;
  kind: SourceKind;
  url: string;
  fileUrl: string | null;
  title: string;
  docDate: string | null;
  status: DocumentStatus;
  mime: string | null;
  sha256: string | null;
  bytes: number | null;
  pages: number | null;
  extraction: ExtractionMethod | null;
  /** Pages whose text came from OCR (1-based). */
  ocrPages: number[];
  language: string | null;
  meta: Record<string, unknown>;
  version: number;
  fetchedAt: string | null;
  indexedAt: string | null;
  error: string | null;
  attempts: number;
  chunks: number;
}

export interface SourceChunk {
  documentId: string;
  index: number;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  /** Markdown text of the chunk (page markers stripped). */
  text: string;
}

export interface SourceSearchQuery {
  q: string;
  sources?: SourceId[];
  kinds?: SourceKind[];
  forum?: string;
  /** ISO dates, inclusive. */
  from?: string;
  to?: string;
  limit?: number;
  /** "hybrid" (default when embeddings are available), "keyword" or "semantic". */
  mode?: "hybrid" | "keyword" | "semantic";
}

export interface SourceSearchHit {
  /** Stable, server-resolvable id: src://<documentId>#p<page> (or #c<chunk>). */
  ref: string;
  documentId: string;
  chunkIndex: number;
  sourceId: SourceId;
  kind: SourceKind;
  title: string;
  publisher: string;
  url: string;
  docDate: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  /** Focused excerpt from the chunk (verbatim). */
  text: string;
  score: number;
  match: "keyword" | "semantic" | "both";
  extraction: ExtractionMethod | null;
}

export interface SourceStats {
  sourceId: SourceId;
  documents: number;
  byStatus: Partial<Record<DocumentStatus, number>>;
  chunks: number;
  embedded: number;
  lastDiscoveredAt: string | null;
  lastIndexedAt: string | null;
  lastError: string | null;
}

/** Result of one bounded ingest run (one API call / one job attempt). */
export interface IngestRunReport {
  sourceId: SourceId | "all";
  stage: "discover" | "fetch" | "extract" | "index" | "all";
  discovered: number;
  fetched: number;
  extracted: number;
  ocr: number;
  indexed: number;
  failed: number;
  skipped: number;
  stop: "done" | "deadline" | "budget" | "error" | "disabled";
  errors: { url: string; error: string }[];
  durationMs: number;
}

// ---- cause lists ----------------------------------------------------------------------------------------------------

export type CauseListType = "main" | "supplementary" | "advance" | "weekly" | "daily" | "other";

/** One listed item, parsed deterministically from a published cause list. Unparsed lines stay unparsed. */
export interface CauseListEntry {
  id: string;
  /** Source document (the cause-list PDF/HTML) this entry was read from. */
  documentId: string;
  forum: string; // "sci", "hc-delhi", "nclt-mumbai", ...
  listDate: string; // ISO date the list is for
  listType: CauseListType;
  courtNo: string | null;
  /** Bench as printed ("HON'BLE THE CHIEF JUSTICE, HON'BLE MR. JUSTICE ..."). */
  bench: string | null;
  itemNo: string | null;
  /** Case numbers as printed and in normalized form ("SLP(C) No. 1234/2026" → "SLPC/1234/2026"). */
  caseNumbers: { printed: string; normalized: string | null }[];
  diaryNo: string | null;
  parties: string | null;
  advocates: string[];
  /** Verbatim text of the entry as read (for display and audit). */
  raw: string;
  page: number | null;
  /** When the list was published / fetched — lists are not authoritative; show "as published at". */
  publishedAt: string | null;
  fetchedAt: string;
  /** False when the entry could not be split into fields; never matched to a matter in that case. */
  parsed: boolean;
}

/** A matter's identifiers used for exact listing matches (never fuzzy). */
export interface MatterCaseIdentifier {
  forum: string;
  /** Normalized case number ("SLPC/1234/2026"), diary number ("12345/2026") or CNR. */
  kind: "case_number" | "diary_no" | "cnr";
  value: string;
}

export interface ListingMatch {
  matterId: string;
  entry: CauseListEntry;
  matchedOn: MatterCaseIdentifier;
}

export const SOURCE_REF_PREFIX = "src://";

/** Build the stable reference for a chunk or page of a source document. */
export function sourceRef(documentId: string, at?: { page?: number | null; chunk?: number | null }): string {
  const base = `${SOURCE_REF_PREFIX}${documentId}`;
  if (at?.page != null) return `${base}#p${at.page}`;
  if (at?.chunk != null) return `${base}#c${at.chunk}`;
  return base;
}

/** Parse a source reference; null when it is not one (never guessed). */
export function parseSourceRef(ref: string): { documentId: string; page: number | null; chunk: number | null } | null {
  const m = /^src:\/\/([A-Za-z0-9_.:-]{6,160})(?:#(p|c)(\d{1,6}))?$/.exec(ref.trim());
  if (!m) return null;
  return { documentId: m[1], page: m[2] === "p" ? Number(m[3]) : null, chunk: m[2] === "c" ? Number(m[3]) : null };
}
