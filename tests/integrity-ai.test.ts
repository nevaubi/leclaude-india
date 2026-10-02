import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * AI integrity wiring with a fake model runtime: every wrapper attaches
 * provenance, runs the verification loops, dedupes against existing records,
 * gates low-confidence output and writes the audit trail. No network.
 */
process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
process.env.OPENAI_API_KEY = "test-key";

type Call = { name?: string; instructions?: string; input?: unknown; schema?: unknown };
const calls: Call[] = [];
const script: Record<string, (c: Call) => unknown> = {};

vi.mock("@/lib/ai/agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/agent")>();
  return {
    ...real,
    generateJSON: async (opts: Call) => { calls.push(opts); const fn = script[opts.name ?? ""]; if (!fn) throw new Error(`no fake for ${opts.name}`); return fn(opts); },
    generateText: async (opts: Call) => { calls.push({ ...opts, name: "text" }); const fn = script.text; return { text: fn ? String(fn(opts)) : "Draft text.", responseId: "r", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }; },
    runAgent: async (opts: { jsonSchema?: { name: string }; onEvent: (e: unknown) => void; instructions: string; input: unknown }) => {
      calls.push({ name: `agent:${opts.jsonSchema?.name ?? "text"}`, instructions: opts.instructions, input: opts.input });
      const fn = script[`agent:${opts.jsonSchema?.name ?? "text"}`];
      const out = fn ? fn({ name: opts.jsonSchema?.name, instructions: opts.instructions, input: opts.input }) : { text: "Agent text." };
      const text = typeof out === "string" ? out : JSON.stringify(out);
      opts.onEvent({ type: "done", responseId: "r", usage: { input: 10, output: 5, total: 15 }, text });
      return { text, responseId: "r", steps: 0, toolCalls: [], usage: { input: 10, output: 5, total: 15 }, json: typeof out === "string" ? undefined : out };
    },
  };
});

import { db, resetSqlite } from "@/lib/db";
import { MATTERS } from "@/lib/seed/ids";
import { listAudit, verifyAuditChain } from "@/lib/integrity/audit";
import { getProvenance, listProvenance } from "@/lib/integrity/store";
import { listReviewQueue, decideReview } from "@/lib/integrity/review";
import { isTrusted } from "@/lib/integrity/provenance";
import { analyzeDocument, applySuggestedCoding, cachedAnalysis, draftPrivilegeDescription, predictResponsiveness } from "@/modules/ediscovery/ai";
import { buildFactMatrix, digestDeposition, extractTimelineEvents, findContradictions, knowledgeMap, prepareOutline } from "@/modules/ediscovery/analysis/ai";
import { generateDailyBrief } from "@/modules/home/brief";
import { summarizeItem, autoTagItem } from "@/modules/library/service";
import { startRun, resumeRun } from "@/modules/workflows/engine";
import { defaultConfigFor, type AnyNodeType } from "@/modules/workflows/registry";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@/lib/types/domain";

const VALSARA = MATTERS.valsara;
const DOC = "ed_vls_0001"; // MFC-0041877 Sundaram report summary
const VASUDEVAN = "dep_vls_voss_v1";

// Default fakes: self-correction keeps everything, claim verification supports everything.
script.self_correction = (c) => { const out = JSON.parse(String(c.input).split("\nEVIDENCE:")[0].replace(/^OUTPUT:\n/, "")); return { corrected: out, changes: [] }; };
script.claim_verification = () => ({ verdicts: [{ claim: "a", status: "supported", sourceIndex: 0, quote: "q" }, { claim: "b", status: "supported", sourceIndex: 0, quote: "q" }] });

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

beforeAll(() => { resetSqlite(); db(); });

describe("e-discovery analysis provenance", () => {
  it("attaches gated provenance to a document analysis and refuses to auto-apply an untrusted suggestion", async () => {
    script.document_analysis = () => ({ summary: "Sundaram summary citing MFC-0041877 and MFC-9999999.", keyIssues: ["liver effects", "serum persistence"], entities: { people: ["Leela Sundaram"], orgs: [], places: [], chemicals: ["PFOS"] }, suggestedCoding: { responsive: true, responsiveConfidence: 92, privileged: false, privilegedConfidence: 5, privilegeBasis: "none", hot: true, issues: ["TOX-01", "NOPE-9"], rationale: "Core study document." }, privilegeRisk: "None identified", confidence: 0.35 });
    const a = await analyzeDocument(DOC, { force: true });
    expect(a.provenance).toBeTruthy();
    expect(a.provenance!.confidence).toBeCloseTo(0.35);
    expect(a.provenance!.review?.status).toBe("pending");
    expect(a.provenance!.sources[0]).toMatchObject({ kind: "document", cite: "MFC-0041877" });
    expect(a.provenance!.verification?.method).toBe("schema");
    expect(a.provenance!.verification?.unresolvedCites).toEqual(["MFC-9999999"]);
    expect(a.summary).toContain("MFC-9999999 [VERIFY]");
    expect(a.suggestedCoding.issues).toEqual(["TOX-01"]);
    expect(cachedAnalysis(DOC)?.provenance?.promptHash).toBe(a.provenance!.promptHash);
    expect(db().edocs.get(DOC)?.aiProvenance?.review?.status).toBe("pending");
    expect(getProvenance("edoc.analysis", DOC)?.surface).toBe("ediscovery.analysis");
    expect(listAudit({ action: "ai.generate", targetId: DOC }).length).toBeGreaterThan(0);
    // untrusted → notes only
    const before = db().edocs.get(DOC)!.coding;
    const res = applySuggestedCoding(DOC);
    expect(res.applied).toBe(false);
    expect(res.needsReview).toBe(true);
    expect(res.doc!.coding.notes).toContain("NEEDS REVIEW");
    expect(res.doc!.coding.responsive).toBe(before.responsive);
    // review queue lists it; approving makes it trusted and applies
    const q = listReviewQueue({ matterId: VALSARA, kind: "edoc.analysis" });
    expect(q.find((i) => i.id === DOC)?.confidence).toBeCloseTo(0.35);
    expect(decideReview({ kind: "edoc.analysis", id: DOC, decision: "approved", note: "ok" }).ok).toBe(true);
    expect(isTrusted(cachedAnalysis(DOC)!.provenance)).toBe(true);
    expect(applySuggestedCoding(DOC).applied).toBe(true);
    expect(listAudit({ action: "coding.change", targetId: DOC }).length).toBeGreaterThanOrEqual(2);
  });

  it("scores a batch with per-document confidence and gates the uncertain ones", async () => {
    script.batch_prediction = (c) => { const ids = Array.from(String(c.input).matchAll(/\(id: (\S+)\)/g)).map((m) => m[1]); return { results: ids.map((id, i) => ({ id, score: i === 0 ? 95 : 52, issues: ["TOX-01"], rationale: "r", confidence: i === 0 ? 0.9 : 0.4 })) }; };
    const ids = db().edocs.find((d) => d.matterId === VALSARA).slice(0, 2).map((d) => d.id);
    const summary = await predictResponsiveness({ matterId: VALSARA, ids, force: true });
    expect(summary.scored).toBe(2);
    expect(summary.belowGate).toBe(1);
    const gated = db().edocs.get(ids[1])!;
    expect(gated.aiProvenance?.review?.status).toBe("pending");
    expect(db().edocs.get(ids[0])!.aiProvenance?.review).toBeUndefined();
    expect(getProvenance("edoc.prediction", ids[1])?.confidence).toBeLessThan(0.6);
  });

  it("drafts a privilege description with deterministic leak checks in its provenance", async () => {
    script.text = () => "Email from Rohit Kapur (Associate General Counsel) to Manish Sood providing legal advice regarding regulatory reporting obligations.";
    const priv = db().edocs.find((d) => d.matterId === VALSARA && d.coding.privileged === true)[0];
    const r = await draftPrivilegeDescription(priv.id);
    expect(r.ai).toBe(true);
    expect(r.provenance?.verification?.method).toBe("citations");
    expect(r.provenance?.sources[0].cite).toBe(priv.bates);
  });

  it("extracts timeline events with self-correction, dedupe against the chronology and per-event provenance", async () => {
    const existing = db().timeline.find((e) => e.matterId === VALSARA)[0];
    const doc = db().edocs.get(DOC)!;
    script.timeline_events = () => ({ events: [
      { date: existing.date, precision: "day", title: existing.title, description: "twin of an existing event", category: "scientific", significance: 3, bates: doc.bates, excerpt: "x", people: [], confidence: 0.9 },
      { date: "2001-03-14", precision: "day", title: "Sundaram delivers 90-day study final report summary to Meridian", description: "Report received.", category: "scientific", significance: 4, bates: doc.bates, excerpt: "FINAL REPORT SUMMARY", people: ["Hema Vasudevan"], confidence: 0.85 },
      { date: "2001-03-20", precision: "day", title: "Invented meeting with EPA about MF-3", description: "not in the text", category: "regulatory", significance: 5, bates: "MFC-0000000", excerpt: "", people: [], confidence: 0.3 },
    ] });
    script.self_correction = (c) => { const out = JSON.parse(String(c.input).split("\nEVIDENCE:")[0].replace(/^OUTPUT:\n/, "")) as { title: string }[]; return { corrected: out.filter((e) => !/Invented/.test(e.title)), changes: ["Dropped 'Invented meeting with EPA' — Bates MFC-0000000 not in evidence"] }; };
    const before = db().timeline.count((e) => e.matterId === VALSARA);
    const res = await extractTimelineEvents(VALSARA, { docIds: [DOC] });
    expect(res.extracted).toBe(3);
    expect(res.dropped).toBe(1);
    expect(res.duplicates).toHaveLength(1);
    expect(res.duplicates[0].duplicateOf).toBe(existing.id);
    expect(res.added).toHaveLength(1);
    expect(db().timeline.count((e) => e.matterId === VALSARA)).toBe(before + 1);
    const ev = db().timeline.get(res.added[0].id)!;
    expect(ev.provenance?.confidence).toBeCloseTo(0.85);
    expect(ev.provenance?.verification?.changes?.[0]).toMatch(/Dropped/);
    expect(ev.provenance?.verification?.status).toBe("partially-verified");
    expect(getProvenance("timeline.event", ev.id)).toBeTruthy();
    expect(listAudit({ action: "ai.verify" }).some((e) => e.meta?.method === "dedupe" && e.target.id === existing.id)).toBe(true);
    script.self_correction = (c) => { const out = JSON.parse(String(c.input).split("\nEVIDENCE:")[0].replace(/^OUTPUT:\n/, "")); return { corrected: out, changes: [] }; };
  });

  it("creates conflicts with provenance and skips near-duplicates on a second pass", async () => {
    const contradiction = { title: "Vasudevan: report was 'preliminary' vs. MFC-0041877 header 'FINAL REPORT SUMMARY' (test)", kind: "testimony_vs_document", severity: "high", testimonyCite: "Vasudevan 19:15", testimonyExcerpt: "it was a preliminary result", sourceKind: "document", sourceCite: "MFC-0041877", sourceExcerpt: "FINAL REPORT SUMMARY", analysis: "Direct conflict.", confidence: 0.8 };
    script.contradictions = () => ({ contradictions: [contradiction] });
    const first = await findContradictions(VALSARA, { depositionId: VASUDEVAN, topic: "Sundaram final report" });
    expect(first.created).toHaveLength(1);
    const c = first.created[0];
    expect(c.provenance?.confidence).toBeCloseTo(0.8);
    expect(c.provenance?.sources.map((s) => s.cite)).toEqual(["Vasudevan 19:15", "MFC-0041877"]);
    expect(c.provenance?.verification?.unresolvedCites ?? []).toEqual([]);
    expect(db().conflicts.get(c.id)?.provenance).toBeTruthy();
    const second = await findContradictions(VALSARA, { depositionId: VASUDEVAN, topic: "Sundaram final report" });
    expect(second.created).toHaveLength(0);
    expect(second.skipped[0].duplicateOf).toBe(c.id);
  });

  it("digests a deposition, verifies the summary and marks cites that do not resolve", async () => {
    script.deposition_digest = () => ({ summary: "Vasudevan admitted the report was labelled final (20:17) and cited MFC-0041877; see also MFC-0000001.", keyAdmissions: [{ cite: "20:17", text: "'final' appears in the title" }, { cite: "999:01", text: "invented" }], themes: ["final vs preliminary"], credibilityNotes: ["Evasive at 19:15"], followUps: ["Confront with MFC-0041880 at next volume"], confidence: 0.8 });
    script.claim_verification = () => ({ verdicts: [{ claim: "labelled final", status: "supported", sourceIndex: 0, quote: "In the title, yes." }, { claim: "MFC-0000001", status: "unsupported", sourceIndex: null }] });
    const d = await digestDeposition(VASUDEVAN, { force: true });
    expect(d.provenance?.verification?.status).toBe("partially-verified");
    expect(d.summary).toContain("MFC-0000001 [VERIFY]");
    expect(d.keyAdmissions.find((k) => k.startsWith("999:01"))).toContain("[VERIFY]");
    expect(d.keyAdmissions.find((k) => k.startsWith("20:17"))).not.toContain("[VERIFY]");
    expect(getProvenance("deposition.digest", VASUDEVAN)?.surface).toBe("ediscovery.digest");
    expect(db().depositions.get(VASUDEVAN)?.aiDigest?.themes).toEqual(["final vs preliminary"]);
    script.claim_verification = () => ({ verdicts: [{ claim: "a", status: "supported", sourceIndex: 0, quote: "q" }] });
  });

  it("builds a fact matrix and a knowledge map with provenance, and an outline verified against the record", async () => {
    script.fact_matrix = (c) => { const ids = Array.from(String(c.input).matchAll(/^- (\S+):/gm)).map((m) => m[1]); return { topics: ["What did Sundaram report?"], cells: ids.map((id) => ({ topic: "What did Sundaram report?", sourceId: id, position: "Silent", cite: "-", stance: "silent" })), confidence: 0.7 }; };
    const m = await buildFactMatrix(VALSARA, { topic: "Sundaram 90-day study" });
    expect(m.provenance?.confidence).toBeCloseTo(0.7);
    expect(getProvenance("fact-matrix", m.id)).toBeTruthy();
    script.knowledge_map = () => ({ narrative: "Vasudevan knew in March 2001.", entries: [{ personName: "Hema Vasudevan", knew: "the liver effects were real", firstKnownDate: "2001-03-14", confidence: "high", cites: [{ cite: "MFC-0041880", sourceKind: "document" }] }, { personName: "Hema Vasudevan", knew: "liver effects real and dose-related", firstKnownDate: "2001-03-14", confidence: "high", cites: [{ cite: "MFC-0041880", sourceKind: "document" }] }], confidence: 0.75 });
    const km = await knowledgeMap(VALSARA, { topic: "liver effects" });
    expect(km.entries).toHaveLength(1); // near-identical entry collapsed
    expect(km.provenance?.sources.length).toBeGreaterThan(0);
    expect(getProvenance("knowledge-map", km.id)?.confidence).toBeCloseTo(0.75);
    script.text = () => "# Outline\n\nUse MFC-0041877 and Vasudevan 19:15. Also MFC-1234567.";
    const o = await prepareOutline(VALSARA, { witnessName: "Hema Vasudevan" });
    expect(o.provenance.sources.length).toBeGreaterThan(0);
    expect(o.unresolvedCites).toContain("MFC-1234567");
    expect(o.markdown).toContain("MFC-1234567 [VERIFY]");
  });
});

describe("daily brief and library provenance", () => {
  it("verifies the brief against the facts it was given", async () => {
    script["agent:daily_brief"] = () => ({ headline: "Two deadlines this week", items: [{ kind: "deadline", text: "Valsara expert reports due.", matterId: VALSARA }, { kind: "task", text: "Overdue task." }], confidence: 0.8 });
    const b = await generateDailyBrief({ now: new Date("2026-09-24T12:00:00Z") });
    expect(b.provenance?.surface).toBe("home.brief");
    expect(b.provenance?.verification?.method).toBe("claims");
    expect(b.provenance?.sources.length).toBeGreaterThan(0);
    expect(getProvenance("home.brief", "2026-09-24")).toBeTruthy();
    expect(listAudit({ action: "ai.generate", targetKind: "home.brief" }).length).toBe(1);
  });
  it("summarizes and auto-tags library items with provenance and gates low-confidence tags", async () => {
    const it0 = db().library.find((l) => l.type === "note" && (l.content?.length ?? 0) > 100)[0];
    script.text = () => "- It is a note.\n\nWatch out: nothing.";
    const s = await summarizeItem(it0.id);
    expect(s.provenance?.surface).toBe("library.summary");
    expect((await summarizeItem(it0.id)).cached).toBe(true);
    script.library_autotag = () => ({ tags: ["groundwater", "toxicology"], practiceArea: "Employment", description: "d", confidence: 0.2 });
    const t = await autoTagItem(it0.id);
    expect(t.needsReview).toBe(true);
    expect(t.tags).toContain("needs-review");
    expect(t.practiceArea).toBe(it0.practiceArea); // low confidence never overwrites the practice area
  });
});

describe("workflow trust gating (fake model)", () => {
  it("pauses an action on low-confidence AI output, resumes on approval and skips on rejection", async () => {
    script["agent:step_output"] = () => ({ title: "Call the expert", confidence: 0.2 });
    const w = wf("wf_int_gate", [N("start", "trigger.manual"), N("plan", "ai.prompt", { prompt: "plan", output: "json", jsonSchema: JSON.stringify({ type: "object", properties: { title: { type: "string" }, confidence: { type: "number" } }, required: ["title", "confidence"] }) }), N("task", "action.create_task", { title: "AI: {{steps.plan.output.title}}", matterId: VALSARA })], [E("start", "plan"), E("plan", "task")]);
    const paused = await startRun(w, { inputs: {}, wait: true });
    expect(paused.status).toBe("waiting_approval");
    const gate = paused.approvals!.find((a) => a.nodeId === "task") as { kind?: string; reasons?: string[]; stepIds?: string[] } | undefined;
    expect(gate?.kind).toBe("trust-gate");
    expect(gate?.stepIds).toEqual(["plan"]);
    expect(gate?.reasons?.[0]).toMatch(/confidence 20% is below/);
    expect(paused.steps.find((s) => s.nodeId === "plan")!.output).toMatchObject({ _provenance: { confidence: 0.2, review: { status: "pending" } } });
    expect(getProvenance("workflow.step", `${paused.id}:plan`)).toBeTruthy();
    const tasksBefore = db().tasks.count();
    const resumed = await resumeRun(paused.id, { approved: true, comment: "fine" }, { wait: true });
    expect(resumed.status).toBe("succeeded");
    expect(db().tasks.count()).toBe(tasksBefore + 1);
    expect((resumed as { trustOverrides?: string[] }).trustOverrides).toEqual(expect.arrayContaining(["task", "plan"]));
    expect(listAudit({ action: "workflow.approve", targetId: paused.id }).length).toBeGreaterThanOrEqual(2);
    // rejection skips the action and the run still finishes
    const second = await startRun(w, { inputs: {}, wait: true });
    const rejected = await resumeRun(second.id, { approved: false, comment: "no" }, { wait: true });
    expect(rejected.status).toBe("succeeded");
    expect(rejected.steps.find((s) => s.nodeId === "task")!.status).toBe("skipped");
    expect(db().tasks.count()).toBe(tasksBefore + 1);
  });

  it("ai.verify marks a draft trusted when its claims are supported and logic.review passes it through", async () => {
    script["agent:text"] = () => "Memo: MFC-0041877 is the Sundaram summary.";
    script.claim_verification = () => ({ verdicts: [{ claim: "Sundaram summary", status: "supported", sourceIndex: 0, quote: "Sundaram" }] });
    const w = wf("wf_int_verify", [
      N("start", "trigger.manual"),
      N("draft", "ai.draft", { brief: "Write a memo", kind: "memo" }),
      N("verify", "ai.verify", { output: "{{steps.draft.output.text}}", sources: "[MFC-0041877] Sundaram final report summary of the 90-day study.", stepId: "draft", mode: "claims" }),
      N("review", "logic.review", { steps: "draft, verify" }),
      N("task", "action.create_task", { title: "Circulate {{steps.draft.output.title}}", matterId: VALSARA }),
    ], [E("start", "draft"), E("draft", "verify"), E("verify", "review"), E("review", "task", "approved")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    expect(run.status, JSON.stringify(run.steps.map((s) => [s.nodeId, s.status, s.error]))).toBe("succeeded");
    const v = run.steps.find((s) => s.nodeId === "verify")!.output as { trusted: boolean; status: string; unresolvedCites: string[] };
    expect(v.status).toBe("verified");
    expect(v.trusted).toBe(true);
    expect(v.unresolvedCites).toEqual([]);
    expect((run.steps.find((s) => s.nodeId === "review")!.output as { trusted: boolean }).trusted).toBe(true);
    expect(run.steps.find((s) => s.nodeId === "task")!.status).toBe("succeeded");
  });

  it("contradicted output pauses at logic.review with a clear reason", async () => {
    script["agent:text"] = () => "Memo: the study found no effects.";
    script.claim_verification = () => ({ verdicts: [{ claim: "no effects", status: "contradicted", sourceIndex: 0, quote: "liver effects are real" }] });
    const w = wf("wf_int_contra", [N("start", "trigger.manual"), N("draft", "ai.draft", { brief: "memo", kind: "memo" }), N("verify", "ai.verify", { output: "{{steps.draft.output.text}}", sources: "the liver effects are real", stepId: "draft" }), N("review", "logic.review", { steps: "draft" }), N("task", "action.create_task", { title: "x" })], [E("start", "draft"), E("draft", "verify"), E("verify", "review"), E("review", "task", "approved")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    expect(run.status).toBe("waiting_approval");
    expect(run.steps.find((s) => s.nodeId === "review")!.status).toBe("waiting_approval");
    const gate = run.approvals![0] as { kind?: string; reasons?: string[] };
    expect(gate.kind).toBe("trust-gate");
    expect(gate.reasons?.[0]).toMatch(/contradicted/i);
    expect(db().workflowRuns.get(run.id)!.status).toBe("waiting_approval");
  });

  it("keeps the audit chain intact after all of the above", () => {
    expect(verifyAuditChain().ok).toBe(true);
    expect(listProvenance({ pending: true }).length).toBeGreaterThan(0);
  });
});
