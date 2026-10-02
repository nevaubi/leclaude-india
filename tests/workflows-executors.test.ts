import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/wf-executors-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
});

import { z } from "zod";
import { db, resetSqlite } from "@/lib/db";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@/lib/types/domain";
import { listReviewQueue } from "@/lib/integrity/review";
import { defineAdapter, registerAdapter } from "@/modules/intel/adapters";
import { intelDocuments, intelInsights, intelSources } from "@/modules/intel/store";
import { updateSource } from "@/modules/intel/service";
import { defaultConfigFor } from "@/modules/workflows/registry";
import { startRun } from "@/modules/workflows/engine";
import { chooseFix, escalateStep, fixPatch, INTEL_EXECUTORS } from "@/modules/workflows/executors-intel";
import { AGENT_EXECUTORS } from "@/modules/workflows/executors-agents";
import { queryRecords, relativeDate, setIntelAnalysisProvider, type AnalysisResult } from "@/modules/workflows/intel-bridge";
import { markdownToDocSpec, renderOutputFile, safeFilename, safeSheetName } from "@/modules/workflows/output-files";
import type { WorkflowRunRecord } from "@/modules/workflows/types";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";

function N(id: string, type: WorkflowNode["type"], config: Record<string, unknown> = {}, label = id): WorkflowNode {
  return { id, type, label, position: { x: 0, y: 0 }, config: { ...defaultConfigFor(type), ...config } };
}
function E(source: string, target: string, sourceHandle?: string, targetHandle?: string): WorkflowEdge {
  return { id: `e_${source}_${target}_${sourceHandle ?? ""}_${targetHandle ?? ""}`, source, target, sourceHandle, targetHandle };
}
function wf(id: string, nodes: WorkflowNode[], edges: WorkflowEdge[], extra: Partial<Workflow> = {}): Workflow {
  const now = new Date().toISOString();
  const w: Workflow = { id, name: id, category: "operations", nodes, edges, inputs: [], status: "active", createdAt: now, updatedAt: now, ...extra };
  db().workflows.put(w);
  return w;
}
const stepOf = (run: WorkflowRunRecord, id: string) => run.steps.find((s) => s.nodeId === id)!;
const out = <T = Record<string, unknown>>(run: WorkflowRunRecord, id: string) => stepOf(run, id).output as T;

beforeAll(() => {
  resetSqlite(); db();
  for (const s of intelSources().all()) updateSource(s.id, { enabled: false });
  // A fake adapter that ingests a few documents per run without any network.
  registerAdapter(defineAdapter({
    id: "web-list", name: "fake web-list", description: "test", kinds: ["web_page"], family: "web", requires: [],
    configSchema: z.object({ pages: z.number().int().default(2), fail: z.boolean().default(false) }), defaults: { pages: 2, fail: false },
    async run(ctx) {
      if (ctx.config.fail) throw new Error("fetch failed: ECONNRESET");
      for (let i = 0; i < ctx.config.pages; i++) await ctx.ingest({ kind: "web_page", title: `Local rule page ${i}`, dates: { published: "2026-09-01" }, externalId: `wf:${ctx.source.id}:${i}`, court: "N.D. Fla.", courtId: "flnd", text: `Page ${i}. Judge M. Casey Rodgers presides over MDL 3140. ` + "Local rules of the Northern District of Florida govern motion practice. ".repeat(40) });
    },
  }));
});

describe("executor registry", () => {
  it("implements every phase-3 node type", () => {
    const types = ["intel.fetch", "intel.extract", "intel.index", "intel.entities", "intel.analyze", "intel.verify", "intel.publish", "review.auto", "data.query", "output.file", "logic.schedule_after"];
    for (const t of types) expect(typeof INTEL_EXECUTORS[t as keyof typeof INTEL_EXECUTORS], t).toBe("function");
    expect(typeof AGENT_EXECUTORS["ai.route"]).toBe("function");
    expect(typeof AGENT_EXECUTORS["ai.agent"]).toBe("function");
  });
  it("resolves relative dates", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    expect(relativeDate("-7d", now)).toBe("2026-09-17");
    expect(relativeDate("-2w", now)).toBe("2026-09-10");
    expect(relativeDate("2026-01-05", now)).toBe("2026-01-05");
    expect(relativeDate("", now)).toBeUndefined();
  });
});

describe("intel executors", () => {
  it("intel.fetch runs an ad-hoc adapter through the job queue, then extract, index and entities follow the doc ids", async () => {
    const w = wf("wf_x_intel", [
      N("start", "trigger.manual"),
      N("fetch", "intel.fetch", { sourceId: "", adapter: "web-list", config: JSON.stringify({ pages: 3 }), mode: "run", maxDocs: 10 }),
      N("extract", "intel.extract", { docIds: "{{steps.fetch.output.docIds}}", summarize: true, entities: true }),
      N("index", "intel.index", { docIds: "{{steps.extract.output.docIds}}", embed: true }),
      N("entities", "intel.entities", { docIds: "{{steps.extract.output.docIds}}", relations: true }),
    ], [E("start", "fetch"), E("fetch", "extract"), E("extract", "index"), E("index", "entities")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    expect(run.status, run.error).toBe("succeeded");
    const fetch = out(run, "fetch");
    expect(fetch.status).toBe("succeeded");
    expect(fetch.added).toBe(3);
    expect((fetch.docIds as string[]).length).toBe(3);
    expect(fetch.kinds).toEqual(["web_page"]);
    const src = intelSources().find((s) => s.adapter === "web-list" && String(s.name).startsWith("Workflow:"));
    expect(src).toHaveLength(1);
    const ex = out(run, "extract");
    expect(ex.docs).toBe(3);
    expect(ex.summarized).toBe(3); // extractive summaries without a key
    expect(ex.entitiesFound as number).toBeGreaterThan(0);
    for (const id of ex.docIds as string[]) expect(intelDocuments().get(id)?.summary).toBeTruthy();
    const ix = out(run, "index");
    expect(ix.docs).toBe(3);
    expect(ix.chunks as number).toBeGreaterThan(0);
    expect(ix.embedded).toBe(0); // no key: keyword only
    const en = out(run, "entities");
    expect(en.docs).toBe(3);
    expect(en.entities as number).toBeGreaterThan(0);
    expect(Object.keys(en.byType as Record<string, number>).length).toBeGreaterThan(0);
    expect((en.byType as Record<string, number>).court).toBeGreaterThan(0);
    // Second run: same external ids are updates, not additions.
    const again = await startRun(w, { inputs: {}, wait: true });
    expect(again.status).toBe("succeeded");
    expect(out(again, "fetch").added).toBe(0);
    expect(out(again, "fetch").updated as number).toBeGreaterThanOrEqual(0);
  });

  it("intel.fetch enqueues without waiting, fails clearly on a bad source, and files uploads through intel.extract", async () => {
    const w = wf("wf_x_enqueue", [N("start", "trigger.manual"), N("fetch", "intel.fetch", { sourceId: "", adapter: "web-list", config: "{}", mode: "enqueue" })], [E("start", "fetch")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    expect(run.status).toBe("succeeded");
    expect(out(run, "fetch").status).toBe("queued");
    const bad = wf("wf_x_badsource", [N("start", "trigger.manual"), N("fetch", "intel.fetch", { sourceId: "isrc_nope", mode: "run", onError: "fail" })], [E("start", "fetch")]);
    const r2 = await startRun(bad, { inputs: {}, wait: true });
    expect(r2.status).toBe("failed");
    expect(r2.error).toMatch(/not found/);
    const none = wf("wf_x_nosource", [N("start", "trigger.manual"), N("fetch", "intel.fetch", { sourceId: "", adapter: "", onError: "fail" })], [E("start", "fetch")]);
    const r3 = await startRun(none, { inputs: {}, wait: true });
    expect(r3.status).toBe("failed");
    expect(r3.error).toMatch(/source id or an adapter/);
    // Uploads: a blob becomes a local_file document.
    const blob = db().blobs.put(new TextEncoder().encode("Deposition of Girish Hegde. Page 12 line 4: Q. Did you read the memo? A. Yes. ".repeat(20)), "text/plain", { name: "hegde.txt" });
    const up = wf("wf_x_upload", [N("start", "trigger.manual"), N("extract", "intel.extract", { docIds: "", blobIds: "{{inputs.files | pluck:blobId}}" })], [E("start", "extract")]);
    const r4 = await startRun(up, { inputs: { files: [{ blobId: blob.id, name: "hegde.txt", mime: "text/plain", size: blob.size }] }, matterId: MATTERS.valsara, wait: true });
    expect(r4.status, r4.error).toBe("succeeded");
    const ex = out(r4, "extract");
    expect((ex.uploaded as string[]).length).toBe(1);
    const doc = intelDocuments().get((ex.uploaded as string[])[0])!;
    expect(doc.kind).toBe("local_file");
    expect(doc.matterIds).toContain(MATTERS.valsara);
    expect(doc.externalId).toBe(`blob:${blob.id}`);
  });

  it("intel.analyze uses the analysis provider, records insights and artifacts; intel.verify and intel.publish act on them", async () => {
    const calls: string[] = [];
    setIntelAnalysisProvider(async (req): Promise<AnalysisResult> => {
      calls.push(req.analysis);
      const now = req.now.toISOString();
      const insight = { id: `iins_test_${req.analysis}`, kind: "trend" as const, scope: { matterId: req.scope.matterId, entityIds: [] }, title: `Fake ${req.analysis}`, summary: "Two filings a week in MDL 3140.", data: { series: [1, 2] }, evidence: [], provenance: { surface: "test", model: "fake", generatedAt: now, sources: [], confidence: 0.9, verification: { status: "verified" as const, checkedAt: now } }, confidence: 0.9, status: "draft" as const, flags: [], createdAt: now, updatedAt: now };
      intelInsights().put(insight as never);
      return { analysis: req.analysis, insightIds: [insight.id], insights: [{ id: insight.id, kind: "trend", title: insight.title, summary: insight.summary, confidence: 0.9, status: "draft" }], data: { series: [1, 2] }, docCount: 12, text: "Two filings a week." };
    });
    try {
      const w = wf("wf_x_analyze", [
        N("start", "trigger.manual"),
        N("trends", "intel.analyze", { analysis: "trends", scope: { matterId: MATTERS.valsara, kinds: ["docket_entry"], entityIds: "", court: "", jurisdiction: "", dateFrom: "-90d", dateTo: "", q: "" }, title: "Valsara filings" }),
        N("verify", "intel.verify", { target: "insights", insightIds: "{{steps.trends.output.insightIds}}", limit: 5 }),
        N("publish", "intel.publish", { to: "library", insightIds: "{{steps.trends.output.insightIds}}", title: "Valsara trend note", matterId: MATTERS.valsara, requireVerified: false }),
        N("home", "intel.publish", { to: "home", insightIds: "{{steps.trends.output.insightIds}}" }),
      ], [E("start", "trends"), E("trends", "verify"), E("verify", "publish"), E("publish", "home")]);
      const run = await startRun(w, { inputs: {}, wait: true });
      expect(run.status, run.error).toBe("succeeded");
      expect(calls).toEqual(["trends"]);
      const a = out(run, "trends");
      expect(a.insightIds).toEqual(["iins_test_trends"]);
      expect(a.docCount).toBe(12);
      expect(run.artifacts!.some((x) => x.id === "iins_test_trends" && x.meta?.kind === "insight.trend")).toBe(true);
      const v = out(run, "verify");
      expect(v.target).toBe("insights");
      expect(v.checked as number).toBeGreaterThanOrEqual(0);
      const p = out(run, "publish");
      expect(p.published).toBe(1);
      expect((p.itemIds as string[]).length).toBe(1);
      const item = db().library.get((p.itemIds as string[])[0])!;
      expect(item.type).toBe("note");
      expect(item.matterId).toBe(MATTERS.valsara);
      expect(item.content).toContain("Fake trends");
      expect(run.deliverables!.some((d) => d.kind === "library" && d.libraryItemId === item.id)).toBe(true);
      expect(run.deliverables!.some((d) => d.kind === "insight" && d.meta?.insightId === "iins_test_trends")).toBe(true);
      expect(intelInsights().get("iins_test_trends")!.status).toBe("published");
      expect(out(run, "home").published).toBe(1);
      const bad = wf("wf_x_analyze_bad", [N("start", "trigger.manual"), N("x", "intel.analyze", { analysis: "magic", onError: "fail" })], [E("start", "x")]);
      const r2 = await startRun(bad, { inputs: {}, wait: true });
      expect(r2.status).toBe("failed");
      expect(r2.error).toMatch(/Unknown analysis/);
      const badTarget = wf("wf_x_publish_bad", [N("start", "trigger.manual"), N("x", "intel.publish", { to: "moon", onError: "fail" })], [E("start", "x")]);
      expect((await startRun(badTarget, { inputs: {}, wait: true })).error).toMatch(/Unknown publish target/);
    } finally { setIntelAnalysisProvider(null); }
  });

  it("intel.verify checks earlier steps' trust and runs the integrity sweep", async () => {
    const w = wf("wf_x_verify", [
      N("start", "trigger.manual"),
      N("q", "data.query", { source: "intel_documents", q: "", filters: { kinds: "mdl" }, limit: 5 }),
      N("steps", "intel.verify", { target: "steps", steps: "q" }),
      N("sweep", "intel.verify", { target: "sweep", network: false, limit: 5 }),
    ], [E("start", "q"), E("q", "steps"), E("steps", "sweep")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    expect(run.status, run.error).toBe("succeeded");
    const s = out(run, "steps");
    expect(s.target).toBe("steps");
    expect(s.checked).toBe(0); // data steps carry no AI provenance and are not gated
    expect(s.trusted).toBe(true);
    expect(s.flagged).toBe(0);
    const sw = out(run, "sweep");
    expect(sw.target).toBe("sweep");
    expect(sw.report).toBeTruthy();
    expect(typeof sw.trusted).toBe("boolean");
  });

  it("intel.publish builds a personal digest and notifies the person", async () => {
    const w = wf("wf_x_digest", [N("start", "trigger.manual"), N("digest", "intel.publish", { to: "digest", userId: PEOPLE.eshaMathur, title: "Morning brief" })], [E("start", "digest")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    expect(run.status, run.error).toBe("succeeded");
    const d = out(run, "digest");
    expect(d.published).toBe(1);
    expect(d.notified).toEqual([PEOPLE.eshaMathur]);
    const ins = intelInsights().get((d.insightIds as string[])[0])!;
    expect(ins.kind).toBe("digest");
    expect(ins.scope.userId).toBe(PEOPLE.eshaMathur);
    expect(db().collection<{ id: string; recipientIds: string[] }>("workflow_notifications").find((n) => n.recipientIds.includes(PEOPLE.eshaMathur)).length).toBeGreaterThan(0);
  });
});

describe("data.query", () => {
  it("queries e-discovery, intel documents, entities, library, tasks and people with filters", () => {
    const ed = queryRecords({ source: "ediscovery", filters: { privileged: "true" }, matterId: MATTERS.valsara, limit: 10 });
    expect(ed.count).toBeGreaterThan(0);
    expect(ed.rows.every((r) => (r.coding as { privileged?: boolean }).privileged === true)).toBe(true);
    expect(ed.text).toContain(String(ed.rows[0].bates ?? ed.rows[0].id));
    const docs = queryRecords({ source: "intel_documents", filters: { kinds: "mdl, docket" }, limit: 5, sort: "date", direction: "desc" });
    expect(docs.count).toBeGreaterThan(0);
    expect(docs.rows.every((r) => r.kind === "mdl" || r.kind === "docket")).toBe(true);
    const judges = queryRecords({ source: "intel_entities", q: "Rodgers", filters: { type: "judge" }, limit: 3 });
    expect(judges.count).toBeGreaterThan(0);
    expect(judges.ids[0]).toMatch(/^ient_/);
    const lib = queryRecords({ source: "library", filters: { type: "docx" }, limit: 3 });
    expect(lib.rows.every((r) => r.type === "docx")).toBe(true);
    const people = queryRecords({ source: "people", filters: { role: "attorney" }, limit: 50 });
    expect(people.count).toBeGreaterThan(2);
    expect(people.rows.every((r) => r.role === "attorney")).toBe(true);
    expect(() => queryRecords({ source: "nope" })).toThrow();
  });
  it("runs as a step and fails on an unknown source", async () => {
    const w = wf("wf_x_query", [N("start", "trigger.manual"), N("q", "data.query", { source: "tasks", filters: { status: "todo" }, matterId: MATTERS.valsara, limit: 5 })], [E("start", "q")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    expect(run.status).toBe("succeeded");
    expect(out(run, "q").source).toBe("tasks");
    expect((out(run, "q").rows as unknown[]).length).toBeLessThanOrEqual(5);
    const bad = wf("wf_x_query_bad", [N("start", "trigger.manual"), N("q", "data.query", { source: "", onError: "fail" })], [E("start", "q")]);
    expect((await startRun(bad, { inputs: {}, wait: true })).error).toMatch(/Choose a source/);
  });
});

describe("output.file", () => {
  it("renders docx, xlsx, csv, md and pdf deliverables through the office generators and files them in the library", async () => {
    const md = "# Memo\n\n## Facts\n\nThe pump failed on **March 3**.\n\n- one\n- two\n\n| Bates | Custodian |\n|---|---|\n| MFC-1 | Hegde |\n";
    const docx = await renderOutputFile({ format: "docx", title: "Test memo", markdown: md, matterId: MATTERS.valsara, tags: ["t"] });
    expect(docx).toMatchObject({ format: "docx", kind: "word", filename: "Test memo.docx" });
    expect(docx.size).toBeGreaterThan(1000);
    expect(db().library.get(docx.libraryItemId!)?.officeDocId).toBe(docx.docId);
    expect(db().blobs.get(docx.blobId)).toBeTruthy();
    const xlsx = await renderOutputFile({ format: "xlsx", title: "Rows", rows: [{ bates: "MFC-1", custodian: "Hegde" }, { bates: "MFC-2", custodian: "Prasad" }], matterId: MATTERS.valsara });
    expect(xlsx.kind).toBe("sheet");
    expect(xlsx.href).toMatch(/^\/office\/sheet\//);
    const csv = await renderOutputFile({ format: "csv", title: "Rows", rows: [{ a: 1, b: "x,y" }], addToLibrary: false });
    expect(new TextDecoder().decode(db().blobs.get(csv.blobId)!.bytes)).toBe('a,b\n1,"x,y"');
    expect(csv.libraryItemId).toBeUndefined();
    const mdf = await renderOutputFile({ format: "md", title: "Note", markdown: "Plain text body", matterId: MATTERS.valsara });
    expect(db().library.get(mdf.libraryItemId!)?.content).toContain("# Note");
    const pdf = await renderOutputFile({ format: "pdf", title: "Test memo", markdown: md, matterId: MATTERS.valsara });
    expect(pdf.mime).toBe("application/pdf");
    expect(pdf.docId).toBeTruthy();
    expect(pdf.size).toBeGreaterThan(500);
    await expect(renderOutputFile({ format: "xlsx", title: "Empty", rows: [] })).rejects.toThrow(/Nothing tabular/);
    await expect(renderOutputFile({ format: "docx", title: "Empty", markdown: "" })).rejects.toThrow(/Nothing to write/);
    expect(safeFilename("A/B: memo?", "docx")).toBe("A-B- memo-.docx");
    expect(safeSheetName("Hot documents — MC-8 / AOX — 2026-09-24")).toBe("Hot documents — MC-8 - AOX — 20");
    expect(safeSheetName("   ")).toBe("Sheet1");
    const spec = markdownToDocSpec(md, "Memo");
    expect(spec.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "bullets", "table"]);
  });
  it("as a step: honours the front end's format, label template and folder, records a deliverable with provenance and an artifact", async () => {
    const w = wf("wf_x_output", [
      N("start", "trigger.manual"),
      N("q", "data.query", { source: "ediscovery", filters: { hot: "true" }, matterId: MATTERS.valsara, limit: 5 }),
      N("file", "output.file", { format: "{{inputs.output_format | default:\"docx\"}}", label: "{{inputs.output_label | default:\"\"}}", content: "# Hot documents\n\n{{steps.q.output.text}}", rows: "{{steps.q.output.rows}}", libraryFolderId: "{{inputs.output_folder | default:\"\"}}", matterId: "{{matter.id}}", addToLibrary: true, tags: ["qc"] }),
    ], [E("start", "q"), E("q", "file")], { frontend: { title: "Hot docs", fields: [{ key: "matter", label: "Matter", type: "matter", required: true }], output: { formats: ["docx", "xlsx"], defaultFormat: "xlsx", defaultLabel: "Hot documents — {{matter.shortName}} — {{now | date:date}}" } } });
    const run = await startRun(w, { inputs: { matter: MATTERS.valsara, output_format: "xlsx" }, matterId: MATTERS.valsara, wait: true });
    expect(run.status, run.error).toBe("succeeded");
    const o = out(run, "file");
    expect(o.format).toBe("xlsx");
    expect(String(o.label)).toMatch(/^Hot documents — Valsara v\. Meridian/);
    expect(String(o.label)).toMatch(/\d{4}-\d{2}-\d{2}$/);
    expect(o.docId).toBeTruthy();
    const d = run.deliverables!.find((x) => x.nodeId === "file")!;
    expect(d).toMatchObject({ kind: "document", format: "xlsx", docId: o.docId, matterId: MATTERS.valsara });
    expect(d.downloadHref).toMatch(/^\/api\/blobs\//);
    expect(d.meta?.source).toBe("output.file"); // no AI upstream: provenance stays undefined rather than claiming trust
    expect(run.artifacts!.filter((a) => a.nodeId === "file").map((a) => a.kind).sort()).toEqual(["document", "file", "library"]);
    expect(db().library.get(d.libraryItemId!)?.tags).toContain("qc");
    // Explicit label wins over the template; unknown formats fail.
    const w2 = wf("wf_x_output2", [N("start", "trigger.manual"), N("file", "output.file", { format: "md", label: "Fixed name", content: "body" })], [E("start", "file")]);
    expect(out(await startRun(w2, { inputs: {}, wait: true }), "file").label).toBe("Fixed name");
    const w3 = wf("wf_x_output3", [N("start", "trigger.manual"), N("file", "output.file", { format: "exe", label: "x", content: "body", onError: "fail" })], [E("start", "file")]);
    expect((await startRun(w3, { inputs: {}, wait: true })).error).toMatch(/Unknown output format/);
  });
});

describe("review.auto (steward)", () => {
  it("chooses allow-listed fixes by error class and computes config patches", () => {
    const all = new Set(["retry", "narrow", "fast_model", "skip_verify"]);
    expect(chooseFix("network", "data.fetch_url", all, new Set())).toBe("retry");
    expect(chooseFix("network", "data.fetch_url", all, new Set(["retry"]))).toBe("narrow");
    expect(chooseFix("network", "data.fetch_url", all, new Set(["retry", "narrow"]))).toBe("escalate");
    expect(chooseFix("timeout", "ai.summarize", all, new Set())).toBe("fast_model");
    expect(chooseFix("timeout", "data.fetch_url", all, new Set())).toBe("narrow");
    expect(chooseFix("verification", "ai.draft", all, new Set())).toBe("skip_verify");
    expect(chooseFix("verification", "ai.draft", new Set(["retry"]), new Set())).toBe("escalate");
    expect(chooseFix("not_configured", "ai.draft", all, new Set())).toBe("escalate");
    expect(chooseFix("cancelled", "ai.draft", all, new Set())).toBe("none");
    expect(chooseFix("empty", "data.query", all, new Set())).toBe("none");
    expect(chooseFix("parse", "data.fetch_url", all, new Set())).toBe("narrow");
    expect(fixPatch("narrow", { limit: 10, maxDocs: 100, timeoutSec: 100 })).toEqual({ limit: 5, maxDocs: 50, timeoutSec: 150 });
    expect(fixPatch("fast_model", {})).toEqual({ modelTier: "fast", timeoutSec: 270 });
    expect(fixPatch("skip_verify", {})).toEqual({ verify: false });
    expect(fixPatch("retry", { limit: 3 })).toEqual({});
  });
  it("re-runs a failed step with a fix, escalates what stays broken to the review queue and records stewardship on the run", async () => {
    const w = wf("wf_x_steward", [
      N("start", "trigger.manual"),
      N("fetch", "intel.fetch", { sourceId: "", adapter: "web-list", config: JSON.stringify({ pages: 1, fail: true }), mode: "run", onError: "continue" }),
      N("url", "data.fetch_url", { url: "http://127.0.0.1:9/nothing", onError: "continue", timeoutSec: 5, retries: 0 }),
      N("ok", "action.create_task", { title: "Still runs", requireTrusted: false }),
      N("steward", "review.auto", { steps: "", fixes: ["retry", "narrow"], maxFixes: 3, escalate: true, reviewerId: PEOPLE.aishaKhan, stopOnEscalate: false }),
    ], [E("start", "fetch"), E("start", "url"), E("start", "ok"), E("fetch", "steward"), E("url", "steward"), E("ok", "steward")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    // Two steps stayed broken and were escalated: the run is partial, never reported as a clean success.
    expect(run.status, run.error).toBe("partial");
    expect(stepOf(run, "ok").status).toBe("succeeded");
    const s = out(run, "steward") as { checked: number; fixed: number; escalated: number; notes: string[]; failures: { nodeId: string; code: string; action: string; ok: boolean }[] };
    expect(s.checked).toBe(2);
    expect(s.fixed + s.escalated).toBeGreaterThanOrEqual(1);
    expect(s.failures.map((f) => f.nodeId).sort()).toEqual(["fetch", "url"]);
    for (const f of s.failures) expect(["retry", "narrow", "escalate", "none"]).toContain(f.action);
    expect(run.stewardship!.length).toBeGreaterThanOrEqual(2);
    expect(stepOf(run, "steward").logs!.some((l) => /Steward:/.test(l))).toBe(true);
    if (s.escalated) {
      const queue = listReviewQueue({ kind: "workflow.step", status: "pending" });
      expect(queue.some((q) => q.id.startsWith(run.id))).toBe(true);
    }
    // stopOnEscalate fails the run when something was escalated.
    const w2 = wf("wf_x_steward_stop", [
      N("start", "trigger.manual"),
      N("summ", "ai.summarize", { source: "hello", onError: "continue" }),
      N("steward", "review.auto", { steps: "summ", fixes: ["retry"], escalate: true, stopOnEscalate: true }),
    ], [E("start", "summ"), E("summ", "steward")]);
    const r2 = await startRun(w2, { inputs: {}, wait: true });
    expect(r2.status).toBe("failed");
    expect(r2.error).toMatch(/escalated 1 step/);
    expect(stepOf(r2, "steward").status).toBe("failed");
    expect(stepOf(r2, "steward").logs!.some((l) => /1 escalated/.test(l))).toBe(true);
    expect(r2.stewardship!.some((x) => x.nodeId === "summ" && x.code === "not_configured" && x.action === "escalate" && !x.fixed && x.escalated)).toBe(true);
    expect(listReviewQueue({ kind: "workflow.step", status: "pending" }).some((q) => q.id === `${r2.id}:summ`)).toBe(true);
    // Nothing failed: a clean report.
    const w3 = wf("wf_x_steward_clean", [N("start", "trigger.manual"), N("ok", "action.notify", { message: "hi" }), N("steward", "review.auto", {})], [E("start", "ok"), E("ok", "steward")]);
    const r3 = await startRun(w3, { inputs: {}, wait: true });
    expect(out(r3, "steward")).toMatchObject({ checked: 0, fixed: 0, escalated: 0 });
  });
  it("escalateStep registers a pending provenance sidecar", () => {
    const existing = db().workflowRuns.all()[0];
    const run = { id: existing.id, matterId: MATTERS.valsara } as WorkflowRunRecord;
    escalateStep({ run, workflow: { id: "wf_x", name: "Esc" } } as never, "n1", "Node one", "parse: bad payload", PEOPLE.aishaKhan);
    const q = listReviewQueue({ kind: "workflow.step", status: "pending" }).find((x) => x.id === `${existing.id}:n1`);
    expect(q).toBeTruthy();
    expect(q!.title).toMatch(/Esc › Node one/);
  });
});

describe("logic.schedule_after and after-run settings", () => {
  it("starts a child workflow with mapped inputs and records the child run", async () => {
    const child = wf("wf_x_child", [N("start", "trigger.manual"), N("t", "action.create_task", { title: "Child got {{inputs.note}} from {{inputs.parent_workflow}}" })], [E("start", "t")]);
    const parent = wf("wf_x_parent", [
      N("start", "trigger.manual"),
      N("file", "output.file", { format: "md", label: "Parent note", content: "hello" }),
      N("next", "logic.schedule_after", { workflowId: child.id, inputs: { note: "{{steps.file.output.label}}" }, includeInputs: true, wait: true }),
    ], [E("start", "file"), E("file", "next")]);
    const run = await startRun(parent, { inputs: { seed: 1 }, wait: true });
    expect(run.status, run.error).toBe("succeeded");
    const o = out(run, "next");
    expect(o.workflowId).toBe(child.id);
    expect(o.status).toBe("succeeded");
    expect(run.childRunIds).toContain(o.runId);
    const childRun = db().workflowRuns.get(o.runId as string) as WorkflowRunRecord;
    expect(childRun.parentRunId).toBe(run.id);
    expect(childRun.inputs).toMatchObject({ seed: 1, note: "Parent note", parent_run_id: run.id, parent_workflow: "wf_x_parent" });
    expect((childRun.inputs.parent_deliverables as unknown[]).length).toBe(1);
    expect(db().tasks.find((t) => t.title === "Child got Parent note from wf_x_parent")).toHaveLength(1);
    const self = wf("wf_x_self", [N("start", "trigger.manual"), N("next", "logic.schedule_after", { workflowId: "wf_x_self", onError: "fail" })], [E("start", "next")]);
    expect((await startRun(self, { inputs: {}, wait: true })).error).toMatch(/cannot start itself/);
  });
  it("executes the front end's after-run task and chained workflow once the run succeeds", async () => {
    const chained = wf("wf_x_chained", [N("start", "trigger.manual"), N("n", "action.notify", { message: "chained from {{inputs.parent_workflow}}" })], [E("start", "n")]);
    const w = wf("wf_x_after", [N("start", "trigger.manual"), N("file", "output.file", { format: "md", label: "Deliverable", content: "body" })], [E("start", "file")], {
      frontend: { title: "After", fields: [{ key: "topic", label: "Topic", type: "text", required: true }], output: { notifyPeopleIds: [PEOPLE.priyaRaman] }, after: { createTask: { title: "Read {{inputs.topic}} output", assigneeId: PEOPLE.eshaMathur, dueRule: "+2d" }, triggerWorkflowIds: [chained.id] } },
    });
    const run = await startRun(w, { inputs: { topic: "AOX" }, wait: true });
    expect(run.status, run.error).toBe("succeeded");
    expect(run.followUps).toBeTruthy();
    expect(run.followUps!.taskIds).toHaveLength(1);
    const task = db().tasks.get(run.followUps!.taskIds[0])!;
    expect(task.title).toBe("Read AOX output");
    expect(task.assigneeId).toBe(PEOPLE.eshaMathur);
    expect(task.description).toContain("Deliverable");
    expect(run.followUps!.triggered).toHaveLength(1);
    expect(run.followUps!.triggered[0].workflowId).toBe(chained.id);
    expect(run.childRunIds).toContain(run.followUps!.triggered[0].runId);
    expect(run.followUps!.notified).toEqual([PEOPLE.priyaRaman]);
    // Validation of front-end values happens before the run starts (manual runs only).
    await expect(startRun(w, { inputs: {} })).rejects.toThrow(/Missing required input|Invalid input/);
    await expect(startRun({ ...w, id: "wf_x_after_b", inputs: [], frontend: { ...w.frontend!, fields: [{ key: "doc", label: "Doc", type: "file", required: true, accept: [".pdf"] }] } }, { inputs: { doc: "", doc_file: { blobId: "b", name: "x.txt", mime: "text/plain", size: 1 } } })).rejects.toThrow(/accepted types/);
  });
});

describe("agent steps without a key", () => {
  it("ai.route and ai.agent validate their configuration first and then fail with no_api_key", async () => {
    const w = wf("wf_x_route", [N("start", "trigger.manual"), N("route", "ai.route", { input: "Please draft a meet-and-confer letter", branches: [{ id: "draft", label: "Drafting", agent: "drafter" }, { id: "research", label: "Research", agent: "research" }] })], [E("start", "route")]);
    const run = await startRun(w, { inputs: {}, wait: true });
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("no_api_key");
    const noBranches = wf("wf_x_route2", [N("start", "trigger.manual"), N("route", "ai.route", { input: "x", branches: [] })], [E("start", "route")]);
    expect((await startRun(noBranches, { inputs: {}, wait: true })).error).toMatch(/No branches/);
    const agent = wf("wf_x_agent", [N("start", "trigger.manual"), N("a", "ai.agent", { agent: "research", brief: "Find the standard for spoliation sanctions in the Fourth Circuit." })], [E("start", "a")]);
    const r2 = await startRun(agent, { inputs: {}, wait: true });
    expect(r2.status).toBe("failed");
    expect(r2.errorCode).toBe("no_api_key");
    const badAgent = wf("wf_x_agent2", [N("start", "trigger.manual"), N("a", "ai.agent", { agent: "wizard", brief: "x" })], [E("start", "a")]);
    expect((await startRun(badAgent, { inputs: {}, wait: true })).error).toMatch(/Unknown agent/);
    const emptyBrief = wf("wf_x_agent3", [N("start", "trigger.manual"), N("a", "ai.agent", { agent: "drafter", brief: "" })], [E("start", "a")]);
    expect((await startRun(emptyBrief, { inputs: {}, wait: true })).error).toMatch(/brief is empty/);
  });
});
