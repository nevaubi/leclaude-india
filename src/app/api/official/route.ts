import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { officialStatus } from "@/modules/official/status";
import { officialErrorResponse } from "./errors";

export const runtime = "nodejs";

/** GET /api/official → OfficialStatus (sources with per-source stats, queue counts, database size vs budget, embeddings mode). */
async function handleGET() {
  try {
    return Response.json(await officialStatus(), { headers: { "cache-control": "private, max-age=30" } });
  } catch (e) {
    return officialErrorResponse(e, "official.status_failed");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
