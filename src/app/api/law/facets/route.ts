import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { lawFacets } from "@/modules/india/law/directory";
import { lawErrorResponse } from "@/modules/india/law/http";

export const runtime = "nodejs";

/** GET /api/law/facets → LawFacets (instruments per jurisdiction, State, regulator and status; dataset load rows). Cached ~10 minutes. */
async function handleGET() {
  try {
    return Response.json(await lawFacets());
  } catch (e) {
    return lawErrorResponse(e, "law.facets_failed", "Coverage for the statutes corpus could not be computed. Try again in a moment.");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
