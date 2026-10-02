import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { hcCoverage } from "@/modules/india/corpus/hc-text/coverage";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/india/hc-text/coverage → HcCoverage: High Court judgments per court × year with text (Open India Law, PDF
 * text layer, OCR, partial), failed and metadata-only, the worker queue and the database size against its budget.
 * Signed-in members with read access to research data only (withAuth read on intel; client guests are refused).
 */
async function handleGET() {
  try {
    return Response.json(await hcCoverage(), { headers: { "cache-control": "private, max-age=60" } });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "hc_text.coverage_failed", error: (e as Error)?.message?.slice(0, 300) }));
    return jsonError("Coverage could not be read just now. Try again in a moment.", 502, { code: "coverage_unavailable" });
  }
}

export const GET = withAuth(handleGET, { action: "read", resource: () => refs.intel() });
