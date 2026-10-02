"use client";
import * as React from "react";
import { ChevronRight, FolderInput, Library as LibraryIcon, Loader2, MessageSquareText, Star, Trash2, X, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { TopbarSlot } from "@/components/shell/app-shell";
import { useInTabbedSection } from "@/components/shell/section-tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/tooltip";
import { useShortcutHelp, type ShortcutGroup } from "@/components/ui/shortcut-help";
import { LibraryProvider, useLibrary, type LibraryInitialData } from "./library-provider";
import { useLibraryUI } from "./store";
import { FolderTree } from "./folder-tree";
import { Toolbar } from "./toolbar";
import { ItemGrid } from "./item-grid";
import { PreviewSheet } from "./preview-sheet";
import { AskLibraryPanel } from "./ask-library";
import { LibraryDialogs } from "./dialogs";

const LIBRARY_SHORTCUTS: ShortcutGroup[] = [
  { id: "library", title: "Library", items: [
    { keys: ["/"], label: "Search the library" }, { keys: ["enter"], label: "Open the selected item" }, { keys: ["space"], label: "Details" }, { keys: ["f2"], label: "Rename" }, { keys: ["s"], label: "Star / unstar" },
    { keys: ["n"], label: "New note" }, { keys: ["f"], label: "New folder" }, { keys: ["u"], label: "Upload" }, { keys: ["a"], label: "Ask the library" }, { keys: ["1"], label: "Grid view" }, { keys: ["2"], label: "List view" }, { keys: ["mod+a"], label: "Select all" }, { keys: ["backspace"], label: "Delete selection" },
  ] },
];

export function LibraryPage({ initial }: { initial: LibraryInitialData }) {
  return (
    <LibraryProvider initial={initial}>
      <Layout />
      <PreviewSheet />
      <LibraryDialogs />
    </LibraryProvider>
  );
}

function Layout() {
  const lib = useLibrary();
  const askOpen = useLibraryUI((s) => s.askOpen);
  const treeWidth = useLibraryUI((s) => s.treeWidth);
  const setTreeWidth = useLibraryUI((s) => s.setTreeWidth);
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);
  useLibraryShortcuts();
  useShortcutHelp(LIBRARY_SHORTCUTS, "library");

  // Tree resize handle (pointer drag).
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = treeWidth;
    const move = (ev: PointerEvent) => setTreeWidth(startW + (ev.clientX - startX));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex h-full min-h-0">
      <Topbar />
      <div className="hidden h-full md:flex" style={{ width: hydrated ? treeWidth : 236 }}>
        <FolderTree className="min-w-0 flex-1" />
        <div onPointerDown={onResizeStart} className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-ring/40 transition-colors" aria-hidden />
      </div>
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Library contents">
        <Toolbar />
        <SelectionBar />
        <ItemGrid />
        <UploadStrip />
      </section>
      {hydrated && askOpen && <AskLibraryPanel className="hidden lg:flex" />}
      <span className="sr-only" aria-live="polite">{lib.listLoading ? "Loading folder" : ""}</span>
    </div>
  );
}

function Topbar() {
  const tabbed = useInTabbedSection();
  const { list, view, isSearching, search, openFolder, listLoading, currentMatterId, matters, aiConfigured } = useLibrary();
  const askOpen = useLibraryUI((s) => s.askOpen);
  const setAskOpen = useLibraryUI((s) => s.setAskOpen);
  const matter = matters.find((m) => m.id === currentMatterId);
  const title = isSearching ? `Search: ${search?.query ?? ""}` : view !== "folder" ? { starred: "Starred", recent: "Recent", shared: "Shared with me", all: "All items" }[view] : list?.folder?.name ?? "All folders";
  return (
    <TopbarSlot>
      {/* In the Drafting section the Library tab names the page; the folder path follows it. */}
      {!tabbed && <LibraryIcon className="size-4 text-muted-foreground" />}
      {!tabbed && <button onClick={() => openFolder(null)} className="shrink-0 text-[13px] font-semibold hover:text-primary cursor-pointer">Library</button>}
      {!tabbed && <ChevronRight className="size-3.5 text-muted-foreground rtl:rotate-180" />}
      {tabbed && view === "folder" && !isSearching && list?.folder ? (
        <button onClick={() => openFolder(null)} className="shrink-0 text-[12.5px] text-muted-foreground hover:text-foreground cursor-pointer">All folders</button>
      ) : null}
      {tabbed && view === "folder" && !isSearching && list?.folder ? <ChevronRight className="size-3.5 text-muted-foreground rtl:rotate-180" /> : null}
      <span className="truncate text-[12.5px] text-muted-foreground">{title}</span>
      {listLoading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      {matter && <Badge variant="outline" size="sm" className="hidden sm:inline-flex">{matter.shortName}</Badge>}
      {list?.total != null && !isSearching && <span className="hidden text-[11.5px] tabular text-muted-foreground md:inline">{list.total} item{list.total === 1 ? "" : "s"}</span>}
      <div className="hidden items-center gap-1 md:flex">
        <Tip label={aiConfigured ? "Ask the library (internal research)" : "Ask the library — OpenAI key required for answers"} shortcut="A"><Button variant={askOpen ? "secondary" : "ghost"} size="xs" onClick={() => setAskOpen(!askOpen)} className="gap-1.5"><MessageSquareText className="size-3.5" /> Ask</Button></Tip>
      </div>
    </TopbarSlot>
  );
}

function SelectionBar() {
  const { selected, clearSelection, itemById, openDialog, actions } = useLibrary();
  if (!selected.size) return null;
  const ids = Array.from(selected);
  const items = ids.map(itemById).filter(Boolean);
  const allStarred = items.length > 0 && items.every((i) => i!.starred);
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-accent/40 px-3 text-[12px]">
      <span className="tabular font-medium">{selected.size}</span>
      <span className="text-muted-foreground">selected</span>
      <div className="flex-1" />
      <Button size="xs" variant="outline" onClick={() => openDialog({ kind: "move", ids })}><FolderInput className="size-3.5" /> Move</Button>
      <Button size="xs" variant="outline" onClick={() => { for (const id of ids) void actions.star(id, !allStarred); }}><Star className={cn("size-3.5", allStarred && "fill-current text-warning")} /> {allStarred ? "Unstar" : "Star"}</Button>
      {items.length === 1 && items[0]!.type !== "folder" && <Button size="xs" variant="outline" onClick={() => actions.download(items[0]!)}><Download className="size-3.5" /> Download</Button>}
      <Button size="xs" variant="outline" className="text-destructive hover:text-destructive" onClick={() => openDialog({ kind: "delete", ids })}><Trash2 className="size-3.5" /> Delete</Button>
      <Button size="icon-xs" variant="ghost" onClick={clearSelection} aria-label="Clear selection"><X className="size-4" /></Button>
    </div>
  );
}

function UploadStrip() {
  const { uploadProgress } = useLibrary();
  if (!uploadProgress) return null;
  const pct = uploadProgress.total ? Math.round((uploadProgress.done / uploadProgress.total) * 100) : 0;
  return (
    <div className="shrink-0 border-t bg-background px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin text-primary" /><span className="truncate">Uploading {uploadProgress.done}/{uploadProgress.total}{uploadProgress.current ? ` · ${uploadProgress.current}` : ""}</span><span className="ml-auto tabular text-muted-foreground">{pct}%</span></div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/** Global keyboard shortcuts for the library (ignored while typing). */
function useLibraryShortcuts() {
  const lib = useLibrary();
  const setViewMode = useLibraryUI((s) => s.setViewMode);
  const askOpen = useLibraryUI((s) => s.askOpen);
  const setAskOpen = useLibraryUI((s) => s.setAskOpen);
  const ref = React.useRef(lib);
  ref.current = lib;
  React.useEffect(() => {
    let chord: string | null = null;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest("[role=dialog]"));
      const l = ref.current;
      if (typing) return;
      // The list view's DataTable owns row navigation, selection and activation keys while it has focus.
      if (t?.closest("[role=grid]") && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Home", "End"].includes(e.key)) return;
      // The shell's "g" navigation chord (g s, g l, …) must not also trigger single-key library shortcuts.
      if (chord === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) { chord = null; return; }
      if (e.key.toLowerCase() === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) { chord = "g"; clearTimeout(chordTimer); chordTimer = setTimeout(() => (chord = null), 900); return; }
      const sel = Array.from(l.selected);
      const first = sel[0] ? l.itemById(sel[0]) : undefined;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); l.selectAll(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "/": e.preventDefault(); l.searchInputRef.current?.focus(); l.searchInputRef.current?.select(); break;
        case "Escape": if (l.previewId) l.openPreview(null); else if (l.selected.size) l.clearSelection(); else if (l.filters.q) l.setFilters({ q: undefined }); break;
        case "Enter": if (first) { e.preventDefault(); l.openItem(first); } break;
        case " ": if (first) { e.preventDefault(); l.openPreview(first.id); } break;
        case "F2": if (first) { e.preventDefault(); l.setRenamingId(first.id); } break;
        case "Delete": case "Backspace": if (sel.length) { e.preventDefault(); l.openDialog({ kind: "delete", ids: sel }); } break;
        case "s": if (sel.length) { e.preventDefault(); const star = !(first?.starred); for (const id of sel) void l.actions.star(id, star); } break;
        case "n": e.preventDefault(); l.openDialog({ kind: "note", parentId: l.folderId }); break;
        case "f": e.preventDefault(); l.openDialog({ kind: "folder", parentId: l.folderId }); break;
        case "u": { e.preventDefault(); const input = document.createElement("input"); input.type = "file"; input.multiple = true; input.onchange = () => { if (input.files?.length) void l.actions.upload(input.files); }; input.click(); break; }
        case "a": e.preventDefault(); setAskOpen(!askOpen); break;
        case "1": setViewMode("grid"); break;
        case "2": setViewMode("list"); break;
        case "ArrowRight": case "ArrowLeft": case "ArrowDown": case "ArrowUp": {
          const ids = l.items.map((i) => i.id);
          if (!ids.length) return;
          e.preventDefault();
          const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-item-id]"));
          const cur = sel.length ? ids.indexOf(sel[sel.length - 1]) : -1;
          let cols = 1;
          if (cards.length > 1) { const y0 = cards[0].getBoundingClientRect().top; cols = cards.findIndex((c, i) => i > 0 && c.getBoundingClientRect().top > y0 + 4); if (cols < 1) cols = cards.length; }
          const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? cols : -cols;
          const next = Math.min(ids.length - 1, Math.max(0, cur < 0 ? 0 : cur + delta));
          l.toggleSelected(ids[next], { additive: false });
          cards.find((c) => c.dataset.itemId === ids[next])?.focus();
          break;
        }
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(chordTimer); };
  }, [askOpen, setAskOpen, setViewMode]);
}
