import "server-only";
import { jsonError } from "@/lib/ai/sse";
import { auditDecision } from "./audit";
import { runWithPrincipal } from "./context";
import { AuthError, isAuthError } from "./errors";
import { authorize } from "./policy";
import { authMode, resolvePrincipal } from "./principal";
import type { Action, PolicyDecision, Principal, ResourceRef } from "./types";

export { requireMatterAccess, matterScope, scopeFor, narrowScope, accessibleMatterIds } from "./scope";
export { currentPrincipal, requirePrincipal, currentObligations } from "./context";

/**
 * Route-boundary authorization for Next 15 route handlers (constitution §22).
 *
 *   export const GET = withAuth(handleGET, { action: "read", resource: (_req, { id }) => refs.library(id) });
 *
 * The wrapper resolves the principal, authorizes principal ∩ tenant ∩ role ∩ matter ∩ resource ∩ action, writes
 * the audit event, runs the handler inside `runWithPrincipal` and maps failures to one 401 / one 403 shape. A
 * denial never becomes a 404, so an existence check cannot leak across tenants or matters. The handler's
 * signature is preserved exactly, which keeps Next's generated route types happy.
 */
export interface WithAuthOptions<P extends Record<string, string | string[] | undefined> = Record<string, string>> {
  action: Action | ((req: Request, params: P, principal: Principal) => Action | Promise<Action>);
  resource: (req: Request, params: P, principal: Principal) => ResourceRef | Promise<ResourceRef>;
  /** Label for the audit log; defaults to "METHOD /path". */
  via?: string;
}

// Route handlers are (req) or (req, ctx); the wrapper must accept either shape verbatim.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRouteHandler = (...args: any[]) => Response | Promise<Response>;

interface RouteCtx<P> {
  params?: Promise<P> | P;
}

export function unauthorizedResponse(message = "Authentication required"): Response {
  return jsonError(message, 401, { code: "unauthenticated" });
}

/** One 403 shape. The reason is included only in dev mode; production clients see nothing that describes the record. */
export function forbiddenResponse(decision?: Partial<Pick<PolicyDecision, "reason">>): Response {
  const extra: Record<string, unknown> = { code: "forbidden" };
  if (decision?.reason && isDevMode()) extra.reason = decision.reason;
  return jsonError("Forbidden", 403, extra);
}

function isDevMode(): boolean {
  try {
    return authMode() === "dev";
  } catch {
    return false;
  }
}

function routeLabel(req: Request): string {
  try {
    return `${req.method} ${new URL(req.url).pathname}`;
  } catch {
    return req.method ?? "GET";
  }
}

/** Handlers declared without a request parameter may be invoked as `GET()` (tests); authorize them as an anonymous GET. */
function ensureRequest(req: Request | undefined): Request {
  return req instanceof Request ? req : new Request("http://localhost/", { method: "GET" });
}

export function clientIp(req: Request): string | undefined {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || undefined;
  return req.headers.get("x-real-ip") ?? undefined;
}

export function withAuth<H extends AnyRouteHandler, P extends Record<string, string | string[] | undefined> = Record<string, string>>(handler: H, opts: WithAuthOptions<P>): H {
  const wrapped = async (rawReq: Request | undefined, ctx?: RouteCtx<P>): Promise<Response> => {
    const req = ensureRequest(rawReq);
    const via = opts.via ?? routeLabel(req);
    const ip = clientIp(req);
    let principal: Principal;
    try {
      principal = await resolvePrincipal(req);
    } catch (e) {
      if (isAuthError(e)) return unauthorizedResponse(e.message);
      throw e;
    }
    const params = ((await ctx?.params) ?? {}) as P;
    let resource: ResourceRef;
    let action: Action;
    try {
      resource = await opts.resource(req, params, principal);
      action = typeof opts.action === "function" ? await opts.action(req, params, principal) : opts.action;
    } catch (e) {
      if (isAuthError(e)) return e.status === 401 ? unauthorizedResponse(e.message) : forbiddenResponse(e);
      return jsonError("Could not determine the requested resource", 400, { code: "bad_resource" });
    }
    const decision = authorize({ principal, action, resource, via, environment: { ip, at: new Date().toISOString() } });
    try {
      auditDecision({ principal, action, resource, decision, via, ip });
    } catch (e) {
      console.warn("[auth] audit write failed", (e as Error).message);
    }
    if (!decision.allow) return forbiddenResponse(decision);
    try {
      return await runWithPrincipal(principal, () => Promise.resolve(handler(rawReq ?? req, ctx)), { decision, via });
    } catch (e) {
      if (isAuthError(e)) {
        const err = e as AuthError;
        try {
          auditDecision({ principal, action, resource, decision: { allow: false, reason: err.reason ?? err.message }, via, ip });
        } catch { /* audit failures never mask the response */ }
        return err.status === 401 ? unauthorizedResponse(err.message) : forbiddenResponse(err);
      }
      throw e;
    }
  };
  return wrapped as unknown as H;
}
