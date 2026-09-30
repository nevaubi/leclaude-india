import { withDb } from "@/lib/db/request";
import { AIConfigError, aiConfig } from "@/lib/ai/config";
import { jsonError } from "@/lib/ai/sse";
import { summarizeSource } from "@/modules/search/service";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";

export const runtime = "nodejs";
export const maxDuration = 120;

/** POST /api/search/summarize {title, cite?, text} → headnote-style summary (fast model). 503 + code when no key. */
async function handlePOST(req: Request) {
  const body = (await req.json().catch(() => null)) as { title?: string; cite?: string; text?: string } | null;
  if (!body?.text?.trim()) return jsonError("`text` is required");
  if (!aiConfig().hasKey) return jsonError("OPENAI_API_KEY is not configured. Add it to .env.local to enable AI summaries.", 503, { code: "no_api_key" });
  try {
    const headnotes = await summarizeSource({ title: body.title ?? "Source", cite: body.cite, text: body.text, signal: req.signal });
    return Response.json({ headnotes, model: aiConfig().fastModel });
  } catch (e) {
    if (e instanceof AIConfigError) return jsonError(e.message, 503, { code: "no_api_key" });
    return jsonError(e instanceof Error ? e.message : String(e), 502, { code: "ai_failed" });
  }
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => refs.research() }));
