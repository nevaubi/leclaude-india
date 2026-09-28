import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // A private, empty production database: reference data only, no sample workspace.
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/demo-pack-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUST_HEADER;
  delete process.env.LECLAUDE_USER_ID;
  delete process.env.CRON_SECRET;
});

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { setWorkspaceUser } from "@/lib/current-user";
import { AUTH_HEADER_USER } from "@/lib/auth/types";
import { hybridSearch, VECTOR_COLLECTIONS } from "@/lib/ai/vector-store";
import { matterRetrievalScope, searchDocuments } from "@/modules/ediscovery/service";
import { createMember, setupWorkspace } from "@/modules/workspace/service";
import { createMatter } from "@/modules/matters/service";
import { listTeam } from "@/modules/workspace/service";
import { ensureLibraryStructure, searchLibrary } from "@/modules/library/service";
import { DEMO_MANIFEST_KEY, loadDemoPack, type DemoManifest } from "@/modules/demo";
import { DEMO_MATTERS, DEMO_TEAM } from "@/modules/demo/ids";
import { DEMO_FOLDERS } from "@/modules/demo/workspace";
import { criminalCodesFor, validateCnr } from "@/modules/matters/india";
import type { MatterRecord } from "@/modules/matters/types";
import { runWithPrincipal } from "@/lib/auth/context";
import { devPrincipal } from "@/lib/auth/principal";
import * as demo from "@/app/api/demo/route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const nreq = (method: string, headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/demo", { method, headers });
const call = async (h: unknown, req: NextRequest) => { const r = await (h as (r: NextRequest) => Promise<Response>)(req); return { status: r.status, body: (await r.json()) as Body }; };
const asHeader = (p: Body) => {
  process.env.AUTH_MODE = "header";
  process.env.AUTH_TRUST_HEADER = "true";
  return { [AUTH_HEADER_USER]: JSON.stringify(p) };
};

const C = DEMO_MATTERS.commercial;
let ownerId = "";
let ownMatterId = "";
let ownMemberId = "";
let firstCounts: Body = {};
let snapshot: Record<string, number> = {};

function collectionSizes(): Record<string, number> {
  const rows = db().raw.prepare("SELECT collection, COUNT(*) AS n FROM docs GROUP BY collection").all() as { collection: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.collection, Number(r.n)]));
}

beforeAll(() => {
  resetSqlite();
  setWorkspaceUser(null);
  db();
});
afterEach(() => { delete process.env.AUTH_MODE; delete process.env.AUTH_TRUST_HEADER; });

describe("demo pack on an empty workspace", () => {
  it("refuses to load before the workspace is set up", async () => {
    // No owner yet: the placeholder principal may not administer the workspace.
    const r = await call(demo.POST, nreq("POST"));
    expect(r.status).toBe(403);
    // The service itself also refuses without a workspace owner.
    await expect(loadDemoPack({ principal: devPrincipal() })).rejects.toMatchObject({ status: 409, code: "not_configured" });
    expect(db().matters.count()).toBe(0);
  });

  it("sets up an owner plus one non-demo matter and member that removal must not touch", () => {
    ownerId = setupWorkspace({ firmName: "Hale & Ortiz LLP", name: "Rebecca Ortiz", email: "rortiz@hale-ortiz.com", role: "Partner" }).owner!.id;
    ownMemberId = createMember({ name: "Daniel Park", email: "dpark@hale-ortiz.com", role: "Associate" }).id;
    ownMatterId = runWithPrincipal(devPrincipal(), () => createMatter({ name: "Valdosta Water Litigation", practiceArea: "Products Liability", clientSide: "plaintiff" })).id as string;
    expect(db().matters.count()).toBe(1);
  });

  it("reports not loaded", async () => {
    const r = await call(demo.GET, nreq("GET"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ loaded: false, counts: null, matterId: C });
  });

  it("forbids a non-admin principal from loading or removing", async () => {
    const assoc = { id: ownMemberId, name: "Daniel Park", roles: ["associate"], matterIds: "*" };
    expect((await call(demo.POST, nreq("POST", asHeader(assoc)))).status).toBe(403);
    expect((await call(demo.DELETE, nreq("DELETE", asHeader(assoc)))).status).toBe(403);
    const para = { id: "p_someone", name: "Para Legal", roles: ["paralegal"], matterIds: "*" };
    expect((await call(demo.POST, nreq("POST", asHeader(para)))).status).toBe(403);
    expect(db().kv.get(DEMO_MANIFEST_KEY)).toBeNull();
  });

  it("loads the pack through the route (owner)", async () => {
    ensureLibraryStructure();
    snapshot = collectionSizes();
    const r = await call(demo.POST, nreq("POST"));
    expect(r.status).toBe(200);
    expect(r.body.loaded).toBe(true);
    firstCounts = r.body.counts;
    expect(firstCounts.matters).toBe(3);
    expect(firstCounts.teamMembers).toBe(2);
    expect(firstCounts.officeDocs).toBeGreaterThanOrEqual(3);
    expect(firstCounts.tasks).toBeGreaterThanOrEqual(10);
    expect(firstCounts.events).toBeGreaterThanOrEqual(6);
    expect(firstCounts.libraryItems).toBeGreaterThanOrEqual(14);
    expect(firstCounts.edocs).toBeGreaterThanOrEqual(100);
    expect(firstCounts.depositions).toBe(2);
    expect(r.body.matterIds).toEqual(Object.values(DEMO_MATTERS));
    expect(r.body.durationMs).toBeLessThan(30_000);
    console.log(`[demo-pack] load ${r.body.durationMs} ms`, JSON.stringify(firstCounts));
  });

  it("wrote the matters (with Indian case particulars), team, folders, office drafts, tasks and hearings", () => {
    const d = db();
    const suit = d.collection<MatterRecord>("matters").get(C)!;
    expect(suit.leadAttorneyId).toBe(ownerId);
    expect(new Set(suit.teamIds)).toEqual(new Set([ownerId, DEMO_TEAM.junior, DEMO_TEAM.clerk]));
    expect(suit.caption).toMatch(/demonstration data/);
    expect(suit.india).toMatchObject({ courtId: "ka-blr-commercial", caseType: "Com.O.S.", caseNumber: "1187", caseYear: 2023 });
    const writ = d.collection<MatterRecord>("matters").get(DEMO_MATTERS.writ)!;
    expect(writ.india).toMatchObject({ courtId: "hc-telangana", caseType: "W.P.", caseNumber: "18234" });
    expect(validateCnr(writ.india!.cnr!, "hc-telangana")).toMatchObject({ ok: true });
    const bail = d.collection<MatterRecord>("matters").get(DEMO_MATTERS.bail)!;
    expect(bail.india?.offenceDate).toBe("2026-08-12");
    expect(criminalCodesFor(bail.india?.offenceDate)?.substantive).toBe("BNS");
    const team = listTeam();
    expect(team.filter((m) => m.id === DEMO_TEAM.junior || m.id === DEMO_TEAM.clerk).map((m) => [m.firmRole, m.active])).toEqual(expect.arrayContaining([["Associate", true], ["Paralegal", true]]));
    for (const id of Object.values(DEMO_FOLDERS)) expect(d.library.get(id)?.type).toBe("folder");
    const drafts = d.officeDocs.find((x) => Object.values(DEMO_MATTERS).includes(x.matterId as never));
    expect(drafts.map((x) => x.kind)).toEqual(["word", "word", "word"]);
    for (const doc of drafts) expect(d.library.findOne((l) => l.officeDocId === doc.id)).not.toBeNull();
    const bailDraft = drafts.find((x) => x.matterId === DEMO_MATTERS.bail)!;
    expect(JSON.stringify(bailDraft.content)).toContain("SECTION 483 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA");
    expect(JSON.stringify(bailDraft.content)).toContain("HIGH COURT FOR THE STATE OF TELANGANA");
    const tasks = d.tasks.find((t) => Object.values(DEMO_MATTERS).includes(t.matterId as never));
    const today = new Date().toISOString().slice(0, 10);
    expect(tasks.some((t) => t.status !== "done" && t.dueAt! < today)).toBe(true);
    expect(tasks.some((t) => t.dueAt! > today)).toBe(true);
    expect(new Set(tasks.map((t) => t.assigneeId))).toEqual(new Set([ownerId, DEMO_TEAM.junior, DEMO_TEAM.clerk]));
    // Each matter has its next hearing on the calendar, on the date stored with the case particulars.
    for (const m of [suit, writ, bail]) expect(d.events.find((e) => e.matterId === m.id && e.kind === "hearing" && e.startsAt.slice(0, 10) === m.india!.nextHearing).length, m.id).toBe(1);
  });

  it("resolves exhibit marks exactly and reports an unmarked exhibit instead of substituting", async () => {
    const hit = await runWithPrincipal(devPrincipal(), () => searchDocuments({ matterId: C, q: "Ex.P14" }));
    expect(hit.hits.map((h) => (h as { india?: { exhibit?: string } }).india?.exhibit)).toEqual(["Ex.P14"]);
    const range = await runWithPrincipal(devPrincipal(), () => searchDocuments({ matterId: C, q: 'exhibit:"Ex.P1 to P25"', limit: 200 }));
    expect(range.total).toBe(25);
    const none = await runWithPrincipal(devPrincipal(), () => searchDocuments({ matterId: C, q: "Ex.P40" }));
    expect(none.total).toBe(0);
    expect(none.parsed.warnings).toContain("Ex.P40 is not marked in this matter");
    // The writ matter has no Ex.P14: the mark does not reach across matters.
    const other = await runWithPrincipal(devPrincipal(), () => searchDocuments({ matterId: DEMO_MATTERS.writ, q: "Ex.P14" }));
    expect(other.total).toBe(0);
  });

  it("indexes the e-discovery documents within the matter only", async () => {
    const res = await runWithPrincipal(devPrincipal(), () => searchDocuments({ matterId: C, q: "acknowledge invoices", semantic: true }));
    expect(res.total).toBeGreaterThan(0);
    const hits = await hybridSearch(VECTOR_COLLECTIONS.edocs, "Sankalp acknowledge", { k: 5, scope: matterRetrievalScope(C) });
    expect(hits.length).toBeGreaterThan(0);
    const elsewhere = await hybridSearch(VECTOR_COLLECTIONS.edocs, "Sankalp acknowledge", { k: 5, scope: matterRetrievalScope(ownMatterId) });
    expect(elsewhere).toEqual([]);
    // The commercial suit's documents do not surface in the Hyderabad writ's scope.
    const writScope = await hybridSearch(VECTOR_COLLECTIONS.edocs, "Sankalp", { k: 5, scope: matterRetrievalScope(DEMO_MATTERS.writ) });
    expect(writScope.every((h) => !h.docId.includes("_ed_p"))).toBe(true);
    // Library notes and office documents are searchable in the library as soon as the load returns.
    const lib = await runWithPrincipal(devPrincipal(), () => searchLibrary("master data"));
    expect(lib.hits.some((h) => h.item.id.startsWith("demo_in_lib_"))).toBe(true);
    const office = await runWithPrincipal(devPrincipal(), () => searchLibrary("Nagarik Suraksha"));
    expect(office.hits.some((h) => h.source === "office")).toBe(true);
  });

  it("reloads in place without duplicates", async () => {
    const before = collectionSizes();
    const r = await call(demo.POST, nreq("POST"));
    expect(r.status).toBe(200);
    expect(r.body.counts).toEqual(firstCounts);
    const after = collectionSizes();
    // Office versions are recreated with the documents; everything else is identical in size.
    for (const [name, n] of Object.entries(after)) if (name !== "office_versions" && !/audit/.test(name)) expect([name, n]).toEqual([name, before[name]]);
    expect(db().matters.count((m) => m.id === C)).toBe(1);
  });

  it("removes exactly the manifest and leaves the owner and non-demo records", async () => {
    const manifest = db().kv.get<DemoManifest>(DEMO_MANIFEST_KEY)!;
    expect(manifest.records.people).not.toContain(ownerId);
    const r = await call(demo.DELETE, nreq("DELETE"));
    expect(r.status).toBe(200);
    expect(r.body.loaded).toBe(false);
    console.log(`[demo-pack] remove ${r.body.durationMs} ms`, JSON.stringify(r.body.removed));
    expect(db().kv.get(DEMO_MANIFEST_KEY)).toBeNull();
    for (const [name, ids] of Object.entries(manifest.records)) for (const id of ids) expect(db().collection<{ id: string }>(name).has(id)).toBe(false);
    for (const id of manifest.blobs) expect(db().blobs.meta(id)).toBeNull();
    for (const key of manifest.kv) expect(db().kv.get(key)).toBeNull();
    expect(db().people.get(ownerId)).not.toBeNull();
    expect(db().people.get(ownMemberId)).not.toBeNull();
    expect(db().matters.get(ownMatterId)).not.toBeNull();
    const hits = await hybridSearch(VECTOR_COLLECTIONS.edocs, "Sankalp acknowledge", { k: 5, scope: matterRetrievalScope(C) });
    expect(hits).toEqual([]);
    // Every collection is back to its pre-load size (audit events are append-only and excluded).
    const after = collectionSizes();
    for (const [name, n] of Object.entries(snapshot)) if (!/audit/.test(name)) expect([name, after[name] ?? 0]).toEqual([name, n]);
    for (const name of Object.keys(after)) if (!/audit/.test(name) && !(name in snapshot)) expect([name, after[name]]).toEqual([name, 0]);
  });

  it("refuses to remove when nothing is loaded", async () => {
    const r = await call(demo.DELETE, nreq("DELETE"));
    expect(r.status).toBe(404);
  });
});
