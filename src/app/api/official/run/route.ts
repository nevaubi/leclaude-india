import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { currentPrincipal } from "@/lib/auth/context";
import { refs } from "@/lib/auth/resources";
import { handleRunRequest } from "./handler";

export const runtime = "nodejs";
/** A run works until its deadline (default 240s, at most 280s) and returns; call again to continue. */
export const maxDuration = 300;

/**
 * POST { sources?, stages?, concurrency?, deadlineMs?, limitPerSource?, forceDiscover? } → OfficialRunResult.
 * Requires `run` on intel AND the ingest token (x-official-token = OFFICIAL_INGEST_TOKEN) unless the caller is the cron
 * service principal. Writes go straight to Postgres (no local mirror).
 */
async function handlePOST(req: NextRequest) {
  return handleRunRequest(req, { principal: currentPrincipal });
}

export const POST = withAuth(handlePOST, { action: "run", resource: () => refs.intel() });
