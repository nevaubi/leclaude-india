"use client";
import * as React from "react";
import { toast } from "sonner";
import { useShellStore } from "@/components/shell/shell-store";
import type { CalendarEvent, NewsItem, Task, TeamUpdate } from "@/lib/types/domain";
import type { CalendarEntry, DailyBrief, EventInput, EventPatch, HomeInitialData, MatterLite, MatterOverview, PersonLite, TaskInput, TaskPatch, TeamUpdateView, UpdateReply } from "../types";
import { useHomeUI } from "../store";

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public payload?: unknown) { super(message); this.name = "ApiError"; }
}

export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, { ...rest, headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) }, body: json !== undefined ? JSON.stringify(json) : rest.body });
  const text = await res.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!res.ok) {
    const p = payload as { error?: string; code?: string } | null;
    throw new ApiError(p?.error ?? `${res.status} ${res.statusText}`, res.status, p?.code, payload);
  }
  return payload as T;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface HomeContextValue {
  now: Date;
  userId: string;
  userName: string;
  aiConfigured: boolean;
  /** The intelligence layer has published insights for the "For you" slot. */
  intelInsights: boolean;
  /** Workspace counts for the first-run checklist. */
  setup: { matters: number; documents: number; people: number };
  people: PersonLite[];
  matters: MatterLite[];
  personById: (id?: string | null) => PersonLite | undefined;
  matterById: (id?: string | null) => MatterLite | undefined;
  /** Active matter filter from the shell (validated against known matters). */
  matterFilter: string | null;
  setMatterFilter: (id: string | null) => void;

  tasks: Task[];
  events: CalendarEntry[];
  news: NewsItem[];
  updates: TeamUpdateView[];
  matterOverview: MatterOverview[];
  brief: DailyBrief;
  briefLoading: boolean;
  newsRefreshing: boolean;
  newNewsIds: Set<string>;
  refreshing: boolean;

  refresh: () => Promise<void>;
  createTask: (input: TaskInput) => Promise<Task | null>;
  updateTask: (id: string, patch: TaskPatch) => Promise<Task | null>;
  deleteTask: (id: string) => Promise<boolean>;
  createEvent: (input: EventInput) => Promise<CalendarEvent | null>;
  updateEvent: (id: string, patch: EventPatch) => Promise<CalendarEvent | null>;
  deleteEvent: (id: string) => Promise<boolean>;
  postUpdate: (input: { body: string; kind?: TeamUpdate["kind"]; matterId?: string | null }) => Promise<TeamUpdateView | null>;
  react: (updateId: string, emoji: string) => Promise<void>;
  reply: (updateId: string, body: string) => Promise<UpdateReply | null>;
  deleteUpdate: (id: string) => Promise<boolean>;
  refreshNews: () => Promise<void>;
  saveNews: (id: string) => Promise<string | null>;
  regenerateBrief: (mode?: "ai" | "computed") => Promise<void>;
}

const HomeContext = React.createContext<HomeContextValue | null>(null);

export function useHome(): HomeContextValue {
  const ctx = React.useContext(HomeContext);
  if (!ctx) throw new Error("useHome must be used inside <HomeProvider>");
  return ctx;
}

function errMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function HomeProvider({ initial, children }: { initial: HomeInitialData; children: React.ReactNode }) {
  const [data, setData] = React.useState<HomeInitialData>(initial);
  const [now, setNow] = React.useState<Date>(() => new Date(initial.now));
  const [briefLoading, setBriefLoading] = React.useState(false);
  const [newsRefreshing, setNewsRefreshing] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [newNewsIds, setNewNewsIds] = React.useState<Set<string>>(() => new Set());
  const activeMatterId = useShellStore((s) => s.activeMatterId);
  const setActiveMatterId = useShellStore((s) => s.setActiveMatterId);

  // Live clock (drives countdown chips and relative times) + persisted UI prefs.
  React.useEffect(() => {
    setNow(new Date());
    let firstVisit = true;
    try { firstVisit = !localStorage.getItem("leclaude:home"); } catch { /* storage unavailable */ }
    void useHomeUI.persist.rehydrate();
    // First visit on a narrower screen: start with the assistant collapsed so the three columns fit.
    if (firstVisit && window.innerWidth < 1500) useHomeUI.getState().setDockOpen(false);
    const t = setInterval(() => setNow(new Date()), 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") setNow(new Date()); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  const peopleMap = React.useMemo(() => new Map(data.people.map((p) => [p.id, p])), [data.people]);
  const mattersMap = React.useMemo(() => new Map(data.matters.map((m) => [m.id, m])), [data.matters]);
  const personById = React.useCallback((id?: string | null) => (id ? peopleMap.get(id) : undefined), [peopleMap]);
  const matterById = React.useCallback((id?: string | null) => (id ? mattersMap.get(id) : undefined), [mattersMap]);
  const matterFilter = activeMatterId && mattersMap.has(activeMatterId) ? activeMatterId : null;

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api<HomeInitialData>("/api/home/overview", { cache: "no-store" });
      setData(next);
      setNow(new Date());
    } catch (e) {
      toast.error("Could not refresh", { description: errMessage(e) });
    } finally { setRefreshing(false); }
  }, []);

  // Keep matter overview counts in sync after task/event mutations (cheap endpoint).
  const refreshMatters = React.useCallback(async () => {
    try { const r = await api<{ matters: MatterOverview[] }>("/api/home/matters", { cache: "no-store" }); setData((d) => ({ ...d, matterOverview: r.matters })); } catch { /* non-critical */ }
  }, []);

  // ----- Tasks -----
  const createTask = React.useCallback(async (input: TaskInput) => {
    try {
      const r = await api<{ task: Task }>("/api/home/tasks", { method: "POST", json: input });
      setData((d) => ({ ...d, tasks: [r.task, ...d.tasks] }));
      void refreshMatters();
      return r.task;
    } catch (e) { toast.error("Could not create task", { description: errMessage(e) }); return null; }
  }, [refreshMatters]);

  const updateTask = React.useCallback(async (id: string, patch: TaskPatch) => {
    let previous: Task | undefined;
    setData((d) => {
      previous = d.tasks.find((t) => t.id === id);
      return { ...d, tasks: d.tasks.map((t) => (t.id === id ? ({ ...t, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v === null ? undefined : v])), updatedAt: new Date().toISOString() } as Task) : t)) };
    });
    try {
      const r = await api<{ task: Task }>(`/api/home/tasks/${id}`, { method: "PATCH", json: patch });
      setData((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? r.task : t)) }));
      if (patch.status !== undefined || patch.dueAt !== undefined || patch.matterId !== undefined) void refreshMatters();
      return r.task;
    } catch (e) {
      if (previous) { const prev = previous; setData((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? prev : t)) })); }
      toast.error("Could not update task", { description: errMessage(e) });
      return null;
    }
  }, [refreshMatters]);

  const deleteTask = React.useCallback(async (id: string) => {
    let removed: Task | undefined;
    setData((d) => { removed = d.tasks.find((t) => t.id === id); return { ...d, tasks: d.tasks.filter((t) => t.id !== id) }; });
    try {
      await api(`/api/home/tasks/${id}`, { method: "DELETE" });
      void refreshMatters();
      return true;
    } catch (e) {
      if (removed) { const r = removed; setData((d) => ({ ...d, tasks: [r, ...d.tasks] })); }
      toast.error("Could not delete task", { description: errMessage(e) });
      return false;
    }
  }, [refreshMatters]);

  // ----- Events -----
  const createEvent = React.useCallback(async (input: EventInput) => {
    try {
      const r = await api<{ event: CalendarEvent }>("/api/home/events", { method: "POST", json: input });
      setData((d) => ({ ...d, events: [...d.events, r.event].sort((a, b) => a.startsAt.localeCompare(b.startsAt)) }));
      void refreshMatters();
      return r.event;
    } catch (e) { toast.error("Could not create event", { description: errMessage(e) }); return null; }
  }, [refreshMatters]);

  const updateEvent = React.useCallback(async (id: string, patch: EventPatch) => {
    try {
      const r = await api<{ event: CalendarEvent }>(`/api/home/events/${id}`, { method: "PATCH", json: patch });
      setData((d) => ({ ...d, events: d.events.map((e) => (e.id === id ? r.event : e)).sort((a, b) => a.startsAt.localeCompare(b.startsAt)) }));
      void refreshMatters();
      return r.event;
    } catch (e) { toast.error("Could not update event", { description: errMessage(e) }); return null; }
  }, [refreshMatters]);

  const deleteEvent = React.useCallback(async (id: string) => {
    try {
      await api(`/api/home/events/${id}`, { method: "DELETE" });
      setData((d) => ({ ...d, events: d.events.filter((e) => e.id !== id) }));
      void refreshMatters();
      return true;
    } catch (e) { toast.error("Could not delete event", { description: errMessage(e) }); return false; }
  }, [refreshMatters]);

  // ----- Team updates -----
  const postUpdate = React.useCallback(async (input: { body: string; kind?: TeamUpdate["kind"]; matterId?: string | null }) => {
    try {
      const r = await api<{ update: TeamUpdateView }>("/api/home/updates", { method: "POST", json: input });
      setData((d) => ({ ...d, updates: [r.update, ...d.updates] }));
      return r.update;
    } catch (e) { toast.error("Could not post update", { description: errMessage(e) }); return null; }
  }, []);

  const react = React.useCallback(async (updateId: string, emoji: string) => {
    // optimistic toggle
    setData((d) => ({
      ...d,
      updates: d.updates.map((u) => {
        if (u.id !== updateId) return u;
        const mine = u.myReactions.includes(emoji);
        const reactions = { ...(u.reactions ?? {}) };
        reactions[emoji] = Math.max(0, (reactions[emoji] ?? 0) + (mine ? -1 : 1));
        if (!reactions[emoji]) delete reactions[emoji];
        return { ...u, reactions, myReactions: mine ? u.myReactions.filter((x) => x !== emoji) : [...u.myReactions, emoji] };
      }),
    }));
    try {
      const r = await api<{ update: TeamUpdateView }>(`/api/home/updates/${updateId}/react`, { method: "POST", json: { emoji } });
      setData((d) => ({ ...d, updates: d.updates.map((u) => (u.id === updateId ? r.update : u)) }));
    } catch (e) { toast.error("Reaction failed", { description: errMessage(e) }); }
  }, []);

  const reply = React.useCallback(async (updateId: string, body: string) => {
    try {
      const r = await api<{ reply: UpdateReply }>(`/api/home/updates/${updateId}/replies`, { method: "POST", json: { body } });
      setData((d) => ({ ...d, updates: d.updates.map((u) => (u.id === updateId ? { ...u, replies: [...u.replies, r.reply] } : u)) }));
      return r.reply;
    } catch (e) { toast.error("Could not post reply", { description: errMessage(e) }); return null; }
  }, []);

  const deleteUpdate = React.useCallback(async (id: string) => {
    try {
      await api(`/api/home/updates/${id}`, { method: "DELETE" });
      setData((d) => ({ ...d, updates: d.updates.filter((u) => u.id !== id) }));
      return true;
    } catch (e) { toast.error("Could not delete update", { description: errMessage(e) }); return false; }
  }, []);

  // ----- News -----
  const refreshNews = React.useCallback(async () => {
    setNewsRefreshing(true);
    try {
      const r = await api<{ items: NewsItem[]; refresh?: { ok: boolean; added: number; checked: number; error?: string } }>("/api/home/news?refresh=1", { cache: "no-store" });
      setData((d) => {
        const known = new Set(d.news.map((n) => n.id));
        const fresh = r.items.filter((n) => !known.has(n.id)).map((n) => n.id);
        if (fresh.length) setNewNewsIds(new Set(fresh));
        return { ...d, news: r.items };
      });
      if (r.refresh?.ok) toast.success(r.refresh.added ? `${r.refresh.added} new Federal Register item${r.refresh.added === 1 ? "" : "s"}` : "News is up to date", { description: r.refresh.added ? "Added to your feed." : undefined });
      else toast.message("Live sources unavailable", { description: r.refresh?.error ? `Federal Register: ${r.refresh.error}` : "Showing the curated feed." });
    } catch (e) { toast.error("Refresh failed", { description: errMessage(e) }); }
    finally { setNewsRefreshing(false); }
  }, []);

  const saveNews = React.useCallback(async (id: string) => {
    try {
      const r = await api<{ href: string }>(`/api/home/news/${id}/save`, { method: "POST" });
      return r.href;
    } catch (e) { toast.error("Could not save to library", { description: errMessage(e) }); return null; }
  }, []);

  // ----- Brief -----
  const regenerateBrief = React.useCallback(async (mode: "ai" | "computed" = "ai") => {
    setBriefLoading(true);
    try {
      const r = await api<{ brief: DailyBrief }>("/api/home/brief", { method: "POST", json: { mode } });
      setData((d) => ({ ...d, brief: r.brief }));
      if (mode === "ai") toast.success("Daily brief regenerated", { description: r.brief.model ? `Model: ${r.brief.model}` : undefined });
    } catch (e) {
      const err = e as ApiError;
      const payload = err.payload as { brief?: DailyBrief } | undefined;
      if (payload?.brief) setData((d) => ({ ...d, brief: payload.brief! }));
      if (err.code === "no_api_key") toast.warning("No model provider configured", { description: "Connect a model provider in Settings to generate an AI brief. Showing the computed brief instead." });
      else toast.error("Brief generation failed", { description: errMessage(e) });
    } finally { setBriefLoading(false); }
  }, []);

  const value = React.useMemo<HomeContextValue>(() => ({
    now,
    userId: data.userId,
    userName: data.userName,
    aiConfigured: data.aiConfigured,
    intelInsights: data.intelInsights ?? false,
    setup: data.setup ?? { matters: data.matters.length, documents: 0, people: data.people.length },
    people: data.people,
    matters: data.matters,
    personById,
    matterById,
    matterFilter,
    setMatterFilter: setActiveMatterId,
    tasks: data.tasks,
    events: data.events,
    news: data.news,
    updates: data.updates,
    matterOverview: data.matterOverview,
    brief: data.brief,
    briefLoading,
    newsRefreshing,
    newNewsIds,
    refreshing,
    refresh,
    createTask,
    updateTask,
    deleteTask,
    createEvent,
    updateEvent,
    deleteEvent,
    postUpdate,
    react,
    reply,
    deleteUpdate,
    refreshNews,
    saveNews,
    regenerateBrief,
  }), [now, data, personById, matterById, matterFilter, setActiveMatterId, briefLoading, newsRefreshing, newNewsIds, refreshing, refresh, createTask, updateTask, deleteTask, createEvent, updateEvent, deleteEvent, postUpdate, react, reply, deleteUpdate, refreshNews, saveNews, regenerateBrief]);

  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}
