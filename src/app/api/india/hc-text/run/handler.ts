import "server-only";
import { jsonError } from "@/lib/ai/sse";
import type { Principal } from "@/lib/auth/types";
import { ingestGate } from "@/app/api/official/run/handler";
import { hcTextConfig } from "@/modules/india/corpus/hc-text/config";
import { hcRepo, HcTextNotConfiguredError, runHcTextIngest, type HcRunOptions, type HcRunResult } from "@/modules/india/corpus/hc-text/run";

/**
 * /api/india/hc-text/run, separated from the route file so it can be tested as a pure handler. Gated exactly like
 * /api/official/run: POST needs `run` on intel (route) AND the operator token (x-official-token = OFFICIAL_INGEST_TOKEN)
 * unless the caller is the cron service principal; GET is the Vercel cron entry.
 */

export const MIN_DEADLINE_MS = 10_000;
export const MAX_DEADLINE_MS = 280_000;
export const DEFAULT_DEADLINE_MS = 240_000;
/** Scheduled runs work until a minute before the 300 s function limit (watchdog hands units back after that). */
export const CRON_DEADLINE_MS = 240_000;
/** Minimum seconds between unauthenticated scheduled kicks (dev mode only; just under the 5-minute schedule). */
export const CRON_MIN_INTERVAL_S = 280;
const CRON_SLOT_KEY = "hc_text_cron_start";

export interface HcRunBody { deadlineMs: number; concurrency?: number; limit?: number; retryFailed?: boolean; seed?: boolean }

export function parseHcRunBody(raw: unknown): HcRunBody {
  const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: HcRunBody = { deadlineMs: DEFAULT_DEADLINE_MS };
  const int = (k: string, min: number, max: number) => {
    const v = b[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new RangeError(`${k} must be an integer between ${min} and ${max}`);
    return v;
  };
  if (b.deadlineMs !== undefined) {
    if (typeof b.deadlineMs !== "number" || !Number.isFinite(b.deadlineMs)) throw new RangeError("deadlineMs must be a number");
    out.deadlineMs = Math.max(MIN_DEADLINE_MS, Math.min(Math.floor(b.deadlineMs), MAX_DEADLINE_MS));
  }
  if (b.concurrency !== undefined) out.concurrency = int("concurrency", 1, 16);
  if (b.limit !== undefined) out.limit = int("limit", 1, 10_000);
  for (const k of ["retryFailed", "seed"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") throw new RangeError(`${k} must be a boolean`);
    out[k] = b[k] as boolean;
  }
  return out;
}

export interface HcRunRouteDeps {
  principal: () => Principal | null;
  run?: (o: HcRunOptions) => Promise<HcRunResult>;
  env?: Readonly<Record<string, string | undefined>>;
  claimSlot?: () => Promise<boolean>;
}

function errorResponse(e: unknown): Response {
  if (e instanceof HcTextNotConfiguredError) return jsonError(e.message, 503, { code: "not_configured" });
  if (e instanceof RangeError) return jsonError(e.message, 400, { code: "bad_request" });
  console.error(JSON.stringify({ level: "error", event: "hc_text.run_failed", error: (e as Error)?.message?.slice(0, 300) ?? String(e) }));
  return jsonError("The High Court text run could not start just now.", 502, { code: "hc_text_unavailable" });
}

export async function handleHcRunRequest(req: Request, deps: HcRunRouteDeps): Promise<Response> {
  const gate = ingestGate(req, deps.principal(), deps.env ?? process.env);
  if (!gate.ok) return jsonError(gate.message, gate.status, { code: gate.code });
  try {
    const body = parseHcRunBody(await req.json().catch(() => ({})));
    return Response.json(await (deps.run ?? runHcTextIngest)({ ...body }));
  } catch (e) {
    return errorResponse(e);
  }
}

async function defaultClaimSlot(): Promise<boolean> {
  const repo = hcRepo();
  await repo.ensureSchema(); // corpus_state may not exist yet
  return repo.claimStartSlot(CRON_SLOT_KEY, CRON_MIN_INTERVAL_S);
}

const isDevAuth =(vars: Readonly<Record<string, string | undefined>>) => ((vars.AUTH_MODE ?? "dev").trim().toLowerCase() || "dev") === "dev";

/**
 * GET — the Vercel cron entry (vercel.json, every 5 minutes). Nothing runs, and the database is not touched, unless
 * HC_TEXT_INGEST is on.
 * - With CRON_SECRET configured, only the scheduled service principal may start a run (403 otherwise).
 * - Without CRON_SECRET, only in AUTH_MODE=dev: an unauthenticated call is a throttled "kick" (one start per
 *   CRON_MIN_INTERVAL_S, claimed atomically in Postgres; extra calls answer 429). With sign-in enforced the cron gate
 *   answers 503 in production and anything but the service principal is refused here.
 */
export async function handleHcCronRun(deps: HcRunRouteDeps): Promise<Response> {
  const vars = deps.env ?? process.env;
  const p = deps.principal();
  const service = Boolean(p && p.source === "service" && p.roles.includes("service"));
  const secretConfigured = Boolean(vars.CRON_SECRET?.trim());
  if (!service && (secretConfigured || !isDevAuth(vars))) {
    return jsonError("Scheduled High Court text runs are only started by the cron service principal; use POST with the ingest token.", 403, { code: "service_only" });
  }
  const cfg = hcTextConfig(vars);
  if (!cfg.enabled) return Response.json({ stop: "disabled", notes: ["HC_TEXT_INGEST is off"] });
  try {
    if (!service) {
      const claimed = await (deps.claimSlot ?? defaultClaimSlot)();
      if (!claimed) return Response.json({ stop: "throttled", notes: [`a scheduled run started less than ${CRON_MIN_INTERVAL_S}s ago`] }, { status: 429, headers: { "retry-after": String(CRON_MIN_INTERVAL_S) } });
    }
    return Response.json(await (deps.run ?? runHcTextIngest)({ deadlineMs: CRON_DEADLINE_MS, concurrency: cfg.concurrency }));
  } catch (e) {
    return errorResponse(e);
  }
}
