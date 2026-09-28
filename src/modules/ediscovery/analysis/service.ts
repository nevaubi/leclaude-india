import "server-only";
import { canonicalExhibit, resolveExhibit as resolveIndiaExhibit, type IndiaEDocument } from "../india";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { aiConfig } from "@/lib/ai/config";
import { hybridSearch } from "@/lib/ai/vector-store";
import { VECTOR_COLLECTIONS } from "@/lib/ai/toolkit/internal";
import type { Conflict, Deposition, DepositionQA, EDocument, Person, Relationship, TimelineEvent } from "@/lib/types/domain";
import type { AnalysisOverview, ConflictNote, ConflictRow, CrossAnalysisResponse, CrossExcerpt, Designation, DepositionSummary, FactMatrix, GraphData, GraphEvidence, GraphOrg, KnowledgeMap, ObjectionRuling, ObjectionRulingRecord, PersonDetail, QAFlag, TimelineEventInput, TimelineFilters, TranscriptHit } from "./types";
import { formatPageLine } from "./types";
import { normalizeRange, searchTranscripts, summarizeObjections } from "./transcript";
import { dedupeEvents, filterEvents, sortEvents } from "./chronology";
import { buildGraph, resolveExactPersonName, resolvePersonName } from "./graph";
import { CURRENT_USER, currentUser } from "@/lib/current-user";

/** Kept for existing importers; prefer `currentUser().id` at call time (honours LECLAUDE_USER_ID). */
/** The acting user id, resolved per call. */
export function currentUserId(): string { return CURRENT_USER.id; }
const DESIGNATIONS = "ediscovery_designations";
const CONFLICT_NOTES = "ediscovery_conflict_notes";
const FACT_MATRICES = "ediscovery_fact_matrices";
const KNOWLEDGE_MAPS = "ediscovery_knowledge_maps";
const OBJECTION_RULINGS = "ediscovery_objection_rulings";

const designations = () => db().collection<Designation>(DESIGNATIONS);
const rulings = () => db().collection<ObjectionRulingRecord>(OBJECTION_RULINGS);
const conflictNotes = () => db().collection<ConflictNote>(CONFLICT_NOTES);
const factMatrices = () => db().collection<FactMatrix>(FACT_MATRICES);
const knowledgeMaps = () => db().collection<KnowledgeMap>(KNOWLEDGE_MAPS);

function now() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function overview(matterId: string): AnalysisOverview {
  const d = db();
  const deps = d.depositions.find((x) => x.matterId === matterId);
  const conflicts = d.conflicts.find((x) => x.matterId === matterId);
  return {
    matterId,
    aiConfigured: aiConfig().hasKey,
    depositions: deps.length,
    transcribed: deps.filter((x) => x.transcript.length > 0).length,
    events: d.timeline.count((x) => x.matterId === matterId),
    relationships: d.relationships.count((x) => x.matterId === matterId),
    conflicts: { open: conflicts.filter((c) => c.status === "open").length, resolved: conflicts.filter((c) => c.status === "resolved").length, dismissed: conflicts.filter((c) => c.status === "dismissed").length },
  };
}

// ---------------------------------------------------------------------------
// Depositions
// ---------------------------------------------------------------------------

export function summarizeDeposition(dep: Deposition): DepositionSummary {
  const { transcript, ...rest } = dep;
  const flagCounts: Record<QAFlag, number> = { admission: 0, contradiction: 0, evasive: 0, key: 0, privilege: 0, objection: 0 };
  let objectionCount = 0;
  for (const qa of transcript) {
    for (const f of qa.flags ?? []) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
    if (qa.objection) objectionCount++;
  }
  return { ...rest, qaCount: transcript.length, flagCounts, objectionCount, exhibitCount: dep.exhibits?.length ?? 0, designationCount: designations().count((x) => x.depositionId === dep.id), hasDigest: !!dep.aiDigest };
}

export function listDepositions(matterId: string): DepositionSummary[] {
  return db().depositions.find((x) => x.matterId === matterId).sort((a, b) => a.date.localeCompare(b.date) || (a.volume ?? 1) - (b.volume ?? 1)).map(summarizeDeposition);
}

export function getDeposition(id: string): Deposition | null {
  return db().depositions.get(id);
}

export function updateQA(depositionId: string, index: number, patch: { flags?: QAFlag[]; note?: string | null }): Deposition | null {
  return db().depositions.update(depositionId, (dep) => {
    if (index < 0 || index >= dep.transcript.length) throw Object.assign(new Error(`Q/A index ${index} out of range`), { status: 400 });
    const transcript = dep.transcript.map((qa, i) => {
      if (i !== index) return qa;
      const next: DepositionQA = { ...qa };
      if (patch.flags) { if (patch.flags.length) next.flags = Array.from(new Set(patch.flags)); else delete next.flags; }
      if (patch.note !== undefined) { if (patch.note) next.note = patch.note; else delete next.note; }
      return next;
    });
    return { ...dep, transcript };
  });
}

export function toggleFlag(depositionId: string, index: number, flag: QAFlag): Deposition | null {
  const dep = getDeposition(depositionId);
  if (!dep) return null;
  const cur = dep.transcript[index]?.flags ?? [];
  const flags = cur.includes(flag) ? cur.filter((f) => f !== flag) : [...cur, flag];
  return updateQA(depositionId, index, { flags });
}

export function setDigest(depositionId: string, digest: Deposition["aiDigest"]) {
  return db().depositions.update(depositionId, { aiDigest: digest });
}

export function searchAllTranscripts(matterId: string, q: string, opts: { limit?: number; flags?: QAFlag[]; depositionId?: string } = {}): TranscriptHit[] {
  const deps = db().depositions.find((x) => x.matterId === matterId && (!opts.depositionId || x.id === opts.depositionId));
  return searchTranscripts(deps, q, { limit: opts.limit ?? 200, flags: opts.flags });
}

export function objectionSummary(depositionId: string) {
  const dep = getDeposition(depositionId);
  return dep ? summarizeObjections(dep.transcript, objectionRulings(depositionId)) : null;
}

// Objection rulings (module-private collection) ---------------------------------

/** Rulings entered for a deposition, keyed by Q/A index. */
export function objectionRulings(depositionId: string): Record<number, ObjectionRuling> {
  const out: Record<number, ObjectionRuling> = {};
  for (const r of rulings().find((x) => x.depositionId === depositionId)) out[r.index] = r.ruling;
  return out;
}

export function setObjectionRuling(depositionId: string, index: number, ruling: ObjectionRuling, opts: { note?: string; userId?: string } = {}): ObjectionRulingRecord | null {
  const dep = getDeposition(depositionId);
  if (!dep) return null;
  const qa = dep.transcript[index];
  if (!qa) throw Object.assign(new Error(`Q/A index ${index} out of range`), { status: 400 });
  if (!qa.objection) throw Object.assign(new Error(`No objection on the record at ${formatPageLine(qa.page, qa.line)}`), { status: 400 });
  const id = `${depositionId}:${index}`;
  if (ruling === "pending" && !opts.note) { rulings().delete(id); return { id, matterId: dep.matterId, depositionId, index, ruling, updatedAt: now(), updatedBy: opts.userId ?? currentUser().id }; }
  const rec: ObjectionRulingRecord = { id, matterId: dep.matterId, depositionId, index, ruling, note: opts.note?.trim() || undefined, updatedAt: now(), updatedBy: opts.userId ?? currentUser().id };
  rulings().put(rec);
  return rec;
}

/** Resolve an exhibit reference ("Voss-3") or Bates number to an e-discovery document id. */
export function resolveExhibit(dep: Deposition, ref: string): { docId?: string; bates?: string; description?: string } {
  const ex = dep.exhibits?.find((e) => e.id.toLowerCase() === ref.toLowerCase() || (canonicalExhibit(e.id) != null && canonicalExhibit(e.id) === canonicalExhibit(ref)));
  // Indian exhibit marks (Ex.P7, M.O.2) resolve to the one document of THIS matter carrying exactly that mark (§23).
  const mark = canonicalExhibit(ex?.id ?? ref);
  if (mark) {
    const r = resolveIndiaExhibit(mark, db().edocs.find((d) => d.matterId === dep.matterId) as IndiaEDocument[], dep.matterId);
    if (r.status === "resolved") { const doc = db().edocs.get(r.docId); return { docId: r.docId, bates: doc?.bates, description: ex?.description ?? doc?.subject }; }
    if (!ex?.bates) return { description: ex?.description };
  }
  const bates = ex?.bates ?? (/^[A-Z]{2,5}-\d{5,}$/i.test(ref) ? ref.toUpperCase() : undefined);
  if (!bates) return { description: ex?.description };
  // Matter-scoped: another matter's document with the same number is never bound (§22/§23).
  const doc = db().edocs.findOne((d) => d.matterId === dep.matterId && d.bates.toUpperCase() === bates.toUpperCase());
  return { docId: doc?.id, bates, description: ex?.description ?? doc?.subject };
}

// Designations -------------------------------------------------------------

export function listDesignations(depositionId: string): Designation[] {
  return designations().find((x) => x.depositionId === depositionId).sort((a, b) => a.startPage - b.startPage || a.startLine - b.startLine);
}

export function createDesignation(input: Omit<Designation, "id" | "createdAt" | "createdBy"> & { id?: string }): Designation {
  const r = normalizeRange(input);
  const d: Designation = { ...input, ...r, id: input.id ?? `dsg_${nanoid(10)}`, createdAt: now(), createdBy: currentUser().id };
  designations().put(d);
  return d;
}

export function updateDesignation(id: string, patch: Partial<Pick<Designation, "purpose" | "note" | "startPage" | "startLine" | "endPage" | "endLine">>) {
  return designations().update(id, (d) => ({ ...d, ...patch, ...normalizeRange({ ...d, ...patch }) }));
}

export function deleteDesignation(id: string) {
  return designations().delete(id);
}

// ---------------------------------------------------------------------------
// Cross-analysis (deterministic; the AI layer builds on these excerpts)
// ---------------------------------------------------------------------------

function docExcerpt(text: string, terms: string[], radius = 220) {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  if (pos < 0) return text.slice(0, radius * 2).replace(/\s+/g, " ").trim() + (text.length > radius * 2 ? "…" : "");
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

export async function crossAnalysis(matterId: string, opts: { topic: string; witnessId?: string; depositionId?: string; k?: number }): Promise<CrossAnalysisResponse> {
  const d = db();
  const topic = opts.topic.trim();
  const deps = d.depositions.find((x) => x.matterId === matterId && x.transcript.length > 0);
  const focus = deps.filter((x) => (opts.depositionId ? x.id === opts.depositionId : opts.witnessId ? x.witnessId === opts.witnessId : true));
  const others = deps.filter((x) => !focus.includes(x));
  const k = opts.k ?? 12;
  const toExcerpt = (hits: TranscriptHit[]): CrossExcerpt[] => {
    const seen = new Set<string>();
    const out: CrossExcerpt[] = [];
    for (const h of hits) {
      const key = `${h.depositionId}:${h.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dep = deps.find((x) => x.id === h.depositionId)!;
      const qa = dep.transcript[h.index];
      out.push({ kind: "deposition", id: dep.id, label: dep.witnessName, cite: `${dep.witnessName.split(" ").pop()} ${formatPageLine(qa.page, qa.line)}`, date: dep.date, text: `Q. ${qa.question}\nA. ${qa.answer}`, score: h.score, index: h.index, flags: qa.flags });
      if (out.length >= k) break;
    }
    return out;
  };
  const searchLoose = (deps: Deposition[], limit: number) => { const strict = searchTranscripts(deps, topic, { limit }); return strict.length >= 3 ? strict : [...strict, ...searchTranscripts(deps, topic, { limit, mode: "any" }).filter((h) => !strict.some((s) => s.depositionId === h.depositionId && s.index === h.index))]; };
  const testimony = topic ? toExcerpt(searchLoose(focus, 60)) : toExcerpt(focus.flatMap((dep) => dep.transcript.map((qa, index) => ({ depositionId: dep.id, witnessName: dep.witnessName, index, page: qa.page, line: qa.line, field: "answer" as const, snippet: qa.answer, score: (qa.flags?.length ?? 0) + 1 }))).sort((a, b) => b.score - a.score));
  const otherTestimony = topic ? toExcerpt(searchLoose(others, 40)).slice(0, Math.ceil(k / 2)) : [];

  const documents: CrossExcerpt[] = [];
  if (topic) {
    const hits = await hybridSearch(VECTOR_COLLECTIONS.edocs, topic, { k, perDoc: 1, filter: (meta) => meta.matterId === matterId });
    const terms = topic.split(/\s+/).filter((t) => t.length > 2);
    for (const h of hits) {
      const doc = d.edocs.get(h.docId);
      if (!doc) continue;
      documents.push({ kind: "document", id: doc.id, label: doc.subject, cite: doc.bates, date: doc.date, text: docExcerpt(h.text || doc.text, terms), score: Math.round(h.score * 100) / 100 });
    }
  }
  const witnessIds = new Set(focus.map((x) => x.id));
  const conflicts = d.conflicts.find((c) => c.matterId === matterId && (!focus.length || c.sides.some((s) => s.sourceKind === "deposition" && witnessIds.has(s.sourceId))) && (!topic || `${c.title} ${c.analysis} ${c.sides.map((s) => s.excerpt).join(" ")}`.toLowerCase().includes(topic.toLowerCase().split(/\s+/)[0])));
  return { topic, witnessId: opts.witnessId, testimony, documents, otherTestimony, conflicts, aiConfigured: aiConfig().hasKey };
}

/** kv key holding a matter's curated cross-analysis topics (string[]). */
export const SUGGESTED_TOPICS_KEY = (matterId: string) => `ediscovery:topics:${matterId}`;

/** Suggested topics: curated topics for the matter plus its issue-code labels. Empty for a new matter. */
export function suggestTopics(matterId: string): string[] {
  const d = db();
  const codes = d.issueCodes.find((c) => c.matterId === matterId).map((c) => c.label);
  // Curated topics for the matter (written by counsel or a seed) come first; issue-code labels fill the rest.
  const curated = d.kv.get<string[]>(SUGGESTED_TOPICS_KEY(matterId)) ?? [];
  return Array.from(new Set([...curated, ...codes])).slice(0, 14);
}

export function listFactMatrices(matterId: string): FactMatrix[] {
  return factMatrices().find((m) => m.matterId === matterId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function saveFactMatrix(m: FactMatrix) { factMatrices().put(m); return m; }
export function deleteFactMatrix(id: string) { return factMatrices().delete(id); }

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export function listEvents(matterId: string, filters?: TimelineFilters): TimelineEvent[] {
  return sortEvents(filterEvents(db().timeline.find((e) => e.matterId === matterId), filters));
}

export function createEvent(matterId: string, input: TimelineEventInput): TimelineEvent {
  const e: TimelineEvent = { ...input, id: input.id ?? `tl_${nanoid(10)}`, matterId, createdBy: input.createdBy ?? "user", sources: input.sources ?? [], significance: (Math.min(5, Math.max(1, input.significance ?? 3)) as TimelineEvent["significance"]) };
  db().timeline.put(e);
  return e;
}

export function updateEvent(id: string, patch: Partial<TimelineEvent>) {
  const { id: _id, matterId: _m, ...rest } = patch;
  void _id; void _m;
  return db().timeline.update(id, rest);
}

export function deleteEvent(id: string) { return db().timeline.delete(id); }

/** Merge incoming events into the matter chronology (dedupe by date+title). */
export function mergeEvents(matterId: string, incoming: TimelineEvent[]) {
  const existing = db().timeline.find((e) => e.matterId === matterId);
  const res = dedupeEvents(existing, incoming);
  db().timeline.putMany(res.added);
  db().timeline.putMany(res.mergedInto.map((m) => m.existing));
  return { added: res.added, merged: res.mergedInto.length, total: res.merged.length };
}

/** Deterministic extraction from document metadata (no AI): one event per document. */
export function eventsFromDocuments(matterId: string, docIds: string[]): TimelineEvent[] {
  const d = db();
  const people = matterPeople(matterId);
  const out: TimelineEvent[] = [];
  for (const id of docIds) {
    const doc = d.edocs.get(id);
    if (!doc || doc.matterId !== matterId) continue;
    const cat: TimelineEvent["category"] = doc.type === "Report" || doc.type === "Spreadsheet" ? "scientific" : doc.type === "Letter" ? "communication" : doc.coding.privileged ? "regulatory" : doc.type === "Email" || doc.type === "Chat" ? "communication" : "corporate";
    const personIds = Array.from(new Set([doc.custodianId, ...[doc.from ?? "", ...(doc.to ?? [])].map((n) => resolvePersonName(n, people)?.id).filter((x): x is string => !!x)]));
    out.push({ id: `tl_${nanoid(10)}`, matterId, date: doc.date, title: doc.subject.replace(/^(re|fw|fwd):\s*/i, ""), description: doc.aiSummary ?? doc.text.slice(0, 240).replace(/\s+/g, " ") + (doc.text.length > 240 ? "…" : ""), category: cat, significance: doc.coding.hot ? 4 : doc.aiScore && doc.aiScore >= 85 ? 3 : 2, sources: [{ kind: "document", id: doc.id, bates: doc.bates }], personIds, createdBy: "user", verified: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// People & graph
// ---------------------------------------------------------------------------

/** People who appear in this matter (relationships, depositions, custodians, team, email headers). Name resolution is scoped to this set so two matters never bind to each other's people. */
export function matterPeople(matterId: string): Person[] {
  const d = db();
  const rels = d.relationships.find((r) => r.matterId === matterId);
  const ids = new Set<string>();
  for (const r of rels) { ids.add(r.fromId); ids.add(r.toId); }
  for (const dep of d.depositions.find((x) => x.matterId === matterId)) ids.add(dep.witnessId);
  const docs = d.edocs.find((x) => x.matterId === matterId);
  for (const doc of docs) ids.add(doc.custodianId);
  const matter = d.matters.get(matterId);
  for (const t of matter?.teamIds ?? []) ids.add(t);
  const people = d.people.all();
  // Also include people named in a header of this matter's documents, but only by exact, unique full name, and never a
  // person anchored to a different matter (its custodian, deponent, relationship member or team): a surname, a near-miss
  // or a namesake from another matter is not bound here (constitution §23, no closest-name or cross-matter binding).
  const elsewhere = anchoredElsewhere(matterId);
  const free = people.filter((p) => ids.has(p.id) || !elsewhere.has(p.id));
  for (const doc of docs) for (const n of [doc.from ?? "", ...(doc.to ?? []), ...(doc.cc ?? [])]) { const p = resolveExactPersonName(n, free); if (p) ids.add(p.id); }
  return people.filter((p) => ids.has(p.id));
}

/** People tied to some other matter by record (custodian, deponent, relationship, team), excluding this matter's own. */
function anchoredElsewhere(matterId: string): Set<string> {
  const d = db();
  const out = new Set<string>();
  for (const doc of d.edocs.all()) if (doc.matterId !== matterId) out.add(doc.custodianId);
  for (const dep of d.depositions.all()) if (dep.matterId !== matterId) out.add(dep.witnessId);
  for (const r of d.relationships.all()) if (r.matterId !== matterId) { out.add(r.fromId); out.add(r.toId); }
  for (const m of d.matters.all()) if (m.id !== matterId) for (const t of m.teamIds ?? []) out.add(t);
  return out;
}

export function graph(matterId: string): GraphData {
  const d = db();
  const people = matterPeople(matterId);
  const rels = d.relationships.find((r) => r.matterId === matterId);
  const edocs = d.edocs.find((x) => x.matterId === matterId);
  const docs = edocs.map((x) => ({ id: x.id, from: x.from, to: x.to, cc: x.cc, custodianId: x.custodianId }));
  const deps = d.depositions.find((x) => x.matterId === matterId);
  const depCounts = new Map<string, number>();
  for (const dep of deps) depCounts.set(dep.witnessId, (depCounts.get(dep.witnessId) ?? 0) + 1);
  const g = buildGraph(people, rels, docs, depCounts);
  // Testimony counts: own Q/A pairs plus Q/A pairs in other transcripts that name the person.
  const qaText = deps.filter((x) => x.transcript.length).map((x) => ({ dep: x, rows: x.transcript.map((qa) => `${qa.question} ${qa.answer}`.toLowerCase()) }));
  for (const n of g.nodes) {
    const last = n.label.split(/\s+/).pop()!.toLowerCase();
    const first = n.label.split(/\s+/)[0];
    let count = 0;
    for (const { dep, rows } of qaText) {
      if (dep.witnessId === n.id) { count += rows.length; continue; }
      if (last.length < 3) continue;
      for (const r of rows) if (r.includes(last) || (first.length > 2 && r.includes(first.toLowerCase()))) count++;
    }
    n.testimony = count;
  }
  // Evidence dates: Bates → document date; "Witness 24:05" excerpts → the deposition (matter-scoped; unresolved stays undated).
  const byBates = new Map(edocs.flatMap((x) => [[x.bates.toUpperCase(), x] as const, ...(x.batesEnd ? [[x.batesEnd.toUpperCase(), x] as const] : [])]));
  const byId = new Map(edocs.map((x) => [x.id, x]));
  const depByLast = new Map<string, Deposition[]>();
  for (const dep of deps) { const k = dep.witnessName.split(/\s+/).pop()!.toLowerCase(); depByLast.set(k, [...(depByLast.get(k) ?? []), dep]); }
  for (const e of g.edges) {
    e.evidence = e.evidence.map((ev): GraphEvidence => {
      const doc = (ev.docId ? byId.get(ev.docId) : undefined) ?? (ev.bates ? byBates.get(ev.bates.toUpperCase()) : undefined);
      if (doc) return { ...ev, docId: doc.id, bates: ev.bates ?? doc.bates, kind: "document", date: doc.date };
      const m = ev.excerpt?.match(/^([A-Z][A-Za-z'-]+)(?:\s+Vol\.\s*[IVX\d]+,?)?\s*(\d{1,4}):(\d{1,2})/);
      const last = (m?.[1] ?? ev.excerpt?.match(/^([A-Z][A-Za-z'-]+)\s+Vol\./)?.[1])?.toLowerCase();
      const cands = last ? (depByLast.get(last) ?? []) : [];
      const dep = cands.length === 1 ? cands[0] : cands.find((x) => x.transcript.length > 0) ?? cands[0];
      if (!dep) return ev;
      return { ...ev, kind: "deposition", depositionId: dep.id, date: dep.date, cite: m ? `${dep.witnessName.split(/\s+/).pop()} ${formatPageLine(Number(m[2]), Number(m[3]))}` : undefined };
    });
    const dates = e.evidence.map((ev) => ev.date).filter((x): x is string => !!x).sort();
    if (dates.length) { e.firstDate = dates[0]; e.lastDate = dates[dates.length - 1]; }
  }
  // Organizations: people grouped by Person.organization (no invented edges; the UI focuses the graph on a member set).
  const orgs = new Map<string, GraphOrg>();
  for (const n of g.nodes) {
    const key = n.organization ?? "Unaffiliated";
    const o = orgs.get(key) ?? { id: `org:${key}`, label: key, memberIds: [], docCount: 0, testimony: 0 };
    o.memberIds.push(n.id); o.docCount += n.docCount; o.testimony += n.testimony ?? 0;
    orgs.set(key, o);
  }
  g.orgs = Array.from(orgs.values()).sort((a, b) => b.memberIds.length - a.memberIds.length || a.label.localeCompare(b.label));
  return g;
}

export function personDetail(matterId: string, personId: string): PersonDetail | null {
  const d = db();
  const person = d.people.get(personId);
  if (!person) return null;
  const people = matterPeople(matterId);
  const docs = d.edocs.find((x) => x.matterId === matterId);
  const lite = (x: EDocument) => ({ id: x.id, bates: x.bates, date: x.date, subject: x.subject, type: x.type });
  const authored = docs.filter((x) => (x.from ? resolvePersonName(x.from, people)?.id === personId : x.custodianId === personId)).sort((a, b) => a.date.localeCompare(b.date));
  const received = docs.filter((x) => (x.to ?? []).some((n) => resolvePersonName(n, people)?.id === personId)).sort((a, b) => a.date.localeCompare(b.date));
  const cc = docs.filter((x) => (x.cc ?? []).some((n) => resolvePersonName(n, people)?.id === personId)).length;
  const last = person.name.split(" ").pop()!.toLowerCase();
  const mentioned = docs.filter((x) => x.text.toLowerCase().includes(last) && !authored.includes(x) && !received.includes(x)).length;
  const deps = d.depositions.find((x) => x.matterId === matterId).map((dep) => ({ id: dep.id, date: dep.date, witnessName: dep.witnessName, pages: dep.pages, status: dep.status, mentions: dep.witnessId === personId ? dep.transcript.length : dep.transcript.filter((qa) => `${qa.question} ${qa.answer}`.toLowerCase().includes(last) || `${qa.question} ${qa.answer}`.includes(person.name.split(" ")[0])).length })).filter((x) => x.mentions > 0 || d.depositions.get(x.id)?.witnessId === personId || false);
  const timeline = d.timeline.find((e) => e.matterId === matterId && !!e.personIds?.includes(personId)).sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({ id: e.id, date: e.date, title: e.title, category: e.category, significance: e.significance }));
  const relationships = d.relationships.find((r) => r.matterId === matterId && (r.fromId === personId || r.toId === personId)).map((r) => {
    const otherId = r.fromId === personId ? r.toId : r.fromId;
    return { id: r.id, otherId, otherName: d.people.get(otherId)?.name ?? otherId, kind: r.kind, direction: (r.fromId === personId ? "out" : "in") as "out" | "in", weight: r.weight, label: r.label, evidence: r.evidence ?? [] };
  }).sort((a, b) => b.weight - a.weight);
  const depIds = new Set(d.depositions.find((x) => x.matterId === matterId && x.witnessId === personId).map((x) => x.id));
  const conflicts = d.conflicts.find((c) => c.matterId === matterId && c.sides.some((s) => (s.sourceKind === "deposition" && depIds.has(s.sourceId)) || (s.sourceKind === "document" && authored.some((a) => a.id === s.sourceId)))).map((c) => ({ id: c.id, title: c.title, severity: c.severity, status: c.status }));
  return { person: { id: person.id, name: person.name, title: person.title, organization: person.organization, role: person.role, email: person.email }, authored: authored.map(lite), received: received.map(lite), counts: { authored: authored.length, received: received.length, cc, mentioned }, depositions: deps, timeline, relationships, conflicts };
}

export function createRelationship(matterId: string, input: { fromId: string; toId: string; kind: Relationship["kind"]; weight?: number; label?: string; evidence?: Relationship["evidence"] }): Relationship {
  const d = db();
  if (!d.people.get(input.fromId) || !d.people.get(input.toId)) throw Object.assign(new Error("Unknown person"), { status: 404 });
  if (input.fromId === input.toId) throw Object.assign(new Error("A relationship needs two different people"), { status: 400 });
  const r: Relationship = { id: `rel_${nanoid(10)}`, matterId, fromId: input.fromId, toId: input.toId, kind: input.kind, weight: input.weight ?? 1, label: input.label, evidence: input.evidence };
  d.relationships.put(r);
  return r;
}

export function deleteRelationship(id: string) { return db().relationships.delete(id); }

export function listKnowledgeMaps(matterId: string): KnowledgeMap[] {
  return knowledgeMaps().find((m) => m.matterId === matterId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function saveKnowledgeMap(m: KnowledgeMap) { knowledgeMaps().put(m); return m; }

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export function conflictRow(c: Conflict): ConflictRow {
  const d = db();
  const witnessNames = Array.from(new Set(c.sides.filter((s) => s.sourceKind === "deposition").map((s) => d.depositions.get(s.sourceId)?.witnessName).filter((x): x is string => !!x)));
  return { ...c, witnessNames, noteCount: conflictNotes().count((n) => n.conflictId === c.id) };
}

export function listConflicts(matterId: string, filters: { status?: Conflict["status"]; kind?: Conflict["kind"]; severity?: Conflict["severity"]; witnessId?: string; q?: string } = {}): ConflictRow[] {
  const d = db();
  const witnessDeps = filters.witnessId ? new Set(d.depositions.find((x) => x.witnessId === filters.witnessId).map((x) => x.id)) : null;
  const sev = { high: 0, medium: 1, low: 2 };
  return d.conflicts.find((c) => c.matterId === matterId)
    .filter((c) => (!filters.status || c.status === filters.status) && (!filters.kind || c.kind === filters.kind) && (!filters.severity || c.severity === filters.severity) && (!witnessDeps || c.sides.some((s) => s.sourceKind === "deposition" && witnessDeps.has(s.sourceId))) && (!filters.q || `${c.title} ${c.analysis}`.toLowerCase().includes(filters.q.toLowerCase())))
    .sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || sev[a.severity] - sev[b.severity] || a.id.localeCompare(b.id))
    .map(conflictRow);
}

export function getConflict(id: string): { conflict: ConflictRow; notes: ConflictNote[] } | null {
  const c = db().conflicts.get(id);
  if (!c) return null;
  return { conflict: conflictRow(c), notes: conflictNotes().find((n) => n.conflictId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
}

export function createConflict(matterId: string, input: Omit<Conflict, "id" | "matterId" | "status" | "createdBy"> & { id?: string; status?: Conflict["status"]; createdBy?: Conflict["createdBy"] }): Conflict {
  if (!input.title?.trim()) throw Object.assign(new Error("`title` is required"), { status: 400 });
  if (!input.sides || input.sides.length < 2) throw Object.assign(new Error("A conflict needs at least two sides"), { status: 400 });
  const c: Conflict = { ...input, id: input.id ?? `cf_${nanoid(10)}`, matterId, status: input.status ?? "open", createdBy: input.createdBy ?? "user" };
  db().conflicts.put(c);
  return c;
}

export function updateConflict(id: string, patch: Partial<Pick<Conflict, "status" | "severity" | "title" | "analysis" | "kind">> & { addSide?: Conflict["sides"][number]; removeSideIndex?: number }) {
  return db().conflicts.update(id, (c) => {
    const { addSide, removeSideIndex, ...rest } = patch;
    let sides = c.sides;
    if (addSide) sides = [...sides, addSide];
    if (removeSideIndex != null && sides.length > 2) sides = sides.filter((_, i) => i !== removeSideIndex);
    return { ...c, ...rest, sides };
  });
}

export function deleteConflict(id: string) {
  for (const n of conflictNotes().find((n) => n.conflictId === id)) conflictNotes().delete(n.id);
  return db().conflicts.delete(id);
}

export function addConflictNote(conflictId: string, body: string, authorId = currentUser().id): ConflictNote {
  if (!db().conflicts.get(conflictId)) throw Object.assign(new Error("Unknown conflict"), { status: 404 });
  const n: ConflictNote = { id: `cfn_${nanoid(10)}`, conflictId, body: body.trim(), authorId, authorName: db().people.get(authorId)?.name ?? authorId, createdAt: now() };
  conflictNotes().put(n);
  return n;
}

function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function conflictsCsv(matterId: string): string {
  const rows = listConflicts(matterId);
  const header = ["ID", "Severity", "Kind", "Status", "Title", "Witnesses", "Side 1", "Cite 1", "Side 2", "Cite 2", "Side 3", "Cite 3", "Analysis", "Created by"];
  const lines = [header.join(",")];
  for (const c of rows) {
    const s = (i: number) => c.sides[i];
    lines.push([c.id, c.severity, c.kind, c.status, c.title, c.witnessNames.join("; "), s(0)?.excerpt, s(0)?.cite, s(1)?.excerpt, s(1)?.cite, s(2)?.excerpt, s(2)?.cite, c.analysis, c.createdBy].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function conflictsMarkdown(matterId: string): string {
  const rows = listConflicts(matterId);
  const matter = db().matters.get(matterId);
  const out = [`# Conflicts register — ${matter?.shortName ?? matterId}`, "", `${rows.length} conflicts · ${rows.filter((c) => c.status === "open").length} open`, ""];
  for (const c of rows) {
    out.push(`## ${c.title}`);
    out.push(`**Severity:** ${c.severity} · **Kind:** ${c.kind.replace(/_/g, " ")} · **Status:** ${c.status}${c.witnessNames.length ? ` · **Witnesses:** ${c.witnessNames.join(", ")}` : ""}`);
    out.push("");
    for (const s of c.sides) out.push(`- **${s.label}** (${s.cite}): "${s.excerpt}"`);
    out.push("");
    out.push(c.analysis);
    out.push("");
  }
  return out.join("\n");
}

/** Documents referenced by a deposition's exhibits, for the AI outline and cross-analysis prompts. */
export function exhibitDocuments(dep: Deposition): EDocument[] {
  const d = db();
  return (dep.exhibits ?? []).map((e) => { const id = resolveExhibit(dep, e.id).docId; return id ? d.edocs.get(id) : null; }).filter((x): x is EDocument => !!x);
}
