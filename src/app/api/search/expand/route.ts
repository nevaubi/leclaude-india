import { withDb } from "@/lib/db/request";
import { AIConfigError, aiConfig } from "@/lib/ai/config";
import { jsonError } from "@/lib/ai/sse";
import { jurisdictionByKey } from "@/modules/search/jurisdictions";
import { expandQuery } from "@/modules/search/service";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";

export const runtime = "nodejs";
export const maxDuration = 120;

/** POST /api/search/expand {query, jurisdiction?} → three alternate boolean queries (fast model, JSON schema). */
async function handlePOST(req: Request) {
  const body = (await req.json().catch(() => null)) as { query?: string; jurisdiction?: string } | null;
  if (!body?.query?.trim()) return jsonError("`query` is required");
  if (!aiConfig().hasKey) return jsonError("OPENAI_API_KEY is not configured. Add it to .env.local to enable AI query expansion.", 503, { code: "no_api_key" });
  try {
    const queries = await expandQuery(body.query.trim(), jurisdictionByKey(body.jurisdiction).label, req.signal);
    return Response.json({ queries });
  } catch (e) {
    if (e instanceof AIConfigError) return jsonError(e.message, 503, { code: "no_api_key" });
    return jsonError(e instanceof Error ? e.message : String(e), 502, { code: "ai_failed" });
  }
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => refs.research() }));
