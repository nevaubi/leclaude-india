/**
 * Computed (non-AI) daily brief. Pure so it can run in tests and as the
 * always-available fallback when no OpenAI key is configured.
 */
import type { NewsItem, Task, TeamUpdate } from "@/lib/types/domain";
import type { BriefItem, CalendarEntry, DailyBrief, MatterLite, PersonLite } from "./types";
import { addDays, countdownPhrase, dateKey, daysBetween, endOfWeek, fmtTime, startOfDay, startOfWeek, toDate } from "./time";
import { matterHref } from "@/lib/features";

export interface BriefContext {
  now: Date;
  userId: string;
  userName: string;
  events: CalendarEntry[];
  tasks: Task[];
  news: NewsItem[];
  updates: TeamUpdate[];
  matters: MatterLite[];
  people: PersonLite[];
}

export interface BriefFacts {
  today: string;
  eventsToday: CalendarEntry[];
  eventsThisWeek: CalendarEntry[];
  overdue: Task[];
  dueSoon: Task[];
  hotNews: NewsItem[];
  recentUpdates: TeamUpdate[];
  keyDatesSoon: { matter: MatterLite; label: string; date: string; days: number }[];
}

export function collectBriefFacts(ctx: BriefContext): BriefFacts {
  const { now } = ctx;
  const today = dateKey(now);
  const weekStart = startOfWeek(now);
  const weekEnd = addDays(endOfWeek(now), 1);
  const sortByStart = (a: CalendarEntry, b: CalendarEntry) => a.startsAt.localeCompare(b.startsAt);
  const eventsToday = ctx.events.filter((e) => dateKey(e.startsAt) === today).sort(sortByStart);
  const eventsThisWeek = ctx.events.filter((e) => { const t = toDate(e.startsAt).getTime(); return t >= weekStart.getTime() && t < weekEnd.getTime(); }).sort(sortByStart);
  const open = ctx.tasks.filter((t) => t.status !== "done");
  const overdue = open.filter((t) => t.dueAt && daysBetween(now, toDate(t.dueAt)) < 0).sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  const dueSoon = open.filter((t) => t.dueAt && daysBetween(now, toDate(t.dueAt)) >= 0 && daysBetween(now, toDate(t.dueAt)) <= 7).sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  const sevenDaysAgo = addDays(now, -7).getTime();
  const hotNews = ctx.news.filter((n) => (n.relevance ?? 0) >= 80 && toDate(n.publishedAt).getTime() >= sevenDaysAgo).sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || b.publishedAt.localeCompare(a.publishedAt));
  const threeDaysAgo = addDays(now, -3).getTime();
  const recentUpdates = ctx.updates.filter((u) => toDate(u.createdAt).getTime() >= threeDaysAgo).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keyDatesSoon = ctx.matters
    .flatMap((m) => m.keyDates.map((k) => ({ matter: m, label: k.label, date: k.date, days: daysBetween(now, toDate(k.date)) })))
    .filter((k) => k.days >= 0 && k.days <= 30)
    .sort((a, b) => a.days - b.days);
  return { today, eventsToday, eventsThisWeek, overdue, dueSoon, hotNews, recentUpdates, keyDatesSoon };
}

export function briefStats(facts: BriefFacts): DailyBrief["stats"] {
  return { eventsToday: facts.eventsToday.length, eventsThisWeek: facts.eventsThisWeek.length, overdueTasks: facts.overdue.length, dueSoonTasks: facts.dueSoon.length, hotNews: facts.hotNews.length, recentUpdates: facts.recentUpdates.length };
}

export function computeFallbackBrief(ctx: BriefContext): DailyBrief {
  const facts = collectBriefFacts(ctx);
  const { now } = ctx;
  const matterName = (id?: string) => ctx.matters.find((m) => m.id === id)?.shortName;
  const personName = (id?: string) => ctx.people.find((p) => p.id === id)?.name?.split(" ")[0];
  const items: BriefItem[] = [];

  // 1. Today's calendar.
  if (facts.eventsToday.length) {
    const first = facts.eventsToday.slice(0, 3).map((e) => `${e.allDay ? "all day" : fmtTime(e.startsAt)} ${e.title}${matterName(e.matterId) ? ` (${matterName(e.matterId)})` : ""}`).join("; ");
    items.push({ kind: "hearing", text: `${facts.eventsToday.length} on today's calendar: ${first}${facts.eventsToday.length > 3 ? `; +${facts.eventsToday.length - 3} more` : ""}.`, href: "/#calendar" });
  } else {
    items.push({ kind: "note", text: "No events on today's calendar. Good day for deep work on briefs and review.", href: "/#calendar" });
  }

  // 2. Overdue tasks.
  if (facts.overdue.length) {
    const mine = facts.overdue.filter((t) => t.assigneeId === ctx.userId);
    const top = facts.overdue[0];
    items.push({ kind: "task", text: `${facts.overdue.length} overdue task${facts.overdue.length === 1 ? "" : "s"}${mine.length ? ` (${mine.length} yours)` : ""}. Oldest: "${top.title}" (${countdownPhrase(top.dueAt!, now)}${matterName(top.matterId) ? `, ${matterName(top.matterId)}` : ""}).`, matterId: top.matterId ?? null, href: "/#tasks" });
  }

  // 3. Matter key dates in the next 30 days.
  for (const k of facts.keyDatesSoon.slice(0, 3)) {
    items.push({ kind: "deadline", text: `${k.matter.shortName}: ${k.label} ${countdownPhrase(k.date, now)} (${fmtLong(k.date)}).`, matterId: k.matter.id, href: matterHref(k.matter.id) });
  }

  // 4. Due-soon tasks.
  if (facts.dueSoon.length) {
    const named = facts.dueSoon.slice(0, 3).map((t) => `"${t.title}" ${countdownPhrase(t.dueAt!, now)}${personName(t.assigneeId) ? ` — ${personName(t.assigneeId)}` : ""}`).join("; ");
    items.push({ kind: "task", text: `${facts.dueSoon.length} task${facts.dueSoon.length === 1 ? "" : "s"} due in the next 7 days: ${named}.`, href: "/#tasks" });
  }

  // 5. Hearings / depositions later this week.
  const restOfWeek = facts.eventsThisWeek.filter((e) => dateKey(e.startsAt) > facts.today && (e.kind === "hearing" || e.kind === "deposition" || e.kind === "filing"));
  for (const e of restOfWeek.slice(0, 2)) {
    items.push({ kind: e.kind === "filing" ? "deadline" : "hearing", text: `${labelKind(e.kind)} ${countdownPhrase(e.startsAt, now)}: ${e.title}${e.location ? ` — ${e.location}` : ""}.`, matterId: e.matterId ?? null, href: "/#calendar" });
  }

  // 6. Hot news.
  for (const n of facts.hotNews.slice(0, 2)) {
    items.push({ kind: "news", text: `${n.source}: ${n.title}${n.matterIds?.length ? ` (relevant to ${n.matterIds.map(matterName).filter(Boolean).join(", ")})` : ""}.`, matterId: n.matterIds?.[0] ?? null, href: n.url ?? "/#news" });
  }

  // 7. Team updates.
  const wins = facts.recentUpdates.filter((u) => u.kind === "win");
  const questions = facts.recentUpdates.filter((u) => u.kind === "question");
  if (wins.length) items.push({ kind: "update", text: `Win from ${personName(wins[0].authorId) ?? "the team"}${matterName(wins[0].matterId) ? ` on ${matterName(wins[0].matterId)}` : ""}: ${truncate(wins[0].body, 140)}`, matterId: wins[0].matterId ?? null, href: "/#updates" });
  if (questions.length) items.push({ kind: "update", text: `Open question from ${personName(questions[0].authorId) ?? "a colleague"}: ${truncate(questions[0].body, 140)}`, matterId: questions[0].matterId ?? null, href: "/#updates" });
  if (!wins.length && !questions.length && facts.recentUpdates.length) items.push({ kind: "update", text: `${facts.recentUpdates.length} team update${facts.recentUpdates.length === 1 ? "" : "s"} in the last 3 days; latest from ${personName(facts.recentUpdates[0].authorId) ?? "the team"}: ${truncate(facts.recentUpdates[0].body, 120)}`, href: "/#updates" });

  const headline = headlineFor(facts, now);
  return {
    date: facts.today,
    generatedAt: now.toISOString(),
    source: "computed",
    headline,
    items: items.slice(0, 10),
    stats: briefStats(facts),
  };
}

function headlineFor(facts: BriefFacts, now: Date): string {
  const parts: string[] = [];
  if (facts.eventsToday.length) parts.push(`${facts.eventsToday.length} event${facts.eventsToday.length === 1 ? "" : "s"} today`);
  if (facts.overdue.length) parts.push(`${facts.overdue.length} overdue`);
  if (facts.dueSoon.length) parts.push(`${facts.dueSoon.length} due this week`);
  const nextKey = facts.keyDatesSoon[0];
  if (nextKey) parts.push(`${nextKey.matter.shortName} ${nextKey.label.toLowerCase()} ${countdownPhrase(nextKey.date, now)}`);
  return parts.length ? parts.join(" · ") : `Quiet day — ${startOfDay(now).toLocaleDateString("en-US", { weekday: "long" })}`;
}

function labelKind(kind: CalendarEntry["kind"]): string {
  return kind === "hearing" ? "Hearing" : kind === "deposition" ? "Deposition" : kind === "filing" ? "Filing" : "Event";
}

function fmtLong(date: string): string {
  return toDate(date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

/** Compact, model-facing rendering of the facts (used as the AI prompt context). */
export function renderFactsForModel(ctx: BriefContext, facts: BriefFacts): string {
  const matterName = (id?: string) => ctx.matters.find((m) => m.id === id)?.shortName ?? "—";
  const personName = (id?: string) => ctx.people.find((p) => p.id === id)?.name ?? "—";
  const lines: string[] = [];
  lines.push(`USER: ${ctx.userName} (${ctx.userId}). TODAY: ${facts.today}.`);
  lines.push(`\nTODAY'S EVENTS (${facts.eventsToday.length}):`);
  for (const e of facts.eventsToday) lines.push(`- [${e.kind}] ${e.allDay ? "all day" : fmtTime(e.startsAt)} ${e.title} | matter=${matterName(e.matterId)} | ${e.location ?? ""} | attendees=${(e.attendeeIds ?? []).map(personName).join(", ")}${e.ruleSource ? ` | rule=${e.ruleSource}` : ""}`);
  lines.push(`\nREST OF THIS WEEK (${facts.eventsThisWeek.length} total):`);
  for (const e of facts.eventsThisWeek.filter((x) => dateKey(x.startsAt) !== facts.today)) lines.push(`- ${dateKey(e.startsAt)} [${e.kind}] ${e.title} | matter=${matterName(e.matterId)}`);
  lines.push(`\nMATTER KEY DATES (next 30 days):`);
  for (const k of facts.keyDatesSoon) lines.push(`- ${k.date} (${countdownPhrase(k.date, ctx.now)}) ${k.matter.shortName}: ${k.label}`);
  lines.push(`\nOVERDUE TASKS (${facts.overdue.length}):`);
  for (const t of facts.overdue) lines.push(`- "${t.title}" due ${t.dueAt} (${countdownPhrase(t.dueAt!, ctx.now)}) | ${t.priority} | ${personName(t.assigneeId)} | matter=${matterName(t.matterId)} | status=${t.status}`);
  lines.push(`\nDUE IN 7 DAYS (${facts.dueSoon.length}):`);
  for (const t of facts.dueSoon) lines.push(`- "${t.title}" due ${t.dueAt} (${countdownPhrase(t.dueAt!, ctx.now)}) | ${t.priority} | ${personName(t.assigneeId)} | matter=${matterName(t.matterId)} | status=${t.status}`);
  lines.push(`\nHOT NEWS (last 7 days, relevance ≥ 80):`);
  for (const n of facts.hotNews.slice(0, 8)) lines.push(`- ${n.publishedAt} [${n.category}] ${n.source}: ${n.title} — ${truncate(n.summary, 220)} | matters=${(n.matterIds ?? []).map(matterName).join(", ")} | relevance=${n.relevance}`);
  lines.push(`\nTEAM UPDATES (last 3 days):`);
  for (const u of facts.recentUpdates.slice(0, 10)) lines.push(`- ${u.createdAt.slice(0, 16)} [${u.kind}] ${personName(u.authorId)} on ${matterName(u.matterId)}: ${truncate(u.body, 260)}`);
  return lines.join("\n");
}
