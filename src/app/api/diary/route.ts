import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth, requirePrincipal } from "@/lib/auth/route";
import { jsonError } from "@/lib/ai/sse";
import { loadDiary } from "@/modules/diary/server";
import { resolveRange } from "@/modules/matters/desk/dates";

export const runtime = "nodejs";

/**
 * GET ?from&to (default: the next 14 days, IST) — listings in parsed cause lists, hand-entered hearings and recorded
 * next-hearing dates across the open matters the principal may read. Matters are filtered by the principal's access
 * before any identifier is looked up.
 */
async function handleGET(req: NextRequest) {
  const url = new URL(req.url);
  const range = resolveRange(url.searchParams.get("from"), url.searchParams.get("to"), 14);
  if (!range.ok) return jsonError(range.error, 400, { code: "bad_range" });
  return Response.json(await loadDiary(requirePrincipal(), range.from, range.to));
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "matter" }) }));
