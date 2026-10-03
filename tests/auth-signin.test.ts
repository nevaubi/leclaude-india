import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/auth-signin-vitest-${process.pid}`;
  // A production-shaped database: reference data only, no demo workspace or people.
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  for (const k of ["AUTH_MODE", "AUTH_TRUST_HEADER", "AUTH_JWT_SECRET", "AUTH_SETUP_TOKEN", "AUTH_JWT_ISSUER", "AUTH_JWT_AUDIENCE", "CRON_SECRET", "LECLAUDE_USER_ID", "AUTH_COOKIE_SECURE"]) delete process.env[k];
});

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { setWorkspaceUser } from "@/lib/current-user";
import { getWorkspace } from "@/lib/workspace";
import { CREDENTIALS_COLLECTION, getCredential, hasPassword, setPassword } from "@/lib/auth/accounts";
import { resetAllLimits } from "@/lib/auth/rate-limit";
import { issueSessionToken } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/session-token";
import { resolvePrincipal, sessionPrincipalFromToken } from "@/lib/auth/principal";
import * as login from "@/app/api/auth/login/route";
import * as logout from "@/app/api/auth/logout/route";
import * as bootstrap from "@/app/api/auth/bootstrap/route";
import * as session from "@/app/api/auth/session/route";
import * as workspace from "@/app/api/workspace/route";
import * as people from "@/app/api/people/route";
import * as person from "@/app/api/people/[id]/route";
import * as password from "@/app/api/people/[id]/password/route";
import * as adminAccess from "@/app/api/admin/access/route";
import * as inviteAccess from "@/app/api/auth/invite/route";
import { createMember, type PersonRecord } from "@/modules/workspace/service";
import { INVITATIONS_COLLECTION, type InvitationRecord } from "@/modules/workspace/admin-access";
import { GENERIC_SIGNIN_ERROR } from "@/modules/workspace/signin";
import * as edStats from "@/app/api/ediscovery/stats/route";
import * as edDocs from "@/app/api/ediscovery/docs/route";
import * as quickSearch from "@/app/api/quick-search/route";

// Test-only values: never real secrets.
const SECRET = "test-secret-for-vitest-only-0123456789abcdef";
const SETUP_TOKEN = "test-setup-token-123";
const OWNER_PW = "owner password long";
const ASHA_PW = "asha password long";
const RAVI_PW = "ravi password long";

const nreq = (path: string, init?: RequestInit) => new NextRequest(`http://localhost${path}`, init as ConstructorParameters<typeof NextRequest>[1]);
const send = (path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) => nreq(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => ({ status: r.status, headers: r.headers, body: (await r.json()) as Record<string, any> });
const call = (h: unknown, ...args: unknown[]) => (h as (...a: unknown[]) => Promise<Response>)(...args);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const cookieFrom = (r: { headers: Headers }) => /lc_session=([^;]*)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
const withCookie = (token: string, extra: Record<string, string> = {}) => ({ cookie: `${SESSION_COOKIE}=${token}`, ...extra });

let ownerId = "";
let ashaId = "";
let raviId = "";

beforeAll(() => {
  resetSqlite();
  setWorkspaceUser(null);
  db();
});
beforeEach(() => {
  process.env.AUTH_JWT_SECRET = SECRET;
  resetAllLimits();
});
afterEach(() => {
  for (const k of ["AUTH_MODE", "AUTH_SETUP_TOKEN"]) delete process.env[k];
});

describe("fresh workspace: setup collects the owner password, bootstrap needs the setup token", () => {
  it("rejects a too-short owner password at /api/workspace setup without creating the workspace", async () => {
    const r = await json(await call(workspace.POST, send("/api/workspace", { firmName: "Rao & Co", name: "Meera Rao", email: "meera@firm.test", role: "Partner", password: "short" })));
    expect(r.status).toBe(422);
    expect(r.body.fields.password).toBeTruthy();
    expect(getWorkspace().configured).toBe(false);
  });

  it("reports bootstrap status as booleans only", async () => {
    const r = await json(await call(bootstrap.GET, nreq("/api/auth/bootstrap")));
    expect(r.body).toEqual({ configured: false, needsOwnerPassword: true, setupTokenConfigured: false, signInConfigured: true, enforced: false });
  });

  it("refuses bootstrap when AUTH_SETUP_TOKEN is not configured", async () => {
    const r = await json(await call(bootstrap.POST, send("/api/auth/bootstrap", { token: "anything", password: OWNER_PW })));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("setup_not_configured");
  });

  it("refuses a wrong setup token (constant-time compare) and rate-limits repeated guesses", async () => {
    process.env.AUTH_SETUP_TOKEN = SETUP_TOKEN;
    const body = { token: "wrong-token", password: OWNER_PW, firmName: "Rao & Co", name: "Meera Rao", email: "meera@firm.test", role: "Partner" };
    const r = await json(await call(bootstrap.POST, send("/api/auth/bootstrap", body, "POST", { "x-forwarded-for": "10.0.0.9" })));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("bad_setup_token");
    expect(getWorkspace().configured).toBe(false);
    for (let i = 0; i < 4; i++) await call(bootstrap.POST, send("/api/auth/bootstrap", body, "POST", { "x-forwarded-for": "10.0.0.9" }));
    const limited = await json(await call(bootstrap.POST, send("/api/auth/bootstrap", { ...body, token: SETUP_TOKEN }, "POST", { "x-forwarded-for": "10.0.0.9" })));
    expect(limited.status).toBe(429);
    expect(getWorkspace().configured).toBe(false);
  });

  it("creates the workspace, stores the hashed owner password and signs the owner in", async () => {
    process.env.AUTH_SETUP_TOKEN = SETUP_TOKEN;
    const r = await json(await call(bootstrap.POST, send("/api/auth/bootstrap", { token: SETUP_TOKEN, password: OWNER_PW, firmName: "Rao & Co", name: "Meera Rao", email: "meera@firm.test", role: "Partner" })));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, workspaceCreated: true, signedIn: true });
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^lc_session=[\w-]+\.[\w-]+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/); // not Secure outside production
    ownerId = getWorkspace().owner!.id;
    const cred = getCredential(ownerId)!;
    expect(cred.hash.startsWith("scrypt$")).toBe(true);
    expect(JSON.stringify(cred)).not.toContain(OWNER_PW);
    expect(sessionPrincipalFromToken(cookieFrom(r)).id).toBe(ownerId);
  });

  it("closes the bootstrap once any account has a password", async () => {
    process.env.AUTH_SETUP_TOKEN = SETUP_TOKEN;
    const r = await json(await call(bootstrap.POST, send("/api/auth/bootstrap", { token: SETUP_TOKEN, password: "another password x" })));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("already_bootstrapped");
    expect((await json(await call(bootstrap.GET, nreq("/api/auth/bootstrap")))).body.needsOwnerPassword).toBe(false);
  });
});

describe("sign-in", () => {
  beforeAll(async () => {
    ashaId = createMember({ name: "Asha Iyer", email: "asha@firm.test", role: "Associate" }).id;
    raviId = createMember({ name: "Ravi Menon", email: "ravi@firm.test", role: "Partner" }).id;
    await setPassword(ashaId, ASHA_PW, "test");
    await setPassword(raviId, RAVI_PW, "test");
  });

  it("signs in with the right password and sets the session cookie", async () => {
    const r = await json(await call(login.POST, send("/api/auth/login", { email: "ASHA@firm.test ", password: ASHA_PW, next: "/matters?x=1" })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, user: { id: ashaId, name: "Asha Iyer" }, next: "/matters?x=1" });
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
    expect(r.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(JSON.stringify(r.body)).not.toContain("scrypt");
  });

  it("answers wrong password and unknown email with the same generic 401", async () => {
    const wrong = await json(await call(login.POST, send("/api/auth/login", { email: "asha@firm.test", password: "not the password" })));
    const unknown = await json(await call(login.POST, send("/api/auth/login", { email: "nobody@firm.test", password: "not the password" })));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual({ error: GENERIC_SIGNIN_ERROR, code: "invalid_credentials" });
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("never treats an unsafe next as a redirect target", async () => {
    const r = await json(await call(login.POST, send("/api/auth/login", { email: "asha@firm.test", password: ASHA_PW, next: "https://evil.example/" })));
    expect(r.body.next).toBe("/");
  });

  it("rate-limits per email+IP (429 + Retry-After, even with the right password) without locking other IPs out", async () => {
    const ip = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 5; i++) expect((await call(login.POST, send("/api/auth/login", { email: "ravi@firm.test", password: "bad password x" }, "POST", ip))).status).toBe(401);
    const limited = await json(await call(login.POST, send("/api/auth/login", { email: "ravi@firm.test", password: RAVI_PW }, "POST", ip)));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const elsewhere = await call(login.POST, send("/api/auth/login", { email: "ravi@firm.test", password: RAVI_PW }, "POST", { "x-forwarded-for": "198.51.100.1" }));
    expect(elsewhere.status).toBe(200);
  });

  it("rate-limits per IP across many emails", async () => {
    const ip = { "x-forwarded-for": "192.0.2.50" };
    for (let i = 0; i < 30; i++) await call(login.POST, send("/api/auth/login", { email: `guess${i}@firm.test`, password: "bad password x" }, "POST", ip));
    expect((await call(login.POST, send("/api/auth/login", { email: "asha@firm.test", password: ASHA_PW }, "POST", ip))).status).toBe(429);
  });

  it("returns 422 for a missing email or password and 503 when AUTH_JWT_SECRET is not set", async () => {
    expect((await call(login.POST, send("/api/auth/login", { email: "asha@firm.test" }))).status).toBe(422);
    delete process.env.AUTH_JWT_SECRET;
    const r = await json(await call(login.POST, send("/api/auth/login", { email: "asha@firm.test", password: ASHA_PW })));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("not_configured");
  });

  it("sign-out clears the cookie", async () => {
    const r = await call(logout.POST, send("/api/auth/logout", {}));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/^lc_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
  });
});

describe("cookie principal resolution (AUTH_MODE=jwt)", () => {
  const signInAs = async (email: string, pw: string) => cookieFrom(await call(login.POST, send("/api/auth/login", { email, password: pw })) as Response);

  it("accepts the session cookie and rejects a missing or forged one", async () => {
    process.env.AUTH_MODE = "jwt";
    const token = await signInAs("asha@firm.test", ASHA_PW);
    const ok = await json(await call(session.GET, nreq("/api/auth/session", { headers: withCookie(token) })));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: ashaId, roles: ["associate"], source: "jwt" });
    expect((await call(session.GET, nreq("/api/auth/session"))).status).toBe(401);
    const [h, p] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), roles: ["admin"], sub: raviId })).toString("base64url")}.${token.split(".")[2]}`;
    expect((await call(session.GET, nreq("/api/auth/session", { headers: withCookie(forged) }))).status).toBe(401);
    expect((await call(session.GET, nreq("/api/auth/session", { headers: withCookie("garbage") }))).status).toBe(401);
  });

  it("derives matter access from the live record: staffed matters only for an associate, tenant-wide for a partner", async () => {
    process.env.AUTH_MODE = "jwt";
    const matters = db().collection<{ id: string } & Record<string, unknown>>("matters");
    matters.put({ id: "m_t_staffed", name: "Staffed", shortName: "Staffed", client: "C", clientSide: "plaintiff", status: "active", teamIds: [ashaId] });
    matters.put({ id: "m_t_other", name: "Other", shortName: "Other", client: "C", clientSide: "plaintiff", status: "active", teamIds: [raviId] });
    const asha = await resolvePrincipal(nreq("/x", { headers: withCookie(await signInAs("asha@firm.test", ASHA_PW)) }));
    expect(asha.matterIds).toEqual(["m_t_staffed"]);
    const ravi = await resolvePrincipal(nreq("/x", { headers: withCookie(await signInAs("ravi@firm.test", RAVI_PW)) }));
    expect(ravi.matterIds).toBe("*");
  });

  it("enforces matter scope at the e-discovery boundary and in quick search", async () => {
    process.env.AUTH_MODE = "jwt";
    const token = await signInAs("asha@firm.test", ASHA_PW);
    const h = { headers: withCookie(token) };
    expect((await call(edStats.GET, nreq("/api/ediscovery/stats?matter=m_t_other", h))).status).toBe(403);
    expect((await call(edStats.GET, nreq("/api/ediscovery/stats?matter=m_t_staffed", h))).status).toBe(200);
    // A body naming a matter the principal cannot access is refused before anything is written.
    const write = await call(edDocs.POST, send("/api/ediscovery/docs", { matterId: "m_t_other", bates: "X-1", subject: "s", text: "t", date: "2024-01-01" }, "POST", withCookie(token)));
    expect(write.status).toBe(403);
    expect(db().edocs.all().some((d) => d.bates === "X-1")).toBe(false);
    const search = async (q: string) => (await json(await call(quickSearch.GET, nreq(`/api/quick-search?q=${q}`, h)))).body.hits as { id: string }[];
    expect((await search("other")).some((x) => x.id === "m_t_other")).toBe(false);
    expect((await search("staffed")).some((x) => x.id === "m_t_staffed")).toBe(true);
  });

  it("gives a session token presented as a bearer the same live checks", async () => {
    process.env.AUTH_MODE = "jwt";
    const token = await signInAs("asha@firm.test", ASHA_PW);
    expect((await resolvePrincipal(nreq("/x", { headers: { authorization: `Bearer ${token}` } }))).id).toBe(ashaId);
  });

  it("rejects an expired session", async () => {
    process.env.AUTH_MODE = "jwt";
    const cred = getCredential(ashaId)!;
    const { token } = issueSessionToken({ id: ashaId, name: "Asha Iyer", roles: ["associate"], sessionVersion: cred.sessionVersion }, undefined, Math.floor(Date.now() / 1000) - 13 * 3600);
    expect((await call(session.GET, nreq("/api/auth/session", { headers: withCookie(token) }))).status).toBe(401);
  });

  it("ignores the cookie in dev mode (the demo persona stays the principal)", async () => {
    const token = await signInAs("asha@firm.test", ASHA_PW);
    const p = await resolvePrincipal(nreq("/x", { headers: withCookie(token) }));
    expect(p.source).toBe("dev");
  });

  it("revokes sessions when the password changes and when the member is deactivated", async () => {
    process.env.AUTH_MODE = "jwt";
    const token = await signInAs("ravi@firm.test", RAVI_PW);
    expect((await call(session.GET, nreq("/api/auth/session", { headers: withCookie(token) }))).status).toBe(200);
    await setPassword(raviId, RAVI_PW, "test");
    expect((await call(session.GET, nreq("/api/auth/session", { headers: withCookie(token) }))).status).toBe(401);

    const fresh = await signInAs("ravi@firm.test", RAVI_PW);
    const ownerToken = await signInAs("meera@firm.test", OWNER_PW);
    expect((await call(person.DELETE, nreq(`/api/people/${raviId}`, { method: "DELETE", headers: withCookie(ownerToken) }), params(raviId))).status).toBe(200);
    expect((await call(session.GET, nreq("/api/auth/session", { headers: withCookie(fresh) }))).status).toBe(401);
    expect((await call(login.POST, send("/api/auth/login", { email: "ravi@firm.test", password: RAVI_PW }))).status).toBe(401);
    await call(person.PATCH, send(`/api/people/${raviId}`, { active: true }, "PATCH", withCookie(ownerToken)), params(raviId));
  });
});

describe("administrator password set / reset", () => {
  const signInAs = async (email: string, pw: string) => cookieFrom(await call(login.POST, send("/api/auth/login", { email, password: pw })) as Response);
  const put = (id: string, pw: string, headers: Record<string, string> = {}) => call(password.PUT, send(`/api/people/${id}/password`, { password: pw }, "PUT", headers), params(id));

  it("refuses the dev persona: setting a password needs a real signed-in session", async () => {
    const r = await json(await put(ashaId, "brand new password"));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("session_required");
  });

  it("lets a signed-in owner set a member's password in dev mode too (rollout), and signs that member's sessions out", async () => {
    const ashaToken = await signInAs("asha@firm.test", ASHA_PW);
    const ownerToken = await signInAs("meera@firm.test", OWNER_PW);
    const r = await json(await put(ashaId, "asha second password", withCookie(ownerToken)));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, self: false });
    process.env.AUTH_MODE = "jwt";
    expect((await call(session.GET, nreq("/api/auth/session", { headers: withCookie(ashaToken) }))).status).toBe(401);
    expect((await call(login.POST, send("/api/auth/login", { email: "asha@firm.test", password: "asha second password" }))).status).toBe(200);
    await setPassword(ashaId, ASHA_PW, "test");
  });

  it("refuses non-managers and refuses a partner setting the owner's password", async () => {
    process.env.AUTH_MODE = "jwt";
    const ashaToken = await signInAs("asha@firm.test", ASHA_PW);
    expect((await json(await put(raviId, "some password long", withCookie(ashaToken)))).status).toBe(403);
    const raviToken = await signInAs("ravi@firm.test", RAVI_PW);
    const r = await json(await put(ownerId, "takeover password", withCookie(raviToken)));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("owner_only");
    expect((await json(await put(ashaId, "short", withCookie(raviToken)))).status).toBe(422);
  });

  it("re-issues the session when you set your own password", async () => {
    process.env.AUTH_MODE = "jwt";
    const ownerToken = await signInAs("meera@firm.test", OWNER_PW);
    const r = await json(await put(ownerId, OWNER_PW, withCookie(ownerToken)));
    expect(r.status).toBe(200);
    expect(r.body.self).toBe(true);
    const fresh = cookieFrom(r);
    expect((await call(session.GET, nreq("/api/auth/session", { headers: withCookie(fresh) }))).status).toBe(200);
    expect((await call(session.GET, nreq("/api/auth/session", { headers: withCookie(ownerToken) }))).status).toBe(401);
  });

  it("shows managers who can sign in, as booleans, and never a hash", async () => {
    process.env.AUTH_MODE = "jwt";
    const ownerToken = await signInAs("meera@firm.test", OWNER_PW);
    const r = await json(await call(people.GET, nreq("/api/people", { headers: withCookie(ownerToken) })));
    expect(r.status).toBe(200);
    expect(r.body.people.find((p: { id: string }) => p.id === ashaId)).toMatchObject({ hasPassword: true });
    expect(JSON.stringify(r.body)).not.toMatch(/scrypt|hash"/);
    expect(hasPassword(ashaId)).toBe(true);
    expect(db().people.get(ashaId)).not.toHaveProperty("hash");
    expect(db().collection(CREDENTIALS_COLLECTION).count()).toBeGreaterThanOrEqual(3);
  });
});


describe("platform admin firm invitations", () => {
  const signInAs = async (email: string, pw: string) => cookieFrom(await call(login.POST, send("/api/auth/login", { email, password: pw })) as Response);

  it("creates a scoped mock firm, sends a single-use invitation, and lets the invitee choose their own identity and password", async () => {
    process.env.AUTH_MODE = "jwt";
    delete process.env.RESEND_API_KEY;
    delete process.env.AUTH_EMAIL_FROM;

    const ownerToken = await signInAs("meera@firm.test", OWNER_PW);
    const headers = withCookie(ownerToken);

    const firm = await json(await call(adminAccess.POST, send("/api/admin/access", {
      action: "create_firm",
      name: "Kapoor Litigation Chambers",
      jurisdiction: "Delhi",
      description: "Mock client firm",
      matterIds: ["m_t_staffed"],
    }, "POST", headers)));
    expect(firm.status).toBe(201);
    expect(firm.body.firm).toMatchObject({ name: "Kapoor Litigation Chambers", matterIds: ["m_t_staffed"] });

    const invited = await json(await call(adminAccess.POST, send("/api/admin/access", {
      action: "invite_user",
      email: "neha@kapoor.test",
      firmId: firm.body.firm.id,
      firmRole: "Associate",
      title: "Senior Associate",
    }, "POST", headers)));
    expect(invited.status).toBe(201);
    expect(invited.body.emailSent).toBe(false);
    expect(invited.body.inviteUrl).toContain("/invite/");
    expect(JSON.stringify(invited.body)).not.toContain("tokenHash");

    const rawToken = new URL(invited.body.inviteUrl).pathname.split("/").pop()!;
    const stored = db().collection<InvitationRecord>(INVITATIONS_COLLECTION).get(invited.body.invitation.id)!;
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(JSON.stringify(stored)).not.toContain(rawToken);

    const publicView = await json(await call(inviteAccess.GET, nreq(`/api/auth/invite?token=${encodeURIComponent(rawToken)}`)));
    expect(publicView.status).toBe(200);
    expect(publicView.body.invitation).toMatchObject({
      email: "neha@kapoor.test",
      firmName: "Kapoor Litigation Chambers",
      firmRole: "Associate",
    });

    const accepted = await json(await call(inviteAccess.POST, send("/api/auth/invite", {
      token: rawToken,
      firstName: "Neha",
      lastName: "Kapoor",
      password: "neha secure password",
    })));
    expect(accepted.status).toBe(200);
    expect(accepted.body.user).toMatchObject({ name: "Neha Kapoor", email: "neha@kapoor.test" });
    expect(accepted.headers.get("set-cookie")).toContain("HttpOnly");

    const member = db().people.all().find((p) => p.email === "neha@kapoor.test") as PersonRecord | undefined;
    expect(member).toBeTruthy();
    expect(member).toMatchObject({
      name: "Neha Kapoor",
      organization: "Kapoor Litigation Chambers",
      firmId: firm.body.firm.id,
      matterScope: ["m_t_staffed"],
    });
    expect(member).not.toHaveProperty("password");

    const signed = await resolvePrincipal(nreq("/x", { headers: withCookie(cookieFrom(accepted)) }));
    expect(signed.id).toBe(member!.id);
    expect(signed.matterIds).toEqual(["m_t_staffed"]);

    const reused = await call(inviteAccess.POST, send("/api/auth/invite", {
      token: rawToken,
      firstName: "Again",
      lastName: "No",
      password: "another secure password",
    }));
    expect(reused.status).toBe(404);
  });
});
