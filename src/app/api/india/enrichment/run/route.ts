import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { courtById } from "@/lib/india/courts";
import { runEnrichment, type EnrichmentTarget } from "@/modules/judges/enrich";
import { JudgesNotConfiguredError } from "@/modules/judges/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

const TARGETS: EnrichmentTarget[] = ["judges", "courts", "all"];

/**
 * POST { target: "judges" | "courts" | "all", courts?: string[], deadlineMs? } → EnrichmentReport.
 * Reads official court pages (Firecrawl), stores vision-checked images in the media store, and upserts judges and
 * court identity assets. Idempotent; call again to continue after a deadline stop. Same permission as the corpus run.
 */
async function handlePOST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { target?: string; courts?: unknown; deadlineMs?: number };
  const target = (body.target ?? "all") as EnrichmentTarget;
  if (!TARGETS.includes(target)) return jsonError(`target must be one of ${TARGETS.join(", ")}`, 400, { code: "bad_target" });
  let courts: string[] | undefined;
  if (body.courts !== undefined) {
    if (!Array.isArray(body.courts) || body.courts.some((c) => typeof c !== "string")) return jsonError("courts must be an array of court ids", 400, { code: "bad_courts" });
    courts = (body.courts as string[]).slice(0, 40);
    const unknown = courts.filter((c) => !courtById(c));
    if (unknown.length) return jsonError(`Unknown court ids: ${unknown.join(", ")}`, 400, { code: "bad_courts" });
  }
  try {
    const deadlineMs = Math.max(10_000, Math.min(Number(body.deadlineMs) || 240_000, 270_000));
    return Response.json(await runEnrichment({ target, courts }, { deadlineMs }));
  } catch (e) {
    if (e instanceof JudgesNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    return jsonError((e as Error).message, 500);
  }
}

export const POST = withAuth(handlePOST, { action: "run", resource: () => refs.intel() });
