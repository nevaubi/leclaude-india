import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { currentPrincipal } from "@/lib/auth/context";
import { refs } from "@/lib/auth/resources";
import { withCronGate } from "@/lib/auth/cron";
import { handleHcCronRun, handleHcRunRequest } from "./handler";

export const runtime = "nodejs";
/** A run works until its deadline (default 240 s, at most 280 s) and returns; call again to continue. */
export const maxDuration = 300;

/**
 * POST { deadlineMs?, concurrency?, limit?, retryFailed?, seed? } → HcRunResult. Requires `run` on intel AND the ingest
 * token (x-official-token = OFFICIAL_INGEST_TOKEN) unless the caller is the cron service principal.
 */
async function handlePOST(req: NextRequest) {
  return handleHcRunRequest(req, { principal: currentPrincipal });
}

export const POST = withAuth(handlePOST, { action: "run", resource: () => refs.intel() });

/** Vercel cron (GET, CRON_SECRET bearer → service principal); runs only when HC_TEXT_INGEST is on. */
async function handleGET() {
  return handleHcCronRun({ principal: currentPrincipal });
}

export const GET = withCronGate(withAuth(handleGET, { action: "run", resource: () => refs.intel() }));
