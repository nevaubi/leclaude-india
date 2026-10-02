import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/auth-cron-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  for (const k of ["AUTH_MODE", "AUTH_JWT_SECRET", "CRON_SECRET", "VERCEL_ENV", "OFFICIAL_INGEST", "LECLAUDE_USER_ID"]) delete process.env[k];
});

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { cronPrecondition, CRON_NOT_CONFIGURED_MESSAGE } from "@/lib/auth/cron";
import { GET as tickGET, POST as tickPOST } from "@/app/api/intel/jobs/tick/route";
import { GET as officialGET } from "@/app/api/official/run/route";
import { handleCronRun } from "@/app/api/official/run/handler";
import { servicePrincipal } from "@/lib/auth/principal";

// Test-only values.
const CRON = "test-cron-secret-123";
const TICK = "/api/intel/jobs/tick?limit=1&housekeeping=0&deadlineMs=1000&news=0&corpus=0&official=0";
const nreq = (path: string, headers: Record<string, string> = {}, method = "GET") => new NextRequest(`http://localhost${path}`, { method, headers });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

beforeAll(() => { resetSqlite(); db(); });
afterEach(() => { for (const k of ["AUTH_MODE", "AUTH_JWT_SECRET", "CRON_SECRET", "VERCEL_ENV", "OFFICIAL_INGEST"]) delete process.env[k]; });

describe("cronPrecondition", () => {
  it("refuses (503) only on an enforced production deployment without CRON_SECRET", async () => {
    const r = cronPrecondition({ VERCEL_ENV: "production", AUTH_MODE: "jwt" });
    expect(r?.status).toBe(503);
    expect(await r!.json()).toEqual({ error: CRON_NOT_CONFIGURED_MESSAGE, code: "cron_not_configured" });
    expect(cronPrecondition({ VERCEL_ENV: "production", AUTH_MODE: "jwt", CRON_SECRET: CRON })).toBeNull();
    expect(cronPrecondition({ VERCEL_ENV: "preview", AUTH_MODE: "jwt" })).toBeNull();
    expect(cronPrecondition({ VERCEL_ENV: "production" })).toBeNull(); // dev mode: unchanged behaviour
    expect(cronPrecondition({ VERCEL_ENV: "production", AUTH_MODE: "header" })?.status).toBe(503);
  });
});

describe("/api/intel/jobs/tick", () => {
  it("answers 503 cron_not_configured in production with AUTH_MODE=jwt and no CRON_SECRET, before any work", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.AUTH_MODE = "jwt";
    for (const h of [tickGET, tickPOST]) {
      const r = await json(await h(nreq(TICK, { authorization: "Bearer whatever" })));
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("cron_not_configured");
    }
  });

  it("with CRON_SECRET, runs only for the bearer (service principal) — 401 otherwise, in jwt and dev mode", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.AUTH_MODE = "jwt";
    process.env.CRON_SECRET = CRON;
    expect((await tickGET(nreq(TICK))).status).toBe(401);
    expect((await tickGET(nreq(TICK, { authorization: "Bearer wrong-secret" }))).status).toBe(401);
    expect((await tickGET(nreq(TICK, { authorization: `Bearer ${CRON}` }))).status).toBe(200);
    delete process.env.AUTH_MODE;
    expect((await tickGET(nreq(TICK))).status).toBe(401);
  });
});

describe("GET /api/official/run (cron)", () => {
  it("answers 503 cron_not_configured in production with AUTH_MODE=jwt and no CRON_SECRET", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.AUTH_MODE = "jwt";
    process.env.OFFICIAL_INGEST = "1";
    const r = await json(await officialGET(nreq("/api/official/run")));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("cron_not_configured");
  });

  it("with CRON_SECRET, only the service principal starts a run: anonymous 401 (jwt), signed-in non-service 403", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.AUTH_MODE = "jwt";
    process.env.CRON_SECRET = CRON;
    expect((await officialGET(nreq("/api/official/run"))).status).toBe(401);
    // Dev mode resolves the demo persona; the handler still refuses anyone but the service principal.
    delete process.env.AUTH_MODE;
    process.env.OFFICIAL_INGEST = "1";
    const denied = await json(await officialGET(nreq("/api/official/run")));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("service_only");
    // The bearer resolves to the service principal; with ingest off nothing runs.
    delete process.env.OFFICIAL_INGEST;
    const ok = await json(await officialGET(nreq("/api/official/run", { authorization: `Bearer ${CRON}` })));
    expect(ok.status).toBe(200);
    expect(ok.body.stop).toBe("disabled");
  });

  it("with CRON_SECRET the service principal runs, and without it a dev-mode kick is throttled (unchanged)", async () => {
    let runs = 0;
    const run = async () => { runs++; return { stop: "done" } as never; };
    const svc = await handleCronRun({ principal: () => servicePrincipal(), env: { CRON_SECRET: CRON, OFFICIAL_INGEST: "1" }, run });
    expect(svc.status).toBe(200);
    const anonymousWithSecret = await handleCronRun({ principal: () => null, env: { CRON_SECRET: CRON, OFFICIAL_INGEST: "1" }, run });
    expect(anonymousWithSecret.status).toBe(403);
    const kick = await handleCronRun({ principal: () => null, env: { OFFICIAL_INGEST: "1" }, run, claimSlot: async () => false });
    expect(kick.status).toBe(429);
    expect(runs).toBe(1);
  });
});
