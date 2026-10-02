import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { OfficialNotConfiguredError } from "@/modules/official/service";
import { causeListEntries, caseKeyOf, CauseListQueryError, CAUSELIST_DEFAULT_LIMIT, diaryKeyOf } from "@/modules/official/causelist/query";
import { isForumKey } from "@/modules/official/causelist/forums";

export const runtime = "nodejs";

/**
 * GET /api/official/causelists?forum=sci&date=2026-10-05 (or from&to) [&case=SLP(C) No. 1234/2026|SLPC/1234/2026]
 *   [&diary=54583/2026] [&advocate=AJAY MARWAH] [&limit=200] → { entries, count, truncated }
 *
 * Exact matches only: `case` is normalized (a value that is not one recognisable case number is a 400, never guessed),
 * `diary` must be a diary number, `advocate` matches a whole printed name (case-insensitive). Without a date window or
 * an identifier the request is rejected (400). Entries are "as published": lists are not authoritative.
 * NCLT numbers repeat at every bench: a printed bench code is kept ("CP(IB)/29(MP)2022" → "CPIB/29/2022@MP") and
 * matches only that bench's listing; a number without one lists NCLT entries only with `forum` set to one bench, and
 * never an entry whose printed number carries a bench code.
 */
async function handleGET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const forum = sp.get("forum")?.trim().toLowerCase() || undefined;
  if (forum && !isForumKey(forum)) return jsonError("unknown forum", 400, { code: "bad_query" });
  const cases = sp.getAll("case").map((v) => v.trim()).filter(Boolean).slice(0, 50);
  const caseKeys: string[] = [];
  for (const c of cases) {
    const k = caseKeyOf(c);
    if (!k) return jsonError(`not a recognisable case number: ${c.slice(0, 80)}`, 400, { code: "bad_case_number" });
    caseKeys.push(k);
  }
  const diaries = sp.getAll("diary").map((v) => v.trim()).filter(Boolean).slice(0, 50);
  const diaryNos: string[] = [];
  for (const d of diaries) {
    const k = diaryKeyOf(d);
    if (!k) return jsonError(`not a diary number: ${d.slice(0, 40)}`, 400, { code: "bad_diary_number" });
    diaryNos.push(k);
  }
  const hasWindow = !!(sp.get("date") || sp.get("from") || sp.get("to"));
  if (!hasWindow && !caseKeys.length && !diaryNos.length) return jsonError("give a date (or from/to) or a case / diary number", 400, { code: "bad_query" });
  const limitRaw = sp.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) return jsonError("limit must be 1-1000", 400, { code: "bad_query" });
  try {
    const entries = await causeListEntries({
      forum,
      date: sp.get("date") ?? undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      caseKeys: caseKeys.length ? caseKeys : undefined,
      diaryNos: diaryNos.length ? diaryNos : undefined,
      advocate: sp.get("advocate") ?? undefined,
      limit,
    });
    // A full page means more entries may match: the caller is told so (narrow the window or raise the limit).
    return Response.json({ entries, count: entries.length, truncated: entries.length >= (limit ?? CAUSELIST_DEFAULT_LIMIT) });
  } catch (e) {
    if (e instanceof OfficialNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    if (e instanceof CauseListQueryError) return jsonError(e.message, 400, { code: e.code });
    console.error("[official.causelists]", (e as Error).message);
    return jsonError("Could not read cause lists", 500, { code: "causelists_failed" });
  }
}

export const GET = withAuth(handleGET, { action: "read", resource: () => refs.intel() });
