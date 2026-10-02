/**
 * Matter-scoped internal tools (constitution §22, §52, §53.4): without a scope every tool that reads matter evidence
 * returns { error: "scope_required" } instead of searching everything; with a scope, results carry stable source
 * identifiers and never reach a matter outside the scope.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS } from "@/lib/seed/ids";
import { configuredTenantId } from "@/lib/ai/vector-store";
import { runTool, type AgentEmit, type ToolContext, type ToolDef } from "@/lib/ai/tools";
import type { Principal } from "@/lib/auth/types";
import {
  findPeopleTool, getEdiscoveryDocumentTool, getIntelContextTool, getLibraryItemTool, INTERNAL_TOOLS, matterContextTool, resolveCorpusScope, resolveMatterScope, searchDepositionsTool,
  searchEdiscoveryTool, searchLibraryTool,
} from "@/lib/ai/toolkit/internal";

const VALSARA = MATTERS.valsara;
const NORTHGATE = MATTERS.northgate;
const TENANT = configuredTenantId();

function ctx(extra: Partial<ToolContext> = {}): ToolContext & { events: AgentEmit[] } {
  const events: AgentEmit[] = [];
  return { emit: (e) => events.push(e), state: {}, ...extra, events };
}

const valsaraOnly: Principal = { id: "p_test_assoc", name: "Test Associate", tenantId: TENANT, roles: ["associate"], matterIds: [VALSARA], source: "jwt" };

beforeAll(() => { resetSqlite(); db(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("no scope", () => {
  // AUTH_MODE=header: outside a request there is no ambient principal, so nothing can supply a scope.
  it("every matter-evidence tool refuses instead of searching everything", async () => {
    vi.stubEnv("AUTH_MODE", "header");
    const bare = ctx();
    expect(resolveMatterScope(bare)).toEqual({ ok: false, error: { error: "scope_required", code: "scope_required" } });
    expect(resolveCorpusScope(bare, "library")).toEqual({ ok: false, error: { error: "scope_required", code: "scope_required" } });
    expect(await searchEdiscoveryTool.execute({ query: "groundwater" }, bare)).toEqual({ error: "scope_required", code: "scope_required", count: 0, results: [] });
    expect(await searchLibraryTool.execute({ query: "PAGA" }, bare)).toEqual({ error: "scope_required", code: "scope_required", count: 0, results: [] });
    expect(await matterContextTool.execute({}, bare)).toEqual({ error: "scope_required", code: "scope_required", count: 0, matters: [] });
    expect(await findPeopleTool.execute({ name: "Vasudevan" }, bare)).toEqual({ error: "scope_required", code: "scope_required", count: 0, people: [] });
    expect(await searchDepositionsTool.execute({ query: "study" }, bare)).toEqual({ error: "scope_required", code: "scope_required", count: 0, results: [] });
    expect(await getEdiscoveryDocumentTool.execute({ id_or_bates: "MFC-0041877" }, bare)).toEqual({ error: "scope_required", code: "scope_required" });
    expect(await getLibraryItemTool.execute({ id: "lib_clause_lol_cap" }, bare)).toEqual({ error: "scope_required", code: "scope_required" });
    expect(await getIntelContextTool.execute({ matter_id: VALSARA }, bare)).toEqual({ error: "scope_required", code: "scope_required" });
    for (const t of INTERNAL_TOOLS as ToolDef<never, unknown>[]) {
      const r = await runTool(t, (t.examples![0] ?? {}) as never, bare);
      expect(r.ok, t.name).toBe(false);
      expect(r.error?.code, t.name).toBe("scope_required");
    }
  });
});

describe("scope from the run state (existing callers)", () => {
  it("search_ediscovery narrows to state.matterId and returns matter:// sources with provenance out of band", async () => {
    vi.stubEnv("AUTH_MODE", "header");
    const c = ctx({ state: { matterId: VALSARA } });
    const r = (await searchEdiscoveryTool.execute({ query: "monitoring well MW-7 groundwater", limit: 5 }, c)) as { count: number; scope: { matter_ids: string[] }; results: { source: string; title: string; id: string; bates: string; matter_id: string; passage: string; score: number }[] };
    expect(r.count).toBeGreaterThan(0);
    expect(r.scope).toEqual({ matter_ids: [VALSARA] });
    for (const hit of r.results) {
      expect(hit.matter_id).toBe(VALSARA);
      expect(hit.source).toMatch(new RegExp(`^matter://${VALSARA}/document/${hit.id}(/chunk/\\d+)?$`));
      expect(hit.title).toContain(hit.bates);
      expect(hit.passage.length).toBeGreaterThan(0);
    }
    const ev = c.events.find((e) => e.type === "evidence") as Extract<AgentEmit, { type: "evidence" }>;
    expect(ev.evidence[0]).toMatchObject({ provider: "ediscovery", tool: "search_ediscovery", rank: 1, matterId: VALSARA, tenantId: TENANT, documentId: r.results[0].id, bates: r.results[0].bates });
    expect(ev.evidence[0].retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(r)).not.toContain("retrievedAt");
    const foreign = await searchEdiscoveryTool.execute({ query: "lease", matter_id: NORTHGATE }, c);
    expect(foreign).toMatchObject({ code: "unauthorized", count: 0, results: [] });
  });

  it("search_depositions and find_people stay inside the matter", async () => {
    vi.stubEnv("AUTH_MODE", "header");
    const c = ctx({ state: { matterId: VALSARA } });
    const deps = (await searchDepositionsTool.execute({ query: "study rats liver", limit: 5 }, c)) as { count: number; results: { source: string; matter_id: string; page: number; line: number; witness: string }[] };
    expect(deps.count).toBeGreaterThan(0);
    for (const h of deps.results) {
      expect(h.matter_id).toBe(VALSARA);
      expect(h.source).toBe(`depo://${VALSARA}/${encodeURIComponent((h as unknown as { deposition_id: string }).deposition_id)}/p/${h.page}/l/${h.line}`);
    }
    const people = (await findPeopleTool.execute({ name: "Vasudevan" }, c)) as { count: number; people: { id: string; matter_ids: string[] }[]; documents_mentioning: { source: string; matter_id: string }[] };
    expect(people.count).toBeGreaterThan(0);
    expect(people.people.every((p) => p.matter_ids.every((m) => m === VALSARA))).toBe(true);
    expect(people.documents_mentioning.every((d) => d.matter_id === VALSARA && d.source.startsWith(`matter://${VALSARA}/document/`))).toBe(true);
  });
});

describe("scope from a principal", () => {
  it("a principal limited to one matter cannot read another matter's documents, even by Bates number", async () => {
    const c = ctx({ principal: valsaraOnly });
    const ng = db().edocs.findOne((d) => d.matterId === NORTHGATE)!;
    const denied = await runTool(getEdiscoveryDocumentTool as ToolDef<never, unknown>, { id_or_bates: ng.bates } as never, c);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("not_found"); // never resolved to another document, never leaks existence
    const byId = await runTool(getEdiscoveryDocumentTool as ToolDef<never, unknown>, { id_or_bates: ng.id } as never, c);
    expect(byId.error?.code).toBe("not_found");
    const valsara = db().edocs.findOne((d) => d.matterId === VALSARA)!;
    const ok = await runTool(getEdiscoveryDocumentTool as ToolDef<never, unknown>, { id_or_bates: valsara.bates.toLowerCase(), max_chars: 120 } as never, c);
    expect(ok.ok).toBe(true);
    const v = ok.value as { source: string; id: string; text: string; window: { offset: number; length: number; total: number; next_offset: number | null } };
    expect(v.source).toBe(`matter://${VALSARA}/document/${valsara.id}`);
    expect(v.window).toMatchObject({ offset: 0, length: 120, total: valsara.text.length });
    if (valsara.text.length > 120) { expect(v.window.next_offset).toBe(120); expect(v.text).toMatch(/\[truncated: \d+ more chars; ask for the next window\]$/); }
    const search = (await searchEdiscoveryTool.execute({ query: "lease", matter_id: NORTHGATE }, c)) as { code?: string };
    expect(search.code).toBe("unauthorized");
    const scoped = (await searchEdiscoveryTool.execute({ query: "groundwater" }, c)) as { results: { matter_id: string }[] };
    expect(scoped.results.every((h) => h.matter_id === VALSARA)).toBe(true);
  });

  it("get_matter_context lists only matters in scope", async () => {
    const c = ctx({ principal: valsaraOnly });
    const r = (await matterContextTool.execute({}, c)) as { count: number; matters: { id: string; team: unknown[] }[] };
    expect(r.count).toBe(1);
    expect(r.matters[0].id).toBe(VALSARA);
    expect((await matterContextTool.execute({ query: "Northgate" }, c)) as { count: number }).toMatchObject({ count: 0 });
    expect(await matterContextTool.execute({ matter_id: NORTHGATE }, c)).toMatchObject({ code: "unauthorized", count: 0, matters: [] });
    const partner: Principal = { ...valsaraOnly, roles: ["partner"], matterIds: "*" };
    const all = (await matterContextTool.execute({}, ctx({ principal: partner }))) as { count: number };
    expect(all.count).toBeGreaterThanOrEqual(5);
  });

  it("library tools use the library corpus with the principal's matters and stable library:// sources", async () => {
    const c = ctx({ principal: valsaraOnly });
    const r = (await searchLibraryTool.execute({ query: "consequential damages", type: "clause", limit: 5 }, c)) as { count: number; results: { source: string; id: string; matter_id?: string }[] };
    expect(r.count).toBeGreaterThan(0);
    for (const hit of r.results) {
      expect(hit.source).toBe(`library://${TENANT}/item/${hit.id}`);
      expect(hit.matter_id === undefined || hit.matter_id === VALSARA).toBe(true);
    }
    const item = (await getLibraryItemTool.execute({ id: r.results[0].id, max_chars: 50 }, c)) as { source: string; content: string; window: { next_offset: number | null } };
    expect(item.source).toBe(`library://${TENANT}/item/${r.results[0].id}`);
    expect(item.window.next_offset).toBe(50);
    expect(item.content).toMatch(/\[truncated: \d+ more chars; ask for the next window\]$/);
    const foreign = db().library.findOne((i) => i.matterId === NORTHGATE && i.type !== "folder");
    if (foreign) {
      const denied = await runTool(getLibraryItemTool as ToolDef<never, unknown>, { id: foreign.id } as never, c);
      expect(denied.error?.code).toBe("not_found");
    }
  });

  it("get_intel_context guards personal context and matter context by principal", async () => {
    const c = ctx({ principal: valsaraOnly });
    expect(await getIntelContextTool.execute({ user_id: "p_jwhitfield" }, c)).toMatchObject({ code: "unauthorized" });
    expect(await getIntelContextTool.execute({ matter_id: NORTHGATE }, c)).toMatchObject({ code: "unauthorized" });
    const r = (await getIntelContextTool.execute({ matter_id: VALSARA }, c)) as { matter: { id: string; recent_docket: { source: string }[] } };
    expect(r.matter.id).toBe(VALSARA);
    for (const d of r.matter.recent_docket) expect(d.source).toMatch(new RegExp(`^intel://${TENANT}/document/`));
  });
});

describe("explicit ctx.scope", () => {
  it("a corpus-only scope cannot reach matter evidence; a matter scope narrows corpus lookups", async () => {
    const libraryOnly = ctx({ scope: { tenantId: TENANT, corpus: "library" } });
    expect(await searchEdiscoveryTool.execute({ query: "groundwater" }, libraryOnly)).toMatchObject({ code: "unauthorized", count: 0 });
    expect(resolveCorpusScope(libraryOnly, "intel").ok).toBe(false);
    expect(resolveCorpusScope(libraryOnly, "library")).toEqual({ ok: true, scope: { tenantId: TENANT, corpus: "library" } });
    const matterScoped = ctx({ scope: { tenantId: TENANT, matterIds: [VALSARA] } });
    expect(resolveCorpusScope(matterScoped, "library")).toEqual({ ok: true, scope: { tenantId: TENANT, corpus: "library", matterIds: [VALSARA] } });
    expect(resolveMatterScope(matterScoped, NORTHGATE).ok).toBe(false);
    // ctx.scope wins over an ambient dev principal with wider access.
    const r = (await searchEdiscoveryTool.execute({ query: "groundwater" }, matterScoped)) as { scope: { matter_ids: string[] }; results: { matter_id: string }[] };
    expect(r.scope.matter_ids).toEqual([VALSARA]);
    expect(r.results.every((h) => h.matter_id === VALSARA)).toBe(true);
  });

  it("strict mode is transparent to scoped tools", async () => {
    vi.stubEnv("LECLAUDE_STRICT_SCOPE", "true");
    const r = (await searchEdiscoveryTool.execute({ query: "groundwater plume" }, ctx({ scope: { tenantId: TENANT, matterIds: [VALSARA] } }))) as { count: number; code?: string };
    expect(r.code).toBeUndefined();
    expect(r.count).toBeGreaterThan(0);
  });
});
