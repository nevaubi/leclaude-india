import { describe, expect, it } from "vitest";
import { referenceTemplateWrites, SEED_VERSION } from "@/lib/seed";
import { buildTemplates } from "@/modules/workflows/templates";
import type { Workflow } from "@/lib/types/domain";

const built = buildTemplates();
const orderActions = built.find((w) => w.id === "wf_tpl_in_order_actions")!;

describe("built-in template refresh on reseed", () => {
  it("re-runs the reference seed for this change", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("inserts missing templates and leaves current ones alone", () => {
    expect(referenceTemplateWrites([], built).map((w) => w.id)).toEqual(built.map((w) => w.id));
    expect(referenceTemplateWrites(built, built)).toEqual([]);
  });

  it("replaces an unedited stored template whose build changed, keeping its run counters", () => {
    expect(orderActions).toBeDefined();
    const stale: Workflow = { ...orderActions, nodes: orderActions.nodes.slice(0, 1), edges: [], runsCount: 4, lastRunAt: "2026-09-30T10:00:00.000Z" };
    const writes = referenceTemplateWrites([stale], [orderActions]);
    expect(writes).toHaveLength(1);
    expect(writes[0].nodes).toEqual(orderActions.nodes);
    expect(writes[0]).toMatchObject({ runsCount: 4, lastRunAt: "2026-09-30T10:00:00.000Z" });
  });

  it("never overwrites a template edited through the API, nor a user's own workflow with a template's id", () => {
    const edited: Workflow = { ...orderActions, nodes: orderActions.nodes.slice(0, 1), updatedAt: "2026-09-01T00:00:00.000Z" };
    expect(referenceTemplateWrites([edited], [orderActions])).toEqual([]);
    const own: Workflow = { ...orderActions, nodes: [], isTemplate: false, system: false };
    expect(referenceTemplateWrites([own], [orderActions])).toEqual([]);
  });

  it("the order-actions template selects the order in code (no free-text search step)", () => {
    expect(orderActions.nodes.some((n) => n.type === ("data.official_order" as never))).toBe(true);
  });
});
