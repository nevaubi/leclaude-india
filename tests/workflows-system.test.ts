import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/wf-system-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
});

import { db, resetSqlite } from "@/lib/db";
import { validateWorkflow } from "@/modules/workflows/graph";
import { KNOWN_NODE_TYPES } from "@/modules/workflows/registry";
import { describeSchedule, nextRunAt, normalizeSchedule, schedulePeriodMs } from "@/modules/workflows/schedule";
import { buildSystemTemplates, buildUsSystemTemplates, INDIA_INTEL_SOURCE_IDS, INTEL_SOURCE_IDS, SYSTEM_WORKFLOW_IDS, US_ONLY_SYSTEM_WORKFLOW_IDS, systemWorkflowById } from "@/modules/workflows/templates-system";
import { buildTemplates, WORKFLOW_TEMPLATE_IDS } from "@/modules/workflows/templates";
import { getWorkflow, listWorkflows, scheduleOf, workflowMeta, workflowStats } from "@/modules/workflows/service";
import { INDIA_SOURCE_IDS, SEED_SOURCE_IDS } from "@/modules/intel/seed";
import * as listRoute from "@/app/api/workflows/route";
import * as byId from "@/app/api/workflows/[id]/route";
import * as runRoute from "@/app/api/workflows/[id]/run/route";
import * as uploads from "@/app/api/workflows/uploads/route";
import * as extractText from "@/app/api/workflows/extract-text/route";
import * as runs from "@/app/api/workflows/runs/route";
import * as metaRoute from "@/app/api/workflows/meta/route";

beforeAll(() => { resetSqlite(); db(); });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

describe("system workflows", () => {
  // LeClaude India: the default set points at the India sources; the US set (all eleven) stays buildable for the US
  // sample dataset, which the demo-mode seed used by this suite still loads.
  const system = buildSystemTemplates();
  const us = buildUsSystemTemplates();
  const all = [...system, ...us];
  it("ships the India automation workflows (and keeps the eleven US ones) as valid, warning-free graphs with stable ids", () => {
    expect(system).toHaveLength(8);
    expect(system.map((w) => w.id).sort()).toEqual(Object.values(SYSTEM_WORKFLOW_IDS).filter((id) => !US_ONLY_SYSTEM_WORKFLOW_IDS.includes(id)).sort());
    expect(system.map((w) => w.name)).toEqual(["Judgment watch — Supreme Court and focus High Courts", "Statute watch — India Code", "Local corpus backfill", "Judge and advocate profiles", "Matter chronologies", "Insight verification sweep", "Data integrity sweep", "Team digest"]);
    expect(us).toHaveLength(11);
    expect(us.map((w) => w.id).sort()).toEqual(Object.values(SYSTEM_WORKFLOW_IDS).sort());
    expect(us.map((w) => w.name)).toEqual(["Authority refresh", "Docket watch", "MDL tracker", "Regulatory watch", "News watch", "Local corpus backfill", "Judge and counsel profiles", "Matter chronologies", "Insight verification sweep", "Data integrity sweep", "Team digest"]);
    for (const w of all) {
      expect(w.system, w.id).toBe(true);
      expect(w.isTemplate).toBe(false);
      expect(w.status).toBe("active");
      expect(w.category).toBe("automation");
      expect(w.nodes.length, w.id).toBeGreaterThanOrEqual(3);
      const v = validateWorkflow(w.nodes, w.edges);
      expect(v.ok, `${w.id}: ${v.issues.map((i) => i.message).join("; ")}`).toBe(true);
      expect(v.issues.filter((i) => i.level === "warning").map((i) => i.message), w.id).toEqual([]);
      for (const n of w.nodes) expect(KNOWN_NODE_TYPES, `${w.id}.${n.id}`).toContain(n.type);
      const trigger = w.nodes.filter((n) => n.type.startsWith("trigger."));
      expect(trigger, w.id).toHaveLength(1);
      expect(trigger[0].type).toBe("trigger.schedule");
      expect(trigger[0].config.enabled).toBe(true);
      expect(normalizeSchedule(trigger[0].config.schedule), w.id).toBeTruthy();
      // Every system workflow is stewarded or verified: it carries a steward, a verify step or a publish step.
      expect(w.nodes.some((n) => n.type === "review.auto" || n.type === "intel.verify" || n.type === "intel.publish"), w.id).toBe(true);
    }
    expect(systemWorkflowById(SYSTEM_WORKFLOW_IDS.teamDigest)?.name).toBe("Team digest");
    expect(systemWorkflowById("nope")).toBeUndefined();
  });
  it("references the seeded intelligence sources and uses the phase-3 node types", () => {
    expect(INTEL_SOURCE_IDS).toEqual(SEED_SOURCE_IDS);
    // India defaults fetch only India sources (plus the jurisdiction-neutral local corpus).
    for (const [k, v] of Object.entries(INDIA_INTEL_SOURCE_IDS)) expect(INDIA_SOURCE_IDS[k as keyof typeof INDIA_SOURCE_IDS], k).toBe(v);
    const indiaFetches = system.flatMap((w) => w.nodes.filter((n) => n.type === "intel.fetch"));
    expect(indiaFetches.length).toBeGreaterThanOrEqual(5);
    const indiaKnown = new Set<string>([...Object.values(INDIA_SOURCE_IDS), SEED_SOURCE_IDS.localCorpus]);
    for (const f of indiaFetches) expect(indiaKnown.has(String(f.config.sourceId)), `${f.id}: ${String(f.config.sourceId)}`).toBe(true);
    const fetches = us.flatMap((w) => w.nodes.filter((n) => n.type === "intel.fetch"));
    expect(fetches.length).toBeGreaterThanOrEqual(8);
    const known = new Set<string>(Object.values(SEED_SOURCE_IDS));
    for (const f of fetches) expect(known.has(String(f.config.sourceId)), `${f.id}: ${String(f.config.sourceId)}`).toBe(true);
    const types = new Set(all.flatMap((w) => w.nodes.map((n) => n.type)));
    for (const t of ["intel.fetch", "intel.extract", "intel.index", "intel.entities", "intel.analyze", "intel.verify", "intel.publish", "review.auto", "data.query", "logic.loop"]) expect(types.has(t as never), t).toBe(true);
    const digest = system.find((w) => w.id === SYSTEM_WORKFLOW_IDS.teamDigest)!;
    const publish = digest.nodes.find((n) => n.type === "intel.publish")!;
    expect(publish.config.to).toBe("digest");
    expect(String(publish.config.userId)).toContain("loop.item.id");
  });
  it("computes the schedules the design asks for", () => {
    const sched = (id: string) => normalizeSchedule((system.find((w) => w.id === id) ?? us.find((w) => w.id === id))!.nodes.find((n) => n.type === "trigger.schedule")!.config.schedule)!;
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.authorityRefresh))).toMatch(/^Daily at/);
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.docketWatch))).toMatch(/^Hourly/);
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.mdlTracker))).toMatch(/^Daily/);
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.regulatoryWatch))).toMatch(/^Weekly/); // India Code statute watch
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.newsWatch))).toMatch(/^Daily/);
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.localCorpus))).toMatch(/^Daily/);
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.profiles))).toMatch(/^Weekly/);
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.chronologies))).toMatch(/^Daily/);
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.insightSweep))).toBe("Every 6 hours");
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.integritySweep))).toBe("Every 6 hours");
    expect(sched(SYSTEM_WORKFLOW_IDS.teamDigest)).toMatchObject({ frequency: "daily", time: "07:00", weekdaysOnly: true });
    expect(describeSchedule(sched(SYSTEM_WORKFLOW_IDS.teamDigest))).toBe("Weekdays at 07:00");
    // Next occurrences (server local time).
    const friday = new Date(2026, 8, 25, 8, 0, 0); // Fri Sep 25 2026 08:00 local
    const nextDigest = nextRunAt(sched(SYSTEM_WORKFLOW_IDS.teamDigest), friday);
    expect(nextDigest.getDay()).toBe(1); // skips the weekend to Monday
    expect([nextDigest.getHours(), nextDigest.getMinutes()]).toEqual([7, 0]);
    const nextSweep = nextRunAt(sched(SYSTEM_WORKFLOW_IDS.insightSweep), friday);
    expect(nextSweep.getTime() - friday.getTime()).toBeGreaterThanOrEqual(6 * 3600_000);
    expect(nextSweep.getTime() - friday.getTime()).toBeLessThan(7 * 3600_000);
    const nextHourly = nextRunAt(sched(SYSTEM_WORKFLOW_IDS.docketWatch), friday);
    expect(nextHourly.getTime() - friday.getTime()).toBeLessThanOrEqual(3600_000);
    expect(nextHourly.getTime()).toBeGreaterThan(friday.getTime());
    expect(schedulePeriodMs(sched(SYSTEM_WORKFLOW_IDS.insightSweep))).toBe(6 * 3600_000);
    expect(schedulePeriodMs(sched(SYSTEM_WORKFLOW_IDS.profiles))).toBe(7 * 86400_000);
  });
  it("is seeded as active workflows with schedule anchors, listed by the system filter and counted in stats", () => {
    const listed = listWorkflows({ system: true });
    expect(listed).toHaveLength(11);
    expect(listed.every((w) => w.status === "active" && w.schedule && w.nextRunAt && !w.isTemplate)).toBe(true);
    expect(listed.every((w) => w.category === "automation")).toBe(true);
    expect(listWorkflows({ system: false }).some((w) => w.system)).toBe(false);
    expect(listWorkflows({ template: true }).some((w) => w.system)).toBe(false);
    expect(listWorkflows({}).filter((w) => w.system)).toHaveLength(11);
    for (const w of listed) {
      expect(db().kv.get<string>(`wf:schedule:last:${w.id}`), w.id).toBeTruthy();
      expect(scheduleOf(getWorkflow(w.id)!)?.enabled).toBe(true);
    }
    const stats = workflowStats();
    expect(stats.system).toBe(11);
    expect(stats.templates).toBe(16);
    expect(stats.workflows).toBeGreaterThanOrEqual(4);
    expect(stats.nextScheduled.some((n) => n.system)).toBe(true);
    // Seeded run history exists for system workflows.
    const sysRuns = db().workflowRuns.find((r) => r.id.startsWith("run_sys_"));
    expect(sysRuns.length).toBeGreaterThanOrEqual(5);
    for (const r of sysRuns) expect(getWorkflow(r.workflowId)?.system).toBe(true);
    const meta = workflowMeta();
    expect(meta.workflows!.filter((w) => w.system)).toHaveLength(11);
    expect(meta.intelSources!.length).toBeGreaterThanOrEqual(12);
    expect(meta.agents!.map((a) => a.id)).toContain("steward");
  });
  it("user templates are the sixteen tailored ones and none is a system workflow", () => {
    const templates = buildTemplates();
    expect(templates).toHaveLength(16);
    expect(templates.every((t) => !t.system && t.isTemplate)).toBe(true);
    expect(templates.every((t) => t.frontend?.fields.length)).toBe(true);
    expect(new Set(templates.map((t) => t.id)).size).toBe(16);
    expect(Object.values(WORKFLOW_TEMPLATE_IDS)).toHaveLength(16);
  });
});

describe("workflow API routes", () => {
  it("lists with the system and template filters", async () => {
    const sys = await json(await listRoute.GET(new Request("http://x/api/workflows?system=1")));
    expect(sys.status).toBe(200);
    expect((sys.body.workflows as { system?: boolean }[]).every((w) => w.system)).toBe(true);
    expect((sys.body.workflows as unknown[]).length).toBe(11);
    const tpl = await json(await listRoute.GET(new Request("http://x/api/workflows?template=1")));
    expect((tpl.body.workflows as { hasFrontend: boolean }[]).every((w) => w.hasFrontend)).toBe(true);
    const mine = await json(await listRoute.GET(new Request("http://x/api/workflows?template=0&system=0")));
    expect((mine.body.workflows as { system?: boolean; isTemplate?: boolean }[]).every((w) => !w.system && !w.isTemplate)).toBe(true);
  });
  it("stores uploads as blobs and extracts their text", async () => {
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("Deposition of Gregory Hale, page 12. Q. Did you read the EHS memo? A. Yes.")], "hale.txt", { type: "text/plain" }));
    form.append("workflowId", WORKFLOW_TEMPLATE_IDS.depoDesignations);
    const res = await json(await uploads.POST(new Request("http://x/api/workflows/uploads", { method: "POST", body: form })));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "hale.txt", mime: "text/plain" });
    expect(String(res.body.blobId).length).toBeGreaterThan(8);
    expect(res.body.size as number).toBeGreaterThan(10);
    expect(db().blobs.get(String(res.body.blobId))?.meta?.source).toBe("workflow.frontend");
    const ex = await json(await extractText.POST(new Request("http://x/api/workflows/extract-text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blobId: res.body.blobId }) })));
    expect(ex.status).toBe(200);
    expect(String(ex.body.text)).toContain("EHS memo");
    // Several files in one call, and error cases.
    const multi = new FormData();
    multi.append("file", new File(["a"], "a.txt", { type: "text/plain" }));
    multi.append("file", new File(["b"], "b.md", { type: "text/markdown" }));
    const m = await json(await uploads.POST(new Request("http://x/api/workflows/uploads", { method: "POST", body: multi })));
    expect(m.status).toBe(201);
    expect((m.body.files as unknown[]).length).toBe(2);
    expect(m.body.blobId).toBeUndefined();
    expect((await uploads.POST(new Request("http://x/api/workflows/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))).status).toBe(415);
    const empty = new FormData();
    empty.append("file", new File([], "empty.txt", { type: "text/plain" }));
    expect((await uploads.POST(new Request("http://x/api/workflows/uploads", { method: "POST", body: empty }))).status).toBe(400);
  });
  it("starts a template from its front end on the caller's own copy, validating the fields first", async () => {
    const id = WORKFLOW_TEMPLATE_IDS.productionQc;
    const bad = await json(await runRoute.POST(new Request(`http://x/api/workflows/${id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: {}, frontend: true }) }), ctx(id)));
    expect(bad.status).toBe(422);
    expect(["missing_inputs", "invalid_inputs"]).toContain(bad.body.code);
    const ok = await json(await runRoute.POST(new Request(`http://x/api/workflows/${id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: { matter: "m_afff_2873", bates_prefix: "AFFF-", volume: "VOL001" }, matterId: "m_afff_2873", frontend: true }) }), ctx(id)));
    expect(ok.status).toBe(202);
    const started = ok.body.workflow as { id: string; name: string };
    expect(started.id).not.toBe(id);
    expect(started.name).toBe("Production QC");
    const own = getWorkflow(started.id)!;
    expect(own.isTemplate).toBe(false);
    expect(own.status).toBe("active");
    expect(own.frontend?.fields.length).toBeGreaterThan(0);
    expect((ok.body.run as { workflowId: string }).workflowId).toBe(started.id);
    // The same copy is reused next time.
    const again = await json(await runRoute.POST(new Request(`http://x/api/workflows/${id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: { matter: "m_afff_2873", bates_prefix: "AFFF-", volume: "VOL002" }, frontend: true }) }), ctx(id)));
    expect((again.body.workflow as { id: string }).id).toBe(started.id);
    const listed = await json(await runs.GET(new Request(`http://x/api/workflows/runs?workflowId=${started.id}`)));
    expect((listed.body.total as number)).toBeGreaterThanOrEqual(2);
    const detail = await json(await byId.GET(new Request(`http://x/api/workflows/${started.id}`), ctx(started.id)));
    expect(detail.status).toBe(200);
    expect((detail.body.workflow as { frontend?: { title: string } }).frontend?.title).toBeTruthy();
    expect((await runRoute.POST(new Request("http://x/api/workflows/wf_missing/run", { method: "POST", body: "{}" }), ctx("wf_missing"))).status).toBe(404);
  });
  it("saves a front end from the builder and refreshes the inputs list from it", async () => {
    const created = await json(await listRoute.POST(new Request("http://x/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Front end test", category: "operations", status: "draft", nodes: [{ id: "start", type: "trigger.manual", label: "Start", position: { x: 0, y: 0 }, config: {} }], edges: [], inputs: [], tags: [] }) })));
    expect(created.status).toBe(201);
    const id = (created.body.workflow as { id: string }).id;
    const frontend = { title: "Go", fields: [{ key: "doc", label: "Document", type: "file", required: true, accept: [".pdf"] }, { key: "matter", label: "Matter", type: "matter", required: true }, { key: "fmt", label: "Format", type: "output-format" }], output: { formats: ["docx", "pdf"], defaultFormat: "pdf", defaultLabel: "Out — {{now | date:date}}" }, after: { createTask: { title: "Read it", dueRule: "+1d" } } };
    const saved = await json(await byId.PUT(new Request(`http://x/api/workflows/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ frontend }) }), ctx(id)));
    expect(saved.status).toBe(200);
    const w = saved.body.workflow as { frontend?: typeof frontend; inputs: { key: string; type: string; required?: boolean; options?: string[] }[] };
    expect(w.frontend?.fields.map((f) => f.key)).toEqual(["doc", "matter", "fmt"]);
    expect(w.inputs.map((i) => [i.key, i.type, Boolean(i.required)])).toEqual([["doc", "file", true], ["matter", "matter", true], ["fmt", "select", false]]);
    expect(w.inputs[2].options).toContain("pdf");
    const listed = await json(await listRoute.GET(new Request("http://x/api/workflows?template=0&system=0")));
    expect((listed.body.workflows as { id: string; hasFrontend: boolean }[]).find((x) => x.id === id)?.hasFrontend).toBe(true);
    // Removing the front end keeps the workflow runnable through the inputs list.
    const removed = await json(await byId.PUT(new Request(`http://x/api/workflows/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ frontend: null }) }), ctx(id)));
    expect((removed.body.workflow as { frontend?: unknown }).frontend).toBeUndefined();
    const invalid = await json(await byId.PUT(new Request(`http://x/api/workflows/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ frontend: { title: "x", fields: [{ key: "a", label: "A", type: "hologram" }] } }) }), ctx(id)));
    expect(invalid.status).toBe(422);
  });
  it("exposes agents, intel sources and startable workflows through meta", async () => {
    const meta = await json(await metaRoute.GET());
    expect(meta.status).toBe(200);
    expect((meta.body.agents as { id: string }[]).map((a) => a.id)).toEqual(["coordinator", "research", "drafter", "reviewer", "coder", "analyst", "steward"]);
    expect((meta.body.intelSources as unknown[]).length).toBeGreaterThanOrEqual(12);
    expect((meta.body.workflows as { system: boolean }[]).some((w) => w.system)).toBe(true);
  });
});
