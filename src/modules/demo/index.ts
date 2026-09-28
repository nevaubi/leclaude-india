import "server-only";
/**
 * India demonstration pack (Bengaluru and Hyderabad practice): load, status and removal (Settings → Demo data).
 *
 * The pack is loaded only on request by the owner, a partner or an admin (never implicitly). Every record it writes
 * has a stable id, so loading again updates the same records in place. Every written id is recorded, by collection,
 * in the manifest (kv "demo:india-blr-hyd:manifest"); removal deletes exactly those records (plus the blobs and
 * search-index rows of the demo documents) and the manifest, and never the workspace owner.
 *
 * Everything runs synchronously against the local mirror except PDF generation and search indexing, so a load or a
 * removal fits in one serverless request; `withDb` persists the writes to the shared store when the request ends.
 */
import { db } from "@/lib/db";
import type { Principal } from "@/lib/auth/types";
import type { LibraryItem, OfficeDocument, OfficeKind } from "@/lib/types/domain";
import { configuredTenantId, indexDocuments, removeDocument, VECTOR_COLLECTIONS } from "@/lib/ai/vector-store";
import { extractPlainText } from "@/lib/ai/toolkit/internal";
import { indexTextFor as libraryIndexText } from "@/modules/library/data";
import { audit } from "@/lib/integrity/audit";
import { getWorkspace } from "@/lib/workspace";
import { ensureLibraryStructure } from "@/modules/library/service";
import { createOfficeDoc, deleteOfficeDoc } from "@/modules/office/shared/docs-service";
import { settingsForTemplate } from "@/modules/office/word/constants";
import { matterRetrievalScope } from "@/modules/ediscovery/service";
import { indexTextFor } from "@/modules/ediscovery/privilege";
import type { IndiaEDocument } from "@/modules/ediscovery/india";
import { buildIndiaEdiscoveryDemo, type IndiaEdiscoveryDemo } from "@/modules/demo/ediscovery";
import { cite } from "@/modules/demo/ediscovery/depo-helpers";
import { DEMO_MATTERS, DEMO_PACK } from "./ids";
import { buildDemoWorkspace, demoMeta, emailDomainOf, DEMO_FOLDERS, type DemoBuildContext } from "./workspace";
import { bailDraft, synopsisDraft, writDraft, DEMO_OFFICE_IDS } from "./workspace/office";

export const DEMO_MANIFEST_KEY = `demo:${DEMO_PACK}:manifest`;
export const DEMO_MANIFEST_VERSION = 1;

/** Collection names as stored (the `docs.collection` column), for the typed handles in `db()`. */
const C = {
  people: "people",
  matters: "matters",
  tasks: "tasks",
  events: "events",
  updates: "team_updates",
  library: "library_items",
  officeDocs: "office_documents",
  officeVersions: "office_versions",
  officeComments: "office_comments",
  edocs: "ediscovery_documents",
  depositions: "depositions",
  timeline: "timeline_events",
  relationships: "relationships",
  conflicts: "conflicts",
  issueCodes: "issue_codes",
  privilegeLog: "privilege_log",
} as const;

export interface DemoManifest {
  pack: typeof DEMO_PACK;
  version: number;
  loadedAt: string;
  loadedBy: { id: string; name: string };
  /** Written record ids by collection name. */
  records: Record<string, string[]>;
  kv: string[];
  blobs: string[];
  /** Search-index rows by vector collection. */
  vectors: Record<string, string[]>;
}

export type DemoCounts = {
  matters: number;
  teamMembers: number;
  people: number;
  tasks: number;
  events: number;
  updates: number;
  libraryItems: number;
  officeDocs: number;
  edocs: number;
  depositions: number;
  timeline: number;
  relationships: number;
  conflicts: number;
  issueCodes: number;
  privilegeLog: number;
  indexed: number;
};

export interface DemoStatus {
  loaded: boolean;
  loadedAt: string | null;
  loadedBy: string | null;
  counts: DemoCounts | null;
  /** Bengaluru commercial suit (opened by "Open matter"). */
  matterId: string;
  /** Hyderabad writ petition. */
  relatedMatterId: string;
  /** Every demo matter id (commercial suit, writ, bail). */
  matterIds: string[];
}

export class DemoPackError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// E-discovery half (built by src/modules/demo/ediscovery)
// ---------------------------------------------------------------------------

type Rec = { id: string } & Record<string, unknown>;

/** The e-discovery pack normalized to what the loader writes. */
interface EdiscoveryPart {
  collections: Record<string, Rec[]>;
  kv: Record<string, unknown>;
  blobs: { id: string; bytes: Uint8Array; mime: string; name?: string; meta?: Record<string, unknown> }[];
}

/** The e-discovery pack's typed bundle as collections by stored name (its module-private collections included). */
function normalizeEdiscovery(b: IndiaEdiscoveryDemo): EdiscoveryPart {
  const out: EdiscoveryPart = { collections: {}, kv: { ...b.kv }, blobs: [] };
  const add = (name: string, recs: { id: string }[]) => { if (recs.length) out.collections[name] = [...(out.collections[name] ?? []), ...(recs as Rec[])]; };
  add(C.edocs, b.edocs);
  add(C.issueCodes, b.issueCodes);
  add(C.depositions, b.depositions);
  add(C.timeline, b.timeline);
  add(C.relationships, b.relationships);
  add(C.conflicts, b.conflicts);
  add(C.privilegeLog, b.privilegeLog);
  for (const c of b.collections) add(c.collection, c.docs);
  return out;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function readManifest(): DemoManifest | null {
  const m = db().kv.get<DemoManifest>(DEMO_MANIFEST_KEY);
  return m && typeof m === "object" && m.records ? m : null;
}

function present(name: string, ids: string[] | undefined): number {
  if (!ids?.length) return 0;
  const col = db().collection<{ id: string }>(name);
  let n = 0;
  for (const id of ids) if (col.has(id)) n++;
  return n;
}

function countsFor(m: DemoManifest): DemoCounts {
  const r = m.records;
  const people = db().collection<{ id: string; role?: string }>(C.people);
  const team = (r[C.people] ?? []).filter((id) => { const p = people.get(id); return !!p && (p.role === "attorney" || p.role === "paralegal" || p.role === "staff"); }).length;
  const libraryIds = r[C.library] ?? [];
  return {
    matters: present(C.matters, r[C.matters]),
    teamMembers: team,
    people: present(C.people, r[C.people]),
    tasks: present(C.tasks, r[C.tasks]),
    events: present(C.events, r[C.events]),
    updates: present(C.updates, r[C.updates]),
    libraryItems: present(C.library, libraryIds),
    officeDocs: present(C.officeDocs, r[C.officeDocs]),
    edocs: present(C.edocs, r[C.edocs]),
    depositions: present(C.depositions, r[C.depositions]),
    timeline: present(C.timeline, r[C.timeline]),
    relationships: present(C.relationships, r[C.relationships]),
    conflicts: present(C.conflicts, r[C.conflicts]),
    issueCodes: present(C.issueCodes, r[C.issueCodes]),
    privilegeLog: present(C.privilegeLog, r[C.privilegeLog]),
    indexed: (m.vectors[VECTOR_COLLECTIONS.edocs] ?? []).length,
  };
}

export function demoStatus(): DemoStatus {
  const m = readManifest();
  return { loaded: !!m, loadedAt: m?.loadedAt ?? null, loadedBy: m?.loadedBy.name ?? null, counts: m ? countsFor(m) : null, matterId: DEMO_MATTERS.commercial, relatedMatterId: DEMO_MATTERS.writ, matterIds: Object.values(DEMO_MATTERS) };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

interface OfficeSpec { id: string; key: string; kind: OfficeKind; matterId: string; title: string; folder: string; tags: string[]; content: () => unknown | Promise<unknown>; meta?: Record<string, unknown> }

export interface LoadResult { status: DemoStatus; durationMs: number }

export async function loadDemoPack({ principal }: { principal: Principal }): Promise<LoadResult> {
  const started = Date.now();
  const d = db();
  const ws = getWorkspace();
  if (!ws.configured || !ws.owner) throw new DemoPackError("Set up the workspace before loading demo data.", 409, "not_configured");
  const owner = ws.owner;
  const previous = readManifest();
  const now = new Date();
  const ctx: DemoBuildContext = { now, ownerId: owner.id, ownerName: owner.name, firmName: ws.firmName, emailDomain: emailDomainOf(owner.email) };

  // System folders (Matters root and friends) are structural, not demo records: create them first so they are
  // never captured in the manifest.
  ensureLibraryStructure();

  const records: Record<string, Set<string>> = {};
  const track = (name: string, ids: Iterable<string>) => { const s = (records[name] ??= new Set()); for (const id of ids) s.add(id); };
  const put = <T extends { id: string }>(name: string, docs: T[]) => {
    if (!docs.length) return;
    d.collection<T>(name).putMany(docs);
    track(name, docs.map((x) => x.id));
  };

  const built = buildIndiaEdiscoveryDemo();
  const ed = normalizeEdiscovery(built);
  const edDocs = (ed.collections[C.edocs] ?? []) as unknown as IndiaEDocument[];

  const takenEmails = new Set(d.people.all().filter((p) => !p.id.includes("_demo_") && p.email).map((p) => p.email!.toLowerCase()));
  const w = buildDemoWorkspace(ctx, { takenEmails });

  // People: the matters' witnesses, officers and record sources, then the team. The workspace owner is never
  // written or recorded by the pack.
  const people = new Map<string, Rec>();
  for (const p of [...((ed.collections[C.people] ?? []) as Rec[]), ...w.team] as Rec[]) if (p.id !== owner.id) people.set(p.id, { ...(people.get(p.id) ?? {}), ...p });
  put(C.people, Array.from(people.values()));

  put(C.matters, w.matters);
  put(C.library, [...w.folders, ...w.libraryItems]);
  put(C.tasks, w.tasks);
  put(C.events, w.events);
  put(C.updates, w.updates);

  for (const [name, recs] of Object.entries(ed.collections)) {
    if (name === C.people) continue;
    put(name, recs);
  }
  const kvKeys: string[] = [];
  for (const [key, value] of Object.entries(ed.kv)) { d.kv.set(key, value); kvKeys.push(key); }
  const blobIds: string[] = [];
  for (const b of ed.blobs) { d.blobs.put(b.bytes, b.mime, { id: b.id, name: b.name, meta: { ...(b.meta ?? {}), ...demoMeta() } }); blobIds.push(b.id); }

  // Office documents through the office service (versions, library rows and search index as the editors produce).
  // The drafts are built from the Indian drafting templates against the demo matters just written.
  const matterById = new Map(w.matters.map((m) => [m.id, m]));
  const [pw1, dw1] = built.depositions;
  const officeSpecs: OfficeSpec[] = [
    { id: DEMO_OFFICE_IDS.bail, key: "bail", kind: "word", matterId: DEMO_MATTERS.bail, title: "Bail petition under s.483 BNSS — Crl.P. 7710/2026 (draft)", folder: DEMO_FOLDERS.bail, tags: ["bail", "BNSS", "draft"], content: () => bailDraft(matterById.get(DEMO_MATTERS.bail)!), meta: { settings: settingsForTemplate("word-in-regular-bail"), templateId: "word-in-regular-bail" } },
    { id: DEMO_OFFICE_IDS.writ, key: "writ", kind: "word", matterId: DEMO_MATTERS.writ, title: "Writ petition — W.P. 18234/2026 (Telangana format, draft)", folder: DEMO_FOLDERS.writ, tags: ["writ", "Article 226", "draft"], content: () => writDraft(matterById.get(DEMO_MATTERS.writ)!), meta: { settings: settingsForTemplate("word-in-writ-telangana"), templateId: "word-in-writ-telangana" } },
    { id: DEMO_OFFICE_IDS.synopsis, key: "synopsis", kind: "word", matterId: DEMO_MATTERS.commercial, title: "Synopsis of arguments — Com.O.S. 1187/2023 (draft)", folder: DEMO_FOLDERS.arguments, tags: ["arguments", "synopsis", "draft"], content: () => synopsisDraft({ dw1Admission: cite(dw1, "It is true that Ex.P9 UAT sign-off e-mail was sent by me."), dw1Qualification: cite(dw1, "was not a final acceptance"), dw1Defects: cite(dw1, "It is true that all 14 defects listed in Ex.D2 were closed before the rollout."), pw1Slip: cite(pw1, "Witness volunteers that the slip was due to the Defendant's delay") }), meta: { settings: settingsForTemplate("word-in-plaint") } },
  ];
  const officeDocs: OfficeDocument[] = [];
  for (const spec of officeSpecs) {
    const content = await spec.content();
    if (d.officeDocs.has(spec.id)) deleteOfficeDoc(spec.id);
    const doc = createOfficeDoc({ id: spec.id, kind: spec.kind, title: spec.title, content, matterId: spec.matterId, folderId: spec.folder, tags: ["demo", ...spec.tags], meta: demoMeta(spec.meta ?? {}) });
    officeDocs.push(doc);
    track(C.officeDocs, [doc.id]);
    track(C.officeVersions, d.officeVersions.find((v) => v.docId === doc.id).map((v) => v.id));
  }
  const officeRows: LibraryItem[] = officeDocs.map((doc, i) => ({
    id: `demo_in_lib_doc_${officeSpecs[i].key}`, parentId: officeSpecs[i].folder, name: doc.title, type: ({ word: "docx", sheet: "xlsx", slides: "pptx", pdf: "pdf" } as const)[doc.kind], matterId: officeSpecs[i].matterId, officeDocId: doc.id,
    size: doc.size, tags: doc.tags, ownerId: owner.id, sharedWith: ["matter-team"], practiceArea: "Litigation", createdAt: doc.createdAt, updatedAt: doc.updatedAt, version: doc.contentVersion, status: "draft",
  }));
  put(C.library, officeRows);

  // Keyword indexes (no embeddings, so the load never waits on a model provider). E-discovery documents are indexed
  // per matter through the path e-discovery ingest uses.
  const vectors: Record<string, string[]> = {};
  // Library notes/clauses/links and the office documents go into the tenant's library corpus (matter kept on each
  // row), the same rows the library's own rebuild writes, so library search finds them immediately.
  const libraryScope = { tenantId: principal.tenantId || configuredTenantId(), corpus: "library" as const };
  const notes = w.libraryItems.filter((i) => i.type !== "folder");
  await indexDocuments(VECTOR_COLLECTIONS.library, notes.map((i) => ({ id: i.id, text: libraryIndexText(i), matterId: i.matterId ?? null, meta: { type: i.type, matterId: i.matterId, practiceArea: i.practiceArea, parentId: i.parentId } })), { embed: false, scope: libraryScope });
  vectors[VECTOR_COLLECTIONS.library] = notes.map((i) => i.id);
  await indexDocuments(VECTOR_COLLECTIONS.office, officeDocs.map((doc) => ({ id: doc.id, text: `${doc.title}\n${extractPlainText(doc.content)}`, matterId: doc.matterId ?? null, meta: { kind: doc.kind, title: doc.title, matterId: doc.matterId } })), { embed: false, scope: libraryScope });
  vectors[VECTOR_COLLECTIONS.office] = officeDocs.map((x) => x.id);
  const byMatter = new Map<string, IndiaEDocument[]>();
  for (const doc of edDocs) byMatter.set(doc.matterId, [...(byMatter.get(doc.matterId) ?? []), doc]);
  for (const [matterId, docs] of byMatter) {
    await indexDocuments(VECTOR_COLLECTIONS.edocs, docs.map((x) => ({ id: x.id, text: indexTextFor(x), meta: { matterId: x.matterId, custodianId: x.custodianId, type: x.type, date: x.date, bates: x.bates } })), { embed: false, scope: matterRetrievalScope(matterId) });
    vectors[VECTOR_COLLECTIONS.edocs] = [...(vectors[VECTOR_COLLECTIONS.edocs] ?? []), ...docs.map((x) => x.id)];
  }

  const manifest: DemoManifest = {
    pack: DEMO_PACK,
    version: DEMO_MANIFEST_VERSION,
    loadedAt: now.toISOString(),
    loadedBy: { id: principal.id, name: principal.name },
    records: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, Array.from(v)])),
    kv: kvKeys,
    blobs: Array.from(new Set(blobIds)),
    vectors,
  };

  // Re-load: anything the previous load wrote that this load did not (e.g. an older pack version) is removed.
  if (previous) removeRecords(diffManifest(previous, manifest), owner.id);
  d.kv.set(DEMO_MANIFEST_KEY, manifest);

  const status = demoStatus();
  audit(previous ? "update" : "create", { kind: "demo.pack", id: DEMO_PACK, label: "India demo data (Bengaluru and Hyderabad)", matterId: DEMO_MATTERS.commercial }, { counts: status.counts, reload: !!previous }, { id: principal.id, name: principal.name });
  return { status, durationMs: Date.now() - started };
}

/** Records in `prev` that `next` does not contain. */
function diffManifest(prev: DemoManifest, next: DemoManifest): DemoManifest {
  const minus = (a: string[] = [], b: string[] = []) => { const s = new Set(b); return a.filter((x) => !s.has(x)); };
  const records: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(prev.records)) records[name] = minus(ids, next.records[name]);
  const vectors: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(prev.vectors ?? {})) vectors[name] = minus(ids, next.vectors[name]);
  return { ...prev, records, kv: minus(prev.kv, next.kv), blobs: minus(prev.blobs, next.blobs), vectors };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export interface RemoveResult { removed: Record<string, number>; durationMs: number }

function removeRecords(m: DemoManifest, ownerId: string | undefined): Record<string, number> {
  const d = db();
  const removed: Record<string, number> = {};
  const officeIds = new Set(m.records[C.officeDocs] ?? []);
  // Dependents of demo office documents created after the load (autosave versions, comments, library rows the
  // library adds for editor-created documents) go with them; they belong to no other record.
  if (officeIds.size) {
    track(m.records, C.officeVersions, d.officeVersions.find((v) => officeIds.has(v.docId)).map((v) => v.id));
    track(m.records, C.officeComments, d.officeComments.find((c) => officeIds.has(c.docId)).map((c) => c.id));
    track(m.records, C.library, d.library.find((l) => !!l.officeDocId && officeIds.has(l.officeDocId)).map((l) => l.id));
  }
  for (const [name, ids] of Object.entries(m.records)) {
    const col = d.collection<{ id: string }>(name);
    let n = 0;
    for (const id of ids) {
      if (name === C.people && id === ownerId) continue;
      if (col.delete(id)) n++;
    }
    if (n) removed[name] = n;
  }
  for (const key of m.kv) d.kv.delete(key);
  for (const id of m.blobs) d.blobs.delete(id);
  for (const [collection, ids] of Object.entries(m.vectors ?? {})) for (const id of ids) removeDocument(collection, id);
  return removed;
}

function track(records: Record<string, string[]>, name: string, ids: string[]) {
  if (!ids.length) return;
  records[name] = Array.from(new Set([...(records[name] ?? []), ...ids]));
}

export function removeDemoPack({ principal }: { principal: Principal }): RemoveResult {
  const started = Date.now();
  const m = readManifest();
  if (!m) throw new DemoPackError("The demo data is not loaded.", 404, "not_loaded");
  const removed = removeRecords({ ...m, records: { ...m.records } }, getWorkspace().owner?.id);
  db().kv.delete(DEMO_MANIFEST_KEY);
  audit("delete", { kind: "demo.pack", id: DEMO_PACK, label: "India demo data (Bengaluru and Hyderabad)", matterId: DEMO_MATTERS.commercial }, { removed }, { id: principal.id, name: principal.name });
  return { removed, durationMs: Date.now() - started };
}
