"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GroupBy, SavedView, SearchFilters, SortKey } from "../types";

export type Density = "compact" | "comfortable";
export type ViewerTab = "text" | "image" | "metadata" | "family" | "similar" | "suggested" | "history";

export interface ColumnDef { id: string; label: string; width: number; min: number; sort?: SortKey; align?: "left" | "right"; defaultHidden?: boolean; locked?: boolean }

/** Review grid columns (Everlaw-style standard metadata). Hidden-by-default columns come back through the column chooser. */
export const DEFAULT_COLUMNS: ColumnDef[] = [
  // Indian record: the document reference (production / list number) plus the exhibit mark once marked in evidence.
  { id: "bates", label: "Doc. ref.", width: 112, min: 90, sort: "bates", locked: true },
  { id: "exhibit", label: "Exhibit", width: 84, min: 64, sort: "exhibit" },
  { id: "record", label: "Record", width: 112, min: 80 },
  { id: "batesEnd", label: "Doc. ref. end", width: 110, min: 90, defaultHidden: true },
  { id: "family", label: "Family", width: 64, min: 52, sort: "family" },
  { id: "thread", label: "Thread", width: 64, min: 52, sort: "thread", defaultHidden: true },
  { id: "dupes", label: "Dupes", width: 60, min: 48, defaultHidden: true },
  { id: "custodian", label: "Source", width: 150, min: 90, sort: "custodian" },
  { id: "date", label: "Date sent / created", width: 100, min: 84, sort: "date" },
  { id: "from", label: "From", width: 120, min: 90, sort: "from", defaultHidden: true },
  { id: "to", label: "To", width: 140, min: 90, defaultHidden: true },
  { id: "cc", label: "Cc", width: 120, min: 90, defaultHidden: true },
  { id: "subject", label: "Subject", width: 360, min: 160, sort: "subject" },
  { id: "type", label: "Type", width: 88, min: 64, sort: "type" },
  { id: "size", label: "Size", width: 64, min: 52, sort: "size", align: "right", defaultHidden: true },
  { id: "pages", label: "Pages", width: 56, min: 48, sort: "pages", align: "right" },
  { id: "decision", label: "Decision", width: 96, min: 84 },
  { id: "issues", label: "Issues", width: 150, min: 90 },
  { id: "suggested", label: "Suggested", width: 96, min: 80, sort: "aiScore", align: "right" },
  { id: "reviewer", label: "Reviewer", width: 110, min: 80, defaultHidden: true },
  { id: "reviewed", label: "Reviewed", width: 110, min: 84, sort: "reviewed", defaultHidden: true },
  { id: "redactions", label: "Redactions", width: 72, min: 56, align: "right", defaultHidden: true },
];

export const DEFAULT_HIDDEN = DEFAULT_COLUMNS.filter((c) => c.defaultHidden).map((c) => c.id);

interface ReviewState {
  // query
  q: string;
  semantic: boolean;
  view: SavedView;
  filters: SearchFilters;
  sort: SortKey | undefined;
  dir: "asc" | "desc" | undefined;
  setQ: (q: string) => void;
  setSemantic: (v: boolean) => void;
  setView: (v: SavedView) => void;
  toggleFilter: (key: keyof SearchFilters, value: string) => void;
  setFilters: (filters: SearchFilters) => void;
  clearFilters: () => void;
  setSort: (sort: SortKey) => void;
  setSortState: (sort: SortKey | undefined, dir: "asc" | "desc" | undefined) => void;
  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  /** Batch review mode: only the batch's documents (or its QC sample) are listed. */
  batchId: string | null;
  qcMode: boolean;
  setBatch: (id: string | null, qc?: boolean) => void;
  // selection / cursor
  selected: string[];
  setSelected: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  lastClickedId: string | null;
  setLastClickedId: (id: string | null) => void;
  // viewer
  openDocId: string | null;
  setOpenDocId: (id: string | null) => void;
  fullscreen: boolean;
  setFullscreen: (v: boolean) => void;
  viewerTab: ViewerTab;
  setViewerTab: (t: ViewerTab) => void;
  codingPanelOpen: boolean;
  setCodingPanelOpen: (v: boolean) => void;
  /** Redaction mode in the viewer: text selection and page drags create redactions. */
  redactMode: boolean;
  setRedactMode: (v: boolean) => void;
  /** Character offset the Text tab should scroll to and flash (verified quote click). */
  jumpTo: { start: number; end: number; nonce: number } | null;
  setJumpTo: (start: number, end: number) => void;
  // preferences (persisted)
  density: Density;
  setDensity: (d: Density) => void;
  columnWidths: Record<string, number>;
  setColumnWidth: (id: string, w: number) => void;
  setColumnWidths: (w: Record<string, number>) => void;
  hiddenColumns: string[];
  setHiddenColumns: (ids: string[]) => void;
  /** Id of the saved layout currently applied (null = ad hoc). */
  layoutId: string | null;
  setLayoutId: (id: string | null) => void;
  applyLayout: (layout: { id: string; hiddenColumns: string[]; columnWidths: Record<string, number>; density: Density }) => void;
  resetLayout: () => void;
  autoAdvance: boolean;
  setAutoAdvance: (v: boolean) => void;
  railCollapsed: boolean;
  setRailCollapsed: (v: boolean) => void;
  chartsOpen: boolean;
  setChartsOpen: (v: boolean) => void;
  /** Incremented to ask the review list to refetch (facets, AI scores) without changing the query. */
  listTick: number;
  bumpList: () => void;
  reset: () => void;
}

export const useReviewStore = create<ReviewState>()(
  persist(
    (set, get) => ({
      q: "",
      semantic: false,
      view: "all",
      filters: {},
      sort: undefined,
      dir: undefined,
      setQ: (q) => set({ q }),
      setSemantic: (semantic) => set({ semantic, sort: semantic ? "relevance" : get().sort === "relevance" ? undefined : get().sort }),
      setView: (view) => set({ view, selected: [] }),
      toggleFilter: (key, value) =>
        set((s) => {
          const cur = (s.filters[key] as string[] | undefined) ?? [];
          const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
          const filters = { ...s.filters, [key]: next };
          if (!next.length) delete (filters as Record<string, unknown>)[key];
          return { filters, selected: [] };
        }),
      setFilters: (filters) => set({ filters, selected: [] }),
      clearFilters: () => set({ filters: {}, selected: [] }),
      setSort: (sort) =>
        set((s) => {
          if (s.sort === sort) return { dir: (s.dir ?? (sort === "aiScore" || sort === "relevance" ? "desc" : "asc")) === "asc" ? "desc" : "asc" };
          return { sort, dir: sort === "aiScore" || sort === "relevance" ? "desc" : "asc" };
        }),
      setSortState: (sort, dir) => set({ sort, dir }),
      groupBy: "none",
      setGroupBy: (groupBy) => set({ groupBy }),
      batchId: null,
      qcMode: false,
      setBatch: (batchId, qc = false) => set({ batchId, qcMode: batchId ? qc : false, selected: [], view: "all", filters: {}, q: "" }),
      selected: [],
      setSelected: (selected) => set({ selected }),
      toggleSelected: (id) => set((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] })),
      activeId: null,
      setActiveId: (activeId) => set({ activeId }),
      lastClickedId: null,
      setLastClickedId: (lastClickedId) => set({ lastClickedId }),
      openDocId: null,
      setOpenDocId: (openDocId) => set({ openDocId, activeId: openDocId ?? get().activeId, jumpTo: null }),
      fullscreen: false,
      setFullscreen: (fullscreen) => set({ fullscreen }),
      viewerTab: "text",
      setViewerTab: (viewerTab) => set({ viewerTab }),
      codingPanelOpen: true,
      setCodingPanelOpen: (codingPanelOpen) => set({ codingPanelOpen }),
      redactMode: false,
      setRedactMode: (redactMode) => set({ redactMode }),
      jumpTo: null,
      setJumpTo: (start, end) => set((s) => ({ jumpTo: { start, end, nonce: (s.jumpTo?.nonce ?? 0) + 1 }, viewerTab: "text" })),
      density: "compact",
      setDensity: (density) => set({ density, layoutId: null }),
      columnWidths: {},
      setColumnWidth: (id, w) => set((s) => ({ columnWidths: { ...s.columnWidths, [id]: w }, layoutId: null })),
      setColumnWidths: (columnWidths) => set({ columnWidths, layoutId: null }),
      hiddenColumns: DEFAULT_HIDDEN,
      setHiddenColumns: (hiddenColumns) => set({ hiddenColumns, layoutId: null }),
      layoutId: null,
      setLayoutId: (layoutId) => set({ layoutId }),
      applyLayout: (l) => set({ layoutId: l.id, hiddenColumns: [...l.hiddenColumns], columnWidths: { ...l.columnWidths }, density: l.density }),
      resetLayout: () => set({ layoutId: null, hiddenColumns: DEFAULT_HIDDEN, columnWidths: {}, density: "compact" }),
      autoAdvance: true,
      setAutoAdvance: (autoAdvance) => set({ autoAdvance }),
      railCollapsed: false,
      setRailCollapsed: (railCollapsed) => set({ railCollapsed }),
      chartsOpen: false,
      setChartsOpen: (chartsOpen) => set({ chartsOpen }),
      listTick: 0,
      bumpList: () => set((s) => ({ listTick: s.listTick + 1 })),
      reset: () => set({ q: "", semantic: false, view: "all", filters: {}, sort: undefined, dir: undefined, selected: [], activeId: null, openDocId: null, batchId: null, qcMode: false, groupBy: "none", redactMode: false, jumpTo: null }),
    }),
    { name: "leclaude:ediscovery:review", version: 4, migrate: (persisted, version) => { const p = (persisted ?? {}) as Record<string, unknown>; if (version < 4) p.chartsOpen = false; return p as never; }, partialize: (s) => ({ density: s.density, columnWidths: s.columnWidths, hiddenColumns: s.hiddenColumns, layoutId: s.layoutId, autoAdvance: s.autoAdvance, codingPanelOpen: s.codingPanelOpen, railCollapsed: s.railCollapsed, chartsOpen: s.chartsOpen }) },
  ),
);
