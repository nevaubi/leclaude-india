import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { computeDeadline, federalHolidays, isCourtDay, DEADLINE_PRESETS } from "@/modules/home/deadline";
import { countdown, countdownPhrase, dateKey, startOfWeek, toDate } from "@/modules/home/time";
import { computeFallbackBrief, collectBriefFacts } from "@/modules/home/brief-fallback";
import { HOME_SEED_IDS } from "@/modules/home/seed";
import { addReply, buildBriefContext, createEvent, createTask, createUpdate, deleteEvent, deleteTask, getOrComputeBrief, keyDateEntries, listEvents, listNews, listTasks, listUpdates, matterOverview, saveNewsToLibrary, toggleReaction, updateEvent, updateTask, NEWS_CLIPPINGS_FOLDER_ID, getCachedBrief } from "@/modules/home/service";
import { taskCreateSchema, eventCreateSchema, deadlineSchema } from "@/modules/home/schemas";
import { eventFormFor, taskFormFor } from "@/modules/home/forms";
import { dropFailedRetry, type AgentMessage } from "@/hooks/use-agent";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";

const NOW = new Date(2026, 8, 23, 9, 30); // Wed Sept 23, 2026 09:30 local

beforeAll(() => { resetSqlite(); db(); });

describe("deadline calculator (FRCP 6(a))", () => {
  it("computes federal holidays with observed dates", () => {
    const h = federalHolidays(2026);
    const names = Object.fromEntries(h.map((x) => [x.name, x.date]));
    expect(names["Independence Day"]).toBe("2026-07-03"); // July 4 is a Saturday → observed Friday
    expect(names["Thanksgiving Day"]).toBe("2026-11-26");
    expect(names["Veterans Day"]).toBe("2026-11-11");
    expect(names["Christmas Day"]).toBe("2026-12-25");
    expect(names["Columbus Day"]).toBe("2026-10-12");
    expect(names["Birthday of Martin Luther King, Jr."]).toBe("2026-01-19");
    expect(isCourtDay("2026-09-23")).toBe(true);
    expect(isCourtDay("2026-09-26")).toBe(false);
    expect(isCourtDay("2026-10-12")).toBe(false);
  });
  it("counts calendar days for periods of 11+ days", () => {
    const r = computeDeadline({ trigger: "2026-09-23", days: 14 });
    expect(r.dueDate).toBe("2026-10-07");
    expect(r.rolled).toBe(false);
    expect(r.countedCourtDaysOnly).toBe(false);
    expect(r.weekday).toBe("Wednesday");
  });
  it("skips weekends and holidays for periods under 11 days", () => {
    const r = computeDeadline({ trigger: "2026-09-23", days: 7 });
    expect(r.countedCourtDaysOnly).toBe(true);
    expect(r.dueDate).toBe("2026-10-02");
    expect(r.skipped.map((s) => s.date)).toEqual(["2026-09-26", "2026-09-27"]);
    const r2 = computeDeadline({ trigger: "2026-10-08", days: 3 }); // crosses Columbus Day (Oct 12)
    expect(r2.dueDate).toBe("2026-10-14");
    expect(r2.skipped.some((s) => s.reason === "Columbus Day")).toBe(true);
  });
  it("rolls a last day that falls on a weekend forward", () => {
    const r = computeDeadline({ trigger: "2026-09-25", days: 30 }); // → Sun Oct 25
    expect(r.rawDate).toBe("2026-10-25");
    expect(r.dueDate).toBe("2026-10-26");
    expect(r.rolled).toBe(true);
    expect(r.rolledReason).toContain("Sunday");
  });
  it("rolls a last day that falls on a federal holiday", () => {
    const r = computeDeadline({ trigger: "2026-10-28", days: 14 }); // → Veterans Day
    expect(r.rawDate).toBe("2026-11-11");
    expect(r.dueDate).toBe("2026-11-12");
    expect(r.rolledReason).toContain("Veterans Day");
    const xmas = computeDeadline({ trigger: "2026-12-11", days: 14 }); // → Fri Dec 25 → Mon Dec 28
    expect(xmas.dueDate).toBe("2026-12-28");
  });
  it("counts backward and rolls to the previous court day", () => {
    const r = computeDeadline({ trigger: "2026-10-14", days: 14, direction: "backward" });
    expect(r.dueDate).toBe("2026-09-30");
    const r2 = computeDeadline({ trigger: "2026-10-11", days: 14, direction: "backward" }); // → Sun Sept 27 → Fri Sept 25
    expect(r2.rawDate).toBe("2026-09-27");
    expect(r2.dueDate).toBe("2026-09-25");
  });
  it("adds 3 mail days under FRCP 6(d) after rollover", () => {
    const r = computeDeadline({ trigger: "2026-09-23", days: 30, addMailDays: true }); // Oct 23 (Fri) + 3 = Mon Oct 26
    expect(r.rawDate).toBe("2026-10-23");
    expect(r.mailDaysAdded).toBe(3);
    expect(r.dueDate).toBe("2026-10-26");
  });
  it("supports pure calendar and court-day methods plus extra closures", () => {
    expect(computeDeadline({ trigger: "2026-09-23", days: 7, method: "calendar" }).dueDate).toBe("2026-09-30");
    expect(computeDeadline({ trigger: "2026-09-23", days: 14, method: "court" }).dueDate).toBe("2026-10-14"); // weekends + Columbus Day skipped
    expect(computeDeadline({ trigger: "2026-09-23", days: 1, extraHolidays: ["2026-09-24"] }).dueDate).toBe("2026-09-25");
    expect(DEADLINE_PRESETS.length).toBeGreaterThan(8);
    expect(deadlineSchema.safeParse({ trigger: "2026-09-23", days: 21 }).success).toBe(true);
    expect(deadlineSchema.safeParse({ trigger: "9/23/2026", days: 21 }).success).toBe(false);
  });
});

describe("time helpers", () => {
  it("treats date-only strings as local dates", () => {
    expect(dateKey("2026-10-14")).toBe("2026-10-14");
    expect(toDate("2026-10-14").getDate()).toBe(14);
    expect(dateKey(startOfWeek(NOW))).toBe("2026-09-21");
  });
  it("produces countdown chips", () => {
    expect(countdown("2026-09-23", NOW).label).toBe("today");
    expect(countdown("2026-09-24", NOW).label).toBe("tomorrow");
    expect(countdown("2026-09-26", NOW)).toMatchObject({ label: "in 3d", urgency: "soon" });
    expect(countdown("2026-10-14", NOW)).toMatchObject({ label: "in 3 wk", urgency: "upcoming" });
    expect(countdown("2026-09-21", NOW, { deadline: true })).toMatchObject({ label: "overdue 2d", urgency: "overdue" });
    expect(countdown("2026-09-21", NOW).label).toBe("2d ago");
    expect(countdown("2027-03-08", NOW).label).toBe("in 6 mo");
    expect(countdownPhrase("2026-10-14", NOW)).toBe("in 3 weeks");
    expect(countdownPhrase("2026-09-19", NOW)).toBe("4 days ago");
  });
});

describe("seed", () => {
  it("seeds realistic home data", () => {
    const d = db();
    expect(HOME_SEED_IDS.tasks.length).toBeGreaterThanOrEqual(25);
    expect(HOME_SEED_IDS.events.length).toBeGreaterThanOrEqual(30);
    expect(HOME_SEED_IDS.news.length).toBeGreaterThanOrEqual(30);
    expect(HOME_SEED_IDS.updates.length).toBeGreaterThanOrEqual(12);
    expect(d.tasks.count()).toBeGreaterThanOrEqual(25);
    expect(d.events.count()).toBeGreaterThanOrEqual(30);
    expect(d.news.count()).toBeGreaterThanOrEqual(30);
    expect(d.updates.count()).toBeGreaterThanOrEqual(12);
    const cats = new Set(d.news.all().map((n) => n.category));
    for (const c of ["court", "regulatory", "legislative", "industry", "firm", "client"]) expect(cats.has(c as never)).toBe(true);
    for (const n of d.news.all()) { expect(n.publishedAt >= "2026-08-24" && n.publishedAt <= "2026-09-23").toBe(true); expect(n.summary.length).toBeGreaterThan(60); }
    expect(d.tasks.find((t) => t.source === "workflow").length).toBeGreaterThanOrEqual(3);
    expect(d.tasks.find((t) => t.source === "agent").length).toBeGreaterThanOrEqual(3);
    // Every seeded attendee / assignee / author exists.
    for (const e of d.events.all()) for (const id of e.attendeeIds ?? []) expect(d.people.has(id), `attendee ${id}`).toBe(true);
    for (const t of d.tasks.all()) if (t.assigneeId) expect(d.people.has(t.assigneeId)).toBe(true);
    for (const u of d.updates.all()) expect(d.people.has(u.authorId)).toBe(true);
    // Filing deadlines match matter key dates.
    const valsara = d.matters.get(MATTERS.valsara)!;
    for (const k of valsara.keyDates ?? []) {
      const covered = d.events.findOne((e) => e.matterId === valsara.id && e.startsAt.startsWith(k.date)) || keyDateEntries().some((e) => e.matterId === valsara.id && e.startsAt === k.date);
      expect(covered, k.label).toBeTruthy();
    }
  });
  it("merges matter key dates as read-only deadline pseudo-events without duplicating stored ones", () => {
    const entries = listEvents({ from: "2026-09-01", to: "2027-06-30" });
    const derived = entries.filter((e) => e.derived);
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((e) => e.kind === "deadline" && e.allDay)).toBe(true);
    // The evidentiary hearing (no stored event) is derived; Tier 2 production (stored filing) is not duplicated.
    expect(derived.some((e) => e.derived!.label.startsWith("Evidentiary hearing"))).toBe(true);
    expect(entries.filter((e) => e.matterId === MATTERS.valsara && e.startsAt.startsWith("2026-10-14")).length).toBe(1);
    expect(listEvents({ matterId: MATTERS.harbor }).every((e) => e.matterId === MATTERS.harbor)).toBe(true);
  });
});

describe("task service", () => {
  it("creates, lists, updates and deletes tasks", () => {
    const t = createTask({ title: "  Draft Rule 26(f) report  ", matterId: MATTERS.northgate, priority: "high", dueAt: "2026-09-30", tags: ["discovery"] });
    expect(t.id.startsWith("t_")).toBe(true);
    expect(t.title).toBe("Draft Rule 26(f) report");
    expect(t.assigneeId).toBe(PEOPLE.arjunMehra);
    expect(t.status).toBe("todo");
    expect(t.source).toBe("manual");
    expect(listTasks({ matterId: MATTERS.northgate, now: NOW }).some((x) => x.id === t.id)).toBe(true);
    const u = updateTask(t.id, { status: "in_progress", dueAt: null, assigneeId: PEOPLE.eshaMathur })!;
    expect(u.status).toBe("in_progress");
    expect(u.dueAt).toBeUndefined();
    expect(u.assigneeId).toBe(PEOPLE.eshaMathur);
    expect(u.updatedAt >= t.updatedAt).toBe(true);
    expect(u.createdAt).toBe(t.createdAt);
    expect(deleteTask(t.id)).toBe(true);
    expect(deleteTask(t.id)).toBe(false);
    expect(updateTask("nope", { title: "x" })).toBeNull();
  });
  it("filters overdue, mine and status, sorted by due date then priority", () => {
    const overdue = listTasks({ overdue: true, now: NOW });
    expect(overdue.length).toBeGreaterThanOrEqual(3);
    expect(overdue.every((t) => t.status !== "done" && t.dueAt! < "2026-09-23")).toBe(true);
    const mine = listTasks({ assigneeId: PEOPLE.arjunMehra, now: NOW, includeDone: false });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.assigneeId === PEOPLE.arjunMehra && t.status !== "done")).toBe(true);
    const all = listTasks({ now: NOW });
    const dues = all.map((t) => t.dueAt ?? "9999");
    expect([...dues].sort()).toEqual(dues);
    expect(listTasks({ status: "review", now: NOW }).every((t) => t.status === "review")).toBe(true);
    expect(taskCreateSchema.safeParse({ title: "" }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ title: "ok", priority: "critical" }).success).toBe(false);
  });
});

describe("event service", () => {
  it("creates, updates and deletes events; key dates are protected", () => {
    const e = createEvent({ title: "Rule 16 conference", startsAt: "2026-10-20T10:00:00", endsAt: "2026-10-20T11:00:00", kind: "hearing", matterId: MATTERS.northgate, attendeeIds: [PEOPLE.dhruvOberoi] });
    expect(e.allDay).toBe(false);
    const allDay = createEvent({ title: "Expert disclosure", startsAt: "2026-11-02" });
    expect(allDay.allDay).toBe(true);
    expect(allDay.kind).toBe("meeting");
    const u = updateEvent(e.id, { location: "Courtroom 1403", endsAt: null })!;
    expect(u.location).toBe("Courtroom 1403");
    expect(u.endsAt).toBeUndefined();
    expect(listEvents({ from: "2026-10-20", to: "2026-10-20" }).some((x) => x.id === e.id)).toBe(true);
    expect(deleteEvent(e.id)).toBe(true);
    expect(deleteEvent(allDay.id)).toBe(true);
    expect(updateEvent("kd_m_valsara_arb_3", { title: "x" })).toBeNull();
    expect(eventCreateSchema.safeParse({ title: "x", startsAt: "2026-10-20", kind: "party" }).success).toBe(false);
  });
});

describe("team updates", () => {
  it("posts, reacts, replies and deletes", () => {
    const u = createUpdate({ body: "Filed the reply brief.", kind: "win", matterId: MATTERS.northgate });
    expect(u.authorId).toBe(PEOPLE.arjunMehra);
    const r1 = toggleReaction(u.id, "🎉")!;
    expect(r1.reactions?.["🎉"]).toBe(1);
    expect(r1.myReactions).toEqual(["🎉"]);
    const r2 = toggleReaction(u.id, "🎉")!;
    expect(r2.reactions?.["🎉"]).toBeUndefined();
    expect(r2.myReactions).toEqual([]);
    const reply = addReply(u.id, "Congrats!")!;
    expect(reply.updateId).toBe(u.id);
    const view = listUpdates().find((x) => x.id === u.id)!;
    expect(view.replies.length).toBe(1);
    expect(listUpdates()[0].id).toBe(u.id); // newest first
    expect(db().updates.delete(u.id)).toBe(true);
    expect(addReply("missing", "x")).toBeNull();
    const seeded = listUpdates().find((x) => x.id === "u_sterling_cure_q")!;
    expect(seeded.replies.length).toBe(2);
  });
});

describe("news", () => {
  it("filters and sorts, and saves to the library as a link", () => {
    const court = listNews({ category: "court" });
    expect(court.length).toBeGreaterThanOrEqual(8);
    expect(court.every((n) => n.category === "court")).toBe(true);
    const rel = listNews({ sort: "relevance" }).map((n) => n.relevance ?? 0);
    expect([...rel].sort((a, b) => b - a)).toEqual(rel);
    const newest = listNews({ sort: "newest" }).map((n) => n.publishedAt);
    expect([...newest].sort().reverse()).toEqual(newest);
    expect(listNews({ practiceArea: "Employment" }).every((n) => n.practiceAreas?.includes("Employment"))).toBe(true);
    expect(listNews({ matterId: MATTERS.valsara }).length).toBeGreaterThanOrEqual(8);
    expect(listNews({ query: "PAGA" }).length).toBeGreaterThanOrEqual(2);
    const item = saveNewsToLibrary("news_fr_npdwr")!;
    expect(item.type).toBe("link");
    expect(item.parentId).toBe(NEWS_CLIPPINGS_FOLDER_ID);
    expect(db().library.get(NEWS_CLIPPINGS_FOLDER_ID)?.type).toBe("folder");
    expect(saveNewsToLibrary("news_fr_npdwr")!.id).toBe(item.id); // idempotent
    expect(saveNewsToLibrary("missing")).toBeNull();
  });
});

describe("matters overview", () => {
  it("computes next key date countdowns and task counts", () => {
    const rows = matterOverview(NOW);
    expect(rows.length).toBe(5);
    const valsara = rows.find((r) => r.id === MATTERS.valsara)!;
    expect(valsara.nextKeyDate?.label).toBe("Tier 2 production deadline");
    expect(valsara.nextKeyDate?.daysUntil).toBe(21);
    expect(valsara.openTasks).toBeGreaterThan(3);
    expect(valsara.overdueTasks).toBeGreaterThanOrEqual(1);
    expect(valsara.upcomingEvents).toBeGreaterThan(3);
    expect(rows[0].nextKeyDate!.daysUntil).toBeLessThanOrEqual(rows[1].nextKeyDate!.daysUntil);
  });
});

describe("daily brief (computed fallback)", () => {
  it("builds 6–10 grounded bullets from the seeded data", () => {
    const ctx = buildBriefContext(NOW);
    const facts = collectBriefFacts(ctx);
    expect(facts.today).toBe("2026-09-23");
    expect(facts.eventsToday.length).toBeGreaterThanOrEqual(3);
    expect(facts.overdue.length).toBeGreaterThanOrEqual(3);
    expect(facts.keyDatesSoon.some((k) => k.label.startsWith("Bellwether"))).toBe(false); // > 30 days out
    const brief = computeFallbackBrief(ctx);
    expect(brief.source).toBe("computed");
    expect(brief.date).toBe("2026-09-23");
    expect(brief.items.length).toBeGreaterThanOrEqual(6);
    expect(brief.items.length).toBeLessThanOrEqual(10);
    expect(brief.headline).toMatch(/events? today/);
    expect(brief.items[0].text).toMatch(/today's calendar/);
    expect(brief.items.some((i) => /overdue/.test(i.text))).toBe(true);
    expect(brief.items.some((i) => i.kind === "deadline" && /in \d+ (days|weeks)/.test(i.text))).toBe(true);
    expect(brief.items.some((i) => i.kind === "news")).toBe(true);
    expect(brief.items.some((i) => i.kind === "update")).toBe(true);
    expect(brief.stats.overdueTasks).toBe(facts.overdue.length);
    expect(brief.items.every((i) => i.text.length > 20 && !/lorem/i.test(i.text))).toBe(true);
  });
  it("caches the computed brief per day in kv", () => {
    const b1 = getOrComputeBrief(NOW);
    expect(getCachedBrief("2026-09-23")?.generatedAt).toBe(b1.generatedAt);
    const b2 = getOrComputeBrief(new Date(2026, 8, 23, 16, 0));
    expect(b2.generatedAt).toBe(b1.generatedAt);
    expect(db().kv.get("home:brief:2026-09-23")).toBeTruthy();
  });
  it("handles an empty day gracefully", () => {
    const ctx = buildBriefContext(new Date(2031, 0, 5, 9, 0));
    const brief = computeFallbackBrief({ ...ctx, tasks: [], updates: [], news: [] });
    expect(brief.items.length).toBeGreaterThanOrEqual(1);
    expect(brief.items[0].text).toMatch(/No events/);
    expect(brief.headline).toMatch(/Quiet day/);
  });
});

describe("dialog form state (regression: edit dialogs opened empty)", () => {
  it("initialises the task form from the task being edited, not the defaults", () => {
    const task = listTasks({ now: NOW })[0];
    const form = taskFormFor(task, null, { userId: "p_someone", matterFilter: "m_other" });
    expect(form.title).toBe(task.title);
    expect(form.matterId).toBe(task.matterId ?? "");
    expect(form.assigneeId).toBe(task.assigneeId ?? "");
    expect(form.status).toBe(task.status);
    expect(form.tags).toBe((task.tags ?? []).join(", "));
    const fresh = taskFormFor(null, { title: "Prefilled" }, { userId: "p_me", matterFilter: "m_valsara_arb" });
    expect(fresh).toMatchObject({ title: "Prefilled", assigneeId: "p_me", matterId: "m_valsara_arb", status: "todo", priority: "medium" });
  });
  it("initialises the event form from the event being edited and splits times", () => {
    const form = eventFormFor({ id: "ev_x", title: "Hearing on MSJ", kind: "hearing", startsAt: "2026-10-09T09:30:00", endsAt: "2026-10-09T11:00:00", matterId: "m_northgate_v_apex", attendeeIds: ["p_jwhitfield"], location: "Courtroom 6" }, null, NOW);
    expect(form).toMatchObject({ title: "Hearing on MSJ", kind: "hearing", date: "2026-10-09", start: "09:30", end: "11:00", allDay: false, matterId: "m_northgate_v_apex", location: "Courtroom 6", attendeeIds: ["p_jwhitfield"] });
    const allDay = eventFormFor(null, { title: "Reply due", startsAt: "2026-10-14" }, NOW);
    expect(allDay).toMatchObject({ title: "Reply due", date: "2026-10-14", allDay: true, kind: "meeting" });
    const blank = eventFormFor(null, null, NOW);
    expect(blank.date).toBe(dateKey(NOW));
    expect(blank.start).toBe("10:00");
  });
});

describe("assistant dock retry", () => {
  it("replaces a failed turn instead of duplicating the user message", () => {
    const ms: AgentMessage[] = [
      { id: "u1", role: "user", content: "hello", createdAt: 1 },
      { id: "a1", role: "assistant", content: "", createdAt: 2, status: "error", error: "OPENAI_API_KEY missing" },
    ];
    expect(dropFailedRetry(ms, "hello").map((m) => m.id)).toEqual([]);
    expect(dropFailedRetry(ms, "something else").map((m) => m.id)).toEqual(["u1", "a1"]);
    const ok: AgentMessage[] = [ms[0], { ...ms[1], status: "done", content: "hi" }];
    expect(dropFailedRetry(ok, "hello")).toBe(ok);
  });
});
