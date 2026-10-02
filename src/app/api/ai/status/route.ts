import { withDb } from "@/lib/db/request";
import { aiConfig } from "@/lib/ai/config";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";

export const runtime = "nodejs";

async function GET__handler() {
  const cfg = aiConfig();
  return Response.json({ configured: cfg.hasKey, model: cfg.model, fastModel: cfg.fastModel, embeddingModel: cfg.embeddingModel, imageModel: cfg.imageModel, reasoningEffort: cfg.reasoningEffort, baseURL: cfg.baseURL ?? null });
}

export const GET = withDb(withAuth(GET__handler, { action: "read", resource: () => refs.settings() }));
