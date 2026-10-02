import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth, requirePrincipal } from "@/lib/auth/route";
import { jsonError } from "@/lib/ai/sse";
import { advocateLists, putAdvocateNames } from "@/modules/diary/server";
import { ADVOCATE_LIST_LINKS, ADVOCATE_LIST_LINKS_CHECKED_ON } from "@/modules/diary/advocate-links";
import { resolveRange } from "@/modules/matters/desk/dates";
import { readJsonObject, serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";

/**
 * GET ?from&to (default: the next 7 days) — the caller's saved advocate names, their exact-token matches in parsed
 * cause lists, and links to the High Courts' own advocate-wise search pages (linked, never fetched).
 */
async function handleGET(req: NextRequest) {
  const url = new URL(req.url);
  const range = resolveRange(url.searchParams.get("from"), url.searchParams.get("to"), 7);
  if (!range.ok) return jsonError(range.error, 400, { code: "bad_range" });
  const lists = await advocateLists(requirePrincipal(), range.from, range.to);
  return Response.json({ ...lists, links: ADVOCATE_LIST_LINKS, linksCheckedOn: ADVOCATE_LIST_LINKS_CHECKED_ON });
}

/** PUT { names: string[] } — replace the caller's saved advocate names (at most 8). */
async function handlePUT(req: NextRequest) {
  try {
    const body = await readJsonObject(req);
    return Response.json({ names: putAdvocateNames(requirePrincipal(), body.names) });
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

// Per-user preferences: the resource is the caller's own settings record.
export const GET = withDb(withAuth(handleGET, { action: "read", resource: (_req, _p, principal) => ({ kind: "settings", id: `diary-advocates:${principal.id}` }) }));
export const PUT = withDb(withAuth(handlePUT, { action: "write", resource: (_req, _p, principal) => ({ kind: "settings", id: `diary-advocates:${principal.id}` }) }));
