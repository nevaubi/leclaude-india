import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { jsonError } from "@/lib/ai/sse";
import { matterListings } from "@/modules/matters/desk/server";
import { resolveRange } from "@/modules/matters/desk/dates";
import { serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the next 14 days, IST) — this matter's exact listings in parsed cause
 * lists. Authorization runs first (withAuth on the matter); only this matter's identifiers reach the official facade.
 * `state` is ok | not_configured | not_available | error; lists are published by the courts and carry fetchedAt.
 */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const url = new URL(req.url);
  const range = resolveRange(url.searchParams.get("from"), url.searchParams.get("to"), 14);
  if (!range.ok) return jsonError(range.error, 400, { code: "bad_range" });
  try {
    return Response.json(await matterListings(id, range.from, range.to));
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: (_req, { id }) => refs.matter(id) }));
