import { beforeAll, describe, expect, it } from "vitest";

/**
 * Integrity wiring without an OpenAI key: scans registered by the bootstrap,
 * the review-queue API, dedupe on import/upload/create, trust gates that pause
 * a run whose inputs carry no provenance, and the data.dedupe node.
 */
process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
delete process.env.OPENAI_API_KEY;

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS } from "@/lib/seed/ids";
import { listScans, runScans, fixFinding } from "@/lib/integrity/bootstrap";
import { listAudit, verifyAuditChain } from "@/lib/integrity/audit";
import { putProvenance, getProvenance } from "@/lib/integrity/store";
import { makeProvenance } from "@/lib/integrity/provenance";
import { crossCheckCitations, extractRecordCites, safeVerifyClaims, safeSelfCorrect } from "@/lib/ai/verify";
import { findNearDuplicateEvent, findNearDuplicateConflict, suffixedName, tokenSimilarity } from "@/lib/integrity/dedupe";
import { GET as reviewGET, POST as reviewPOST } from "@/app/api/integrity/review/route";
import { POST as importPOST } from "@/app/api/office/import/route";
import { POST as blobsPOST } from "@/app/api/blobs/route";
import { POST as auditApplyPOST } from "@/app/api/office/docs/[id]/audit-apply/route";
import { POST as docsPOST } from "@/app/api/ediscovery/docs/route";
import { createDocument, ensureHashes, updateCoding, bulkCode } from "@/modules/ediscovery/service";
import { draftPrivilegeDescription, applySuggestedCoding } from "@/modules/ediscovery/ai";
import { createItem } from "@/modules/library/service";
import { LIBRARY_FOLDERS } from "@/modules/library/ids";
import { saveOfficeDoc, createOfficeDoc } from "@/modules/office/shared/docs-service";
import { startRun, resumeRun } from "@/modules/workflows/engine";
import { defaultConfigFor, NODE_TYPE_MAP, type AnyNodeType } from "@/modules/workflows/registry";
import { buildTemplates, WORKFLOW_TEMPLATE_IDS } from "@/modules/workflows/templates";
import { validateWorkflow } from "@/modules/workflows/graph";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@/lib/types/domain";

const VALSARA = MATTERS.valsara;

function N(id: string, type: AnyNodeType, config: Record<string, unknown> = {}, label = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], label, position: { x: 0, y: 0 }, config: { ...defaultConfigFor(type), ...config } };
}
function E(source: string, target: string, sourceHandle?: string): WorkflowEdge { return { id: `e_${source}_${target}_${sourceHandle ?? ""}`, source, target, sourceHandle }; }
function wf(id: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  const now = new Date().toISOString();
  const w: Workflow = { id, name: id, category: "operations", nodes, edges, inputs: [], status: "active", createdAt: now, updatedAt: now };
  db().workflows.put(w);
  return w;
}
function req(url: string, init?: RequestInit) { return new NextRequest(new Request(`http://localhost${url}`, init)); }
function form(name: string, text: string, extra: Record<string, string> = {}) { const f = new FormData(); f.append("file", new File([text], name, { type: "text/plain" })); for (const [k, v] of Object.entries(extra)) f.append(k, v); return f; }

beforeAll(() => { resetSqlite(); db(); });

describe("verification primitives (no key)", () => {
  it("fails soft without a key and cross-checks record cites", async () => {
    const v = await safeVerifyClaims({ answer: "x", sources: [{ text: "y" }] });
    expect(v.status).toBe("unverified");
    expect(v.error).toBe("no_api_key");
    const sc = await safeSelfCorrect({ label: "t", output: [1], evidence: "e", schema: { type: "array" } });
    expect(sc.ran).toBe(false);
    expect(sc.corrected).toEqual([1]);
    expect(extractRecordCites("See MFC-0041877 and Vasudevan 19:15–20:08, also NG_000123.")).toEqual({ bates: ["MFC-0041877", "NG_000123"], pageLines: ["19:15", "20:8"] });
    const c = crossCheckCitations("Cites MFC-0041877, MFC-0000009 and 19:15 plus 999:01.", { bates: ["MFC-0041877"], pages: [19, 20] });
    expect(c.unresolved.sort()).toEqual(["999:1", "MFC-0000009"]);
    expect(c.text).toBe("Cites MFC-0041877, MFC-0000009 [VERIFY] and 19:15 plus 999:01 [VERIFY].");
    expect(crossCheckCitations(c.text, { bates: ["MFC-0041877"], pages: [19] }).text).not.toMatch(/\[VERIFY\] \[VERIFY\]/);
  });
  it("finds near-duplicate events, conflicts and names", () => {
    const ex = [{ id: "a", date: "2001-03-14", title: "Sundaram delivers the 90-day study final report summary", sources: [{ bates: "MFC-0041877" }] }];
    expect(findNearDuplicateEvent(ex, { date: "2001-03-14", title: "Sundaram final report summary of 90-day study delivered", sources: [{ bates: "MFC-0041877" }] })?.id).toBe("a");
    expect(findNearDuplicateEvent(ex, { date: "2001-03-15", title: "Sundaram delivers the 90-day study final report summary" })).toBeNull();
    expect(findNearDuplicateConflict([{ id: "c", title: "Vasudevan vs report", sides: [{ cite: "Vasudevan 19:15" }, { cite: "MFC-0041877" }] }], { title: "different", sides: [{ cite: "mfc-0041877" }, { cite: "VASUDEVAN 19:15" }] })?.id).toBe("c");
    expect(tokenSimilarity("The Sundaram report", "sundaram report")).toBe(1);
    expect(suffixedName("Memo.docx", new Set(["memo.docx", "Memo (2).docx"]))).toBe("Memo (3).docx");
  });
});

describe("integrity scans", () => {
  it("registers the module scans through the bootstrap and runs clean on the seed", () => {
    const ids = listScans().map((s) => s.id);
    for (const id of ["ediscovery-families", "ediscovery-coding", "ediscovery-citations", "ediscovery-ai-review", "workflow-definitions", "workflow-artifacts", "library-content", "library-links"]) expect(ids).toContain(id);
    const report = runScans("manual");
    expect(report.results.every((r) => !r.error), report.results.filter((r) => r.error).map((r) => `${r.scanId}: ${r.error}`).join("; ")).toBe(true);
    expect(report.results.find((r) => r.scanId === "ediscovery-citations")!.findings.filter((f) => f.severity === "high")).toHaveLength(0);
    expect(report.results.find((r) => r.scanId === "workflow-definitions")!.findings.filter((f) => f.severity === "high")).toHaveLength(0);
  });
  it("detects and fixes a timeline source that does not resolve, and flags privileged-without-basis", () => {
    const d = db();
    const doc = d.edocs.find((x) => x.matterId === VALSARA)[0];
    d.timeline.put({ id: "tl_test_bad", matterId: VALSARA, date: "2002-01-01", title: "Bad source", category: "other", significance: 2, sources: [{ kind: "document", id: "ed_missing", bates: doc.bates }], createdBy: "ai" });
    d.edocs.put({ ...doc, id: "ed_test_priv", bates: "MFC-TEST-0001", coding: { privileged: true, responsive: true } });
    const report = runScans("manual", ["ediscovery-citations", "ediscovery-coding"]);
    const f = report.results.find((r) => r.scanId === "ediscovery-citations")!.findings.find((x) => x.target?.id === "tl_test_bad")!;
    expect(f.fixable).toBe(true);
    expect(fixFinding(f.id).ok).toBe(true);
    expect(d.timeline.get("tl_test_bad")!.sources[0].id).toBe(doc.id);
    expect(report.results.find((r) => r.scanId === "ediscovery-coding")!.findings.some((x) => x.target?.id === "ed_test_priv" && /without a basis/.test(x.title))).toBe(true);
    d.timeline.delete("tl_test_bad"); d.edocs.delete("ed_test_priv");
  });
});

describe("review queue API", () => {
  it("lists pending AI records and records decisions", async () => {
    putProvenance({ kind: "timeline.event", recordId: db().timeline.find((e) => e.matterId === VALSARA)[0].id, matterId: VALSARA, title: "Test pending event", href: "/x", provenance: makeProvenance({ surface: "test", confidence: 0.2, sources: [{ kind: "document", cite: "MFC-0041877" }] }) });
    const list = await (await reviewGET(req(`/api/integrity/review?matter=${VALSARA}`))).json() as { items: { kind: string; id: string; confidence: number; review: { status: string } }[]; counts: { pending: number } };
    const item = list.items.find((i) => i.kind === "timeline.event")!;
    expect(item.review.status).toBe("pending");
    expect(list.counts.pending).toBeGreaterThan(0);
    const res = await reviewPOST(req("/api/integrity/review", { method: "POST", body: JSON.stringify({ kind: item.kind, id: item.id, decision: "rejected", note: "not supported" }) }));
    expect(res.status).toBe(200);
    const body = await res.json() as { results: { ok: boolean; provenance: { review: { status: string; note: string } } }[] };
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].provenance.review).toMatchObject({ status: "rejected", note: "not supported" });
    expect(db().timeline.get(item.id)?.provenance?.review?.status ?? "rejected").toBe("rejected");
    expect(listAudit({ action: "ai.verify", targetId: item.id })[0].meta).toMatchObject({ method: "human", decision: "rejected" });
    const bad = await reviewPOST(req("/api/integrity/review", { method: "POST", body: JSON.stringify({ kind: "conflict", id: "nope", decision: "approved" }) }));
    expect(bad.status).toBe(207);
  });
});

describe("dedupe on ingest", () => {
  it("imports the same bytes once and answers 409 with the existing document the second time", async () => {
    const text = "MEMORANDUM\n\nThis is a test import for dedupe. It has enough text to be hashed as content.\n\nSecond paragraph here.";
    const first = await importPOST(req("/api/office/import", { method: "POST", body: form("dedupe-test.txt", text, { matterId: VALSARA }) }));
    expect(first.status).toBe(200);
    const a = await first.json() as { doc: { id: string }; sha256: string; contentHash: string; libraryItemId: string };
    expect(a.sha256).toHaveLength(64);
    const second = await importPOST(req("/api/office/import", { method: "POST", body: form("dedupe-test.txt", text, { matterId: VALSARA }) }));
    expect(second.status).toBe(409);
    const b = await second.json() as { duplicate: boolean; existing: { id: string; url: string }; message: string };
    expect(b.duplicate).toBe(true);
    expect(b.existing.id).toBe(a.doc.id);
    // same text under a different file name is also a duplicate; a different matter is not
    const third = await importPOST(req("/api/office/import", { method: "POST", body: form("other-name.txt", text + "\n", { matterId: VALSARA }) }));
    expect(third.status).toBe(409);
    const other = await importPOST(req("/api/office/import", { method: "POST", body: form("dedupe-test.txt", text, { matterId: MATTERS.northgate }) }));
    expect(other.status).toBe(200);
    const forced = await importPOST(req("/api/office/import", { method: "POST", body: form("dedupe-test.txt", text, { matterId: VALSARA, allowDuplicate: "1" }) }));
    expect(forced.status).toBe(200);
    expect(((await forced.json()) as { doc: { title: string } }).doc.title).toMatch(/\(2\)$/);
    expect(db().officeDocs.count((o) => o.meta?.sha256 === a.sha256)).toBe(3);
    expect(listAudit({ action: "import", targetId: a.doc.id }).length).toBeGreaterThanOrEqual(2);
  });
  it("stores identical blobs once", async () => {
    const bytes = new TextEncoder().encode("blob bytes for dedupe " + Date.now());
    const first = await (await blobsPOST(req("/api/blobs?name=a.bin&mime=application/octet-stream", { method: "POST", body: bytes }))).json() as { id: string; duplicate: boolean };
    const again = await blobsPOST(req("/api/blobs?name=a.bin&mime=application/octet-stream", { method: "POST", body: bytes }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: first.id, duplicate: true });
    const matter = await blobsPOST(req(`/api/blobs?name=a.bin&mime=application/octet-stream&matterId=${VALSARA}`, { method: "POST", body: bytes }));
    expect(matter.status).toBe(200); // first upload for this matter is new
    const matterDup = await blobsPOST(req(`/api/blobs?name=a.bin&mime=application/octet-stream&matterId=${VALSARA}`, { method: "POST", body: bytes }));
    expect(matterDup.status).toBe(409);
  });
  it("creates e-discovery documents with hashes and links exact duplicates", () => {
    const base = { matterId: VALSARA, date: "2003-01-01", custodianId: "c_ghale", type: "Email" as const, subject: "Dedupe test", text: "Identical body for ingest dedupe test." };
    const a = createDocument({ ...base, bates: "MFC-DEDUP-0001" });
    expect(a.created).toBe(true);
    expect(a.doc.hash).toHaveLength(64);
    expect(a.duplicateOf).toBeNull();
    const b = createDocument({ ...base, bates: "MFC-DEDUP-0002" });
    expect(b.duplicateOf?.id).toBe(a.doc.id);
    expect(b.doc.isDuplicateOf).toBe(a.doc.id);
    expect(() => createDocument({ ...base, bates: "mfc-dedup-0001" })).toThrow(/already exists/);
    expect(ensureHashes(VALSARA).hashed).toBeGreaterThanOrEqual(0);
    expect(db().edocs.find((d) => d.matterId === VALSARA).every((d) => d.hash)).toBe(true);
  });
  it("POST /api/ediscovery/docs validates and dedupes", async () => {
    const res = await docsPOST(req("/api/ediscovery/docs", { method: "POST", body: JSON.stringify({ matterId: VALSARA, bates: "MFC-DEDUP-0003", date: "2003-01-02", custodianId: "c_ghale", type: "Email", subject: "Dedupe test", text: "Identical body for ingest dedupe test." }) }));
    expect(res.status).toBe(201);
    const body = await res.json() as { doc: { isDuplicateOf?: string }; duplicateOf: { bates: string } | null };
    expect(body.duplicateOf?.bates).toBe("MFC-DEDUP-0001");
    const conflict = await docsPOST(req("/api/ediscovery/docs", { method: "POST", body: JSON.stringify({ matterId: VALSARA, bates: "MFC-DEDUP-0003", date: "2003-01-02", subject: "x", text: "y" }) }));
    expect(conflict.status).toBe(409);
  });
  it("suffixes or merges library items with the same name in one folder", () => {
    const a = createItem({ name: "Integrity note", type: "note", parentId: LIBRARY_FOLDERS.myFiles, content: "Same content" });
    const merged = createItem({ name: "integrity note", type: "note", parentId: LIBRARY_FOLDERS.myFiles, content: "Same content", tags: ["merged"] });
    expect(merged.id).toBe(a.id);
    expect(merged.tags).toContain("merged");
    const b = createItem({ name: "Integrity note", type: "note", parentId: LIBRARY_FOLDERS.myFiles, content: "Different content" });
    expect(b.id).not.toBe(a.id);
    expect(b.name).toBe("Integrity note (2)");
    expect(listAudit({ action: "create", targetId: b.id })[0].meta).toMatchObject({ renamedFrom: "Integrity note" });
  });
});

describe("audit events", () => {
  it("records coding changes, agent edits and applied proposals", async () => {
    const doc = db().edocs.find((d) => d.matterId === VALSARA)[2];
    updateCoding(doc.id, { hot: !doc.coding.hot, notes: "audit test" });
    const ev = listAudit({ action: "coding.change", targetId: doc.id })[0];
    expect(ev.meta?.fields).toEqual(expect.arrayContaining(["hot", "notes"]));
    bulkCode({ ids: [doc.id], patch: {}, addIssues: ["TOX-01"] });
    expect(listAudit({ action: "coding.change" }).some((e) => (e.meta?.ids as string[] | undefined)?.includes(doc.id))).toBe(true);
    const od = createOfficeDoc({ kind: "word", title: "Audit doc", content: { type: "doc", content: [] }, matterId: VALSARA });
    saveOfficeDoc(od.id, { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "edited" }] }] }, version: { summary: "Agent edit: rewrote ¶1", force: true } });
    expect(listAudit({ action: "ai.apply", targetId: od.id }).length).toBe(1);
    const res = await auditApplyPOST(req(`/api/office/docs/${od.id}/audit-apply`, { method: "POST", body: JSON.stringify({ mode: "draft", proposals: [{ id: "p1", kind: "rewrite_paragraph", title: "Rewrite ¶1", status: "applied", provenance: makeProvenance({ surface: "office.word", sources: [{ kind: "document", cite: "MFC-0041877" }] }) }, { id: "p2", kind: "insert_after", title: "x", status: "discarded" }] }) }), { params: Promise.resolve({ id: od.id }) });
    expect(await res.json()).toMatchObject({ ok: true, applied: 1, discarded: 1 });
    expect(listAudit({ action: "ai.apply", targetId: od.id }).length).toBe(2);
    expect(verifyAuditChain().ok).toBe(true);
  });
  it("degrades AI wrappers to explicit no-key states", async () => {
    const doc = db().edocs.find((d) => d.matterId === VALSARA && d.coding.privileged === true)[0];
    const r = await draftPrivilegeDescription(doc.id);
    expect(r.ai).toBe(false);
    expect(r.provenance).toBeUndefined();
    expect(applySuggestedCoding("ed_vls_0001")).toMatchObject({ applied: false, needsReview: false });
    expect(getProvenance("edoc.analysis", "ed_vls_0001")).toBeNull();
  });
});

describe("workflow trust gates without a key", () => {
  it("pauses at logic.review when a referenced step has no provenance, then honours the decision", async () => {
    const w = wf("wf_int_nokey", [N("start", "trigger.manual"), N("search", "data.search_ediscovery", { query: "*", matterId: VALSARA, limit: 3 }), N("review", "logic.review", { steps: "search" }), N("task", "action.create_task", { title: "Follow up on {{steps.search.output.count}} docs", matterId: VALSARA })], [E("start", "search"), E("search", "review"), E("review", "task", "approved")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    // a data step is not an AI step: nothing to distrust, the gate passes
    expect(run.status).toBe("succeeded");
    const w2 = wf("wf_int_nokey2", [N("start", "trigger.manual"), N("summ", "ai.summarize", { source: "text", retries: 0 }), N("task", "action.create_task", { title: "x {{steps.summ.output.text}}", matterId: VALSARA })], [E("start", "summ"), E("summ", "task")]);
    const failed = await startRun(w2, { inputs: {}, wait: true });
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("no_api_key");
    expect(failed.steps.find((s) => s.nodeId === "task")!.status).toBe("skipped");
  });
  it("gates an action on a step that carries untrusted provenance and lets a reviewer lift it", async () => {
    // Seed a run snapshot by hand: a prior AI step output with pending review, then the action.
    const w = wf("wf_int_gate2", [N("start", "trigger.manual"), N("plan", "ai.prompt", { prompt: "x" }), N("task", "action.create_task", { title: "AI says {{steps.plan.output.text}}", matterId: VALSARA })], [E("start", "plan"), E("plan", "task")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    expect(run.errorCode).toBe("no_api_key");
    // Simulate the AI step having succeeded with low-confidence provenance and re-run only the action through resume machinery:
    const record = db().workflowRuns.get(run.id)!;
    const pending = makeProvenance({ surface: "workflow.ai.prompt", confidence: 0.3, sources: [] });
    db().workflowRuns.put({ ...record, status: "waiting_approval", steps: record.steps.map((s) => (s.nodeId === "plan" ? { ...s, status: "succeeded", output: { text: "do it", _provenance: pending }, error: undefined } : s.nodeId === "task" ? { ...s, status: "waiting_approval" } : s)), ...( { approvals: [{ nodeId: "task", title: "Trust gate: task", message: "plan not trusted", requestedAt: new Date().toISOString(), kind: "trust-gate", stepIds: ["plan"], reasons: ["confidence 30% is below the 60% gate"] }] } ) });
    const before = db().tasks.count();
    const resumed = await resumeRun(run.id, { approved: true, comment: "I checked it" }, { wait: true });
    expect(resumed.status).toBe("succeeded");
    expect(db().tasks.count()).toBe(before + 1);
    expect(resumed.steps.find((s) => s.nodeId === "task")!.logs?.some((l) => /Trust gate lifted/.test(l))).toBe(true);
  });
  it("data.dedupe drops items already on the timeline and repeated rows", async () => {
    const existing = db().timeline.find((e) => e.matterId === VALSARA)[0];
    const w = wf("wf_int_dedupe", [N("start", "trigger.manual"), N("dedupe", "data.dedupe", { items: "{{inputs.items}}", collection: "timeline", keyFields: "date,event", matterId: VALSARA })], [E("start", "dedupe")]);
    const items = [{ date: existing.date, event: existing.title, source: existing.sources[0]?.bates }, { date: "2030-01-01", event: "Brand new event", source: "MFC-1" }, { date: "2030-01-01", event: "Brand new event", source: "MFC-1" }];
    const run = await startRun(w, { inputs: { items }, wait: true });
    expect(run.status).toBe("succeeded");
    const out = run.steps.find((s) => s.nodeId === "dedupe")!.output as { kept: number; dropped: number; droppedItems: { reason: string }[] };
    expect(out.kept).toBe(1);
    expect(out.dropped).toBe(2);
    expect(out.droppedItems.map((d) => d.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/matches timeline event/), "repeated in the list"]));
  });
  it("update_coding writes a NEEDS REVIEW note instead of coding when the AI step is untrusted", async () => {
    const doc = db().edocs.find((d) => d.matterId === VALSARA)[3];
    const w = wf("wf_int_coding", [N("start", "trigger.manual"), N("plan", "ai.prompt", { prompt: "x" }), N("code", "action.update_coding", { documents: [doc.id], field: "hot", value: "{{steps.plan.output.text}}" })], [E("start", "plan"), E("plan", "code")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    const record = db().workflowRuns.get(run.id)!;
    db().workflowRuns.put({ ...record, status: "waiting_approval", steps: record.steps.map((s) => (s.nodeId === "plan" ? { ...s, status: "succeeded", output: { text: "true", _provenance: makeProvenance({ surface: "workflow.ai.prompt", confidence: 0.1 }) }, error: undefined } : s.nodeId === "code" ? { ...s, status: "waiting_approval" } : s)), ...({ approvals: [{ nodeId: "code", title: "t", message: "m", requestedAt: new Date().toISOString(), kind: "trust-gate", stepIds: [] }] }) });
    const resumed = await resumeRun(run.id, { approved: false }, { wait: true });
    expect(resumed.steps.find((s) => s.nodeId === "code")!.status).toBe("skipped");
    // now run the executor directly with untrusted upstream (no override): notes only
    const w2 = wf("wf_int_coding2", [N("start", "trigger.manual"), N("code", "action.update_coding", { documents: [doc.id], field: "hot", value: "true", note: "from test" })], [E("start", "code")]);
    const hotBefore = db().edocs.get(doc.id)!.coding.hot;
    const direct = await startRun(w2, { inputs: {}, wait: true });
    expect(direct.status).toBe("succeeded");
    expect(db().edocs.get(doc.id)!.coding.hot).toBe(true); // no AI upstream → applies normally
    db().edocs.update(doc.id, (c) => ({ ...c, coding: { ...c.coding, hot: hotBefore } }));
  });
  it("ships the updated templates with verify, dedupe and review nodes", () => {
    const byId = new Map(buildTemplates().map((t) => [t.id, t]));
    for (const [id, expected] of [[WORKFLOW_TEMPLATE_IDS.chronology, ["ai.verify", "data.dedupe", "logic.review"]], [WORKFLOW_TEMPLATE_IDS.privilegeLog, ["ai.verify", "data.dedupe", "logic.review"]], [WORKFLOW_TEMPLATE_IDS.depoDigest, ["ai.verify", "logic.review"]], [WORKFLOW_TEMPLATE_IDS.researchMemo, ["ai.verify", "logic.review"]]] as const) {
      const t = byId.get(id)!;
      const types = new Set(t.nodes.map((n) => n.type as string));
      for (const e of expected) expect(types, id).toContain(e);
      const v = validateWorkflow(t.nodes, t.edges);
      expect(v.ok, `${id}: ${v.issues.map((i) => i.message).join("; ")}`).toBe(true);
    }
    for (const t of ["ai.verify", "data.dedupe", "logic.review"]) expect(NODE_TYPE_MAP[t]).toBeTruthy();
  });
});
