import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { currentPrincipal } from "@/lib/auth/context";
import { refs } from "@/lib/auth/resources";
import { withCronGate } from "@/lib/auth/cron";
import { handleLawLinksCron, handleLawLinksPost } from "./handler";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST { tasks?, deadlineMs?, restart?, limit? } — see ./handler.ts. Requires `run` on intel and the ingest token (or the cron service principal). */
async function handlePOST(req: NextRequest) {
  return handleLawLinksPost(req, { principal: currentPrincipal });
}

export const POST = withAuth(handlePOST, { action: "run", resource: () => refs.intel() });

/** Vercel cron (GET, CRON_SECRET bearer → service principal); runs only when LAW_LINKS_INGEST=1. */
async function handleGET() {
  return handleLawLinksCron({ principal: currentPrincipal });
}

export const GET = withCronGate(withAuth(handleGET, { action: "run", resource: () => refs.intel() }));
