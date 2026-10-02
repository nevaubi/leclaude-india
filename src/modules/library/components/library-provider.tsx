"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { LibraryItemView, LibraryFilters, LibraryListResponse, LibrarySearchResponse, LibraryTreeResponse, LibraryView, CreateItemInput, UpdateItemInput } from "../types";
import { filtersToParams, parseFilters } from "../filters";
import { matterFolderId, matterIdFromFolderId } from "../ids";
import { api, downloadText } from "./api";
import { useLibraryUI } from "./store";
import { useUploads, type UploadResult } from "./use-uploads";

export type DialogState =
  | { kind: "folder" | "note" | "clause" | "link"; parentId: string | null }
  | { kind: "move"; ids: string[] }
  | { kind: "delete"; ids: string[] }
  | { kind: "shortcuts" }
  | null;

export interface LibraryActions {
  rename: (id: string, name: string) => Promise<void>;
  move: (ids: string[], parentId: string | null) => Promise<boolean>;
  star: (id: string, starred: boolean) => Promise<void>;
  remove: (ids: string[]) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
  update: (id: string, patch: UpdateItemInput, opts?: { silent?: boolean }) => Promise<LibraryItemView | null>;
  create: (input: CreateItemInput) => Promise<LibraryItemView | null>;
  upload: (files: File[] | FileList, target?: { folderId?: string | null; matterId?: string | null }) => Promise<UploadResult[]>;
  rebuildIndex: () => Promise<void>;
  download: (item: LibraryItemView) => Promise<void>;
}

export interface LibraryContextValue {
  filters: LibraryFilters;
  setFilters: (patch: Partial<LibraryFilters>, opts?: { replace?: boolean }) => void;
  folderId: string | null;
  view: LibraryView;
  currentMatterId: string | null;
  tree: LibraryTreeResponse | null;
  refreshTree: () => Promise<void>;
  list: LibraryListResponse | null;
  listLoading: boolean;
  refreshList: () => Promise<void>;
  search: LibrarySearchResponse | null;
  searchLoading: boolean;
  isSearching: boolean;
  items: LibraryItemView[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  toggleSelected: (id: string, opts?: { additive?: boolean; range?: boolean }) => void;
  selectAll: () => void;
  clearSelection: () => void;
  previewId: string | null;
  openPreview: (id: string | null) => void;
  openItem: (item: LibraryItemView, opts?: { newTab?: boolean }) => void;
  openFolder: (id: string | null) => void;
  openView: (view: LibraryView) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  dialog: DialogState;
  openDialog: (d: DialogState) => void;
  closeDialog: () => void;
  dragOverId: string | null;
  setDragOverId: (id: string | null) => void;
  dragging: boolean;
  setDragging: (v: boolean) => void;
  uploading: boolean;
  uploadProgress: { done: number; total: number; current?: string } | null;
  actions: LibraryActions;
  matters: LibraryTreeResponse["matters"];
  people: LibraryTreeResponse["people"];
  aiConfigured: boolean;
  itemById: (id: string) => LibraryItemView | undefined;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

const Ctx = React.createContext<LibraryContextValue | null>(null);

export function useLibrary() {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useLibrary must be used inside LibraryProvider");
  return v;
}

export interface LibraryInitialData { tree: LibraryTreeResponse; list: LibraryListResponse | null; aiConfigured: boolean }

export function LibraryProvider({ initial, children }: { initial: LibraryInitialData; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const filters = React.useMemo(() => parseFilters(new URLSearchParams(sp.toString())), [sp]);
  const previewId = sp.get("item");
  const folderId = filters.folder ?? null;
  const view = filters.view ?? "folder";
  const uiSort = useLibraryUI((s) => s.sort);
  const uiDir = useLibraryUI((s) => s.dir);

  const [tree, setTree] = React.useState<LibraryTreeResponse | null>(initial.tree);
  const [list, setList] = React.useState<LibraryListResponse | null>(initial.list);
  const [listLoading, setListLoading] = React.useState(false);
  const [search, setSearch] = React.useState<LibrarySearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<DialogState>(null);
  const [dragOverId, setDragOverId] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const lastClickRef = React.useRef<string | null>(null);
  const cacheRef = React.useRef(new Map<string, LibraryListResponse>());
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const listReq = React.useRef(0);
  const searchReq = React.useRef(0);

  // `?matter=<id>` with no folder/view opens the matter folder (links from Home use this form).
  React.useEffect(() => {
    if (filters.matterId && !filters.folder && (!filters.view || filters.view === "folder") && !filters.q) {
      const next = filtersToParams({ ...filters, matterId: undefined, folder: matterFolderId(filters.matterId) });
      if (previewId) next.set("item", previewId);
      router.replace(`${pathname}?${next.toString()}`);
    }
  }, [filters, previewId, pathname, router]);

  const navigate = React.useCallback((next: LibraryFilters, item?: string | null, mode: "push" | "replace" = "push") => {
    const params = filtersToParams(next);
    const itemId = item === undefined ? previewId : item;
    if (itemId) params.set("item", itemId);
    const qs = params.toString();
    const href = qs ? `${pathname}?${qs}` : pathname;
    if (mode === "replace") router.replace(href); else router.push(href);
  }, [pathname, router, previewId]);

  const setFilters = React.useCallback((patch: Partial<LibraryFilters>, opts?: { replace?: boolean }) => {
    const next: LibraryFilters = { ...filters, ...patch };
    // sort/dir live in the persisted UI store, not the URL, unless explicitly set.
    // Typing in the search box replaces the entry so Back leaves the library in one step.
    navigate(next, undefined, opts?.replace || ("q" in patch && Object.keys(patch).length === 1) ? "replace" : "push");
  }, [filters, navigate]);

  const effective = React.useMemo<LibraryFilters>(() => ({ ...filters, sort: filters.sort ?? uiSort, dir: filters.dir ?? uiDir }), [filters, uiSort, uiDir]);
  const listKey = React.useMemo(() => filtersToParams({ ...effective, q: undefined }).toString(), [effective]);

  const refreshTree = React.useCallback(async () => {
    try { setTree(await api<LibraryTreeResponse>("/api/library/tree")); } catch (e) { console.warn("[library] tree refresh failed", e); }
  }, []);

  const refreshList = React.useCallback(async () => {
    const id = ++listReq.current;
    const cached = cacheRef.current.get(listKey);
    if (cached) setList(cached); else setListLoading(true);
    try {
      const r = await api<LibraryListResponse>(`/api/library/items?${listKey}`);
      if (id !== listReq.current) return;
      cacheRef.current.set(listKey, r);
      setList(r);
    } catch (e) {
      if (id === listReq.current) toast.error("Could not load the folder", { description: (e as Error).message });
    } finally { if (id === listReq.current) setListLoading(false); }
  }, [listKey]);

  React.useEffect(() => { void refreshList(); }, [refreshList]);

  // Hybrid search when a query is present (debounced).
  const q = filters.q?.trim() ?? "";
  React.useEffect(() => {
    if (!q) { setSearch(null); setSearchLoading(false); return; }
    const id = ++searchReq.current;
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const params = filtersToParams({ ...effective, q: undefined, view: undefined });
        params.set("q", q);
        const r = await api<LibrarySearchResponse>(`/api/library/search?${params.toString()}`);
        if (id === searchReq.current) setSearch(r);
      } catch (e) {
        if (id === searchReq.current) toast.error("Search failed", { description: (e as Error).message });
      } finally { if (id === searchReq.current) setSearchLoading(false); }
    }, 180);
    return () => clearTimeout(t);
  }, [q, effective]);

  React.useEffect(() => { setSelected(new Set()); setRenamingId(null); }, [listKey, q]);

  const isSearching = q.length > 0;
  const items = React.useMemo(() => (isSearching ? (search?.hits ?? []).map((h) => h.item) : list?.items ?? []), [isSearching, search, list]);
  const itemById = React.useCallback((id: string) => items.find((i) => i.id === id), [items]);

  const invalidate = React.useCallback(async () => {
    cacheRef.current.clear();
    await Promise.all([refreshList(), refreshTree()]);
  }, [refreshList, refreshTree]);

  const currentMatterId = React.useMemo(() => {
    if (filters.matterId) return filters.matterId;
    if (list?.folder?.matterId) return list.folder.matterId;
    for (const seg of list?.breadcrumbs ?? []) { const m = matterIdFromFolderId(seg.id); if (m) return m; }
    return null;
  }, [filters.matterId, list]);

  const openPreview = React.useCallback((id: string | null) => {
    const params = new URLSearchParams(sp.toString());
    if (id) params.set("item", id); else params.delete("item");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [pathname, router, sp]);

  const openFolder = React.useCallback((id: string | null) => {
    navigate({ folder: id, view: "folder" }, null);
  }, [navigate]);

  const openView = React.useCallback((v: LibraryView) => {
    navigate({ view: v, folder: null }, null);
  }, [navigate]);

  const openItem = React.useCallback((item: LibraryItemView, opts: { newTab?: boolean } = {}) => {
    if (item.type === "folder") { openFolder(item.id); return; }
    if (item.officeDocId && item.officeKind) { const url = `/office/${item.officeKind}/${item.officeDocId}`; if (opts.newTab) window.open(url, "_blank"); else router.push(url); return; }
    if (item.type === "template" && item.url) { if (opts.newTab) window.open(item.url, "_blank"); else router.push(item.url); return; }
    if (item.type === "link" && item.url) { window.open(item.url, "_blank", "noopener"); return; }
    openPreview(item.id);
  }, [openFolder, openPreview, router]);

  const toggleSelected = React.useCallback((id: string, opts: { additive?: boolean; range?: boolean } = {}) => {
    setSelected((prev) => {
      const next = new Set(opts.additive || opts.range ? prev : []);
      if (opts.range && lastClickRef.current) {
        const ids = items.map((i) => i.id);
        const a = ids.indexOf(lastClickRef.current), b = ids.indexOf(id);
        if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]); return next; }
      }
      if (opts.additive && prev.has(id)) next.delete(id); else next.add(id);
      lastClickRef.current = id;
      return next;
    });
  }, [items]);

  const selectAll = React.useCallback(() => setSelected(new Set(items.map((i) => i.id))), [items]);
  const clearSelection = React.useCallback(() => setSelected(new Set()), []);

  const patchLocal = React.useCallback((id: string, patch: Partial<LibraryItemView>) => {
    setList((l) => (l ? { ...l, items: l.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) } : l));
    setSearch((s) => (s ? { ...s, hits: s.hits.map((h) => (h.item.id === id ? { ...h, item: { ...h.item, ...patch } } : h)) } : s));
  }, []);

  const uploads = useUploads({ onDone: invalidate, openSingle: (url) => router.push(url) });

  const actions = React.useMemo<LibraryActions>(() => ({
    async update(id, patch, opts) {
      try {
        const { item } = await api<{ item: LibraryItemView }>(`/api/library/items/${id}`, { method: "PATCH", json: patch });
        patchLocal(id, item);
        await invalidate();
        if (!opts?.silent) toast.success("Saved");
        return item;
      } catch (e) { toast.error("Update failed", { description: (e as Error).message }); return null; }
    },
    async rename(id, name) {
      const trimmed = name.trim();
      const cur = items.find((i) => i.id === id);
      if (!trimmed || !cur || trimmed === cur.name) return;
      patchLocal(id, { name: trimmed });
      try { await api(`/api/library/items/${id}`, { method: "PATCH", json: { name: trimmed } }); await invalidate(); toast.success(`Renamed to "${trimmed}"`); }
      catch (e) { patchLocal(id, { name: cur.name }); toast.error("Rename failed", { description: (e as Error).message }); }
    },
    async move(ids, parentId) {
      try {
        const r = await api<{ moved: string[] }>("/api/library/move", { method: "POST", json: { ids, parentId } });
        await invalidate();
        const target = parentId ? tree?.roots && findName(tree, parentId) : "Library root";
        toast.success(`Moved ${r.moved.length} item${r.moved.length === 1 ? "" : "s"}${target ? ` to ${target}` : ""}`, { action: parentId === undefined ? undefined : { label: "Open folder", onClick: () => openFolder(parentId) } });
        setSelected(new Set());
        return true;
      } catch (e) { toast.error("Move failed", { description: (e as Error).message }); return false; }
    },
    async star(id, starred) {
      patchLocal(id, { starred });
      try { await api(`/api/library/items/${id}`, { method: "PATCH", json: { starred } }); await refreshTree(); cacheRef.current.clear(); }
      catch (e) { patchLocal(id, { starred: !starred }); toast.error("Could not update star", { description: (e as Error).message }); }
    },
    async remove(ids) {
      try {
        const results = await Promise.all(ids.map((id) => api<{ deleted: string[] }>(`/api/library/items/${id}`, { method: "DELETE" }).catch((e: Error) => ({ deleted: [], error: e.message }))));
        const n = results.reduce((s, r) => s + r.deleted.length, 0);
        const failed = results.filter((r) => "error" in r) as { error: string }[];
        if (failed.length) toast.error(`${failed.length} could not be deleted`, { description: failed[0].error });
        if (n) toast.success(`Deleted ${n} item${n === 1 ? "" : "s"}`);
        if (previewId && ids.includes(previewId)) openPreview(null);
        setSelected(new Set());
        await invalidate();
      } catch (e) { toast.error("Delete failed", { description: (e as Error).message }); }
    },
    async duplicate(id) {
      try {
        const { item } = await api<{ item: LibraryItemView }>(`/api/library/items/${id}/duplicate`, { method: "POST", json: {} });
        await invalidate();
        toast.success(`Created "${item.name}"`, { action: { label: item.officeDocId ? "Open" : "Preview", onClick: () => openItem(item) } });
      } catch (e) { toast.error("Duplicate failed", { description: (e as Error).message }); }
    },
    async create(input) {
      try {
        const { item } = await api<{ item: LibraryItemView }>("/api/library/items", { method: "POST", json: input });
        await invalidate();
        toast.success(`${input.type === "folder" ? "Folder" : input.type === "clause" ? "Clause" : input.type === "link" ? "Link" : "Note"} created`, { description: item.name });
        return item;
      } catch (e) { toast.error("Could not create item", { description: (e as Error).message }); return null; }
    },
    upload: (files, target) => uploads.upload(files, { folderId: target?.folderId === undefined ? folderId : target.folderId, matterId: target?.matterId === undefined ? currentMatterId : target.matterId }),
    async rebuildIndex() {
      const id = toast.loading("Rebuilding search index…");
      try {
        const r = await api<{ embed: boolean; library: { docs: number; chunks: number; embedded: number }; office: { docs: number }; note?: string }>("/api/library/index", { method: "POST", json: {} });
        toast.success(`Indexed ${r.library.docs} items and ${r.office.docs} documents`, { id, description: r.embed ? `${r.library.embedded} chunks embedded` : r.note });
        await refreshTree();
      } catch (e) { toast.error("Index rebuild failed", { id, description: (e as Error).message }); }
    },
    async download(item) {
      try {
        if (item.content) { downloadText(`${safeName(item.name)}.md`, item.content); return; }
        if (item.officeDocId && item.officeKind === "word") {
          // Word exports go through the editor's filing-check gate (citations, citator, quotations, AI-use declaration).
          window.location.assign(`/office/word/${encodeURIComponent(item.officeDocId)}?export=docx`);
          return;
        }
        if (item.officeDocId) {
          const { doc } = await api<{ doc: { content: unknown } }>(`/api/office/docs/${item.officeDocId}`);
          downloadText(`${safeName(item.name)}.json`, JSON.stringify(doc.content, null, 2), "application/json");
          return;
        }
        if (item.url) { window.open(item.url, "_blank", "noopener"); return; }
        toast.info("Nothing to download for this item");
      } catch (e) { toast.error("Download failed", { description: (e as Error).message }); }
    },
  }), [patchLocal, invalidate, items, tree, openFolder, refreshTree, previewId, openPreview, openItem, uploads, folderId, currentMatterId]);

  const value = React.useMemo<LibraryContextValue>(() => ({
    filters: effective, setFilters, folderId, view, currentMatterId,
    tree, refreshTree, list, listLoading, refreshList, search, searchLoading, isSearching, items,
    selected, setSelected, toggleSelected, selectAll, clearSelection,
    previewId, openPreview, openItem, openFolder, openView,
    renamingId, setRenamingId, dialog, openDialog: setDialog, closeDialog: () => setDialog(null),
    dragOverId, setDragOverId, dragging, setDragging,
    uploading: uploads.busy, uploadProgress: uploads.progress,
    actions, matters: tree?.matters ?? initial.tree.matters, people: tree?.people ?? initial.tree.people, aiConfigured: tree?.aiConfigured ?? initial.aiConfigured, itemById, searchInputRef,
  }), [effective, setFilters, folderId, view, currentMatterId, tree, refreshTree, list, listLoading, refreshList, search, searchLoading, isSearching, items, selected, toggleSelected, selectAll, clearSelection, previewId, openPreview, openItem, openFolder, openView, renamingId, dialog, dragOverId, dragging, uploads.busy, uploads.progress, actions, initial, itemById]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function findName(tree: LibraryTreeResponse, id: string): string | undefined {
  const walk = (nodes: LibraryTreeResponse["roots"]): string | undefined => { for (const n of nodes) { if (n.id === id) return n.name; const f = walk(n.children); if (f) return f; } return undefined; };
  return walk(tree.roots);
}

function safeName(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\.[a-z0-9]{2,5}$/i, "").trim() || "item";
}
