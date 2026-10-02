/**
 * Retrieval matter scope (constitution §22, §27, §44): two matters share a surname and a witness name; a
 * matter-scoped search never returns the other matter's rows, people/document lookups never bind across matters,
 * and a missing scope throws in strict mode. Runs offline (keyword-only index, no API key).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { getSqlite } from "@/lib/db/sqlite";
import type { Deposition, EDocument, LibraryItem, Matter, Person } from "@/lib/types/domain";
import {
  assertValidScope, configuredTenantId, describeScope, hybridSearch, indexDocument, indexDocuments, indexStats, resetUnscopedRetrievalReport, rowInScope, ScopeError,
  strictScopeEnabled, unscopedRetrievalReport, VECTOR_COLLECTIONS, type CorpusRetrievalScope, type MatterRetrievalScope,
} from "@/lib/ai/vector-store";
import { tenantId } from "@/lib/auth/principal";
import { depositionSource, documentSource, findDepositionPassages, findDocuments, findPeople, searchEdiscoveryTool, searchDepositionsTool, findPeopleTool } from "@/lib/ai/toolkit/internal";
import type { ToolContext } from "@/lib/ai/tools";

const TENANT = configuredTenantId();
const ALPHA = "m_scope_alpha";
const BETA = "m_scope_beta";
const VOSS_A = "p_scope_voss_alpha";
const VOSS_B = "p_scope_voss_beta";
const alphaScope: MatterRetrievalScope = { tenantId: TENANT, matterIds: [ALPHA] };
const betaScope: MatterRetrievalScope = { tenantId: TENANT, matterIds: [BETA] };
const LIB = "scope_test_library";

function matter(id: string, name: string): Matter {
  return { id, slug: id, name, shortName: name, client: "Riverbend Holdings", clientSide: "defendant", practiceArea: "Litigation", status: "active", openedAt: "2026-01-01", teamIds: [] };
}

function person(id: string, name: string, role: Person["role"]): Person {
  return { id, name, role, organization: "Riverbend" };
}

function doc(id: string, matterId: string, custodianId: string, bates: string, subject: string, text: string): EDocument {
  return { id, matterId, bates, date: "2024-05-01", custodianId, custodianName: "Hema Vasudevan", type: "Email", subject, text, coding: {}, from: "Hema Vasudevan", to: ["Counsel"], entities: { people: ["Hema Vasudevan"], orgs: [], places: [] } };
}

function depo(id: string, matterId: string, witnessId: string, answer: string): Deposition {
  return { id, matterId, witnessId, witnessName: "Hema Vasudevan", date: "2025-02-10", takenBy: "Plaintiffs", pages: 40, status: "transcribed", transcript: [{ page: 12, line: 4, question: "What did you know about the Riverbend outfall?", answer }, { page: 30, line: 18, question: "Anything else?", answer: "No." }] };
}

const ALPHA_DOCS = [
  doc("ed_scope_alpha_1", ALPHA, VOSS_A, "RB-ALPHA-0001", "Riverbend outfall sampling — Vasudevan notes", "Hema Vasudevan reviewed the Riverbend outfall sampling data for the discharge permit renewal."),
  doc("ed_scope_alpha_2", ALPHA, VOSS_A, "RB-ALPHA-0002", "Vasudevan follow-up on Riverbend sampling", "Follow-up from Vasudevan: the Riverbend outfall exceedance needs a corrective action plan."),
];
const BETA_DOCS = [
  doc("ed_scope_beta_1", BETA, VOSS_B, "RB-BETA-0001", "Riverbend warehouse lease — Vasudevan review", "Hema Vasudevan reviewed the Riverbend warehouse lease renewal and the outfall easement language."),
];

function ctxWith(scope?: ToolContext["scope"], state: Record<string, unknown> = {}): ToolContext & { events: unknown[] } {
  const events: unknown[] = [];
  return { emit: (e) => events.push(e), state, scope, events };
}

beforeAll(async () => {
  resetSqlite();
  // A legacy vector row (indexed before scope columns existed) must be backfilled from its own metadata.
  getSqlite().prepare("INSERT INTO vectors (collection, doc_id, chunk_index, text, embedding, meta, model) VALUES (?, ?, ?, ?, NULL, ?, NULL)").run(VECTOR_COLLECTIONS.edocs, "ed_scope_legacy", 0, "Legacy Riverbend outfall memo indexed before scope columns existed", JSON.stringify({ matterId: ALPHA }));
  const d = db();
  d.matters.putMany([matter(ALPHA, "Riverbend Outfall Permit"), matter(BETA, "Riverbend Warehouse Lease")]);
  d.people.putMany([person(VOSS_A, "Hema Vasudevan", "custodian"), person(VOSS_B, "Hema Vasudevan", "witness")]);
  d.edocs.putMany([...ALPHA_DOCS, ...BETA_DOCS]);
  d.depositions.putMany([depo("dep_scope_alpha", ALPHA, VOSS_A, "I saw the outfall sampling results in May."), depo("dep_scope_beta", BETA, VOSS_B, "The outfall easement was part of the lease.")]);
  await indexDocuments(VECTOR_COLLECTIONS.edocs, ALPHA_DOCS.map((x) => ({ id: x.id, text: `${x.subject}\n${x.text}`, matterId: x.matterId, meta: { matterId: x.matterId, bates: x.bates } })), { embed: false, scope: alphaScope });
  await indexDocuments(VECTOR_COLLECTIONS.edocs, BETA_DOCS.map((x) => ({ id: x.id, text: `${x.subject}\n${x.text}`, matterId: x.matterId, meta: { matterId: x.matterId, bates: x.bates } })), { embed: false, scope: betaScope });
  const items: LibraryItem[] = [
    { id: "lib_scope_firm", parentId: null, name: "Firm-wide outfall permit template", type: "template", content: "Riverbend outfall permit renewal template", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    { id: "lib_scope_alpha", parentId: null, name: "Alpha outfall memo", type: "note", matterId: ALPHA, content: "Riverbend outfall memo for the alpha matter", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    { id: "lib_scope_beta", parentId: null, name: "Beta outfall memo", type: "note", matterId: BETA, content: "Riverbend outfall memo for the beta matter", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  ];
  await indexDocuments(LIB, items.map((i) => ({ id: i.id, text: `${i.name}\n${i.content}`, matterId: i.matterId ?? null })), { embed: false, scope: { tenantId: TENANT, corpus: "library" } });
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("scope model", () => {
  it("keeps the retrieval tenant default in sync with the auth layer", () => {
    expect(configuredTenantId()).toBe(tenantId());
  });
  it("validates scopes and describes them without content", () => {
    expect(() => assertValidScope({ tenantId: "", matterIds: [ALPHA] })).toThrow(ScopeError);
    expect(() => assertValidScope({ tenantId: TENANT, matterIds: ["ok", 3 as unknown as string] })).toThrow(ScopeError);
    expect(() => assertValidScope({ tenantId: TENANT, corpus: "everything" as "library" })).toThrow(ScopeError);
    expect(() => assertValidScope(alphaScope)).not.toThrow();
    expect(describeScope(alphaScope)).toBe(`matter:${TENANT}/[${ALPHA}]`);
    expect(describeScope({ tenantId: TENANT, corpus: "library", matterIds: [ALPHA] })).toBe(`corpus:${TENANT}/library[${ALPHA}]`);
    expect(describeScope(undefined)).toBe("unscoped");
  });
  it("applies the row predicate: tenant, matter and corpus", () => {
    const row = { tenantId: TENANT, matterId: ALPHA, corpus: null };
    expect(rowInScope(row, alphaScope)).toBe(true);
    expect(rowInScope(row, betaScope)).toBe(false);
    expect(rowInScope(row, { tenantId: "other-tenant", matterIds: [ALPHA] })).toBe(false);
    expect(rowInScope(row, { tenantId: TENANT, corpus: "library" })).toBe(false); // matter evidence is unreachable through a corpus scope
    const lib = { tenantId: TENANT, matterId: null, corpus: "library" };
    expect(rowInScope(lib, { tenantId: TENANT, corpus: "library" })).toBe(true);
    expect(rowInScope(lib, { tenantId: TENANT, corpus: "intel" })).toBe(false);
    expect(rowInScope(lib, alphaScope)).toBe(false); // firm-wide rows are not matter evidence
    expect(rowInScope({ tenantId: TENANT, matterId: BETA, corpus: "library" }, { tenantId: TENANT, corpus: "library", matterIds: [ALPHA] })).toBe(false);
  });
});

describe("cross-matter isolation (§44 name collision)", () => {
  it("indexes legacy rows into the scope model by backfilling from their metadata", async () => {
    const cols = (getSqlite().prepare("PRAGMA table_info(vectors)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["tenant_id", "matter_id", "corpus"]));
    const hits = await hybridSearch(VECTOR_COLLECTIONS.edocs, "legacy Riverbend outfall memo", { scope: alphaScope, k: 5 });
    expect(hits.map((h) => h.docId)).toContain("ed_scope_legacy");
    expect(hits.find((h) => h.docId === "ed_scope_legacy")).toMatchObject({ tenantId: TENANT, matterId: ALPHA });
    expect(await hybridSearch(VECTOR_COLLECTIONS.edocs, "legacy Riverbend outfall memo", { scope: betaScope, k: 5 })).toEqual([]);
  });
  it("a matter-scoped search never returns the other matter's rows", async () => {
    const alpha = await hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan Riverbend outfall", { scope: alphaScope, k: 10 });
    expect(alpha.length).toBeGreaterThan(0);
    expect(alpha.every((h) => h.matterId === ALPHA && h.tenantId === TENANT)).toBe(true);
    expect(alpha.some((h) => h.docId.startsWith("ed_scope_beta"))).toBe(false);
    const beta = await hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan Riverbend outfall", { scope: betaScope, k: 10 });
    expect(beta.map((h) => h.docId)).toEqual(["ed_scope_beta_1"]);
    const both = await hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan Riverbend outfall", { scope: { tenantId: TENANT, matterIds: [ALPHA, BETA] }, k: 10 });
    expect(new Set(both.map((h) => h.matterId))).toEqual(new Set([ALPHA, BETA]));
    expect(await hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan Riverbend outfall", { scope: { tenantId: "other-tenant", matterIds: [ALPHA] }, k: 10 })).toEqual([]);
    expect(await hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan Riverbend outfall", { scope: { tenantId: TENANT, matterIds: [] }, k: 10 })).toEqual([]);
    expect(indexStats(VECTOR_COLLECTIONS.edocs, betaScope).docs).toBe(1);
    expect(indexStats(VECTOR_COLLECTIONS.edocs, alphaScope).docs).toBe(3);
  });
  it("a corpus scope reaches firm-wide rows plus the scoped matters' rows only", async () => {
    const all = await hybridSearch(LIB, "Riverbend outfall", { scope: { tenantId: TENANT, corpus: "library" }, k: 10 });
    expect(new Set(all.map((h) => h.docId))).toEqual(new Set(["lib_scope_firm", "lib_scope_alpha", "lib_scope_beta"]));
    const alphaOnly = await hybridSearch(LIB, "Riverbend outfall", { scope: { tenantId: TENANT, corpus: "library", matterIds: [ALPHA] } satisfies CorpusRetrievalScope, k: 10 });
    expect(new Set(alphaOnly.map((h) => h.docId))).toEqual(new Set(["lib_scope_firm", "lib_scope_alpha"]));
    expect(await hybridSearch(LIB, "Riverbend outfall", { scope: { tenantId: TENANT, corpus: "intel" }, k: 10 })).toEqual([]);
    expect(await hybridSearch(LIB, "Riverbend outfall", { scope: { tenantId: "other-tenant", corpus: "library" }, k: 10 })).toEqual([]);
    const asMatter = await hybridSearch(LIB, "Riverbend outfall", { scope: alphaScope, k: 10 });
    expect(asMatter.map((h) => h.docId)).toEqual(["lib_scope_alpha"]);
  });
  it("refuses to index a document under a matter it did not declare", async () => {
    const stray = { id: "ed_scope_stray", text: "stray", matterId: BETA, meta: { matterId: BETA } };
    await expect(indexDocuments(VECTOR_COLLECTIONS.edocs, [stray], { embed: false, scope: alphaScope })).rejects.toBeInstanceOf(ScopeError);
    await expect(indexDocument(VECTOR_COLLECTIONS.edocs, "ed_scope_nomatter", "no matter declared", {}, { embed: false, scope: { tenantId: TENANT, matterIds: [ALPHA, BETA] } })).rejects.toThrow(/does not declare a matter/);
    expect(await hybridSearch(VECTOR_COLLECTIONS.edocs, "stray", { scope: betaScope, k: 5 })).toEqual([]);
    // A single-matter scope may bind undeclared documents to that matter (the caller declared it).
    await indexDocument(VECTOR_COLLECTIONS.edocs, "ed_scope_bound", "bound to alpha by the caller's single-matter scope", {}, { embed: false, scope: alphaScope });
    expect((await hybridSearch(VECTOR_COLLECTIONS.edocs, "bound alpha single-matter", { scope: alphaScope, k: 5 })).map((h) => h.docId)).toContain("ed_scope_bound");
  });
  it("findPeople / findDocuments / findDepositionPassages never bind across matters", () => {
    const a = findPeople("Vasudevan", alphaScope);
    expect(a.map((p) => p.id)).toEqual([VOSS_A]);
    expect(a[0]).toMatchObject({ name: "Hema Vasudevan", matter_ids: [ALPHA], documents: 2, depositions: 1 });
    expect(a[0].linked_as).toEqual(expect.arrayContaining(["custodian", "witness"]));
    const b = findPeople("Hema Vasudevan", betaScope);
    expect(b.map((p) => p.id)).toEqual([VOSS_B]);
    const both = findPeople("vasudevan", { tenantId: TENANT, matterIds: [ALPHA, BETA] });
    expect(new Set(both.map((p) => p.id))).toEqual(new Set([VOSS_A, VOSS_B])); // same name, two people, never merged
    expect(findPeople("Vasudevan", { tenantId: TENANT, matterIds: [] })).toEqual([]);
    expect(findPeople("Nobody Here", alphaScope)).toEqual([]);

    const docsA = findDocuments("Vasudevan", alphaScope);
    expect(docsA.map((d) => d.id).sort()).toEqual(["ed_scope_alpha_1", "ed_scope_alpha_2"]);
    expect(docsA.every((d) => d.matter_id === ALPHA && d.source === documentSource(ALPHA, d.id))).toBe(true);
    expect(findDocuments("Vasudevan", betaScope).map((d) => d.id)).toEqual(["ed_scope_beta_1"]);

    const passA = findDepositionPassages("outfall", alphaScope);
    expect(passA.map((p) => p.deposition_id)).toEqual(["dep_scope_alpha"]);
    expect(passA[0].source).toBe(depositionSource(ALPHA, "dep_scope_alpha", 12, 4));
    expect(passA[0].source).toBe(`depo://${ALPHA}/dep_scope_alpha/p/12/l/4`);
    expect(findDepositionPassages("outfall", betaScope, { witness: "Vasudevan" }).map((p) => p.matter_id)).toEqual([BETA]);
  });
  it("the internal tools honour an explicit ctx.scope and never widen to a requested foreign matter", async () => {
    const ctx = ctxWith(alphaScope);
    const r = (await searchEdiscoveryTool.execute({ query: "Vasudevan Riverbend outfall" }, ctx)) as { count: number; scope: { matter_ids: string[] }; results: { source: string; matter_id: string }[] };
    expect(r.count).toBeGreaterThan(0);
    expect(r.scope.matter_ids).toEqual([ALPHA]);
    expect(r.results.every((x) => x.matter_id === ALPHA && x.source.startsWith(`matter://${ALPHA}/document/`))).toBe(true);
    const foreign = (await searchEdiscoveryTool.execute({ query: "Vasudevan", matter_id: BETA }, ctx)) as { code?: string; count: number; results: unknown[] };
    expect(foreign).toMatchObject({ code: "unauthorized", count: 0, results: [] });
    const people = (await findPeopleTool.execute({ name: "Vasudevan" }, ctxWith(betaScope))) as { people: { id: string }[] };
    expect(people.people.map((p) => p.id)).toEqual([VOSS_B]);
    const deps = (await searchDepositionsTool.execute({ query: "outfall" }, ctxWith(alphaScope))) as { results: { source: string }[] };
    expect(deps.results.map((d) => d.source)).toEqual([`depo://${ALPHA}/dep_scope_alpha/p/12/l/4`]);
    // Provenance travels out of band, not in the model-facing result.
    const evidence = ctx.events.filter((e) => (e as { type: string }).type === "evidence") as { evidence: { source: string; matterId: string; tenantId: string; hash?: string; retrievedAt: string; provider: string }[] }[];
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].evidence[0]).toMatchObject({ provider: "ediscovery", matterId: ALPHA, tenantId: TENANT });
    expect(evidence[0].evidence[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain("retrievedAt");
  });
});

describe("strict and lenient modes", () => {
  it("throws ScopeError for unscoped search and index in strict mode", async () => {
    vi.stubEnv("LECLAUDE_STRICT_SCOPE", "true");
    expect(strictScopeEnabled()).toBe(true);
    await expect(hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan", { k: 5 })).rejects.toBeInstanceOf(ScopeError);
    await expect(hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan", { k: 5, filter: (m) => m.matterId === ALPHA })).rejects.toThrow(/retrieval without scope/);
    await expect(indexDocuments(VECTOR_COLLECTIONS.edocs, [{ id: "ed_scope_strict", text: "x", matterId: ALPHA }], { embed: false })).rejects.toBeInstanceOf(ScopeError);
    await expect(indexDocument("strict_col", "d", "x", {}, { embed: false })).rejects.toBeInstanceOf(ScopeError);
    // Scoped calls keep working in strict mode.
    expect((await hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan Riverbend outfall", { scope: alphaScope, k: 5 })).length).toBeGreaterThan(0);
  });
  it("in lenient mode an unscoped call is recorded per call site, warned once, and never widened by the layer", async () => {
    vi.stubEnv("LECLAUDE_STRICT_SCOPE", "false");
    expect(strictScopeEnabled()).toBe(false);
    resetUnscopedRetrievalReport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: (string | null | undefined)[][] = [];
    for (let i = 0; i < 2; i++) seen.push((await hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan Riverbend outfall", { k: 10 })).map((h) => h.matterId)); // one call site, called twice
    expect(new Set(seen[0])).toEqual(new Set([ALPHA, BETA])); // legacy behaviour: nothing narrows without a scope or filter
    let report = unscopedRetrievalReport();
    expect(report.strict).toBe(false);
    expect(report.total).toBe(2);
    expect(report.sites).toHaveLength(1);
    expect(report.sites[0]).toMatchObject({ operation: "search", collection: VECTOR_COLLECTIONS.edocs, count: 2 });
    expect(report.sites[0].site).toContain("ai-scope-isolation.test.ts");
    const warningsFor = () => warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("retrieval.unscoped"));
    expect(warningsFor()).toHaveLength(1); // warned once per site, not per call
    expect(JSON.parse(warningsFor()[0])).toMatchObject({ event: "retrieval.unscoped", operation: "search", collection: VECTOR_COLLECTIONS.edocs });
    // The caller's own filter still narrows (never widened by the layer); a second call site is reported separately.
    const narrowed = await hybridSearch(VECTOR_COLLECTIONS.edocs, "Vasudevan Riverbend outfall", { k: 10, filter: (m) => m.matterId === BETA });
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.every((h) => h.matterId === BETA)).toBe(true);
    report = unscopedRetrievalReport();
    expect(report.total).toBe(3);
    expect(report.sites).toHaveLength(2);
    expect(warningsFor()).toHaveLength(2);
    // Unscoped indexing is reported too.
    await indexDocument("scope_lenient_col", "d1", "lenient index", { matterId: ALPHA }, { embed: false });
    expect(unscopedRetrievalReport().sites.some((s) => s.operation === "index" && s.collection === "scope_lenient_col")).toBe(true);
    expect((await hybridSearch("scope_lenient_col", "lenient index", { scope: alphaScope }))[0]).toMatchObject({ docId: "d1", tenantId: TENANT, matterId: ALPHA });
  });
});
