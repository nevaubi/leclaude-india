"use client";
import * as React from "react";
import type { TFunction } from "@/lib/i18n/translator";
import { relativeDue } from "@/lib/i18n/relative";
import { useI18n } from "@/lib/i18n/client";
import Link from "next/link";
import { CalendarClock, ChevronRight, MessageSquareText, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { dueText, fmtTime, greetingFor, DATE_ONLY_RE } from "../time";
import { EVENT_KIND_LABEL } from "../types";
import { useHomeUI } from "../store";
import { useHome } from "./home-provider";
import { computeTodaySpine, type SpineDeadline, type TodaySpine as TodaySpineModel } from "./today-spine-model";

/** "Good morning, Dana." with the first name, or no name at all before setup. */
export function greetingLine(now: Date, userName: string, t?: TFunction): string {
  const first = userName.trim().split(/\s+/)[0] ?? "";
  if (!t) return `${greetingFor(now)}${first ? `, ${first}` : ""}.`;
  const h = now.getHours();
  const period = h < 5 ? "late" : h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  return first ? t(`home.greeting.${period}`, { name: first }) : t(`home.greeting.${period}NoName`);
}

/** The spine's one-line summary in the UI language (the model's English `summary` stays the tested source). */
function localSummary(s: Pick<TodaySpineModel, "deadlines" | "todayEvents" | "overdueTasks" | "dueTodayTasks">, t: TFunction): string {
  const parts: string[] = [];
  const next = s.deadlines[0];
  if (next) {
    const hearing = next.kind === "hearing";
    parts.push(next.days === 0 ? t(hearing ? "home.summary.hearingToday" : "home.summary.dueToday", { title: next.title })
      : next.days === 1 ? t(hearing ? "home.summary.hearingTomorrow" : "home.summary.dueTomorrow", { title: next.title })
      : t("home.summary.nextDeadline", { count: next.days }));
  }
  parts.push(t("home.summary.eventsToday", { count: s.todayEvents.length }));
  if (s.overdueTasks.length) parts.push(t("home.summary.overdueTasks", { count: s.overdueTasks.length }));
  else if (s.dueTodayTasks.length) parts.push(t("home.summary.tasksDueToday", { count: s.dueTodayTasks.length }));
  else parts.push(t("home.summary.nothingOverdue"));
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * The "Today" spine: the greeting, then three quiet columns that answer the
 * litigator's first questions — what is due next, what is on today, and what
 * of mine is late. Due dates are plain text; only overdue items use the danger
 * color. Before the first matter exists and with nothing scheduled, only the
 * greeting and the create actions are shown.
 */
export function TodaySpine({ firstRun = false }: { firstRun?: boolean }) {
  const { now, userId, userName, events, tasks, matterOverview, matterFilter, matterById, aiConfigured } = useHome();
  const setFocus = useHomeUI((s) => s.setFocus);
  const setTaskFilter = useHomeUI((s) => s.setTaskFilter);
  const openEvent = useHomeUI((s) => s.openEvent);
  const openTaskDialog = useHomeUI((s) => s.openTaskDialog);
  const openEventDialog = useHomeUI((s) => s.openEventDialog);
  const askAssistant = useHomeUI((s) => s.askAssistant);
  const i18n = useI18n();
  const { t } = i18n;
  const spine = React.useMemo(() => computeTodaySpine({ now, userId, matterFilter, events, tasks, matterOverview }), [now, userId, matterFilter, events, tasks, matterOverview]);
  const matter = matterById(matterFilter);
  const myTasks = [...spine.overdueTasks, ...spine.dueTodayTasks].slice(0, 5);
  const empty = spine.deadlines.length === 0 && spine.todayEvents.length === 0 && myTasks.length === 0;
  const showColumns = !(firstRun && empty);

  return (
    <section aria-label={t("home.todayAria")}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pb-3">
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold leading-tight tracking-tight">{greetingLine(now, userName, t)}</h1>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{i18n.date(now, "full")}{matter ? ` · ${matter.shortName}` : ""}{showColumns ? ` · ${localSummary(spine, t)}` : ""}</p>
        </div>
        {/* Creation lives in the top bar's New menu; the first-run page repeats it next to the greeting. */}
        {(firstRun || aiConfigured) && (
          <div className="flex flex-wrap items-center gap-1">
            {firstRun && <Button variant="ghost" size="xs" onClick={() => openTaskDialog({})}><Plus className="size-3" /> {t("home.spine.task")}</Button>}
            {firstRun && <Button variant="ghost" size="xs" onClick={() => openEventDialog({})}><CalendarClock className="size-3" /> {t("home.spine.event")}</Button>}
            {!firstRun && aiConfigured && <Button variant="ghost" size="xs" onClick={() => askAssistant(t("home.spine.askTodayPrompt"))}><MessageSquareText className="size-3" /> {t("home.spine.askToday")}</Button>}
          </div>
        )}
      </div>
      {showColumns && (
        <div className="grid gap-x-8 gap-y-4 border-t pt-3 md:grid-cols-3">
          <SpineColumn title={t("home.spine.nextDeadlines")} count={spine.deadlines.length} onOpen={() => setFocus("calendar")} openLabel={t("home.spine.calendar")}>
            {spine.deadlines.length === 0 ? <Quiet>{matter ? t("home.spine.noDeadlinesMatter", { matter: matter.shortName }) : t("home.spine.noDeadlines")}</Quiet> : (
              <ul>{spine.deadlines.map((d) => <DeadlineRow key={d.id} d={d} now={now} matterName={matterById(d.matterId)?.shortName} onOpen={() => (d.source === "event" ? openEvent(d.id) : undefined)} />)}</ul>
            )}
          </SpineColumn>
          <SpineColumn title={t("home.spine.today")} count={spine.todayEvents.length} onOpen={() => setFocus("calendar")} openLabel={t("home.spine.calendar")}>
            {spine.todayEvents.length === 0 ? <Quiet>{t("home.spine.nothingToday")}</Quiet> : (
              <ul>
                {spine.todayEvents.slice(0, 5).map((e) => (
                  <li key={e.id}>
                    <button onClick={() => openEvent(e.id)} className={ROW}>
                      <span className="w-[52px] shrink-0 text-[11.5px] tabular text-muted-foreground">{e.allDay || DATE_ONLY_RE.test(e.startsAt) ? t("home.spine.allDay") : fmtTime(e.startsAt)}</span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.title}</span>
                      <span className="hidden shrink-0 text-[11.5px] text-muted-foreground lg:inline">{i18n.tx(`event.kind.${e.kind}`, EVENT_KIND_LABEL[e.kind])}</span>
                    </button>
                  </li>
                ))}
                {spine.todayEvents.length > 5 && <li className="px-1.5 text-[11.5px] text-muted-foreground">{t("home.spine.more", { count: spine.todayEvents.length - 5 })}</li>}
              </ul>
            )}
          </SpineColumn>
          <SpineColumn title={t("home.spine.myTasks")} count={spine.overdueTasks.length + spine.dueTodayTasks.length} onOpen={() => { setTaskFilter({ mine: true, overdue: false }); setFocus("tasks"); }} openLabel={t("home.spine.allTasks")}>
            {myTasks.length === 0 ? <Quiet>{t("home.spine.noMyTasks")}</Quiet> : (
              <ul>
                {myTasks.map((task) => {
                  const due = relativeDue(dueText(task.dueAt!, now).days, t);
                  return (
                    <li key={task.id}>
                      <button onClick={() => openTaskDialog({ taskId: task.id })} className={ROW}>
                        <span className="min-w-0 flex-1 truncate text-[12.5px]">{task.title}</span>
                        <span className={cn("shrink-0 text-[11.5px] tabular", due.overdue ? "text-destructive" : "text-muted-foreground")}>{due.text}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </SpineColumn>
        </div>
      )}
    </section>
  );
}

const ROW = "flex h-7 w-full items-center gap-2 rounded px-1.5 text-start hover:bg-accent/50 cursor-pointer focus-ring";

function SpineColumn({ title, count, onOpen, openLabel, children }: { title: string; count: number; onOpen: () => void; openLabel: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex h-6 items-center gap-2 px-1.5">
        <h2 className="text-[12.5px] font-medium">{title}</h2>
        {count > 0 && <span className="text-[11.5px] tabular text-muted-foreground">{count}</span>}
        <button onClick={onOpen} className="ms-auto inline-flex items-center gap-0.5 rounded text-[11.5px] text-muted-foreground hover:text-foreground cursor-pointer focus-ring">{openLabel}<ChevronRight className="size-3 rtl:rotate-180" /></button>
      </div>
      {children}
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 py-1 text-[12px] text-muted-foreground">{children}</p>;
}

function DeadlineRow({ d, now, matterName, onOpen }: { d: SpineDeadline; now: Date; matterName?: string; onOpen: () => void }) {
  const i18n = useI18n();
  const due = relativeDue(dueText(d.date, now).days, i18n.t);
  const inner = (
    <>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{d.title}</span>
      <span className="hidden shrink-0 text-[11.5px] tabular text-muted-foreground xl:inline">{i18n.date(d.date, "dayMonth")}{matterName ? ` · ${matterName}` : ""}</span>
      <span className={cn("w-[84px] shrink-0 truncate text-end text-[11.5px] tabular", due.overdue ? "text-destructive" : "text-muted-foreground")} title={i18n.date(d.date, "full")}>{due.text}</span>
    </>
  );
  return <li>{d.source === "event" ? <button onClick={onOpen} className={ROW}>{inner}</button> : <Link href={d.href ?? "#"} className={ROW}>{inner}</Link>}</li>;
}
