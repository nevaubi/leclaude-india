import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * "New order → action items" picks the matter's order in code: exact identifier matches from the official-sources
 * facade, the latest by date, an explicit status when none — never a model choosing among free-text search hits — and
 * the review before anything is filed, calendared or tasked always needs a person. The model runtime is faked.
 */
vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/wf-official-order-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUST_HEADER;
  delete process.env.LECLAUDE_USER_ID;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

const agentCalls: { schema?: string; input: unknown }[] = [];
let extraction: Record<string, unknown> = {};

vi.mock("@/lib/ai/agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/agent")>();
  return {
    ...real,
    generateJSON: async () => { throw new Error("no verifier model in this test"); },
    runAgent: async (opts: { jsonSchema?: { name: string }; input: unknown; onEvent?: (e: unknown) => void }) => {
      agentCalls.push({ schema: opts.jsonSchema?.name, input: opts.input });
      const text = JSON.stringify(extraction);
      opts.onEvent?.({ type: "done", responseId: "r", usage: { input: 10, output: 5, total: 15 }, text });
      return { text, responseId: "r", steps: 0, toolCalls: [], usage: { input: 10, output: 5, total: 15 }, json: extraction };
    },
  };
});

import { db, resetSqlite } from "@/lib/db";
import { setWorkspaceUser } from "@/lib/current-user";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@/lib/types/domain";
import { setupWorkspace } from "@/modules/workspace/service";
import { createMatter } from "@/modules/matters/service";
import { registerOfficialImpl, OfficialNotConfiguredError } from "@/modules/official/service";
import type { MatterCaseIdentifier, SourceDocument } from "@/modules/official/types";
import { putTracking } from "@/modules/matters/desk/server";
import { startRun, resumeRun } from "@/modules/workflows/engine";
import { buildTemplates, INDIA_WORKFLOW_TEMPLATE_IDS } from "@/modules/workflows/templates";
import { defaultConfigFor, type AnyNodeType } from "@/modules/workflows/registry";
import { validateWorkflow } from "@/modules/workflows/graph";
import type { WorkflowRunRecord } from "@/modules/workflows/types";

function doc(over: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: "sci_ord_0110", sourceId: "sci-orders", kind: "order", url: "https://www.sci.gov.in/view-pdf/?diary_no=131762026&type=o&order_date=2026-10-01", fileUrl: "https://www.sci.gov.in/sci-get-pdf/?diary_no=131762026&type=o&order_date=2026-10-01",
    title: "HARDIK CHAWDA vs. STATE OF HIMACHAL PRADESH - SLP(Crl) No. 13176/2026", docDate: "2026-10-01", status: "indexed", mime: "application/pdf", sha256: "a".repeat(64), bytes: 1000, pages: 2,
    extraction: "text_layer", ocrPages: [], language: "en", meta: { caseKeys: ["SLPCRL/13176/2026"], forum: "sci" }, version: 1, fetchedAt: "2026-10-01T12:00:00Z", indexedAt: "2026-10-01T12:05:00Z", error: null, attempts: 1, chunks: 2,
    ...over,
  };
}

const ORDER_TEXT = [
  { pageStart: 1, pageEnd: 1, text: "UPON hearing the counsel the Court made the following O R D E R\nIssue notice, returnable in four weeks.\nThe respondent-State shall file its counter affidavit within four weeks from today." },
  { pageStart: 2, pageEnd: 2, text: "List on 15.10.2026." },
];

const orderCalls: MatterCaseIdentifier[][] = [];
const readCalls: string[] = [];
function official(docs: SourceDocument[]) {
  registerOfficialImpl({
    ordersForIdentifiers: async (ids) => { orderCalls.push(ids); return docs; },
    readOfficialDocument: async (id, opts) => {
      readCalls.push(id);
      const d = docs.find((x) => x.id === id);
      if (!d) return null;
      const from = opts?.fromChunk ?? 0;
      return { document: d, chunks: ORDER_TEXT.slice(from).map((c, i) => ({ documentId: id, index: from + i, heading: null, ...c })), hasMore: false, nextChunk: null, attribution: "Supreme Court of India" };
    },
  });
}

function N(id: string, type: AnyNodeType, config: Record<string, unknown> = {}, label = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], label, position: { x: 0, y: 0 }, config: { ...defaultConfigFor(type), ...config } };
}
function E(source: string, target: string, sourceHandle?: string): WorkflowEdge { return { id: `e_${source}_${target}_${sourceHandle ?? ""}`, source, target, sourceHandle }; }
function wf(id: string, nodes: WorkflowNode[], edges: WorkflowEdge[], extra: Partial<Workflow> = {}): Workflow {
  const now = new Date().toISOString();
  const w: Workflow = { id, name: id, category: "operations", nodes, edges, inputs: [], status: "active", createdAt: now, updatedAt: now, ...extra };
  db().workflows.put(w);
  return w;
}
const stepOf = (run: WorkflowRunRecord, id: string) => run.steps.find((s) => s.nodeId === id)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out = (run: WorkflowRunRecord, id: string) => stepOf(run, id).output as Record<string, any>;

let tracked = "";
let untracked = "";
let orderTemplate: Workflow;

beforeAll(() => {
  resetSqlite();
  setWorkspaceUser(null);
  db();
  setupWorkspace({ firmName: "Rao & Iyer Advocates", name: "Meera Rao", email: "mrao@raoiyer.in", role: "Partner" });
  tracked = createMatter({ name: "Hardik Chawda v. State of H.P.", practiceArea: "Litigation", india: { courtId: "sci" } }).id;
  untracked = createMatter({ name: "Unitech Holdings v. Entertainment City", practiceArea: "Corporate / M&A" }).id;
  putTracking(tracked, { identifiers: [{ forum: "sci", kind: "case_number", printed: "SLP(Crl) No. 13176/2026" }, { forum: "sci", kind: "diary_no", printed: "54583/2026" }] });
  const t = buildTemplates().find((x) => x.id === INDIA_WORKFLOW_TEMPLATE_IDS.orderActions)!;
  orderTemplate = wf("wf_test_order_actions", t.nodes, t.edges, { name: t.name, inputs: t.inputs, frontend: t.frontend });
});

afterEach(() => {
  registerOfficialImpl({ ordersForIdentifiers: undefined, readOfficialDocument: undefined });
  orderCalls.length = 0;
  readCalls.length = 0;
  agentCalls.length = 0;
});

describe("New order → action items template (structure)", () => {
  it("chooses the order in a deterministic step and gates every action behind 'found' and a person", () => {
    const { nodes, edges } = orderTemplate;
    expect(validateWorkflow(nodes, edges).ok).toBe(true);
    const type = (id: string) => nodes.find((n) => n.id === id)?.type;
    expect(type("find")).toBe("data.official_order");
    // No model step can search the official sources for "the latest order".
    const read = nodes.find((n) => n.id === "read")!;
    expect(read.type).toBe("ai.prompt");
    expect(read.config.research).toEqual({ web: false, legal: false, internal: false });
    expect(JSON.stringify(nodes)).not.toContain("search_official_sources");
    // The extraction runs only on the found branch; the review always asks a person.
    expect(edges).toContainEqual(expect.objectContaining({ source: "found", target: "read", sourceHandle: "yes" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "found", target: "none", sourceHandle: "else" }));
    expect(nodes.find((n) => n.id === "review")!.config.requireHuman).toBe(true);
    // The compliance task and the event each sit behind their own branch.
    expect(edges.filter((e) => e.target === "task")).toEqual([expect.objectContaining({ source: "comply", sourceHandle: "yes" })]);
    expect(edges.filter((e) => e.target === "event")).toEqual([expect.objectContaining({ source: "dated", sourceHandle: "yes" })]);
  });
});

describe("other official-sources templates", () => {
  it("the hearing brief takes its orders from the exact-match step, not from a search", () => {
    const t = buildTemplates().find((x) => x.id === INDIA_WORKFLOW_TEMPLATE_IDS.hearingBrief)!;
    expect(validateWorkflow(t.nodes, t.edges).ok).toBe(true);
    expect(t.nodes.find((n) => n.id === "find")?.type).toBe("data.official_order");
    expect(t.edges).toContainEqual(expect.objectContaining({ source: "find", target: "orders" }));
    const orders = t.nodes.find((n) => n.id === "orders")!;
    expect(orders.config.tools).not.toContain("search_official_sources");
    expect(String(orders.config.context)).toContain("{{steps.find.output.text");
  });
  it("the daily cause-list check has a status for a number that could not be read (no lookup run)", () => {
    const t = buildTemplates().find((x) => x.id === INDIA_WORKFLOW_TEMPLATE_IDS.dailyCauseList)!;
    const lookup = t.nodes.find((n) => n.id === "lookup")!;
    const schema = lookup.config.jsonSchema as { properties: { status: { enum: string[] } } };
    expect(schema.properties.status.enum).toEqual(["listed", "not_found_in_loaded_lists", "unparsed_identifier", "not_available"]);
    expect(String(lookup.config.brief)).toMatch(/unparsed_identifier when the tool returned status unparsed_identifier/);
  });
});

describe("New order → action items template (runs)", () => {
  it("a matter with no tracked identifier: nothing is looked up or read, the run says why, nothing is created", async () => {
    official([doc()]);
    const tasks = db().tasks.count(() => true);
    const events = db().events.count(() => true);
    const run = await startRun(orderTemplate, { inputs: { matter: untracked, case_number: "SLP(Crl) No. 13176/2026", forum: "sci" }, wait: true });
    expect(run.status).toBe("succeeded");
    expect(out(run, "find")).toMatchObject({ status: "untracked", order: null, text: "" });
    expect(orderCalls).toHaveLength(0);
    expect(readCalls).toHaveLength(0);
    expect(stepOf(run, "read").status).toBe("skipped");
    expect(stepOf(run, "none").status).toBe("succeeded");
    expect(agentCalls).toHaveLength(0);
    expect(db().tasks.count(() => true)).toBe(tasks);
    expect(db().events.count(() => true)).toBe(events);
  });

  it("never substitutes another case's order: a newer order without the matter's key is set aside, none exact → not_found", async () => {
    official([doc({ id: "sci_ord_other", docDate: "2026-10-02", title: "OTHER vs. STATE - SLP(Crl) No. 13177/2026", meta: { caseKeys: ["SLPCRL/13177/2026"] } })]);
    const run = await startRun(orderTemplate, { inputs: { matter: tracked }, wait: true });
    expect(run.status).toBe("succeeded");
    expect(out(run, "find").status).toBe("not_found");
    expect(out(run, "find").message).toMatch(/No other case's order is used/);
    expect(orderCalls[0].map((i) => i.value).sort()).toEqual(["54583/2026", "SLPCRL/13176/2026"]);
    expect(readCalls).toHaveLength(0);
    expect(stepOf(run, "read").status).toBe("skipped");
  });

  it("reads exactly the latest exact match, pauses for a person even when the extraction verifies, then files, calendars and tasks", async () => {
    official([
      doc({ id: "sci_ord_other", docDate: "2026-10-02", title: "OTHER vs. STATE - SLP(Crl) No. 13177/2026", meta: { caseKeys: ["SLPCRL/13177/2026"] } }),
      doc({ id: "sci_ord_0901", docDate: "2026-09-01", title: "Earlier order" }),
      doc(),
    ]);
    extraction = {
      directions: [{ direction: "Notice issued", quote: "Issue notice, returnable in four weeks.", page: "1" }],
      next_date: "2026-10-15", next_date_quote: "List on 15.10.2026.",
      compliance: [{ task: "File counter affidavit", by_whom: "respondent-State", due_as_stated: "within four weeks from today", quote: "The respondent-State shall file its counter affidavit within four weeks from today.", page: "1" }],
      summary: "Notice issued; counter in four weeks; listed on 15.10.2026.",
    };
    const tasks = db().tasks.count(() => true);
    const run = await startRun(orderTemplate, { inputs: { matter: tracked, case_number: "SLP(Crl) No. 13176/2026", forum: "sci" }, wait: true });
    const find = out(run, "find");
    expect(find).toMatchObject({ status: "found", order: { id: "sci_ord_0110", ref: "src://sci_ord_0110", date: "2026-10-01" }, matchedOn: { value: "SLPCRL/13176/2026", printed: "SLP(Crl) No. 13176/2026" }, matches: 2, complete: true });
    expect(find.text).toContain("[Page 2]\nList on 15.10.2026.");
    // Narrowed to the tracked case number only (the diary number was not used).
    expect(orderCalls[0]).toEqual([{ forum: "sci", kind: "case_number", value: "SLPCRL/13176/2026" }]);
    expect(readCalls.every((id) => id === "sci_ord_0110")).toBe(true);
    // The extraction saw the chosen order's text and nothing else.
    expect(String(agentCalls[0].input)).toContain("Source: src://sci_ord_0110");
    expect(String(agentCalls[0].input)).toContain("The respondent-State shall file its counter affidavit within four weeks from today.");
    // The review never passes on its own.
    expect(run.status).toBe("waiting_approval");
    expect(stepOf(run, "review").status).toBe("waiting_approval");
    expect(String(out(run, "review").message)).toMatch(/chosen because it carries SLP\(Crl\) No\. 13176\/2026 exactly/);
    expect(stepOf(run, "save").status).toBe("pending");
    expect(db().tasks.count(() => true)).toBe(tasks);

    const done = await resumeRun(run.id, { approved: true }, { wait: true });
    expect(done.status).toBe("succeeded");
    expect(out(done, "review")).toMatchObject({ approved: true, decidedBy: "reviewer" });
    const ev = db().events.get(String(out(done, "event").eventId));
    expect(ev).toMatchObject({ matterId: tracked, title: expect.stringContaining("SLP(Crl) No. 13176/2026") });
    expect(ev!.startsAt.slice(0, 10)).toBe("2026-10-15");
    expect(db().tasks.count(() => true)).toBe(tasks + 1);
    expect(db().tasks.find((t) => t.matterId === tracked && t.title.startsWith("Comply with order dated 2026-10-01"))).toHaveLength(1);
  });

  it("a review rejected by the person files, calendars and tasks nothing", async () => {
    official([doc()]);
    const tasks = db().tasks.count(() => true);
    const events = db().events.count(() => true);
    const run = await startRun(orderTemplate, { inputs: { matter: tracked }, wait: true });
    expect(run.status).toBe("waiting_approval");
    const done = await resumeRun(run.id, { approved: false, comment: "wrong order" }, { wait: true });
    expect(["save", "event", "task"].map((id) => stepOf(done, id).status)).not.toContain("succeeded");
    expect(db().tasks.count(() => true)).toBe(tasks);
    expect(db().events.count(() => true)).toBe(events);
  });

  it("no compliance in the order: no compliance task", async () => {
    official([doc()]);
    extraction = { directions: [], next_date: "", next_date_quote: "", compliance: [], summary: "Adjourned." };
    const tasks = db().tasks.count(() => true);
    const run = await startRun(orderTemplate, { inputs: { matter: tracked }, wait: true });
    const done = await resumeRun(run.id, { approved: true }, { wait: true });
    expect(done.status).toBe("succeeded");
    expect(stepOf(done, "task").status).toBe("skipped");
    expect(stepOf(done, "event").status).toBe("skipped");
    expect(db().tasks.count(() => true)).toBe(tasks);
  });
});

describe("data.official_order step", () => {
  const find = (config: Record<string, unknown> = {}) => wf(`wf_find_${Math.random().toString(36).slice(2, 8)}`, [N("start", "trigger.manual"), N("find", "data.official_order", config)], [E("start", "find")]);

  it("two orders on the latest date are ambiguous (none chosen); a named exact order is read; a named foreign order is not", async () => {
    official([doc({ id: "sci_ord_a", title: "Order in SLP" }), doc({ id: "sci_ord_b", title: "Order in IA", meta: { diaryNo: "54583/2026" } }), doc({ id: "sci_ord_x", docDate: "2026-10-03", meta: { caseKeys: ["SLPCRL/99/2026"] } })]);
    const amb = await startRun(find(), { matterId: tracked, wait: true });
    expect(out(amb, "find")).toMatchObject({ status: "ambiguous", order: null, text: "" });
    expect(out(amb, "find").candidates.map((c: { id: string }) => c.id).sort()).toEqual(["sci_ord_a", "sci_ord_b"]);
    expect(readCalls).toHaveLength(0);
    const named = await startRun(find({ orderRef: "src://sci_ord_b#p1" }), { matterId: tracked, wait: true });
    expect(out(named, "find")).toMatchObject({ status: "found", order: { id: "sci_ord_b" }, matchedOn: { kind: "diary_no", value: "54583/2026" } });
    const foreign = await startRun(find({ orderRef: "src://sci_ord_x" }), { matterId: tracked, wait: true });
    expect(out(foreign, "find")).toMatchObject({ status: "not_linked", order: null });
  });

  it("a tracked case number given without a forum narrows to that identifier only", async () => {
    official([doc()]);
    const r = await startRun(find({ caseNumber: "SLP (Crl.) No. 13176 of 2026" }), { matterId: tracked, wait: true });
    expect(out(r, "find")).toMatchObject({ status: "found", matchedOn: { kind: "case_number", value: "SLPCRL/13176/2026" } });
    expect(orderCalls[0]).toEqual([{ forum: "sci", kind: "case_number", value: "SLPCRL/13176/2026" }]);
  });

  it("a case number the matter does not track is never looked up; an unreadable one is reported as such", async () => {
    official([doc()]);
    const other = await startRun(find({ caseNumber: "SLP(Crl) No. 13177/2026", forum: "sci" }), { matterId: tracked, wait: true });
    expect(out(other, "find")).toMatchObject({ status: "not_tracked" });
    const bad = await startRun(find({ caseNumber: "bail matter", forum: "sci" }), { matterId: tracked, wait: true });
    expect(out(bad, "find")).toMatchObject({ status: "unparsed_identifier" });
    expect(orderCalls).toHaveLength(0);
  });

  it("an order whose text is not indexed is not read; an unconfigured corpus is not_available, never 'not found'", async () => {
    official([doc({ status: "extracted" })]);
    const pending = await startRun(find(), { matterId: tracked, wait: true });
    expect(out(pending, "find")).toMatchObject({ status: "not_indexed", order: { id: "sci_ord_0110" }, text: "" });
    expect(readCalls).toHaveLength(0);
    registerOfficialImpl({ ordersForIdentifiers: async () => { throw new OfficialNotConfiguredError(); } });
    const na = await startRun(find(), { matterId: tracked, wait: true });
    expect(out(na, "find")).toMatchObject({ status: "not_available" });
    expect(out(na, "find").message).not.toMatch(/No published order/);
  });

  it("a facade failure fails the step (it is not reported as no order), and a run without a matter is refused", async () => {
    registerOfficialImpl({ ordersForIdentifiers: async () => { throw new Error("statement timeout"); } });
    const failed = await startRun(find(), { matterId: tracked, wait: true });
    expect(stepOf(failed, "find").status).toBe("failed");
    expect(stepOf(failed, "find").error).toMatch(/statement timeout/);
    const noMatter = await startRun(find(), { wait: true });
    expect(stepOf(noMatter, "find").status).toBe("failed");
    expect(stepOf(noMatter, "find").error).toMatch(/needs the run's matter/);
  });
});

describe("logic.review: always ask a person", () => {
  it("pauses even with nothing untrusted, and continues only on approval", async () => {
    const w = wf("wf_review_human", [
      N("start", "trigger.manual"),
      N("review", "logic.review", { steps: "", requireHuman: true, message: "Check it." }),
      N("after", "logic.delay", { minutes: 0 }),
    ], [E("start", "review"), E("review", "after", "approved")]);
    const run = await startRun(w, { wait: true });
    expect(run.status).toBe("waiting_approval");
    expect(String(out(run, "review").message)).toMatch(/^Check it\./);
    const done = await resumeRun(run.id, { approved: true }, { wait: true });
    expect(done.status).toBe("succeeded");
    expect(stepOf(done, "after").status).toBe("succeeded");
    // Without the option, the same review passes automatically (unchanged behaviour).
    const auto = wf("wf_review_auto", [N("start", "trigger.manual"), N("review", "logic.review", { steps: "" }), N("after", "logic.delay", { minutes: 0 })], [E("start", "review"), E("review", "after", "approved")]);
    const passed = await startRun(auto, { wait: true });
    expect(passed.status).toBe("succeeded");
    expect(out(passed, "review")).toMatchObject({ approved: true, decidedBy: "automatic" });
  });
});
