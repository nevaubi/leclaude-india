import { withDb } from "@/lib/db/request";
import { jsonError } from "@/lib/ai/sse";
import { checkCitations } from "@/modules/search/service";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";

export const runtime = "nodejs";
export const maxDuration = 120;

/** POST /api/search/citecheck {text} → extracted citations + CourtListener resolution (graceful when offline). */
async function handlePOST(req: Request) {
  const body = (await req.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim() ?? "";
  if (!text) return jsonError("`text` is required");
  if (text.length > 120_000) return jsonError("Text is too long (max 120,000 characters)");
  const result = await checkCitations(text, req.signal);
  return Response.json(result);
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => refs.research() }));
