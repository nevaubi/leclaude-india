import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { audit, listAudit, verifyAuditChain } from "@/lib/integrity/audit";
import { runScans, fixFinding, lastReport } from "@/lib/integrity/scans";
import { makeProvenance, isTrusted, trustLabel } from "@/lib/integrity/provenance";
import { contentHash, promptHash } from "@/lib/integrity/hash";
import { getProvenanceRecord, putProvenance } from "@/lib/integrity/store";
import { crossCheckCitations } from "@/lib/ai/verify";

beforeAll(() => { resetSqlite(); db(); });

describe("audit log", () => {
  it("chains hashes and verifies", () => {
    audit("ai.generate", { kind: "test", id: "t1", label: "first" });
    audit("ai.apply", { kind: "test", id: "t1", label: "second" });
    const events = listAudit({ targetKind: "test" });
    expect(events.length).toBe(2);
    expect(events[0].prevHash).toBe(events[1].hash);
    expect(verifyAuditChain().ok).toBe(true);
  });
});

describe("integrity scans", () => {
  it("runs all scans on the seeded database and can fix an orphan", () => {
    const d = db();
    d.tasks.put({ id: "t_orphan", title: "Orphan", status: "todo", priority: "low", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", matterId: "m_missing" });
    const report = runScans("manual");
    expect(report.results.length).toBeGreaterThanOrEqual(6);
    expect(report.results.every((r) => !r.error)).toBe(true);
    const orphan = report.results.flatMap((r) => r.findings).find((f) => f.target?.id === "t_orphan");
    expect(orphan?.fixable).toBe(true);
    expect(fixFinding(orphan!.id).ok).toBe(true);
    expect(d.tasks.get("t_orphan")?.matterId).toBeUndefined();
    expect(lastReport()?.results.flatMap((r) => r.findings).find((f) => f.id === orphan!.id)?.fixed).toBe(true);
  });
  it("links unlinked duplicate documents", () => {
    const d = db();
    const base = { matterId: "m_valsara_arb", date: "2020-01-01", custodianId: "c_ghale", custodianName: "Girish Hegde", type: "Email" as const, subject: "Dup", text: "Identical body text for duplicate detection.", coding: {} };
    d.edocs.put({ id: "ed_dup_a", bates: "MFC-DUP-0001", ...base });
    d.edocs.put({ id: "ed_dup_b", bates: "MFC-DUP-0002", ...base });
    const report = runScans("manual", ["duplicate-documents"]);
    const f = report.results[0].findings.find((x) => x.detail.includes("MFC-DUP-0001"));
    expect(f).toBeTruthy();
    expect(fixFinding(f!.id).ok).toBe(true);
    expect(d.edocs.get("ed_dup_b")?.isDuplicateOf ?? d.edocs.get("ed_dup_a")?.isDuplicateOf).toBeTruthy();
  });
});

describe("ai provenance scan", () => {
  it("flags orphaned sidecars, ungated contradicted output and stale pending reviews, and fixes what it can", () => {
    const d = db();
    const ev = d.timeline.list({ limit: 1 })[0];
    expect(ev).toBeTruthy();
    const src = [{ kind: "document" as const, cite: "MFC-0041877" }];
    putProvenance({ kind: "timeline.event", recordId: "tl_ghost_scan", title: "ghost event", provenance: makeProvenance({ surface: "test", sources: src, confidence: 0.9 }) });
    putProvenance({ kind: "timeline.event", recordId: ev.id, matterId: ev.matterId, title: ev.title, provenance: { ...makeProvenance({ surface: "test", sources: src, confidence: 0.9 }), verification: { status: "contradicted", checkedAt: new Date().toISOString(), method: "claims", supported: 0, unsupported: 0, contradicted: 2 } } });
    const run = d.collection<{ id: string }>("search_runs").list({ limit: 1 })[0];
    expect(run).toBeTruthy();
    putProvenance({ kind: "research", recordId: run.id, title: "old answer", provenance: { ...makeProvenance({ surface: "research", sources: src, confidence: 0.3 }), generatedAt: new Date(Date.now() - 30 * 86400000).toISOString() } });

    const report = runScans("manual", ["ai-provenance"]);
    const findings = report.results[0].findings;
    expect(report.results[0].error).toBeUndefined();
    const ghost = findings.find((f) => f.target?.id === "timeline.event:tl_ghost_scan");
    const contradicted = findings.find((f) => f.target?.id === `timeline.event:${ev.id}`);
    const stale = findings.find((f) => f.target?.id === `research:${run.id}`);
    expect(ghost?.severity).toBe("low");
    expect(contradicted?.severity).toBe("high");
    expect(stale?.title).toMatch(/awaiting review for \d+ days/);
    expect(findings.some((f) => /hash chain/.test(f.title))).toBe(false);

    expect(fixFinding(ghost!.id).ok).toBe(true);
    expect(getProvenanceRecord("timeline.event", "tl_ghost_scan")).toBeNull();
    expect(fixFinding(contradicted!.id).ok).toBe(true);
    expect(getProvenanceRecord("timeline.event", ev.id)?.provenance.review).toEqual({ status: "pending", note: "Contradicted by sources" });
    expect(runScans("manual", ["ai-provenance"]).results[0].findings.find((f) => f.target?.id === `timeline.event:${ev.id}` && f.severity === "high")).toBeUndefined();
    expect(listAudit({ action: "ai.verify", targetId: ev.id })[0]?.meta?.decision).toBe("gated");
  });
});

describe("record cite cross-check", () => {
  it("does not mistake clock times for page:line cites", () => {
    const c = crossCheckCitations("The call at 10:30 a.m. and the 2:15 PM meeting are noted at 24:05 and 31:2–31:9.", { pages: [24] });
    expect(c.cites).toEqual(["24:5", "31:2", "31:9"]);
    expect(c.unresolved).toEqual(["31:2", "31:9"]);
    expect(c.text).toContain("10:30 a.m. and the 2:15 PM meeting");
    expect(c.text).toContain("31:2–31:9 [VERIFY]");
  });
});

describe("provenance", () => {
  it("gates low confidence and labels trust", () => {
    const low = makeProvenance({ surface: "test", confidence: 0.3, sources: [{ kind: "document", cite: "MFC-1" }] });
    expect(low.review?.status).toBe("pending");
    expect(isTrusted(low)).toBe(false);
    expect(trustLabel(low).label).toBe("Needs review");
    const ok = makeProvenance({ surface: "test", confidence: 0.9, sources: [{ kind: "document", cite: "MFC-1" }] });
    expect(isTrusted(ok)).toBe(true);
    expect(trustLabel({ ...ok, verification: { status: "contradicted", checkedAt: "", method: "claims", supported: 1, unsupported: 0, contradicted: 1 } }).tone).toBe("destructive");
    expect(isTrusted(makeProvenance({ surface: "test" }))).toBe(false);
  });
  it("hashes content and prompts stably", () => {
    expect(contentHash("Hello   World")).toBe(contentHash("hello world"));
    expect(promptHash("a", { b: 1 })).toHaveLength(16);
  });
});
