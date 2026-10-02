import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { jsonError } from "@/lib/ai/sse";
import type { Principal } from "@/lib/auth/types";
import { officialIngestEnabled, runOfficialIngest, type OfficialRunOptions, type OfficialRunResult } from "@/modules/official/run";
import { isSourceId, type SourceId } from "@/modules/official/types";
import { claimStartSlot, officialStore, UNIT_STAGES, type UnitStage } from "@/modules/official/units";
import { officialErrorResponse } from "../errors";

/**
 * POST /api/official/run, separated from the route file so it can be tested as a pure handler.
 *
 * Besides the route's `withAuth(run, intel)` decision, an ingest run needs the operator token: header
 * `x-official-token` equal to OFFICIAL_INGEST_TOKEN (constant-time compare). The scheduled service principal (CRON_SECRET
 * bearer) is exempt. Without OFFICIAL_INGEST_TOKEN only the service principal may run (503 not_configured otherwise).
 */

export const MIN_DEADLINE_MS = 10_000;
export const MAX_DEADLINE_MS = 280_000;
export const DEFAULT_DEADLINE_MS = 240_000;

function sameSecret(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time regardless of length.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type IngestGate = { ok: true; via: "service" | "token" } | { ok: false; status: 403 | 503; code: string; message: string };

export function ingestGate(req: Request, principal: Principal | null, env: Readonly<Record<string, string | undefined>> = process.env): IngestGate {
  if (principal && principal.source === "service" && principal.roles.includes("service")) return { ok: true, via: "service" };
  const token = env.OFFICIAL_INGEST_TOKEN?.trim();
  if (!token) return { ok: false, status: 503, code: "not_configured", message: "Ingest runs are not configured on this deployment (OFFICIAL_INGEST_TOKEN is not set)." };
  const given = req.headers.get("x-official-token")?.trim() ?? "";
  if (!given || !sameSecret(given, token)) return { ok: false, status: 403, code: "ingest_token_required", message: "An ingest run needs a valid x-official-token header." };
  return { ok: true, via: "token" };
}

export interface RunBody {
  sources?: SourceId[];
  stages?: UnitStage[];
  concurrency?: number;
  deadlineMs: number;
  limitPerSource?: number;
  forceDiscover?: boolean;
  /** Re-queue documents whose last attempt failed (never those the publisher answered 404/410 for). */
  retryFailed?: boolean;
}

/** Validate the JSON body; RangeError with a precise message for anything malformed. */
export function parseRunBody(raw: unknown): RunBody {
  const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: RunBody = { deadlineMs: DEFAULT_DEADLINE_MS };
  if (b.sources !== undefined) {
    if (!Array.isArray(b.sources) || b.sources.length > 40 || !b.sources.every(isSourceId)) throw new RangeError("sources must be an array of known source ids");
    out.sources = b.sources as SourceId[];
  }
  if (b.stages !== undefined) {
    if (!Array.isArray(b.stages) || !b.stages.every((s) => (UNIT_STAGES as readonly unknown[]).includes(s))) throw new RangeError(`stages must be a subset of ${UNIT_STAGES.join(", ")}`);
    out.stages = b.stages as UnitStage[];
  }
  if (b.concurrency !== undefined) {
    if (typeof b.concurrency !== "number" || !Number.isInteger(b.concurrency) || b.concurrency < 1 || b.concurrency > 16) throw new RangeError("concurrency must be an integer between 1 and 16");
    out.concurrency = b.concurrency;
  }
  if (b.limitPerSource !== undefined) {
    if (typeof b.limitPerSource !== "number" || !Number.isInteger(b.limitPerSource) || b.limitPerSource < 1 || b.limitPerSource > 500) throw new RangeError("limitPerSource must be an integer between 1 and 500");
    out.limitPerSource = b.limitPerSource;
  }
  if (b.deadlineMs !== undefined) {
    if (typeof b.deadlineMs !== "number" || !Number.isFinite(b.deadlineMs)) throw new RangeError("deadlineMs must be a number");
    out.deadlineMs = Math.max(MIN_DEADLINE_MS, Math.min(Math.floor(b.deadlineMs), MAX_DEADLINE_MS));
  }
  if (b.forceDiscover !== undefined) {
    if (typeof b.forceDiscover !== "boolean") throw new RangeError("forceDiscover must be a boolean");
    out.forceDiscover = b.forceDiscover;
  }
  if (b.retryFailed !== undefined) {
    if (typeof b.retryFailed !== "boolean") throw new RangeError("retryFailed must be a boolean");
    out.retryFailed = b.retryFailed;
  }
  return out;
}

export interface RunRouteDeps {
  principal: () => Principal | null;
  run?: (o: OfficialRunOptions) => Promise<OfficialRunResult>;
  env?: Readonly<Record<string, string | undefined>>;
  /** Global start throttle for unauthenticated scheduled kicks (tests inject it). */
  claimSlot?: () => Promise<boolean>;
}

export async function handleRunRequest(req: Request, deps: RunRouteDeps): Promise<Response> {
  const gate = ingestGate(req, deps.principal(), deps.env ?? process.env);
  if (!gate.ok) return jsonError(gate.message, gate.status, { code: gate.code });
  let body: RunBody;
  try {
    const raw = await req.json().catch(() => ({}));
    body = parseRunBody(raw);
  } catch (e) {
    return officialErrorResponse(e, "official.run_bad_request");
  }
  try {
    const r = await (deps.run ?? runOfficialIngest)({ ...body });
    return Response.json(r);
  } catch (e) {
    return officialErrorResponse(e, "official.run_failed");
  }
}

/** Scheduled runs: work until shortly before the function limit, and redrive old failures a bounded number of times. */
export const CRON_DEADLINE_MS = 270_000;
export const CRON_REDRIVE = { cooldownMinutes: 60, maxRedrives: 3 } as const;
/** Minimum seconds between scheduled starts when the deployment has no CRON_SECRET (just under the 2-minute schedule). */
export const CRON_MIN_INTERVAL_S = 110;
const CRON_SLOT_KEY = "official_cron_start";

async function defaultClaimSlot(): Promise<boolean> {
  return claimStartSlot(await officialStore(), CRON_SLOT_KEY, CRON_MIN_INTERVAL_S);
}

/**
 * GET /api/official/run — the Vercel cron entry (vercel.json). Nothing runs, and the database is not touched, unless
 * OFFICIAL_INGEST is on.
 * - With CRON_SECRET configured (Vercel then sends it as a bearer), only the scheduled service principal may start a run.
 * - Without CRON_SECRET, Vercel cannot authenticate its cron, so a call is a "kick": it starts a run only when no run
 *   started in the last CRON_MIN_INTERVAL_S seconds (claimed atomically in Postgres). Extra calls are no-ops (429), so
 *   nobody can make the ingest run more often than the schedule does. The work itself is bounded public-data ingestion.
 */
export async function handleCronRun(deps: RunRouteDeps): Promise<Response> {
  const vars = deps.env ?? process.env;
  const p = deps.principal();
  const service = Boolean(p && p.source === "service" && p.roles.includes("service"));
  const secretConfigured = Boolean(vars.CRON_SECRET?.trim());
  if (!service && secretConfigured) {
    return jsonError("Scheduled ingest runs are only started by the cron service principal; use POST with the ingest token.", 403, { code: "service_only" });
  }
  if (!officialIngestEnabled(vars)) return Response.json({ stop: "disabled", notes: ["OFFICIAL_INGEST is off"] });
  const workers = Number(vars.OFFICIAL_CONCURRENCY);
  try {
    if (!service) {
      const claimed = await (deps.claimSlot ?? defaultClaimSlot)();
      if (!claimed) {
        return Response.json({ stop: "throttled", notes: [`a scheduled run started less than ${CRON_MIN_INTERVAL_S}s ago`] }, { status: 429, headers: { "retry-after": String(CRON_MIN_INTERVAL_S) } });
      }
    }
    const r = await (deps.run ?? runOfficialIngest)({
      deadlineMs: CRON_DEADLINE_MS,
      concurrency: Number.isInteger(workers) && workers >= 1 ? Math.min(workers, 16) : 6,
      redrive: { ...CRON_REDRIVE },
    });
    return Response.json(r);
  } catch (e) {
    return officialErrorResponse(e, "official.run_failed");
  }
}
