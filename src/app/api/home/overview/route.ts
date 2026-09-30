import { withDb } from "@/lib/db/request";
import { aiConfig } from "@/lib/ai/config";
import { loadHomeInitialData, withDocumentSetFiles } from "@/modules/home/service";
import { currentPrincipal } from "@/lib/auth/context";
import { withAuth } from "@/lib/auth/route";

export const runtime = "nodejs";

/** Everything the home page needs, for client-side refreshes. */
async function handleGET() {
  return Response.json(await withDocumentSetFiles(loadHomeInitialData({ aiConfigured: aiConfig().hasKey }), currentPrincipal()));
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => ({ kind: "brief" }) }));
