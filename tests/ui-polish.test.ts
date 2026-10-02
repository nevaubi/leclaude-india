import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/types/domain";
import type { CalendarEntry, MatterOverview } from "@/modules/home/types";
import { computeTodaySpine, deadlineTone, myTasksDue, spineSummary, todaysEvents, upcomingDeadlines } from "@/modules/home/components/today-spine-model";
import { GO_CHORD, NAV, SECONDARY_NAV } from "@/components/shell/nav";
import { groupHits, type QuickSearchHit } from "@/components/shell/palette-groups";
import { activeFacetCount } from "@/modules/ediscovery/components/rail-helpers";
import { isTrustGate } from "@/modules/workflows/components/run/approval-helpers";

const NOW = new Date(2026, 8, 24, 9, 0); // Thu Sept 24, 2026 09:00 local

function ev(over: Partial<CalendarEntry> & { id: string; title: string; startsAt: string }): CalendarEntry {
  return { kind: "meeting", ...over };
}
function task(over: Partial<Task> & { id: string; title: string }): Task {
  return { status: "todo", priority: "medium", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", assigneeId: "me", ...over };
}
function matter(over: Partial<MatterOverview> & { id: string }): MatterOverview {
  return { shortName: over.id, name: over.id, client: "Client", clientSide: "plaintiff", practiceArea: "Litigation", status: "active", teamIds: [], keyDates: [], openTasks: 0, overdueTasks: 0, myOpenTasks: 0, hotDocs: 0, docCount: 0, upcomingEvents: 0, ...over };
}

const events: CalendarEntry[] = [
  ev({ id: "e_today_meeting", title: "Team stand-up", startsAt: "2026-09-24T09:30:00", kind: "meeting" }),
  ev({ id: "e_today_hearing", title: "Status conference", startsAt: "2026-09-24T14:00:00", kind: "hearing", matterId: "m_vls" }),
  ev({ id: "e_allday", title: "Firm holiday", startsAt: "2026-09-24", allDay: true, kind: "internal" }),
  ev({ id: "e_past_deadline", title: "Rule 26(a)(2) disclosures", startsAt: "2026-09-20", kind: "deadline", matterId: "m_vls" }),
  ev({ id: "e_filing", title: "Opposition due", startsAt: "2026-10-02", kind: "filing", matterId: "m_vls" }),
  ev({ id: "e_far", title: "Expert reports", startsAt: "2027-06-01", kind: "deadline", matterId: "m_vls" }),
  ev({ id: "e_derived", title: "Fact discovery closes", startsAt: "2026-10-15", kind: "deadline", matterId: "m_north", derived: { source: "matter-key-date", matterId: "m_north", label: "Fact discovery closes" } }),
  ev({ id: "e_other_matter", title: "Mediation", startsAt: "2026-09-28", kind: "hearing", matterId: "m_north" }),
];
const tasks: Task[] = [
  task({ id: "t_overdue_low", title: "File notice of appearance", dueAt: "2026-09-22", priority: "low" }),
  task({ id: "t_overdue_urgent", title: "Serve subpoena", dueAt: "2026-09-23", priority: "urgent", matterId: "m_vls" }),
  task({ id: "t_today", title: "Prep Hegde outline", dueAt: "2026-09-24", priority: "high" }),
  task({ id: "t_done", title: "Old task", dueAt: "2026-09-01", status: "done" }),
  task({ id: "t_not_mine", title: "Someone else's", dueAt: "2026-09-20", assigneeId: "other" }),
  task({ id: "t_no_due", title: "Read the file" , dueAt: undefined }),
  task({ id: "t_future", title: "Draft reply", dueAt: "2026-10-01" }),
];
const overview: MatterOverview[] = [
  matter({ id: "m_vls", keyDates: [{ label: "Opposition due", date: "2026-10-02", daysUntil: 8 }, { label: "Trial", date: "2026-12-07", daysUntil: 74 }] }),
  matter({ id: "m_north", keyDates: [{ label: "Fact discovery closes", date: "2026-10-15", daysUntil: 21 }] }),
];

describe("Today spine model", () => {
  it("lists the next deadlines across events and matter key dates without duplicates", () => {
    // A hearing today is the most urgent item, then the mediation in 4 days, then the filing in 8.
    const d = upcomingDeadlines({ now: NOW, userId: "me", events, tasks, matterOverview: overview }, 3);
    expect(d.map((x) => x.id)).toEqual(["e_today_hearing", "e_other_matter", "e_filing"]);
    expect(d[0].kind).toBe("hearing");
    expect(d[0].days).toBe(0);
    expect(d[2].days).toBe(8);
    expect(d[2].href).toBe("/?event=e_filing");
    const more = upcomingDeadlines({ now: NOW, userId: "me", events, tasks, matterOverview: overview }, 6);
    // The matter key date on 2026-10-02 is the same day as the filing event, so it is not listed twice.
    expect(more.filter((x) => x.date.startsWith("2026-10-02"))).toHaveLength(1);
    // A derived key-date event links to the matter; the trial key date (not on the calendar) is added from the matter.
    const derived = more.find((x) => x.id === "e_derived")!;
    expect(derived.source).toBe("matter");
    expect(derived.href).toBe("/matters?id=m_north");
    expect(more.map((x) => x.title)).toContain("Trial");
  });
  it("adds matter key dates that are not on the calendar and respects the horizon", () => {
    const d = upcomingDeadlines({ now: NOW, userId: "me", events: [], tasks, matterOverview: overview }, 5);
    expect(d.map((x) => x.title)).toEqual(["Opposition due", "Fact discovery closes", "Trial"]);
    expect(d.every((x) => x.source === "matter" && x.kind === "key-date")).toBe(true);
    const none = upcomingDeadlines({ now: NOW, userId: "me", events: [events[5]], tasks, matterOverview: [] }, 3);
    expect(none).toEqual([]); // 2027-06-01 is beyond the 120-day horizon
  });
  it("honours the matter filter", () => {
    const d = upcomingDeadlines({ now: NOW, userId: "me", matterFilter: "m_vls", events, tasks, matterOverview: overview }, 3);
    expect(d.every((x) => x.matterId === "m_vls")).toBe(true);
    expect(todaysEvents({ now: NOW, userId: "me", matterFilter: "m_vls", events, tasks, matterOverview: overview }).map((e) => e.id)).toEqual(["e_today_hearing"]);
  });
  it("orders today's events all-day first, then by time", () => {
    expect(todaysEvents({ now: NOW, userId: "me", events, tasks, matterOverview: overview }).map((e) => e.id)).toEqual(["e_allday", "e_today_meeting", "e_today_hearing"]);
  });
  it("splits my open tasks into overdue (most overdue, then priority) and due today", () => {
    const { overdue, dueToday } = myTasksDue({ now: NOW, userId: "me", events, tasks, matterOverview: overview });
    expect(overdue.map((t) => t.id)).toEqual(["t_overdue_low", "t_overdue_urgent"]);
    expect(dueToday.map((t) => t.id)).toEqual(["t_today"]);
    expect(overdue.some((t) => "_d" in t)).toBe(false);
  });
  it("writes a one-line summary", () => {
    const s = computeTodaySpine({ now: NOW, userId: "me", events, tasks, matterOverview: overview });
    expect(s.summary).toBe("Status conference is today · 3 events today · 2 overdue tasks");
    const noHearing = computeTodaySpine({ now: NOW, userId: "me", events: events.filter((e) => e.id !== "e_today_hearing"), tasks, matterOverview: overview });
    expect(noHearing.summary).toBe("Next deadline in 4 days · 2 events today · 2 overdue tasks");
    expect(spineSummary({ deadlines: [], todayEvents: [], overdueTasks: [], dueTodayTasks: [] })).toBe("No events today · nothing overdue");
    expect(spineSummary({ deadlines: [{ id: "x", title: "Reply brief", date: "2026-09-24", kind: "filing", days: 0, source: "event" }], todayEvents: [], overdueTasks: [], dueTodayTasks: [tasks[2]] })).toBe("Reply brief is due today · no events today · 1 task due today");
  });
  it("tones deadline chips by urgency", () => {
    expect(deadlineTone(0)).toBe("danger");
    expect(deadlineTone(7)).toBe("warning");
    expect(deadlineTone(30)).toBe("accent");
    expect(deadlineTone(31)).toBe("quiet");
  });
});

describe("shell navigation", () => {
  it("keeps the G chord in sync with the nav shortcuts, group children and section tabs included", () => {
    const entries = [...NAV, ...SECONDARY_NAV].flatMap((item) => [item, ...(item.children ?? []), ...(item.tabs ?? []).flatMap((tb) => [tb, ...(tb.sub ?? [])])]);
    let checked = 0;
    for (const item of entries) {
      if (!item.shortcut) continue;
      const key = item.shortcut.split(" ")[1].toLowerCase();
      expect(GO_CHORD[key]).toBe(item.href);
      checked++;
    }
    expect(Object.keys(GO_CHORD)).toHaveLength(checked);
    expect(GO_CHORD[","]).toBe("/settings");
  });
  it("groups palette hits by kind, matters first, with pluralised headings", () => {
    const hits: QuickSearchHit[] = [
      { id: "d1", kind: "document", title: "Memo", href: "/x" },
      { id: "m1", kind: "matter", title: "Valsara v. Meridian", href: "/y" },
      { id: "d2", kind: "document", title: "Email", href: "/z" },
      { id: "p1", kind: "person", title: "Hegde", href: "/p" },
    ];
    const g = groupHits(hits);
    expect(g.map((x) => x.kind)).toEqual(["matter", "document", "person"]);
    expect(g.map((x) => x.label)).toEqual(["Matter", "Documents", "Person"]);
    expect(g[1].hits.map((h) => h.id)).toEqual(["d1", "d2"]);
    expect(groupHits([])).toEqual([]);
  });
});

describe("e-discovery rail and workflow gates", () => {
  it("counts active facet values across keys", () => {
    expect(activeFacetCount({})).toBe(0);
    expect(activeFacetCount({ custodians: ["c1", "c2"], years: ["2001"], types: [] })).toBe(3);
  });
  it("recognises trust-gate approvals, including legacy rows that only carry reasons", () => {
    expect(isTrustGate({ kind: "trust-gate", reasons: [] })).toBe(true);
    expect(isTrustGate({ kind: "approval", reasons: ["x"] })).toBe(false);
    expect(isTrustGate({ reasons: ["confidence 40% is below the gate"] })).toBe(true);
    expect(isTrustGate({})).toBe(false);
  });
});
