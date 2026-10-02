import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/auth-principal-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUST_HEADER;
  delete process.env.CRON_SECRET;
  delete process.env.LECLAUDE_USER_ID;
  delete process.env.LECLAUDE_TENANT_ID;
});

import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { db, resetSqlite } from "@/lib/db";
import { PEOPLE } from "@/lib/seed/ids";
import { AuthError } from "@/lib/auth/errors";
import { authMode, DEFAULT_TENANT_ID, devPrincipal, headerPrincipal, jwtPrincipal, resolvePrincipal, rolesForPerson, verifyJwt } from "@/lib/auth/principal";
import { AUTH_HEADER_USER } from "@/lib/auth/types";

const ENV_KEYS = ["AUTH_MODE", "AUTH_TRUST_HEADER", "AUTH_JWT_SECRET", "AUTH_JWT_PUBLIC_KEY", "AUTH_JWT_ISSUER", "AUTH_JWT_AUDIENCE", "CRON_SECRET", "LECLAUDE_USER_ID", "LECLAUDE_TENANT_ID"];
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
}
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
beforeAll(() => { resetSqlite(); db(); });

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function hs256(claims: Record<string, unknown>, secret: string, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  return `${input}.${b64(createHmac("sha256", secret).update(input).digest())}`;
}
function rs256(claims: Record<string, unknown>, privateKey: string) {
  const input = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify(claims))}`;
  const sig = createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${b64(sig)}`;
}
const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/x", { headers });
const now = Math.floor(Date.now() / 1000);

describe("dev mode", () => {
  it("maps the demo persona to a partner with tenant-wide access", async () => {
    const p = await resolvePrincipal(req());
    expect(p).toMatchObject({ id: PEOPLE.arjunMehra, name: "Arjun Mehra", tenantId: DEFAULT_TENANT_ID, roles: ["partner"], matterIds: "*", source: "dev" });
    expect(p.email).toBe("amehra@mehrarao.example");
  });
  it("honours LECLAUDE_TENANT_ID and LECLAUDE_USER_ID with roles from the person record", () => {
    setEnv({ LECLAUDE_TENANT_ID: "acme", LECLAUDE_USER_ID: PEOPLE.meeraLobo });
    expect(devPrincipal()).toMatchObject({ id: PEOPLE.meeraLobo, tenantId: "acme", roles: ["paralegal"] });
    setEnv({ LECLAUDE_USER_ID: PEOPLE.tanmayBhatt });
    expect(devPrincipal().roles).toEqual(["litigation_support"]);
    setEnv({ LECLAUDE_USER_ID: PEOPLE.aishaKhan });
    expect(devPrincipal().roles).toEqual(["admin"]);
    setEnv({ LECLAUDE_USER_ID: PEOPLE.eshaMathur });
    expect(devPrincipal().roles).toEqual(["associate"]);
    setEnv({ LECLAUDE_USER_ID: "p_nobody_here" });
    expect(devPrincipal().roles).toEqual(["associate"]);
  });
  it.each([
    [{ role: "attorney", title: "Partner" }, ["partner"]],
    [{ role: "attorney", title: "Senior Associate" }, ["associate"]],
    [{ role: "paralegal", title: "Litigation Paralegal" }, ["paralegal"]],
    [{ role: "staff", title: "E-Discovery Project Manager" }, ["litigation_support"]],
    [{ role: "staff", title: "Knowledge Management Director" }, ["admin"]],
    [{ role: "client", title: "General Counsel" }, ["client_guest"]],
    [{ role: "custodian", title: "VP" }, []],
    [{ role: "opposing", title: "Counsel" }, []],
  ] as const)("rolesForPerson(%o) → %o", (person, roles) => {
    expect(rolesForPerson(person as { role: "attorney"; title: string })).toEqual(roles);
  });
  it("fails closed on an unknown AUTH_MODE instead of falling back to the demo persona", async () => {
    setEnv({ AUTH_MODE: "magic" });
    expect(() => authMode()).toThrow(AuthError);
    await expect(resolvePrincipal(req())).rejects.toMatchObject({ status: 401 });
  });
});

describe("header mode", () => {
  it("refuses the header unless AUTH_TRUST_HEADER=true", () => {
    setEnv({ AUTH_MODE: "header" });
    expect(() => headerPrincipal(req({ [AUTH_HEADER_USER]: JSON.stringify({ id: "u1", roles: ["partner"] }) }))).toThrow(/AUTH_TRUST_HEADER/);
  });
  it("accepts JSON or base64url JSON and filters unknown roles and malformed matter ids", async () => {
    setEnv({ AUTH_MODE: "header", AUTH_TRUST_HEADER: "true" });
    const asserted = { id: "u_ext", name: "External Reviewer", email: "r@example.com", tenantId: "acme", roles: ["reviewer", "superuser"], matterIds: ["m_valsara_arb", "bad id with spaces", 42] };
    const p = await resolvePrincipal(req({ [AUTH_HEADER_USER]: JSON.stringify(asserted) }));
    expect(p).toMatchObject({ id: "u_ext", name: "External Reviewer", tenantId: "acme", roles: ["reviewer"], matterIds: ["m_valsara_arb"], source: "header" });
    const p2 = await resolvePrincipal(req({ [AUTH_HEADER_USER]: Buffer.from(JSON.stringify({ id: "u2", roles: ["partner"], matterIds: "*" })).toString("base64url") }));
    expect(p2).toMatchObject({ id: "u2", roles: ["partner"], matterIds: "*", tenantId: DEFAULT_TENANT_ID });
  });
  it("rejects a missing, malformed or expired assertion with 401", async () => {
    setEnv({ AUTH_MODE: "header", AUTH_TRUST_HEADER: "true" });
    await expect(resolvePrincipal(req())).rejects.toMatchObject({ status: 401 });
    await expect(resolvePrincipal(req({ [AUTH_HEADER_USER]: "{not json" }))).rejects.toMatchObject({ status: 401 });
    await expect(resolvePrincipal(req({ [AUTH_HEADER_USER]: JSON.stringify({ roles: ["partner"] }) }))).rejects.toMatchObject({ status: 401 });
    await expect(resolvePrincipal(req({ [AUTH_HEADER_USER]: JSON.stringify({ id: "u", roles: ["partner"], expiresAt: "2000-01-01T00:00:00.000Z" }) }))).rejects.toMatchObject({ status: 401 });
  });
});

describe("jwt mode", () => {
  const SECRET = "test-secret-with-enough-entropy";
  const claims = { sub: "u_jwt", name: "Token User", email: "t@example.com", tenant: "acme", roles: ["associate"], matters: ["m_valsara_arb"], iss: "https://idp.example.com", aud: "leclaude", exp: now + 600, iat: now, sid: "sess-1" };

  it("verifies HS256 and maps claims to a principal", () => {
    setEnv({ AUTH_MODE: "jwt", AUTH_JWT_SECRET: SECRET, AUTH_JWT_ISSUER: "https://idp.example.com", AUTH_JWT_AUDIENCE: "leclaude" });
    const p = jwtPrincipal(req({ authorization: `Bearer ${hs256(claims, SECRET)}` }));
    expect(p).toMatchObject({ id: "u_jwt", name: "Token User", email: "t@example.com", tenantId: "acme", roles: ["associate"], matterIds: ["m_valsara_arb"], source: "jwt", sessionId: "sess-1" });
    expect(p.expiresAt).toBe(new Date(claims.exp * 1000).toISOString());
  });
  it("verifies RS256 with a PEM public key and rejects tampering", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
    setEnv({ AUTH_MODE: "jwt", AUTH_JWT_PUBLIC_KEY: pem.replace(/\n/g, "\\n") });
    const token = rs256({ ...claims, matters: "*", roles: ["partner"] }, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    const p = await resolvePrincipal(req({ authorization: `Bearer ${token}` }));
    expect(p).toMatchObject({ id: "u_jwt", roles: ["partner"], matterIds: "*" });
    const [h, body, sig] = token.split(".");
    const forged = `${h}.${b64(JSON.stringify({ ...claims, roles: ["admin"] }))}.${sig}`;
    await expect(resolvePrincipal(req({ authorization: `Bearer ${forged}` }))).rejects.toMatchObject({ status: 401 });
    expect(body).toBeTruthy();
  });
  it("rejects alg=none, unknown algorithms, key confusion, bad signatures and missing tokens", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(() => verifyJwt(hs256(claims, SECRET, { alg: "none" }), { secret: SECRET })).toThrow(/not accepted/);
    expect(() => verifyJwt(hs256(claims, SECRET, { alg: "ES256" }), { secret: SECRET })).toThrow(/not accepted/);
    // An HS256 token signed with the RSA public key must not verify when only the public key is configured.
    expect(() => verifyJwt(hs256(claims, pem), { publicKey: pem })).toThrow(/HS256 tokens are not accepted/);
    expect(() => verifyJwt(hs256(claims, "wrong"), { secret: SECRET })).toThrow(/signature/);
    expect(() => verifyJwt("a.b", { secret: SECRET })).toThrow(/compact JWS/);
    setEnv({ AUTH_MODE: "jwt", AUTH_JWT_SECRET: SECRET });
    expect(() => jwtPrincipal(req())).toThrow(/Missing bearer token/);
  });
  it("enforces exp, nbf, iat, iss and aud", () => {
    const cfg = { secret: SECRET, issuer: "https://idp.example.com", audience: "leclaude" };
    expect(() => verifyJwt(hs256({ ...claims, exp: now - 120 }, SECRET), cfg)).toThrow(/expired/);
    expect(() => verifyJwt(hs256({ ...claims, nbf: now + 600 }, SECRET), cfg)).toThrow(/not yet valid/);
    expect(() => verifyJwt(hs256({ ...claims, iat: now + 600 }, SECRET), cfg)).toThrow(/future/);
    const { exp: _exp, ...noExp } = claims;
    void _exp;
    expect(() => verifyJwt(hs256(noExp, SECRET), cfg)).toThrow(/no exp/);
    expect(() => verifyJwt(hs256({ ...claims, iss: "https://evil.example.com" }, SECRET), cfg)).toThrow(/issuer/);
    expect(() => verifyJwt(hs256({ ...claims, aud: ["other"] }, SECRET), cfg)).toThrow(/audience/);
    expect(verifyJwt(hs256({ ...claims, aud: ["other", "leclaude"] }, SECRET), cfg).sub).toBe("u_jwt");
    // 60s leeway on exp
    expect(verifyJwt(hs256({ ...claims, exp: now - 30 }, SECRET), cfg).sub).toBe("u_jwt");
  });
  it("a token with no usable roles yields a principal the policy will deny (403), not a 401", () => {
    setEnv({ AUTH_MODE: "jwt", AUTH_JWT_SECRET: SECRET });
    const p = jwtPrincipal(req({ authorization: `Bearer ${hs256({ ...claims, roles: ["wizard"] }, SECRET)}` }));
    expect(p.roles).toEqual([]);
  });
});

describe("service token", () => {
  it("resolves the cron secret to a service principal in every mode, with a constant-time comparison", async () => {
    setEnv({ CRON_SECRET: "cron-secret-1" });
    expect(await resolvePrincipal(req({ authorization: "Bearer cron-secret-1" }))).toMatchObject({ id: "svc_cron", roles: ["service"], matterIds: "*", source: "service" });
    setEnv({ AUTH_MODE: "jwt", AUTH_JWT_SECRET: "s", CRON_SECRET: "cron-secret-1" });
    expect((await resolvePrincipal(req({ authorization: "Bearer cron-secret-1" }))).source).toBe("service");
    await expect(resolvePrincipal(req({ authorization: "Bearer cron-secret-2" }))).rejects.toMatchObject({ status: 401 });
  });
  it("is inert when CRON_SECRET is unset", async () => {
    expect((await resolvePrincipal(req({ authorization: "Bearer anything" }))).source).toBe("dev");
  });
});
