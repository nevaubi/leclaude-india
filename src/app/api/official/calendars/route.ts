import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { OfficialNotConfiguredError } from "@/modules/official/service";
import { CalendarQueryError, courtCalendarWithSources } from "@/modules/official/calendars/query";
import { isForumKey } from "@/modules/official/causelist/forums";

export const runtime = "nodejs";

/**
 * GET /api/official/calendars?forum=sci&years=2026,2027 → { calendar | null, sources, forum, notes }
 *
 * The court's notified calendar built from official holiday lists (court_holidays). `calendar` is null when no official
 * calendar is loaded for those years (never a sample). 503 when the official-sources corpus is not configured.
 * Dates read from a scan are flagged: `sources[].ocr` / `sources[].note`, a warning in `notes` and first in
 * `calendar.source`, an id ending in ":ocr", and "(OCR-read; verify against the PDF)" on closures only OCR text gives.
 */
async function handleGET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const forum = (sp.get("forum") ?? "").trim().toLowerCase();
  if (!isForumKey(forum)) return jsonError("forum is required (e.g. sci, hc-delhi, nclt-mumbai)", 400, { code: "bad_query" });
  const raw = sp.getAll("years").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const years = raw.length ? raw.map(Number) : [new Date().getUTCFullYear()];
  if (years.some((y) => !Number.isInteger(y))) return jsonError("years must be whole years (e.g. 2026,2027)", 400, { code: "bad_query" });
  try {
    const r = await courtCalendarWithSources(forum, years);
    return Response.json({ calendar: r.calendar, sources: r.sources, forum: r.forum, notes: r.notes });
  } catch (e) {
    if (e instanceof OfficialNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    if (e instanceof CalendarQueryError) return jsonError(e.message, 400, { code: e.code });
    console.error("[official.calendars]", (e as Error).message);
    return jsonError("Could not read the court calendar", 500, { code: "calendar_failed" });
  }
}

export const GET = withAuth(handleGET, { action: "read", resource: () => refs.intel() });
