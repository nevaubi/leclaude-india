import "server-only";
import { jsonError } from "@/lib/ai/sse";
import { aiConfig, AIConfigError } from "@/lib/ai/config";
import { currentPrincipal } from "@/lib/auth/context";
import { AuthError } from "@/lib/auth/errors";
import type { Principal, ResourceRef } from "@/lib/auth/types";
import { DocsError } from "./access";

/**
 * Route helpers for /api/documents/**. The route wrapper (`withAuth`) checks the caller may use document sets at
 * all; each handler then resolves the set and authorizes it in code (matter policy or owner), so unknown and
 * unreadable sets are both 404.
 */

/** Wrapper-level resource: the document-sets surface itself (set-level checks happen in the handler). */
export const DOCS_SURFACE: ResourceRef = { kind: "research", id: "documents" };

export function principal(): Principal {
  const p = currentPrincipal();
  if (!p) throw AuthError.unauthenticated();
  return p;
}

export function aiAvailable(): boolean {
  try { return aiConfig().hasKey; } catch { return false; }
}

export function aiUnavailableResponse(): Response {
  return jsonError(new AIConfigError().message, 503, { code: "ai_not_configured" });
}

export function docsErrorResponse(e: unknown): Response {
  if (e instanceof DocsError) return jsonError(e.message, e.status, e.code ? { code: e.code } : {});
  if (e instanceof AIConfigError || (e as { name?: string })?.name === "AIConfigError") return jsonError((e as Error).message, 503, { code: "ai_not_configured" });
  if (e instanceof AuthError) throw e; // mapped to 401/403 by withAuth
  console.error("[documents]", e);
  return jsonError("Something went wrong on the server; please try again.", 500);
}

export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}
