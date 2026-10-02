import { withDb } from "@/lib/db/request";
import type { ResponseInput, ResponseInputItem } from "openai/resources/responses/responses";
import { runAgent } from "@/lib/ai/agent";
import { AIConfigError } from "@/lib/ai/config";
import { jsonError, sseResponse } from "@/lib/ai/sse";
import { researchToolset } from "@/lib/ai/toolkit";
import { FIRM_NAME, LEGAL_STYLE_RULES, RESEARCH_METHOD, todayLine } from "@/lib/ai/prompts";
import { db } from "@/lib/db";
import { withAuth } from "@/lib/auth/route";
import { bodyMatterId, refs } from "@/lib/auth/resources";

export const runtime = "nodejs";

interface Body {
  message: string;
  attachments?: { kind: "image"; name: string; dataUrl: string }[];
  history?: { role: "user" | "assistant"; content: string }[];
  previousResponseId?: string | null;
  matterId?: string | null;
  research?: { web?: boolean; legal?: boolean; internal?: boolean };
  instructions?: string;
}

/** General-purpose firm assistant with the full research toolset (used by Home and the palette). */
async function POST__handler(req: Request) {
  let body: Body;
  try { body = (await req.json()) as Body; } catch { return jsonError("Invalid JSON"); }
  if (!body?.message) return jsonError("`message` is required");
  const matter = body.matterId ? db().matters.get(body.matterId) : null;
  const { tools, builtinTools } = researchToolset({ web: body.research?.web ?? true, legal: body.research?.legal ?? true, internal: body.research?.internal ?? true });
  const instructions = [
    `You are the ${FIRM_NAME} research and operations assistant. ${todayLine()}`,
    matter ? `Active matter: ${matter.name} (${matter.caption ?? ""}), client ${matter.client} (${matter.clientSide}). ${matter.description ?? ""}` : "No matter is selected; use get_matter_context to look one up if the question refers to a matter.",
    RESEARCH_METHOD,
    LEGAL_STYLE_RULES,
    body.instructions ?? "",
  ].filter(Boolean).join("\n\n");
  const input: ResponseInput = [];
  if (!body.previousResponseId) for (const h of (body.history ?? []).slice(-16)) input.push({ role: h.role, content: h.content.slice(0, 12_000) } as ResponseInputItem);
  const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "high" }> = [{ type: "input_text", text: body.message }];
  for (const a of body.attachments ?? []) if (a.dataUrl?.startsWith("data:image/")) content.push({ type: "input_image", image_url: a.dataUrl, detail: "high" });
  input.push({ role: "user", content } as ResponseInputItem);
  return sseResponse(async (send, signal) => {
    try {
      await runAgent({ instructions, input, tools, builtinTools, previousResponseId: body.previousResponseId ?? null, maxSteps: 14, signal, metadata: { app: "leclaude", surface: "chat" }, onEvent: send });
    } catch (e) {
      if (e instanceof AIConfigError) { send({ type: "error", message: e.message, code: "no_api_key" }); return; }
      throw e;
    }
  });
}

// The selected matter (body.matterId) is authorized at the boundary; research tools re-check matter scope inside.
export const POST = withDb(withAuth(POST__handler, { action: "run", resource: async (req) => refs.research(undefined, await bodyMatterId(req)) }));
