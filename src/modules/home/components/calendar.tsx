"use client";
import * as React from "react";
import { T } from "@/lib/i18n/client";
import Link from "next/link";
import { CalendarDays, CalendarPlus, Calculator, ChevronLeft, ChevronRight, Clock, ExternalLink, FileSearch, ListChecks, MapPin, Pencil, Plus, ScrollText, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { PersonAvatar } from "@/components/ui/avatar";
import { Tip } from "@/components/ui/tooltip";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { CalendarEvent } from "@/lib/types/domain";
import { computeDeadline, DEADLINE_PRESETS, type DeadlineDirection, type DeadlineMethod, type DeadlineResult } from "../deadline";
import { addDays, addMonths, dateKey, daysBetween, endOfMonth, endOfWeek, fmtDate, fmtDateLong, fmtRange, fmtTime, isSameDay, startOfMonth, startOfWeek, toDate, DATE_ONLY_RE } from "../time";
import { EVENT_KINDS, EVENT_KIND_LABEL, type CalendarEntry, type EventInput } from "../types";
import { useHomeUI, type CalendarView } from "../store";
import { eventFormFor, type EventForm } from "../forms";
import { useHome } from "./home-provider";
import { CountdownChip, DateInput, EmptyRow, FieldLabel, KIND_STYLE, KindDot, MatterBadge, NONE, Section, TimeInput } from "./shared";
import { matterHref, matterDocumentsHref } from "@/lib/features";

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

export function useCalendarEvents() {
  const { events, matterFilter } = useHome();
  return React.useMemo(() => {
    const list = matterFilter ? events.filter((e) => e.matterId === matterFilter) : events;
    const byDay = new Map<string, CalendarEntry[]>();
    for (const e of list) {
      const k = dateKey(e.startsAt);
      const arr = byDay.get(k) ?? [];
      arr.push(e);
      byDay.set(k, arr);
    }
    for (const arr of byDay.values()) arr.sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay) || a.startsAt.localeCompare(b.startsAt));
    return { list, byDay };
  }, [events, matterFilter]);
}

function useAnchor(): [Date, (d: Date) => void] {
  const { now } = useHome();
  const calendarDate = useHomeUI((s) => s.calendarDate);
  const setCalendarDate = useHomeUI((s) => s.setCalendarDate);
  const anchor = calendarDate ? toDate(calendarDate) : now;
  return [anchor, (d) => setCalendarDate(dateKey(d))];
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------------------------------------------------------------------------
// Overview card (left column)
// ---------------------------------------------------------------------------

export function CalendarOverview() {
  const { now } = useHome();
  const { byDay } = useCalendarEvents();
  const selectedDay = useHomeUI((s) => s.selectedDay);
  const setSelectedDay = useHomeUI((s) => s.setSelectedDay);
  const setFocus = useHomeUI((s) => s.setFocus);
  const setCalendarView = useHomeUI((s) => s.setCalendarView);
  const openEvent = useHomeUI((s) => s.openEvent);
  const openEventDialog = useHomeUI((s) => s.openEventDialog);
  const todayKey = dateKey(now);
  const day = selectedDay ?? todayKey;
  const dayEvents = byDay.get(day) ?? [];
  const isToday = day === todayKey;
  const upcoming = React.useMemo(() => {
    if (!isToday) return [];
    const out: { day: string; events: CalendarEntry[] }[] = [];
    for (let i = 1; i <= 7 && out.reduce((n, d) => n + d.events.length, 0) < 5; i++) {
      const k = dateKey(addDays(now, i));
      const evs = byDay.get(k);
      if (evs?.length) out.push({ day: k, events: evs.slice(0, 3) });
    }
    return out;
  }, [byDay, isToday, now]);

  const openView = (v: CalendarView) => { setCalendarView(v); setFocus("calendar"); };

  return (
    <Section
      id="calendar"
      title={isToday ? "Today" : fmtDate(day, { weekday: "long", month: "short", day: "numeric" })}
      icon={CalendarDays}
      count={dayEvents.length}
      description={isToday ? fmtDateLong(now) : undefined}
      actions={
        <>
          <div className="hidden items-center rounded-md border p-0.5 @md:flex">
            {(["month", "week", "agenda"] as CalendarView[]).map((v) => (
              <button key={v} onClick={() => openView(v)} className="h-6 rounded px-2 text-[11px] capitalize text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer">{v}</button>
            ))}
          </div>
          <Tip label="New event" shortcut="N E"><Button variant="ghost" size="icon-xs" onClick={() => openEventDialog({ initial: { startsAt: `${day}T10:00:00`, endsAt: `${day}T11:00:00` } })} aria-label="New event"><Plus className="size-3.5" /></Button></Tip>
        </>
      }
      onExpand={() => setFocus("calendar")}
    >
      <div className="divide-y">
        <div className="px-2 py-1.5">
          {dayEvents.length === 0 ? (
            <EmptyRow icon={CalendarDays} title={isToday ? "Nothing on the calendar today" : "No events this day"} hint="Deep-work day. Add an event or run the deadline calculator." className="py-5" action={<Button variant="outline" size="xs" onClick={() => openEventDialog({ initial: { startsAt: `${day}T10:00:00`, endsAt: `${day}T11:00:00` } })}><CalendarPlus className="size-3" /> Add event</Button>} />
          ) : (
            <ul className="space-y-0.5">
              {dayEvents.map((e) => <EventRow key={e.id} event={e} onClick={() => openEvent(e.id)} now={now} showCountdown={!isToday} />)}
            </ul>
          )}
          {upcoming.length > 0 && (
            <div className="mt-1 border-t pt-1.5">
              <div className="px-1.5 pb-1 text-[11.5px] font-medium text-muted-foreground">Coming up</div>
              <ul className="space-y-0.5">
                {upcoming.flatMap((d) => d.events.map((e) => <EventRow key={e.id} event={e} onClick={() => openEvent(e.id)} now={now} dayLabel={fmtDate(d.day, { weekday: "short" })} showCountdown />))}
              </ul>
            </div>
          )}
        </div>
        <MiniMonth selected={day} onSelect={(k) => setSelectedDay(k === todayKey ? null : k)} />
      </div>
    </Section>
  );
}

export function EventRow({ event: e, onClick, now, dayLabel, showCountdown, dense }: { event: CalendarEntry; onClick?: () => void; now: Date; dayLabel?: string; showCountdown?: boolean; dense?: boolean }) {
  const past = toDate(e.endsAt ?? e.startsAt).getTime() < now.getTime() && dateKey(e.startsAt) === dateKey(now) && !e.allDay;
  return (
    <li>
      <button onClick={onClick} className={cn("group flex w-full items-start gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 cursor-pointer", past && "opacity-60")}>
        <div className={cn("mt-0.5 w-[52px] shrink-0 text-[11px] tabular text-muted-foreground", dense && "w-[46px]")}>
          {dayLabel ? <span className="font-medium text-foreground/80">{dayLabel}</span> : e.allDay || DATE_ONLY_RE.test(e.startsAt) ? "All day" : fmtTime(e.startsAt)}
        </div>
        <div className={cn("mt-1.5 w-0.5 self-stretch rounded-full", KIND_STYLE[e.kind].dot)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium leading-snug">{e.title}</span>
            {showCountdown && <CountdownChip date={e.startsAt} deadline={e.kind === "deadline" || e.kind === "filing"} className="ml-auto" />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="capitalize">{EVENT_KIND_LABEL[e.kind]}</span>
            {e.endsAt && !e.allDay && <span>· {fmtRange(e.startsAt, e.endsAt)}</span>}
            {e.location && <span className="hidden truncate sm:inline">· {e.location}</span>}
            <MatterBadge matterId={e.matterId} className="ml-auto" />
          </div>
        </div>
      </button>
    </li>
  );
}

function MiniMonth({ selected, onSelect }: { selected: string; onSelect: (k: string) => void }) {
  const { now } = useHome();
  const { byDay } = useCalendarEvents();
  const [anchor, setAnchor] = useAnchor();
  const todayKey = dateKey(now);
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  return (
    <div className="px-2.5 pb-2.5 pt-2">
      <div className="mb-1.5 flex items-center gap-1">
        <span className="text-[12.5px] font-semibold">{monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-xs" onClick={() => setAnchor(addMonths(anchor, -1))} aria-label="Previous month"><ChevronLeft className="size-3.5" /></Button>
        <Button variant="ghost" size="xs" className="px-1.5 text-[11px]" onClick={() => { setAnchor(now); onSelect(todayKey); }}>Today</Button>
        <Button variant="ghost" size="icon-xs" onClick={() => setAnchor(addMonths(anchor, 1))} aria-label="Next month"><ChevronRight className="size-3.5" /></Button>
      </div>
      <div className="grid grid-cols-7 text-center text-[11.5px] font-medium text-muted-foreground">
        {WEEKDAYS.map((d) => <div key={d} className="py-1">{d[0]}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5" role="grid">
        {cells.map((d) => {
          const k = dateKey(d);
          const evs = byDay.get(k) ?? [];
          const inMonth = d.getMonth() === monthStart.getMonth();
          const kinds = Array.from(new Set(evs.map((e) => e.kind))).slice(0, 3);
          return (
            <button
              key={k}
              role="gridcell"
              aria-selected={k === selected}
              onClick={() => onSelect(k)}
              onDoubleClick={() => { useHomeUI.getState().setCalendarView("agenda"); useHomeUI.getState().setCalendarDate(k); useHomeUI.getState().setFocus("calendar"); }}
              className={cn(
                "group relative mx-auto flex h-8 w-8 flex-col items-center justify-center rounded-md text-[12px] tabular transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 cursor-pointer",
                !inMonth && "text-muted-foreground/50",
                k === selected && "bg-primary text-primary-foreground hover:bg-primary",
                k === todayKey && k !== selected && "font-semibold text-primary ring-1 ring-primary/40",
              )}
              title={evs.length ? `${evs.length} event${evs.length === 1 ? "" : "s"}` : undefined}
            >
              <span className="leading-none">{d.getDate()}</span>
              <span className="mt-0.5 flex h-1.5 items-center gap-0.5">
                {kinds.map((kind) => <span key={kind} className={cn("size-1 rounded-full", KIND_STYLE[kind].dot, k === selected && "bg-primary-foreground")} />)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Focused calendar (month / week / agenda)
// ---------------------------------------------------------------------------

export function CalendarFocus() {
  const { now } = useHome();
  const view = useHomeUI((s) => s.calendarView);
  const setView = useHomeUI((s) => s.setCalendarView);
  const setFocus = useHomeUI((s) => s.setFocus);
  const openEventDialog = useHomeUI((s) => s.openEventDialog);
  const [anchor, setAnchor] = useAnchor();
  const [calcOpen, setCalcOpen] = React.useState(false);

  const step = (dir: 1 | -1) => setAnchor(view === "month" ? addMonths(anchor, dir) : view === "week" ? addDays(anchor, 7 * dir) : addDays(anchor, 30 * dir));
  const title = view === "month"
    ? anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : view === "week"
      ? `${fmtDate(startOfWeek(anchor), { month: "short", day: "numeric" })} – ${fmtDate(endOfWeek(anchor), { month: "short", day: "numeric", year: "numeric" })}`
      : `${fmtDate(anchor, { month: "short", day: "numeric" })} – ${fmtDate(addDays(anchor, 29), { month: "short", day: "numeric", year: "numeric" })}`;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "[") { e.preventDefault(); step(-1); }
      else if (e.key === "]") { e.preventDefault(); step(1); }
      else if (e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey) { setAnchor(now); }
      else if (e.key === "m") setView("month");
      else if (e.key === "w") setView("week");
      else if (e.key === "d") setView("agenda");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Section
      id="calendar"
      title={<T k="home.section.calendar" />}
      icon={CalendarDays}
      expanded
      onExpand={() => setFocus(null)}
      actions={
        <>
          <div className="mr-1 flex items-center gap-0.5">
            <Tip label="Previous" shortcut="["><Button variant="ghost" size="icon-xs" onClick={() => step(-1)} aria-label="Previous"><ChevronLeft className="size-3.5" /></Button></Tip>
            <Tip label="Jump to today" shortcut="T"><Button variant="outline" size="xs" onClick={() => setAnchor(now)}>Today</Button></Tip>
            <Tip label="Next" shortcut="]"><Button variant="ghost" size="icon-xs" onClick={() => step(1)} aria-label="Next"><ChevronRight className="size-3.5" /></Button></Tip>
          </div>
          <span className="mr-2 hidden text-[12.5px] font-medium tabular md:inline">{title}</span>
          <div className="flex items-center rounded-md border p-0.5">
            {(["month", "week", "agenda"] as CalendarView[]).map((v) => (
              <button key={v} onClick={() => setView(v)} className={cn("h-6 rounded px-2 text-[11px] capitalize cursor-pointer", view === v ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground")}>{v}</button>
            ))}
          </div>
          <Tip label="Deadline calculator (FRCP 6(a))"><Button variant="ghost" size="icon-xs" onClick={() => setCalcOpen(true)} aria-label="Deadline calculator"><Calculator className="size-3.5" /></Button></Tip>
          <Button size="xs" onClick={() => openEventDialog({ initial: { startsAt: `${dateKey(anchor)}T10:00:00`, endsAt: `${dateKey(anchor)}T11:00:00` } })}><Plus className="size-3" /> Event</Button>
        </>
      }
      bodyClassName="overflow-auto scrollbar-thin"
    >
      {view === "month" && <MonthView anchor={anchor} />}
      {view === "week" && <WeekView anchor={anchor} />}
      {view === "agenda" && <AgendaView anchor={anchor} />}
      <Dialog open={calcOpen} onOpenChange={setCalcOpen}>
        <DialogContent size="lg">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Calculator className="size-4" /> Deadline calculator</DialogTitle><DialogDescription>FRCP 6(a)-style computation: calendar days, court days under 11, weekend and federal-holiday rollover, optional 6(d) mail days.</DialogDescription></DialogHeader>
          <DeadlineCalculator initialTrigger={dateKey(anchor)} onCreated={() => setCalcOpen(false)} />
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function MonthView({ anchor }: { anchor: Date }) {
  const { now } = useHome();
  const { byDay } = useCalendarEvents();
  const openEvent = useHomeUI((s) => s.openEvent);
  const openEventDialog = useHomeUI((s) => s.openEventDialog);
  const setView = useHomeUI((s) => s.setCalendarView);
  const setAnchor = useHomeUI((s) => s.setCalendarDate);
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart);
  const weeks = Math.ceil((daysBetween(gridStart, endOfMonth(anchor)) + 1) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i));
  const todayKey = dateKey(now);
  return (
    <div className="flex h-full min-h-[560px] flex-col">
      <div className="grid grid-cols-7 border-b text-center text-[11.5px] font-medium text-muted-foreground">
        {WEEKDAYS.map((d) => <div key={d} className="py-1.5">{d}</div>)}
      </div>
      <div className="grid flex-1 grid-cols-7 auto-rows-fr">
        {cells.map((d, i) => {
          const k = dateKey(d);
          const evs = byDay.get(k) ?? [];
          const inMonth = d.getMonth() === monthStart.getMonth();
          const shown = evs.slice(0, 4);
          return (
            <div
              key={k}
              className={cn("group relative flex min-h-[92px] flex-col border-b border-r p-1 transition-colors hover:bg-accent/30", (i + 1) % 7 === 0 && "border-r-0", !inMonth && "bg-muted/30", (d.getDay() === 0 || d.getDay() === 6) && inMonth && "bg-muted/15")}
              onDoubleClick={() => openEventDialog({ initial: { startsAt: `${k}T10:00:00`, endsAt: `${k}T11:00:00` } })}
            >
              <div className="flex items-center justify-between px-0.5">
                <button onClick={() => { setAnchor(k); setView("agenda"); }} className={cn("flex size-6 items-center justify-center rounded-full text-[12px] tabular hover:bg-accent cursor-pointer", !inMonth && "text-muted-foreground/60", k === todayKey && "bg-primary font-semibold text-primary-foreground hover:bg-primary")}>{d.getDate()}</button>
                <button onClick={() => openEventDialog({ initial: { startsAt: `${k}T10:00:00`, endsAt: `${k}T11:00:00` } })} className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100 cursor-pointer" aria-label="Add event"><Plus className="size-3" /></button>
              </div>
              <div className="mt-0.5 flex flex-1 flex-col gap-0.5">
                {shown.map((e) => (
                  <button key={e.id} onClick={() => openEvent(e.id)} className={cn("flex w-full items-center gap-1 truncate rounded border-l-2 bg-background/80 px-1 py-0.5 text-left text-[11px] leading-tight hover:bg-accent cursor-pointer", KIND_STYLE[e.kind].bar)} title={e.title}>
                    {!e.allDay && !DATE_ONLY_RE.test(e.startsAt) && <span className="shrink-0 tabular text-muted-foreground">{fmtTime(e.startsAt).replace(":00", "").replace(" ", "")}</span>}
                    <span className="truncate">{e.title}</span>
                  </button>
                ))}
                {evs.length > shown.length && <button onClick={() => { setAnchor(k); setView("agenda"); }} className="px-1 text-left text-[10.5px] font-medium text-muted-foreground hover:text-foreground cursor-pointer">+{evs.length - shown.length} more</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const HOUR_START = 7, HOUR_END = 19, ROW_H = 44;

function WeekView({ anchor }: { anchor: Date }) {
  const { now } = useHome();
  const { byDay } = useCalendarEvents();
  const openEvent = useHomeUI((s) => s.openEvent);
  const openEventDialog = useHomeUI((s) => s.openEventDialog);
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const todayKey = dateKey(now);
  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
  const nowTop = ((now.getHours() + now.getMinutes() / 60) - HOUR_START) * ROW_H;
  return (
    <div className="min-w-[760px]">
      <div className="sticky top-0 z-10 grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b bg-card">
        <div />
        {days.map((d) => {
          const k = dateKey(d);
          return (
            <div key={k} className={cn("border-l px-2 py-1.5 text-center", k === todayKey && "bg-primary/5")}>
              <div className="text-[11.5px] font-medium text-muted-foreground">{WEEKDAYS[(d.getDay() + 6) % 7]}</div>
              <div className={cn("mx-auto mt-0.5 flex size-6 items-center justify-center rounded-full text-[13px] tabular", k === todayKey && "bg-primary font-semibold text-primary-foreground")}>{d.getDate()}</div>
            </div>
          );
        })}
      </div>
      {/* all-day row */}
      <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b">
        <div className="px-2 py-1 text-[11.5px] text-muted-foreground">All day</div>
        {days.map((d) => {
          const k = dateKey(d);
          const evs = (byDay.get(k) ?? []).filter((e) => e.allDay || DATE_ONLY_RE.test(e.startsAt));
          return (
            <div key={k} className="min-h-[30px] space-y-0.5 border-l p-0.5">
              {evs.map((e) => (
                <button key={e.id} onClick={() => openEvent(e.id)} className={cn("block w-full truncate rounded border-l-2 bg-background/80 px-1.5 py-0.5 text-left text-[11px] leading-tight hover:bg-accent cursor-pointer", KIND_STYLE[e.kind].bar)} title={e.title}>{e.title}</button>
              ))}
            </div>
          );
        })}
      </div>
      {/* time grid */}
      <div className="relative grid grid-cols-[56px_repeat(7,minmax(0,1fr))]">
        <div className="relative" style={{ height: hours.length * ROW_H }}>
          {hours.map((h, i) => <div key={h} className="absolute right-2 -translate-y-1/2 text-[10px] tabular text-muted-foreground" style={{ top: i * ROW_H }}>{i === 0 ? "" : `${h > 12 ? h - 12 : h} ${h >= 12 ? "PM" : "AM"}`}</div>)}
        </div>
        {days.map((d) => {
          const k = dateKey(d);
          const evs = (byDay.get(k) ?? []).filter((e) => !(e.allDay || DATE_ONLY_RE.test(e.startsAt)));
          return (
            <div key={k} className={cn("relative border-l", k === todayKey && "bg-primary/[0.03]")} style={{ height: hours.length * ROW_H }}>
              {hours.map((h, i) => (
                <div key={h} className="absolute inset-x-0 border-t border-border/70 hover:bg-accent/40 cursor-pointer" style={{ top: i * ROW_H, height: ROW_H }} onClick={() => openEventDialog({ initial: { startsAt: `${k}T${String(h).padStart(2, "0")}:00:00`, endsAt: `${k}T${String(h + 1).padStart(2, "0")}:00:00` } })} aria-hidden />
              ))}
              {evs.map((e, idx) => {
                const s = toDate(e.startsAt);
                const en = e.endsAt ? toDate(e.endsAt) : new Date(s.getTime() + 3600_000);
                const top = Math.max(0, (s.getHours() + s.getMinutes() / 60 - HOUR_START) * ROW_H);
                const height = Math.max(22, ((en.getTime() - s.getTime()) / 3600_000) * ROW_H - 2);
                const overlap = evs.slice(0, idx).filter((o) => { const os = toDate(o.startsAt).getTime(); const oe = (o.endsAt ? toDate(o.endsAt) : new Date(os + 3600_000)).getTime(); return os < en.getTime() && oe > s.getTime(); }).length;
                return (
                  <button key={e.id} onClick={() => openEvent(e.id)} className={cn("absolute flex flex-col items-stretch justify-start overflow-hidden rounded border border-l-2 bg-card px-1.5 py-1 text-left hover:z-20 hover:bg-accent/60 cursor-pointer", KIND_STYLE[e.kind].bar)} style={{ top, height, left: `${4 + overlap * 14}%`, right: 2, zIndex: 1 + overlap }} title={`${e.title} · ${fmtRange(e.startsAt, e.endsAt)}`}>
                    <div className="truncate text-[11px] font-medium leading-tight">{height < 34 ? `${fmtTime(e.startsAt).replace(":00", "")} ${e.title}` : e.title}</div>
                    {height >= 34 && <div className="truncate text-[10px] tabular text-muted-foreground">{fmtRange(e.startsAt, e.endsAt)}{e.location ? ` · ${e.location}` : ""}</div>}
                  </button>
                );
              })}
              {k === todayKey && nowTop >= 0 && nowTop <= hours.length * ROW_H && (
                <div className="pointer-events-none absolute inset-x-0 z-20 flex items-center" style={{ top: nowTop }}><span className="-ml-1 size-2 rounded-full bg-destructive" /><span className="h-px flex-1 bg-destructive" /></div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgendaView({ anchor }: { anchor: Date }) {
  const { now } = useHome();
  const { byDay } = useCalendarEvents();
  const openEvent = useHomeUI((s) => s.openEvent);
  const todayKey = dateKey(now);
  const days = Array.from({ length: 30 }, (_, i) => addDays(anchor, i)).map((d) => ({ d, k: dateKey(d), evs: byDay.get(dateKey(d)) ?? [] })).filter((x) => x.evs.length);
  if (!days.length) return <EmptyRow icon={CalendarDays} title="No events in this 30-day window" hint="Use [ and ] to move, or T for today." />;
  return (
    <div className="divide-y">
      {days.map(({ d, k, evs }) => (
        <div key={k} className="grid grid-cols-[120px_1fr] gap-2 px-3 py-2">
          <div className="pt-1.5">
            <div className={cn("text-[12.5px] font-semibold", k === todayKey && "text-primary")}>{k === todayKey ? "Today" : fmtDate(d, { weekday: "long" })}</div>
            <div className="text-[11px] text-muted-foreground">{fmtDate(d, { month: "short", day: "numeric", year: "numeric" })}</div>
            <CountdownChip date={k} className="mt-1" />
          </div>
          <ul className="space-y-0.5">
            {evs.map((e) => <EventRow key={e.id} event={e} onClick={() => openEvent(e.id)} now={now} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event sheet
// ---------------------------------------------------------------------------

export function EventSheet() {
  const { events, now, personById, matterById, deleteEvent, createTask } = useHome();
  const id = useHomeUI((s) => s.eventSheetId);
  const openEvent = useHomeUI((s) => s.openEvent);
  const openEventDialog = useHomeUI((s) => s.openEventDialog);
  const e = React.useMemo(() => events.find((x) => x.id === id) ?? null, [events, id]);
  const [calcOpen, setCalcOpen] = React.useState(false);
  React.useEffect(() => { setCalcOpen(false); }, [id]);
  const matter = matterById(e?.matterId);
  const attendees = (e?.attendeeIds ?? []).map((a) => personById(a)).filter(Boolean);

  const addToTasks = async () => {
    if (!e) return;
    const due = dateKey(addDays(toDate(e.startsAt), e.kind === "deadline" || e.kind === "filing" ? 0 : -1));
    const t = await createTask({ title: `${e.kind === "deadline" || e.kind === "filing" ? "File: " : "Prepare for: "}${e.title}`, matterId: e.matterId ?? null, dueAt: due, priority: e.kind === "deadline" || e.kind === "filing" ? "high" : "medium", description: e.notes, links: [{ label: "Calendar event", href: `/#calendar` }] });
    if (t) toast.success("Task created", { description: `${t.title} · due ${fmtDate(due)}` });
  };

  return (
    <Sheet open={!!e} onOpenChange={(o) => { if (!o) openEvent(null); }}>
      <SheetContent width="max-w-lg" className="gap-0">
        {e && (
          <>
            <SheetHeader className="pr-10">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground"><span className="inline-flex items-center gap-1"><KindDot kind={e.kind} className="size-1.5" />{EVENT_KIND_LABEL[e.kind]}</span>{e.derived && <span>· Matter key date</span>}<CountdownChip date={e.startsAt} deadline={e.kind === "deadline" || e.kind === "filing"} /></div>
              <SheetTitle className="text-base leading-snug">{e.title}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <span className="inline-flex items-center gap-1"><Clock className="size-3" />{fmtDateLong(e.startsAt)} · {fmtRange(e.startsAt, e.endsAt, e.allDay)}</span>
                {e.location && <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{e.location}</span>}
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="space-y-4 text-sm">
              {matter && (
                <div className="rounded-md border bg-muted/40 p-2.5">
                  <div className="text-[11.5px] font-medium text-muted-foreground">Matter</div>
                  <div className="mt-0.5 font-medium">{matter.shortName} <span className="font-normal text-muted-foreground">· {matter.caption ?? matter.practiceArea}</span></div>
                  <div className="mt-1.5 flex gap-1.5">
                    <Button asChild variant="outline" size="xs"><Link href={matterDocumentsHref(matter.id)}><FileSearch className="size-3" /> Documents</Link></Button>
                    <Button asChild variant="outline" size="xs"><Link href={`/library?matter=${matter.id}`}><ScrollText className="size-3" /> Library</Link></Button>
                  </div>
                </div>
              )}
              {e.ruleSource && (
                <div>
                  <div className="text-[11.5px] font-medium text-muted-foreground">Rule source</div>
                  <div className="mt-0.5 font-mono text-[12px]">{e.ruleSource}</div>
                </div>
              )}
              <div>
                <div className="flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground"><Users className="size-3" /> Attendees <span className="tabular">({attendees.length})</span></div>
                {attendees.length ? (
                  <ul className="mt-1.5 space-y-1.5">
                    {attendees.map((p) => (
                      <li key={p!.id} className="flex items-center gap-2">
                        <PersonAvatar name={p!.name} size="sm" />
                        <div className="min-w-0 leading-tight"><div className="truncate text-[13px] font-medium">{p!.name}</div><div className="truncate text-[11px] text-muted-foreground">{[p!.title, p!.organization].filter(Boolean).join(" · ")}</div></div>
                        {(p!.role === "opposing" || p!.role === "judge") && <Badge variant="muted" className="ml-auto capitalize">{p!.role}</Badge>}
                        {p!.role === "custodian" && <Badge variant="outline" className="ml-auto">Custodian</Badge>}
                      </li>
                    ))}
                  </ul>
                ) : <div className="mt-1 text-xs text-muted-foreground">No attendees listed.</div>}
              </div>
              {e.notes && (
                <div>
                  <div className="text-[11.5px] font-medium text-muted-foreground">Notes</div>
                  <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">{e.notes}</p>
                </div>
              )}
              <Collapsible open={calcOpen} onOpenChange={setCalcOpen}>
                <CollapsibleTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full justify-start"><Calculator className="size-3.5" /> Deadline calculator from this date<span className="ml-auto text-[11px] text-muted-foreground">{calcOpen ? "Hide" : "Show"}</span></Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <DeadlineCalculator initialTrigger={dateKey(e.startsAt)} matterId={e.matterId} compact />
                </CollapsibleContent>
              </Collapsible>
            </SheetBody>
            <SheetFooter className="justify-between">
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" onClick={() => void addToTasks()}><ListChecks className="size-3.5" /> Add to tasks</Button>
              </div>
              <div className="flex gap-1.5">
                {!e.derived && (
                  <>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={async () => { if (await deleteEvent(e.id)) { toast.success("Event deleted"); openEvent(null); } }}><Trash2 className="size-3.5" /> Delete</Button>
                    <Button size="sm" onClick={() => openEventDialog({ eventId: e.id })}><Pencil className="size-3.5" /> Edit</Button>
                  </>
                )}
                {e.derived && <Button asChild size="sm" variant="outline"><Link href={matterHref(e.derived.matterId)}>Open matter <ExternalLink className="size-3" /></Link></Button>}
              </div>
            </SheetFooter>
            <span className="sr-only">{daysBetween(now, toDate(e.startsAt))} days</span>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Event dialog (create / edit)
// ---------------------------------------------------------------------------

export function EventDialog() {
  const { events } = useHome();
  const dlg = useHomeUI((s) => s.eventDialog);
  const close = useHomeUI((s) => s.closeEventDialog);
  const existing = React.useMemo(() => (dlg.eventId ? events.find((e) => e.id === dlg.eventId) ?? null : null), [events, dlg.eventId]);
  return (
    <Dialog open={dlg.open} onOpenChange={(o) => { if (!o) close(); }}>
      {/* Mount the form only while open (keyed by event) so its state re-initialises from the selected event / initial values on every open. */}
      {dlg.open && <EventDialogForm key={dlg.eventId ?? "new"} existing={existing} initial={dlg.initial} onClose={close} />}
    </Dialog>
  );
}

function EventDialogForm({ existing, initial, onClose }: { existing: CalendarEntry | null; initial: Partial<EventInput> | null; onClose: () => void }) {
  const { people, matters, now, createEvent, updateEvent, userId } = useHome();
  const openEvent = useHomeUI((s) => s.openEvent);
  const [form, setForm] = React.useState<EventForm>(() => eventFormFor(existing, initial, now));
  const [saving, setSaving] = React.useState(false);
  const [attendeeQuery, setAttendeeQuery] = React.useState("");
  const set = <K extends keyof EventForm>(k: K, v: EventForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.title.trim()) { toast.error("Give the event a title"); return; }
    setSaving(true);
    const payload: EventInput = {
      title: form.title,
      kind: form.kind,
      matterId: form.matterId || null,
      startsAt: form.allDay ? form.date : `${form.date}T${form.start}:00`,
      endsAt: form.allDay ? null : `${form.date}T${form.end}:00`,
      allDay: form.allDay,
      location: form.location || null,
      attendeeIds: form.attendeeIds,
      notes: form.notes || null,
      ruleSource: form.ruleSource || null,
    };
    const res = existing ? await updateEvent(existing.id, payload) : await createEvent(payload);
    setSaving(false);
    if (res) { toast.success(existing ? "Event updated" : "Event created", { description: `${res.title} · ${fmtDate(res.startsAt, { weekday: "short", month: "short", day: "numeric" })}` }); onClose(); if (existing) openEvent(existing.id); }
  };

  const filteredPeople = people.filter((p) => !attendeeQuery || p.name.toLowerCase().includes(attendeeQuery.toLowerCase()) || (p.organization ?? "").toLowerCase().includes(attendeeQuery.toLowerCase()));

  return (
      <DialogContent size="lg" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void save(); } }}>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit event" : "New event"}</DialogTitle>
          <DialogDescription>{existing ? "Changes are saved to the firm calendar." : "Hearings, depositions, filings and deadlines show up in everyone's calendar and in the daily brief."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-6">
          <div className="sm:col-span-6"><FieldLabel>Title</FieldLabel><Input autoFocus value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Deposition of …, Hearing on …, Reply brief due" /></div>
          <div className="sm:col-span-2"><FieldLabel>Kind</FieldLabel>
            <Select value={form.kind} onValueChange={(v) => set("kind", v as CalendarEvent["kind"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{EVENT_KINDS.map((k) => <SelectItem key={k} value={k}><span className="inline-flex items-center gap-2"><KindDot kind={k} />{EVENT_KIND_LABEL[k]}</span></SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-4"><FieldLabel>Matter</FieldLabel>
            <Select value={form.matterId || NONE} onValueChange={(v) => set("matterId", v === NONE ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="No matter" /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>No matter (firm)</SelectItem>{matters.map((m) => <SelectItem key={m.id} value={m.id}>{m.shortName} <span className="text-muted-foreground">· {m.caption ?? m.practiceArea}</span></SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2"><FieldLabel>Date</FieldLabel><DateInput value={form.date} onChange={(v) => set("date", v)} /></div>
          <div className="sm:col-span-2"><FieldLabel>Start</FieldLabel><TimeInput value={form.start} onChange={(v) => set("start", v)} disabled={form.allDay} /></div>
          <div className="sm:col-span-2"><FieldLabel>End</FieldLabel><TimeInput value={form.end} onChange={(v) => set("end", v)} disabled={form.allDay} /></div>
          <div className="flex items-center gap-2 sm:col-span-3"><Switch id="allday" size="sm" checked={form.allDay} onCheckedChange={(v) => set("allDay", v)} /><Label htmlFor="allday" className="text-xs">All day</Label></div>
          <div className="sm:col-span-3"><FieldLabel>Location</FieldLabel><Input value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Courtroom 6 · Zoom · Conference Room 4B" /></div>
          <div className="sm:col-span-6"><FieldLabel>Rule source</FieldLabel><Input value={form.ruleSource} onChange={(e) => set("ruleSource", e.target.value)} placeholder="FRCP 26(f) · CMO 26 ¶ 6 · Local Rule 7.1" className="font-mono text-xs" /></div>
          <div className="sm:col-span-6">
            <FieldLabel>Attendees <span className="normal-case tracking-normal text-muted-foreground/80">({form.attendeeIds.length})</span></FieldLabel>
            <div className="flex flex-wrap gap-1 pb-1.5">
              {form.attendeeIds.map((id) => { const p = people.find((x) => x.id === id); return p ? <button key={id} onClick={() => set("attendeeIds", form.attendeeIds.filter((x) => x !== id))} className="inline-flex items-center gap-1 rounded-full border bg-background py-0.5 pl-0.5 pr-2 text-[11px] hover:bg-accent cursor-pointer" title="Remove"><PersonAvatar name={p.name} size="xs" />{p.name}</button> : null; })}
            </div>
            <Input value={attendeeQuery} onChange={(e) => setAttendeeQuery(e.target.value)} placeholder="Search people…" className="h-8 text-xs" />
            <div className="mt-1 max-h-32 overflow-auto rounded-md border scrollbar-thin">
              {filteredPeople.filter((p) => !form.attendeeIds.includes(p.id)).map((p) => (
                <button key={p.id} onClick={() => set("attendeeIds", [...form.attendeeIds, p.id])} className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent cursor-pointer">
                  <PersonAvatar name={p.name} size="xs" /><span className="font-medium">{p.name}</span><span className="truncate text-muted-foreground">{[p.title, p.organization].filter(Boolean).join(" · ")}</span>{p.id === userId && <Badge variant="muted" className="ml-auto">you</Badge>}
                </button>
              ))}
            </div>
          </div>
          <div className="sm:col-span-6"><FieldLabel>Notes</FieldLabel><Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} placeholder="Agenda, exhibits to bring, prep status…" /></div>
        </div>
        <DialogFooter className="items-center">
          <span className="mr-auto text-[11px] text-muted-foreground"><kbd>⌘</kbd> <kbd>↵</kbd> to save</span>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : existing ? "Save changes" : "Create event"}</Button>
        </DialogFooter>
      </DialogContent>
  );
}

// ---------------------------------------------------------------------------
// Deadline calculator
// ---------------------------------------------------------------------------

export function DeadlineCalculator({ initialTrigger, matterId, compact, onCreated }: { initialTrigger: string; matterId?: string | null; compact?: boolean; onCreated?: (e: CalendarEvent) => void }) {
  const { createEvent, matters } = useHome();
  const [trigger, setTrigger] = React.useState(initialTrigger);
  const [days, setDays] = React.useState(14);
  const [direction, setDirection] = React.useState<DeadlineDirection>("forward");
  const [method, setMethod] = React.useState<DeadlineMethod>("frcp6a");
  const [mail, setMail] = React.useState(false);
  const [preset, setPreset] = React.useState<string>("custom");
  const [label, setLabel] = React.useState("");
  const [matter, setMatter] = React.useState(matterId ?? "");
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => setTrigger(initialTrigger), [initialTrigger]);

  const result: DeadlineResult | null = React.useMemo(() => { try { return trigger ? computeDeadline({ trigger, days, direction, method, addMailDays: mail }) : null; } catch { return null; } }, [trigger, days, direction, method, mail]);
  const presetDef = DEADLINE_PRESETS.find((p) => p.id === preset);

  const applyPreset = (id: string) => {
    setPreset(id);
    const p = DEADLINE_PRESETS.find((x) => x.id === id);
    if (p) { setDays(p.days); setDirection(p.direction); setMethod(p.method); setMail(!!p.mail); setLabel(p.label); }
  };

  const create = async () => {
    if (!result) return;
    setCreating(true);
    const ev = await createEvent({ title: label.trim() || `Deadline: ${days} days ${direction === "forward" ? "after" : "before"} ${fmtDate(trigger)}`, startsAt: result.dueDate, allDay: true, kind: "deadline", matterId: matter || null, ruleSource: presetDef?.rule ?? `Computed: ${days} ${result.countedCourtDaysOnly ? "court" : "calendar"} days ${direction} from ${trigger}${mail ? " + FRCP 6(d)" : ""}`, notes: `Trigger ${trigger}; ${result.rolled ? `rolled: ${result.rolledReason}` : "no rollover"}${result.skipped.length ? `; skipped ${result.skipped.length} non-court day(s)` : ""}.` });
    setCreating(false);
    if (ev) { toast.success("Deadline added to calendar", { description: `${ev.title} · ${fmtDate(ev.startsAt, { weekday: "short", month: "short", day: "numeric" })}` }); onCreated?.(ev); }
  };

  return (
    <div className={cn("grid gap-3", compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-[1fr_1fr]")}>
      <div className="space-y-2.5">
        <div><FieldLabel>Rule preset</FieldLabel>
          <Select value={preset} onValueChange={applyPreset}>
            <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="custom">Custom period</SelectItem>{DEADLINE_PRESETS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label} <span className="text-muted-foreground">· {p.rule}</span></SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><FieldLabel>Trigger date</FieldLabel><DateInput value={trigger} onChange={setTrigger} className="h-8 text-xs" /></div>
          <div><FieldLabel>Days</FieldLabel><Input type="number" min={0} max={3660} value={days} onChange={(e) => { setDays(Math.max(0, Number(e.target.value) || 0)); setPreset("custom"); }} className="h-8 text-xs tabular" /></div>
          <div><FieldLabel>Direction</FieldLabel>
            <Select value={direction} onValueChange={(v) => { setDirection(v as DeadlineDirection); setPreset("custom"); }}>
              <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="forward">After trigger</SelectItem><SelectItem value="backward">Before trigger</SelectItem></SelectContent>
            </Select>
          </div>
          <div><FieldLabel>Counting</FieldLabel>
            <Select value={method} onValueChange={(v) => { setMethod(v as DeadlineMethod); setPreset("custom"); }}>
              <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="frcp6a">FRCP 6(a) style</SelectItem><SelectItem value="calendar">Calendar days</SelectItem><SelectItem value="court">Court days only</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2"><Switch id="mail" size="sm" checked={mail} onCheckedChange={setMail} disabled={direction === "backward"} /><Label htmlFor="mail" className="text-xs">Add 3 days for service by mail (FRCP 6(d))</Label></div>
        <div><FieldLabel>Event title</FieldLabel><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={presetDef?.label ?? "e.g. Opposition to motion to compel due"} className="h-8 text-xs" /></div>
        <div><FieldLabel>Matter</FieldLabel>
          <Select value={matter || NONE} onValueChange={(v) => setMatter(v === NONE ? "" : v)}>
            <SelectTrigger size="sm"><SelectValue placeholder="No matter" /></SelectTrigger>
            <SelectContent><SelectItem value={NONE}>No matter</SelectItem>{matters.map((m) => <SelectItem key={m.id} value={m.id}>{m.shortName}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col rounded-lg border bg-muted/30 p-3">
        {result ? (
          <>
            <div className="text-[11.5px] font-medium text-muted-foreground">Due date</div>
            <div className="mt-0.5 font-serif text-2xl leading-tight">{fmtDate(result.dueDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground"><CountdownChip date={result.dueDate} deadline /><span className="font-mono">{result.countedCourtDaysOnly ? "court days" : "calendar days"}</span>{result.mailDaysAdded > 0 && <span className="font-mono">+{result.mailDaysAdded} mail days</span>}</div>
            <ul className="mt-3 space-y-1 text-[12px] text-foreground/90">
              <li>Period ends <span className="tabular font-medium">{fmtDate(result.rawDate, { weekday: "short", month: "short", day: "numeric" })}</span>{result.rolled ? <span className="text-muted-foreground"> — {result.rolledReason}; rolled {direction === "forward" ? "forward" : "back"} to the next court day.</span> : <span className="text-muted-foreground"> — a court day, no rollover.</span>}</li>
              {result.skipped.length > 0 && <li className="text-muted-foreground">Skipped {result.skipped.length} non-court day{result.skipped.length === 1 ? "" : "s"}: {result.skipped.slice(0, 6).map((s) => `${fmtDate(s.date)} (${s.reason})`).join(", ")}{result.skipped.length > 6 ? "…" : ""}</li>}
              {result.holidaysInRange.length > 0 && <li className="text-muted-foreground">Federal holidays in range: {result.holidaysInRange.map((h) => `${h.name} (${fmtDate(h.date)})`).join(", ")}</li>}
              {presetDef && <li className="font-mono text-[11px] text-muted-foreground">{presetDef.rule}</li>}
            </ul>
            <div className="mt-auto pt-3">
              <Button size="sm" className="w-full" onClick={() => void create()} disabled={creating}><CalendarPlus className="size-3.5" /> {creating ? "Adding…" : "Add as deadline event"}</Button>
              <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">Verify against the governing rules and local practice; state courts and standing orders vary. Not a substitute for docketing review.</p>
            </div>
          </>
        ) : <div className="text-xs text-muted-foreground">Enter a valid trigger date.</div>}
      </div>
    </div>
  );
}

export function eventDurationLabel(e: CalendarEvent) {
  if (e.allDay || !e.endsAt) return "";
  const s = toDate(e.startsAt), en = toDate(e.endsAt);
  if (!isSameDay(s, en)) return `${fmtDate(s)} – ${fmtDate(en)}`;
  return fmtRange(e.startsAt, e.endsAt);
}
