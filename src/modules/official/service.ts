import "server-only";
import type { RemoteStore } from "@/lib/db/remote";
import type { CourtCalendar } from "@/lib/india/holidays";
import type {
  CauseListEntry,
  ListingMatch,
  MatterCaseIdentifier,
  SourceChunk,
  SourceDef,
  SourceDocument,
  SourceId,
  SourceKind,
  SourceSearchHit,
  SourceSearchQuery,
  SourceStats,
} from "./types";

/**
 * Official-sources service facade: the ONLY module other features (agent tools, workflows, matters, diary, tools, UI
 * routes) import. Implementations live in the official-core stream (search/read/status), the courts stream
 * (cause lists, calendars, orders for identifiers) and are wired here at integration.
 *
 * Every function is read-only, bounded (limits, statement timeouts) and never widens a query: a missing filter means
 * "none of that kind", not "everything". Errors: OfficialNotConfiguredError (no Postgres) → 503 "not configured".
 */

export class OfficialNotConfiguredError extends Error {
  readonly code = "official_not_configured";
  constructor(message = "The official-sources corpus is not configured on this deployment (no DATABASE_URL).") {
    super(message);
    this.name = "OfficialNotConfiguredError";
  }
}

/** Thrown by facade functions whose implementation has not been wired yet (integration-time only). */
export class OfficialNotImplementedError extends Error {
  readonly code = "official_not_implemented";
  constructor(fn: string) {
    super(`${fn} is not wired yet`);
    this.name = "OfficialNotImplementedError";
  }
}

export interface OfficialSearchResult {
  hits: SourceSearchHit[];
  /** How the hits were found: hybrid (keyword + embeddings), keyword only (no embeddings), semantic only. */
  mode: "hybrid" | "keyword" | "semantic";
  /** Total keyword candidates considered (bounded). */
  candidates: number;
  /** Explicit no-result state: true when nothing matched (never padded with unrelated documents). */
  empty: boolean;
}

export interface OfficialReadResult {
  document: SourceDocument;
  chunks: SourceChunk[];
  /** True when more chunks follow `chunks`. */
  hasMore: boolean;
  nextChunk: number | null;
  attribution: string;
}

export interface OfficialListQuery {
  sources?: SourceId[];
  kinds?: SourceKind[];
  forum?: string;
  q?: string;
  from?: string;
  to?: string;
  /** Opaque cursor from a previous page. */
  cursor?: string | null;
  limit?: number;
}

export interface OfficialListResult {
  documents: SourceDocument[];
  nextCursor: string | null;
}

export interface OfficialStatus {
  configured: boolean;
  sources: (SourceDef & { stats: SourceStats })[];
  dbBytes: number | null;
  limitBytes: number | null;
  embeddings: "pgvector" | "bytea" | "none";
  queue: { pending: number; running: number; failed: number; done: number };
}

export interface CauseListQuery {
  forum?: string;
  /** ISO date or range (inclusive). */
  date?: string;
  from?: string;
  to?: string;
  /** Normalized case keys (see ./case-numbers.ts). */
  caseKeys?: string[];
  diaryNos?: string[];
  /** Case-insensitive advocate name (exact token match on the advocates list; never fuzzy). */
  advocate?: string;
  limit?: number;
}

type Impl = {
  searchOfficial?: (q: SourceSearchQuery, store?: RemoteStore | null) => Promise<OfficialSearchResult>;
  readOfficialDocument?: (id: string, opts?: { fromChunk?: number; page?: number; maxChars?: number }, store?: RemoteStore | null) => Promise<OfficialReadResult | null>;
  listOfficialDocuments?: (q: OfficialListQuery, store?: RemoteStore | null) => Promise<OfficialListResult>;
  officialStatus?: (store?: RemoteStore | null) => Promise<OfficialStatus>;
  causeListEntries?: (q: CauseListQuery, store?: RemoteStore | null) => Promise<CauseListEntry[]>;
  listingsForMatters?: (matters: { matterId: string; identifiers: MatterCaseIdentifier[] }[], opts: { from: string; to: string }, store?: RemoteStore | null) => Promise<ListingMatch[]>;
  ordersForIdentifiers?: (identifiers: MatterCaseIdentifier[], opts?: { since?: string; limit?: number }, store?: RemoteStore | null) => Promise<SourceDocument[]>;
  courtCalendar?: (forum: string, years: number[], store?: RemoteStore | null) => Promise<CourtCalendar | null>;
};

/** Implementations registered by the core and courts modules (see ./wire-core.ts, ./wire-courts.ts). Tests may override. */
const impl: Impl = {};

export function registerOfficialImpl(part: Impl): void {
  Object.assign(impl, part);
}

let wiring: Promise<void> | null = null;

/**
 * Wire the real implementations on first use. Dynamic imports keep the module graph acyclic at load time: the
 * implementation modules import this file (for its error classes and registerOfficialImpl), so a static import here
 * would evaluate them before `impl` exists.
 */
function ensureWired(): Promise<void> {
  wiring ??= (async () => {
    const [core, courts] = await Promise.all([import("./wire-core"), import("./wire-courts")]);
    core.wireOfficialCore();
    courts.wireCourts();
  })().catch((e) => {
    wiring = null;
    throw e;
  });
  return wiring;
}

async function need<K extends keyof Impl>(k: K): Promise<NonNullable<Impl[K]>> {
  if (!impl[k]) await ensureWired();
  const f = impl[k];
  if (!f) throw new OfficialNotImplementedError(k);
  return f as NonNullable<Impl[K]>;
}

/** Hybrid search over official-document chunks; returns citable hits with stable `src://` refs. */
export async function searchOfficial(q: SourceSearchQuery, store?: RemoteStore | null): Promise<OfficialSearchResult> {
  return (await need("searchOfficial"))(q, store);
}

/** Read a document's chunks (from a chunk index or the chunk containing `page`), bounded by `maxChars`. */
export async function readOfficialDocument(id: string, opts?: { fromChunk?: number; page?: number; maxChars?: number }, store?: RemoteStore | null): Promise<OfficialReadResult | null> {
  return (await need("readOfficialDocument"))(id, opts, store);
}

export async function listOfficialDocuments(q: OfficialListQuery, store?: RemoteStore | null): Promise<OfficialListResult> {
  return (await need("listOfficialDocuments"))(q, store);
}

export async function officialStatus(store?: RemoteStore | null): Promise<OfficialStatus> {
  return (await need("officialStatus"))(store);
}

export async function causeListEntries(q: CauseListQuery, store?: RemoteStore | null): Promise<CauseListEntry[]> {
  return (await need("causeListEntries"))(q, store);
}

/** Exact matches of matters' identifiers against parsed cause-list entries in [from, to]. */
export async function listingsForMatters(matters: { matterId: string; identifiers: MatterCaseIdentifier[] }[], opts: { from: string; to: string }, store?: RemoteStore | null): Promise<ListingMatch[]> {
  return (await need("listingsForMatters"))(matters, opts, store);
}

/** Orders / judgments whose published metadata carries one of these identifiers exactly (diary no., case no.). */
export async function ordersForIdentifiers(identifiers: MatterCaseIdentifier[], opts?: { since?: string; limit?: number }, store?: RemoteStore | null): Promise<SourceDocument[]> {
  return (await need("ordersForIdentifiers"))(identifiers, opts, store);
}

/** The court's notified calendar for the given years, built from official holiday lists; null when none is loaded. */
export async function courtCalendar(forum: string, years: number[], store?: RemoteStore | null): Promise<CourtCalendar | null> {
  return (await need("courtCalendar"))(forum, years, store);
}
