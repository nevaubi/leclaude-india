import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { storageStatus } from "@/modules/documents/server/sets";
import { aiAvailable, DOCS_SURFACE, docsErrorResponse } from "@/modules/documents/server/http";

export const runtime = "nodejs";

/** GET → { ai, storage: { backend, usedMb, limitMb, full } } */
async function handleGET() {
  try {
    return Response.json({ ai: aiAvailable(), storage: await storageStatus() });
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
