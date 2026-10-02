import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { currentPrincipal } from "@/lib/auth/context";
import { refs } from "@/lib/auth/resources";
import { handleCronRun, handleRunRequest } from "./handler";

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

/** Vercel cron (GET, CRON_SECRET bearer → service principal); runs only when OFFICIAL_INGEST is on. */
async function handleGET(req: NextRequest) {
  const res = await handleCronRun({ principal: currentPrincipal });
  if (res.status === 403) {
    // Booleans only (never the header or the secret): why a scheduled call did not resolve to the service principal.
    const auth = req.headers.get("authorization") ?? "";
    console.warn(JSON.stringify({
      event: "official.cron_denied",
      hasAuthorization: auth.length > 0,
      bearerScheme: /^Bearer\s+\S/i.test(auth),
      cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
      vercelCron: (req.headers.get("user-agent") ?? "").startsWith("vercel-cron"),
    }));
  }
  return res;
}

export const GET = withAuth(handleGET, { action: "run", resource: () => refs.intel() });
