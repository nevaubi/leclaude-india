"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, PanelLeftOpen, PanelRightOpen, Scale, Search as SearchIcon, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { TopbarSlot } from "@/components/shell/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { SegmentedControl } from "@/components/ui/form";
import { useShortcutHelp, type ShortcutGroup } from "@/components/ui/shortcut-help";
import type { Matter } from "@/lib/types/domain";
import { jurisdictionByKey } from "../jurisdictions";
import { formatBluebook } from "../normalize";
import { extractTerms } from "../query-builder";
import type { SavedSearch, SearchHit, SearchRun, SearchSettings } from "../types";
import type { ResearchSource, ResearchThread } from "../engine/types";
import { annotateAnswer } from "../engine/trust";
import { useSearchStore } from "./store";
import { useResearch } from "./use-research";
import { ResearchProvider, type ReaderFocus, type ResearchActions } from "./research-context";
import { Conversation } from "./conversation";
import { ResearchComposer } from "./composer";
import { RightPanel } from "./right-panel";
import { ThreadRail, type ThreadSummary } from "./thread-rail";
import { ReaderDrawer } from "./reader-drawer";
import { CiteChecker } from "./citecheck";
import { searchUrl, urlAction } from "./url-sync";

export interface ResearchPageProps {
  initialQuery?: string;
  initialTool?: string;
  initialThreadId?: string;
  saved: SavedSearch[];
  runs: SearchRun[];
  threads: ThreadSummary[];
  matters: Pick<Matter, "id" | "shortName" | "name" | "caption">[];
  aiConfigured: boolean;
  userName: string;
}

/** Example questions, in the UI language (catalogue keys research.example.1–5). */
const EXAMPLE_KEYS = ["research.example.1", "research.example.2", "research.example.3", "research.example.4", "research.example.5"] as const;

type Tool = "research" | "citecheck";

const SEARCH_SHORTCUTS: ShortcutGroup[] = [
  { id: "search", title: "Research", titleKey: "research.shortcuts.group", items: [
    { keys: ["/"], label: "Focus the question", labelKey: "research.shortcuts.focus" }, { keys: ["enter"], label: "Ask", labelKey: "research.shortcuts.ask" }, { keys: ["shift+enter"], label: "New line", labelKey: "research.shortcuts.newLine" }, { keys: ["["], label: "Toggle threads", labelKey: "research.shortcuts.threads" }, { keys: ["]"], label: "Toggle the research panel", labelKey: "research.shortcuts.panel" }, { keys: ["esc"], label: "Stop the run", labelKey: "research.shortcuts.stop" },
  ] },
];

export function ResearchPage(props: ResearchPageProps) {
  const router = useRouter();
  const t = useT();
  const params = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const urlThread = params.get("thread") ?? props.initialThreadId ?? "";
  const urlTool = params.get("tool") ?? props.initialTool ?? "";

  // ---- persisted UI state ----
  const hydrated = useSearchStore((s) => s.hydrated);
  const settings = useSearchStore((s) => s.settings);
  const pins = useSearchStore((s) => s.pins);
  const panelOpen = useSearchStore((s) => s.panelOpen);
  const railOpen = useSearchStore((s) => s.railOpen);
  const recentQueries = useSearchStore((s) => s.recentQueries);
  const { setSettings, replaceSettings, toggleSource, pinSource, pinPassage, replacePins, pushRecentQuery, setPanelOpen, setRailOpen, setPanelTab, setHydrated } = useSearchStore.getState();
  React.useEffect(() => { void useSearchStore.persist.rehydrate(); setHydrated(true); }, [setHydrated]);

  // ---- page state ----
  const [query, setQuery] = React.useState(props.initialQuery ?? urlQ);
  const [tool, setTool] = React.useState<Tool>(urlTool === "citecheck" ? "citecheck" : "research");
  const [saved, setSaved] = React.useState<SavedSearch[]>(props.saved);
  const [runs, setRuns] = React.useState<SearchRun[]>(props.runs);
  const [threads, setThreads] = React.useState<ThreadSummary[]>(props.threads);
  const [readerHit, setReaderHit] = React.useState<SearchHit | null>(null);
  const [readerOpen, setReaderOpen] = React.useState(false);
  const [hoverN, setHoverN] = React.useState<number | null>(null);
  const [hoverSourceId, setHoverSourceId] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  useShortcutHelp(SEARCH_SHORTCUTS, "search");

  const refresh = React.useCallback(async () => {
    try {
      const [r1, r2, r3] = await Promise.all([fetch("/api/search/threads?limit=40"), fetch("/api/search/saved"), fetch("/api/search/history?limit=30&full=1")]);
      if (r1.ok) setThreads(((await r1.json()) as { threads: ThreadSummary[] }).threads);
      if (r2.ok) setSaved(((await r2.json()) as { saved: SavedSearch[] }).saved);
      if (r3.ok) setRuns(((await r3.json()) as { runs: SearchRun[] }).runs);
    } catch { /* offline */ }
  }, []);

  // URL sync. `handledQ` / `handledThread` remember what this page already ran or opened, because
  // useSearchParams lags history.replaceState by a render: without them, opening a thread right after
  // a composer question re-ran that question into a fresh (duplicate) thread.
  const handledQRef = React.useRef<string | null>(null);
  const handledThreadRef = React.useRef<string | null>(null);
  const setUrl = React.useCallback((next: { q?: string | null; thread?: string | null; tool?: Tool }) => {
    if (next.q) handledQRef.current = next.q;
    if (next.thread) handledThreadRef.current = next.thread;
    try { window.history.replaceState(null, "", searchUrl(next)); } catch { /* ignore */ }
  }, []);

  const research = useResearch({
    // Once a run has a thread, the URL points at the thread so a reload reopens it instead of re-running the question.
    // Failures render inline as a proper state (no toast); the terminal state is on the turn itself.
    onRunDone: (r) => { if (r.threadId) setUrl({ thread: r.threadId }); void refresh(); },
  });
  const { state, sourceList } = research;
  const streaming = research.streaming;

  // ---- pins ↔ thread sync (debounced) ----
  const pinsSyncRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (!state.threadId || !hydrated) return;
    if (pinsSyncRef.current) clearTimeout(pinsSyncRef.current);
    pinsSyncRef.current = setTimeout(() => { void fetch(`/api/search/threads/${state.threadId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pins }) }).catch(() => {}); }, 800);
    return () => { if (pinsSyncRef.current) clearTimeout(pinsSyncRef.current); };
  }, [pins, state.threadId, hydrated]);

  // ---- actions ----
  const ask = React.useCallback((q: string | undefined, override?: SearchSettings, extra: { savedSearchId?: string; newThread?: boolean } = {}) => {
    const text = (q ?? query).trim();
    if (!text) { inputRef.current?.focus(); return; }
    const s = override ?? useSearchStore.getState().settings;
    pushRecentQuery(text);
    setQuery("");
    setTool("research");
    if (extra.newThread) setPanelTab("live");
    const savedMatch = extra.savedSearchId ?? saved.find((x) => x.query.trim() === text)?.id;
    void research.ask(text, s, { savedSearchId: savedMatch, newThread: extra.newThread });
    setUrl({ q: text });
  }, [query, saved, research, pushRecentQuery, setPanelTab, setUrl]);
  const askRef = React.useRef(ask);
  askRef.current = ask;

  const openThread = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/search/threads/${id}`);
      if (res.status === 403 || res.status === 401) {
        // Permission denied is a state of the page, not a toast: the server refused this thread.
        let msg = t("research.threadDenied");
        try { const j = (await res.json()) as { error?: string }; if (j.error) msg = j.error; } catch { /* keep default */ }
        research.deny(msg, res.status);
        setTool("research");
        setUrl({ thread: id });
        return;
      }
      if (!res.ok) throw new Error(res.status === 404 ? t("research.threadGone") : res.statusText);
      const { thread } = (await res.json()) as { thread: ResearchThread };
      replaceSettings(thread.settings);
      replacePins(thread.pins ?? []);
      research.loadThread(thread);
      setTool("research");
      setUrl({ thread: thread.id });
    } catch (e) { toast.error(t("research.toast.openThreadFailed"), { description: e instanceof Error ? e.message : String(e) }); }
  }, [replaceSettings, replacePins, research, setUrl, t]);
  const openThreadRef = React.useRef(openThread);
  openThreadRef.current = openThread;

  React.useEffect(() => {
    // useSearchParams is the trigger, but window.location is the truth: the params lag one render behind
    // history.replaceState, and acting on the lagging values re-opened the previous thread (ping-pong).
    let q = urlQ, thread = urlThread;
    try { const loc = new URLSearchParams(window.location.search); q = loc.get("q") ?? ""; thread = loc.get("thread") ?? ""; } catch { /* SSR */ }
    const action = urlAction({ hydrated, tool, urlQ: q, urlThread: thread, handledQ: handledQRef.current, handledThread: handledThreadRef.current, activeThreadId: state.threadId });
    if (action.type === "openThread") { handledThreadRef.current = action.id; void openThreadRef.current(action.id); }
    else if (action.type === "ask") { handledQRef.current = action.q; askRef.current(action.q, undefined, { newThread: true }); }
  }, [hydrated, urlQ, urlThread, tool, state.threadId]);

  const newThread = React.useCallback(() => { research.reset(); replacePins([]); setQuery(""); setTool("research"); setUrl({}); inputRef.current?.focus(); }, [research, replacePins, setUrl]);

  const copyCite = React.useCallback((hit: SearchHit) => {
    const cite = formatBluebook(hit);
    navigator.clipboard.writeText(cite).then(() => toast.success(t("research.toast.citationCopied"), { description: cite })).catch(() => toast.error(t("research.toast.clipboard")));
  }, [t]);
  const saveToLibrary = React.useCallback(async (hit: SearchHit) => {
    try {
      const res = await fetch("/api/search/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hit, matterId: useSearchStore.getState().settings.matterId }) });
      const j = (await res.json()) as { item?: { id: string }; error?: string };
      if (!res.ok || !j.item) throw new Error(j.error ?? res.statusText);
      toast.success(t("research.toast.savedLibrary"), { description: t("research.toast.savedLibraryDesc"), action: { label: t("common.open"), onClick: () => router.push(`/library?item=${j.item!.id}`) } });
    } catch (e) { toast.error(t("research.toast.saveLibraryFailed"), { description: e instanceof Error ? e.message : String(e) }); }
  }, [router, t]);
  const [readerFocus, setReaderFocus] = React.useState<ReaderFocus | null>(null);
  const openSource = React.useCallback((s: ResearchSource | SearchHit, focus?: ReaderFocus) => { const hit = "hit" in s ? s.hit : s; setReaderHit(hit); setReaderFocus(focus ?? null); setReaderOpen(true); }, []);
  const pinSourceAction = React.useCallback((s: ResearchSource) => {
    const r = pinSource(s.hit, s.id);
    if (r === "exists") { toast.info(t("research.toast.alreadyPinned")); return; }
    toast.success(t("research.toast.pinned"), { action: { label: t("research.toast.openPins"), onClick: () => { setPanelOpen(true); setPanelTab("pins"); } } });
  }, [pinSource, setPanelOpen, setPanelTab, t]);
  const pinPassageAction = React.useCallback((text: string, sourceId?: string) => {
    const src = sourceId ? state.sources[sourceId] : undefined;
    pinPassage(text, { sourceId, hit: src?.hit });
    toast.success(t("research.toast.passagePinned"), { action: { label: t("research.toast.openPins"), onClick: () => { setPanelOpen(true); setPanelTab("pins"); } } });
  }, [pinPassage, state.sources, setPanelOpen, setPanelTab, t]);

  const runSaved = React.useCallback((s: SavedSearch) => { replaceSettings(s.settings); ask(s.query, s.settings, { savedSearchId: s.id, newThread: true }); }, [replaceSettings, ask]);
  const openRun = React.useCallback((r: SearchRun) => { if (r.threadId) { void openThread(r.threadId); return; } replaceSettings(r.settings); research.loadRun(r); setTool("research"); setUrl({}); }, [openThread, replaceSettings, research, setUrl]);
  const togglePin = async (s: SavedSearch) => { await fetch(`/api/search/saved/${s.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: !s.pinned }) }); void refresh(); };
  const deleteSaved = async (s: SavedSearch) => { await fetch(`/api/search/saved/${s.id}`, { method: "DELETE" }); toast.success(t("research.toast.savedDeleted")); void refresh(); };
  const deleteThread = async (id: string) => { await fetch(`/api/search/threads/${id}`, { method: "DELETE" }); if (id === state.threadId) newThread(); void refresh(); };
  const saveSearch = async (name: string) => {
    const lastQ = [...state.messages].reverse().find((m) => m.role === "user")?.content ?? query;
    try {
      const res = await fetch("/api/search/saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, query: lastQ, settings }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
      toast.success(t("research.toast.searchSaved"));
      void refresh();
    } catch (e) { toast.error(t("research.toast.saveSearchFailed"), { description: e instanceof Error ? e.message : String(e) }); }
  };
  const switchTool = (t: Tool) => { setTool(t); setUrl({ tool: t, thread: state.threadId }); };

  // ---- keyboard: / focus, [ rail, ] panel, Esc stop ----
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" && !typing) { e.preventDefault(); inputRef.current?.focus(); return; }
      if (typing) return;
      if (e.key === "]") { e.preventDefault(); setPanelOpen(!useSearchStore.getState().panelOpen); }
      if (e.key === "[") { e.preventDefault(); setRailOpen(!useSearchStore.getState().railOpen); }
      if (e.key === "Escape" && streaming) research.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPanelOpen, setRailOpen, streaming, research]);

  const currentMatter = React.useMemo(() => props.matters.find((m) => m.id === settings.matterId) ?? null, [props.matters, settings.matterId]);
  const jurisdictionLabel = jurisdictionByKey(settings.jurisdiction).label;
  const lastAssistant = React.useMemo(() => [...state.messages].reverse().find((m) => m.role === "assistant"), [state.messages]);
  const lastQuestion = state.pending?.question ?? [...state.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const verdicts = state.pending?.verification?.verdicts ?? lastAssistant?.verification?.verdicts ?? [];
  const terms = React.useMemo(() => extractTerms(lastQuestion || query), [lastQuestion, query]);
  const pinnedIds = React.useMemo(() => new Set(pins.filter((p) => p.kind === "source").map((p) => p.sourceId)), [pins]);
  const lanes = React.useMemo(() => state.laneOrder.map((id) => state.lanes[id]).filter(Boolean), [state.laneOrder, state.lanes]);
  const shownAnswer = React.useMemo(() => (lastAssistant ? annotateAnswer(lastAssistant, sourceList) : ""), [lastAssistant, sourceList]);
  const trustContext = React.useMemo(() => (state.pending ? { artifactHash: state.pending.artifactHash, verification: state.pending.verification } : { artifactHash: lastAssistant?.artifactHash, verification: lastAssistant?.verification }), [state.pending, lastAssistant]);
  const retry = React.useCallback((q?: string) => { const text = (q ?? state.lastQuestion ?? "").trim(); if (text) ask(text); }, [ask, state.lastQuestion]);

  const actions: ResearchActions = React.useMemo(() => ({
    sources: state.sources,
    trustContext,
    retry,
    sourceByN: (n) => sourceList.find((s) => s.n === n),
    hoverN, setHoverN, hoverSourceId, setHoverSourceId,
    openSource, copyCite, pinSource: pinSourceAction, pinPassage: pinPassageAction, saveToLibrary,
    isPinned: (id) => pinnedIds.has(id),
    askFollowUp: (q) => ask(q),
  }), [state.sources, trustContext, retry, sourceList, hoverN, hoverSourceId, openSource, copyCite, pinSourceAction, pinPassageAction, saveToLibrary, pinnedIds, ask]);

  const hasConversation = state.messages.length > 0 || state.pending != null;

  const topbar = (
    <TopbarSlot>
      <SearchIcon className="size-4 text-muted-foreground" />
      <button onClick={newThread} className="shrink-0 text-[13px] font-semibold hover:text-primary cursor-pointer">{t("research.title")}</button>
      {tool === "citecheck" ? (
        <><ChevronRight className="size-3.5 text-muted-foreground rtl:rotate-180" /><span className="text-[12.5px] text-muted-foreground">{t("research.citationChecker")}</span></>
      ) : state.threadTitle ? (
        <><ChevronRight className="size-3.5 text-muted-foreground rtl:rotate-180" /><span className="max-w-[28vw] truncate text-[12.5px] text-muted-foreground" title={state.threadTitle}>{state.threadTitle}</span>{streaming && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}</>
      ) : null}
      <SegmentedControl size="xs" className="ms-2 hidden md:inline-flex" ariaLabel={t("research.toolAria")} value={tool} onChange={(v) => switchTool(v)} options={[{ value: "research", label: t("research.title"), icon: Scale }, { value: "citecheck", label: t("research.citationChecker"), icon: ShieldCheck }]} />
      <div className="flex-1" />
      {currentMatter && <Tip label={currentMatter.caption ?? currentMatter.name}><Badge variant="outline" size="sm" className="hidden shrink-0 xl:inline-flex">{currentMatter.shortName}</Badge></Tip>}
      {!railOpen && <Tip label={t("research.showThreads")} shortcut="["><Button variant="ghost" size="icon-xs" onClick={() => setRailOpen(true)} aria-label={t("research.showThreads")}><PanelLeftOpen className="size-4" /></Button></Tip>}
      {!panelOpen && tool === "research" && <Tip label={t("research.showPanel")} shortcut="]"><Button variant="ghost" size="icon-xs" onClick={() => setPanelOpen(true)} aria-label={t("research.showPanel")}><PanelRightOpen className="size-4" /></Button></Tip>}
    </TopbarSlot>
  );

  const emptyState = (
    <div className="mx-auto flex h-full w-full max-w-[760px] flex-col justify-center px-6 py-10">
      <div className="mb-1 text-[11.5px] font-medium text-muted-foreground">{t("research.eyebrow")}</div>
      <h1 className="text-[20px] font-semibold tracking-tight">{t("research.heading")}</h1>
      <p className="mt-1 max-w-xl text-[12.5px] text-muted-foreground">{t("research.intro")}</p>
      <div className="mt-6 flex flex-wrap gap-1.5">
        {(recentQueries.length ? recentQueries.slice(0, 2) : []).concat(EXAMPLE_KEYS.map((k) => t(k))).slice(0, 6).map((ex) => (
          <button key={ex} onClick={() => ask(ex, undefined, { newThread: true })} className="max-w-full truncate rounded-md border bg-card px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground cursor-pointer" title={ex}>{ex}</button>
        ))}
      </div>
    </div>
  );

  return (
    <ResearchProvider value={actions}>
      <div className="flex h-full min-h-0 bg-background" data-owns-bracket-left>
        {topbar}
        {hydrated && railOpen && (
          <div className="hidden w-[248px] shrink-0 lg:block">
            <ThreadRail threads={threads} runs={runs} saved={saved} matters={props.matters} activeThreadId={state.threadId} onNew={newThread} onOpenThread={(id) => void openThread(id)} onOpenRun={openRun} onRunSaved={runSaved} onDeleteThread={(id) => void deleteThread(id)} onDeleteSaved={(s) => void deleteSaved(s)} onTogglePin={(s) => void togglePin(s)} onClose={() => setRailOpen(false)} />
          </div>
        )}

        {tool === "citecheck" ? (
          <div className="min-w-0 flex-1"><CiteChecker matterId={settings.matterId} /></div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <Conversation state={state} sources={sourceList} userName={props.userName} matter={currentMatter} aiConfigured={props.aiConfigured} onSaveSearch={saveSearch} onStop={research.stop} onRetry={(q) => retry(q)} onNewThread={newThread} emptyState={emptyState} />
            <div className="shrink-0 px-4 pb-4 pt-2">
              <div className="mx-auto w-full max-w-[760px]">
                <ResearchComposer
                  value={query}
                  onChange={setQuery}
                  onSubmit={() => ask(undefined, undefined, { newThread: !hasConversation })}
                  settings={settings}
                  setSettings={setSettings}
                  toggleSource={toggleSource}
                  matters={props.matters}
                  streaming={streaming}
                  onStop={research.stop}
                  onToggleLanes={() => setPanelOpen(!panelOpen)}
                  lanesOpen={panelOpen}
                  autoFocus={!hasConversation}
                  inputRef={inputRef}
                  placeholder={hasConversation ? t("research.followUp") : undefined}
                />
                <div className="mt-1.5 flex items-center justify-between px-1 text-[10.5px] text-muted-foreground">
                  <span className="truncate">{t("research.hint")}</span>
                  <span className="hidden truncate sm:inline">{settings.fast ? t("research.fastNote") : t("research.fullNote")}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {hydrated && panelOpen && tool === "research" && (
          <div className="hidden w-[380px] shrink-0 border-l md:block xl:w-[420px]">
            <RightPanel lanes={lanes} sources={sourceList} sourceMap={state.sources} verdicts={verdicts} streaming={streaming} question={lastQuestion} answer={shownAnswer} jurisdictionLabel={jurisdictionLabel} matter={currentMatter ? { id: currentMatter.id, name: currentMatter.name, caption: currentMatter.caption } : null} userName={props.userName} onClose={() => setPanelOpen(false)} />
          </div>
        )}

        <ReaderDrawer hit={readerHit} focus={readerFocus} open={readerOpen} onOpenChange={setReaderOpen} onCite={copyCite} onPin={(hit) => { const s = sourceList.find((x) => x.hit.id === hit.id); pinSourceAction(s ?? { id: hit.id, kind: hit.source, title: hit.title, cite: hit.cite, url: hit.url, read: false, laneIds: [], hit, scope: "authority", foundAt: Date.now() }); }} onPinPassage={(text, hit) => pinPassageAction(text, sourceList.find((x) => x.hit.id === hit.id)?.id)} onSave={saveToLibrary} pinned={readerHit ? pinnedIds.has(sourceList.find((x) => x.hit.id === readerHit.id)?.id ?? readerHit.id) : false} aiConfigured={props.aiConfigured} terms={terms} />
      </div>
    </ResearchProvider>
  );
}
