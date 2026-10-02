import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { remoteStore } from "@/lib/db/remote";
import { withDb } from "@/lib/db/request";
import { scrReportsForJudgment } from "@/modules/india/scr/load";

export const runtime = "nodejs";

/**
 * GET /api/india/scr?judgment=<corpus judgment id> → { reports, built }: the Supreme Court Reports entries linked to
 * that judgment by exact identifiers (SCR and INSC citations, official headnote, how the link was made).
 */
async function handleGET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("judgment") ?? "";
  if (!/^sc:[A-Za-z0-9_.-]{1,120}$/.test(id)) return jsonError("judgment must be a Supreme Court corpus id (sc:…)", 400, { code: "bad_id" });
  const store = remoteStore();
  if (!store) return jsonError("The case-law corpus is not configured on this deployment.", 503, { code: "corpus_not_configured" });
  try {
    const reports = await scrReportsForJudgment(store, id);
    return Response.json({ built: reports !== null, reports: reports ?? [], attribution: "Supreme Court Reports (official law reporter of the Supreme Court of India), from the portal's result cards." });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "india.scr_failed", error: (e as Error).message }));
    return jsonError("The SCR record could not be loaded.", 502, { code: "scr_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
