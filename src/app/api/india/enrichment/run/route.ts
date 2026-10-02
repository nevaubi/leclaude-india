import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { courtById } from "@/lib/india/courts";
import { runEnrichment, type EnrichmentTarget } from "@/modules/judges/enrich";
import { JudgesNotConfiguredError } from "@/modules/judges/schema";
import { auditCourtEmblems } from "@/modules/media/emblem-audit";
import { runVisuals, VISUAL_KINDS_ALL, VisualsNotConfiguredError } from "@/modules/media/visuals";
import type { VisualKind } from "@/modules/media/visuals-types";

export const runtime = "nodejs";
export const maxDuration = 300;
// Several Indian court and government sites only answer requests from India; run enrichment in Mumbai.
export const preferredRegion = ["bom1"];

type RunTarget = EnrichmentTarget | "visuals" | "emblems_audit";
const TARGETS: RunTarget[] = ["judges", "courts", "all", "visuals", "emblems_audit"];
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * POST → enrichment report. Same permission as the corpus run. Idempotent; call again to continue after a deadline stop.
 *   { target: "judges" | "courts" | "all", courts?: string[], deadlineMs? } → EnrichmentReport (official court pages).
 *   { target: "visuals", kinds?: VisualKind[], keys?: string[], refresh?: boolean, deadlineMs? } → VisualsReport
 *     (Commons photographs of court buildings and city landmarks, regulator logos; keys already shown are skipped
 *     unless refresh is true; `remaining` lists keys not reached before the deadline).
 *   { target: "emblems_audit" } → EmblemAuditReport (stored court emblems re-checked for the State Emblem; hits hidden).
 */
async function handlePOST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { target?: string; courts?: unknown; kinds?: unknown; keys?: unknown; refresh?: unknown; deadlineMs?: number };
  const target = (body.target ?? "all") as RunTarget;
  if (!TARGETS.includes(target)) return jsonError(`target must be one of ${TARGETS.join(", ")}`, 400, { code: "bad_target" });
  const deadlineMs = Math.max(10_000, Math.min(Number(body.deadlineMs) || 240_000, 270_000));

  if (target === "visuals") {
    let kinds: VisualKind[] | undefined;
    if (body.kinds !== undefined) {
      if (!Array.isArray(body.kinds) || body.kinds.some((k) => !VISUAL_KINDS_ALL.includes(k as VisualKind))) return jsonError(`kinds must be an array of ${VISUAL_KINDS_ALL.join(", ")}`, 400, { code: "bad_kinds" });
      kinds = body.kinds as VisualKind[];
    }
    let keys: string[] | undefined;
    if (body.keys !== undefined) {
      if (!Array.isArray(body.keys) || body.keys.length > 80 || body.keys.some((k) => typeof k !== "string" || !KEY_RE.test(k))) return jsonError("keys must be an array of at most 80 registry keys", 400, { code: "bad_keys" });
      keys = body.keys as string[];
    }
    if (body.refresh !== undefined && typeof body.refresh !== "boolean") return jsonError("refresh must be a boolean", 400, { code: "bad_refresh" });
    try {
      return Response.json(await runVisuals({ kinds, keys, refresh: body.refresh === true }, { deadlineMs }));
    } catch (e) {
      if (e instanceof VisualsNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
      return jsonError((e as Error).message, 500);
    }
  }

  if (target === "emblems_audit") {
    try {
      return Response.json(await auditCourtEmblems());
    } catch (e) {
      if (e instanceof JudgesNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
      return jsonError((e as Error).message, 500);
    }
  }

  let courts: string[] | undefined;
  if (body.courts !== undefined) {
    if (!Array.isArray(body.courts) || body.courts.some((c) => typeof c !== "string")) return jsonError("courts must be an array of court ids", 400, { code: "bad_courts" });
    courts = (body.courts as string[]).slice(0, 40);
    const unknown = courts.filter((c) => !courtById(c));
    if (unknown.length) return jsonError(`Unknown court ids: ${unknown.join(", ")}`, 400, { code: "bad_courts" });
  }
  try {
    return Response.json(await runEnrichment({ target, courts }, { deadlineMs }));
  } catch (e) {
    if (e instanceof JudgesNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    return jsonError((e as Error).message, 500);
  }
}

export const POST = withAuth(handlePOST, { action: "run", resource: () => refs.intel() });
