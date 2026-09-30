/**
 * Pure model for the Home "Today" spine: the next deadlines, today's events and
 * the current user's overdue / due-today tasks. No React, no server imports, so
 * it is unit-tested directly and shared by the spine and the assistant prompt.
 */
import type { Task } from "@/lib/types/domain";
import type { CalendarEntry, MatterOverview } from "../types";
import { dateKey, daysBetween, toDate } from "../time";
import { matterHref } from "@/lib/features";

export type SpineDeadlineKind = "deadline" | "filing" | "hearing" | "key-date";

export interface SpineDeadline {
  id: string;
  title: string;
  /** ISO date or datetime. */
  date: string;
  matterId?: string;
  kind: SpineDeadlineKind;
  /** Whole days from now (0 = today). */
  days: number;
  source: "event" | "matter";
  /** Where a click should go: the event sheet (id) or the matter's e-discovery page. */
  href?: string;
}

export interface TodaySpine {
  deadlines: SpineDeadline[];
  todayEvents: CalendarEntry[];
  overdueTasks: Task[];
  dueTodayTasks: Task[];
  /** One quiet line describing the shape of the day. */
  summary: string;
}

export interface SpineInput {
  now: Date;
  userId: string;
  matterFilter?: string | null;
  events: CalendarEntry[];
  tasks: Task[];
  matterOverview: MatterOverview[];
}

const DEADLINE_KINDS = new Set<CalendarEntry["kind"]>(["deadline", "filing", "hearing"]);

/** Deadline-ish events (deadline, filing, hearing) from today on, then matter key dates not already on the calendar. */
export function upcomingDeadlines(input: SpineInput, limit = 3, horizonDays = 120): SpineDeadline[] {
  const { now, matterFilter } = input;
  const seen = new Set<string>();
  const out: SpineDeadline[] = [];
  const events = input.events.filter((e) => (!matterFilter || e.matterId === matterFilter) && DEADLINE_KINDS.has(e.kind));
  for (const e of events) {
    const days = daysBetween(now, toDate(e.startsAt));
    if (days < 0 || days > horizonDays) continue;
    const key = `${e.matterId ?? ""}|${dateKey(e.startsAt)}|${e.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: e.id, title: e.title, date: e.startsAt, matterId: e.matterId, kind: e.kind === "hearing" ? "hearing" : e.kind === "filing" ? "filing" : e.derived ? "key-date" : "deadline", days, source: e.derived ? "matter" : "event", href: e.derived ? matterHref(e.derived.matterId) : `/?event=${e.id}` });
  }
  for (const m of input.matterOverview) {
    if (matterFilter && m.id !== matterFilter) continue;
    for (const k of m.keyDates) {
      if (k.daysUntil < 0 || k.daysUntil > horizonDays) continue;
      const key = `${m.id}|${k.date}|${k.label.toLowerCase()}`;
      // A key date already projected onto the calendar (same matter + day) is not repeated.
      if (seen.has(key) || out.some((d) => d.matterId === m.id && dateKey(d.date) === k.date)) continue;
      seen.add(key);
      out.push({ id: `${m.id}:${k.date}:${k.label}`, title: k.label, date: k.date, matterId: m.id, kind: "key-date", days: k.daysUntil, source: "matter", href: matterHref(m.id) });
    }
  }
  out.sort((a, b) => a.days - b.days || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return out.slice(0, limit);
}

export function todaysEvents(input: SpineInput): CalendarEntry[] {
  const todayKey = dateKey(input.now);
  return input.events
    .filter((e) => (!input.matterFilter || e.matterId === input.matterFilter) && dateKey(e.startsAt) === todayKey)
    .sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay) || a.startsAt.localeCompare(b.startsAt));
}

/** The user's open tasks split into overdue and due today (most urgent first, urgent priority breaks ties). */
export function myTasksDue(input: SpineInput): { overdue: Task[]; dueToday: Task[] } {
  const rank: Record<Task["priority"], number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const mine = input.tasks.filter((t) => t.status !== "done" && t.assigneeId === input.userId && !!t.dueAt && (!input.matterFilter || t.matterId === input.matterFilter));
  const overdue: (Task & { _d: number })[] = [];
  const dueToday: (Task & { _d: number })[] = [];
  for (const t of mine) {
    const d = daysBetween(input.now, toDate(t.dueAt!));
    if (d < 0) overdue.push({ ...t, _d: d });
    else if (d === 0) dueToday.push({ ...t, _d: d });
  }
  const strip = (t: Task & { _d: number }) => { const { _d, ...rest } = t; void _d; return rest as Task; };
  overdue.sort((a, b) => a._d - b._d || rank[a.priority] - rank[b.priority] || a.title.localeCompare(b.title));
  dueToday.sort((a, b) => rank[a.priority] - rank[b.priority] || a.title.localeCompare(b.title));
  return { overdue: overdue.map(strip), dueToday: dueToday.map(strip) };
}

export function spineSummary(s: Pick<TodaySpine, "deadlines" | "todayEvents" | "overdueTasks" | "dueTodayTasks">): string {
  const parts: string[] = [];
  const next = s.deadlines[0];
  if (next) {
    const verb = next.kind === "hearing" ? "is" : "is due";
    parts.push(next.days === 0 ? `${next.title} ${verb} today` : next.days === 1 ? `${next.title} ${verb} tomorrow` : `next deadline in ${next.days} days`);
  }
  parts.push(s.todayEvents.length ? `${s.todayEvents.length} event${s.todayEvents.length === 1 ? "" : "s"} today` : "no events today");
  if (s.overdueTasks.length) parts.push(`${s.overdueTasks.length} overdue task${s.overdueTasks.length === 1 ? "" : "s"}`);
  else if (s.dueTodayTasks.length) parts.push(`${s.dueTodayTasks.length} task${s.dueTodayTasks.length === 1 ? "" : "s"} due today`);
  else parts.push("nothing overdue");
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function computeTodaySpine(input: SpineInput, opts: { deadlineLimit?: number } = {}): TodaySpine {
  const deadlines = upcomingDeadlines(input, opts.deadlineLimit ?? 3);
  const todayEvents = todaysEvents(input);
  const { overdue, dueToday } = myTasksDue(input);
  const partial = { deadlines, todayEvents, overdueTasks: overdue, dueTodayTasks: dueToday };
  return { ...partial, summary: spineSummary(partial) };
}

/** Countdown tone for a deadline chip: overdue/today read as danger, this week as warning, later stays quiet. */
export function deadlineTone(days: number): "danger" | "warning" | "accent" | "quiet" {
  if (days <= 0) return "danger";
  if (days <= 7) return "warning";
  if (days <= 30) return "accent";
  return "quiet";
}
