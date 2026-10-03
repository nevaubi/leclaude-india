/**
 * The request gate that `src/middleware.ts` applies when AUTH_MODE=jwt (pure and edge-safe, unit-tested).
 *
 *   page without a valid session cookie   → 307 /login?next=<same-origin path>
 *   /api/* without a session or a Bearer  → 401 JSON
 *   cross-site state-changing API request → 403 JSON (Origin does not match the host)
 *
 * The allowlist is deliberately short (see PUBLIC_*). A Bearer header on /api/* is passed through un-verified here
 * because every route handler verifies it with `withAuth` (enforced by tests/auth-route-audit.test.ts); pages have
 * no such wrapper, so a page needs a session cookie that verifies right here.
 *
 * AUTH_MODE=dev and AUTH_MODE=header are passed through unchanged (header mode is authenticated by the proxy in
 * front of the app). Any other value, including a typo, is enforced: the gate fails closed.
 */
import { readCookie, safeNextPath, SESSION_COOKIE, verifySessionTokenEdge } from "./session-token";

/** Pages reachable without a session. /setup is closed by the page itself once the workspace exists, and its POST needs AUTH_SETUP_TOKEN. */
export const PUBLIC_PAGES: readonly string[] = ["/login", "/setup", "/invite"];
/** API routes reachable without a session: sign-in/out, owner bootstrap, liveness, and the cron routes (which authenticate themselves with CRON_SECRET). */
export const PUBLIC_API: readonly string[] = ["/api/auth/login", "/api/auth/logout", "/api/auth/bootstrap", "/api/auth/invite", "/api/health", "/api/official/run", "/api/intel/jobs/tick", "/api/india/hc-text/run", "/api/news/run"];
/** Static asset prefixes / files. */
export const PUBLIC_ASSET_PREFIXES: readonly string[] = ["/_next/", "/brand/", "/vendor/"];
export const PUBLIC_ASSET_FILES: readonly string[] = ["/icon.svg", "/favicon.ico", "/robots.txt"];

export type GateEnv = Readonly<Record<string, string | undefined>>;

/** Request header the middleware sets to the pathname for the root layout (overwritten on every request). */
export const PATH_HEADER = "x-leclaude-pathname";

export type GateResult =
  | { kind: "next" }
  | { kind: "redirect"; location: string; clearCookie: boolean }
  | { kind: "unauthorized"; message: string; clearCookie: boolean }
  | { kind: "forbidden"; message: string };

export interface GateInput {
  method: string;
  pathname: string;
  search?: string;
  authorization?: string | null;
  cookie?: string | null;
  origin?: string | null;
  host?: string | null;
  forwardedHost?: string | null;
  env: GateEnv;
  /** Seconds since epoch (tests). */
  now?: number;
}

function val(env: GateEnv, name: string): string | undefined {
  const v = env[name];
  return v == null || !v.trim() ? undefined : v.trim();
}

/** True when the gate enforces sign-in: anything but dev (the default) and header. */
export function gateEnforced(env: GateEnv): boolean {
  const mode = (val(env, "AUTH_MODE") ?? "dev").toLowerCase();
  return mode !== "dev" && mode !== "header";
}

function matches(pathname: string, list: readonly string[]): boolean {
  return list.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_ASSET_FILES.includes(pathname)) return true;
  if (PUBLIC_ASSET_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  // Exact matches only for API routes: /api/auth/login/anything is not public.
  if (PUBLIC_API.includes(pathname)) return true;
  return matches(pathname, PUBLIC_PAGES);
}

function isApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isUnsafeMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A browser request whose Origin names another site. Requests without Origin (curl, server-to-server) pass. */
export function crossSite(input: Pick<GateInput, "origin" | "host" | "forwardedHost">): boolean {
  if (!input.origin || input.origin === "null") return Boolean(input.origin);
  const o = hostOf(input.origin);
  if (!o) return true;
  const hosts = [input.host, ...(input.forwardedHost ?? "").split(",")].map((h) => h?.trim().toLowerCase()).filter(Boolean);
  return !hosts.includes(o);
}

function bearer(authorization: string | null | undefined): boolean {
  return /^Bearer\s+\S+/i.test((authorization ?? "").trim());
}

export async function gate(input: GateInput): Promise<GateResult> {
  if (!gateEnforced(input.env)) return { kind: "next" };
  const { pathname } = input;
  const api = isApi(pathname);
  const sessionToken = readCookie(input.cookie, SESSION_COOKIE);

  // CSRF defence in depth (the cookie is SameSite=Lax): a state-changing API call from another origin is refused,
  // public routes included (login CSRF).
  if (api && isUnsafeMethod(input.method) && crossSite(input)) return { kind: "forbidden", message: "Cross-site request refused" };

  if (isPublicPath(pathname)) return { kind: "next" };

  const secret = val(input.env, "AUTH_JWT_SECRET");
  const claims = secret ? await verifySessionTokenEdge(sessionToken, { secret, issuer: val(input.env, "AUTH_JWT_ISSUER"), audience: val(input.env, "AUTH_JWT_AUDIENCE"), now: input.now }) : null;
  if (claims) return { kind: "next" };

  if (api) {
    if (bearer(input.authorization)) return { kind: "next" };
    return { kind: "unauthorized", message: sessionToken ? "Your session has expired. Sign in again." : "Authentication required", clearCookie: Boolean(sessionToken) };
  }
  const next = safeNextPath(`${pathname}${input.search ?? ""}`);
  const location = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
  return { kind: "redirect", location, clearCookie: Boolean(sessionToken) };
}
