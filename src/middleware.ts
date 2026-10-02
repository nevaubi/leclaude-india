import { NextResponse, type NextRequest } from "next/server";
import { gate, PATH_HEADER } from "@/lib/auth/gatekeeper";
import { SESSION_COOKIE } from "@/lib/auth/session-token";

/** Static references, so the values reach the gate whether the platform inlines them at build time or provides them at runtime. */
function gateSettings() {
  return {
    AUTH_MODE: process.env.AUTH_MODE,
    AUTH_JWT_SECRET: process.env.AUTH_JWT_SECRET,
    AUTH_JWT_ISSUER: process.env.AUTH_JWT_ISSUER,
    AUTH_JWT_AUDIENCE: process.env.AUTH_JWT_AUDIENCE,
  };
}

/**
 * Sign-in lockdown (AUTH_MODE=jwt). The decision lives in src/lib/auth/gatekeeper.ts; this file only maps it to a
 * response. Route handlers (withAuth) and server pages (resolvePrincipal) remain the authoritative checks.
 */
export async function middleware(req: NextRequest) {
  const result = await gate({
    method: req.method,
    pathname: req.nextUrl.pathname,
    search: req.nextUrl.search,
    authorization: req.headers.get("authorization"),
    cookie: req.headers.get("cookie"),
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
    forwardedHost: req.headers.get("x-forwarded-host"),
    env: gateSettings(),
  });
  switch (result.kind) {
    case "next": {
      // The root layout reads the path from here (always overwritten, so a client cannot spoof it).
      const headers = new Headers(req.headers);
      headers.set(PATH_HEADER, req.nextUrl.pathname);
      return NextResponse.next({ request: { headers } });
    }
    case "redirect": {
      const res = NextResponse.redirect(new URL(result.location, req.url), 307);
      if (result.clearCookie) res.cookies.delete(SESSION_COOKIE);
      return res;
    }
    case "unauthorized": {
      const res = NextResponse.json({ error: result.message, code: "unauthenticated" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="leclaude"', "cache-control": "no-store" } });
      if (result.clearCookie) res.cookies.delete(SESSION_COOKIE);
      return res;
    }
    case "forbidden":
      return NextResponse.json({ error: result.message, code: "forbidden" }, { status: 403 });
  }
}

export const config = {
  // Everything except Next's build output; the gate itself allowlists the few public paths.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
