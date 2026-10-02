import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A production (non-demo) workspace on a private database that starts empty.
vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/home-vitest-empty-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
});

import { db, resetSqlite } from "@/lib/db";
import { setWorkspaceUser } from "@/lib/current-user";
import { buildBriefContext, createEvent, createTask, displayUserName, getOrComputeBrief, listEvents, listNews, listTasks, listUpdates, loadHomeInitialData, matterOverview } from "@/modules/home/service";
import { computeTodaySpine } from "@/modules/home/components/today-spine-model";
import { firstRunSteps } from "@/modules/home/components/first-run-model";
import { dueText } from "@/modules/home/time";

const NOW = new Date(2026, 8, 23, 9, 30);
const SAMPLE = /VALSARA|Northgate|Sundaram|Arjun Mehra|Arb\. Ref\. 14\/2024|Rangan|Kale & Associates|Depo-Provera/i;

beforeAll(() => { resetSqlite(); db(); setWorkspaceUser(null); });
afterAll(() => { resetSqlite(); });

describe("Home on an empty workspace", () => {
  it("has no matters, people, tasks, events, news or updates", () => {
    const d = db();
    for (const c of [d.matters, d.people, d.tasks, d.events, d.news, d.updates, d.edocs]) expect(c.count()).toBe(0);
    expect(listTasks({ now: NOW })).toEqual([]);
    expect(listEvents({})).toEqual([]);
    expect(listNews({})).toEqual([]);
    expect(listUpdates({})).toEqual([]);
    expect(matterOverview(NOW)).toEqual([]);
  });

  it("builds the initial payload with no sample-derived records and a neutral name", () => {
    const data = loadHomeInitialData({ now: NOW, aiConfigured: false });
    expect(data.userName).toBe(""); // never the "Workspace owner" placeholder
    expect(data.intelInsights).toBe(false);
    expect(data.setup).toEqual({ matters: 0, documents: 0, people: 0 });
    expect(data.matters).toEqual([]);
    expect(data.matterOverview).toEqual([]);
    expect(data.news).toEqual([]);
    expect(data.updates).toEqual([]);
    expect(JSON.stringify(data)).not.toMatch(SAMPLE);
  });

  it("computes an empty brief and spine without throwing", () => {
    const ctx = buildBriefContext(NOW);
    expect(ctx.matters).toEqual([]);
    const brief = getOrComputeBrief(NOW);
    expect(brief.source).toBe("computed");
    expect(brief.stats).toMatchObject({ eventsToday: 0, overdueTasks: 0, dueSoonTasks: 0, hotNews: 0 });
    expect(JSON.stringify(brief)).not.toMatch(SAMPLE);
    const spine = computeTodaySpine({ now: NOW, userId: "u_owner", events: [], tasks: [], matterOverview: [] });
    expect(spine.deadlines).toEqual([]);
    expect(spine.todayEvents).toEqual([]);
    expect(spine.overdueTasks).toEqual([]);
  });

  it("shows the first-run checklist steps, done only when satisfied", () => {
    const steps = firstRunSteps({ matters: 0, documents: 0, people: 0, aiConfigured: false });
    expect(steps.map((s) => [s.id, s.href, s.done])).toEqual([
      ["matter", "/matters?new=1", false],
      ["documents", "/documents", false],
      ["provider", "/settings#ai", false],
      ["team", "/settings#team", false],
    ]);
    expect(firstRunSteps({ matters: 1, documents: 3, people: 2, aiConfigured: true }).every((s) => s.done)).toBe(true);
  });

  it("still creates tasks and events without a matter", () => {
    const t = createTask({ title: "Draft engagement letter", dueAt: "2026-09-25" });
    const e = createEvent({ title: "Intake call", startsAt: "2026-09-23T14:00:00", kind: "meeting" });
    expect(listTasks({ now: NOW }).map((x) => x.id)).toContain(t.id);
    expect(listEvents({}).map((x) => x.id)).toContain(e.id);
    expect(t.matterId).toBeUndefined();
  });

  it("uses the owner's name once the workspace is set up", () => {
    setWorkspaceUser({ id: "p_owner_test", name: "Dana Reyes" });
    try { expect(displayUserName("p_owner_test")).toBe("Dana Reyes"); } finally { setWorkspaceUser(null); }
    expect(displayUserName()).toBe("");
  });
});

describe("due-date text", () => {
  it("is plain, and says overdue in words", () => {
    expect(dueText("2026-09-14", NOW)).toEqual({ text: "9 days overdue", overdue: true, days: -9 });
    expect(dueText("2026-09-22", NOW).text).toBe("1 day overdue");
    expect(dueText("2026-09-23", NOW).text).toBe("today");
    expect(dueText("2026-09-24", NOW).text).toBe("tomorrow");
    expect(dueText("2026-09-28", NOW)).toEqual({ text: "in 5 days", overdue: false, days: 5 });
    expect(dueText("2026-10-21", NOW).text).toBe("in 4 weeks");
  });
});
