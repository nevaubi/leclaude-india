import "server-only";
import { headers } from "next/headers";
import { currentAuthContext } from "./context";
import { authMode, resolvePrincipal } from "./principal";
import type { Principal } from "./types";

/**
 * The principal for a server page or layout (no route wrapper there). Resolved from the incoming request headers
 * (session cookie / bearer / proxy header, by AUTH_MODE); null when the request is not authenticated. In dev mode
 * this is the demo persona, as before.
 */
export async function pagePrincipal(path = "/"): Promise<Principal | null> {
  const ctx = currentAuthContext();
  if (ctx) return ctx.principal;
  try {
    return await resolvePrincipal(new Request(`http://localhost${path}`, { headers: new Headers(await headers()) }));
  } catch {
    return null;
  }
}

/** True when sign-in is enforced (any AUTH_MODE but dev; an invalid mode counts as enforced). */
export function signInEnforced(): boolean {
  try {
    return authMode() !== "dev";
  } catch {
    return true;
  }
}
