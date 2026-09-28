"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { CalendarPlus, CheckSquare, ChevronDown, Home as HomeIcon, Keyboard, MessageSquarePlus, MessageSquareText, Plus, RefreshCw, Scale, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TopbarSlot } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { useShortcutHelp, type ShortcutGroup } from "@/components/ui/shortcut-help";
import type { HomeInitialData } from "../types";
import { useHomeUI, type HomeSection } from "../store";
import { HomeProvider, useHome } from "./home-provider";
import { DailyBriefCard } from "./daily-brief";
import { CalendarFocus, EventDialog, EventSheet } from "./calendar";
import { TaskDialog, TasksFocus } from "./tasks";
import { NewsFocus, NewsOverview } from "./news-feed";
import { UpdatesFocus, UpdatesOverview } from "./team-updates";
import { MattersFocus, MattersOverview } from "./matters-overview";
import { AssistantDock } from "./assistant-dock";
import { TodaySpine } from "./today-spine";
import { ForYouSection } from "./for-you";
import { MatterWatchSection } from "./insights-matter-watch";
import { UpcomingPrepSection } from "./insights-upcoming";
import { FirstRunChecklist } from "./first-run";

/** Home page shortcuts, listed in the `?` help dialog. */
export const HOME_SHORTCUTS: ShortcutGroup[] = [
  { id: "home", title: "Home", titleKey: "home.shortcuts.group", items: [
    { keys: ["n", "t"], label: "New task", labelKey: "home.shortcuts.newTask" },
    { keys: ["n", "e"], label: "New event", labelKey: "home.shortcuts.newEvent" },
    { keys: ["n", "u"], label: "New team update", labelKey: "home.shortcuts.newUpdate" },
    { keys: ["a"], label: "Toggle the assistant", labelKey: "home.shortcuts.toggleAssistant" },
    { keys: ["c"], label: "Open the calendar", labelKey: "home.shortcuts.openCalendar" },
    { keys: ["k"], label: "Open the task board", labelKey: "home.shortcuts.openTaskBoard" },
    { keys: ["esc"], label: "Back to the overview", labelKey: "home.shortcuts.backToOverview" },
  ] },
  { id: "home-calendar", title: "Calendar", titleKey: "home.shortcuts.calendarGroup", items: [
    { keys: ["["], label: "Previous period", labelKey: "home.shortcuts.prevPeriod" }, { keys: ["]"], label: "Next period", labelKey: "home.shortcuts.nextPeriod" }, { keys: ["t"], label: "Today", labelKey: "home.shortcuts.today" }, { keys: ["m"], label: "Month", labelKey: "home.shortcuts.month" }, { keys: ["w"], label: "Week", labelKey: "home.shortcuts.week" }, { keys: ["d"], label: "Agenda", labelKey: "home.shortcuts.agenda" },
  ] },
  { id: "home-tasks", title: "Task rows", titleKey: "home.shortcuts.taskRowsGroup", items: [
    { keys: ["enter"], label: "Rename", labelKey: "home.shortcuts.rename" }, { keys: ["space"], label: "Complete", labelKey: "home.shortcuts.complete" }, { keys: ["s"], label: "Next status", labelKey: "home.shortcuts.nextStatus" }, { keys: ["e"], label: "Details", labelKey: "home.shortcuts.details" }, { keys: ["backspace"], label: "Delete", labelKey: "home.shortcuts.delete" },
  ] },
];

export function HomePage({ initial }: { initial: HomeInitialData }) {
  return (
    <HomeProvider initial={initial}>
      <HomeLayout />
      <EventSheet />
      <EventDialog />
      <TaskDialog />
      <React.Suspense fallback={null}><DeepLinkHandler /></React.Suspense>
    </HomeProvider>
  );
}

/** Honors /?task=<id>, /?event=<id> and /?section=<calendar|tasks|news|updates|matters> deep links (command palette, workflow artifacts). */
function DeepLinkHandler() {
  const params = useSearchParams();
  const { tasks, events } = useHome();
  const openTaskDialog = useHomeUI((s) => s.openTaskDialog);
  const openEvent = useHomeUI((s) => s.openEvent);
  const setFocus = useHomeUI((s) => s.setFocus);
  const task = params.get("task");
  const event = params.get("event");
  const section = params.get("section") as HomeSection | null;
  const t = useT();
  // Only react to the URL once per link (data refreshes must not re-open a dialog the user closed).
  const handled = React.useRef<string | null>(null);
  React.useEffect(() => {
    const key = `${task ?? ""}|${event ?? ""}|${section ?? ""}`;
    if (handled.current === key) return;
    handled.current = key;
    if (task) {
      if (tasks.some((t) => t.id === task)) openTaskDialog({ taskId: task });
      else toast.error(t("home.toast.taskNotFound"), { description: t("home.toast.taskNotFoundDesc") });
    }
    if (event) {
      if (events.some((e) => e.id === event)) openEvent(event);
      else toast.error(t("home.toast.eventNotFound"), { description: t("home.toast.eventNotFoundDesc") });
    }
    if (section && ["calendar", "tasks", "news", "updates", "matters"].includes(section)) setFocus(section);
  }, [task, event, section, tasks, events, openTaskDialog, openEvent, setFocus, t]);
  return null;
}

const ALL = "__all__";

function HomeLayout() {
  const focus = useHomeUI((s) => s.focus);
  const setFocus = useHomeUI((s) => s.setFocus);
  const mainRef = React.useRef<HTMLDivElement>(null);
  useHomeShortcuts();
  useShortcutHelp(HOME_SHORTCUTS, "home");

  // Reset scroll when switching between overview and a focused section.
  React.useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [focus]);

  return (
    <div className="flex h-full min-h-0">
      <Topbar />
      <div ref={mainRef} className={cn("flex min-w-0 flex-1 flex-col overflow-y-auto scrollbar-thin", focus && "overflow-hidden")}>
        {focus ? (
          <div className="flex h-full min-h-0 flex-col p-2">
            <FocusedSection section={focus} onClose={() => setFocus(null)} />
          </div>
        ) : (
          <Overview />
        )}
      </div>
      <AssistantDock />
    </div>
  );
}

/**
 * Overview order follows the litigator's morning: what is due (spine), the
 * matters, the brief, then the quieter news and team updates. Sections with
 * nothing to show are left out rather than rendered as empty boxes; before the
 * first matter exists the page is the greeting plus a first-run checklist.
 */
function Overview() {
  const { setup, news, updates } = useHome();
  const composerNonce = useHomeUI((s) => s.composerNonce);
  const firstRun = setup.matters === 0;
  const showNews = news.length > 0;
  const showUpdates = updates.length > 0 || composerNonce > 0;
  return (
    <div className="@container mx-auto w-full max-w-[1480px] space-y-4 p-4 pb-8">
      <TodaySpine firstRun={firstRun} />
      {firstRun && <FirstRunChecklist />}
      <ForYouSection />
      <UpcomingPrepSection />
      <MatterWatchSection />
      {!firstRun && (
        <div className="grid gap-4 @5xl:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
          <MattersOverview />
          <DailyBriefCard />
        </div>
      )}
      {(showNews || showUpdates) && (
        <div className={cn("grid gap-4", showNews && showUpdates && "@3xl:grid-cols-2")}>
          {showNews && <NewsOverview />}
          {showUpdates && <UpdatesOverview />}
        </div>
      )}
    </div>
  );
}

function FocusedSection({ section, onClose }: { section: HomeSection; onClose: () => void }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector('[role="dialog"]')) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  switch (section) {
    case "calendar": return <CalendarFocus />;
    case "tasks": return <TasksFocus />;
    case "news": return <NewsFocus />;
    case "updates": return <UpdatesFocus />;
    case "matters": return <MattersFocus />;
  }
}

function Topbar() {
  const { matters, matterFilter, setMatterFilter, refresh, refreshing, matterById } = useHome();
  const focus = useHomeUI((s) => s.focus);
  const setFocus = useHomeUI((s) => s.setFocus);
  const openTaskDialog = useHomeUI((s) => s.openTaskDialog);
  const openEventDialog = useHomeUI((s) => s.openEventDialog);
  const focusComposer = useHomeUI((s) => s.focusComposer);
  const dockOpen = useHomeUI((s) => s.dockOpen);
  const setDockOpen = useHomeUI((s) => s.setDockOpen);
  const help = useShortcutHelp(undefined);
  const t = useT();
  const sectionLabel: Record<HomeSection, string> = { calendar: t("home.section.calendar"), tasks: t("home.section.tasks"), news: t("home.section.news"), updates: t("home.section.updates"), matters: t("home.section.matters") };
  const active = matterById(matterFilter);
  return (
    <TopbarSlot>
      <HomeIcon className="size-4 text-muted-foreground" />
      <button onClick={() => setFocus(null)} className="shrink-0 text-[13px] font-semibold hover:text-primary cursor-pointer">{t("home.title")}</button>
      {focus && <><span className="text-muted-foreground">/</span><span className="text-[13px] text-muted-foreground">{sectionLabel[focus]}</span><Button variant="ghost" size="icon-xs" onClick={() => setFocus(null)} aria-label={t("common.backToOverview")}><X className="size-3.5" /></Button></>}
      {active && (
        <button onClick={() => setMatterFilter(null)} className="chip chip-accent ms-1 hidden md:inline-flex cursor-pointer" title={t("home.topbar.clearMatterFilter")}><Scale className="size-3" /> {active.shortName} <X className="size-3 opacity-70" /></button>
      )}
      <div className="flex-1" />
      {/* Filters and shortcuts live in one quiet popover instead of a row of controls. */}
      <Popover>
        <Tip label={t("home.topbar.filters")}><PopoverTrigger asChild><Button variant={matterFilter ? "secondary" : "ghost"} size="icon-xs" aria-label={t("home.topbar.filters")}><SlidersHorizontal className="size-4" /></Button></PopoverTrigger></Tip>
        <PopoverContent align="end" className="w-72 space-y-3 p-3">
          <div>
            <Label className="text-[11px] text-muted-foreground">{t("home.topbar.matter")}</Label>
            <Select value={matterFilter ?? ALL} onValueChange={(v) => setMatterFilter(v === ALL ? null : v)}>
              <SelectTrigger size="xs" className="mt-1 w-full" aria-label={t("home.topbar.matterFilter")}><SelectValue placeholder={t("home.topbar.allMatters")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("home.topbar.allMatters")}</SelectItem>
                {matters.map((m) => <SelectItem key={m.id} value={m.id}>{m.shortName} <span className="text-muted-foreground">· {m.caption ?? m.practiceArea}</span></SelectItem>)}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("home.topbar.filterHint")}</p>
          </div>
          <div className="flex items-center justify-between border-t pt-2">
            <span className="text-[11px] text-muted-foreground">{t("home.topbar.data")}</span>
            <Button variant="outline" size="xs" onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={cn("size-3", refreshing && "animate-spin")} /> {t("common.refresh")}</Button>
          </div>
        </PopoverContent>
      </Popover>
      <Tip label={t("shell.menu.shortcuts")} shortcut="?"><Button variant="ghost" size="icon-xs" onClick={() => help.open()} aria-label={t("shell.menu.shortcuts")}><Keyboard className="size-4" /></Button></Tip>
      <Tip label={dockOpen ? t("home.topbar.hideAssistant") : t("home.topbar.showAssistant")} shortcut="A"><Button variant={dockOpen ? "secondary" : "ghost"} size="icon-xs" onClick={() => setDockOpen(!dockOpen)} aria-label={t("home.topbar.toggleAssistant")}><MessageSquareText className="size-4" /></Button></Tip>
      <div className="ms-1 flex items-center">
        <Button size="xs" className="rounded-e-none" onClick={() => openTaskDialog({})}><Plus className="size-3.5" /> {t("common.new")}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="xs" className="rounded-s-none border-s border-primary-foreground/20 px-1.5" aria-label={t("home.topbar.moreNew")}><ChevronDown className="size-3.5" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>{t("common.create")}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => openTaskDialog({})}><CheckSquare /> {t("home.topbar.task")}<DropdownMenuShortcut>N T</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onClick={() => openEventDialog({})}><CalendarPlus /> {t("home.topbar.event")}<DropdownMenuShortcut>N E</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onClick={focusComposer}><MessageSquarePlus /> {t("home.topbar.teamUpdate")}<DropdownMenuShortcut>N U</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { setFocus("calendar"); }}>{t("home.topbar.openCalendar")}<DropdownMenuShortcut>C</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onClick={() => { useHomeUI.getState().setTasksView("board"); setFocus("tasks"); }}>{t("home.topbar.openTaskBoard")}<DropdownMenuShortcut>K</DropdownMenuShortcut></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TopbarSlot>
  );
}


/** Page-level chords and single-key shortcuts (ignored while typing or when a dialog is open). */
function useHomeShortcuts() {
  React.useEffect(() => {
    let chord: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      const s = useHomeUI.getState();
      const k = e.key.toLowerCase();
      if (chord === "n") {
        chord = null;
        if (k === "t") { e.preventDefault(); s.openTaskDialog({}); }
        else if (k === "e") { e.preventDefault(); s.openEventDialog({}); }
        else if (k === "u") { e.preventDefault(); s.focusComposer(); }
        return;
      }
      if (chord === "g") { chord = null; return; } // shell navigation chord
      if (k === "n" || k === "g") { chord = k; clearTimeout(timer); timer = setTimeout(() => (chord = null), 900); return; }
      if (k === "a") { e.preventDefault(); s.setDockOpen(!s.dockOpen); }
      else if (k === "c") { e.preventDefault(); s.setFocus("calendar"); }
      else if (k === "k") { e.preventDefault(); s.setTasksView("board"); s.setFocus("tasks"); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(timer); };
  }, []);
}
