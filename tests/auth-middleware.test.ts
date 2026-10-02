import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { gate, gateEnforced, isPublicPath, type GateInput } from "@/lib/auth/gatekeeper";
import { SESSION_COOKIE, SESSION_TYP, verifySessionTokenEdge } from "@/lib/auth/session-token";
import { signHs256 } from "@/lib/auth/session";
import { middleware } from "@/middleware";

// Test-only secret.
const SECRET = "test-secret-for-vitest-only-0123456789abcdef";
const NOW = 1_800_000_000;
const env = { AUTH_MODE: "jwt", AUTH_JWT_SECRET: SECRET };
const token = (claims: Record<string, unknown> = {}, secret = SECRET) => signHs256({ typ: SESSION_TYP, sub: "p_member", sv: 1, iat: NOW, exp: NOW + 3600, ...claims }, secret);
const input = (over: Partial<GateInput>): GateInput => ({ method: "GET", pathname: "/", env, now: NOW, host: "app.example", ...over });
const cookie = (t: string) => `${SESSION_COOKIE}=${t}`;

describe("edge HS256 verification", () => {
  it("accepts a session token signed with node:crypto and rejects tampering, wrong secret, expiry and non-session tokens", async () => {
    expect(await verifySessionTokenEdge(token(), { secret: SECRET, now: NOW })).toMatchObject({ sub: "p_member" });
    const t = token();
    expect(await verifySessionTokenEdge(`${t.slice(0, -2)}xx`, { secret: SECRET, now: NOW })).toBeNull();
    expect(await verifySessionTokenEdge(token({}, "another-secret-another-secret-123"), { secret: SECRET, now: NOW })).toBeNull();
    expect(await verifySessionTokenEdge(token({ exp: NOW - 120 }), { secret: SECRET, now: NOW })).toBeNull();
    expect(await verifySessionTokenEdge(token({ typ: undefined }), { secret: SECRET, now: NOW })).toBeNull();
    expect(await verifySessionTokenEdge(token({ iss: "a" }), { secret: SECRET, issuer: "b", now: NOW })).toBeNull();
    expect(await verifySessionTokenEdge(token({ aud: "app" }), { secret: SECRET, audience: "app", now: NOW })).not.toBeNull();
    const [, p, s] = t.split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${p}.${s}`;
    expect(await verifySessionTokenEdge(none, { secret: SECRET, now: NOW })).toBeNull();
  });
});

describe("gate (AUTH_MODE=jwt)", () => {
  it("is off in dev and header modes and on for jwt or an unknown mode (fails closed)", () => {
    expect(gateEnforced({})).toBe(false);
    expect(gateEnforced({ AUTH_MODE: "dev" })).toBe(false);
    expect(gateEnforced({ AUTH_MODE: "header" })).toBe(false);
    expect(gateEnforced({ AUTH_MODE: "jwt" })).toBe(true);
    expect(gateEnforced({ AUTH_MODE: "jtw" })).toBe(true);
  });

  it("redirects an unauthenticated page to /login with a same-origin next", async () => {
    expect(await gate(input({ pathname: "/matters", search: "?tab=open" }))).toEqual({ kind: "redirect", location: "/login?next=%2Fmatters%3Ftab%3Dopen", clearCookie: false });
    expect(await gate(input({ pathname: "/" }))).toEqual({ kind: "redirect", location: "/login", clearCookie: false });
    // A bearer header never unlocks a page (pages have no route-level verification).
    expect((await gate(input({ pathname: "/matters", authorization: "Bearer anything" }))).kind).toBe("redirect");
  });

  it("returns 401 for /api/* without a session or bearer, and clears an invalid cookie", async () => {
    expect(await gate(input({ pathname: "/api/matters" }))).toEqual({ kind: "unauthorized", message: "Authentication required", clearCookie: false });
    expect(await gate(input({ pathname: "/api/india/corpus", cookie: cookie("bad.token.value") }))).toMatchObject({ kind: "unauthorized", clearCookie: true });
    expect((await gate(input({ pathname: "/api/official" }))).kind).toBe("unauthorized");
  });

  it("lets a valid session through to pages and APIs, and passes a bearer to the API route (which verifies it)", async () => {
    expect(await gate(input({ pathname: "/matters", cookie: cookie(token()) }))).toEqual({ kind: "next" });
    expect(await gate(input({ pathname: "/api/matters", cookie: cookie(token()) }))).toEqual({ kind: "next" });
    expect(await gate(input({ pathname: "/api/matters", authorization: "Bearer x.y.z" }))).toEqual({ kind: "next" });
    expect((await gate(input({ pathname: "/matters", cookie: cookie(token({ exp: NOW - 3600 })) }))).kind).toBe("redirect");
  });

  it("allowlists only sign-in, bootstrap, health, cron routes, /login, /setup and static assets", async () => {
    for (const p of ["/login", "/setup", "/api/auth/login", "/api/auth/logout", "/api/auth/bootstrap", "/api/health", "/api/official/run", "/api/intel/jobs/tick", "/api/india/hc-text/run", "/_next/static/chunks/a.js", "/brand/sw-mark.svg", "/icon.svg"]) {
      expect(isPublicPath(p), p).toBe(true);
      expect(await gate(input({ pathname: p })), p).toEqual({ kind: "next" });
    }
    for (const p of ["/api/auth/session", "/api/auth/login/x", "/api/official", "/api/official/run/extra", "/api/india/hc-text/run/x", "/api/india/hc-text/coverage", "/api/intel/jobs", "/api/people", "/loginx", "/settings", "/api/health/x"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("refuses cross-site state-changing API calls (login CSRF included) but not same-origin or Origin-less ones", async () => {
    expect(await gate(input({ method: "POST", pathname: "/api/auth/login", origin: "https://evil.example" }))).toMatchObject({ kind: "forbidden" });
    expect(await gate(input({ method: "POST", pathname: "/api/matters", origin: "https://evil.example", cookie: cookie(token()) }))).toMatchObject({ kind: "forbidden" });
    expect(await gate(input({ method: "POST", pathname: "/api/auth/login", origin: "https://app.example" }))).toEqual({ kind: "next" });
    expect(await gate(input({ method: "POST", pathname: "/api/matters", origin: "https://app.example", host: "internal:3000", forwardedHost: "app.example", cookie: cookie(token()) }))).toEqual({ kind: "next" });
    expect(await gate(input({ method: "POST", pathname: "/api/auth/login" }))).toEqual({ kind: "next" });
    expect(await gate(input({ method: "GET", pathname: "/api/matters", origin: "https://evil.example", cookie: cookie(token()) }))).toEqual({ kind: "next" });
  });

  it("without AUTH_JWT_SECRET nothing verifies: pages redirect and APIs need a bearer", async () => {
    const noSecret = { AUTH_MODE: "jwt" };
    expect((await gate(input({ env: noSecret, pathname: "/matters", cookie: cookie(token()) }))).kind).toBe("redirect");
    expect((await gate(input({ env: noSecret, pathname: "/api/matters", cookie: cookie(token()) }))).kind).toBe("unauthorized");
  });
});

describe("middleware wiring", () => {
  const run = async (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const prev = { mode: process.env.AUTH_MODE, secret: process.env.AUTH_JWT_SECRET };
    process.env.AUTH_MODE = "jwt";
    process.env.AUTH_JWT_SECRET = SECRET;
    try {
      return await middleware(new NextRequest(`http://app.example${path}`, { method: init.method ?? "GET", headers: { host: "app.example", ...(init.headers ?? {}) } }));
    } finally {
      if (prev.mode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prev.mode;
      if (prev.secret === undefined) delete process.env.AUTH_JWT_SECRET; else process.env.AUTH_JWT_SECRET = prev.secret;
    }
  };

  it("maps the decision to 307 /login, 401 JSON, 403 JSON or pass-through", async () => {
    const page = await run("/documents?x=1");
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("http://app.example/login?next=%2Fdocuments%3Fx%3D1");
    const api = await run("/api/matters");
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: "Authentication required", code: "unauthenticated" });
    const csrf = await run("/api/auth/login", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(csrf.status).toBe(403);
    const live = token({ exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), nbf: undefined });
    const ok = await run("/matters", { headers: { cookie: cookie(live) } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    // The pathname reaches the root layout, overwriting anything the client sent.
    const spoofed = await run("/matters", { headers: { cookie: cookie(live), "x-leclaude-pathname": "/login" } });
    expect(spoofed.headers.get("x-middleware-request-x-leclaude-pathname")).toBe("/matters");
    const stale = await run("/matters", { headers: { cookie: cookie("bad.token.value") } });
    expect(stale.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
  });
});
