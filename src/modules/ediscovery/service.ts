import "server-only";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { hybridSearch, indexDocuments, indexStats, type MatterRetrievalScope } from "@/lib/ai/vector-store";
import { VECTOR_COLLECTIONS } from "@/lib/ai/toolkit/internal";
import { tenantId } from "@/lib/auth/principal";

/** Retrieval scope for one matter: e-discovery reads and indexes never widen past the matter (constitution §22). */
export function matterRetrievalScope(matterId: string): MatterRetrievalScope {
  return { tenantId: tenantId(), matterIds: [matterId] };
}
import type { EDocument, IssueCode, PrivilegeLogEntry } from "@/lib/types/domain";
import { batesInRange, compareBates, exhibitMatches, exhibitValueLabel, isEmptyQuery, makeSnippet, matchesQuery, parseQuery, type ParsedQuery, type QueryNode, type Searchable } from "./query";
import { batches, redactions as redactionStore } from "./review-store";
import { currentUser } from "@/lib/current-user";
import { counselRoster, indexTextFor, isProducible, productionLoadFileCsv, productionSummary, templatePrivilegeDescription, toPrivilegeLogRow } from "./privilege";
import { CODING_RULES_KEY, DEFAULT_CODING_RULES } from "./rules";
import { compareExhibitMarks, exhibitSearchKey, type IndiaEDocument } from "./india";
import { audit } from "@/lib/integrity/audit";
import { contentHash } from "@/lib/integrity/hash";
import { updateProvenance } from "@/lib/integrity/store";
import {
  SCORE_BUCKETS,
  type BulkCodingRequest,
  type BulkPreview,
  type CodingPatch,
  type CodingStatus,
  type DocRow,
  type Facets,
  type GroupBy,
  type FamilyInfo,
  type IssueCodeInput,
  type MatterStats,
  type PrivilegeLogRow,
  type SavedView,
  type SavedViewCounts,
  type ScoreBucket,
  type SearchFilters,
  type SearchRequest,
  type SearchResponse,
  type SimilarDoc,
  type SortKey,
} from "./types";

/** The signed-in reviewer (LECLAUDE_USER_ID override honoured through @/lib/current-user). */
/** The acting reviewer id, resolved per call. */
export function currentUserId(): string { return currentUser().id; }
/** Maximum number of documents returned by a semantic (hybrid) search. */
export const SEMANTIC_K = 60;
/** Hard cap on rows per search page (the grid is virtualised; the client pages in 500s and refreshes with everything loaded). */
export const MAX_PAGE = 5000;
const RECENT_KEY = (matterId: string) => `ediscovery:recent:${matterId}`;
const RECENT_MAX = 25;

// ---------------------------------------------------------------------------
// Projections (cached per document object; the collection cache replaces
// objects on write so stale projections fall out automatically)
// ---------------------------------------------------------------------------

const searchableCache = new WeakMap<EDocument, Searchable>();

export function toSearchable(d: EDocument): Searchable {
  let s = searchableCache.get(d);
  if (s) return s;
  const lower = (x?: string) => (x ?? "").toLowerCase();
  const to = (d.to ?? []).join("; ").toLowerCase();
  const cc = (d.cc ?? []).join("; ").toLowerCase();
  s = {
    id: d.id,
    bates: d.bates,
    batesEnd: d.batesEnd,
    date: d.date,
    custodian: `${lower(d.custodianName)} ${lower(d.custodianId)}`,
    type: lower(d.type),
    from: lower(d.from),
    to,
    cc,
    subject: lower(d.subject),
    haystack: `${lower(d.bates)} ${lower((d as IndiaEDocument).india?.docNumber)} ${lower(d.subject)} ${lower(d.from)} ${to} ${cc} ${lower(d.custodianName)} ${lower(d.text)} ${(d.tags ?? []).join(" ").toLowerCase()}`,
    issues: (d.coding.issues ?? []).join(" ").toLowerCase(),
    tags: (d.tags ?? []).join(" ").toLowerCase(),
    hash: lower(d.hash),
    hot: !!d.coding.hot,
    privileged: d.coding.privileged ?? null,
    privilegeBasis: d.coding.privilegeBasis,
    responsive: d.coding.responsive ?? null,
    attachments: d.family?.attachmentIds?.length ?? 0,
    isAttachment: !!d.family?.parentId,
    family: lower(d.family?.parentId ?? d.id),
    thread: lower(d.family?.threadId),
    isDuplicate: !!d.isDuplicateOf,
    nearDuplicates: d.nearDuplicateIds?.length ?? 0,
    pages: d.pages ?? 1,
    reviewer: lower(d.coding.reviewerId),
    ...(exhibitSearchKey(d as IndiaEDocument) ? { exhibit: exhibitSearchKey(d as IndiaEDocument) } : {}),
  };
  searchableCache.set(d, s);
  return s;
}

/**
 * `family:` and `thread:` accept a Bates number or document id of any member; rewrite the
 * value to the family root id / thread id so the projection can match it exactly.
 */
function resolveFieldRefs(node: QueryNode, all: EDocument[]): QueryNode {
  const find = (v: string) => all.find((d) => d.id.toLowerCase() === v || d.bates.toLowerCase() === v || d.bates.toLowerCase().replace(/[-_ ]/g, "") === v.replace(/[-_ ]/g, ""));
  const walk = (n: QueryNode): QueryNode => {
    switch (n.kind) {
      case "and": case "or": return { kind: n.kind, children: n.children.map(walk) };
      case "not": return { kind: "not", child: walk(n.child) };
      case "prox": return { ...n, left: walk(n.left), right: walk(n.right) };
      case "field": {
        if (n.field === "family") { const d = find(n.value); return d ? { ...n, value: (d.family?.parentId ?? d.id).toLowerCase() } : n; }
        if (n.field === "thread") { const d = find(n.value); return d?.family?.threadId ? { ...n, value: d.family.threadId.toLowerCase() } : n; }
        if (n.field === "reviewer") { const p = db().people.findOne((x) => x.name.toLowerCase().includes(n.value)); return p ? { ...n, value: p.id.toLowerCase() } : n; }
        return n;
      }
      default: return n;
    }
  };
  return walk(node);
}

export function codingStatuses(d: EDocument): CodingStatus[] {
  const out: CodingStatus[] = [];
  if (d.coding.responsive === true) out.push("responsive");
  else if (d.coding.responsive === false) out.push("non_responsive");
  else out.push("needs_review");
  if (d.coding.privileged === true) out.push("privileged");
  if (d.coding.hot) out.push("hot");
  return out;
}

export function scoreBucket(d: EDocument): ScoreBucket {
  const s = d.aiScore;
  if (s == null) return "unscored";
  if (s >= 90) return "90+";
  if (s >= 70) return "70-89";
  if (s >= 50) return "50-69";
  return "<50";
}

function familyInfo(d: EDocument, byId: Map<string, EDocument>, threadSizes: Map<string, number>): FamilyInfo {
  return {
    isParent: (d.family?.attachmentIds?.length ?? 0) > 0,
    isAttachment: !!d.family?.parentId && byId.has(d.family.parentId),
    attachmentCount: d.family?.attachmentIds?.length ?? 0,
    inThread: !!d.family?.threadId,
    threadSize: d.family?.threadId ? (threadSizes.get(d.family.threadId) ?? 1) : 0,
    isDuplicate: !!d.isDuplicateOf,
    nearDuplicateCount: d.nearDuplicateIds?.length ?? 0,
  };
}

const ANALYSIS_KEY = (docId: string) => `ediscovery:analysis:${docId}`;

/** Rationale + confidence behind the AI suggestion, from the cached analysis or the prediction audit meta. */
export function aiSuggestionMeta(d: EDocument): { aiRationale?: string; aiConfidence?: number } {
  const out: { aiRationale?: string; aiConfidence?: number } = {};
  if (d.aiProvenance?.confidence != null) out.aiConfidence = d.aiProvenance.confidence;
  const cached = db().kv.get<{ suggestedCoding?: { rationale?: string } }>(ANALYSIS_KEY(d.id));
  if (cached?.suggestedCoding?.rationale) out.aiRationale = cached.suggestedCoding.rationale;
  else if (d.aiProvenance) {
    const meta = (d.aiProvenance as { meta?: { rationale?: string } }).meta;
    if (meta?.rationale) out.aiRationale = meta.rationale;
  }
  return out;
}

export function toRow(d: EDocument, byId: Map<string, EDocument>, threadSizes: Map<string, number>, extra: Partial<Pick<DocRow, "score" | "snippet" | "groupKey" | "groupIndex" | "groupSize">> = {}): DocRow {
  const { text, entities: _e, aiSummary: _s, ...rest } = d;
  void _e; void _s;
  const redactionCount = redactionCounts.get(d.matterId)?.get(d.id) ?? 0;
  return { ...rest, family2: familyInfo(d, byId, threadSizes), textLength: text.length, ...aiSuggestionMeta(d), ...(redactionCount ? { redactions: redactionCount } : {}), ...extra };
}

/** Per-matter redaction counts, refreshed on each search (cheap: the collection is memory-resident). */
const redactionCounts = new Map<string, Map<string, number>>();
function refreshRedactionCounts(matterId: string) {
  const m = new Map<string, number>();
  for (const r of redactionStore().all()) if (r.matterId === matterId) m.set(r.docId, (m.get(r.docId) ?? 0) + 1);
  redactionCounts.set(matterId, m);
}

// ---------------------------------------------------------------------------
// Matter-scoped document access
// ---------------------------------------------------------------------------

export function matterDocs(matterId: string): EDocument[] {
  return db().edocs.find((d) => d.matterId === matterId);
}

function indexes(docs: EDocument[]) {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const threadSizes = new Map<string, number>();
  for (const d of docs) if (d.family?.threadId) threadSizes.set(d.family.threadId, (threadSizes.get(d.family.threadId) ?? 0) + 1);
  return { byId, threadSizes };
}

export function recentIds(matterId: string): string[] {
  return db().kv.get<string[]>(RECENT_KEY(matterId)) ?? [];
}

export function recordView(matterId: string, docId: string) {
  const cur = recentIds(matterId).filter((id) => id !== docId);
  cur.unshift(docId);
  db().kv.set(RECENT_KEY(matterId), cur.slice(0, RECENT_MAX));
}

function viewPredicate(view: SavedView | undefined, matterId: string): (d: EDocument) => boolean {
  switch (view) {
    case "needs_review": return (d) => d.coding.responsive == null;
    case "hot": return (d) => !!d.coding.hot;
    case "privileged": return (d) => d.coding.privileged === true;
    case "ai_responsive": return (d) => (d.aiScore ?? 0) >= 70;
    case "recent": { const set = new Set(recentIds(matterId)); return (d) => set.has(d.id); }
    default: return () => true;
  }
}

export function viewCounts(matterId: string): SavedViewCounts[] {
  const docs = matterDocs(matterId);
  const views: SavedView[] = ["all", "needs_review", "hot", "privileged", "ai_responsive", "recent"];
  return views.map((view) => ({ view, count: docs.filter(viewPredicate(view, matterId)).length }));
}

// ---------------------------------------------------------------------------
// Faceting (each facet counted with every other filter applied)
// ---------------------------------------------------------------------------

type FacetKey = keyof SearchFilters;

function facetMatch(d: EDocument, key: FacetKey, values: string[]): boolean {
  if (!values.length) return true;
  switch (key) {
    case "custodians": return values.includes(d.custodianId);
    case "types": return values.includes(d.type);
    case "statuses": { const st = codingStatuses(d); return values.some((v) => st.includes(v as CodingStatus)); }
    case "issues": return values.some((v) => (d.coding.issues ?? []).includes(v));
    case "scores": return values.includes(scoreBucket(d));
    case "years": return values.includes(d.date.slice(0, 4));
    case "months": return values.includes(d.date.slice(0, 7));
  }
}

const FACET_KEYS: FacetKey[] = ["custodians", "types", "statuses", "issues", "scores", "years", "months"];

export function applyFilters(docs: EDocument[], filters: SearchFilters | undefined, except?: FacetKey): EDocument[] {
  if (!filters) return docs;
  return docs.filter((d) => FACET_KEYS.every((k) => k === except || facetMatch(d, k, (filters[k] as string[] | undefined) ?? [])));
}

export function computeFacets(base: EDocument[], filters: SearchFilters | undefined, matterId: string): Facets {
  const count = <T,>(list: EDocument[], keyOf: (d: EDocument) => T[]) => {
    const m = new Map<T, number>();
    for (const d of list) for (const k of keyOf(d)) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const custodianNames = new Map<string, string>();
  for (const d of base) custodianNames.set(d.custodianId, d.custodianName);
  const c = count(applyFilters(base, filters, "custodians"), (d) => [d.custodianId]);
  const t = count(applyFilters(base, filters, "types"), (d) => [d.type]);
  const s = count(applyFilters(base, filters, "statuses"), (d) => codingStatuses(d));
  const i = count(applyFilters(base, filters, "issues"), (d) => d.coding.issues ?? []);
  const sc = count(applyFilters(base, filters, "scores"), (d) => [scoreBucket(d)]);
  const y = count(applyFilters(base, filters, "years"), (d) => [d.date.slice(0, 4)]);
  const mo = count(applyFilters(base, filters, "months"), (d) => [d.date.slice(0, 7)]);
  const codes = new Map(db().issueCodes.find((x) => x.matterId === matterId).map((x) => [x.code, x]));
  const statusLabel: Record<CodingStatus, string> = { responsive: "Responsive", non_responsive: "Non-responsive", needs_review: "Needs review", privileged: "Privileged", hot: "Hot" };
  const sortDesc = (a: { count: number; label: string }, b: { count: number; label: string }) => b.count - a.count || a.label.localeCompare(b.label);
  return {
    custodian: Array.from(c.entries()).map(([value, n]) => ({ value, label: custodianNames.get(value) ?? value, count: n })).sort(sortDesc),
    type: Array.from(t.entries()).map(([value, n]) => ({ value, label: value, count: n })).sort(sortDesc),
    status: (["responsive", "needs_review", "non_responsive", "privileged", "hot"] as CodingStatus[]).map((v) => ({ value: v, label: statusLabel[v], count: s.get(v) ?? 0 })),
    issues: Array.from(new Set([...codes.keys(), ...i.keys()])).map((value) => ({ value, label: codes.get(value)?.label ?? value, count: i.get(value) ?? 0 })).sort(sortDesc),
    score: SCORE_BUCKETS.map((b) => ({ value: b.id, label: b.label, count: sc.get(b.id) ?? 0 })),
    years: Array.from(y.entries()).map(([year, n]) => ({ year, count: n })).sort((a, b) => a.year.localeCompare(b.year)),
    months: Array.from(mo.entries()).map(([year, n]) => ({ year, count: n })).sort((a, b) => a.year.localeCompare(b.year)),
  };
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export function sortDocs<T extends { doc: EDocument; score?: number }>(items: T[], sort: SortKey | undefined, dir: "asc" | "desc" | undefined): T[] {
  const mul = (dir ?? (sort === "aiScore" || sort === "relevance" ? "desc" : "asc")) === "desc" ? -1 : 1;
  const cmp: Record<SortKey, (a: T, b: T) => number> = {
    date: (a, b) => a.doc.date.localeCompare(b.doc.date) || compareBates(a.doc.bates, b.doc.bates),
    bates: (a, b) => compareBates(a.doc.bates, b.doc.bates),
    // Marked exhibits in mark order (Ex.P before Ex.D, numerically); unmarked documents after them by reference.
    exhibit: (a, b) => { const x = (a.doc as IndiaEDocument).india?.exhibit, y = (b.doc as IndiaEDocument).india?.exhibit; return x && y ? compareExhibitMarks(x, y) : x ? -1 : y ? 1 : compareBates(a.doc.bates, b.doc.bates); },
    custodian: (a, b) => a.doc.custodianName.localeCompare(b.doc.custodianName) || a.doc.date.localeCompare(b.doc.date),
    type: (a, b) => a.doc.type.localeCompare(b.doc.type) || a.doc.date.localeCompare(b.doc.date),
    subject: (a, b) => a.doc.subject.localeCompare(b.doc.subject),
    aiScore: (a, b) => (a.doc.aiScore ?? -1) - (b.doc.aiScore ?? -1) || compareBates(a.doc.bates, b.doc.bates),
    relevance: (a, b) => (a.score ?? 0) - (b.score ?? 0) || compareBates(b.doc.bates, a.doc.bates),
    from: (a, b) => (a.doc.from ?? "").localeCompare(b.doc.from ?? "") || compareBates(a.doc.bates, b.doc.bates),
    pages: (a, b) => (a.doc.pages ?? 1) - (b.doc.pages ?? 1) || compareBates(a.doc.bates, b.doc.bates),
    size: (a, b) => a.doc.text.length - b.doc.text.length || compareBates(a.doc.bates, b.doc.bates),
    family: (a, b) => (a.doc.family?.parentId ?? a.doc.id).localeCompare(b.doc.family?.parentId ?? b.doc.id) || compareBates(a.doc.bates, b.doc.bates),
    thread: (a, b) => (a.doc.family?.threadId ?? "~").localeCompare(b.doc.family?.threadId ?? "~") || a.doc.date.localeCompare(b.doc.date) || compareBates(a.doc.bates, b.doc.bates),
    reviewed: (a, b) => (a.doc.coding.reviewedAt ?? "").localeCompare(b.doc.coding.reviewedAt ?? "") || compareBates(a.doc.bates, b.doc.bates),
  };
  const fn = cmp[sort ?? "bates"];
  return [...items].sort((a, b) => fn(a, b) * mul);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchDocuments(req: SearchRequest): Promise<SearchResponse> {
  const t0 = Date.now();
  const all = matterDocs(req.matterId);
  const { byId, threadSizes } = indexes(all);
  const parsed: ParsedQuery = parseQuery(req.q ?? "");
  parsed.ast = resolveFieldRefs(parsed.ast, all);
  // An exhibit mark that no document in this matter carries is reported, never mapped to the nearest mark (§23).
  for (const f of parsed.fields) {
    if (f.field !== "exhibit") continue;
    if (!all.some((d) => exhibitMatches(toSearchable(d).exhibit, f.value))) parsed.warnings.push(`${exhibitValueLabel(f.value)} is not marked in this matter`);
  }
  const useSemantic = !!req.semantic && !!req.q?.trim();
  refreshRedactionCounts(req.matterId);

  let scored: { doc: EDocument; score?: number; snippet?: string }[];
  let inView = all.filter(viewPredicate(req.view, req.matterId));
  // Batch review mode / explicit id lists narrow the corpus before the query runs.
  const idSet = scopeIds(req);
  if (idSet) inView = inView.filter((d) => idSet.has(d.id));

  if (useSemantic) {
    // Hybrid (keyword BM25 + embeddings when available) over the vector index, restricted to this matter.
    // Capped to the top SEMANTIC_K by fused rank so the result set is a ranked shortlist, not the whole corpus.
    const hits = await hybridSearch(VECTOR_COLLECTIONS.edocs, req.q!, { k: SEMANTIC_K, perDoc: 1, scope: matterRetrievalScope(req.matterId), filter: (meta) => meta.matterId === req.matterId });
    const scoreById = new Map<string, { score: number; passage: string }>();
    for (const h of hits) if (!scoreById.has(h.docId)) scoreById.set(h.docId, { score: h.score, passage: h.text });
    // Structured parts of the query (fields, Bates, dates, NOT) still apply as hard filters.
    const structural = stripTerms(parsed);
    scored = inView
      .filter((d) => scoreById.has(d.id) && (structural.kind === "empty" || matchesQuery(toSearchable(d), structural)))
      .map((d) => ({ doc: d, score: scoreById.get(d.id)!.score, snippet: makeSnippet(scoreById.get(d.id)!.passage, parsed.terms) }));
  } else {
    const matched = isEmptyQuery(parsed) ? inView : inView.filter((d) => matchesQuery(toSearchable(d), parsed.ast));
    scored = matched.map((d) => ({ doc: d, snippet: parsed.terms.length ? makeSnippet(d.text, parsed.terms) : undefined }));
  }

  const base = scored.map((s) => s.doc);
  const facets = computeFacets(base, req.filters, req.matterId);
  const filteredIds = new Set(applyFilters(base, req.filters).map((d) => d.id));
  const filtered = scored.filter((s) => filteredIds.has(s.doc.id));
  const sort: SortKey = req.sort ?? (useSemantic ? "relevance" : "bates");
  let sorted = sortDocs(filtered, sort, req.dir);
  const groupBy: GroupBy = req.groupBy ?? "none";
  const groups = groupBy !== "none" ? groupRows(sorted, groupBy, byId) : null;
  if (groups) sorted = groups.rows;
  const limit = Math.min(MAX_PAGE, Math.max(1, req.limit ?? 100));
  const offset = Math.max(0, req.page && req.page > 0 ? (req.page - 1) * limit : (req.offset ?? 0));
  const page = sorted.slice(offset, offset + limit);
  return {
    hits: page.map((s) => toRow(s.doc, byId, threadSizes, { score: s.score, snippet: s.snippet, ...(groups?.meta.get(s.doc.id) ?? {}) })),
    total: sorted.length,
    totalWorkspace: all.length,
    offset,
    limit,
    page: Math.floor(offset / limit) + 1,
    pages: Math.max(1, Math.ceil(sorted.length / limit)),
    facets,
    parsed: { terms: parsed.terms, fields: parsed.fields, bates: parsed.bates.map((b) => ({ start: b.start.raw, end: b.end.raw })), warnings: parsed.warnings },
    tookMs: Date.now() - t0,
    semantic: useSemantic,
    groupBy,
  };
}

/** Id restriction for batch review mode (`batchId`, optionally its QC sample) or an explicit `ids` list. */
function scopeIds(req: SearchRequest): Set<string> | null {
  let set: Set<string> | null = null;
  if (req.batchId) {
    const b = batches().get(req.batchId);
    if (!b) return new Set();
    set = new Set(req.qc ? b.qcSampleIds : b.docIds);
  }
  if (req.ids?.length) {
    const ids = new Set(req.ids);
    set = set ? new Set([...set].filter((id) => ids.has(id))) : ids;
  }
  return set;
}

/** Reorder rows so each group (family / thread / near-dup cluster) is contiguous, head first; single-member groups stay in place. */
function groupRows<T extends { doc: EDocument }>(rows: T[], groupBy: GroupBy, byId: Map<string, EDocument>): { rows: T[]; meta: Map<string, { groupKey: string; groupIndex: number; groupSize: number }> } {
  const keyOf = (d: EDocument): string | null => {
    if (groupBy === "family") { const root = d.family?.parentId && byId.has(d.family.parentId) ? d.family.parentId : d.id; return (byId.get(root)?.family?.attachmentIds?.length ?? 0) > 0 ? root : null; }
    if (groupBy === "thread") return d.family?.threadId ?? null;
    if (groupBy === "neardup") {
      const cluster = new Set<string>([d.id, ...(d.nearDuplicateIds ?? []), ...(d.isDuplicateOf ? [d.isDuplicateOf] : [])]);
      for (const x of byId.values()) if (x.nearDuplicateIds?.includes(d.id) || x.isDuplicateOf === d.id) cluster.add(x.id);
      if (cluster.size < 2) return null;
      return Array.from(cluster).sort((a, b) => compareBates(byId.get(a)?.bates ?? a, byId.get(b)?.bates ?? b))[0];
    }
    return null;
  };
  const buckets = new Map<string, T[]>();
  const order: { key: string | null; row: T }[] = [];
  for (const r of rows) {
    const key = keyOf(r.doc);
    if (key) { const list = buckets.get(key); if (list) { list.push(r); continue; } buckets.set(key, [r]); }
    order.push({ key, row: r });
  }
  const out: T[] = [];
  const meta = new Map<string, { groupKey: string; groupIndex: number; groupSize: number }>();
  for (const o of order) {
    if (!o.key) { out.push(o.row); continue; }
    const list = buckets.get(o.key)!;
    // Head of the group: the family root / earliest message / primary of the cluster when present in the results.
    const headIdx = list.findIndex((r) => r.doc.id === o.key);
    const ordered = headIdx > 0 ? [list[headIdx], ...list.filter((_, i) => i !== headIdx)] : list;
    ordered.forEach((r, i) => { meta.set(r.doc.id, { groupKey: o.key!, groupIndex: i, groupSize: ordered.length }); out.push(r); });
  }
  return { rows: out, meta };
}

/** Remove free-text terms from a parsed query, keeping structural constraints (used by semantic mode). */
function stripTerms(parsed: ParsedQuery): ParsedQuery["ast"] {
  const walk = (n: ParsedQuery["ast"]): ParsedQuery["ast"] => {
    switch (n.kind) {
      case "term": return { kind: "empty" };
      case "and": case "or": {
        const kids = n.children.map(walk).filter((c) => c.kind !== "empty");
        return kids.length === 0 ? { kind: "empty" } : kids.length === 1 ? kids[0] : { kind: n.kind, children: kids };
      }
      case "not": { const c = walk(n.child); return c.kind === "empty" ? c : { kind: "not", child: c }; }
      case "prox": return { kind: "empty" };
      default: return n;
    }
  };
  return walk(parsed.ast);
}

/** Ordered ids for keyboard navigation / auto-advance: same query, no paging. */
export async function searchIds(req: SearchRequest): Promise<string[]> {
  const res = await searchDocuments({ ...req, offset: 0, limit: MAX_PAGE });
  return res.hits.map((h) => h.id);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function matterStats(matterId: string): MatterStats & { views: SavedViewCounts[] } {
  const docs = matterDocs(matterId);
  const matter = db().matters.get(matterId);
  const reviewed = docs.filter((d) => d.coding.responsive != null).length;
  const deadline = matter?.keyDates?.find((k) => /production/i.test(k.label)) ?? null;
  const daysLeft = deadline ? Math.ceil((new Date(deadline.date + "T00:00:00Z").getTime() - Date.now()) / 86_400_000) : 0;
  let indexed = { docs: 0, chunks: 0, embedded: 0 };
  try {
    const all = indexStats(VECTOR_COLLECTIONS.edocs);
    // per-matter doc count approximated from the collection; chunk/embed totals are collection-wide
    indexed = { docs: Math.min(all.docs, docs.length), chunks: all.chunks, embedded: all.embedded };
  } catch { /* ignore */ }
  return {
    matterId,
    total: docs.length,
    reviewed,
    pctReviewed: docs.length ? Math.round((reviewed / docs.length) * 100) : 0,
    needsReview: docs.length - reviewed,
    responsive: docs.filter((d) => d.coding.responsive === true).length,
    nonResponsive: docs.filter((d) => d.coding.responsive === false).length,
    privileged: docs.filter((d) => d.coding.privileged === true).length,
    hot: docs.filter((d) => !!d.coding.hot).length,
    aiScored: docs.filter((d) => d.aiScore != null).length,
    custodians: new Set(docs.map((d) => d.custodianId)).size,
    productionDeadline: deadline ? { label: deadline.label, date: deadline.date, daysLeft } : null,
    indexed,
    views: viewCounts(matterId),
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocDetail {
  doc: EDocument;
  family: {
    parent: DocRow | null;
    attachments: DocRow[];
    thread: DocRow[];
    duplicateOf: DocRow | null;
    duplicates: DocRow[];
    nearDuplicates: DocRow[];
  };
  row: DocRow;
  reviewerName?: string;
}

export function getDocument(id: string, opts: { recordView?: boolean } = {}): DocDetail | null {
  const d = db().edocs.get(id) ?? db().edocs.findOne((x) => x.bates.toLowerCase() === id.toLowerCase());
  if (!d) return null;
  const all = matterDocs(d.matterId);
  const { byId, threadSizes } = indexes(all);
  const row = (x: EDocument) => toRow(x, byId, threadSizes);
  const parent = d.family?.parentId ? byId.get(d.family.parentId) ?? null : null;
  const attachments = (d.family?.attachmentIds ?? []).map((x) => byId.get(x)).filter(Boolean) as EDocument[];
  const thread = d.family?.threadId ? all.filter((x) => x.family?.threadId === d.family?.threadId).sort((a, b) => a.date.localeCompare(b.date) || compareBates(a.bates, b.bates)) : [];
  const duplicateOf = d.isDuplicateOf ? byId.get(d.isDuplicateOf) ?? null : null;
  const duplicates = all.filter((x) => x.isDuplicateOf === d.id || (d.hash && x.hash === d.hash && x.id !== d.id && !x.isDuplicateOf && !d.isDuplicateOf));
  const nearDuplicates = Array.from(new Set([...(d.nearDuplicateIds ?? []), ...all.filter((x) => x.nearDuplicateIds?.includes(d.id)).map((x) => x.id)])).map((x) => byId.get(x)).filter(Boolean) as EDocument[];
  if (opts.recordView) recordView(d.matterId, d.id);
  const reviewer = d.coding.reviewerId ? db().people.get(d.coding.reviewerId) : null;
  return {
    doc: d,
    row: row(d),
    family: { parent: parent ? row(parent) : null, attachments: attachments.map(row), thread: thread.map(row), duplicateOf: duplicateOf ? row(duplicateOf) : null, duplicates: duplicates.map(row), nearDuplicates: nearDuplicates.map(row) },
    reviewerName: reviewer?.name,
  };
}

export function updateCoding(id: string, patch: CodingPatch, reviewerId: string = currentUserId()): EDocument | null {
  const cur = db().edocs.get(id);
  if (!cur) return null;
  const coding = { ...cur.coding, ...patch };
  if (coding.privileged !== true) delete coding.privilegeBasis;
  if (coding.issues) coding.issues = Array.from(new Set(coding.issues));
  coding.reviewerId = reviewerId;
  coding.reviewedAt = new Date().toISOString();
  const next = db().edocs.put({ ...cur, coding });
  const changed = codingDiff(cur.coding, coding);
  if (changed.length) audit("coding.change", { kind: "edoc", id: cur.id, label: cur.bates, matterId: cur.matterId }, { fields: changed, before: pick(cur.coding, changed), after: pick(coding, changed), aiScore: cur.aiScore, aiSuggested: cur.aiIssues }, { id: reviewerId, name: db().people.get(reviewerId)?.name ?? reviewerId });
  // A human decision on an AI-scored document settles its prediction: mark the prediction reviewed so it leaves the queue.
  if (cur.aiProvenance && cur.aiProvenance.review?.status === "pending" && (patch.responsive !== undefined || patch.privileged !== undefined)) {
    db().edocs.update(cur.id, (x) => ({ ...x, aiProvenance: x.aiProvenance ? { ...x.aiProvenance, review: { status: "approved", by: db().people.get(reviewerId)?.name ?? reviewerId, at: coding.reviewedAt, note: "Reviewer coded the document" } } : x.aiProvenance }));
    for (const k of ["edoc.prediction", "edoc.analysis"] as const) updateProvenance(k, cur.id, (p) => (p.review?.status === "pending" ? { ...p, review: { status: "approved", by: db().people.get(reviewerId)?.name ?? reviewerId, at: coding.reviewedAt, note: "Reviewer coded the document" } } : p));
  }
  return next;
}

/** Parents and attachments of the given documents (same matter), so a family can be coded together. */
export function expandFamilies(ids: string[]): { ids: string[]; added: number } {
  const set = new Set(ids);
  const before = set.size;
  for (const id of ids) {
    const d = db().edocs.get(id);
    if (!d) continue;
    const root = d.family?.parentId ? db().edocs.get(d.family.parentId) : d;
    if (root && root.matterId === d.matterId) {
      set.add(root.id);
      for (const a of root.family?.attachmentIds ?? []) { const att = db().edocs.get(a); if (att && att.matterId === d.matterId) set.add(a); }
    }
  }
  return { ids: Array.from(set), added: set.size - before };
}

const FIELD_LABELS: Record<string, string> = { responsive: "Responsive", privileged: "Privileged", privilegeBasis: "Privilege basis", hot: "Hot", confidentiality: "Confidentiality", notes: "Notes", reviewerId: "Reviewer" };

function fmtCodingValue(v: unknown): string {
  if (v == null) return "cleared";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** The effect of a bulk coding request without applying it: per-field change counts, families pulled in and overwrites. */
export function bulkPreview(req: BulkCodingRequest): BulkPreview {
  const base = Array.from(new Set(req.ids));
  const expanded = req.includeFamilies ? expandFamilies(base) : { ids: base, added: 0 };
  const docs = expanded.ids.map((id) => db().edocs.get(id)).filter((d): d is EDocument => !!d);
  const fields: BulkPreview["fields"] = [];
  const touched = new Set<string>();
  for (const [field, value] of Object.entries(req.patch ?? {})) {
    if (value === undefined) continue;
    const changed = docs.filter((d) => JSON.stringify((d.coding as Record<string, unknown>)[field] ?? null) !== JSON.stringify(value ?? null));
    changed.forEach((d) => touched.add(d.id));
    fields.push({ field, label: FIELD_LABELS[field] ?? field, to: fmtCodingValue(value), changed: changed.length });
  }
  if (req.addIssues?.length) {
    const changed = docs.filter((d) => req.addIssues!.some((i) => !(d.coding.issues ?? []).includes(i)));
    changed.forEach((d) => touched.add(d.id));
    fields.push({ field: "issues", label: "Add issue codes", to: req.addIssues.join(", "), changed: changed.length });
  }
  if (req.removeIssues?.length) {
    const changed = docs.filter((d) => req.removeIssues!.some((i) => (d.coding.issues ?? []).includes(i)));
    changed.forEach((d) => touched.add(d.id));
    fields.push({ field: "issues", label: "Remove issue codes", to: req.removeIssues.join(", "), changed: changed.length });
  }
  if (req.reviewerId) {
    const changed = docs.filter((d) => d.coding.reviewerId !== req.reviewerId);
    changed.forEach((d) => touched.add(d.id));
    fields.push({ field: "reviewerId", label: "Reviewer", to: db().people.get(req.reviewerId)?.name ?? req.reviewerId, changed: changed.length });
  }
  const overwrites = req.patch?.responsive === undefined ? 0 : docs.filter((d) => d.coding.responsive != null && d.coding.responsive !== req.patch.responsive).length;
  return { ids: docs.map((d) => d.id), total: docs.length, addedFamily: expanded.added, unchanged: docs.length - touched.size, fields, overwrites };
}

export function bulkCode(req: BulkCodingRequest): { updated: number } {
  let updated = 0;
  const ids = req.includeFamilies ? expandFamilies(Array.from(new Set(req.ids))).ids : Array.from(new Set(req.ids));
  const docs = ids.map((id) => db().edocs.get(id)).filter(Boolean) as EDocument[];
  const now = new Date().toISOString();
  const reviewerId = req.reviewerId ?? currentUserId();
  const next = docs.map((cur) => {
    const coding = { ...cur.coding, ...req.patch };
    let issues = coding.issues ?? [];
    if (req.addIssues?.length) issues = Array.from(new Set([...issues, ...req.addIssues]));
    if (req.removeIssues?.length) issues = issues.filter((i) => !req.removeIssues!.includes(i));
    coding.issues = issues;
    if (coding.privileged !== true) delete coding.privilegeBasis;
    coding.reviewerId = reviewerId;
    coding.reviewedAt = now;
    updated++;
    return { ...cur, coding };
  });
  db().edocs.putMany(next);
  if (next.length) audit("coding.change", { kind: "edoc", label: `bulk coding of ${next.length} documents`, matterId: next[0].matterId }, { ids: next.slice(0, 200).map((d) => d.id), bates: next.slice(0, 50).map((d) => d.bates), patch: req.patch, addIssues: req.addIssues, removeIssues: req.removeIssues }, { id: reviewerId, name: db().people.get(reviewerId)?.name ?? reviewerId });
  return { updated };
}

const CODING_FIELDS: (keyof EDocument["coding"])[] = ["responsive", "privileged", "privilegeBasis", "hot", "confidentiality", "issues", "notes"];

function codingDiff(a: EDocument["coding"], b: EDocument["coding"]): string[] {
  return CODING_FIELDS.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).map(String);
}

function pick(o: EDocument["coding"], keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (o as Record<string, unknown>)[k];
  return out;
}

// ---------------------------------------------------------------------------
// Document ingest (hash + duplicate linking on every creation path)
// ---------------------------------------------------------------------------

export type CreateDocumentInput = Omit<EDocument, "id" | "hash" | "coding" | "isDuplicateOf" | "custodianName"> & { id?: string; coding?: Partial<EDocument["coding"]>; custodianName?: string; hash?: string };

/**
 * Create an e-discovery document: computes the content hash, links it to an
 * existing identical document in the matter (isDuplicateOf) and audits the
 * creation. Never creates a second Bates number for the same id.
 */
export function createDocument(input: CreateDocumentInput, opts: { source?: string } = {}): { doc: EDocument; duplicateOf: EDocument | null; created: boolean } {
  const d = db();
  const id = input.id ?? `ed_${nanoid(10)}`;
  const existing = d.edocs.get(id);
  if (existing) return { doc: existing, duplicateOf: existing.isDuplicateOf ? d.edocs.get(existing.isDuplicateOf) : null, created: false };
  const hash = input.hash ?? contentHash(input.text ?? "");
  const primary = d.edocs.findOne((x) => x.matterId === input.matterId && (x.hash ?? contentHash(x.text)) === hash && !x.isDuplicateOf) ?? null;
  const sameBates = d.edocs.findOne((x) => x.matterId === input.matterId && x.bates.toUpperCase() === input.bates.toUpperCase());
  if (sameBates) throw Object.assign(new Error(`Bates ${input.bates} already exists in this matter (${sameBates.id})`), { status: 409, existingId: sameBates.id });
  const custodianName = input.custodianName ?? d.people.get(input.custodianId)?.name ?? "Unknown custodian";
  const doc: EDocument = { ...input, id, custodianName, hash, coding: { ...(input.coding ?? {}) }, isDuplicateOf: primary?.id, source: input.source ?? opts.source };
  d.edocs.put(doc);
  audit("create", { kind: "edoc", id, label: doc.bates, matterId: doc.matterId }, { source: opts.source ?? input.source, hash, duplicateOf: primary?.id, type: doc.type, custodian: doc.custodianName });
  return { doc, duplicateOf: primary, created: true };
}

/** Backfill hashes and duplicate links for a matter (idempotent; used by scans and the index rebuild). */
export function ensureHashes(matterId: string): { hashed: number; linked: number } {
  const d = db();
  const docs = matterDocs(matterId);
  const byHash = new Map<string, EDocument>();
  let hashed = 0, linked = 0;
  const updates: EDocument[] = [];
  for (const doc of [...docs].sort((a, b) => compareBates(a.bates, b.bates))) {
    let next = doc;
    if (!next.hash) { next = { ...next, hash: contentHash(next.text) }; hashed++; }
    const primary = byHash.get(next.hash!);
    if (!primary) byHash.set(next.hash!, next);
    else if (!next.isDuplicateOf && primary.id !== next.id) { next = { ...next, isDuplicateOf: primary.id }; linked++; }
    if (next !== doc) updates.push(next);
  }
  if (updates.length) d.edocs.putMany(updates);
  return { hashed, linked };
}

// ---------------------------------------------------------------------------
// Similar documents (family relations first, then hybrid search)
// ---------------------------------------------------------------------------

export async function similarDocuments(id: string, k = 10): Promise<SimilarDoc[]> {
  const detail = getDocument(id);
  if (!detail) return [];
  const { doc } = detail;
  const out: SimilarDoc[] = [];
  const seen = new Set<string>([doc.id]);
  const push = (r: DocRow, reason: SimilarDoc["reason"], score: number, passage: string) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ id: r.id, bates: r.bates, subject: r.subject, date: r.date, custodianName: r.custodianName, type: r.type, score, passage, reason });
  };
  if (detail.family.duplicateOf) push(detail.family.duplicateOf, "duplicate", 1, "Exact duplicate (same hash).");
  for (const r of detail.family.duplicates) push(r, "duplicate", 1, "Exact duplicate (same hash).");
  for (const r of detail.family.nearDuplicates) push(r, "near-duplicate", 0.95, "Near-duplicate / draft version.");
  if (detail.family.parent) push(detail.family.parent, "family", 0.9, "Parent document.");
  for (const r of detail.family.attachments) push(r, "family", 0.9, "Attachment.");
  for (const r of detail.family.thread) push(r, "thread", 0.85, "Same email thread.");
  const all = matterDocs(doc.matterId);
  const terms = distinctiveTerms(doc, all, 10);
  // Hybrid search (embeddings + BM25 when a key exists; BM25 only otherwise). Try a broad query first, then a tighter one.
  for (const q of [terms.join(" "), terms.slice(0, 4).join(" ")]) {
    if (out.length >= k || !q) break;
    try {
      const hits = await hybridSearch(VECTOR_COLLECTIONS.edocs, q, { k: k + seen.size + 2, perDoc: 1, scope: matterRetrievalScope(doc.matterId), filter: (meta) => meta.matterId === doc.matterId });
      for (const h of hits) {
        if (seen.has(h.docId)) continue;
        const other = db().edocs.get(h.docId);
        if (!other) continue;
        push(toRow(other, new Map(), new Map()), h.semantic != null ? "semantic" : "keyword", Number(h.score.toFixed(3)), makeSnippet(h.text, terms, 90));
        if (out.length >= k) break;
      }
    } catch (e) {
      console.warn("[ediscovery] similar search failed:", (e as Error).message);
    }
  }
  // Term-overlap fallback so the tab is never empty on small corpora.
  if (out.length < k && terms.length) {
    const scored = all
      .filter((x) => !seen.has(x.id))
      .map((x) => { const hay = toSearchable(x).haystack; const n = terms.filter((t) => hay.includes(t)).length; return { x, n }; })
      .filter((r) => r.n >= Math.max(2, Math.ceil(terms.length / 3)))
      .sort((a, b) => b.n - a.n || a.x.date.localeCompare(b.x.date));
    for (const r of scored) { push(toRow(r.x, new Map(), new Map()), "keyword", Number((r.n / terms.length).toFixed(3)), makeSnippet(r.x.text, terms, 90)); if (out.length >= k) break; }
  }
  return out.slice(0, k);
}

const STOP = new Set("the and for that with this from have will would there their they been were which what when where about into your please than then them these those also because only over under after before between during through more most some such very just should could might must shall does done being other same each into upon within without regarding subject sent date from cc to re fw fwd".split(" "));

/** Frequent, non-generic terms of a document (terms present in >60% of the matter's docs are ignored). */
export function distinctiveTerms(doc: EDocument, corpus: EDocument[], n = 10): string[] {
  const words = `${doc.subject} ${doc.subject} ${doc.text}`.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? [];
  const tf = new Map<string, number>();
  for (const w of words) if (!STOP.has(w)) tf.set(w, (tf.get(w) ?? 0) + 1);
  const candidates = Array.from(tf.entries()).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 40);
  const limit = Math.max(1, Math.floor(corpus.length * 0.6));
  const df = (t: string) => { let c = 0; for (const d of corpus) if (toSearchable(d).haystack.includes(t)) { c++; if (c > limit) break; } return c; };
  return candidates.filter(([t]) => df(t) <= limit).slice(0, n).map(([t]) => t);
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export async function rebuildIndex(matterId: string, opts: { embed?: boolean } = {}) {
  const docs = matterDocs(matterId);
  const res = await indexDocuments(VECTOR_COLLECTIONS.edocs, docs.map((d) => ({ id: d.id, text: indexTextFor(d), meta: { matterId: d.matterId, custodianId: d.custodianId, type: d.type, date: d.date, bates: d.bates } })), { embed: opts.embed ?? true, scope: matterRetrievalScope(matterId) });
  return { matterId, ...res };
}

// ---------------------------------------------------------------------------
// Issue codes
// ---------------------------------------------------------------------------

export function listIssueCodes(matterId: string): IssueCode[] {
  const docs = matterDocs(matterId);
  const counts = new Map<string, number>();
  for (const d of docs) for (const c of d.coding.issues ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
  return db().issueCodes
    .find((c) => c.matterId === matterId)
    .map((c) => ({ ...c, count: counts.get(c.code) ?? 0 }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function createIssueCode(matterId: string, input: IssueCodeInput): IssueCode {
  const code = input.code.trim().toUpperCase();
  if (!code) throw new Error("Code is required");
  if (db().issueCodes.findOne((c) => c.matterId === matterId && c.code === code)) throw new Error(`Issue code ${code} already exists`);
  const ic: IssueCode = { id: `ic_${nanoid(8)}`, matterId, code, label: input.label.trim() || code, description: input.description?.trim() || undefined, color: input.color ?? "chart-1", parentId: input.parentId || undefined };
  return db().issueCodes.put(ic);
}

/** A small, generic starter set for a new matter (no case-specific codes). */
export const STANDARD_ISSUE_CODES: IssueCodeInput[] = [
  { code: "RESP", label: "Responsive", description: "Responsive to one or more document requests.", color: "chart-2" },
  { code: "NR", label: "Not responsive", description: "Outside the scope of the requests.", color: "chart-3" },
  { code: "HOT", label: "Hot", description: "Likely exhibit or key document for either side.", color: "destructive" },
  { code: "PRIV-AC", label: "Privileged — attorney-client", description: "Confidential communication with counsel for legal advice; log before production.", color: "primary" },
  { code: "PRIV-WP", label: "Privileged — work product", description: "Prepared in anticipation of litigation; log before production.", color: "primary" },
  { code: "CONF", label: "Confidential", description: "Produce under the protective order's confidentiality designation.", color: "warning" },
];

/** Add the standard set to a matter, skipping codes it already has. Idempotent. */
export function addStandardIssueCodes(matterId: string): { created: IssueCode[]; skipped: string[] } {
  const created: IssueCode[] = [];
  const skipped: string[] = [];
  for (const c of STANDARD_ISSUE_CODES) {
    if (db().issueCodes.findOne((x) => x.matterId === matterId && x.code === c.code)) { skipped.push(c.code); continue; }
    created.push(createIssueCode(matterId, c));
  }
  if (created.length) audit("create", { kind: "issueCode", label: `standard issue codes (${created.length})`, matterId }, { codes: created.map((c) => c.code) });
  return { created, skipped };
}

export function updateIssueCode(id: string, patch: Partial<IssueCodeInput>): IssueCode | null {
  const cur = db().issueCodes.get(id);
  if (!cur) return null;
  const nextCode = patch.code ? patch.code.trim().toUpperCase() : cur.code;
  if (nextCode !== cur.code) {
    if (db().issueCodes.findOne((c) => c.matterId === cur.matterId && c.code === nextCode)) throw new Error(`Issue code ${nextCode} already exists`);
    const affected = matterDocs(cur.matterId).filter((d) => d.coding.issues?.includes(cur.code));
    db().edocs.putMany(affected.map((d) => ({ ...d, coding: { ...d.coding, issues: d.coding.issues!.map((i) => (i === cur.code ? nextCode : i)) } })));
  }
  if (patch.parentId === id) patch.parentId = undefined;
  return db().issueCodes.put({ ...cur, ...patch, code: nextCode, parentId: patch.parentId === "" ? undefined : (patch.parentId ?? cur.parentId) });
}

export function deleteIssueCode(id: string): boolean {
  const cur = db().issueCodes.get(id);
  if (!cur) return false;
  const affected = matterDocs(cur.matterId).filter((d) => d.coding.issues?.includes(cur.code));
  db().edocs.putMany(affected.map((d) => ({ ...d, coding: { ...d.coding, issues: d.coding.issues!.filter((i) => i !== cur.code) } })));
  for (const child of db().issueCodes.find((c) => c.parentId === id)) db().issueCodes.put({ ...child, parentId: cur.parentId });
  return db().issueCodes.delete(id);
}

// ---------------------------------------------------------------------------
// Coding rules
// ---------------------------------------------------------------------------

export function getCodingRules(matterId: string): string {
  return db().kv.get<string>(CODING_RULES_KEY(matterId)) ?? DEFAULT_CODING_RULES.default;
}

export function setCodingRules(matterId: string, text: string) {
  db().kv.set(CODING_RULES_KEY(matterId), text);
  return text;
}

// ---------------------------------------------------------------------------
// Privilege log
// ---------------------------------------------------------------------------

export function listPrivilegeLog(matterId: string): PrivilegeLogRow[] {
  return db().privilegeLog
    .find((e) => e.matterId === matterId)
    .map((e) => toPrivilegeLogRow(e, db().edocs.get(e.docId)))
    .sort((a, b) => compareBates(a.bates.split(" ")[0], b.bates.split(" ")[0]));
}

export function privilegedDocsWithoutEntry(matterId: string): EDocument[] {
  const have = new Set(db().privilegeLog.find((e) => e.matterId === matterId).map((e) => e.docId));
  return matterDocs(matterId).filter((d) => d.coding.privileged === true && !have.has(d.id));
}

export function basisLabel(d: EDocument) {
  switch (d.coding.privilegeBasis) {
    case "work-product": return "Work product";
    case "common-interest": return "Common interest";
    case "joint-defense": return "Joint defense";
    default: return "Attorney-client";
  }
}

export function upsertPrivilegeEntry(d: EDocument, description: string, status: PrivilegeLogEntry["status"] = "draft"): PrivilegeLogEntry {
  const existing = db().privilegeLog.get(`pl_${d.id}`);
  const entry: PrivilegeLogEntry = {
    id: `pl_${d.id}`,
    matterId: d.matterId,
    docId: d.id,
    bates: d.batesEnd ? `${d.bates} – ${d.batesEnd}` : d.bates,
    date: d.date,
    author: d.from ?? d.custodianName,
    recipients: [...(d.to ?? []), ...(d.cc ?? []).map((c) => `${c} (cc)`)],
    docType: d.type,
    basis: basisLabel(d),
    description,
    status: existing?.status === "final" && status === "draft" ? "final" : status,
  };
  return db().privilegeLog.put(entry);
}

export function updatePrivilegeEntry(id: string, patch: Partial<Pick<PrivilegeLogEntry, "description" | "status" | "basis" | "templateId">>): PrivilegeLogEntry | null {
  return db().privilegeLog.update(id, patch);
}

export function deletePrivilegeEntry(id: string) {
  return db().privilegeLog.delete(id);
}

/** Template-based generation (no AI). The AI variant lives in ai.ts and falls back to this. */
export function generatePrivilegeLogTemplate(matterId: string, opts: { regenerate?: boolean } = {}) {
  const docs = opts.regenerate ? matterDocs(matterId).filter((d) => d.coding.privileged === true) : privilegedDocsWithoutEntry(matterId);
  const roster = counselRoster(matterId);
  const entries = docs.map((d) => upsertPrivilegeEntry(d, templatePrivilegeDescription(d, roster)));
  // Remove entries for documents no longer coded privileged.
  const stale = db().privilegeLog.find((e) => e.matterId === matterId && db().edocs.get(e.docId)?.coding.privileged !== true);
  for (const e of stale) db().privilegeLog.delete(e.id);
  return { created: entries.length, removed: stale.length, ai: false };
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

export function production(matterId: string) {
  return productionSummary(matterId, matterDocs(matterId));
}

export function productionCsv(matterId: string) {
  const docs = matterDocs(matterId).filter(isProducible).sort((a, b) => compareBates(a.bates, b.bates));
  return productionLoadFileCsv(docs);
}

/** Bates lookup helper shared by routes. */
export function findByBatesRange(matterId: string, start: string, end: string): EDocument[] {
  const p = parseQuery(`${start}-${end}`);
  const range = p.bates[0];
  if (!range) return [];
  return matterDocs(matterId).filter((d) => batesInRange(d.bates, range, d.batesEnd)).sort((a, b) => compareBates(a.bates, b.bates));
}
