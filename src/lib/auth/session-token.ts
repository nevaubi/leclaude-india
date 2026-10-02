/**
 * Session-cookie constants and an HS256 verifier that runs anywhere Web Crypto exists (the Next.js edge middleware,
 * Node 20+, tests). No Node or server imports: the middleware bundles this file.
 *
 * The middleware uses it only to decide "redirect to /login / 401" early. Route handlers and server pages re-verify
 * with `resolvePrincipal()` (src/lib/auth/principal.ts), which also checks the account is still active and the
 * session has not been revoked; that check is authoritative.
 */

/** HttpOnly session cookie set by POST /api/auth/login. */
export const SESSION_COOKIE = "lc_session";
/** Session lifetime: 12 hours. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
/** `typ` claim that distinguishes a LeClaude session from a bearer token minted by an external identity provider. */
export const SESSION_TYP = "lc_session";
const LEEWAY_SECONDS = 60;

/** The value of one cookie from a Cookie header, or undefined. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const v = part.slice(i + 1).trim();
    if (!v) return undefined;
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return undefined;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}

export interface EdgeVerifyOptions {
  secret: string;
  issuer?: string;
  audience?: string;
  /** Seconds since epoch; defaults to now. */
  now?: number;
}

/**
 * Verify an HS256 session token: signature (constant-time via `crypto.subtle.verify`), `typ`, exp/nbf, and iss/aud
 * when configured. Returns the claims, or null for anything invalid. Never throws.
 */
export async function verifySessionTokenEdge(token: string | undefined, opts: EdgeVerifyOptions): Promise<Record<string, unknown> | null> {
  if (!token || !opts.secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  const header = decodeJson(parts[0]!);
  if (!header || header.alg !== "HS256") return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(opts.secret), b64urlToBytes(parts[2]!) as BufferSource, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  const claims = decodeJson(parts[1]!);
  if (!claims || claims.typ !== SESSION_TYP || typeof claims.sub !== "string") return null;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_SECONDS > now) return null;
  if (opts.issuer && claims.iss !== opts.issuer) return null;
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.audience)) return null;
  }
  return claims;
}

/**
 * `next` target after sign-in: only a same-origin relative path ("/matters?x=1"). Anything else (absolute URLs,
 * protocol-relative "//host", backslashes, control characters, the login page itself) becomes "/".
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string" || raw.length > 2048) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  try {
    const u = new URL(raw, "http://localhost");
    if (u.origin !== "http://localhost") return "/";
    if (u.pathname === "/login" || u.pathname.startsWith("/login/") || u.pathname.startsWith("/api/")) return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}
