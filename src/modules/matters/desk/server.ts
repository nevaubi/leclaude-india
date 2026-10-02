import "server-only";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import { currentPrincipal } from "@/lib/auth/context";
import { generateJSON } from "@/lib/ai/agent";
import { ServiceError } from "@/modules/workspace/errors";
import { createTask } from "@/modules/home/service";
import { matterHref } from "@/lib/features";
import { isValidIsoDate } from "@/lib/india/holidays";
import { listingsForMatters, ordersForIdentifiers, OfficialNotConfiguredError, OfficialNotImplementedError, readOfficialDocument } from "@/modules/official/service";
import type { SourceDocument } from "@/modules/official/types";
import type { MatterRecord } from "../types";
import { forumHasParsedLists, identifierCheckable, listingMatchHolds, validateTrackingInput } from "./tracking";
import { buildActionItems, type OrderTextChunk, type RawOrderExtraction } from "./order-actions";
import type { ListingSource, ListingsResponse, ManualHearing, ManualHearingInput, MatterListing, MatterOrder, MatterTracking, OfficialState, OrderActionReviewDecision, OrderActionSet, OrderActionSetSummary, OrdersResponse, TrackedIdentifier } from "./types";

/**
 * Litigation desk services (server-only). Every function takes a matter id the route has already authorized
 * (withAuth + refs.matter(id)); the official-sources facade is called only with that matter's own identifiers, so
 * nothing from another matter is ever read or matched. Desk records live in their own matter-scoped collections:
 *   matter_tracking       one per matter (id = matterId): tracked identifiers
 *   matter_hearings       manual hearings (courts whose lists are not parsed)
 *   matter_order_actions  action items extracted from an order, bound to the order's SHA-256 / version
 * `matter.india` is untouched (PATCH replaces it wholesale; appending there would lose updates).
 */

export const TRACKING = "matter_tracking";
export const HEARINGS = "matter_hearings";
export const ORDER_ACTIONS = "matter_order_actions";

const tracking = () => db().collection<MatterTracking>(TRACKING);
const hearings = () => db().collection<ManualHearing>(HEARINGS);
const actionSets = () => db().collection<OrderActionSet>(ORDER_ACTIONS);

function actor(): { id: string; name: string } {
  const p = currentPrincipal();
  return p ? { id: p.id, name: p.name } : { id: "unknown", name: "Unknown" };
}

export function requireMatter(id: string): MatterRecord {
  const m = db().collection<MatterRecord>("matters").get(id);
  if (!m) throw new ServiceError(404, "Matter not found", undefined, "not_found");
  return m;
}

/** A dependency failed or ran out of time (503 / 504): nothing was saved and the caller may retry. */
export class DeskUnavailableError extends Error {
  constructor(message: string, readonly code: string, readonly status: 503 | 504 = 503) {
    super(message);
    this.name = "DeskUnavailableError";
  }
}

// ---- official facade errors ---------------------------------------------------------------------------------------

/** Classify a facade failure into a state the UI can show (never a silent empty list). */
export function officialFailure(e: unknown): { state: OfficialState; message: string } {
  if (e instanceof OfficialNotConfiguredError) return { state: "not_configured", message: e.message };
  if (e instanceof OfficialNotImplementedError) return { state: "not_available", message: "Cause lists and orders are not available on this deployment yet." };
  return { state: "error", message: (e as Error)?.message ?? String(e) };
}

// ---- tracking ------------------------------------------------------------------------------------------------------

export function getTracking(matterId: string): MatterTracking | null {
  return tracking().get(matterId);
}

/**
 * Replace the matter's tracked identifiers. 400 with the reason when any identifier does not normalize. When the body
 * names `expectedUpdatedAt` (the `updatedAt` it last read, null for "nothing tracked yet"), a record changed since then
 * is a 409 conflict instead of a silent overwrite.
 */
export function putTracking(matterId: string, body: Record<string, unknown>): MatterTracking {
  requireMatter(matterId);
  const v = validateTrackingInput(body);
  if (!v.ok) throw new ServiceError(400, v.error, { [v.field]: v.error }, "invalid_identifier");
  if (body.expectedUpdatedAt !== undefined) {
    if (body.expectedUpdatedAt !== null && typeof body.expectedUpdatedAt !== "string") throw new ServiceError(400, "expectedUpdatedAt must be the updatedAt you read, or null.", undefined, "invalid");
    const current = getTracking(matterId)?.updatedAt ?? null;
    if (current !== body.expectedUpdatedAt) throw new ServiceError(409, "The tracked identifiers were changed by someone else. They have been reloaded; make your change again.", undefined, "conflict");
  }
  const who = actor();
  const prev = getTracking(matterId)?.updatedAt;
  let updatedAt = new Date().toISOString();
  // A version stamp must move on every write, even two writes in the same millisecond.
  if (prev && updatedAt <= prev) updatedAt = new Date(Date.parse(prev) + 1).toISOString();
  const rec: MatterTracking = { id: matterId, matterId, identifiers: v.identifiers, updatedAt, updatedBy: who.id };
  tracking().put(rec);
  audit("update", { kind: "matter_tracking", id: matterId, label: "Tracked case identifiers", matterId }, { identifiers: v.identifiers.map((i) => `${i.forum}:${i.kind}:${i.value}`) }, who);
  return rec;
}

function uncovered(t: MatterTracking | null): string[] {
  return Array.from(new Set((t?.identifiers ?? []).map((i) => i.forum).filter((f) => !forumHasParsedLists(f))));
}

/** The matter's identifiers split into those the official sources can match and those kept for reference only. */
export function splitIdentifiers(t: MatterTracking | null): { checkable: TrackedIdentifier[]; unmatchable: TrackedIdentifier[] } {
  const ids = t?.identifiers ?? [];
  return { checkable: ids.filter(identifierCheckable), unmatchable: ids.filter((i) => !identifierCheckable(i)) };
}

const bare = (ids: TrackedIdentifier[]) => ids.map(({ forum, kind, value }) => ({ forum, kind, value }));

// ---- listings ------------------------------------------------------------------------------------------------------

const SOURCE_LOOKUP_CONCURRENCY = 8;

/**
 * The published cause lists behind a set of entries: every distinct list is looked up (at most 8 reads in flight).
 * A list whose record cannot be read gets no link (null), never another document's link.
 */
export async function listingSources(documentIds: string[], read: typeof readOfficialDocument = readOfficialDocument): Promise<Map<string, ListingSource | null>> {
  const ids = Array.from(new Set(documentIds));
  const out = new Map<string, ListingSource | null>();
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < ids.length; i = next++) {
      const id = ids[i];
      try {
        const r = await read(id, { fromChunk: 0, maxChars: 1 });
        out.set(id, r && r.document.id === id ? { url: r.document.fileUrl ?? r.document.url, title: r.document.title } : null);
      } catch {
        out.set(id, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SOURCE_LOOKUP_CONCURRENCY, ids.length) }, worker));
  return out;
}

/** Exact listings of this matter's identifiers in [from, to], as matched by the official-sources facade. */
export async function matterListings(matterId: string, from: string, to: string, deps: { listings?: typeof listingsForMatters; read?: typeof readOfficialDocument } = {}): Promise<ListingsResponse> {
  requireMatter(matterId);
  const t = getTracking(matterId);
  const { checkable, unmatchable } = splitIdentifiers(t);
  const base = { from, to, uncoveredForums: uncovered(t), unmatchable };
  if (!checkable.length) return { ...base, state: "ok", untracked: true, listings: [] };
  try {
    const matches = await (deps.listings ?? listingsForMatters)([{ matterId, identifiers: bare(checkable) }], { from, to });
    // Defence in depth: keep only matches for this matter, on parsed entries, inside the range, on one of its own
    // identifiers whose exact key the entry carries in a compatible forum.
    const kept = matches.filter((m) => m.matterId === matterId && m.entry.parsed && m.entry.listDate >= from && m.entry.listDate <= to && listingMatchHolds(m, checkable));
    const sources = await listingSources(kept.map((m) => m.entry.documentId), deps.read);
    const listings: MatterListing[] = kept
      .map((m) => ({ id: m.entry.id, matterId, entry: m.entry, matchedOn: m.matchedOn, source: sources.get(m.entry.documentId) ?? null }))
      .sort((a, b) => a.entry.listDate.localeCompare(b.entry.listDate) || (a.entry.courtNo ?? "").localeCompare(b.entry.courtNo ?? "", undefined, { numeric: true }) || (a.entry.itemNo ?? "").localeCompare(b.entry.itemNo ?? "", undefined, { numeric: true }));
    return { ...base, state: "ok", listings: dedupeListings(listings) };
  } catch (e) {
    const f = officialFailure(e);
    return { ...base, state: f.state, message: f.message, listings: [] };
  }
}

function dedupeListings(rows: MatterListing[]): MatterListing[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

// ---- manual hearings -----------------------------------------------------------------------------------------------

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

export function listManualHearings(matterId: string, range?: { from?: string; to?: string }): ManualHearing[] {
  return hearings()
    .find((h) => h.matterId === matterId && (!range?.from || h.date >= range.from) && (!range?.to || h.date <= range.to))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}

export function addManualHearing(matterId: string, input: ManualHearingInput): ManualHearing {
  requireMatter(matterId);
  const date = text(input.date, 10);
  if (!date || !isValidIsoDate(date)) throw new ServiceError(422, "Enter the hearing date (YYYY-MM-DD).", { date: "Enter the hearing date." }, "invalid");
  const time = text(input.time, 5);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ServiceError(422, "Time must be HH:MM (24-hour).", { time: "Time must be HH:MM." }, "invalid");
  const who = actor();
  const h: ManualHearing = {
    id: `hr_${nanoid(10)}`, matterId, date, createdAt: new Date().toISOString(), createdBy: who.id,
    ...(time ? { time } : {}),
    ...Object.fromEntries((["court", "courtNo", "itemNo", "bench", "purpose", "note"] as const).map((k) => [k, text(input[k], k === "note" ? 600 : 160)]).filter(([, v]) => v)),
  };
  hearings().put(h);
  audit("create", { kind: "matter_hearing", id: h.id, label: `Hearing ${h.date}`, matterId }, { date: h.date }, who);
  return h;
}

export function deleteManualHearing(matterId: string, hearingId: string): void {
  const h = hearings().get(hearingId);
  // A hearing of another matter is "not found" here: the route authorized this matter only.
  if (!h || h.matterId !== matterId) throw new ServiceError(404, "Hearing not found", undefined, "not_found");
  hearings().delete(hearingId);
  audit("delete", { kind: "matter_hearing", id: hearingId, label: `Hearing ${h.date}`, matterId }, { date: h.date }, actor());
}

// ---- orders --------------------------------------------------------------------------------------------------------

function summarize(set: OrderActionSet, current: SourceDocument | null): OrderActionSetSummary {
  return {
    id: set.id, status: set.status, documentSha256: set.documentSha256, createdAt: set.createdAt,
    items: set.items.length, flagged: set.items.filter((i) => i.flagged).length,
    stale: !!current && ((current.sha256 ?? null) !== set.documentSha256 || current.version !== set.documentVersion),
  };
}

export function listActionSets(matterId: string, documentId?: string): OrderActionSet[] {
  return actionSets().find((s) => s.matterId === matterId && (!documentId || s.documentId === documentId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getActionSet(matterId: string, setId: string): OrderActionSet {
  const s = actionSets().get(setId);
  if (!s || s.matterId !== matterId) throw new ServiceError(404, "Action items not found", undefined, "not_found");
  return s;
}

/** Orders / judgments published for this matter's identifiers (exact metadata matches), newest first. */
export async function matterOrders(matterId: string, deps: { orders?: typeof ordersForIdentifiers } = {}, opts: { limit?: number } = {}): Promise<OrdersResponse> {
  requireMatter(matterId);
  const { checkable, unmatchable } = splitIdentifiers(getTracking(matterId));
  if (!checkable.length) return { state: "ok", untracked: true, unmatchable, orders: [] };
  try {
    const docs = await (deps.orders ?? ordersForIdentifiers)(bare(checkable), { limit: Math.min(Math.max(opts.limit ?? 40, 1), 100) });
    const seen = new Set<string>();
    const orders: MatterOrder[] = docs
      .filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
      .sort((a, b) => (b.docDate ?? "").localeCompare(a.docDate ?? ""))
      .map((d) => {
        const latest = listActionSets(matterId, d.id)[0];
        return { document: d, actions: latest ? summarize(latest, d) : null };
      });
    return { state: "ok", unmatchable, orders };
  } catch (e) {
    const f = officialFailure(e);
    return { state: f.state, message: f.message, unmatchable, orders: [] };
  }
}

export const ORDER_MAX_CHARS = 60_000;

export interface OrderText {
  document: SourceDocument;
  chunks: OrderTextChunk[];
  complete: boolean;
  chars: number;
  /** SHA-256 of the text read (pages and chunk text), the exact input the items are checked against. */
  textSha256: string;
}

/** SHA-256 of order text as read: page ranges and chunk text, in order. */
export function orderTextSha256(chunks: OrderTextChunk[]): string {
  const h = createHash("sha256");
  for (const c of chunks) h.update(`${c.pageStart ?? ""}-${c.pageEnd ?? ""}\u0000${c.text}\u0000`);
  return h.digest("hex");
}

/** Read an order's text chunk by chunk, bounded. `complete` is false when the budget stopped before the end. */
export async function readOrderText(documentId: string, deps: { read?: typeof readOfficialDocument } = {}, maxChars = ORDER_MAX_CHARS): Promise<OrderText | null> {
  const read = deps.read ?? readOfficialDocument;
  let from = 0;
  let chars = 0;
  let document: SourceDocument | null = null;
  const chunks: OrderTextChunk[] = [];
  const done = (complete: boolean): OrderText | null => (document ? { document, chunks, complete, chars, textSha256: orderTextSha256(chunks) } : null);
  for (let round = 0; round < 20; round++) {
    const r = await read(documentId, { fromChunk: from, maxChars: Math.min(20_000, maxChars - chars) });
    if (!r) return done(false);
    document = r.document;
    for (const c of r.chunks) {
      chunks.push({ pageStart: c.pageStart, pageEnd: c.pageEnd, text: c.text });
      chars += c.text.length;
    }
    if (!r.hasMore || r.nextChunk == null) return done(true);
    if (chars >= maxChars || r.nextChunk <= from) return done(false);
    from = r.nextChunk;
  }
  return done(false);
}

function pageLabel(c: OrderTextChunk): string {
  if (c.pageStart == null) return "[Page unknown]";
  return c.pageEnd != null && c.pageEnd !== c.pageStart ? `[Pages ${c.pageStart}-${c.pageEnd}]` : `[Page ${c.pageStart}]`;
}

const ORDER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    directions: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, quote: { type: "string" }, page: { type: ["integer", "null"] } }, required: ["text", "quote", "page"] } },
    nextDates: { type: "array", maxItems: 1, items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, quote: { type: "string" }, page: { type: ["integer", "null"] } }, required: ["text", "quote", "page"] } },
    complianceTasks: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false, properties: { task: { type: "string" }, party: { type: ["string", "null"] }, quote: { type: "string" }, page: { type: ["integer", "null"] }, period: { type: ["string", "null"] }, statedDate: { type: ["string", "null"] } }, required: ["task", "party", "quote", "page", "period", "statedDate"] } },
  },
  required: ["directions", "nextDates", "complianceTasks"],
} as const;

const ORDER_INSTRUCTIONS = [
  "You read one order or judgment of an Indian court or tribunal and list what it directs. Output JSON only.",
  "- directions: each substantive direction (notice issued, interim relief granted / refused / continued, stay, pleadings or documents to be filed, deposits, appearances).",
  "- nextDates: at most one item: the date or period for which the matter is listed next, if the order says so.",
  "- complianceTasks: each thing a party must do, with the party as the order names it (or null).",
  "Rules:",
  "- quote: copy the words character for character from ORDER TEXT (the sentence holding the direction, at most about 300 characters). No paraphrase, no ellipsis, no added or corrected words.",
  "- page: the number in the [Page N] marker the quote appears under; null when unsure.",
  "- period: the exact words stating the time allowed (e.g. \"within four weeks from today\"), copied verbatim, or null. statedDate: an exact date as printed (e.g. \"15.10.2026\"), or null. Both must be words inside that item's own quote, never taken from elsewhere in the order.",
  "- Never compute or convert dates. Never add a task or direction the order does not state. If the order directs nothing, return empty lists.",
].join("\n");

export type OrderExtractor = (input: { instructions: string; text: string; matterId: string; signal?: AbortSignal }) => Promise<RawOrderExtraction>;

const defaultExtractor: OrderExtractor = async ({ instructions, text, matterId, signal }) => {
  const r = await generateJSON<{ directions: RawOrderExtraction["directions"]; nextDates: NonNullable<RawOrderExtraction["nextDate"]>[]; complianceTasks: RawOrderExtraction["complianceTasks"] }>({
    instructions, input: text, schema: ORDER_SCHEMA as unknown as Record<string, unknown>, name: "order_actions",
    taskType: "extract", reasoningEffort: "low", maxOutputTokens: 4000, matterId, privacy: "internal", signal,
  });
  return { directions: r.directions ?? [], nextDate: r.nextDates?.[0] ?? null, complianceTasks: r.complianceTasks ?? [] };
};

/** Time allowed for reading an order and extracting its items; below the route's maxDuration (120 s). */
export const ORDER_EXTRACT_BUDGET_MS = 100_000;

/**
 * Extract action items from one order of this matter. The order must be one the facade returns for the matter's own
 * identifiers (an arbitrary official document cannot be attached to a matter here) and its text must be indexed. The
 * model reads the bounded order text; quotes, pages and deadlines are then checked in code (./order-actions.ts) and
 * the set is stored for review, bound to the file hash, the version and the hash of the text read.
 */
export async function extractOrderActions(matterId: string, documentId: string, deps: { orders?: typeof ordersForIdentifiers; read?: typeof readOfficialDocument; extract?: OrderExtractor; signal?: AbortSignal; budgetMs?: number } = {}): Promise<OrderActionSet> {
  const listed = await matterOrders(matterId, { orders: deps.orders }, { limit: 100 });
  if (listed.state !== "ok") throw new ServiceError(409, listed.message ?? "Orders are not available.", undefined, `official_${listed.state}`);
  const order = listed.orders.find((o) => o.document.id === documentId);
  if (!order) throw new ServiceError(404, "This order is not linked to the matter's tracked identifiers.", undefined, "order_not_linked");
  if (order.document.status !== "indexed") throw new ServiceError(409, "The order's text has not been extracted yet. Try again after it is indexed.", undefined, "order_not_indexed");
  const budget = AbortSignal.timeout(deps.budgetMs ?? ORDER_EXTRACT_BUDGET_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, budget]) : budget;
  const read = await readOrderText(documentId, { read: deps.read });
  if (!read || !read.chunks.length || read.document.status !== "indexed") throw new ServiceError(409, "The order's text has not been extracted yet. Try again after it is indexed.", undefined, "order_not_indexed");
  const doc = read.document;
  const body = [`ORDER: ${doc.title}`, `Date printed by the publisher: ${doc.docDate ?? "not printed"}`, "", "ORDER TEXT:", ...read.chunks.map((c) => `${pageLabel(c)}\n${c.text}`)].join("\n");
  let raw: RawOrderExtraction;
  try {
    raw = await (deps.extract ?? defaultExtractor)({ instructions: ORDER_INSTRUCTIONS, text: body, matterId, signal });
  } catch (e) {
    if (budget.aborted && !deps.signal?.aborted) throw new DeskUnavailableError("Reading the order took longer than the time allowed. Nothing was saved; try again.", "timeout", 504);
    throw e;
  }
  const who = actor();
  const set: OrderActionSet = {
    id: `oa_${nanoid(10)}`, matterId, documentId, documentSha256: doc.sha256 ?? null, documentVersion: doc.version, textSha256: read.textSha256, documentTitle: doc.title, documentUrl: doc.fileUrl ?? doc.url,
    orderDate: doc.docDate, textChars: read.chars, coverage: read.complete ? "complete" : "partial",
    items: buildActionItems(raw, read.chunks, doc.docDate), status: "pending_review", createdAt: new Date().toISOString(), createdBy: who.id,
  };
  actionSets().put(set);
  audit("ai.generate", { kind: "order_actions", id: set.id, label: `Action items: ${doc.title}`.slice(0, 160), matterId }, { documentId, sha256: set.documentSha256, textSha256: set.textSha256, items: set.items.length, flagged: set.items.filter((i) => i.flagged).length, coverage: set.coverage }, who);
  return set;
}

/** Sets under review in this process (a second concurrent submission is refused, never run twice). */
const reviewing = new Set<string>();

/** Deterministic task id per set and item: a repeated submission finds the task instead of creating a second one. */
export function orderActionTaskId(setId: string, itemId: string): string {
  return `t_${setId}_${itemId}`;
}

/**
 * Reviewer confirmation (human control boundary for deadlines): tasks are created only for items the reviewer
 * confirms, with the due date the reviewer confirms. Before anything is created the order is read again and must be
 * the same file, version and text the items were extracted from: a changed order is stale (409), and an order that
 * cannot be re-checked fails closed (409 when it is gone or not indexed, 503 when the read fails); no task is created.
 */
export async function reviewActionSet(matterId: string, setId: string, body: Record<string, unknown>, deps: { read?: typeof readOfficialDocument } = {}): Promise<{ set: OrderActionSet; created: string[] }> {
  const set = getActionSet(matterId, setId);
  if (set.status === "reviewed") throw new ServiceError(409, "These action items were already reviewed.", undefined, "already_reviewed");
  const raw = body.decisions;
  if (!Array.isArray(raw) || !raw.length) throw new ServiceError(400, "decisions must list the items you reviewed.", undefined, "invalid");
  const byId = new Map(set.items.map((i) => [i.id, i]));
  const decisions: OrderActionReviewDecision[] = [];
  const named = new Set<string>();
  for (const d of raw as Record<string, unknown>[]) {
    const item = typeof d?.itemId === "string" ? byId.get(d.itemId) : undefined;
    if (!item) throw new ServiceError(400, "A decision names an item that is not in this set.", undefined, "unknown_item");
    if (named.has(item.id)) throw new ServiceError(400, "Each item can be decided once per review.", undefined, "duplicate_item");
    named.add(item.id);
    const dueAt = d.dueAt === null || d.dueAt === undefined || d.dueAt === "" ? null : String(d.dueAt);
    if (dueAt && !isValidIsoDate(dueAt)) throw new ServiceError(400, "Due dates must be YYYY-MM-DD.", undefined, "invalid");
    decisions.push({ itemId: item.id, create: d.create === true, dueAt });
  }
  if (!set.textSha256) throw new ServiceError(409, "These items were extracted before the order text was bound to them. Extract them again before review.", undefined, "stale");
  if (reviewing.has(set.id)) throw new ServiceError(409, "These action items are being reviewed in another request.", undefined, "review_in_progress");
  reviewing.add(set.id);
  try {
    let current: Awaited<ReturnType<typeof readOrderText>>;
    try {
      current = await readOrderText(set.documentId, { read: deps.read });
    } catch {
      throw new DeskUnavailableError("The order could not be read again to confirm it has not changed. No task was created; try again.", "order_recheck_failed", 503);
    }
    // The same bounded read as at extraction: the whole order for a complete set, the same leading part for a partial one.
    if (!current || current.document.status !== "indexed" || (set.coverage === "complete" && !current.complete)) throw new ServiceError(409, "The order could not be read again in full to confirm it has not changed. No task was created.", undefined, "order_unverified");
    if ((current.document.sha256 ?? null) !== set.documentSha256 || current.document.version !== set.documentVersion || current.textSha256 !== set.textSha256) {
      throw new ServiceError(409, "The order changed after these items were extracted. Extract them again before review.", undefined, "stale");
    }
    // Another instance may have finished a review while the order was read.
    const fresh = actionSets().get(set.id);
    if (!fresh || fresh.status !== "pending_review") throw new ServiceError(409, "These action items were already reviewed.", undefined, "already_reviewed");
    const who = actor();
    const created: string[] = [];
    for (const d of decisions) {
      if (!d.create) continue;
      const item = byId.get(d.itemId)!;
      const id = orderActionTaskId(set.id, item.id);
      if (!db().tasks.get(id)) {
        const lines = [
          `"${item.quote}"`,
          `Source: ${set.documentTitle}${set.orderDate ? ` (${set.orderDate})` : ""}${item.page ? `, p. ${item.page}` : ""}.`,
          item.check.quoteFound ? (item.check.pageVerified ? "Quote verified against the order text." : "Quote found in the order text on a different page than cited.") : "Quote NOT found in the order text: check the order before relying on this.",
          item.deadline ? `Computed: ${item.deadline.date} — ${item.deadline.rule}.` : "No deadline computed from the order.",
          d.dueAt ? `Due date confirmed by reviewer: ${d.dueAt}.` : "No due date set by reviewer.",
        ];
        createTask({
          title: item.text.slice(0, 200), description: lines.join("\n"), matterId, dueAt: d.dueAt ?? undefined, assigneeId: who.id, createdById: who.id,
          priority: d.dueAt ? "high" : "medium", source: "docket", tags: ["order-action"],
          links: [{ label: "Official order", href: set.documentUrl }, { label: "Matter", href: matterHref(matterId) }],
        }, who.id, { id });
      }
      d.taskId = id;
      created.push(id);
    }
    const next: OrderActionSet = { ...set, status: "reviewed", review: { reviewerId: who.id, reviewedAt: new Date().toISOString(), decisions } };
    actionSets().put(next);
    audit("workflow.approve", { kind: "order_actions", id: set.id, label: `Reviewed action items: ${set.documentTitle}`.slice(0, 160), matterId }, { sha256: set.documentSha256, textSha256: set.textSha256, confirmed: created.length, rejected: decisions.length - created.length, dueDates: decisions.filter((d) => d.create && d.dueAt).map((d) => d.dueAt) }, who);
    return { set: next, created };
  } finally {
    reviewing.delete(set.id);
  }
}
