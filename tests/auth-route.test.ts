import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/auth-route-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUST_HEADER;
  delete process.env.AUTH_AUDIT_READS;
  delete process.env.CRON_SECRET;
  delete process.env.LECLAUDE_USER_ID;
});

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { auditCount, recentAudit } from "@/lib/auth/audit";
import { currentObligations, currentPrincipal, requirePrincipal, runWithPrincipal } from "@/lib/auth/context";
import { AuthError } from "@/lib/auth/errors";
import { bodyMatterId, jsonBody, refs } from "@/lib/auth/resources";
import { accessibleMatterIds, matterScope, narrowScope, requireMatterAccess, scopeFor, withAuth } from "@/lib/auth/route";
import { AUTH_HEADER_USER, type Principal } from "@/lib/auth/types";
import { GET as libraryTree } from "@/app/api/library/tree/route";
import { GET as libraryItem } from "@/app/api/library/items/[id]/route";
import { GET as settingsProviders } from "@/app/api/settings/providers/route";
import { GET as homeMatters } from "@/app/api/home/matters/route";
import { GET as workflowsList } from "@/app/api/workflows/route";
import { GET as tickGET } from "@/app/api/intel/jobs/tick/route";

const ENV_KEYS = ["AUTH_MODE", "AUTH_TRUST_HEADER", "AUTH_AUDIT_READS", "CRON_SECRET", "LECLAUDE_USER_ID"];
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
beforeAll(() => { resetSqlite(); db(); });

const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> });
/** Routes declared without a request parameter still receive one from Next; call them the way Next does. */
const call = (h: unknown, ...args: unknown[]) => (h as (...a: unknown[]) => Promise<Response>)(...args);
const nreq = (path: string, init?: RequestInit) => new NextRequest(`http://localhost${path}`, init as ConstructorParameters<typeof NextRequest>[1]);
const headerFor = (p: Partial<Principal>) => ({ [AUTH_HEADER_USER]: JSON.stringify({ id: "u_test", name: "Test", roles: ["associate"], matterIds: [MATTERS.valsara], ...p }) });

describe("withAuth in dev mode", () => {
  it("passes through with the demo principal in context and preserves the handler's return", async () => {
    const handler = withAuth(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => Response.json({ id: (await params).id, principal: currentPrincipal()?.id, obligations: currentObligations() }), {
      action: "read",
      resource: (_req, { id }) => refs.library(id),
    });
    const r = await json(await handler(nreq("/api/x/abc"), { params: Promise.resolve({ id: "abc" }) }));
    expect(r).toEqual({ status: 200, body: { id: "abc", principal: PEOPLE.arjunMehra, obligations: [] } });
  });
  it("audits writes and denials but not plain reads unless AUTH_AUDIT_READS is set", async () => {
    const before = auditCount();
    const read = withAuth(async (req: Request) => Response.json({ ok: true, via: req.url }), { action: "read", resource: () => ({ kind: "task" }) });
    const write = withAuth(async (req: Request) => Response.json({ ok: true, via: req.url }), { action: "write", resource: () => ({ kind: "task", matterId: MATTERS.valsara }) });
    await read(nreq("/api/tasks"));
    expect(auditCount()).toBe(before);
    await write(nreq("/api/tasks", { method: "POST" }));
    expect(auditCount()).toBe(before + 1);
    const last = recentAudit({ limit: 1 })[0];
    expect(last).toMatchObject({ principalId: PEOPLE.arjunMehra, action: "write", decision: "allow", via: "POST /api/tasks", resource: { kind: "task", matterId: MATTERS.valsara } });
    process.env.AUTH_AUDIT_READS = "1";
    await read(nreq("/api/tasks"));
    expect(auditCount()).toBe(before + 2);
    expect(recentAudit({ decision: "allow", action: "read", limit: 1 })[0].via).toBe("GET /api/tasks");
  });
  it("maps AuthError thrown inside the handler to the same 401/403 shapes and audits the denial", async () => {
    const before = auditCount();
    const handler = withAuth(async (req: Request) => { throw AuthError.forbidden(`deep service said no to ${req.method}`); }, { action: "read", resource: () => ({ kind: "task" }) });
    const r = await json(await handler(nreq("/api/deep")));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "Forbidden", code: "forbidden", reason: "deep service said no to GET" });
    expect(auditCount()).toBe(before + 1);
    expect(recentAudit({ limit: 1 })[0]).toMatchObject({ decision: "deny", reason: "deep service said no to GET" });
    const h401 = withAuth(async (req: Request) => { throw AuthError.unauthenticated(`session gone for ${req.method}`); }, { action: "read", resource: () => ({ kind: "task" }) });
    expect((await json(await h401(nreq("/api/deep")))).body).toMatchObject({ code: "unauthenticated" });
  });
  it("returns 400 when the resource cannot be determined and never runs the handler", async () => {
    let ran = false;
    const handler = withAuth(async (req: Request) => { ran = true; return Response.json({ via: req.url }); }, { action: "read", resource: () => { throw new Error("boom"); } });
    expect((await handler(nreq("/api/x"))).status).toBe(400);
    expect(ran).toBe(false);
  });
  it("wrapped real routes still answer 200 for the demo partner", async () => {
    expect((await call(libraryTree, nreq("/api/library/tree"))).status).toBe(200);
    expect((await call(settingsProviders, nreq("/api/settings/providers"))).status).toBe(200);
    expect((await call(homeMatters, nreq("/api/home/matters"))).status).toBe(200);
    expect((await call(workflowsList, nreq("/api/workflows"))).status).toBe(200);
    // Next may also invoke a handler that declares no parameters with none; the wrapper authorizes it as an anonymous GET.
    expect((await call(libraryTree)).status).toBe(200);
    const missing = await libraryItem(nreq("/api/library/items/nope"), { params: Promise.resolve({ id: "nope" }) });
    expect(missing.status).toBe(404);
  });
  it("applies the role matrix to dev personas: a paralegal cannot administer settings", async () => {
    process.env.LECLAUDE_USER_ID = PEOPLE.meeraLobo;
    const r = await json(await call(settingsProviders, nreq("/api/settings/providers")));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "Forbidden", code: "forbidden" });
    expect(String(r.body.reason)).toMatch(/paralegal/);
    expect((await call(libraryTree, nreq("/api/library/tree"))).status).toBe(200);
  });
  it("keeps the tick route's own CRON_SECRET check and lets the cron token through as a service principal", async () => {
    process.env.CRON_SECRET = "cron-1";
    expect((await tickGET(nreq("/api/intel/jobs/tick?limit=1&housekeeping=0&deadlineMs=1000"))).status).toBe(401);
    const ok = await tickGET(nreq("/api/intel/jobs/tick?limit=1&housekeeping=0&deadlineMs=1000", { headers: { authorization: "Bearer cron-1" } }));
    expect(ok.status).toBe(200);
    expect(recentAudit({ principalId: "svc_cron", limit: 1 })[0]).toMatchObject({ action: "run", decision: "allow", source: "service" });
  });
});

describe("withAuth in header mode", () => {
  it("returns 401 without a trusted assertion and one 403 shape without reasons when the policy denies", async () => {
    process.env.AUTH_MODE = "header";
    process.env.AUTH_TRUST_HEADER = "true";
    const exportRoute = withAuth(async (req: Request) => Response.json({ ok: true, via: req.url }), { action: "export", resource: () => ({ kind: "document", id: "ed_x", matterId: MATTERS.valsara }) });
    const missing = await json(await exportRoute(nreq("/api/export")));
    expect(missing).toEqual({ status: 401, body: { error: `Missing ${AUTH_HEADER_USER} header`, code: "unauthenticated" } });
    const denied = await json(await exportRoute(nreq("/api/export", { headers: headerFor({ roles: ["paralegal"] }) })));
    expect(denied).toEqual({ status: 403, body: { error: "Forbidden", code: "forbidden" } });
    expect(recentAudit({ principalId: "u_test", limit: 1 })[0]).toMatchObject({ decision: "deny", action: "export" });
    const foreign = await json(await exportRoute(nreq("/api/export", { headers: headerFor({ roles: ["partner"], matterIds: [MATTERS.northgate] }) })));
    expect(foreign).toEqual({ status: 403, body: { error: "Forbidden", code: "forbidden" } });
    const allowed = await json(await exportRoute(nreq("/api/export", { headers: headerFor({ roles: ["partner"] }) })));
    expect(allowed.status).toBe(200);
    expect(recentAudit({ principalId: "u_test", decision: "allow", limit: 1 })[0].obligations).toEqual(["log-export"]);
  });
  it("a deny never turns into a 404: a foreign matter's existing record answers 403 exactly like a missing one would not", async () => {
    process.env.AUTH_MODE = "header";
    process.env.AUTH_TRUST_HEADER = "true";
    const anyDoc = db().edocs.findOne((d) => d.matterId === MATTERS.northgate)!;
    const route = withAuth(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => Response.json({ leaked: (await params).id }), { action: "read", resource: (_req, { id }) => refs.edoc(id) });
    const r = await json(await route(nreq(`/api/docs/${anyDoc.id}`, { headers: headerFor({ matterIds: [MATTERS.valsara] }) }), { params: Promise.resolve({ id: anyDoc.id }) }));
    expect(r).toEqual({ status: 403, body: { error: "Forbidden", code: "forbidden" } });
  });
  it("outside a request, currentPrincipal is null and requirePrincipal fails closed", () => {
    process.env.AUTH_MODE = "header";
    expect(currentPrincipal()).toBeNull();
    expect(() => requirePrincipal()).toThrow(AuthError);
    const p: Principal = { id: "u", name: "u", tenantId: "t", roles: ["partner"], matterIds: "*", source: "header" };
    expect(runWithPrincipal(p, () => requirePrincipal().id)).toBe("u");
  });
});

describe("scope helpers", () => {
  const partner: Principal = { id: "p", name: "p", tenantId: "default", roles: ["partner"], matterIds: "*", source: "header" };
  const member: Principal = { ...partner, roles: ["associate"], matterIds: [MATTERS.valsara, "m_unknown"] };
  const guest: Principal = { ...partner, roles: ["client_guest"] };
  it("enumerates tenant matters for wildcard access and never widens an explicit list", () => {
    expect(accessibleMatterIds(partner).sort()).toEqual(Object.values(MATTERS).sort());
    expect(matterScope(member).matterIds).toEqual([MATTERS.valsara, "m_unknown"]);
    expect(accessibleMatterIds(guest)).toEqual([]);
    expect(narrowScope(member, [MATTERS.valsara, MATTERS.northgate]).matterIds).toEqual([MATTERS.valsara]);
  });
  it("requireMatterAccess throws 403 for a non-member and scopeFor narrows to the requested matter", () => {
    expect(requireMatterAccess(member, MATTERS.valsara, "write").allow).toBe(true);
    expect(() => requireMatterAccess(member, MATTERS.northgate)).toThrow(AuthError);
    expect(scopeFor(member, MATTERS.valsara).matterIds).toEqual([MATTERS.valsara]);
    expect(scopeFor(member, undefined).matterIds).toEqual([MATTERS.valsara, "m_unknown"]);
    expect(() => scopeFor(member, MATTERS.northgate)).toThrow(/no access to matter/);
  });
});

describe("resource helpers", () => {
  it("jsonBody reads a clone so the handler can still consume the body", async () => {
    const r = nreq("/api/x", { method: "POST", body: JSON.stringify({ matterId: MATTERS.valsara, n: 1 }), headers: { "content-type": "application/json" } });
    expect(await bodyMatterId(r)).toBe(MATTERS.valsara);
    expect(await jsonBody(r)).toEqual({ matterId: MATTERS.valsara, n: 1 });
    expect(await r.json()).toEqual({ matterId: MATTERS.valsara, n: 1 });
    expect(await jsonBody(nreq("/api/x", { method: "POST", body: "nope" }))).toEqual({});
  });
  it("refs carry the record's matter and sensitivity", () => {
    const priv = db().edocs.findOne((d) => d.coding.privileged === true)!;
    expect(refs.edoc(priv.id)).toEqual({ kind: "document", id: priv.id, matterId: priv.matterId, sensitivity: "privileged" });
    expect(refs.edoc("missing")).toEqual({ kind: "document", id: "missing", matterId: undefined, sensitivity: undefined });
    const dep = db().depositions.all()[0];
    expect(refs.deposition(dep.id).matterId).toBe(dep.matterId);
    expect(refs.event("kd_anything").matterId).toBeUndefined();
  });
});
