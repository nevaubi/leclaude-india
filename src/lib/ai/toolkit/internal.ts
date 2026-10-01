import "server-only";
import { defineTool, ToolExecutionError, truncationMarker, type EvidenceProvenance, type ToolContext, type ToolErrorShape } from "../tools";
import { db } from "@/lib/db";
import { configuredTenantId, hybridSearch, isCorpusScope, VECTOR_COLLECTIONS, type CorpusRetrievalScope, type MatterRetrievalScope, type RetrievalCorpus, type RetrievalScope } from "../vector-store";
import { currentPrincipal } from "@/lib/auth/context";
import { hasMatterAccess } from "@/lib/auth/policy";
import { accessibleMatterIds } from "@/lib/auth/scope";
import type { MatterScope, Principal } from "@/lib/auth/types";
import { contentHash } from "@/lib/integrity/hash";
import type { DepositionQA, EDocument, LibraryItem, Matter } from "@/lib/types/domain";
import { forumContextFor } from "@/modules/courts/context";
import type { IndianCaseInfo } from "@/modules/matters/india";

export { VECTOR_COLLECTIONS };

// ---------------------------------------------------------------------------
// Stable source identifiers (constitution §25, §53.4). Server-resolvable; never trusted from the model.
// ---------------------------------------------------------------------------

/** matter://<matterId>/document/<documentId>[/page/<page> | /chunk/<index>] — page when a page map exists, chunk otherwise. */
export function documentSource(matterId: string, documentId: string, loc: { page?: number; chunk?: number } = {}): string {
  const base = `matter://${enc(matterId)}/document/${enc(documentId)}`;
  if (typeof loc.page === "number") return `${base}/page/${loc.page}`;
  if (typeof loc.chunk === "number") return `${base}/chunk/${loc.chunk}`;
  return base;
}

/** depo://<matterId>/<depositionId>/p/<page>/l/<start>[-<end>] — the end line is appended only when it is known. */
export function depositionSource(matterId: string, depositionId: string, page: number, line: number, lineEnd?: number): string {
  return `depo://${enc(matterId)}/${enc(depositionId)}/p/${page}/l/${line}${typeof lineEnd === "number" && lineEnd !== line ? `-${lineEnd}` : ""}`;
}

/** library://<tenantId>/item/<itemId> — firm library items (templates, clauses, notes, matter work product). */
export function librarySource(tenantId: string, itemId: string): string {
  return `library://${enc(tenantId)}/item/${enc(itemId)}`;
}

/** intel://<tenantId>/document/<docId>[/chunk/<idx>] — the tenant-wide intelligence corpus. */
export function intelSource(tenantId: string, docId: string, chunk?: number): string {
  return `intel://${enc(tenantId)}/document/${enc(docId)}${typeof chunk === "number" ? `/chunk/${chunk}` : ""}`;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

// ---------------------------------------------------------------------------
// Scope resolution for tools: explicit ctx.scope → principal (ctx or request context) → ctx.state.matterId.
// A tool with no scope returns { error: "scope_required" } instead of searching everything.
// ---------------------------------------------------------------------------

export type ScopeResolution<T extends RetrievalScope> = { ok: true; scope: T } | { ok: false; error: ToolErrorShape };

const SCOPE_REQUIRED: ToolErrorShape = { error: "scope_required", code: "scope_required" };

function principalOf(ctx: ToolContext): Principal | null {
  if (ctx.principal) return ctx.principal;
  try { return currentPrincipal(); } catch { return null; }
}

function stateMatterId(ctx: ToolContext): string | undefined {
  const v = ctx.state?.matterId;
  return typeof v === "string" && v ? v : undefined;
}

function stateTenantId(ctx: ToolContext): string {
  const v = ctx.state?.tenantId;
  return typeof v === "string" && v ? v : configuredTenantId();
}

function outOfScope(matterId: string): ToolErrorShape {
  return { error: `matter ${matterId} is outside the current scope`, code: "unauthorized", status: 403 };
}

function narrowList(tenantId: string, matterIds: readonly string[], requested: string | undefined): ScopeResolution<MatterRetrievalScope> {
  if (requested) return matterIds.includes(requested) ? { ok: true, scope: { tenantId, matterIds: [requested] } } : { ok: false, error: outOfScope(requested) };
  return { ok: true, scope: { tenantId, matterIds: Array.from(new Set(matterIds)) } };
}

/**
 * The matter scope a tool may read matter evidence in. `requested` (the model's matter_id, else the run's
 * state.matterId) narrows the scope and is checked against it; it never widens it.
 */
export function resolveMatterScope(ctx: ToolContext, requestedMatterId?: string): ScopeResolution<MatterRetrievalScope> {
  const requested = requestedMatterId || stateMatterId(ctx);
  const s = ctx.scope as RetrievalScope | MatterScope | undefined;
  if (s) {
    if (!isCorpusScope(s)) return narrowList(s.tenantId, s.matterIds, requested);
    if (s.matterIds) return narrowList(s.tenantId, s.matterIds, requested);
    return { ok: false, error: { error: `the current scope is limited to the ${s.corpus} corpus; matter evidence is not available`, code: "unauthorized", status: 403 } };
  }
  const p = principalOf(ctx);
  if (p) {
    if (requested) return hasMatterAccess(p, requested) ? { ok: true, scope: { tenantId: p.tenantId, matterIds: [requested] } } : { ok: false, error: outOfScope(requested) };
    return { ok: true, scope: { tenantId: p.tenantId, matterIds: accessibleMatterIds(p) } };
  }
  const fromState = stateMatterId(ctx);
  if (fromState) {
    if (requested && requested !== fromState) return { ok: false, error: outOfScope(requested) };
    return { ok: true, scope: { tenantId: stateTenantId(ctx), matterIds: [fromState] } };
  }
  return { ok: false, error: SCOPE_REQUIRED };
}

/**
 * A tenant-wide corpus scope (library, intel, authority). Matter-linked rows of the corpus are limited to the
 * matters the run may touch; `requested` narrows further. A run scoped to one corpus cannot read another.
 */
export function resolveCorpusScope(ctx: ToolContext, corpus: RetrievalCorpus, requestedMatterId?: string): ScopeResolution<CorpusRetrievalScope> {
  const requested = requestedMatterId || stateMatterId(ctx);
  const s = ctx.scope as RetrievalScope | MatterScope | undefined;
  const withMatters = (tenantId: string, matterIds: readonly string[] | undefined): ScopeResolution<CorpusRetrievalScope> => {
    if (requested) {
      if (matterIds && !matterIds.includes(requested)) return { ok: false, error: outOfScope(requested) };
      return { ok: true, scope: { tenantId, corpus, matterIds: [requested] } };
    }
    return { ok: true, scope: matterIds ? { tenantId, corpus, matterIds: Array.from(new Set(matterIds)) } : { tenantId, corpus } };
  };
  if (s) {
    if (isCorpusScope(s)) {
      if (s.corpus !== corpus) return { ok: false, error: { error: `the current scope is limited to the ${s.corpus} corpus`, code: "unauthorized", status: 403 } };
      return withMatters(s.tenantId, s.matterIds);
    }
    return withMatters(s.tenantId, s.matterIds);
  }
  const p = principalOf(ctx);
  if (p) {
    if (requested) return hasMatterAccess(p, requested) ? { ok: true, scope: { tenantId: p.tenantId, corpus, matterIds: [requested] } } : { ok: false, error: outOfScope(requested) };
    return { ok: true, scope: { tenantId: p.tenantId, corpus, matterIds: accessibleMatterIds(p) } };
  }
  const fromState = stateMatterId(ctx);
  if (fromState) return { ok: true, scope: { tenantId: stateTenantId(ctx), corpus, matterIds: [fromState] } };
  return { ok: false, error: SCOPE_REQUIRED };
}

function inMatterScope(scope: MatterRetrievalScope, matterId: string | undefined | null): boolean {
  return !!matterId && scope.matterIds.includes(matterId);
}

function libraryItemInScope(scope: CorpusRetrievalScope, item: Pick<LibraryItem, "matterId">): boolean {
  return !item.matterId || !scope.matterIds || scope.matterIds.includes(item.matterId);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function keywordScore(text: string, terms: string[]) {
  const t = text.toLowerCase();
  let s = 0;
  for (const term of terms) { let i = 0; while ((i = t.indexOf(term, i)) >= 0) { s++; i += term.length; if (s > 50) break; } }
  return s;
}

/** Keyword fallback search when a vector index is empty. */
function keywordFallback<T>(items: T[], query: string, textOf: (t: T) => string, k: number): { item: T; score: number; excerpt: string }[] {
  const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!terms.length) return [];
  return items
    .map((item) => { const text = textOf(item); const score = keywordScore(text, terms); return { item, score, excerpt: excerptAround(text, terms[0]) }; })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function excerptAround(text: string, term: string, radius = 180) {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return text.slice(0, radius * 2).replace(/\s+/g, " ");
  return (i > radius ? "…" : "") + text.slice(Math.max(0, i - radius), i + radius).replace(/\s+/g, " ") + "…";
}

/** A bounded window of a long text with an explicit marker and the offset of the next window. */
export function textWindow(text: string, offset = 0, maxChars = 30_000): { text: string; window: { offset: number; length: number; total: number; next_offset: number | null } } {
  const start = Math.max(0, Math.min(Math.floor(offset), text.length));
  const end = Math.min(text.length, start + Math.max(1, Math.floor(maxChars)));
  const remaining = text.length - end;
  return { text: text.slice(start, end) + (remaining > 0 ? truncationMarker(remaining) : ""), window: { offset: start, length: end - start, total: text.length, next_offset: remaining > 0 ? end : null } };
}

function nameTokens(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}

/** Every token of the needle is a token (or token prefix) of the candidate name. */
export function nameMatches(candidate: string, needle: string): boolean {
  const n = nameTokens(needle);
  if (!n.length) return false;
  const c = nameTokens(candidate);
  return n.every((t) => c.some((w) => w === t || (t.length >= 3 && w.startsWith(t))));
}

function hashOf(doc: EDocument): string {
  return doc.hash ?? contentHash(doc.text);
}

// ---------------------------------------------------------------------------
// Scoped lookup helpers for the toolkit (people, documents, deposition passages). Never bind across matters.
// ---------------------------------------------------------------------------

export type PersonLink = "team" | "lead" | "custodian" | "witness";

export interface PersonMatch {
  id: string;
  name: string;
  role: string;
  title?: string;
  organization?: string;
  /** Matters in scope the person is linked to (team member, lead attorney, custodian, witness). */
  matter_ids: string[];
  linked_as: PersonLink[];
  documents: number;
  depositions: number;
}

/**
 * People linked to the matters in scope whose name matches. A person who only appears in another matter is not
 * returned even when the name matches exactly (constitution §44 cross-matter name collision).
 */
export function findPeople(name: string, scope: MatterRetrievalScope, opts: { limit?: number } = {}): PersonMatch[] {
  if (!nameTokens(name).length || !scope.matterIds.length) return [];
  const d = db();
  const links = new Map<string, { matters: Set<string>; as: Set<PersonLink>; documents: number; depositions: number }>();
  const link = (personId: string | undefined, matterId: string, as: PersonLink) => {
    if (!personId) return;
    let l = links.get(personId);
    if (!l) { l = { matters: new Set(), as: new Set(), documents: 0, depositions: 0 }; links.set(personId, l); }
    l.matters.add(matterId);
    l.as.add(as);
    if (as === "custodian") l.documents++;
    if (as === "witness") l.depositions++;
  };
  for (const mid of scope.matterIds) {
    const m = d.matters.get(mid);
    if (!m) continue;
    for (const id of m.teamIds) link(id, mid, "team");
    link(m.leadAttorneyId, mid, "lead");
  }
  for (const doc of d.edocs.all()) if (inMatterScope(scope, doc.matterId)) link(doc.custodianId, doc.matterId, "custodian");
  for (const dep of d.depositions.all()) if (inMatterScope(scope, dep.matterId)) link(dep.witnessId, dep.matterId, "witness");
  const out: PersonMatch[] = [];
  for (const [personId, l] of links) {
    const p = d.people.get(personId);
    if (!p || !nameMatches(p.name, name)) continue;
    out.push({ id: p.id, name: p.name, role: p.role, title: p.title, organization: p.organization, matter_ids: Array.from(l.matters).sort(), linked_as: Array.from(l.as), documents: l.documents, depositions: l.depositions });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, opts.limit ?? 20);
}

export interface DocumentMatch {
  source: string;
  id: string;
  bates: string;
  matter_id: string;
  date: string;
  custodian: string;
  type: string;
  subject: string;
  /** Where the name matched: custodian, from, to, cc, entity, subject. */
  matched: string[];
}

/** Matter documents in scope that mention a person by name (custodian, sender, recipients, extracted entities, subject). */
export function findDocuments(name: string, scope: MatterRetrievalScope, opts: { limit?: number } = {}): DocumentMatch[] {
  if (!nameTokens(name).length || !scope.matterIds.length) return [];
  const out: DocumentMatch[] = [];
  for (const doc of db().edocs.all()) {
    if (!inMatterScope(scope, doc.matterId)) continue;
    const matched: string[] = [];
    if (nameMatches(doc.custodianName, name)) matched.push("custodian");
    if (doc.from && nameMatches(doc.from, name)) matched.push("from");
    if (doc.to?.some((t) => nameMatches(t, name))) matched.push("to");
    if (doc.cc?.some((t) => nameMatches(t, name))) matched.push("cc");
    if (doc.entities?.people?.some((t) => nameMatches(t, name))) matched.push("entity");
    if (nameMatches(doc.subject, name)) matched.push("subject");
    if (!matched.length) continue;
    out.push({ source: documentSource(doc.matterId, doc.id), id: doc.id, bates: doc.bates, matter_id: doc.matterId, date: doc.date, custodian: doc.custodianName, type: doc.type, subject: doc.subject, matched });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, opts.limit ?? 25);
}

export interface DepositionPassage {
  source: string;
  deposition_id: string;
  matter_id: string;
  witness: string;
  date: string;
  volume?: number;
  page: number;
  line: number;
  question: string;
  answer: string;
  flags?: DepositionQA["flags"];
  exhibit?: string;
  objection?: DepositionQA["objection"];
  score: number;
}

/** Deterministic keyword search over deposition Q/A segments in scope; each hit carries an exact page:line source. */
export function findDepositionPassages(query: string, scope: MatterRetrievalScope, opts: { witness?: string; limit?: number } = {}): DepositionPassage[] {
  const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!terms.length || !scope.matterIds.length) return [];
  const out: DepositionPassage[] = [];
  for (const dep of db().depositions.all()) {
    if (!inMatterScope(scope, dep.matterId)) continue;
    if (opts.witness && !nameMatches(dep.witnessName, opts.witness)) continue;
    for (const qa of dep.transcript) {
      const score = keywordScore(`${qa.question}\n${qa.answer}`, terms);
      if (score <= 0) continue;
      out.push({ source: depositionSource(dep.matterId, dep.id, qa.page, qa.line), deposition_id: dep.id, matter_id: dep.matterId, witness: dep.witnessName, date: dep.date, volume: dep.volume, page: qa.page, line: qa.line, question: qa.question.slice(0, 600), answer: qa.answer.slice(0, 900), flags: qa.flags, exhibit: qa.exhibit, objection: qa.objection, score });
    }
  }
  const max = Math.max(...out.map((h) => h.score), 1);
  return out.sort((a, b) => b.score - a.score || a.page - b.page || a.line - b.line).slice(0, opts.limit ?? 10).map((h) => ({ ...h, score: Number((h.score / max).toFixed(3)) }));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface EdocHit {
  source: string;
  title: string;
  id: string;
  matter_id: string;
  bates: string;
  bates_end?: string;
  date: string;
  custodian: string;
  type: string;
  subject: string;
  from?: string;
  to?: string[];
  passage: string;
  chunk_index?: number;
  score: number;
  ai_score?: number;
  coding: EDocument["coding"];
}

function edocHit(doc: EDocument, passage: string, score: number, chunk?: number): EdocHit {
  return { source: documentSource(doc.matterId, doc.id, { chunk }), title: `${doc.bates} — ${doc.subject}`, id: doc.id, matter_id: doc.matterId, bates: doc.bates, bates_end: doc.batesEnd, date: doc.date, custodian: doc.custodianName, type: doc.type, subject: doc.subject, from: doc.from, to: doc.to, passage, chunk_index: chunk, score: Number(score.toFixed(3)), ai_score: doc.aiScore, coding: doc.coding };
}

export const searchEdiscoveryTool = defineTool<{ query: string; matter_id?: string; custodian?: string; doc_type?: string; date_after?: string; date_before?: string; limit?: number }>({
  name: "search_ediscovery",
  description: "Semantic + keyword search over the e-discovery documents of the matters in the current scope (emails, memos, reports, transcripts). Each result is a focused passage with a stable `source` identifier (matter://<matterId>/document/<documentId>/chunk/<n>), Bates number, custodian, date and subject. Use for fact development, chronology building and locating exhibits; read a document in full with get_ediscovery_document.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language or keyword query" },
      matter_id: { type: "string", description: "Restrict to one matter id inside the current scope (never widens the scope)" },
      custodian: { type: "string", description: "Custodian name filter (contains)" },
      doc_type: { type: "string", description: "Email | Memo | Report | Presentation | Spreadsheet | Letter | Contract | Chat | Transcript" },
      date_after: { type: "string", description: "ISO date YYYY-MM-DD (inclusive)" },
      date_before: { type: "string", description: "ISO date YYYY-MM-DD (inclusive)" },
      limit: { type: "integer", description: "Default 8, max 25" },
    },
    required: ["query"],
  },
  examples: [
    { query: "Whitfield 90-day rat study hepatic effects", matter_id: "m_afff_2873", custodian: "Voss", date_after: "2001-01-01", date_before: "2001-12-31", limit: 8 },
    { query: "monitoring well MW-7 groundwater PFOA", doc_type: "Report", limit: 5 },
  ],
  timeoutMs: 20_000,
  maxResultChars: 24_000,
  label: (a) => `Searching documents: ${a.query}`,
  async execute(args, ctx) {
    const r = resolveMatterScope(ctx, args.matter_id);
    if (!r.ok) return { ...r.error, count: 0, results: [] as EdocHit[] };
    const scope = r.scope;
    const k = Math.min(args.limit ?? 8, 25);
    const d = db();
    const matches = (doc: EDocument) =>
      inMatterScope(scope, doc.matterId) &&
      (!args.custodian || doc.custodianName.toLowerCase().includes(args.custodian.toLowerCase())) &&
      (!args.doc_type || doc.type.toLowerCase() === args.doc_type.toLowerCase()) &&
      (!args.date_after || doc.date >= args.date_after) &&
      (!args.date_before || doc.date <= args.date_before);
    const hits = await hybridSearch(VECTOR_COLLECTIONS.edocs, args.query, { scope, k, filter: (_m, id) => { const doc = d.edocs.get(id); return !!doc && matches(doc); } });
    let results: EdocHit[] = hits.map((h) => edocHit(d.edocs.get(h.docId)!, h.text.slice(0, 900), h.score, h.chunkIndex));
    if (!results.length) results = keywordFallback(d.edocs.find(matches), args.query, (doc) => `${doc.subject}\n${doc.text}`, k).map(({ item: doc, score, excerpt }) => edocHit(doc, excerpt, score));
    const retrievedAt = new Date().toISOString();
    const evidence: EvidenceProvenance[] = results.map((res, i) => ({ source: res.source, kind: "document", provider: "ediscovery", tool: "search_ediscovery", query: args.query, rank: i + 1, score: res.score, documentId: res.id, matterId: res.matter_id, tenantId: scope.tenantId, bates: res.bates, chunkIndex: res.chunk_index, hash: hashOf(d.edocs.get(res.id)!), retrievedAt }));
    if (evidence.length) ctx.emit({ type: "evidence", evidence });
    for (const res of results.slice(0, 5)) ctx.emit({ type: "citation", citation: { title: res.title, cite: res.bates, source: "e-discovery", snippet: res.passage.slice(0, 200) } });
    return { count: results.length, scope: { matter_ids: scope.matterIds }, results };
  },
});

export const getEdiscoveryDocumentTool = defineTool<{ id_or_bates: string; max_chars?: number; offset?: number }>({
  name: "get_ediscovery_document",
  description: "Read the full text and metadata of an e-discovery document in the current scope by document id or Bates number. Returns a text window (default 30,000 characters) with `window.next_offset` for the next window. A Bates number that does not resolve inside the scope is reported as not found — it is never mapped to another document.",
  parameters: { type: "object", properties: { id_or_bates: { type: "string", description: "Document id (ed_…) or Bates number such as MFC-0041877" }, max_chars: { type: "integer", description: "Window size, default 30000" }, offset: { type: "integer", description: "Character offset of the window (from window.next_offset of the previous call)" } }, required: ["id_or_bates"] },
  examples: [
    { id_or_bates: "MFC-0041877" },
    { id_or_bates: "ed_afff_0057", max_chars: 20000, offset: 20000 },
  ],
  timeoutMs: 10_000,
  maxResultChars: 36_000,
  label: (a) => `Reading ${a.id_or_bates}`,
  async execute({ id_or_bates, max_chars, offset }, ctx) {
    const r = resolveMatterScope(ctx);
    if (!r.ok) return r.error;
    const scope = r.scope;
    const d = db();
    const needle = id_or_bates.trim().toLowerCase();
    const byId = d.edocs.get(id_or_bates.trim());
    const doc = byId && inMatterScope(scope, byId.matterId) ? byId : d.edocs.findOne((x) => inMatterScope(scope, x.matterId) && x.bates.toLowerCase() === needle);
    if (!doc) throw new ToolExecutionError("not_found", `No document ${id_or_bates} in the current matter scope`);
    const w = textWindow(doc.text, offset ?? 0, max_chars ?? 30_000);
    ctx.emit({ type: "evidence", evidence: [{ source: documentSource(doc.matterId, doc.id), kind: "document", provider: "ediscovery", tool: "get_ediscovery_document", rank: 1, documentId: doc.id, matterId: doc.matterId, tenantId: scope.tenantId, bates: doc.bates, hash: hashOf(doc), retrievedAt: new Date().toISOString() }] });
    return { ...doc, source: documentSource(doc.matterId, doc.id), text: w.text, window: w.window };
  },
});

interface LibraryHit {
  source: string;
  title: string;
  id: string;
  name: string;
  type: string;
  matter_id?: string;
  description?: string;
  tags?: string[];
  practice_area?: string;
  office_doc_id?: string;
  passage: string;
  score: number;
}

function libraryHit(scope: CorpusRetrievalScope, it: LibraryItem, passage: string, score: number): LibraryHit {
  return { source: librarySource(scope.tenantId, it.id), title: it.name, id: it.id, name: it.name, type: it.type, matter_id: it.matterId, description: it.description, tags: it.tags, practice_area: it.practiceArea, office_doc_id: it.officeDocId, passage, score: Number(score.toFixed(3)) };
}

export const searchLibraryTool = defineTool<{ query: string; type?: string; matter_id?: string; limit?: number }>({
  name: "search_library",
  description: "Search the firm's shared library: templates, precedents, clause bank, knowledge notes, prior work product and the matter folders the current scope may see. Returns items with excerpts and a stable `source` (library://<tenantId>/item/<itemId>); use get_library_item to read one fully.",
  parameters: { type: "object", properties: { query: { type: "string" }, type: { type: "string", description: "folder | docx | xlsx | pptx | pdf | template | clause | link | note" }, matter_id: { type: "string", description: "Only this matter's work product plus firm-wide items" }, limit: { type: "integer", description: "Default 8, max 25" } }, required: ["query"] },
  examples: [
    { query: "limitation of liability cap carve-outs", type: "clause", limit: 5 },
    { query: "Rule 30(b)(6) deposition outline", matter_id: "m_afff_2873" },
  ],
  timeoutMs: 20_000,
  maxResultChars: 24_000,
  label: (a) => `Searching library: ${a.query}`,
  async execute(args, ctx) {
    const r = resolveCorpusScope(ctx, "library", args.matter_id);
    if (!r.ok) return { ...r.error, count: 0, results: [] as LibraryHit[] };
    const scope = r.scope;
    const k = Math.min(args.limit ?? 8, 25);
    const d = db();
    const matches = (it: LibraryItem) => it.type !== "folder" && (!args.type || it.type === args.type) && libraryItemInScope(scope, it) && (!args.matter_id || !it.matterId || it.matterId === args.matter_id);
    const hits = await hybridSearch(VECTOR_COLLECTIONS.library, args.query, { scope, k, filter: (_m, id) => { const it = d.library.get(id); return !!it && matches(it); } });
    let results: LibraryHit[] = hits.map((h) => libraryHit(scope, d.library.get(h.docId)!, h.text.slice(0, 800), h.score));
    if (!results.length) results = keywordFallback(d.library.find(matches), args.query, (it) => `${it.name}\n${it.description ?? ""}\n${it.content ?? ""}\n${(it.tags ?? []).join(" ")}`, k).map(({ item: it, score, excerpt }) => libraryHit(scope, it, excerpt, score));
    const retrievedAt = new Date().toISOString();
    if (results.length) ctx.emit({ type: "evidence", evidence: results.map((res, i) => ({ source: res.source, kind: "library", provider: "library", tool: "search_library", query: args.query, rank: i + 1, score: res.score, documentId: res.id, matterId: res.matter_id, tenantId: scope.tenantId, hash: contentHash(res.passage), retrievedAt })) });
    return { count: results.length, results };
  },
});

export const getLibraryItemTool = defineTool<{ id: string; max_chars?: number; offset?: number }>({
  name: "get_library_item",
  description: "Read a library item (clause, template, note, matter work product) in full, including its text content when available. Returns a text window with `window.next_offset` for the next window.",
  parameters: { type: "object", properties: { id: { type: "string", description: "Library item id (lib_…)" }, max_chars: { type: "integer", description: "Window size, default 30000" }, offset: { type: "integer", description: "Character offset of the window" } }, required: ["id"] },
  examples: [{ id: "lib_clause_lol_cap" }, { id: "lib_note_afff_voss_admissions", max_chars: 8000, offset: 8000 }],
  timeoutMs: 10_000,
  maxResultChars: 36_000,
  label: (a) => `Reading library item ${a.id}`,
  async execute({ id, max_chars, offset }, ctx) {
    const r = resolveCorpusScope(ctx, "library");
    if (!r.ok) return r.error;
    const scope = r.scope;
    const d = db();
    const it = d.library.get(id);
    if (!it || !libraryItemInScope(scope, it)) throw new ToolExecutionError("not_found", `No library item ${id}`);
    let content = it.content ?? "";
    if (!content && it.officeDocId) {
      const od = d.officeDocs.get(it.officeDocId);
      if (od) content = extractPlainText(od.content);
    }
    const w = textWindow(content, offset ?? 0, max_chars ?? 30_000);
    ctx.emit({ type: "evidence", evidence: [{ source: librarySource(scope.tenantId, it.id), kind: "library", provider: "library", tool: "get_library_item", rank: 1, documentId: it.id, matterId: it.matterId, tenantId: scope.tenantId, hash: contentHash(content), retrievedAt: new Date().toISOString() }] });
    return { ...it, source: librarySource(scope.tenantId, it.id), content: w.text, window: w.window };
  },
});

export const matterContextTool = defineTool<{ matter_id?: string; query?: string }>({
  name: "get_matter_context",
  description: "Get the firm's matter context for matters in the current scope: caption, client, posture, court, judge, team, key dates, open tasks and upcoming events. Call with matter_id, or with a query to find matters by name; without either it lists every matter in scope.",
  parameters: { type: "object", properties: { matter_id: { type: "string", description: "Matter id such as m_afff_2873" }, query: { type: "string", description: "Name, client or caption fragment" } }, required: [] },
  examples: [{ matter_id: "m_afff_2873" }, { query: "Harbor" }],
  timeoutMs: 10_000,
  label: () => "Loading matter context",
  async execute({ matter_id, query }, ctx) {
    const r = resolveMatterScope(ctx, matter_id);
    if (!r.ok) return { ...r.error, count: 0, matters: [] as Matter[] };
    const scope = r.scope;
    const d = db();
    const today = new Date().toISOString().slice(0, 10);
    const q = query?.trim().toLowerCase();
    const matters = scope.matterIds.map((id) => d.matters.get(id)).filter((m): m is Matter => !!m).filter((m) => !q || `${m.name} ${m.shortName} ${m.client} ${m.caption ?? ""}`.toLowerCase().includes(q));
    return {
      count: matters.length,
      matters: matters.map((matter) => ({
        ...matter,
        // Forum, city, State and local-law pointer titles (pointers, not authority; get_forum_info resolves them).
        ...(forumContextFor((matter as Matter & { india?: IndianCaseInfo }).india) ? { forum_context: forumContextFor((matter as Matter & { india?: IndianCaseInfo }).india) } : {}),
        team: matter.teamIds.map((id) => d.people.get(id)).filter(Boolean).map((p) => ({ name: p!.name, title: p!.title })),
        open_tasks: d.tasks.find((t) => t.matterId === matter.id && t.status !== "done").slice(0, 15).map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueAt })),
        upcoming_events: d.events.find((e) => e.matterId === matter.id && e.startsAt >= today).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 10).map((e) => ({ title: e.title, kind: e.kind, at: e.startsAt })),
      })),
    };
  },
});

export const findPeopleTool = defineTool<{ name: string; matter_id?: string; limit?: number }>({
  name: "find_people",
  description: "Resolve a person by name inside the current matter scope: team members, custodians and deposition witnesses linked to the scoped matters, with the matters and documents they are linked to. A person who only appears in another matter is never returned, and the same surname in two matters is never merged.",
  parameters: { type: "object", properties: { name: { type: "string", description: "Full or partial name, e.g. 'Voss' or 'Helen Voss'" }, matter_id: { type: "string", description: "Restrict to one matter id inside the scope" }, limit: { type: "integer", description: "Default 20" } }, required: ["name"] },
  examples: [{ name: "Helen Voss", matter_id: "m_afff_2873" }, { name: "Kaine" }],
  timeoutMs: 10_000,
  label: (a) => `Resolving ${a.name}`,
  async execute({ name, matter_id, limit }, ctx) {
    const r = resolveMatterScope(ctx, matter_id);
    if (!r.ok) return { ...r.error, count: 0, people: [] as PersonMatch[] };
    const people = findPeople(name, r.scope, { limit });
    const documents = findDocuments(name, r.scope, { limit: 10 });
    return { count: people.length, scope: { matter_ids: r.scope.matterIds }, people, documents_mentioning: documents };
  },
});

export const searchDepositionsTool = defineTool<{ query: string; matter_id?: string; witness?: string; limit?: number }>({
  name: "search_depositions",
  description: "Keyword search over deposition transcripts in the current matter scope. Each hit is one question/answer segment with an exact page:line `source` (depo://<matterId>/<depositionId>/p/<page>/l/<line>), the witness, date and any flags (admission, contradiction, evasive, objection). Quote only what the segment says.",
  parameters: { type: "object", properties: { query: { type: "string" }, matter_id: { type: "string", description: "Restrict to one matter id inside the scope" }, witness: { type: "string", description: "Witness name filter" }, limit: { type: "integer", description: "Default 10, max 30" } }, required: ["query"] },
  examples: [{ query: "hepatic effects rat study aware", witness: "Voss", limit: 10 }, { query: "monitoring well results", matter_id: "m_afff_2873" }],
  timeoutMs: 15_000,
  maxResultChars: 24_000,
  label: (a) => `Searching depositions: ${a.query}`,
  async execute({ query, matter_id, witness, limit }, ctx) {
    const r = resolveMatterScope(ctx, matter_id);
    if (!r.ok) return { ...r.error, count: 0, results: [] as DepositionPassage[] };
    const results = findDepositionPassages(query, r.scope, { witness, limit: Math.min(limit ?? 10, 30) });
    const retrievedAt = new Date().toISOString();
    if (results.length) ctx.emit({ type: "evidence", evidence: results.map((h, i) => ({ source: h.source, kind: "deposition", provider: "depositions", tool: "search_depositions", query, rank: i + 1, score: h.score, documentId: h.deposition_id, matterId: h.matter_id, tenantId: r.scope.tenantId, page: h.page, line: h.line, hash: contentHash(`${h.question}\n${h.answer}`), retrievedAt })) });
    for (const h of results.slice(0, 5)) ctx.emit({ type: "citation", citation: { title: `${h.witness} Dep. ${h.page}:${h.line}`, cite: `${h.witness} Dep. ${h.page}:${h.line}`, source: "deposition", snippet: h.answer.slice(0, 200) } });
    return { count: results.length, scope: { matter_ids: r.scope.matterIds }, results };
  },
});

/** Best-effort plain text from any office content model (TipTap JSON, workbook, deck). */
export function extractPlainText(content: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n) return;
    if (typeof n === "string") { out.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (Array.isArray(o.marks) && (o.marks as { type?: string }[]).some((m) => m?.type === "deletion")) return; // tracked deletions are not live text
      if (typeof o.text === "string") out.push(o.text);
      if (typeof o.value === "string" || typeof o.value === "number") out.push(String(o.value));
      for (const k of ["content", "children", "cells", "rows", "slides", "elements", "sheets", "blocks", "paragraphs"]) if (o[k]) walk(o[k]);
      if (o.type === "paragraph" || o.type === "heading") out.push("\n");
    }
  };
  walk(content);
  return out.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/**
 * Intelligence context for the agents: the matter's judge, court and MDL as
 * resolved entities, recent docket and regulatory activity, the sourced
 * chronology and ranked insights; the user's matters, calendar, due tasks and
 * watches; and, with a query, the best-matching passages from the ingested
 * corpus (opinions, dockets, regulations, recalls, news, local files). Loads
 * the intel modules lazily so the toolkit stays light when they are unused.
 */
export const getIntelContextTool = defineTool<{ matter_id?: string; user_id?: string; query?: string; entity_id?: string; limit?: number }>({
  name: "get_intel_context",
  description: "Intelligence context from the firm's background-ingested corpus: for a matter in scope, the resolved judge/court/MDL, recent docket and regulatory activity, a sourced chronology and ranked insights; for the current user, active matters, the next two weeks of calendar, due tasks and watches; for a query, the most relevant passages from opinions, dockets, regulations, Federal Register notices, FDA recalls, MDL records, news and local documents (each with a stable `source` intel://<tenantId>/document/<id>/chunk/<n>, record id and URL). Use it before answering matter-specific questions or when the user asks what changed.",
  parameters: {
    type: "object",
    properties: {
      matter_id: { type: "string", description: "Matter id for matter context" },
      user_id: { type: "string", description: "User id for personal context (defaults to the current user)" },
      query: { type: "string", description: "Search the intelligence corpus for passages" },
      entity_id: { type: "string", description: "Intel entity id (judge, attorney, firm, MDL, product…) for a compact profile" },
      limit: { type: "integer", description: "Passages to return for a query (default 6, max 12)" },
    },
    required: [],
  },
  examples: [{ matter_id: "m_afff_2873", query: "government contractor defense specifications", limit: 6 }, { entity_id: "ie_judge_gergel" }, {}],
  timeoutMs: 20_000,
  maxResultChars: 24_000,
  label: (a) => (a.query ? `Searching intelligence: ${a.query}` : a.matter_id ? "Loading matter intelligence" : "Loading intelligence context"),
  async execute({ matter_id, user_id, query, entity_id, limit }, ctx) {
    const corpus = resolveCorpusScope(ctx, "intel", matter_id);
    if (!corpus.ok) return corpus.error;
    const [{ buildMatterContext, buildUserContext }, { searchIntel, intelEntities }, { profileSummary }] = await Promise.all([import("@/modules/intel/context/user-context"), import("@/modules/intel/store"), import("@/modules/intel/analysis/profiles")]);
    const out: Record<string, unknown> = {};
    if (matter_id) {
      const ms = resolveMatterScope(ctx, matter_id);
      if (!ms.ok) return ms.error;
      const m = buildMatterContext(matter_id);
      if (!m) throw new ToolExecutionError("not_found", `No matter ${matter_id}`);
      out.matter = { ...m.matter, judge: m.judge, court: m.court, mdl: m.mdl, team: m.team.map((p) => p.name), recent_docket: m.activity.docket.slice(0, 6).map((d) => ({ id: d.id, source: intelSource(corpus.scope.tenantId, d.id), date: d.date, title: d.title, url: d.url, confidence: d.confidence, flags: d.flags.map((f) => f.kind) })), recent_regulatory: m.activity.regulatory.slice(0, 6).map((d) => ({ id: d.id, source: intelSource(corpus.scope.tenantId, d.id), date: d.date, title: d.title, url: d.url })), chronology: m.chronology.slice(-15), insights: m.insights.slice(0, 5).map((i) => ({ id: i.id, kind: i.kind, title: i.title, summary: i.summary.slice(0, 400), confidence: i.confidence, status: i.status })), calendar: m.calendar.slice(0, 8), tasks: m.tasks.slice(0, 8), records_by_kind: m.byKind };
    }
    if (user_id || (!matter_id && !query && !entity_id)) {
      const p = principalOf(ctx);
      const target = user_id ?? p?.id;
      if (p && target && target !== p.id && !p.roles.some((r) => r === "partner" || r === "admin")) return { error: "personal context is only available for the current user", code: "unauthorized", status: 403 } satisfies ToolErrorShape;
      const u = buildUserContext(target);
      out.user = { id: u.userId, name: u.user.name, team: u.team.map((p) => p.name), matters: u.matters.filter((m) => !corpus.scope.matterIds || corpus.scope.matterIds.includes(m.id)).map((m) => ({ id: m.id, shortName: m.shortName, status: m.status, stage: m.stage, court: m.court, judge: m.judge, keyDates: m.keyDates.slice(0, 3), recentRecords: m.recentRecords })), calendar: u.calendar.slice(0, 10), tasks: u.tasks.slice(0, 10), watches: u.watches.map((w) => ({ kind: w.kind, label: w.label })), insights: u.insights.slice(0, 5).map((i) => ({ id: i.id, kind: i.kind, title: i.title, summary: i.summary.slice(0, 300) })), upcoming: u.upcoming.slice(0, 4).map((x) => ({ event: x.event.title, at: x.event.startsAt, matter: x.matter?.shortName, prep: x.insights.map((i) => i.title), records: x.records.map((r) => r.title) })) };
    }
    if (entity_id) {
      const e = intelEntities().get(entity_id);
      if (!e) throw new ToolExecutionError("not_found", `No entity ${entity_id}`);
      const p = profileSummary(e);
      out.entity = { id: e.id, type: e.type, name: e.name, aliases: e.aliases, attributes: e.attributes, documents: p.counts.documents, tendencies: p.tendencies.map((t) => ({ motion: t.label, total: t.total, granted: t.granted, denied: t.denied, partial: t.partial })), related: p.related.map((r) => `${r.relation} ${r.entity.name} (×${r.weight})`), recent: p.recent.map((d) => ({ id: d.id, source: intelSource(corpus.scope.tenantId, d.id), date: d.date, title: d.title, url: d.url })) };
    }
    if (query) {
      const hits = await searchIntel({ q: query, matterId: matter_id, limit: Math.min(limit ?? 6, 12) });
      const retrievedAt = new Date().toISOString();
      out.hits = hits.map((h) => ({ source: intelSource(corpus.scope.tenantId, h.doc.id, h.chunk.idx), id: h.doc.id, kind: h.doc.kind, title: h.doc.title, court: h.doc.court, citation: h.doc.citation, docket: h.doc.docketNumber, date: h.doc.dates.decided ?? h.doc.dates.filed ?? h.doc.dates.published ?? h.doc.dates.event, url: h.doc.url, confidence: h.doc.confidence, flags: h.doc.flags.map((f) => f.kind), passage: h.chunk.text.slice(0, 700), score: Number(h.score.toFixed(3)) }));
      if (hits.length) ctx.emit({ type: "evidence", evidence: hits.map((h, i) => ({ source: intelSource(corpus.scope.tenantId, h.doc.id, h.chunk.idx), kind: "intel", provider: "intel", tool: "get_intel_context", query, rank: i + 1, score: h.score, documentId: h.doc.id, matterId: matter_id, tenantId: corpus.scope.tenantId, chunkIndex: h.chunk.idx, url: h.doc.url, hash: contentHash(h.chunk.text), retrievedAt })) });
    }
    return out;
  },
});

export const INTERNAL_TOOLS = [searchEdiscoveryTool, getEdiscoveryDocumentTool, searchLibraryTool, getLibraryItemTool, matterContextTool, findPeopleTool, searchDepositionsTool, getIntelContextTool];
