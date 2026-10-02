import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { readVisuals } from "@/modules/media/visuals";

export const runtime = "nodejs";

/**
 * GET /api/india/visuals → VisualsResponse (src/modules/media/visuals-types.ts): court building and city photographs and
 * regulator logos that passed the vision check and are not hidden (never an image showing the State Emblem), each with
 * its credit. Not matter data; cached like the court emblems. Empty maps and updatedAt null when no store is configured.
 */
async function handleGET() {
  try {
    return Response.json(await readVisuals(), { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "india.visuals_failed", error: (e as Error).message }));
    return jsonError("The visual library could not be loaded.", 502, { code: "visuals_unavailable" });
  }
}

export const GET = withAuth(handleGET, { action: "read", resource: () => refs.intel() });
