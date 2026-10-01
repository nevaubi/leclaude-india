import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { PLAYBOOKS } from "@/modules/documents/server/playbooks";
import { DOCS_SURFACE, docsErrorResponse } from "@/modules/documents/server/http";

export const runtime = "nodejs";

/** GET → { playbooks: ReviewPlaybook[] } (the review playbook catalogue) */
async function handleGET() {
  try {
    return Response.json({ playbooks: PLAYBOOKS });
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
