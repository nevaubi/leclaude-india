"use client";
import * as React from "react";
import { T } from "@/lib/i18n/client";
import Link from "next/link";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCorners, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { Check, CheckSquare, Circle, CircleDot, Columns3, ExternalLink, GripVertical, Link2, List, MoreHorizontal, Pencil, Plus, Trash2, User } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { PersonAvatar } from "@/components/ui/avatar";
import { Tip } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Task } from "@/lib/types/domain";
import { addDays, dateKey, daysBetween, endOfWeek, fmtDate, toDate } from "../time";
import { TASK_PRIORITIES, TASK_STATUSES, TASK_STATUS_LABEL, type TaskInput } from "../types";
import { useHomeUI } from "../store";
import { taskFormFor, type TaskForm } from "../forms";
import { useHome } from "./home-provider";
import { CountdownChip, DateInput, EmptyRow, FieldLabel, MatterBadge, NONE, PRIORITY_STYLE, PriorityBadge, Section, SourceIcon } from "./shared";
import { isHiddenHref } from "@/lib/features";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export function useVisibleTasks() {
  const { tasks, matterFilter, userId, now } = useHome();
  const filter = useHomeUI((s) => s.taskFilter);
  return React.useMemo(() => {
    const list = tasks.filter((t) =>
      (!matterFilter || t.matterId === matterFilter) &&
      (!filter.mine || t.assigneeId === userId) &&
      (!filter.overdue || (t.status !== "done" && !!t.dueAt && daysBetween(now, toDate(t.dueAt)) < 0)),
    );
    const open = list.filter((t) => t.status !== "done");
    const done = list.filter((t) => t.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { list, open, done, overdue: open.filter((t) => t.dueAt && daysBetween(now, toDate(t.dueAt)) < 0) };
  }, [tasks, matterFilter, userId, now, filter]);
}

type Group = "overdue" | "today" | "week" | "later" | "nodate" | "done";
const GROUP_LABEL: Record<Group, string> = { overdue: "Overdue", today: "Today", week: "This week", later: "Later", nodate: "No due date", done: "Done" };

function groupTasks(open: Task[], now: Date): { key: Group; tasks: Task[] }[] {
  const weekEnd = endOfWeek(now);
  const groups: Record<Group, Task[]> = { overdue: [], today: [], week: [], later: [], nodate: [], done: [] };
  for (const t of open) {
    if (!t.dueAt) { groups.nodate.push(t); continue; }
    const d = daysBetween(now, toDate(t.dueAt));
    if (d < 0) groups.overdue.push(t);
    else if (d === 0) groups.today.push(t);
    else if (toDate(t.dueAt).getTime() <= weekEnd.getTime() || d <= 7) groups.week.push(t);
    else groups.later.push(t);
  }
  return (Object.keys(groups) as Group[]).filter((k) => k !== "done" && groups[k].length).map((k) => ({ key: k, tasks: groups[k] }));
}

const NEXT_STATUS: Record<Task["status"], Task["status"]> = { todo: "in_progress", in_progress: "review", review: "done", done: "todo" };

// ---------------------------------------------------------------------------
// Overview card (right column)
// ---------------------------------------------------------------------------

export function TasksOverview() {
  const { now } = useHome();
  const { open, overdue, done } = useVisibleTasks();
  const filter = useHomeUI((s) => s.taskFilter);
  const setFilter = useHomeUI((s) => s.setTaskFilter);
  const setFocus = useHomeUI((s) => s.setFocus);
  const setTasksView = useHomeUI((s) => s.setTasksView);
  const groups = groupTasks(open, now);
  return (
    <Section
      id="tasks"
      title={<T k="home.section.tasks" />}
      icon={CheckSquare}
      count={open.length}
      actions={
        <>
          <FilterChips filter={filter} setFilter={setFilter} overdueCount={overdue.length} />
          <Tip label="Kanban board" shortcut="K"><Button variant="ghost" size="icon-xs" onClick={() => { setTasksView("board"); setFocus("tasks"); }} aria-label="Open board"><Columns3 className="size-3.5" /></Button></Tip>
        </>
      }
      onExpand={() => setFocus("tasks")}
    >
      <div className="px-2 pb-2 pt-2">
        <QuickAdd />
        {groups.length === 0 && (!filter.showDone || !done.length) ? (
          <EmptyRow icon={CheckSquare} title={filter.mine || filter.overdue ? "Nothing matches these filters" : "All clear"} hint={filter.overdue ? "No overdue tasks. Nice." : "Add a task above, or let a workflow create them for you."} className="py-6" />
        ) : (
          <div className="mt-1.5 space-y-1.5">
            {groups.map((g) => <TaskGroup key={g.key} label={GROUP_LABEL[g.key]} tasks={g.tasks} tone={g.key === "overdue" ? "text-destructive" : g.key === "today" ? "text-primary" : undefined} />)}
            {filter.showDone && done.length > 0 && <TaskGroup label="Done" tasks={done.slice(0, 8)} tone="text-muted-foreground" muted />}
          </div>
        )}
      </div>
    </Section>
  );
}

function FilterChips({ filter, setFilter, overdueCount }: { filter: { mine: boolean; overdue: boolean; showDone: boolean }; setFilter: (p: Partial<{ mine: boolean; overdue: boolean; showDone: boolean }>) => void; overdueCount: number }) {
  const chip = (active: boolean, onClick: () => void, label: React.ReactNode, tone?: string) => (
    <button onClick={onClick} className={cn("h-6 rounded-md border px-2 text-[11px] font-medium transition-colors cursor-pointer", active ? "border-transparent bg-accent text-foreground" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground", active && tone)}>{label}</button>
  );
  return (
    <div className="flex items-center gap-0.5">
      {chip(filter.mine, () => setFilter({ mine: !filter.mine }), <span className="inline-flex items-center gap-1"><User className="size-3" /> Mine</span>)}
      {chip(filter.overdue, () => setFilter({ overdue: !filter.overdue }), <span className="inline-flex items-center gap-1">Overdue{overdueCount > 0 && <span className={cn("rounded-full px-1 tabular", "text-destructive")}>{overdueCount}</span>}</span>, "border-destructive/30 bg-destructive/10 text-destructive")}
      {chip(filter.showDone, () => setFilter({ showDone: !filter.showDone }), "Done")}
    </div>
  );
}

function QuickAdd({ status, className, autoFocusNonce }: { status?: Task["status"]; className?: string; autoFocusNonce?: number }) {
  const { createTask, matterFilter, userId } = useHome();
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (autoFocusNonce) ref.current?.focus(); }, [autoFocusNonce]);
  const submit = async () => {
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    // Lightweight natural-language hints: "!urgent", "!high", "@today", "@tomorrow", "@fri", "#matter".
    let priority: Task["priority"] = "medium";
    let dueAt: string | null = null;
    const matterId = matterFilter;
    let clean = title;
    const pm = /!(urgent|high|medium|low)\b/i.exec(clean); if (pm) { priority = pm[1].toLowerCase() as Task["priority"]; clean = clean.replace(pm[0], ""); }
    const dm = /@(today|tomorrow|mon|tue|wed|thu|fri|sat|sun|\d{4}-\d{2}-\d{2})\b/i.exec(clean);
    if (dm) {
      const v = dm[1].toLowerCase(); const now = new Date();
      if (v === "today") dueAt = dateKey(now); else if (v === "tomorrow") dueAt = dateKey(addDays(now, 1));
      else if (/^\d{4}/.test(v)) dueAt = v;
      else { const idx = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(v); let delta = (idx - now.getDay() + 7) % 7; if (delta === 0) delta = 7; dueAt = dateKey(addDays(now, delta)); }
      clean = clean.replace(dm[0], "");
    }
    const t = await createTask({ title: clean.replace(/\s+/g, " ").trim(), priority, dueAt, matterId, assigneeId: userId, status: status ?? "todo" });
    setBusy(false);
    if (t) { setValue(""); toast.success("Task added", { description: t.dueAt ? `Due ${fmtDate(t.dueAt)}` : undefined }); }
  };
  return (
    <div className={cn("relative", className)}>
      <Plus className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input ref={ref} size="xs" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } if (e.key === "Escape") setValue(""); }} placeholder={status ? `Add to ${TASK_STATUS_LABEL[status]}…` : "Add a task…  try  !urgent  @fri  (Enter)"} className="pl-8" aria-label="Quick add task" />
    </div>
  );
}

function TaskGroup({ label, tasks, tone, muted }: { label: string; tasks: Task[]; tone?: string; muted?: boolean }) {
  return (
    <div>
      <div className={cn("flex items-center gap-1.5 px-1.5 pb-0.5 text-[11.5px] font-medium text-muted-foreground", tone)}>{label}<span className="tabular opacity-70">{tasks.length}</span></div>
      <ul className={cn("divide-y divide-line-quiet", muted && "opacity-70")}>{tasks.map((t) => <TaskRow key={t.id} task={t} />)}</ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task row (list) — keyboard: Enter edit · Space complete · E open · Delete remove · S cycle status
// ---------------------------------------------------------------------------

export function TaskRow({ task: t, dense }: { task: Task; dense?: boolean }) {
  const { updateTask, deleteTask, personById, matterById } = useHome();
  const openTaskDialog = useHomeUI((s) => s.openTaskDialog);
  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState(t.title);
  const rowRef = React.useRef<HTMLLIElement>(null);
  React.useEffect(() => setTitle(t.title), [t.title]);
  const done = t.status === "done";
  const assignee = personById(t.assigneeId);

  const toggleDone = async () => {
    const next = done ? "todo" : "done";
    await updateTask(t.id, { status: next });
  };
  const commit = async () => {
    setEditing(false);
    const v = title.trim();
    if (!v || v === t.title) { setTitle(t.title); return; }
    await updateTask(t.id, { title: v });
  };
  const remove = async () => { if (await deleteTask(t.id)) toast.success("Task deleted", { description: t.title }); };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    if (e.key === "Enter") { e.preventDefault(); setEditing(true); }
    else if (e.key === " ") { e.preventDefault(); void toggleDone(); }
    else if (e.key.toLowerCase() === "e") { e.preventDefault(); openTaskDialog({ taskId: t.id }); }
    else if (e.key.toLowerCase() === "s") { e.preventDefault(); void updateTask(t.id, { status: NEXT_STATUS[t.status] }); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); void remove(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (rowRef.current?.nextElementSibling as HTMLElement | null)?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (rowRef.current?.previousElementSibling as HTMLElement | null)?.focus(); }
  };

  const matter = matterById(t.matterId);
  return (
    <li
      ref={rowRef}
      tabIndex={0}
      onKeyDown={onKey}
      onDoubleClick={() => setEditing(true)}
      className={cn("group flex items-center gap-2 rounded px-1.5 outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50", dense ? "h-[24px]" : "h-[28px]")}
    >
      <button onClick={() => void toggleDone()} aria-label={done ? "Mark as not done" : "Mark as done"} className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors cursor-pointer", done ? "border-success bg-success text-success-foreground" : "border-muted-foreground/40 hover:border-primary")}>{done && <Check className="size-2.5" />}</button>
      <PriorityBadge priority={t.priority} compact />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {editing ? (
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } if (e.key === "Escape") { setTitle(t.title); setEditing(false); } }} className="w-full rounded border border-ring bg-background px-1.5 py-0 text-[12.5px] leading-5 outline-none" />
        ) : (
          <>
            <span className={cn("truncate text-[12.5px] leading-snug", done && "text-muted-foreground line-through")}>{t.title}</span>
            <SourceIcon source={t.source} />
            {(() => { const l = t.links?.find((x) => !isHiddenHref(x.href)); return l ? <Tip label={l.label}><Link href={l.href} className="text-muted-foreground hover:text-primary" onClick={(e) => e.stopPropagation()}><Link2 className="size-3" /></Link></Tip> : null; })()}
          </>
        )}
      </div>
      {t.status !== "todo" && !done && <span className="hidden shrink-0 text-[10.5px] text-muted-foreground sm:inline">{TASK_STATUS_LABEL[t.status]}</span>}
      {matter && <span className="hidden max-w-[120px] shrink-0 truncate text-[11px] text-muted-foreground md:inline" title={matter.name}>{matter.shortName}</span>}
      {!done && <CountdownChip date={t.dueAt} deadline className="shrink-0" />}
      {done && t.dueAt && <span className="shrink-0 text-[10.5px] text-muted-foreground">was due {fmtDate(t.dueAt)}</span>}
      {assignee && <Tip label={assignee.name}><span className="shrink-0"><PersonAvatar name={assignee.name} size="xs" /></span></Tip>}
      <div className="flex w-5 shrink-0 items-center justify-end opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <TaskMenu task={t} onEdit={() => openTaskDialog({ taskId: t.id })} onDelete={remove} />
      </div>
    </li>
  );
}

function TaskMenu({ task: t, onEdit, onDelete }: { task: Task; onEdit: () => void; onDelete: () => void }) {
  const { updateTask, people } = useHome();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label="Task actions"><MoreHorizontal className="size-3.5" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={onEdit}><Pencil /> Edit details<span className="ml-auto text-[10px] text-muted-foreground">E</span></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={t.status} onValueChange={(v) => void updateTask(t.id, { status: v as Task["status"] })}>
          {TASK_STATUSES.map((s) => <DropdownMenuRadioItem key={s} value={s}>{TASK_STATUS_LABEL[s]}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Priority</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={t.priority} onValueChange={(v) => void updateTask(t.id, { priority: v as Task["priority"] })}>
          {TASK_PRIORITIES.map((p) => <DropdownMenuRadioItem key={p} value={p}><span className={cn("mr-1.5 inline-block size-2 rounded-full", PRIORITY_STYLE[p].dot)} />{PRIORITY_STYLE[p].label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Assign to</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={t.assigneeId ?? NONE} onValueChange={(v) => void updateTask(t.id, { assigneeId: v === NONE ? null : v })}>
          {people.filter((p) => p.role === "attorney" || p.role === "paralegal" || p.role === "staff").map((p) => <DropdownMenuRadioItem key={p.id} value={p.id}>{p.name}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onClick={onDelete}><Trash2 /> Delete<span className="ml-auto text-[10px] text-muted-foreground">⌫</span></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Focused tasks: list or board
// ---------------------------------------------------------------------------

export function TasksFocus() {
  const { now } = useHome();
  const { open, done, overdue, list } = useVisibleTasks();
  const view = useHomeUI((s) => s.tasksView);
  const setView = useHomeUI((s) => s.setTasksView);
  const filter = useHomeUI((s) => s.taskFilter);
  const setFilter = useHomeUI((s) => s.setTaskFilter);
  const setFocus = useHomeUI((s) => s.setFocus);
  const openTaskDialog = useHomeUI((s) => s.openTaskDialog);
  const groups = groupTasks(open, now);
  return (
    <Section
      id="tasks"
      title={<T k="home.section.tasks" />}
      icon={CheckSquare}
      count={`${open.length} open`}
      expanded
      onExpand={() => setFocus(null)}
      actions={
        <>
          <FilterChips filter={filter} setFilter={setFilter} overdueCount={overdue.length} />
          <div className="ml-1 flex items-center rounded-md border p-0.5">
            <button onClick={() => setView("list")} className={cn("flex h-6 items-center gap-1 rounded px-2 text-[11px] cursor-pointer", view === "list" ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground")}><List className="size-3" /> List</button>
            <button onClick={() => setView("board")} className={cn("flex h-6 items-center gap-1 rounded px-2 text-[11px] cursor-pointer", view === "board" ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground")}><Columns3 className="size-3" /> Board</button>
          </div>
          <Button size="xs" onClick={() => openTaskDialog({})}><Plus className="size-3" /> Task</Button>
        </>
      }
      bodyClassName={cn("min-h-0", view === "board" ? "overflow-x-auto overflow-y-hidden scrollbar-thin" : "overflow-auto scrollbar-thin")}
    >
      {view === "board" ? (
        <TaskBoard tasks={filter.showDone ? list : list.filter((t) => t.status !== "done" || daysBetween(toDate(t.updatedAt), now) <= 7)} />
      ) : (
        <div className="mx-auto max-w-3xl px-3 py-3">
          <QuickAdd />
          <div className="mt-3 space-y-3">
            {groups.map((g) => <TaskGroup key={g.key} label={GROUP_LABEL[g.key]} tasks={g.tasks} tone={g.key === "overdue" ? "text-destructive" : g.key === "today" ? "text-primary" : undefined} />)}
            {filter.showDone && done.length > 0 && <TaskGroup label="Done" tasks={done} tone="text-muted-foreground" muted />}
            {!groups.length && !done.length && <EmptyRow icon={CheckSquare} title="No tasks match" hint="Clear the filters or add a task." />}
          </div>
          <p className="mt-4 text-[11px] text-muted-foreground">Keyboard: focus a row, then <kbd>↵</kbd> rename · <kbd>Space</kbd> complete · <kbd>S</kbd> next status · <kbd>E</kbd> details · <kbd>⌫</kbd> delete.</p>
        </div>
      )}
    </Section>
  );
}

function TaskBoard({ tasks }: { tasks: Task[] }) {
  const { updateTask } = useHome();
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const columns = TASK_STATUSES.map((s) => ({ status: s, tasks: tasks.filter((t) => t.status === s) }));
  const active = tasks.find((t) => t.id === activeId) ?? null;

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    const overId = e.over?.id;
    if (!overId) return;
    const status = String(overId) as Task["status"];
    if (!TASK_STATUSES.includes(status)) return;
    const task = tasks.find((t) => t.id === e.active.id);
    if (!task || task.status === status) return;
    await updateTask(task.id, { status });
    toast.success(`Moved to ${TASK_STATUS_LABEL[status]}`, { description: task.title });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))} onDragEnd={(e) => void onDragEnd(e)} onDragCancel={() => setActiveId(null)}>
      <div className="grid h-full min-w-[880px] grid-cols-4 gap-3 p-3">
        {columns.map((c) => <BoardColumn key={c.status} status={c.status} tasks={c.tasks} />)}
      </div>
      <DragOverlay dropAnimation={null}>{active ? <BoardCard task={active} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

const COLUMN_ICON: Record<Task["status"], React.ReactNode> = { todo: <Circle className="size-3.5 text-muted-foreground" />, in_progress: <CircleDot className="size-3.5 text-primary" />, review: <CircleDot className="size-3.5 text-chart-3" />, done: <Check className="size-3.5 text-success" /> };

function BoardColumn({ status, tasks }: { status: Task["status"]; tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div ref={setNodeRef} data-column={status} className={cn("flex min-h-0 flex-col rounded-lg border bg-muted/30 transition-colors", isOver && "border-primary/40 bg-primary/5")}>
      <div className="flex items-center gap-1.5 px-2.5 py-2 text-[12px] font-semibold">{COLUMN_ICON[status]}{TASK_STATUS_LABEL[status]}<span className="rounded-full bg-background px-1.5 text-[10.5px] font-medium tabular text-muted-foreground">{tasks.length}</span></div>
      <div className="px-2 pb-2"><QuickAdd status={status} /></div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2 scrollbar-thin">
        {tasks.map((t) => <DraggableCard key={t.id} task={t} />)}
        {!tasks.length && <div className="rounded-md border border-dashed px-2 py-6 text-center text-[11px] text-muted-foreground">Drop tasks here</div>}
      </div>
    </div>
  );
}

function DraggableCard({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, data: { status: task.status } });
  return (
    <div ref={setNodeRef} data-task-id={task.id} className={cn(isDragging && "opacity-30")}>
      <BoardCard task={task} handleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

function BoardCard({ task: t, handleProps, overlay }: { task: Task; handleProps?: React.HTMLAttributes<HTMLButtonElement>; overlay?: boolean }) {
  const { personById, deleteTask, matterById } = useHome();
  const openTaskDialog = useHomeUI((s) => s.openTaskDialog);
  const assignee = personById(t.assigneeId);
  const matter = matterById(t.matterId);
  return (
    <div className={cn("group rounded-md border bg-card p-2 text-left transition-colors hover:border-foreground/25", overlay && "shadow-lg ring-2 ring-primary/30")} onDoubleClick={() => openTaskDialog({ taskId: t.id })}>
      <div className="flex items-start gap-1.5">
        <button {...handleProps} className="mt-0.5 shrink-0 cursor-grab touch-none rounded text-muted-foreground/60 hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label="Drag task"><GripVertical className="size-3.5" /></button>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium leading-snug">{t.title}</div>
          {t.description && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{t.description}</div>}
        </div>
        {!overlay && <div className="opacity-0 group-hover:opacity-100"><TaskMenu task={t} onEdit={() => openTaskDialog({ taskId: t.id })} onDelete={() => void deleteTask(t.id)} /></div>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={t.priority} compact />
        {matter && <MatterBadge matterId={t.matterId} />}
        {t.status !== "done" && <CountdownChip date={t.dueAt} deadline />}
        <SourceIcon source={t.source} />
        {assignee && <Tip label={assignee.name}><span className="ml-auto"><PersonAvatar name={assignee.name} size="xs" /></span></Tip>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task dialog (create / edit)
// ---------------------------------------------------------------------------

export function TaskDialog() {
  const { tasks } = useHome();
  const dlg = useHomeUI((s) => s.taskDialog);
  const close = useHomeUI((s) => s.closeTaskDialog);
  const existing = React.useMemo(() => (dlg.taskId ? tasks.find((t) => t.id === dlg.taskId) ?? null : null), [tasks, dlg.taskId]);
  return (
    <Dialog open={dlg.open} onOpenChange={(o) => { if (!o) close(); }}>
      {/* Mount the form only while open (keyed by task) so its state re-initialises from the selected task / initial values on every open. */}
      {dlg.open && <TaskDialogForm key={dlg.taskId ?? "new"} existing={existing} initial={dlg.initial} onClose={close} />}
    </Dialog>
  );
}

function TaskDialogForm({ existing, initial, onClose: close }: { existing: Task | null; initial: Partial<TaskInput> | null; onClose: () => void }) {
  const { people, matters, userId, matterFilter, createTask, updateTask, deleteTask } = useHome();
  const [form, setForm] = React.useState<TaskForm>(() => taskFormFor(existing, initial, { userId, matterFilter }));
  const [saving, setSaving] = React.useState(false);
  const set = <K extends keyof TaskForm>(k: K, v: TaskForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.title.trim()) { toast.error("Give the task a title"); return; }
    setSaving(true);
    const payload: TaskInput = { title: form.title, description: form.description || null, matterId: form.matterId || null, assigneeId: form.assigneeId || null, status: form.status, priority: form.priority, dueAt: form.dueAt || null, tags: form.tags.split(",").map((s) => s.trim()).filter(Boolean), links: form.links };
    const res = existing ? await updateTask(existing.id, payload) : await createTask(payload);
    setSaving(false);
    if (res) { toast.success(existing ? "Task updated" : "Task created", { description: res.title }); close(); }
  };

  return (
      <DialogContent size="lg" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void save(); } }}>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>{existing ? <span className="inline-flex flex-wrap items-center gap-1.5">Created {fmtDate(existing.createdAt, { month: "short", day: "numeric", year: "numeric" })}{existing.source && existing.source !== "manual" && <Badge variant="muted" className="capitalize">{existing.source}</Badge>}</span> : "Tasks show up in the daily brief and in matter overviews."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-6">
          <div className="sm:col-span-6"><FieldLabel>Title</FieldLabel><Input autoFocus value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Draft opposition to motion to compel" /></div>
          <div className="sm:col-span-6"><FieldLabel>Description</FieldLabel><Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={3} placeholder="Scope, sources, what done looks like…" /></div>
          <div className="sm:col-span-3"><FieldLabel>Matter</FieldLabel>
            <Select value={form.matterId || NONE} onValueChange={(v) => set("matterId", v === NONE ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="No matter" /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>No matter (firm)</SelectItem>{matters.map((m) => <SelectItem key={m.id} value={m.id}>{m.shortName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-3"><FieldLabel>Assignee</FieldLabel>
            <Select value={form.assigneeId || NONE} onValueChange={(v) => set("assigneeId", v === NONE ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>Unassigned</SelectItem>{people.filter((p) => ["attorney", "paralegal", "staff"].includes(p.role)).map((p) => <SelectItem key={p.id} value={p.id}>{p.name} <span className="text-muted-foreground">· {p.title}</span></SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2"><FieldLabel>Status</FieldLabel>
            <Select value={form.status} onValueChange={(v) => set("status", v as Task["status"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{TASK_STATUSES.map((s) => <SelectItem key={s} value={s}>{TASK_STATUS_LABEL[s]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2"><FieldLabel>Priority</FieldLabel>
            <Select value={form.priority} onValueChange={(v) => set("priority", v as Task["priority"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{TASK_PRIORITIES.map((p) => <SelectItem key={p} value={p}><span className="inline-flex items-center gap-2"><span className={cn("size-2 rounded-full", PRIORITY_STYLE[p].dot)} />{PRIORITY_STYLE[p].label}</span></SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2"><FieldLabel>Due</FieldLabel><DateInput value={form.dueAt} onChange={(v) => set("dueAt", v)} /></div>
          <div className="sm:col-span-6"><FieldLabel>Tags</FieldLabel><Input value={form.tags} onChange={(e) => set("tags", e.target.value)} placeholder="review, privilege, msj" /></div>
          {form.links.length > 0 && (
            <div className="sm:col-span-6"><FieldLabel>Links</FieldLabel>
              <div className="flex flex-wrap gap-1.5">{form.links.map((l, i) => isHiddenHref(l.href) ? <span key={i} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground">{l.label}</span> : <Link key={i} href={l.href} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent"><ExternalLink className="size-3" />{l.label}</Link>)}</div>
            </div>
          )}
        </div>
        <DialogFooter className="items-center">
          {existing && <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={async () => { if (await deleteTask(existing.id)) { toast.success("Task deleted"); close(); } }}><Trash2 className="size-4" /> Delete</Button>}
          {!existing && <span className="mr-auto text-[11px] text-muted-foreground"><kbd>⌘</kbd> <kbd>↵</kbd> to save</span>}
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : existing ? "Save changes" : "Create task"}</Button>
        </DialogFooter>
      </DialogContent>
  );
}
