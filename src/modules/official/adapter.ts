import "server-only";
import type { RemoteStore } from "@/lib/db/remote";
import type { DiscoveredDoc, FetchProvenance, SourceDef } from "./types";

/**
 * Source adapter contract (server-only).
 *
 * An adapter knows one publisher: how to list what it has published (discover) and, optionally, how to turn the
 * extracted text of one of its documents into structured records (parse; e.g. cause-list entries, holidays) and store
 * them (persist). Fetching, hashing, PDF text / Firecrawl parse / OCR, chunking, embedding and storage of the document
 * itself are done by the shared pipeline (./pipeline.ts) so every source gets the same provenance and failure handling.
 *
 * Rules for adapters
 * - Bounded: `discover` returns at most `ctx.limit` items per call and a cursor to resume; it must stop before
 *   `ctx.deadline`.
 * - Honest: never synthesise URLs that were not on the publisher's page unless the publisher's documented pattern is
 *   used (e.g. dated cause-list file names, eGazette ids), and then mark `meta.urlFromPattern = true`; a 404 is
 *   "not published", never a reason to try a nearby URL.
 * - Polite: use `ctx.fetchPage` / `ctx.fetchFile` / `ctx.fetchJson` / `ctx.postForm` (rate-limited per host,
 *   SSRF-safe, Firecrawl-in-India fallback when the source says so); no CAPTCHA or login is ever bypassed, no
 *   free-form query languages are sent to publisher endpoints (only the exact parameter shapes their own UI sends).
 * - Deterministic parsing: `parse` uses code, not a model. Unparseable content is counted in `unparsed`, never guessed.
 * - Personal data: cause lists carry advocates' phone numbers and e-mails; `parse` must drop them (keep names).
 */

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  /** Server HTML (direct fetch) or Firecrawl rawHtml (which strips onclick/javascript: hrefs). */
  html: string | null;
  /** Markdown (Firecrawl) when available. */
  markdown: string | null;
  /** Absolute links found on the page. */
  links: string[];
  provenance: FetchProvenance;
}

export interface FetchedFile {
  url: string;
  finalUrl: string;
  status: number;
  mime: string | null;
  bytes: Uint8Array;
  provenance: FetchProvenance;
}

export interface AdapterContext {
  /** Max items to return from this call. */
  limit: number;
  /** Epoch ms; stop before it. */
  deadline: number;
  /** Opaque resume cursor stored by the runner (null on the first call). */
  cursor: string | null;
  /** Today's date in India (Asia/Kolkata), ISO YYYY-MM-DD. */
  today: string;
  /** Fetch an HTML page: direct first (browser UA, legacy-TLS retry for gov.in), Firecrawl (location IN) on failure
   *  when the source's fetch method is firecrawl_in or `opts.firecrawl` is true. */
  fetchPage(url: string, opts?: { waitForMs?: number; actions?: Array<Record<string, unknown>>; firecrawl?: boolean; /** Skip the direct request (the publisher refuses requests from our servers): Firecrawl, location IN, only. */ firecrawlOnly?: boolean; headers?: Record<string, string> }): Promise<FetchedPage>;
  /** Fetch a file (PDF, XLSX, JSON) directly; size-limited (default 40 MB). */
  fetchFile(url: string, opts?: { maxBytes?: number; accept?: string; headers?: Record<string, string> }): Promise<FetchedFile>;
  /** GET JSON from an API endpoint (direct). */
  fetchJson<T = unknown>(url: string, opts?: { headers?: Record<string, string> }): Promise<T>;
  /** POST an application/x-www-form-urlencoded form (direct) and return the response text — only the exact field
   *  shapes the publisher's own page sends (e.g. SEBI listing pages). */
  postForm(url: string, fields: Record<string, string>, opts?: { headers?: Record<string, string> }): Promise<{ status: number; text: string; finalUrl: string }>;
  signal?: AbortSignal;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface DiscoverResult {
  items: DiscoveredDoc[];
  /** Cursor for the next call; null when this pass found everything currently published. */
  nextCursor: string | null;
  done: boolean;
  notes?: string[];
}

/** Structured records an adapter can derive from a document's extracted text. */
export interface ParseResult<T = unknown> {
  records: T[];
  /** Lines / blocks that could not be parsed (kept for audit; never guessed). */
  unparsed: number;
  notes?: string[];
}

export interface ParseInput {
  id: string;
  url: string;
  title: string;
  docDate: string | null;
  meta: Record<string, unknown>;
  /** Page-marked markdown of the whole document. */
  markdown: string;
  /** Text per page (1-based). */
  pages: { page: number; text: string }[];
  /** Positional text items per page when the PDF had a text layer (for column-aware table parsing). */
  items?: { page: number; str: string; x: number; y: number; w: number; h: number }[];
  fetchedAt: string;
}

export interface SourceAdapter {
  def: SourceDef;
  discover(ctx: AdapterContext): Promise<DiscoverResult>;
  /** Optional: derive structured records (pure, deterministic). */
  parse?(doc: ParseInput): ParseResult;
  /** Optional: store parsed records (idempotent; replaces the records of this document). When an adapter has no
   *  persist, records shaped `{ meta: {...} }` have the first record's meta merged into the document's meta. */
  persist?(store: RemoteStore, doc: ParseInput, result: ParseResult): Promise<{ stored: number }>;
  /** Optional: turn the bytes a publisher returns into the document's real bytes before hashing and extraction
   *  (e.g. CBIC answers PDFs as base64 inside JSON). Throw when the answer is not the expected document. */
  decode?(meta: Record<string, unknown>, bytes: Uint8Array): { bytes: Uint8Array; mime: string | null };
}
