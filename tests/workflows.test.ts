import { beforeAll, describe, expect, it } from "vitest";

process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
delete process.env.OPENAI_API_KEY;

import { db, resetSqlite } from "@/lib/db";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@/lib/types/domain";
import { evaluateExpression, getPath, isSingleExpression, markdownTable, parseExpression, referencedStepIds, resolveDateRule, resolveDeep, resolveTemplate, resolveText, type ResolveReport } from "@/modules/workflows/template-expr";
import { autoLayout, executionPlan, findCycleNodes, loopBodies, topologicalOrder, upstreamOf, validateWorkflow } from "@/modules/workflows/graph";
import { compare, evaluateBranch } from "@/modules/workflows/conditions";
import { describeSchedule, nextRunAt } from "@/modules/workflows/schedule";
import { validateGeneratedDraft, workflowUpsertSchema } from "@/modules/workflows/schema";
import { buildTemplates, WORKFLOW_TEMPLATE_IDS } from "@/modules/workflows/templates";
import { defaultConfigFor, KNOWN_NODE_TYPES, NODE_TYPES, sourceHandles } from "@/modules/workflows/registry";
import { cancelRun, createRunRecord, estimateCostUsd, rerun, resumeRun, startRun } from "@/modules/workflows/engine";
import { cloneWorkflow, createWorkflow, getRun, listRuns, listWorkflows, summarizeRun, updateWorkflow, workflowMeta, workflowStats } from "@/modules/workflows/service";
import { tick } from "@/modules/workflows/scheduler";
import { WORKFLOW_SEED_IDS } from "@/modules/workflows/seed";
import { tableFromRows, workbookFromRows } from "@/modules/workflows/executors";
import { recentRunEvents, subscribeRunEvents } from "@/modules/workflows/events";
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

beforeAll(() => { resetSqlite(); db(); });

// ─────────────────────────── Template expressions ───────────────────────────

describe("template expressions", () => {
  const ctx = {
    inputs: { name: "Snowfield Reseller LLC", count: 3, text: "hello" },
    steps: { extract: { output: { parties: ["Harborline", "Snowfield"], term_months: 36, nested: { deep: { value: "x" } } } }, search: { output: { results: [{ bates: "MFC-0043877", subject: "RE: 8(e)" }, { bates: "MFC-0043881", subject: "FW: Voss" }] } } },
    matter: { id: "m_1", name: "Northgate v. Apex" },
    now: "2026-09-23T12:00:00.000Z",
  };
  it("interpolates and stringifies", () => {
    expect(resolveText("Client: {{inputs.name}} ({{steps.extract.output.term_months}} months)", ctx)).toBe("Client: Snowfield Reseller LLC (36 months)");
    expect(resolveText("{{matter.name}} · {{inputs.count}}", ctx)).toBe("Northgate v. Apex · 3");
  });
  it("returns raw values for single expressions", () => {
    expect(isSingleExpression("{{steps.extract.output.parties}}")).toBe(true);
    expect(isSingleExpression("a {{b}}")).toBe(false);
    expect(resolveTemplate("{{steps.extract.output.parties}}", ctx)).toEqual(["Harborline", "Snowfield"]);
    expect(resolveTemplate("{{steps.extract.output}}", ctx)).toMatchObject({ term_months: 36 });
    expect(resolveTemplate("{{steps.extract.output.nested.deep.value}}", ctx)).toBe("x");
  });
  it("supports array indexes and filters", () => {
    expect(resolveText("{{steps.search.output.results[0].bates}}", ctx)).toBe("MFC-0043877");
    expect(resolveText("{{steps.search.output.results.1.subject}}", ctx)).toBe("FW: Voss");
    expect(resolveText("{{steps.extract.output.parties | join:\" & \"}}", ctx)).toBe("Harborline & Snowfield");
    expect(resolveTemplate("{{steps.search.output.results | pluck:bates}}", ctx)).toEqual(["MFC-0043877", "MFC-0043881"]);
    expect(resolveText("{{steps.search.output.results | length}}", ctx)).toBe("2");
    expect(resolveText("{{inputs.name | upper | truncate:9}}", ctx)).toBe("SNOWFIELD…");
    expect(resolveText("{{inputs.missing | default:\"n/a\"}}", ctx)).toBe("n/a");
    expect(resolveText("{{steps.extract.output.parties | bullets}}", ctx)).toBe("- Harborline\n- Snowfield");
    expect(resolveText("{{now | date:date}}", ctx)).toBe("2026-09-23");
    expect(resolveText("{{now | add_days:33}}", ctx)).toBe("2026-10-26");
    expect(JSON.parse(resolveText("{{steps.extract.output | json:compact}}", ctx))).toMatchObject({ term_months: 36 });
    const table = resolveText("{{steps.search.output.results | table:bates,subject}}", ctx);
    expect(table.split("\n")[0]).toBe("| bates | subject |");
    expect(table).toContain("| MFC-0043881 | FW: Voss |");
    expect(resolveTemplate("{{steps.search.output.results | where:bates,MFC-0043877 | length}}", ctx)).toBe(1);
  });
  it("reports missing paths and unknown filters without throwing", () => {
    const report: ResolveReport = { missing: [], errors: [] };
    expect(resolveText("{{inputs.nope}}/{{inputs.text | nosuchfilter}}", ctx, report)).toBe("/hello");
    expect(report.missing).toEqual(["inputs.nope"]);
    expect(report.errors[0]).toContain("nosuchfilter");
  });
  it("never reads prototypes", () => {
    expect(getPath({ a: 1 }, "__proto__.polluted")).toBeUndefined();
    expect(getPath({ a: 1 }, "constructor.name")).toBeUndefined();
    expect(resolveText("{{inputs.constructor}}", ctx)).toBe("");
  });
  it("parses filters with quoted arguments", () => {
    const p = parseExpression('steps.x.output | join:", " | truncate:5');
    expect(p.path).toBe("steps.x.output");
    expect(p.filters).toEqual([{ name: "join", args: [", "] }, { name: "truncate", args: ["5"] }]);
    expect(evaluateExpression("'literal'", ctx)).toBe("literal");
    expect(evaluateExpression("42", ctx)).toBe(42);
  });
  it("resolves deeply and finds referenced step ids", () => {
    const cfg = { title: "Task for {{inputs.name}}", nested: { items: "{{steps.search.output.results}}", flag: true }, list: ["{{steps.extract.output.term_months}}"] };
    const out = resolveDeep(cfg, ctx);
    expect(out.title).toBe("Task for Snowfield Reseller LLC");
    expect(out.nested.items).toHaveLength(2);
    expect(out.list[0]).toBe(36);
    expect(referencedStepIds(cfg).sort()).toEqual(["extract", "search"]);
  });
  it("resolves date rules", () => {
    const base = new Date("2026-09-23T15:00:00Z"); // Wednesday
    expect(resolveDateRule("+3d", base)!.toISOString().slice(0, 10)).toBe("2026-09-26");
    expect(resolveDateRule("+2w", base)!.toISOString().slice(0, 10)).toBe("2026-10-07");
    expect(resolveDateRule("+3bd", base)!.toISOString().slice(0, 10)).toBe("2026-09-28"); // skips the weekend
    expect(resolveDateRule("2026-10-14", base)!.toISOString().slice(0, 10)).toBe("2026-10-14");
    expect(resolveDateRule("next-friday", base)!.getDay()).toBe(5);
    expect(resolveDateRule("", base)).toBeNull();
    expect(resolveDateRule("garbage", base)).toBeNull();
  });
  it("builds markdown tables from arrays of objects", () => {
    expect(markdownTable([{ a: 1, b: "x|y" }])).toBe("| a | b |\n| --- | --- |\n| 1 | x\\|y |");
    expect(markdownTable([])).toBe("");
  });
});

// ─────────────────────────── Graph ───────────────────────────

describe("graph utilities", () => {
  it("orders a DAG topologically and detects cycles", () => {
    const nodes = [N("t", "trigger.manual"), N("a", "ai.prompt"), N("b", "ai.prompt"), N("c", "action.notify")];
    const edges = [E("t", "a"), E("t", "b"), E("a", "c"), E("b", "c")];
    const order = topologicalOrder(nodes, edges)!;
    expect(order[0]).toBe("t");
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b"));
    expect(findCycleNodes(nodes, edges)).toEqual([]);
    const cyclic = [...edges, E("c", "a")];
    expect(topologicalOrder(nodes, cyclic)).toBeNull();
    expect(findCycleNodes(nodes, cyclic).sort()).toEqual(["a", "c"]);
    const v = validateWorkflow(nodes, cyclic);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === "cycle")).toBe(true);
  });
  it("allows loop-back edges into a loop node only", () => {
    const nodes = [N("t", "trigger.manual"), N("loop", "logic.loop", { over: "{{inputs.items}}" }), N("body", "action.create_task", { title: "x" }), N("done", "action.notify", { message: "m" })];
    const edges = [E("t", "loop"), E("loop", "body", "each"), E("body", "loop", undefined, "loop-back"), E("loop", "done", "done")];
    const v = validateWorkflow(nodes, edges);
    expect(v.ok).toBe(true);
    const { bodies } = loopBodies(nodes, edges);
    expect(bodies[0]).toMatchObject({ loopId: "loop", body: ["body"] });
    const plan = executionPlan(nodes, edges);
    expect(plan.order).toEqual(["t", "loop", "done"]);
    expect(plan.loops.loop.bodyOrder).toEqual(["body"]);
    const bad = [...edges, E("done", "body", undefined, "loop-back")];
    expect(validateWorkflow(nodes, bad).issues.some((i) => i.code === "bad_loop_back")).toBe(true);
  });
  it("requires exactly one trigger and flags dangling references", () => {
    const two = validateWorkflow([N("t", "trigger.manual"), N("t2", "trigger.schedule")], []);
    expect(two.issues.some((i) => i.code === "multiple_triggers")).toBe(true);
    const none = validateWorkflow([N("a", "ai.prompt")], []);
    expect(none.issues.some((i) => i.code === "no_trigger")).toBe(true);
    const dangling = validateWorkflow([N("t", "trigger.manual")], [E("t", "ghost")]);
    expect(dangling.issues.some((i) => i.code === "dangling_edge")).toBe(true);
    const badRef = validateWorkflow([N("t", "trigger.manual"), N("a", "action.notify", { message: "{{steps.nope.output.text}}" })], [E("t", "a")]);
    expect(badRef.issues.some((i) => i.code === "unknown_step_ref")).toBe(true);
    const unknown = validateWorkflow([{ ...N("t", "trigger.manual"), type: "ai.magic" as WorkflowNode["type"] }], []);
    expect(unknown.issues.some((i) => i.code === "unknown_type")).toBe(true);
  });
  it("lays out nodes by rank and finds upstream nodes", () => {
    const nodes = [N("t", "trigger.manual"), N("a", "ai.prompt"), N("b", "ai.prompt"), N("c", "action.notify")];
    const edges = [E("t", "a"), E("t", "b"), E("a", "c"), E("b", "c")];
    const laid = autoLayout(nodes, edges);
    const pos = Object.fromEntries(laid.map((n) => [n.id, n.position]));
    expect(pos.a.x).toBeGreaterThan(pos.t.x);
    expect(pos.c.x).toBeGreaterThan(pos.a.x);
    expect(pos.a.x).toBe(pos.b.x);
    expect(pos.a.y).not.toBe(pos.b.y);
    expect(upstreamOf(nodes, edges, "c").sort()).toEqual(["a", "b", "t"]);
  });
  it("exposes dynamic branch handles", () => {
    const handles = sourceHandles("logic.branch", { rules: [{ id: "high", label: "High" }], elseLabel: "Low" });
    expect(handles.map((h) => h.id)).toEqual(["high", "else"]);
    expect(sourceHandles("logic.loop", {}).map((h) => h.id)).toEqual(["each", "done"]);
    expect(sourceHandles("ai.prompt", {}).map((h) => h.id)).toEqual(["out"]);
  });
  it("ships 19 valid templates with every node type known", () => {
    const templates = buildTemplates();
    expect(templates).toHaveLength(19);
    for (const t of templates) {
      const v = validateWorkflow(t.nodes, t.edges);
      expect(v.ok, `${t.id}: ${v.issues.map((i) => i.message).join("; ")}`).toBe(true);
      expect(v.issues.filter((i) => i.level === "warning"), t.id).toHaveLength(0);
      for (const n of t.nodes) expect(KNOWN_NODE_TYPES).toContain(n.type);
    }
    expect(NODE_TYPES.length).toBeGreaterThanOrEqual(27);
  });
});

// ─────────────────────────── Conditions ───────────────────────────

describe("branch conditions", () => {
  it("compares values with type coercion", () => {
    expect(compare("equals", "High", "high")).toBe(true);
    expect(compare("equals", 3, "3")).toBe(true);
    expect(compare("gt", "12", "9")).toBe(true);
    expect(compare("gt", "abc", "abd")).toBe(false);
    expect(compare("contains", ["a", "B"], "b")).toBe(true);
    expect(compare("in", "medium", "low, medium, high")).toBe(true);
    expect(compare("is_empty", [])).toBe(true);
    expect(compare("not_empty", "x")).toBe(true);
    expect(compare("truthy", "false")).toBe(false);
    expect(compare("regex", "MFC-0043877", "^MFC-\\d{7}$")).toBe(true);
    expect(compare("starts_with", "Hello", "he")).toBe(true);
  });
  it("evaluates rules in order and falls back to else", () => {
    const ctx = { steps: { classify: { output: { label: "medium", confidence: 0.8 } }, search: { output: { results: [1, 2] } } } };
    const rules = [
      { id: "high", label: "High", logic: "all" as const, conditions: [{ left: "{{steps.classify.output.label}}", op: "equals" as const, right: "high" }] },
      { id: "medium", label: "Medium", logic: "all" as const, conditions: [{ left: "{{steps.classify.output.label}}", op: "equals" as const, right: "medium" }, { left: "{{steps.search.output.results | length}}", op: "gt" as const, right: "0" }] },
    ];
    const r = evaluateBranch(rules, ctx);
    expect(r.matched).toBe("medium");
    expect(r.evaluations[0].matched).toBe(false);
    expect(evaluateBranch(rules, { steps: { classify: { output: { label: "low" } }, search: { output: { results: [] } } } }).matched).toBe("else");
    expect(evaluateBranch([{ id: "any", logic: "any", conditions: [{ left: "{{x}}", op: "truthy" }, { left: "yes", op: "truthy" }] }], {}).matched).toBe("any");
  });
});

// ─────────────────────────── Schedule ───────────────────────────

describe("schedules", () => {
  it("computes the next occurrence", () => {
    const from = new Date(2026, 8, 23, 9, 30); // Wed
    expect(nextRunAt({ frequency: "daily", time: "07:00" }, from).getDate()).toBe(24);
    expect(nextRunAt({ frequency: "daily", time: "10:00" }, from).getDate()).toBe(23);
    const weekly = nextRunAt({ frequency: "weekly", time: "06:30", weekday: 1 }, from);
    expect(weekly.getDay()).toBe(1);
    expect(weekly.getDate()).toBe(28);
    const monthly = nextRunAt({ frequency: "monthly", time: "07:00", dayOfMonth: 1 }, from);
    expect(monthly.getMonth()).toBe(9);
    expect(monthly.getDate()).toBe(1);
    expect(nextRunAt({ frequency: "hourly", time: "00:15" }, from).getMinutes()).toBe(15);
    expect(describeSchedule({ frequency: "weekly", time: "06:30", weekday: 1 })).toBe("Weekly on Monday at 06:30");
  });
});

// ─────────────────────────── Generated drafts ───────────────────────────

describe("generated workflow validation", () => {
  it("rejects unknown node types and dangling edges", () => {
    const bad = validateGeneratedDraft({ name: "x", description: "", category: "intake", tags: [], inputs: [], nodes: [{ id: "start", type: "trigger.manual", label: "Start", configJson: "{}" }, { id: "magic", type: "ai.magic", label: "Magic", configJson: "{}" }], edges: [{ source: "start", target: "nowhere", sourceHandle: "", targetHandle: "" }], notes: [] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) { expect(bad.errors.some((e) => e.includes("Unknown node type"))).toBe(true); expect(bad.errors.some((e) => e.includes("missing node"))).toBe(true); }
    const noTrigger = validateGeneratedDraft({ name: "x", description: "", category: "intake", tags: [], inputs: [], nodes: [{ id: "a", type: "ai.prompt", label: "A", configJson: "{}" }], edges: [], notes: [] });
    expect(noTrigger.ok).toBe(false);
  });
  it("accepts a valid draft, fills defaults and keeps inputs", () => {
    const res = validateGeneratedDraft({ name: "NDA triage", description: "d", category: "intake", tags: ["nda"], inputs: [{ key: "nda_text", label: "NDA", type: "file", required: true, options: null, placeholder: null }], nodes: [{ id: "start", type: "trigger.manual", label: "Start", configJson: "{}" }, { id: "extract", type: "ai.extract", label: "Extract", configJson: JSON.stringify({ source: "{{inputs.nda_text}}", fields: [{ name: "parties", type: "string[]", description: "p" }] }) }, { id: "task", type: "action.create_task", label: "Task", configJson: JSON.stringify({ title: "Review {{steps.extract.output.parties | join}}" }) }], edges: [{ source: "start", target: "extract", sourceHandle: "", targetHandle: "" }, { source: "extract", target: "task", sourceHandle: "", targetHandle: "" }], notes: ["Set the assignee"] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.draft.nodes).toHaveLength(3);
      expect(res.draft.nodes[1].config.modelTier).toBe("fast");
      expect(res.draft.inputs[0]).toMatchObject({ key: "nda_text", type: "file", required: true });
      expect(res.draft.edges[0].sourceHandle).toBeUndefined();
    }
    expect(workflowUpsertSchema.safeParse({ name: "x", category: "nope", nodes: [], edges: [] }).success).toBe(false);
  });
});

// ─────────────────────────── Engine ───────────────────────────

describe("engine", () => {
  it("runs a data/action workflow end to end without AI and creates real records", async () => {
    const w = wf("wf_test_e2e", [
      N("start", "trigger.manual"),
      N("search", "data.search_library", { query: "{{inputs.query}}", limit: 5 }),
      N("route", "logic.branch", { rules: [{ id: "yes", label: "Yes", logic: "all", conditions: [{ left: "{{steps.search.output.count}}", op: "gte", right: "0" }] }] }),
      N("task", "action.create_task", { title: "Review {{inputs.title}} ({{steps.search.output.count}} hits)", description: "From run {{run.id}}", assigneeId: PEOPLE.elenaMarsh, priority: "high", dueRule: "+3d", matterId: "{{matter.id}}", tags: ["test"] }),
      N("event", "action.create_event", { title: "Follow-up on {{inputs.title}}", kind: "meeting", startsAt: "+2d 10:00", durationMinutes: 30, attendeeIds: [PEOPLE.jordanWhitfield] }),
      N("never", "action.notify", { message: "should be skipped" }),
      N("merge", "logic.merge"),
      N("notify", "action.notify", { message: "Done: {{steps.task.output.title}}", recipientIds: [PEOPLE.jordanWhitfield], matterId: "{{matter.id}}" }),
      N("export", "action.export", { format: "markdown", filename: "test-export", source: "# Report\n\n{{steps.task.output.title}}", addToLibrary: true }),
    ], [E("start", "search"), E("search", "route"), E("route", "task", "yes"), E("route", "event", "yes"), E("route", "never", "else"), E("task", "merge"), E("event", "merge"), E("never", "merge"), E("merge", "notify"), E("notify", "export")], { inputs: [{ key: "query", label: "Query", type: "text", required: true }, { key: "title", label: "Title", type: "text" }, { key: "matter", label: "Matter", type: "matter" }] });

    const events: string[] = [];
    const rec = createRunRecord(w, { inputs: { query: "engagement letter", title: "Aurora NDA", matter: MATTERS.harbor } });
    expect(rec.matterId).toBe(MATTERS.harbor);

    const tasksBefore = db().tasks.count();
    const run = await startRun(w, { inputs: { query: "engagement letter", title: "Aurora NDA", matter: MATTERS.harbor }, wait: true });
    void subscribeRunEvents(run.id, (e) => events.push(e.type));
    expect(run.status, run.error).toBe("succeeded");
    const st = Object.fromEntries(run.steps.map((s) => [s.nodeId, s.status]));
    expect(st).toMatchObject({ start: "succeeded", search: "succeeded", route: "succeeded", task: "succeeded", event: "succeeded", never: "skipped", merge: "succeeded", notify: "succeeded", export: "succeeded" });
    const taskStep = run.steps.find((s) => s.nodeId === "task")!;
    const out = taskStep.output as { taskId: string; title: string; dueAt: string };
    expect(out.title).toMatch(/^Review Aurora NDA \(\d+ hits\)$/);
    expect(db().tasks.count()).toBe(tasksBefore + 1);
    const task = db().tasks.get(out.taskId)!;
    expect(task.source).toBe("workflow");
    expect(task.matterId).toBe(MATTERS.harbor);
    expect(task.assigneeId).toBe(PEOPLE.elenaMarsh);
    expect(task.dueAt).toBe(new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10));
    expect(task.links?.[0].href).toBe(`/workflows/runs/${run.id}`);
    const merge = run.steps.find((s) => s.nodeId === "merge")!.output as { succeeded: string[]; skipped: string[] };
    expect(merge.succeeded.sort()).toEqual(["event", "task"]);
    expect(merge.skipped).toEqual(["never"]);
    expect(run.artifacts?.map((a) => a.kind).sort()).toEqual(["event", "file", "notification", "task"]);
    const exp = run.steps.find((s) => s.nodeId === "export")!.output as { blobId: string; filename: string };
    expect(exp.filename).toBe("test-export.md");
    expect(new TextDecoder().decode(db().blobs.get(exp.blobId)!.bytes)).toContain("Review Aurora NDA");
    expect(db().updates.find((u) => u.body.startsWith("Done: Review Aurora NDA"))).toHaveLength(1);
    expect(run.outputs && Object.keys(run.outputs)).toContain("task");
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(db().workflows.get(w.id)?.runsCount).toBe(1);
    const recent = recentRunEvents(run.id).map((e) => e.type);
    expect(recent).toContain("node.completed");
    expect(recent).toContain("run.completed");
    expect(recent[recent.length - 1]).toBe("run.done");
    const summary = summarizeRun(getRun(run.id)!);
    expect(summary.stepCounts.succeeded).toBe(8);
    expect(summary.stepCounts.skipped).toBe(1);
    expect(summary.matterName).toBe("Project Harbor");
  });

  it("iterates loops with per-item context, bounded and with loop-back edges", async () => {
    const w = wf("wf_test_loop", [
      N("start", "trigger.manual"),
      N("loop", "logic.loop", { over: "{{inputs.items}}", maxIterations: 3, itemLabel: "item" }),
      N("task", "action.create_task", { title: "Item {{loop.number}}/{{loop.count}}: {{loop.item.name}}", dueRule: "+1d" }),
      N("done", "action.notify", { message: "Processed {{steps.loop.output.count}} of {{steps.loop.output.total}}: {{steps.loop.output.results | pluck:steps.task.title | join:\"; \"}}" }),
    ], [E("start", "loop"), E("loop", "task", "each"), E("task", "loop", undefined, "loop-back"), E("loop", "done", "done")]);
    const items = Array.from({ length: 5 }, (_, i) => ({ name: `Doc ${i + 1}` }));
    const run = await startRun(w, { inputs: { items }, wait: true });
    expect(run.status, run.error).toBe("succeeded");
    const loop = run.steps.find((s) => s.nodeId === "loop")!.output as { count: number; total: number; results: { steps: { task: { title: string } } }[] };
    expect(loop.total).toBe(5);
    expect(loop.count).toBe(3);
    expect(loop.results.map((r) => r.steps.task.title)).toEqual(["Item 1/3: Doc 1", "Item 2/3: Doc 2", "Item 3/3: Doc 3"]);
    expect(run.loopIterations?.loop).toHaveLength(3);
    const done = run.steps.find((s) => s.nodeId === "done")!;
    expect((done.input as { message: string }).message).toBe("Processed 3 of 5: Item 1/3: Doc 1; Item 2/3: Doc 2; Item 3/3: Doc 3");
  });

  it("pauses on approval and resumes down the approved or rejected path", async () => {
    const w = wf("wf_test_approval", [
      N("start", "trigger.manual"),
      N("approval", "logic.approval", { approverId: PEOPLE.jordanWhitfield, title: "Sign off {{inputs.doc}}", message: "Please review {{inputs.doc}}" }),
      N("ok", "action.create_task", { title: "Circulate {{inputs.doc}} — {{steps.approval.output.comment}}" }),
      N("no", "action.create_task", { title: "Revise {{inputs.doc}} — {{steps.approval.output.comment}}" }),
    ], [E("start", "approval"), E("approval", "ok", "approved"), E("approval", "no", "rejected")]);
    const paused = await startRun(w, { inputs: { doc: "Memo v2" }, wait: true });
    expect(paused.status).toBe("waiting_approval");
    expect(paused.approvals?.[0]).toMatchObject({ nodeId: "approval", title: "Sign off Memo v2", message: "Please review Memo v2", approverId: PEOPLE.jordanWhitfield });
    expect(paused.steps.find((s) => s.nodeId === "approval")!.status).toBe("waiting_approval");
    expect(paused.steps.find((s) => s.nodeId === "ok")!.status).toBe("pending");
    await expect(resumeRun("run_nope", { approved: true })).rejects.toThrow(/not found/);
    const resumed = await resumeRun(paused.id, { approved: true, comment: "Looks good" }, { wait: true });
    expect(resumed.status, resumed.error).toBe("succeeded");
    const st = Object.fromEntries(resumed.steps.map((s) => [s.nodeId, s.status]));
    expect(st).toMatchObject({ approval: "succeeded", ok: "succeeded", no: "skipped" });
    expect((resumed.steps.find((s) => s.nodeId === "ok")!.output as { title: string }).title).toBe("Circulate Memo v2 — Looks good");
    await expect(resumeRun(paused.id, { approved: true })).rejects.toThrow(/not waiting/);

    const second = await startRun(w, { inputs: { doc: "Memo v3" }, wait: true });
    const rejected = await resumeRun(second.id, { approved: false, comment: "Cite check first" }, { wait: true });
    expect(rejected.status).toBe("succeeded");
    expect(Object.fromEntries(rejected.steps.map((s) => [s.nodeId, s.status]))).toMatchObject({ ok: "skipped", no: "succeeded" });

    // Rejection with no rejected path cancels the run.
    const w2 = wf("wf_test_approval2", [N("start", "trigger.manual"), N("approval", "logic.approval", { title: "t", message: "m" }), N("ok", "action.notify", { message: "x" })], [E("start", "approval"), E("approval", "ok", "approved")]);
    const p2 = await startRun(w2, { wait: true });
    const c2 = await resumeRun(p2.id, { approved: false, comment: "No" }, { wait: true });
    expect(c2.status).toBe("cancelled");
    expect(c2.errorCode).toBe("rejected");
    expect(c2.steps.find((s) => s.nodeId === "ok")!.status).toBe("skipped");
  });

  it("fails AI steps clearly without an API key while data/action steps still work", async () => {
    const w = wf("wf_test_ai", [
      N("start", "trigger.manual"),
      N("task", "action.create_task", { title: "Before AI" }),
      N("summ", "ai.summarize", { source: "{{inputs.text}}", retries: 2 }),
      N("after", "action.notify", { message: "after" }),
    ], [E("start", "task"), E("task", "summ"), E("summ", "after")]);
    const run = await startRun(w, { inputs: { text: "Some deposition text." }, wait: true });
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("no_api_key");
    expect(run.error).toMatch(/OpenAI key required/);
    const st = Object.fromEntries(run.steps.map((s) => [s.nodeId, s.status]));
    expect(st).toMatchObject({ task: "succeeded", summ: "failed", after: "skipped" });
    expect(run.steps.find((s) => s.nodeId === "summ")!.logs?.some((l) => /retrying/.test(l))).toBe(false); // config errors are never retried
    expect(recentRunEvents(run.id).some((e) => e.type === "error" && e.code === "no_api_key")).toBe(true);
  });

  it("validates inputs and graphs before starting", async () => {
    const w = wf("wf_test_inputs", [N("start", "trigger.manual"), N("n", "action.notify", { message: "hi {{inputs.name}}" })], [E("start", "n")], { inputs: [{ key: "name", label: "Name", type: "text", required: true }] });
    await expect(startRun(w, { inputs: {} })).rejects.toThrow(/Missing required input/);
    const broken = { ...w, id: "wf_test_broken", edges: [E("start", "n"), E("n", "start")] };
    await expect(startRun(broken, { inputs: { name: "x" } })).rejects.toThrow(/not runnable/);
  });

  it("cancels a run that is waiting in a delay step and can re-run it", async () => {
    const w = wf("wf_test_cancel", [N("start", "trigger.manual"), N("wait", "logic.delay", { minutes: 5 }), N("after", "action.notify", { message: "never" })], [E("start", "wait"), E("wait", "after")]);
    const run = await startRun(w, { inputs: {} });
    await new Promise((r) => setTimeout(r, 60));
    expect(getRun(run.id)!.steps.find((s) => s.nodeId === "wait")!.status).toBe("running");
    cancelRun(run.id);
    await new Promise((r) => setTimeout(r, 100));
    const after = getRun(run.id)!;
    expect(after.status).toBe("cancelled");
    expect(after.steps.find((s) => s.nodeId === "after")!.status).toBe("skipped");
    const again = await rerun(run.id);
    expect(again.parentRunId).toBe(run.id);
    expect(again.workflowId).toBe(w.id);
    cancelRun(again.id);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("estimates cost by tier and builds workbooks from rows", () => {
    expect(estimateCostUsd({ input: 1_000_000, output: 0 }, "primary")).toBeCloseTo(2.5);
    expect(estimateCostUsd({ input: 0, output: 1_000_000 }, "fast")).toBeCloseTo(2);
    const table = tableFromRows("Sheet", [{ clause: "Term", risk: "Low" }, { clause: "Indemnity", risk: "High", note: "cap" }]);
    expect(table.sheets[0].header).toEqual(["clause", "risk", "note"]);
    expect(table.sheets[0].rows).toHaveLength(3);
    expect(table.sheets[0].rows[2]).toEqual(["Indemnity", "High", "cap"]);
    const wb = workbookFromRows("Sheet", [{ clause: "Term", risk: "Low" }, { clause: "Indemnity", risk: "High", note: "cap" }]);
    expect(wb.sheets[0].cells["A1"]?.v).toBe("clause");
    expect(wb.sheets[0].cells["A3"]?.v).toBe("Indemnity");
    expect(wb.sheets[0].freeze.rows).toBe(1);
    const csv = tableFromRows("S", "a,b\n1,2\n3,4");
    expect(csv.sheets[0].rows).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    const md = tableFromRows("S", "| x | y |\n| --- | --- |\n| 1 | 2 |");
    expect(md.sheets[0].rows).toEqual([["x", "y"], ["1", "2"]]);
  });

  it("updates e-discovery coding and saves Word documents through the office service", async () => {
    const d = db();
    d.edocs.put({ id: "ed_test_1", matterId: MATTERS.afff, bates: "MFC-TEST-0001", date: "2031-01-01", custodianId: PEOPLE.robertKaine, custodianName: "Robert Kaine", type: "Email", subject: "Test privileged email", text: "privileged legal advice about reporting", coding: {} });
    const w = wf("wf_test_coding", [
      N("start", "trigger.manual"),
      N("search", "data.search_ediscovery", { query: "*", matterId: MATTERS.afff, limit: 1 }),
      N("code", "action.update_coding", { documents: "{{steps.search.output.results | pluck:bates}}", field: "privileged", value: "true", note: "coded in test" }),
      N("doc", "action.save_document", { kind: "word", title: "Memo {{inputs.n}}", content: "# Memo {{inputs.n}}\n\nCoded {{steps.code.output.updated}} document(s).\n\n- MFC-TEST-0001", matterId: MATTERS.afff }),
      N("sheet", "action.save_document", { kind: "sheet", title: "Log", rows: "{{steps.search.output.results}}", matterId: MATTERS.afff }),
    ], [E("start", "search"), E("search", "code"), E("code", "doc"), E("code", "sheet")]);
    const run = await startRun(w, { inputs: { n: "1" }, wait: true });
    expect(run.status, run.error).toBe("succeeded");
    expect(d.edocs.get("ed_test_1")!.coding.privileged).toBe(true);
    expect(d.edocs.get("ed_test_1")!.coding.notes).toContain("coded in test");
    const doc = run.steps.find((s) => s.nodeId === "doc")!.output as { docId: string; href: string };
    expect(doc.href).toBe(`/office/word/${doc.docId}`);
    const office = d.officeDocs.get(doc.docId)!;
    expect(office.kind).toBe("word");
    expect(office.title).toBe("Memo 1");
    expect(d.library.find((l) => l.officeDocId === doc.docId)).toHaveLength(1);
    const sheet = run.steps.find((s) => s.nodeId === "sheet")!.output as { docId: string; kind: string };
    expect(d.officeDocs.get(sheet.docId)!.kind).toBe("sheet");
  });
});

// ─────────────────────────── Service, seeds, scheduler ───────────────────────────

describe("service and seeds", () => {
  it("seeds templates, user workflows and runs", () => {
    const templates = listWorkflows({ template: true });
    expect(templates).toHaveLength(19);
    expect(templates.every((t) => t.status === "active" && t.nodeCount >= 5)).toBe(true);
    const mine = listWorkflows({ template: false, system: false }).filter((w) => w.id.startsWith("wf_") && !w.id.startsWith("wf_test"));
    expect(mine.length).toBeGreaterThanOrEqual(4);
    const scheduled = mine.filter((w) => w.schedule);
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
    expect(scheduled[0].nextRunAt).toBeTruthy();
    const runs = db().workflowRuns.find((r) => r.id.startsWith("run_seed_"));
    expect(runs.length).toBeGreaterThanOrEqual(10);
    const statuses = new Set(runs.map((r) => r.status));
    expect(statuses.has("succeeded") && statuses.has("failed") && statuses.has("waiting_approval")).toBe(true);
    for (const r of runs) expect(db().workflows.has(r.workflowId), r.id).toBe(true);
    expect(WORKFLOW_SEED_IDS.runs).toHaveLength(13);
  });
  it("clones templates into drafts, updates and lists", () => {
    const clone = cloneWorkflow(WORKFLOW_TEMPLATE_IDS.ndaIntake, { name: "My NDA flow" })!;
    expect(clone.isTemplate).toBe(false);
    expect(clone.status).toBe("draft");
    expect(clone.sourceTemplateId).toBe(WORKFLOW_TEMPLATE_IDS.ndaIntake);
    expect(clone.nodes).toHaveLength(10);
    const updated = updateWorkflow(clone.id, { name: "Renamed", status: "active" })!;
    expect(updated.workflow.name).toBe("Renamed");
    expect(updated.workflow.version).toBe(2);
    expect(listWorkflows({ q: "renamed" }).map((w) => w.id)).toContain(clone.id);
    const created = createWorkflow({ name: "Blank", category: "operations", nodes: [{ id: "start", type: "trigger.manual", label: "Start", position: { x: 0, y: 0 }, config: {} }], edges: [] });
    expect(created.workflow.nodes[0].config).toHaveProperty("note");
    const stats = workflowStats();
    expect(stats.templates).toBe(19);
    expect(stats.runs).toBeGreaterThanOrEqual(10);
    expect(stats.byCategory.discovery).toBeGreaterThan(0);
    const meta = workflowMeta();
    expect(meta.aiConfigured).toBe(false);
    expect(meta.people.length).toBeGreaterThan(3);
    const list = listRuns({ status: "waiting_approval" });
    expect(list.runs.every((r) => r.status === "waiting_approval")).toBe(true);
    expect(listRuns({ q: "docket" }).runs.length).toBeGreaterThan(0);
  });
  /** Scheduled runs finish asynchronously: poll for `count` settled runs instead of sleeping a fixed time (flaky under load). */
  async function settledRuns(workflowId: string, count: number, timeoutMs = 15_000) {
    const started = Date.now();
    for (;;) {
      const runs = listRuns({ workflowId }).runs;
      if (runs.filter((r) => r.status !== "running" && r.status !== "queued").length >= count) return runs;
      if (Date.now() - started > timeoutMs) return runs;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  it("fires due schedules through the scheduler tick", async () => {
    const w = wf("wf_test_sched", [N("sched", "trigger.schedule", { schedule: { frequency: "daily", time: "06:00" }, enabled: true, presetInputs: { who: "Maria" } }), N("task", "action.create_task", { title: "Scheduled for {{inputs.who}} at {{steps.sched.output.scheduledFor | date:date}}" })], [E("sched", "task")]);
    db().kv.set(`wf:schedule:last:${w.id}`, new Date(Date.now() - 3 * 86_400_000).toISOString());
    const res = await tick(new Date(), {});
    expect(res.fired).toContain(w.id);
    const run = (await settledRuns(w.id, 1))[0];
    expect(run.triggeredBy).toBe("schedule");
    expect(run.status).toBe("succeeded");
    const task = db().tasks.find((t) => t.title.startsWith("Scheduled for Maria"));
    expect(task).toHaveLength(1);
    // Not due again right away.
    const again = await tick(new Date(), {});
    expect(again.fired).not.toContain(w.id);
    // Forced fire ignores the schedule.
    const forced = await tick(new Date(), { force: [w.id] });
    expect(forced.fired).toContain(w.id);
    await settledRuns(w.id, 2);
  });
});
