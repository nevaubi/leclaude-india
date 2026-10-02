import "server-only";
import { createHmac, timingSafeEqual, verify as cryptoVerify, constants as cryptoConstants, createPublicKey, type KeyObject } from "node:crypto";
import { currentUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import type { Person } from "@/lib/types/domain";
import { activeMember, getCredential } from "./accounts";
import { AuthError } from "./errors";
import { ALL_ROLES } from "./policy";
import { readCookie, SESSION_COOKIE, SESSION_TYP } from "./session-token";
import { AUTH_HEADER_USER, AUTH_MODES, type AuthMode, type Principal, type Role } from "./types";

/**
 * Principal resolution (constitution §21 identity). The real authenticated principal is propagated end to end;
 * there is no hardcoded production user.
 *
 *   AUTH_MODE=dev     (default) the demo persona from `currentUser()` mapped to a Principal
 *   AUTH_MODE=header  a reverse proxy that authenticated upstream asserts the user in `x-leclaude-user` (JSON or
 *                     base64url JSON); trusted only when AUTH_TRUST_HEADER=true
 *   AUTH_MODE=jwt     `Authorization: Bearer <jwt>` verified with HS256 (AUTH_JWT_SECRET) or RS256
 *                     (AUTH_JWT_PUBLIC_KEY, PEM); exp/nbf always, iss/aud when AUTH_JWT_ISSUER / AUTH_JWT_AUDIENCE are set.
 *                     Without a bearer, the HttpOnly session cookie issued by POST /api/auth/login (same HS256 claims
 *                     plus typ/sv) is accepted; it is re-checked against the account on every request (active member,
 *                     session version), and roles and matter access come from the current person record.
 *
 * In every mode a request carrying `Authorization: Bearer <CRON_SECRET>` (when CRON_SECRET is set) resolves to the
 * cron service principal so scheduled drivers keep working behind real authentication.
 */
export const DEFAULT_TENANT_ID = "default";
export const DEFAULT_DEV_ROLES: Role[] = ["associate"];
const JWT_LEEWAY_SECONDS = 60;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v == null || !v.trim() ? undefined : v.trim();
}

export function tenantId(): string {
  return env("LECLAUDE_TENANT_ID") ?? DEFAULT_TENANT_ID;
}

export function authMode(): AuthMode {
  const raw = (env("AUTH_MODE") ?? "dev").toLowerCase();
  if ((AUTH_MODES as readonly string[]).includes(raw)) return raw as AuthMode;
  // Fail closed: an unknown mode never silently becomes the demo persona.
  throw AuthError.unauthenticated(`AUTH_MODE "${raw}" is not one of ${AUTH_MODES.join(", ")}`);
}

/** Map a seeded person record to platform roles. Firm attorneys and staff get their role; everyone else gets none. */
export function rolesForPerson(person: Pick<Person, "role" | "title"> | null | undefined): Role[] {
  if (!person) return DEFAULT_DEV_ROLES;
  const title = (person.title ?? "").toLowerCase();
  switch (person.role) {
    case "attorney":
      return [/\bpartner\b/.test(title) ? "partner" : "associate"];
    case "paralegal":
      return ["paralegal"];
    case "staff":
      if (/knowledge|librar|information|technolog|systems|\bit\b|administrat/.test(title)) return ["admin"];
      return ["litigation_support"];
    case "client":
      return ["client_guest"];
    default:
      return [];
  }
}

/** The development persona as a Principal (tenant-wide access, like the demo has always had). */
export function devPrincipal(): Principal {
  const people = db().people;
  const user = currentUser((id) => people.get(id)?.name);
  const person = people.get(user.id);
  return {
    id: user.id,
    name: user.name,
    email: person?.email,
    tenantId: tenantId(),
    roles: person ? rolesForPerson(person) : DEFAULT_DEV_ROLES,
    matterIds: "*",
    source: "dev",
  };
}

export function servicePrincipal(id = "svc_cron", name = "Scheduled service"): Principal {
  return { id, name, tenantId: tenantId(), roles: ["service"], matterIds: "*", source: "service" };
}

function bearerToken(req: Request): string | undefined {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m?.[1]?.trim() || undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The cron/service token path shared by every mode. */
function serviceFromRequest(req: Request): Principal | null {
  const secret = env("CRON_SECRET");
  if (!secret) return null;
  const token = bearerToken(req);
  if (!token || !safeEqual(token, secret)) return null;
  return servicePrincipal();
}

// ---------------------------------------------------------------------------
// Shape validation shared by header and jwt claims
// ---------------------------------------------------------------------------

const ID_RE = /^[\w.@:-]{1,128}$/;

function asRoles(value: unknown): Role[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  return Array.from(new Set(list.filter((r): r is Role => typeof r === "string" && (ALL_ROLES as readonly string[]).includes(r))));
}

function asMatterIds(value: unknown): Principal["matterIds"] {
  if (value === "*") return "*";
  if (Array.isArray(value)) return Array.from(new Set(value.filter((m): m is string => typeof m === "string" && ID_RE.test(m))));
  return [];
}

function principalFromObject(obj: Record<string, unknown>, source: Principal["source"]): Principal {
  const id = typeof obj.id === "string" ? obj.id : typeof obj.sub === "string" ? obj.sub : "";
  if (!ID_RE.test(id)) throw AuthError.unauthenticated("Principal id is missing or malformed");
  const name = [obj.name, obj.preferred_username, obj.email, id].find((v): v is string => typeof v === "string" && v.trim().length > 0)!;
  const tenant = [obj.tenantId, obj.tenant, obj.tenant_id, obj.tid].find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? tenantId();
  const roles = asRoles(obj.roles ?? obj.role);
  const matterIds = asMatterIds(obj.matterIds ?? obj.matters ?? obj.matter_ids);
  const email = typeof obj.email === "string" ? obj.email : undefined;
  const sessionId = [obj.sessionId, obj.sid, obj.jti].find((v): v is string => typeof v === "string") ?? undefined;
  const exp = typeof obj.exp === "number" ? new Date(obj.exp * 1000).toISOString() : typeof obj.expiresAt === "string" ? obj.expiresAt : undefined;
  return { id, name, email, tenantId: tenant, roles, matterIds, source, sessionId, expiresAt: exp };
}

// ---------------------------------------------------------------------------
// header mode
// ---------------------------------------------------------------------------

function decodeHeaderValue(raw: string): Record<string, unknown> {
  const text = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.startsWith("{") ? text : Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw AuthError.unauthenticated(`${AUTH_HEADER_USER} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw AuthError.unauthenticated(`${AUTH_HEADER_USER} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

export function headerPrincipal(req: Request): Principal {
  if (env("AUTH_TRUST_HEADER") !== "true") throw AuthError.unauthenticated("AUTH_MODE=header requires AUTH_TRUST_HEADER=true behind a proxy that authenticates upstream");
  const raw = req.headers.get(AUTH_HEADER_USER);
  if (!raw) throw AuthError.unauthenticated(`Missing ${AUTH_HEADER_USER} header`);
  const p = principalFromObject(decodeHeaderValue(raw), "header");
  if (p.expiresAt && p.expiresAt <= new Date().toISOString()) throw AuthError.unauthenticated("Asserted principal has expired");
  return p;
}

// ---------------------------------------------------------------------------
// jwt mode (node:crypto only; `jose` is not installed)
// ---------------------------------------------------------------------------

export interface JwtConfig {
  secret?: string;
  publicKey?: string;
  issuer?: string;
  audience?: string;
  /** Seconds; defaults to Date.now(). */
  now?: number;
}

export function jwtConfigFromEnv(): JwtConfig {
  return { secret: env("AUTH_JWT_SECRET"), publicKey: env("AUTH_JWT_PUBLIC_KEY")?.replace(/\\n/g, "\n"), issuer: env("AUTH_JWT_ISSUER"), audience: env("AUTH_JWT_AUDIENCE") };
}

function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function parseJson(buf: Buffer, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(buf.toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw AuthError.unauthenticated(`Token ${what} is malformed`);
  }
}

let cachedKey: { pem: string; key: KeyObject } | null = null;
function publicKeyObject(pem: string): KeyObject {
  if (cachedKey?.pem === pem) return cachedKey.key;
  try {
    const key = createPublicKey(pem);
    cachedKey = { pem, key };
    return key;
  } catch {
    throw AuthError.unauthenticated("AUTH_JWT_PUBLIC_KEY is not a valid PEM public key");
  }
}

/** Verify a compact JWS and return its claims. Rejects `none`, unknown algorithms and key-confusion (an RS256 key never acts as an HMAC secret). */
export function verifyJwt(token: string, cfg: JwtConfig): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) throw AuthError.unauthenticated("Token is not a compact JWS");
  const header = parseJson(b64url(parts[0]), "header");
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = b64url(parts[2]);
  const alg = header.alg;
  if (alg === "HS256") {
    if (!cfg.secret) throw AuthError.unauthenticated("HS256 tokens are not accepted: AUTH_JWT_SECRET is not configured");
    const expected = createHmac("sha256", cfg.secret).update(signingInput).digest();
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) throw AuthError.unauthenticated("Token signature is invalid");
  } else if (alg === "RS256") {
    if (!cfg.publicKey) throw AuthError.unauthenticated("RS256 tokens are not accepted: AUTH_JWT_PUBLIC_KEY is not configured");
    const ok = cryptoVerify("RSA-SHA256", signingInput, { key: publicKeyObject(cfg.publicKey), padding: cryptoConstants.RSA_PKCS1_PADDING }, signature);
    if (!ok) throw AuthError.unauthenticated("Token signature is invalid");
  } else {
    throw AuthError.unauthenticated(`Token algorithm ${String(alg)} is not accepted`);
  }
  const claims = parseJson(b64url(parts[1]), "payload");
  const now = cfg.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number") throw AuthError.unauthenticated("Token has no exp claim");
  if (claims.exp + JWT_LEEWAY_SECONDS <= now) throw AuthError.unauthenticated("Token has expired");
  if (typeof claims.nbf === "number" && claims.nbf - JWT_LEEWAY_SECONDS > now) throw AuthError.unauthenticated("Token is not yet valid");
  if (typeof claims.iat === "number" && claims.iat - JWT_LEEWAY_SECONDS > now) throw AuthError.unauthenticated("Token was issued in the future");
  if (cfg.issuer && claims.iss !== cfg.issuer) throw AuthError.unauthenticated("Token issuer is not accepted");
  if (cfg.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.audience)) throw AuthError.unauthenticated("Token audience is not accepted");
  }
  return claims;
}

// ---------------------------------------------------------------------------
// session cookie (issued by POST /api/auth/login)
// ---------------------------------------------------------------------------

/** Matter access for a signed-in member: tenant-wide for the owner, partners and admins; otherwise the matters they staff. */
export function matterIdsForPerson(personId: string, roles: readonly Role[], ownerId?: string): Principal["matterIds"] {
  if (personId === ownerId || roles.includes("partner") || roles.includes("admin")) return "*";
  return db().matters.all().filter((m) => m.leadAttorneyId === personId || (m.teamIds ?? []).includes(personId)).map((m) => m.id);
}

function workspaceOwnerId(): string | undefined {
  const w = db().kv.get<{ owner?: { id?: string } | null }>("workspace");
  return w?.owner?.id ?? undefined;
}

/**
 * Verify a session token and build the principal from the live account: the person must still be an active team
 * member, the token's session version must match the credential (a password change revokes older sessions), and the
 * tenant must be this deployment's. Roles are derived from the person record now, not trusted from the token.
 */
export function sessionPrincipalFromToken(token: string, cfg: JwtConfig = jwtConfigFromEnv()): Principal {
  if (!cfg.secret) throw AuthError.unauthenticated("Sign-in sessions are not configured: AUTH_JWT_SECRET is not set");
  const claims = verifyJwt(token, { ...cfg, publicKey: undefined });
  if (claims.typ !== SESSION_TYP) throw AuthError.unauthenticated("Token is not a session token");
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!ID_RE.test(sub)) throw AuthError.unauthenticated("Principal id is missing or malformed");
  const tenant = typeof claims.tenant === "string" ? claims.tenant : tenantId();
  if (tenant !== tenantId()) throw AuthError.unauthenticated("Session belongs to another tenant");
  const person = activeMember(sub);
  if (!person) throw AuthError.unauthenticated("This account is not active");
  const cred = getCredential(sub);
  if (!cred || typeof claims.sv !== "number" || claims.sv !== cred.sessionVersion) throw AuthError.unauthenticated("This session has been signed out");
  const roles = rolesForPerson(person);
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    tenantId: tenant,
    roles,
    matterIds: matterIdsForPerson(person.id, roles, workspaceOwnerId()),
    source: "jwt",
    sessionId: typeof claims.sid === "string" ? claims.sid : undefined,
    expiresAt: typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : undefined,
  };
}

export function sessionCookieToken(req: Request): string | undefined {
  return readCookie(req.headers.get("cookie"), SESSION_COOKIE);
}

/** The signed-in member from the session cookie in any AUTH_MODE, or null (used where an action needs a real sign-in even in dev mode). */
export function sessionPrincipalFromRequest(req: Request, cfg: JwtConfig = jwtConfigFromEnv()): Principal | null {
  const token = sessionCookieToken(req);
  if (!token || !cfg.secret) return null;
  try {
    return sessionPrincipalFromToken(token, cfg);
  } catch {
    return null;
  }
}

export function jwtPrincipal(req: Request, cfg: JwtConfig = jwtConfigFromEnv()): Principal {
  const token = bearerToken(req);
  if (token) {
    const claims = verifyJwt(token, cfg);
    // A session token presented as a bearer gets the same live-account checks as the cookie (no revocation bypass).
    if (claims.typ === SESSION_TYP) return sessionPrincipalFromToken(token, cfg);
    return principalFromObject(claims, "jwt");
  }
  const session = sessionCookieToken(req);
  if (session) return sessionPrincipalFromToken(session, cfg);
  throw AuthError.unauthenticated("Missing bearer token or session");
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Resolve the authenticated principal for a request, or throw an AuthError (401). */
export async function resolvePrincipal(req: Request): Promise<Principal> {
  const service = serviceFromRequest(req);
  if (service) return service;
  switch (authMode()) {
    case "dev":
      return devPrincipal();
    case "header":
      return headerPrincipal(req);
    case "jwt":
      return jwtPrincipal(req);
  }
}
