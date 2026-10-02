import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/intel-vitest-steward-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
});

import { z } from "zod";
import { memoryHttpCache } from "@/lib/ai/toolkit/http";
import { db, resetSqlite } from "@/lib/db";
import { listAudit } from "@/lib/integrity/audit";
import { runScans, fixFinding, listScans } from "@/lib/integrity/bootstrap";
import { listReviewQueue } from "@/lib/integrity/review";
import { getProvenanceRecord } from "@/lib/integrity/store";
import { makeProvenance } from "@/lib/integrity/provenance";
import { defineAdapter, registerAdapter } from "@/modules/intel/adapters";
import { claimJob, enqueueJob, executeJob, getJob, listJobs } from "@/modules/intel/jobs";
import { createProviders, ProviderError, type IntelProviders } from "@/modules/intel/providers";
import { createSource, updateSource } from "@/modules/intel/service";
import { flagDocument, hasFlag, ingestDocument, intelDocuments, intelEntities, intelInsights, intelSources, upsertEntity } from "@/modules/intel/store";
import { classifyError, deterministicFix, DISABLE_AFTER_FAILURES, escalate, findContradictions, FIX_ALLOWLIST, narrowedConfig, reviewJob, staleDocuments, sweep, verifyInsights } from "@/modules/intel/steward";
import type { IntelJob } from "@/modules/intel/types";

beforeAll(() => {
  resetSqlite(); db();
  for (const s of intelSources().all()) updateSource(s.id, { enabled: false });
});

let mode: "network" | "ok" | "parse" = "network";
registerAdapter(defineAdapter({
  id: "web-list", name: "fake", description: "t", kinds: ["web_page"], family: "web", requires: [],
  configSchema: z.object({ prefer: z.string().optional(), maxResults: z.number().optional() }), defaults: {},
  async run(ctx) {
    if (mode === "network") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    if (mode === "parse") throw new ProviderError("web", "parse", "web: no readable text", false);
    await ctx.ingest({ kind: "web_page", title: `ok ${ctx.config.prefer ?? "auto"}`, dates: {}, externalId: `ok:${ctx.source.id}`, text: "Recovered page text. ".repeat(30) });
  },
}));

const providers = (overrides: Partial<{ firecrawl: boolean }> = {}): IntelProviders => {
  const p = createProviders({ cache: memoryHttpCache(), offline: true, sleep: async () => {}, env: { FIRECRAWL_API_KEY: overrides.firecrawl ? "fc" : undefined } });
  return p;
};

function job(over: Partial<IntelJob> = {}): IntelJob {
  const ts = new Date().toISOString();
  return { id: "ijob_test", kind: "source.run", payload: {}, status: "failed", priority: 5, attempts: 3, maxAttempts: 3, log: [], fixes: [], createdAt: ts, updatedAt: ts, ...over };
}

describe("classifyError", () => {
  it("maps structured codes, provider errors and messages", () => {
    expect(classifyError({ code: "rate_limited", message: "x" })).toBe("rate_limited");
    expect(classifyError({ code: "unknown", message: "HTTP 429 Too Many Requests" })).toBe("rate_limited");
    expect(classifyError(new ProviderError("t", "http", "HTTP 503", true, 503))).toBe("network");
    expect(classifyError(new Error("FIRECRAWL_API_KEY is not configured"))).toBe("not_configured");
    expect(classifyError("search response has no results array (schema drift?)")).toBe("schema_drift");
    expect(classifyError(new Error("request timed out"))).toBe("timeout");
    expect(classifyError(new Error("Unexpected token < in JSON at position 0"))).toBe("parse");
    expect(classifyError(new Error("fetch failed"))).toBe("network");
    expect(classifyError(new Error("run produced no results (empty)"))).toBe("empty");
    expect(classifyError(new Error("duplicate record"))).toBe("duplicate");
    expect(classifyError(new Error("Run cancelled"))).toBe("cancelled");
    expect(classifyError(new Error("something odd"))).toBe("unknown");
  });
});

describe("deterministic fixes", () => {
  const src = () => intelSources().all()[0];
  it("picks allow-listed actions per error code and disables after repeated failures", () => {
    for (const code of ["rate_limited", "timeout", "network", "not_configured", "parse", "schema_drift", "empty", "low_confidence", "duplicate", "cancelled", "unknown"] as const) {
      const d = deterministicFix(job(), src(), code);
      if (d) expect(FIX_ALLOWLIST).toContain(d.action);
    }
    expect(deterministicFix(job(), src(), "rate_limited")).toMatchObject({ action: "backoff", delayMs: 15 * 60_000 });
    expect(deterministicFix(job({ error: { code: "rate_limited", message: "429", retryAfterMs: 5000 } as unknown as IntelJob["error"] }), src(), "rate_limited")).toMatchObject({ action: "backoff", delayMs: 5000 });
    expect(deterministicFix(job(), src(), "network")).toMatchObject({ action: "retry" });
    expect(deterministicFix(job({ fixes: [{ at: "x", action: "retry", by: "steward", note: "" }] }), src(), "network")).toMatchObject({ action: "backoff" });
    expect(deterministicFix(job(), src(), "timeout")).toMatchObject({ action: "narrow_query" });
    expect(deterministicFix(job(), src(), "not_configured")).toMatchObject({ action: "flag" });
    expect(deterministicFix(job(), src(), "empty")).toMatchObject({ action: "none" });
    expect(deterministicFix(job(), src(), "duplicate")).toMatchObject({ action: "quarantine" });
    expect(deterministicFix(job({ fixes: [{ at: "x", action: "retry", by: "steward", note: "" }] }), src(), "unknown")).toBeNull();
    const failing = { ...src(), health: { ok: false, consecutiveFailures: DISABLE_AFTER_FAILURES } };
    expect(deterministicFix(job(), failing, "network")).toMatchObject({ action: "disable_source" });
    const web = { ...src(), adapter: "web-list" as const, config: { prefer: "auto" } };
    expect(deterministicFix(job(), web, "parse", { firecrawlConfigured: true })).toMatchObject({ action: "switch_provider", configOverride: { prefer: "firecrawl" } });
    expect(deterministicFix(job(), web, "schema_drift", { firecrawlConfigured: false })).toBeNull();
    expect(narrowedConfig({ maxResults: 20, sinceDays: 30, maxTextChars: 80_000, other: 1 })).toEqual({ maxResults: 10, sinceDays: 15, maxTextChars: 40_000 });
  });
});

describe("reviewJob: fix, re-run once, escalate", () => {
  it("retries a network failure once through a re-run job, then escalates to the review queue with provenance and audit when the re-run fails", async () => {
    mode = "network";
    const src = createSource({ adapter: "web-list", name: "steward src", config: {}, schedule: { every: "manual" } });
    const first = enqueueJob({ kind: "source.run", sourceId: src.id, maxAttempts: 1, payload: { force: true } });
    const reviewed = await executeJob(claimJob(first.id, "w")!, { providers: providers() });
    expect(reviewed.status).toBe("fixed");
    expect(reviewed.fixes.at(-1)).toMatchObject({ action: "retry", by: "steward" });
    const rerun = listJobs({ sourceId: src.id, status: ["queued"] }).items[0];
    expect(rerun).toBeTruthy();
    expect(rerun.payload).toMatchObject({ rerunOf: first.id, fix: "retry" });
    expect(rerun.priority).toBe(2);
    expect(new Date(rerun.runAfter!).getTime()).toBeGreaterThan(Date.now());
    expect(listAudit({ action: "scan.fix", targetKind: "intel.job" }).some((e) => e.target.id === first.id)).toBe(true);
    // The re-run fails again → escalation (no second fix).
    const claimed = claimJob(rerun.id, "w", new Date(Date.now() + 10 * 60_000))!;
    const escalated = await executeJob(claimed, { providers: providers() });
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalation?.reason).toMatch(/Re-run after "retry" failed again \(network/);
    expect(escalated.escalation?.reviewId).toBe(`intel.job:${rerun.id}`);
    const rec = getProvenanceRecord("intel.job", rerun.id)!;
    expect(rec.provenance.review?.status).toBe("pending");
    expect(rec.provenance.surface).toBe("intel.steward");
    expect(rec.href).toContain(rerun.id);
    expect(listReviewQueue({ kind: "intel.job" }).some((r) => r.id === rerun.id)).toBe(true);
    const audit = listAudit({ action: "ai.verify", targetKind: "intel.job", targetId: rerun.id })[0];
    expect(audit?.meta).toMatchObject({ decision: "escalated" });
    expect(intelSources().get(src.id)!.health.lastError).toMatch(/^Escalated/);
  });
  it("switches provider for parse failures when Firecrawl is configured and the re-run succeeds", async () => {
    mode = "parse";
    const src = createSource({ adapter: "web-list", name: "parse src", config: { prefer: "auto" }, schedule: { every: "manual" } });
    const first = enqueueJob({ kind: "source.run", sourceId: src.id, maxAttempts: 1, payload: { force: true } });
    const fixed = await executeJob(claimJob(first.id, "w")!, { providers: providers({ firecrawl: true }) });
    expect(fixed.status).toBe("fixed");
    expect(fixed.fixes.at(-1)).toMatchObject({ action: "switch_provider" });
    const rerun = listJobs({ sourceId: src.id, status: ["queued"] }).items[0];
    expect(rerun.payload.configOverride).toEqual({ prefer: "firecrawl" });
    mode = "ok";
    const done = await executeJob(claimJob(rerun.id, "w")!, { providers: providers({ firecrawl: true }) });
    expect(done.status).toBe("succeeded");
    expect(intelDocuments().findOne((d) => d.sourceId === src.id)?.title).toBe("ok firecrawl");
    expect(intelSources().get(src.id)!.health.ok).toBe(true);
  });
  it("disables a source after repeated failures and escalates when nothing applies", async () => {
    mode = "network";
    const src = createSource({ adapter: "web-list", name: "flaky", config: {}, schedule: { every: "1h" } });
    intelSources().update(src.id, (s) => ({ ...s, health: { ok: false, consecutiveFailures: DISABLE_AFTER_FAILURES - 1 } }));
    const j = enqueueJob({ kind: "source.run", sourceId: src.id, maxAttempts: 1, payload: { force: true } });
    const done = await executeJob(claimJob(j.id, "w")!, { providers: providers() });
    expect(done.fixes.at(-1)?.action).toBe("disable_source");
    expect(done.status).toBe("failed");
    const s = intelSources().get(src.id)!;
    expect(s.enabled).toBe(false);
    expect(s.status).toBe("disabled");
    expect(s.nextRunAt).toBeUndefined();
    const healthy = createSource({ adapter: "web-list", name: "odd", config: {}, schedule: { every: "manual" } });
    const lone = enqueueJob({ kind: "source.run", sourceId: healthy.id, maxAttempts: 1 });
    claimJob(lone.id, "w");
    intelJobs_fail(lone.id, "unknown", "something odd", [{ at: "x", action: "retry", by: "steward", note: "already" }]);
    const r = await reviewJob(lone.id, { providers: providers(), model: false });
    expect(r?.status).toBe("escalated");
    expect(r?.escalation?.reason).toMatch(/No applicable automatic fix/);
    expect(escalate(job({ id: lone.id }), "manual").status).toBe("escalated");
  });
});

function intelJobs_fail(id: string, code: string, message: string, fixes: IntelJob["fixes"]) {
  const col = db().collection<IntelJob>("intel_jobs");
  col.update(id, (j) => ({ ...j, status: "failed", error: { code: code as IntelJob["error"] extends infer E ? (E extends { code: infer C } ? C : never) : never, message }, fixes }));
}

describe("sweep", () => {
  it("flags stale documents, contradictions, broken links and orphaned entities; verification is skipped without a key", async () => {
    const enabled = createSource({ adapter: "web-list", name: "sweep src A", config: {}, schedule: { every: "daily", at: "06:00" } });
    const other = createSource({ adapter: "court-rules", name: "sweep src B", config: {}, schedule: { every: "daily", at: "06:00" } });
    const old = new Date(Date.now() - 400 * 86400_000);
    const a = await ingestDocument({ sourceId: enabled.id, adapter: "web-list", kind: "docket", title: "Depo-Provera docket (A)", docketNumber: "3:25-md-03140", dates: { filed: "2018-12-07" }, externalId: "sw:a", text: "Docket A text. ".repeat(20), url: "https://example.test/gone" }, { embed: false, now: old });
    const b = await ingestDocument({ sourceId: other.id, adapter: "court-rules", kind: "docket", title: "Depo-Provera docket (B)", docketNumber: "3:25-MD-3140", dates: { filed: "2018-12-08" }, externalId: "sw:b", text: "Docket B text. ".repeat(20), url: "https://example.test/ok" }, { embed: false });
    intelDocuments().update(a.doc.id, (d) => ({ ...d, fetchedAt: old.toISOString() }));
    expect(staleDocuments(new Date()).map((d) => d.id)).toContain(a.doc.id);
    expect(findContradictions([a.doc, intelDocuments().get(b.doc.id)!])).toHaveLength(1);
    upsertEntity({ id: "ient_orphan", type: "party", name: "Ghost Corp", docId: "idoc_missing_1" });
    const p = providers();
    p.web.probe = async (url) => ({ status: url.endsWith("/gone") ? 404 : 200, ok: !url.endsWith("/gone"), finalUrl: url });
    const report = await sweep({ providers: p, network: true, urlChecks: 5, sampleSize: 2 });
    expect(report.staleFlagged).toBeGreaterThanOrEqual(1);
    expect(report.contradictions).toBeGreaterThanOrEqual(1);
    expect(report.brokenLinks).toBeGreaterThanOrEqual(1);
    expect(report.orphanedEntities).toBe(1);
    const A = intelDocuments().get(a.doc.id)!;
    expect(hasFlag(A, "stale")).toBe(true);
    expect(hasFlag(A, "contradicted")).toBe(true);
    expect(hasFlag(A, "broken_link")).toBe(true);
    expect(hasFlag(intelDocuments().get(b.doc.id)!, "contradicted")).toBe(true);
    expect(intelEntities().get("ient_orphan")!.flags?.some((f) => f.kind === "needs_review")).toBe(true);
    expect(db().kv.get("intel:last-sweep")).toMatchObject({ at: report.at });
    // A refreshed document loses its stale flag on the next sweep.
    intelDocuments().update(a.doc.id, (d) => ({ ...d, fetchedAt: new Date().toISOString() }));
    await sweep({ providers: p, network: false });
    expect(hasFlag(intelDocuments().get(a.doc.id)!, "stale")).toBe(false);
    intelInsights().put({ id: "iins_test", kind: "alert", scope: { entityIds: [] }, title: "MDL created", summary: "The JPML created MDL No. 3140.", data: {}, evidence: [{ docId: "idoc_seed_news_jpml_depo" }], provenance: makeProvenance({ surface: "test", confidence: 0.9 }), confidence: 0.9, status: "verified", flags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    // Target the test insight by id: the analysis seed also stores its own insights, which would widen the candidate set.
    const v = await verifyInsights({ insightIds: ["iins_test"] });
    expect(v).toMatchObject({ checked: 0, skipped: 1, reason: "no_api_key" });
  });
});

describe("intel integrity scans", () => {
  it("registers the four intel scans through the bootstrap and fixes findings", () => {
    const ids = listScans().map((s) => s.id);
    for (const id of ["intel-sources", "intel-jobs", "intel-documents", "intel-freshness"]) expect(ids).toContain(id);
    const src = createSource({ adapter: "web-list", name: "scan src", config: {}, schedule: { every: "manual" } });
    intelDocuments().put({ id: "idoc_scan_low", sourceId: src.id, adapter: "web-list", kind: "web_page", title: "Low confidence page", judgeIds: [], attorneyIds: [], firmIds: [], partyIds: [], productIds: [], agencies: [], dates: {}, hash: "h1", textLength: 100, chunkCount: 0, matterIds: [], tags: [], flags: [], confidence: 0.2, fetchedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const stale = intelDocuments().find((d) => hasFlag(d, "stale"))[0];
    if (stale) flagDocument(stale.id, { kind: "stale", by: "test" });
    const report = runScans("manual", ["intel-sources", "intel-jobs", "intel-documents", "intel-freshness"]);
    expect(report.results.every((r) => !r.error), report.results.filter((r) => r.error).map((r) => `${r.scanId}: ${r.error}`).join("; ")).toBe(true);
    const docFindings = report.results.find((r) => r.scanId === "intel-documents")!.findings;
    const low = docFindings.find((f) => f.target?.id === "idoc_scan_low" && /without a flag/.test(f.title))!;
    expect(low.fixable).toBe(true);
    expect(fixFinding(low.id).ok).toBe(true);
    expect(hasFlag(intelDocuments().get("idoc_scan_low")!, "low_confidence")).toBe(true);
    const escalatedFinding = report.results.find((r) => r.scanId === "intel-jobs")!.findings.find((f) => /Escalated job/.test(f.title));
    expect(escalatedFinding).toBeTruthy();
    const sourceFindings = report.results.find((r) => r.scanId === "intel-sources")!.findings;
    expect(sourceFindings.some((f) => /failed \d+ times/.test(f.title))).toBe(true);
    expect(getJob("ijob_test")).toBeNull();
  });
});
