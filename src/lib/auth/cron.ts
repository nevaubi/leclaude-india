/**
 * Cron-route precondition (the two scheduled entries in vercel.json: /api/intel/jobs/tick and GET /api/official/run).
 *
 * Vercel authenticates its cron calls only by sending `Authorization: Bearer $CRON_SECRET`, which resolves to the
 * service principal (src/lib/auth/principal.ts). On a production deployment that enforces sign-in, a missing
 * CRON_SECRET means every scheduled call would be anonymous; instead of silently failing (401) or running
 * unauthenticated work, the routes answer 503 with a message that names the fix.
 *
 * With AUTH_MODE=dev (the open demo mode) the existing behaviour is unchanged, including the throttled
 * unauthenticated kick of /api/official/run.
 */
import { jsonError } from "@/lib/ai/sse";

export type CronEnv = Readonly<Record<string, string | undefined>>;

function val(env: CronEnv, name: string): string | undefined {
  const v = env[name];
  return v == null || !v.trim() ? undefined : v.trim();
}

export const CRON_NOT_CONFIGURED_MESSAGE =
  "Scheduled jobs are disabled on this deployment: sign-in is enforced (AUTH_MODE) but CRON_SECRET is not set, so the scheduler cannot authenticate. Set CRON_SECRET in the project environment and redeploy.";

/** 503 Response when cron cannot authenticate on an enforced production deployment, otherwise null. */
export function cronPrecondition(env: CronEnv = process.env): Response | null {
  const mode = (val(env, "AUTH_MODE") ?? "dev").toLowerCase();
  const production = val(env, "VERCEL_ENV") === "production";
  if (production && mode !== "dev" && !val(env, "CRON_SECRET")) {
    console.error(JSON.stringify({ level: "error", event: "cron.not_configured", authMode: mode }));
    return jsonError(CRON_NOT_CONFIGURED_MESSAGE, 503, { code: "cron_not_configured" });
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => Response | Promise<Response>;

/** Wrap a cron route handler with `cronPrecondition` (outermost, before any database or auth work). */
export function withCronGate<H extends AnyHandler>(handler: H): H {
  const wrapped = async (...args: Parameters<H>): Promise<Response> => cronPrecondition() ?? handler(...args);
  return wrapped as unknown as H;
}
