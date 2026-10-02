import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { concordanceSummaries } from "@/lib/india/concordance/summaries";

export const runtime = "nodejs";

/**
 * GET /api/law/concordance?rows=ipc-bns:237,ipc-bns:238 → { rows: [{ id, summary }], sources } — the official
 * "summary of comparison" text for rows of the BPR&D correspondence tables (the rows themselves ship with the client
 * library). Static data: no database.
 */
async function handleGET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("rows") ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length || ids.length > 40) return jsonError("rows must list 1 to 40 row ids", 400, { code: "bad_rows" });
  return Response.json(concordanceSummaries(ids));
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
