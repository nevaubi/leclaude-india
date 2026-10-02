import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { jwtConfigFromEnv, tenantId, type JwtConfig } from "./principal";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, SESSION_TYP } from "./session-token";
import type { Role } from "./types";

/**
 * Session issuing for the workspace sign-in. Tokens are HS256 JWTs signed with AUTH_JWT_SECRET carrying the claims
 * `verifyJwt` already checks (sub, roles, tenant, exp, iss/aud when configured) plus `typ` and `sv` (session
 * version); they travel in an HttpOnly, SameSite=Lax cookie that is Secure in production.
 */

export interface SessionSubject {
  id: string;
  name: string;
  email?: string;
  roles: Role[];
  sessionVersion: number;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signHs256(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export class SessionConfigError extends Error {
  constructor() {
    super("Sign-in is not configured on this deployment (AUTH_JWT_SECRET is not set).");
    this.name = "SessionConfigError";
  }
}

export function sessionsConfigured(cfg: JwtConfig = jwtConfigFromEnv()): boolean {
  return Boolean(cfg.secret && cfg.secret.length >= 32);
}

export function issueSessionToken(subject: SessionSubject, cfg: JwtConfig = jwtConfigFromEnv(), nowSeconds = Math.floor(Date.now() / 1000)): { token: string; expiresAt: string; sessionId: string } {
  if (!sessionsConfigured(cfg)) throw new SessionConfigError();
  const sessionId = randomUUID();
  const exp = nowSeconds + SESSION_TTL_SECONDS;
  const claims: Record<string, unknown> = {
    typ: SESSION_TYP,
    sub: subject.id,
    name: subject.name,
    ...(subject.email ? { email: subject.email } : {}),
    roles: subject.roles,
    tenant: tenantId(),
    sv: subject.sessionVersion,
    sid: sessionId,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp,
    ...(cfg.issuer ? { iss: cfg.issuer } : {}),
    ...(cfg.audience ? { aud: cfg.audience } : {}),
  };
  return { token: signHs256(claims, cfg.secret!), expiresAt: new Date(exp * 1000).toISOString(), sessionId };
}

/** Secure cookies in production (NODE_ENV=production) unless AUTH_COOKIE_SECURE=false is set for a plain-HTTP test host. */
export function secureCookies(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const flag = env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (flag === "false" || flag === "0") return false;
  if (flag === "true" || flag === "1") return true;
  return env.NODE_ENV === "production";
}

export function sessionCookieHeader(token: string, secure = secureCookies()): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_TTL_SECONDS}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export function clearSessionCookieHeader(secure = secureCookies()): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", ...(secure ? ["Secure"] : [])].join("; ");
}
