import { describe, expect, it } from "vitest";
import type { ReviewQueueItem } from "@/lib/integrity/types";
import { decisionBody, groupQueueByKind, isEndpointMissing, kindLabel, queueReason, summarizeByMatter } from "@/modules/ediscovery/components/review-queue-helpers";
import { provenanceOf } from "@/modules/ediscovery/components/provenance-of";
import { deadlineChip, deadlineLabel } from "@/modules/ediscovery/components/matter-header-helpers";
import { CODING_COLUMN_MIN_WIDTH, codingColumnWidth } from "@/modules/ediscovery/components/viewer-layout";
import { artifactProvenance, outputWithoutProvenance, stepDotTone, stepProvenance, stepSummary } from "@/modules/workflows/components/run/timeline-helpers";

const item = (over: Partial<ReviewQueueItem> = {}): ReviewQueueItem => ({
  kind: "timeline.event", id: "tl_1", title: "Board briefed on MC-8 persistence", matterId: "m_vls", surface: "ediscovery.timeline", confidence: 0.4,
  generatedAt: "2026-09-20T10:00:00Z", model: "gpt-5.4", sources: 2, review: { status: "pending", note: "Below confidence gate" }, ...over,
});

describe("review queue helpers", () => {
  it("groups by kind with privilege entries first and newest rows first", () => {
    const rows = [
      item({ kind: "timeline.event", id: "a", generatedAt: "2026-09-01T00:00:00Z" }),
      item({ kind: "privilege.entry", id: "b", generatedAt: "2026-09-02T00:00:00Z" }),
      item({ kind: "timeline.event", id: "c", generatedAt: "2026-09-03T00:00:00Z" }),
    ];
    const g = groupQueueByKind(rows);
    expect(g.map((x) => x.kind)).toEqual(["privilege.entry", "timeline.event"]);
    expect(g[1].items.map((x) => x.id)).toEqual(["c", "a"]);
    expect(g[0].label).toBe("Privilege log entry");
    expect(kindLabel("something.new")).toBe("something new");
  });
  it("explains why a row is queued", () => {
    expect(queueReason(item())).toBe("Below confidence gate");
    expect(queueReason(item({ review: { status: "pending" }, verification: { status: "contradicted", checkedAt: "", method: "claims", supported: 1, unsupported: 0, contradicted: 2 } }))).toBe("2 claims contradicted by the sources");
    expect(queueReason(item({ review: { status: "pending" }, verification: { status: "partially-verified", checkedAt: "", method: "claims", supported: 3, unsupported: 1, contradicted: 0 } }))).toBe("1 unsupported claim");
    expect(queueReason(item({ review: { status: "pending" }, confidence: 0.3 }))).toBe("confidence 30% is below the gate");
    expect(queueReason(item({ review: { status: "pending" }, confidence: undefined, sources: 0 }))).toBe("not source-backed");
    expect(queueReason(item({ review: { status: "pending" }, confidence: undefined, sources: 3 }))).toBe("awaiting human review");
  });
  it("builds the decision body with both `status` and `decision` and trims notes", () => {
    expect(decisionBody(item(), "approved", "  looks right ")).toEqual({ id: "tl_1", kind: "timeline.event", status: "approved", decision: "approved", note: "looks right" });
    expect(decisionBody(item(), "rejected", "   ")).toEqual({ id: "tl_1", kind: "timeline.event", status: "rejected", decision: "rejected" });
  });
  it("detects a missing endpoint but not a real error", () => {
    expect(isEndpointMissing({ status: 404 })).toBe(true);
    expect(isEndpointMissing({ status: 405 })).toBe(true);
    expect(isEndpointMissing({ status: 500 })).toBe(false);
    expect(isEndpointMissing(new TypeError("Failed to fetch"))).toBe(true);
    expect(isEndpointMissing(new Error("boom"))).toBe(false);
    expect(isEndpointMissing(null)).toBe(false);
  });
  it("summarises pending rows by matter, busiest first", () => {
    const rows = [item({ matterId: "m1" }), item({ matterId: "m2", id: "x" }), item({ matterId: "m1", id: "y", kind: "conflict" }), item({ matterId: undefined, id: "z", kind: "home.brief" })];
    const s = summarizeByMatter(rows, (id) => ({ m1: "Valsara v. Meridian", m2: "Northgate" } as Record<string, string>)[id ?? ""]);
    expect(s[0]).toMatchObject({ matterId: "m1", matterName: "Valsara v. Meridian", pending: 2, kinds: ["Conflict", "Timeline event"] });
    expect(s[1]).toMatchObject({ matterId: "m2", matterName: "Northgate", pending: 1 });
    expect(s[2]).toMatchObject({ matterId: undefined, matterName: "Firm-wide", pending: 1 });
  });
});

describe("provenanceOf (defensive rendering)", () => {
  const prov = { model: "gpt-5.4", generatedAt: "2026-09-20T10:00:00Z", sources: [], surface: "x" };
  it("reads provenance or aiProvenance when well-formed", () => {
    expect(provenanceOf({ provenance: prov })).toBe(prov);
    expect(provenanceOf({ aiProvenance: prov })).toBe(prov);
  });
  it("returns undefined for records without a usable provenance field", () => {
    expect(provenanceOf(undefined)).toBeUndefined();
    expect(provenanceOf({})).toBeUndefined();
    expect(provenanceOf({ provenance: null })).toBeUndefined();
    expect(provenanceOf({ provenance: { model: "x" } })).toBeUndefined();
    expect(provenanceOf("nope")).toBeUndefined();
  });
});

describe("matter header deadline helpers", () => {
  it("labels and tones a production deadline by urgency", () => {
    expect(deadlineLabel(-3)).toEqual({ label: "3d overdue", tone: "destructive" });
    expect(deadlineLabel(0)).toEqual({ label: "due today", tone: "destructive" });
    expect(deadlineLabel(5)).toEqual({ label: "in 5d", tone: "destructive" });
    expect(deadlineLabel(20)).toEqual({ label: "in 20d", tone: "warning" });
    expect(deadlineLabel(45)).toEqual({ label: "in 6 wk", tone: "outline" });
    expect(deadlineLabel(120)).toEqual({ label: "in 4 mo", tone: "outline" });
    expect(deadlineChip(-1).tone).toBe("danger");
    expect(deadlineChip(40)).toEqual({ tone: "quiet", label: "40d" });
  });
});

describe("viewer coding column", () => {
  it("is a fixed column from 560px and narrows in tight viewers", () => {
    expect(CODING_COLUMN_MIN_WIDTH).toBe(560);
    expect(codingColumnWidth(0)).toBe(272);
    expect(codingColumnWidth(600)).toBe(240);
    expect(codingColumnWidth(900)).toBe(272);
  });
});

describe("run timeline helpers", () => {
  it("maps step status to a quiet dot", () => {
    expect(stepDotTone("running")).toEqual({ tone: "info", pulse: true, label: "Running" });
    expect(stepDotTone("succeeded").tone).toBe("success");
    expect(stepDotTone("failed").tone).toBe("destructive");
    expect(stepDotTone("waiting_approval")).toMatchObject({ tone: "warning", pulse: true });
    expect(stepDotTone("skipped").tone).toBe("muted");
    expect(stepDotTone("pending")).toMatchObject({ tone: "muted", pulse: false });
  });
  it("summarises steps for the header line", () => {
    expect(stepSummary([{ status: "succeeded" }, { status: "succeeded" }, { status: "failed" }, { status: "waiting_approval" }])).toBe("2 of 4 done · 1 failed · 1 awaiting approval");
    expect(stepSummary([])).toBe("0 of 0 done");
  });
  it("finds artifact provenance at the top level or under meta, and ignores junk", () => {
    const prov = { model: "gpt-5.4", generatedAt: "2026-09-20T10:00:00Z", sources: [{ kind: "document" as const, cite: "MFC-0041877" }], surface: "workflow" };
    expect(artifactProvenance({ kind: "document", id: "d1", title: "Memo", nodeId: "n1", meta: { provenance: prov } })).toBe(prov);
    expect(artifactProvenance({ kind: "document", id: "d1", title: "Memo", nodeId: "n1", provenance: prov })).toBe(prov);
    expect(artifactProvenance({ kind: "task", id: "t1", title: "Task", nodeId: "n1", meta: { provenance: { model: 1 } } })).toBeUndefined();
    expect(artifactProvenance({ kind: "task", id: "t1", title: "Task", nodeId: "n1" })).toBeUndefined();
  });
  it("reads step provenance where the executors put it: output._provenance (AI steps), output.provenance (verify steps), or the step itself", () => {
    const prov = { model: "gpt-5.4", generatedAt: "2026-09-20T10:00:00Z", sources: [{ kind: "case-law" as const, cite: "Daubert v. Merrell Dow, 509 U.S. 579" }], surface: "workflow", confidence: 0.8 };
    expect(stepProvenance({ output: { text: "memo", _provenance: prov } })).toBe(prov);
    expect(stepProvenance({ output: { status: "verified", trusted: true, provenance: prov } })).toBe(prov);
    expect(stepProvenance({ provenance: prov, output: { text: "x" } })).toBe(prov);
    expect(stepProvenance({ meta: { provenance: prov } })).toBe(prov);
    expect(stepProvenance({ output: { text: "no provenance here" } })).toBeUndefined();
    expect(stepProvenance({ output: "plain string" })).toBeUndefined();
    expect(stepProvenance({ output: { provenance: "not an object" } })).toBeUndefined();
    expect(stepProvenance(undefined)).toBeUndefined();
  });
  it("strips only real provenance blobs from an output before it is shown as JSON", () => {
    const prov = { model: "gpt-5.4", generatedAt: "2026-09-20T10:00:00Z", sources: [], surface: "workflow" };
    expect(outputWithoutProvenance({ text: "memo", citations: [], _provenance: prov })).toEqual({ text: "memo", citations: [] });
    expect(outputWithoutProvenance({ status: "verified", provenance: prov, trusted: true })).toEqual({ status: "verified", trusted: true });
    const domain = { title: "Deed", provenance: "Recorded 1998, Book 12 Page 4" };
    expect(outputWithoutProvenance(domain)).toBe(domain);
    expect(outputWithoutProvenance("text")).toBe("text");
    expect(outputWithoutProvenance(null)).toBeNull();
    const arr = [1, 2];
    expect(outputWithoutProvenance(arr)).toBe(arr);
  });
});
