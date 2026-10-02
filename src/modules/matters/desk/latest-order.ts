import "server-only";
import { isValidIsoDate } from "@/lib/india/holidays";
import { ordersForIdentifiers, readOfficialDocument } from "@/modules/official/service";
import { parseSourceRef, sourceRef, type SourceDocument } from "@/modules/official/types";
import { normalizeCaseNumber, qualifiedCaseKey } from "@/modules/official/case-numbers";
import { normalizeIdentifier } from "./tracking";
import { getTracking, readOrderText, requireMatter, splitIdentifiers, ORDER_MAX_CHARS } from "./server";
import type { OrderTextChunk } from "./order-actions";
import type { LatestOrderCandidate, LatestOrderResult, LatestOrderStatus, TrackedIdentifier } from "./types";

/**
 * The latest published order of a matter, chosen in code (server-only). Used by the "New order → action items"
 * workflow so that no model ever picks "the latest order" from free-text search hits.
 *
 * - Identifiers: only the matter's own tracked identifiers the official sources can match (case number, SC diary
 *   number; NCLT numbers bench-qualified). A case number given by the caller narrows to one of them; it is never looked
 *   up on its own, so an order cannot be attached to a matter through an identifier the matter does not track.
 * - Matches: `ordersForIdentifiers` (exact metadata matches), re-checked here: an order or judgment whose published
 *   metadata carries the identifier exactly. Nothing is matched by title, party name or similarity.
 * - Choice: a named order (orderRef) must be one of the exact matches; otherwise the latest by order date. Two orders on
 *   the latest date, or matches that carry no date, are `ambiguous` (the caller names one); nothing is substituted.
 */

const DOC_ID = /^[A-Za-z0-9_.:-]{6,160}$/;
const MAX_CANDIDATES = 10;

export interface LatestOrderOptions {
  forum?: string;
  caseNumber?: string;
  /** A src:// reference or document id; it must be one of the matter's exact matches. */
  orderRef?: string;
  /** Characters of order text to read (bounded at ORDER_MAX_CHARS). */
  maxChars?: number;
}

export interface LatestOrderDeps {
  orders?: typeof ordersForIdentifiers;
  read?: typeof readOfficialDocument;
}

/** Facade errors that mean "no official corpus on this deployment" (matched by code / name: module instances may differ). */
function officialUnavailable(e: unknown): boolean {
  const err = e as { code?: unknown; name?: unknown } | null;
  return err?.code === "official_not_configured" || err?.code === "official_not_implemented" || err?.name === "OfficialNotConfiguredError" || err?.name === "OfficialNotImplementedError";
}

/** The tracked identifier an order's published metadata carries exactly (same rule as the facade), or null. */
export function orderCarries(d: Pick<SourceDocument, "kind" | "meta">, ids: TrackedIdentifier[]): TrackedIdentifier | null {
  if (d.kind !== "order" && d.kind !== "judgment") return null;
  const keys = Array.isArray(d.meta.caseKeys) ? (d.meta.caseKeys as unknown[]).filter((k): k is string => typeof k === "string") : [];
  return ids.find((i) => (i.kind === "case_number" ? keys.includes(i.value) : i.kind === "diary_no" && d.meta.diaryNo === i.value)) ?? null;
}

function candidate(d: SourceDocument): LatestOrderCandidate {
  return { id: d.id, ref: sourceRef(d.id), title: d.title, date: d.docDate, kind: d.kind, url: d.fileUrl ?? d.url };
}

function pageLabel(c: OrderTextChunk): string {
  if (c.pageStart == null) return "[Page unknown]";
  return c.pageEnd != null && c.pageEnd !== c.pageStart ? `[Pages ${c.pageStart}-${c.pageEnd}]` : `[Page ${c.pageStart}]`;
}

const printedList = (ids: TrackedIdentifier[]) => ids.map((i) => `${i.printed} (${i.forum})`).join("; ");

/** Narrow the matter's checkable identifiers to the case number the caller gave (exact: forum, kind and key). */
function narrow(checkable: TrackedIdentifier[], forumRaw: string, caseNumber: string): { ok: true; ids: TrackedIdentifier[] } | { ok: false; status: LatestOrderStatus; message: string } {
  if (!caseNumber) return { ok: true, ids: checkable };
  const forum = forumRaw.trim().toLowerCase();
  let ids: TrackedIdentifier[];
  if (forum) {
    const r = normalizeIdentifier({ forum, kind: "case_number", printed: caseNumber });
    if (!r.ok) return { ok: false, status: "unparsed_identifier", message: `${r.error} Nothing was looked up.` };
    ids = checkable.filter((i) => i.kind === "case_number" && i.forum === r.identifier.forum && i.value === r.identifier.value);
  } else {
    const n = normalizeCaseNumber(caseNumber);
    if (!n) return { ok: false, status: "unparsed_identifier", message: `"${caseNumber}" is not a single recognisable case number. Nothing was looked up.` };
    const keys = [n.key, qualifiedCaseKey(n)].filter((k): k is string => !!k);
    ids = checkable.filter((i) => i.kind === "case_number" && keys.includes(i.value));
  }
  if (!ids.length) {
    const tracked = checkable.length ? ` Tracked: ${printedList(checkable)}.` : "";
    return { ok: false, status: "not_tracked", message: `"${caseNumber}"${forum ? ` (${forum})` : ""} is not one of this matter's tracked identifiers, so no order was looked up for it. Orders are matched only through the matter's own identifiers: add it under Tracked identifiers on the matter's Hearings tab.${tracked}` };
  }
  return { ok: true, ids };
}

function result(status: LatestOrderStatus, message: string, extra: Partial<LatestOrderResult> = {}): LatestOrderResult {
  return { status, message, order: null, matchedOn: null, identifiers: [], candidates: [], matches: 0, text: "", complete: false, chars: 0, textSha256: null, ...extra };
}

/**
 * Choose and read the matter's latest order (see the module comment). The matter id must already be authorized by the
 * caller (a route, or a workflow run whose matter was authorized when it started). Facade outages other than "not
 * configured / not wired" are thrown (the caller fails or retries); they are never reported as "no order".
 */
export async function findLatestMatterOrder(matterId: string, opts: LatestOrderOptions = {}, deps: LatestOrderDeps = {}): Promise<LatestOrderResult> {
  requireMatter(matterId);
  const { checkable } = splitIdentifiers(getTracking(matterId));
  const caseNumber = (opts.caseNumber ?? "").replace(/\s+/g, " ").trim();
  if (!checkable.length) {
    return result("untracked", `No case number or diary number the official sources can match is tracked for this matter, so no order was looked up.${caseNumber ? ` "${caseNumber}" is not tracked on it.` : ""} Add the matter's case number under Tracked identifiers on its Hearings tab.`);
  }
  const n = narrow(checkable, opts.forum ?? "", caseNumber);
  if (!n.ok) return result(n.status, n.message, { identifiers: checkable.map((i) => i.printed) });
  const ids = n.ids;
  const identifiers = ids.map((i) => i.printed);
  const lookedUp = printedList(ids);

  let docs: SourceDocument[];
  try {
    docs = await (deps.orders ?? ordersForIdentifiers)(ids.map(({ forum, kind, value }) => ({ forum, kind, value })), { limit: 100 });
  } catch (e) {
    if (officialUnavailable(e)) return result("not_available", `Published orders could not be checked: the official-sources corpus is not available on this deployment. Nothing was looked up for ${lookedUp}.`, { identifiers });
    throw e;
  }
  // Defence in depth: only orders / judgments whose published metadata carries one of these identifiers exactly.
  const seen = new Set<string>();
  const exact: { doc: SourceDocument; on: TrackedIdentifier }[] = [];
  for (const d of docs) {
    if (seen.has(d.id)) continue;
    const on = orderCarries(d, ids);
    if (!on) continue;
    seen.add(d.id);
    exact.push({ doc: d, on });
  }
  exact.sort((a, b) => (b.doc.docDate ?? "").localeCompare(a.doc.docDate ?? "") || a.doc.id.localeCompare(b.doc.id));
  const matches = exact.length;
  const listed = exact.slice(0, MAX_CANDIDATES).map((x) => candidate(x.doc));
  if (!matches) return result("not_found", `No published order or judgment carries ${ids.length === 1 ? "the identifier" : "any of the identifiers"} ${lookedUp} in the official sources loaded. No other case's order is used in its place.`, { identifiers });

  let chosen: { doc: SourceDocument; on: TrackedIdentifier } | undefined;
  const ref = (opts.orderRef ?? "").trim();
  if (ref) {
    const id = ref.startsWith("src://") ? parseSourceRef(ref)?.documentId : DOC_ID.test(ref) ? ref : undefined;
    chosen = id ? exact.find((x) => x.doc.id === id) : undefined;
    if (!chosen) return result("not_linked", `The order "${ref}" is not one of this matter's exact matches for ${lookedUp}, so it was not read. Choose one of the orders listed.`, { identifiers, candidates: listed, matches });
  } else {
    const dated = exact.filter((x) => x.doc.docDate && isValidIsoDate(x.doc.docDate));
    if (!dated.length) return result("ambiguous", `${matches} order${matches === 1 ? "" : "s"} carr${matches === 1 ? "ies" : "y"} ${lookedUp} but no order date is printed, so the latest cannot be told. Name the order to read.`, { identifiers, candidates: listed, matches });
    const latest = dated[0].doc.docDate!;
    const tied = dated.filter((x) => x.doc.docDate === latest);
    if (tied.length > 1) return result("ambiguous", `${tied.length} orders for ${lookedUp} are dated ${latest}; the latest cannot be told apart. Name the order to read.`, { identifiers, candidates: tied.map((x) => candidate(x.doc)), matches });
    chosen = tied[0];
  }
  const d = chosen.doc;
  const order = { ...candidate(d), fileUrl: d.fileUrl, sha256: d.sha256, version: d.version, sourceId: d.sourceId, ocr: d.extraction === "ocr_model" || (d.ocrPages ?? []).length > 0, ocrPages: d.ocrPages ?? [] };
  const base = { identifiers, candidates: listed, matches, order, matchedOn: chosen.on };
  const undated = ref ? 0 : exact.filter((x) => !x.doc.docDate || !isValidIsoDate(x.doc.docDate)).length;
  if (d.status !== "indexed") return result("not_indexed", `The order "${d.title}" (${d.docDate ?? "date not printed"}) matches ${chosen.on.printed} exactly, but its text has not been extracted yet. Run again once it is indexed.`, base);

  let read;
  try {
    read = await readOrderText(d.id, { read: deps.read }, Math.max(2_000, Math.min(ORDER_MAX_CHARS, Math.floor(opts.maxChars ?? ORDER_MAX_CHARS))));
  } catch (e) {
    if (officialUnavailable(e)) return result("not_available", `The order "${d.title}" could not be read: the official-sources corpus is not available on this deployment.`, base);
    throw e;
  }
  // The text must be the chosen document's own (an unknown id is never replaced by another document).
  if (!read || !read.chunks.length || read.document.id !== d.id || read.document.status !== "indexed") return result("not_indexed", `The text of "${d.title}" could not be read from the official sources. Run again once it is indexed.`, base);
  const text = read.chunks.map((c) => `${pageLabel(c)}\n${c.text}`).join("\n\n");
  const notes = [
    undated ? `${undated} exact match${undated === 1 ? "" : "es"} without a printed date ${undated === 1 ? "was" : "were"} not considered for "latest".` : "",
    read.complete ? "" : `Only the first ${read.chars.toLocaleString("en-US")} characters of the order were read.`,
    order.ocr ? "Its text is partly OCR: check quotes against the PDF." : "",
  ].filter(Boolean).join(" ");
  const how = ref ? "the order named" : `the latest of ${matches} exact match${matches === 1 ? "" : "es"}`;
  return { ...result("found", `"${d.title}"${d.docDate ? ` dated ${d.docDate}` : ""}: ${how}, carrying ${chosen.on.printed} (${chosen.on.forum}) in its published metadata.${notes ? ` ${notes}` : ""}`, base), text, complete: read.complete, chars: read.chars, textSha256: read.textSha256 };
}
