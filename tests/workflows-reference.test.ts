import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Reference seed only (a production workspace before anyone adds data): the template gallery and the
 * system workflows must be valid, must not name demo people or matters, and every system workflow must
 * finish on an empty database without failing and without inventing sample content.
 */
vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/wf-reference-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.OPENROUTER_API_KEY = "";
});

import { rmSync } from "node:fs";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { validateWorkflow } from "@/modules/workflows/graph";
import { buildSystemTemplates } from "@/modules/workflows/templates-system";
import { buildTemplates, TEMPLATE_FRONTENDS } from "@/modules/workflows/templates";
import { startRun } from "@/modules/workflows/engine";

const DEMO_IDS = new Set<string>([...Object.values(PEOPLE), ...Object.values(MATTERS)]);
/** Names from the demo dataset that must not appear in reference content. */
const DEMO_NAMES = /\b(VALSARA|Depo-Provera|Meridian|Fine Chemicals|Harborline|Bluewater|Snowfield|Aurora Health|Northgate|Sterling Medical|Rangan|Sundaram|Oberoi|Priya Raman|Esha Mathur|Sameer Chawla|Meera Lobo|Aisha Khan|Kapur|Hegde|Prasad|Arb\. Ref\. 14\/2024|Procedural Order No\. 5)\b/;

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out);
  return out;
}

beforeAll(() => {
  try { rmSync(process.env.LECLAUDE_DATA_DIR!, { recursive: true, force: true }); } catch { /* fresh dir */ }
  resetSqlite();
  db();
});

describe("reference seed", () => {
  it("starts with no matters, people or documents; only the workflow gallery and system workflows", () => {
    const d = db();
    expect(d.matters.all()).toHaveLength(0);
    expect(d.people.all()).toHaveLength(0);
    expect(d.tasks.all()).toHaveLength(0);
    const ids = new Set(d.workflows.all().map((w) => w.id));
    for (const w of [...buildTemplates(), ...buildSystemTemplates()]) expect(ids.has(w.id), w.id).toBe(true);
    expect(d.workflows.all().length).toBe(buildTemplates().length + buildSystemTemplates().length);
  });

  it("every template and system workflow validates and names no demo person, matter or case", () => {
    for (const w of [...buildTemplates(), ...buildSystemTemplates()]) {
      const v = validateWorkflow(w.nodes, w.edges);
      expect(v.ok, `${w.id}: ${v.issues.map((i) => i.message).join("; ")}`).toBe(true);
      const strings = collectStrings({ nodes: w.nodes, frontend: w.frontend, description: w.description, tags: w.tags, inputs: w.inputs });
      for (const s of strings) {
        expect(DEMO_IDS.has(s), `${w.id}: demo id ${s}`).toBe(false);
        expect(DEMO_NAMES.test(s), `${w.id}: demo name in "${s.slice(0, 120)}"`).toBe(false);
      }
      for (const n of w.nodes) {
        for (const key of ["assigneeId", "approverId", "reviewerId"]) {
          const val = n.config[key];
          if (val) expect(val, `${w.id}.${n.id}.${key}`).toBe("{{user.id}}");
        }
        for (const key of ["recipientIds", "attendeeIds"]) {
          const val = n.config[key];
          if (Array.isArray(val)) for (const r of val) expect(r, `${w.id}.${n.id}.${key}`).toBe("{{user.id}}");
        }
      }
    }
    for (const fe of Object.values(TEMPLATE_FRONTENDS)) for (const s of collectStrings(fe)) expect(DEMO_NAMES.test(s), `front end: "${s.slice(0, 120)}"`).toBe(false);
  });

  it("every template that files work under a matter asks for it on the start form", () => {
    for (const w of buildTemplates()) {
      const usesMatter = collectStrings(w.nodes).some((s) => s.includes("{{inputs.matter}}"));
      if (!usesMatter || !w.frontend) continue;
      const field = w.frontend.fields.find((f) => f.key === "matter");
      expect(field, w.id).toBeTruthy();
      expect(field!.type).toBe("matter");
      expect(field!.required, w.id).toBe(true);
    }
  });

  it("every system workflow finishes on an empty database without failing and without creating sample content", async () => {
    const d = db();
    const before = { tasks: d.tasks.all().length, events: d.events.all().length, library: d.library.all().length, updates: d.updates.all().length, matters: d.matters.all().length, insights: d.collection("intel_insights").all().length };
    for (const w of buildSystemTemplates()) {
      const run = await startRun(w, { triggeredBy: "manual", wait: true });
      expect(run.status, `${w.id}: ${run.error ?? ""} ${(run.logs ?? []).slice(-3).join(" | ")}`).not.toBe("failed");
      expect(run.status, w.id).not.toBe("waiting_approval");
      expect(run.status, `${w.id}: ${(run.logs ?? []).slice(-3).join(" | ")}`).toBe("succeeded");
    }
    expect(d.tasks.all().length).toBe(before.tasks);
    expect(d.events.all().length).toBe(before.events);
    expect(d.library.all().length).toBe(before.library);
    expect(d.matters.all().length).toBe(before.matters);
    expect(d.collection("intel_insights").all().length, "no sample insights on an empty workspace").toBe(before.insights);
  }, 120_000);
});
