"use client";
import * as React from "react";
import { Bookmark, ChevronDown, CornerDownRight, FileSearch, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DataTable, type DataTableColumn, type SortState } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Tip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CodingDecision } from "@/lib/types/domain";
import type { DocRow, ReviewLayout } from "../types";
import { DEFAULT_COLUMNS, useReviewStore } from "./store";
import { useReview } from "./review-page";
import { ReviewListContext } from "./review-tab";
import { api, useLayouts } from "./use-review-data";
import { DecisionCell, IssueChip, SuggestedCell, TypeIcon, formatDateTime, formatShortDate } from "./shared";
import { IssuePicker } from "./issue-picker";
import { formatBytes } from "./review-helpers";
import { docClassLabel } from "../india";

const rowId = (r: DocRow) => r.id;

/**
 * The review grid: a virtualized DataTable over the search rows with the standard
 * metadata columns, inline coding in the Decision and Issues cells, a quiet
 * Suggested column, grouped rows (family / thread / near-dup) and per-user saved
 * layouts. Selection, cursor, sort, density and columns live in the review store.
 */
export function DocTable({ hits, loading, error, total, totalWorkspace, tookMs, semantic, onLoadMore, loadingMore }: { hits: DocRow[]; loading: boolean; error?: string | null; total: number; totalWorkspace: number; tookMs?: number; semantic: boolean; onLoadMore?: () => void; loadingMore?: boolean }) {
  const { issueCodes, reviewers } = useReview();
  const list = React.useContext(ReviewListContext);
  const density = useReviewStore((s) => s.density);
  const setDensity = useReviewStore((s) => s.setDensity);
  const columnWidths = useReviewStore((s) => s.columnWidths);
  const setColumnWidths = useReviewStore((s) => s.setColumnWidths);
  const hiddenColumns = useReviewStore((s) => s.hiddenColumns);
  const setHiddenColumns = useReviewStore((s) => s.setHiddenColumns);
  const sortKey = useReviewStore((s) => s.sort);
  const dir = useReviewStore((s) => s.dir);
  const setSortState = useReviewStore((s) => s.setSortState);
  const selected = useReviewStore((s) => s.selected);
  const setSelected = useReviewStore((s) => s.setSelected);
  const activeId = useReviewStore((s) => s.activeId);
  const setActiveId = useReviewStore((s) => s.setActiveId);
  const openDocId = useReviewStore((s) => s.openDocId);
  const setOpenDocId = useReviewStore((s) => s.setOpenDocId);
  const groupBy = useReviewStore((s) => s.groupBy);
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);
  const reviewerName = React.useCallback((id?: string) => (id ? reviewers.find((r) => r.id === id)?.name ?? id : ""), [reviewers]);

  const codeInline = React.useCallback((row: DocRow, patch: Partial<CodingDecision>) => { void list.codeDocs([row.id], patch); }, [list]);

  const columns = React.useMemo<DataTableColumn<DocRow>[]>(() => DEFAULT_COLUMNS.map((c) => ({
    id: c.id,
    header: c.label,
    label: c.label,
    width: c.width,
    minWidth: c.min,
    align: c.align,
    sortable: !!c.sort,
    locked: c.locked,
    defaultHidden: c.defaultHidden,
    render: (row) => renderCell(c.id, row, { issueCodes, reviewerName, density, grouped: groupBy !== "none", codeInline }),
  })), [issueCodes, reviewerName, density, groupBy, codeInline]);

  // Store sort key ↔ column id.
  const sort = React.useMemo<SortState | null>(() => {
    const col = DEFAULT_COLUMNS.find((c) => c.sort && c.sort === sortKey);
    return col ? { columnId: col.id, dir: dir ?? (sortKey === "aiScore" ? "desc" : "asc") } : null;
  }, [sortKey, dir]);
  const onSortChange = React.useCallback((s: SortState | null) => {
    if (!s) { setSortState(undefined, undefined); return; }
    const col = DEFAULT_COLUMNS.find((c) => c.id === s.columnId);
    if (!col?.sort) return;
    // The suggested column starts descending (highest scores first).
    const first = sortKey !== col.sort;
    setSortState(col.sort, first && col.sort === "aiScore" ? "desc" : s.dir);
  }, [setSortState, sortKey]);

  const onActiveChange = React.useCallback((id: string | null) => {
    setActiveId(id);
    // With the viewer open the cursor drives the viewer (j/k reads the next document).
    if (id && useReviewStore.getState().openDocId) setOpenDocId(id);
  }, [setActiveId, setOpenDocId]);

  const onRowClick = React.useCallback((row: DocRow, e: React.MouseEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    setOpenDocId(row.id);
  }, [setOpenDocId]);

  const rowProps = React.useCallback((row: DocRow) => (row.groupKey ? { "data-group": row.groupKey, "data-group-index": row.groupIndex } as React.HTMLAttributes<HTMLDivElement> : undefined), []);
  const rowClassName = React.useCallback((row: DocRow) => cn(openDocId === row.id && "bg-primary/10", row.groupKey && row.groupIndex && row.groupIndex > 0 && "shadow-[inset_3px_0_0_var(--line-quiet)]"), [openDocId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-doc-table>
      <DataTable<DocRow>
        rows={hits}
        columns={columns}
        rowId={rowId}
        serverSort
        sort={sort}
        onSortChange={onSortChange}
        selectionMode="multi"
        selected={selected}
        onSelectedChange={setSelected}
        activeId={activeId}
        onActiveChange={onActiveChange}
        onRowActivate={(row) => setOpenDocId(row.id)}
        onRowClick={onRowClick}
        rowProps={rowProps}
        rowClassName={rowClassName}
        density={hydrated ? density : "compact"}
        onDensityChange={setDensity}
        hiddenColumns={hydrated ? hiddenColumns : DEFAULT_COLUMNS.filter((c) => c.defaultHidden).map((c) => c.id)}
        onHiddenColumnsChange={setHiddenColumns}
        columnWidths={hydrated ? columnWidths : {}}
        onColumnWidthsChange={setColumnWidths}
        noun="document"
        total={total}
        loading={loading}
        error={error ?? null}
        empty={<div className="p-8"><EmptyState icon={FileSearch} title="No documents match" description="Adjust the query, view or facets. Exhibit marks (Ex.P7), document references and field prefixes are exact; try Semantic for concept searches." /></div>}
        onEndReached={onLoadMore}
        ariaLabel="Documents"
        stripActions={<LayoutMenu />}
      />
      <footer className="flex h-7 shrink-0 items-center justify-between border-t bg-muted/30 px-3 text-[11px] text-muted-foreground">
        <span className="tabular">
          {loading && !hits.length ? "Searching…" : <><span className="text-foreground">{hits.length.toLocaleString()}</span> of <span className="text-foreground">{total.toLocaleString()}</span> in view · {totalWorkspace.toLocaleString()} in workspace</>}
          {!loading && hits.length < total && onLoadMore && (
            <button onClick={onLoadMore} disabled={loadingMore} className="ml-2 inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] text-primary hover:bg-accent disabled:opacity-60 cursor-pointer">
              {loadingMore ? <Loader2 className="size-3 animate-spin" /> : null}{loadingMore ? "Loading…" : `Load ${Math.min(500, total - hits.length).toLocaleString()} more`}
            </button>
          )}
        </span>
        <span className="hidden items-center gap-3 sm:flex">
          {semantic && <span className="text-primary">semantic ranking</span>}
          {tookMs != null && <span className="tabular">{tookMs} ms</span>}
          <span className="hidden xl:inline"><kbd className="px-1 py-px text-[10px]">j</kbd> <kbd className="px-1 py-px text-[10px]">k</kbd> move · <kbd className="px-1 py-px text-[10px]">r</kbd> <kbd className="px-1 py-px text-[10px]">n</kbd> <kbd className="px-1 py-px text-[10px]">p</kbd> <kbd className="px-1 py-px text-[10px]">h</kbd> code · <kbd className="px-1 py-px text-[10px]">1–9</kbd> issues · <kbd className="px-1 py-px text-[10px]">x</kbd> next uncoded</span>
        </span>
      </footer>
    </div>
  );
}

interface CellCtx { issueCodes: ReturnType<typeof useReview>["issueCodes"]; reviewerName: (id?: string) => string; density: "compact" | "comfortable"; grouped: boolean; codeInline: (row: DocRow, patch: Partial<CodingDecision>) => void }

function renderCell(id: string, row: DocRow, ctx: CellCtx): React.ReactNode {
  const f = row.family2;
  switch (id) {
    case "bates": {
      const member = ctx.grouped && row.groupKey && (row.groupIndex ?? 0) > 0;
      const head = ctx.grouped && row.groupKey && row.groupIndex === 0;
      return (
        <span className={cn("flex min-w-0 items-center gap-1 font-mono text-[11.5px] tabular text-foreground/90", member && "pl-3")}>
          {member && <CornerDownRight className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />}
          <span className="truncate">{row.bates}</span>
          {head && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground" title={`Group of ${row.groupSize}`}>{row.groupSize}</span>}
        </span>
      );
    }
    case "batesEnd": return <span className="font-mono text-[11.5px] tabular text-muted-foreground">{row.batesEnd ?? row.bates}</span>;
    case "exhibit": return row.india?.exhibit ? <span className="font-mono text-[11.5px] font-medium tabular" title={row.india.markedThrough ? `Marked through ${row.india.markedThrough}${row.india.markedOn ? ` on ${formatShortDate(row.india.markedOn)}` : ""}${row.india.markedSubjectToObjection ? " (subject to objection)" : ""}` : undefined}>{row.india.exhibit}</span> : <span className="text-muted-foreground/40">—</span>;
    case "record": return row.india ? <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">{docClassLabel(row.india.docClass)}{row.india.language && row.india.language !== "en" && <span className="shrink-0 rounded border px-1 text-[10px] uppercase leading-4" title="Original-language text (text of record)">{row.india.language}</span>}{row.india.docClass === "translation" && <span className="shrink-0 rounded border border-dashed px-1 text-[10px] leading-4" title={`Translation (${row.india.translationOrigin ?? "unknown origin"}); the original is the text of record`}>TR</span>}</span> : <span className="text-muted-foreground/40">—</span>;
    case "family": return f.isParent ? <span className="tabular text-muted-foreground" title={`Parent with ${f.attachmentCount} attachment${f.attachmentCount === 1 ? "" : "s"}`}>P +{f.attachmentCount}</span> : f.isAttachment ? <span className="text-muted-foreground" title="Attachment">A</span> : <span className="text-muted-foreground/40">—</span>;
    case "thread": return f.inThread ? <span className="tabular text-muted-foreground" title={`Thread of ${f.threadSize}`}>{f.threadSize}</span> : <span className="text-muted-foreground/40">—</span>;
    case "dupes": return f.isDuplicate ? <span className="text-muted-foreground" title="Exact duplicate">D</span> : f.nearDuplicateCount ? <span className="tabular text-muted-foreground" title={`${f.nearDuplicateCount} near-duplicate${f.nearDuplicateCount === 1 ? "" : "s"}`}>≈{f.nearDuplicateCount}</span> : <span className="text-muted-foreground/40">—</span>;
    case "custodian": return <span className="truncate">{row.custodianName}</span>;
    case "date": return <span className="tabular text-muted-foreground">{formatShortDate(row.date)}</span>;
    case "from": return <span className="truncate">{row.from ?? ""}</span>;
    case "to": return <span className="truncate text-muted-foreground" title={(row.to ?? []).join("; ")}>{(row.to ?? []).join("; ")}</span>;
    case "cc": return <span className="truncate text-muted-foreground" title={(row.cc ?? []).join("; ")}>{(row.cc ?? []).join("; ")}</span>;
    case "subject":
      return (
        <span className="flex min-w-0 flex-col justify-center overflow-hidden leading-tight">
          <span className="truncate font-medium text-foreground/95" title={row.subject}>{row.subject}</span>
          {ctx.density === "comfortable" && row.snippet && <span className="truncate text-[10.5px] text-muted-foreground">{row.snippet}</span>}
        </span>
      );
    case "type": return <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><TypeIcon type={row.type} /><span className="truncate">{row.type}</span></span>;
    case "size": return <span className="tabular text-muted-foreground">{formatBytes(row.textLength)}</span>;
    case "pages": return <span className="tabular text-muted-foreground">{row.pages ?? 1}</span>;
    case "decision": return <DecisionCell coding={row.coding} onChange={(patch) => ctx.codeInline(row, patch)} />;
    case "issues": return <IssuesCell row={row} ctx={ctx} />;
    case "suggested": return <SuggestedCell score={row.aiScore} coding={row.coding} rationale={row.aiRationale} confidence={row.aiConfidence} record={row} />;
    case "reviewer": return <span className="truncate text-muted-foreground">{ctx.reviewerName(row.coding.reviewerId)}</span>;
    case "reviewed": return <span className="tabular text-muted-foreground">{row.coding.reviewedAt ? formatDateTime(row.coding.reviewedAt) : ""}</span>;
    case "redactions": return row.redactions ? <span className="tabular">{row.redactions}</span> : <span className="text-muted-foreground/40">—</span>;
    default: return null;
  }
}

function IssuesCell({ row, ctx }: { row: DocRow; ctx: CellCtx }) {
  const [open, setOpen] = React.useState(false);
  const issues = row.coding.issues ?? [];
  const shown = issues.slice(0, 3);
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {shown.map((c) => <IssueChip key={c} code={c} codes={ctx.issueCodes} size="xs" />)}
      {issues.length > 3 && <span className="text-[10.5px] tabular text-muted-foreground" title={issues.slice(3).join(", ")}>+{issues.length - 3}</span>}
      <IssuePicker codes={ctx.issueCodes} value={issues} onChange={(next) => ctx.codeInline(row, { issues: next })} open={open} onOpenChange={setOpen} showKeys>
        <button type="button" data-row-action onClick={(e) => { e.stopPropagation(); setOpen(true); }} className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded border border-dashed text-muted-foreground/60 hover:border-border hover:text-foreground cursor-pointer", !issues.length && "opacity-70")} aria-label="Edit issue codes"><Plus className="size-2.5" /></button>
      </IssuePicker>
    </span>
  );
}

/** Saved grid layouts (per user, stored server-side): apply, save the current columns/widths/density, delete, reset. */
function LayoutMenu() {
  const { matterId } = useReview();
  const layouts = useLayouts(matterId);
  const layoutId = useReviewStore((s) => s.layoutId);
  const applyLayout = useReviewStore((s) => s.applyLayout);
  const resetLayout = useReviewStore((s) => s.resetLayout);
  const [saving, setSaving] = React.useState(false);
  const [name, setName] = React.useState("");
  const current = layouts.data?.layouts.find((l) => l.id === layoutId);
  const save = async () => {
    const s = useReviewStore.getState();
    try {
      const r = await api<{ layout: ReviewLayout }>("/api/ediscovery/layouts", { method: "POST", json: { name: name.trim(), hiddenColumns: s.hiddenColumns, columnWidths: s.columnWidths, density: s.density } });
      layouts.refresh();
      useReviewStore.getState().setLayoutId(r.layout.id);
      setSaving(false);
      toast.success(`Layout “${r.layout.name}” saved`);
    } catch (e) { toast.error("Could not save layout", { description: (e as Error).message }); }
  };
  const remove = async (l: ReviewLayout) => {
    try { await api(`/api/ediscovery/layouts?id=${encodeURIComponent(l.id)}`, { method: "DELETE" }); layouts.refresh(); if (layoutId === l.id) useReviewStore.getState().setLayoutId(null); } catch (e) { toast.error("Could not delete layout", { description: (e as Error).message }); }
  };
  return (
    <>
      <DropdownMenu>
        <Tip label="Saved grid layouts (columns, widths, density)">
          <DropdownMenuTrigger asChild><Button variant="ghost" size="xs" className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"><Bookmark className={cn("size-3", current && "fill-current")} /><span className="hidden lg:inline">{current ? current.name : "Layout"}</span><ChevronDown className="size-3 opacity-60" /></Button></DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Layouts</DropdownMenuLabel>
          {!layouts.data?.layouts.length && <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground">No saved layouts yet.</div>}
          {layouts.data?.layouts.map((l) => (
            <DropdownMenuItem key={l.id} onClick={() => applyLayout({ id: l.id, hiddenColumns: l.hiddenColumns, columnWidths: l.columnWidths, density: l.density })} className="group/layout">
              <span className="min-w-0 flex-1 truncate">{l.name}</span>
              {l.id === layoutId && <span className="text-[10px] text-primary">current</span>}
              <button type="button" onClick={(e) => { e.stopPropagation(); e.preventDefault(); void remove(l); }} className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover/layout:opacity-100" aria-label={`Delete layout ${l.name}`}><Trash2 className="size-3" /></button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => { setName(current?.name ?? ""); setSaving(true); }}><Plus /> Save current layout…</DropdownMenuItem>
          <DropdownMenuItem onClick={resetLayout}><RotateCcw /> Reset to default</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover open={saving} onOpenChange={setSaving}>
        <PopoverTrigger asChild><span className="sr-only" aria-hidden /></PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-2 p-3">
          <div className="text-[12px] font-medium">Save layout</div>
          <Input size="sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Privilege pass" onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void save(); }} />
          <div className="text-[11px] text-muted-foreground">Visible columns, widths and density are stored for you; a layout with the same name is replaced.</div>
          <div className="flex justify-end gap-1.5"><Button variant="ghost" size="xs" onClick={() => setSaving(false)}>Cancel</Button><Button size="xs" disabled={!name.trim()} onClick={() => void save()}>Save</Button></div>
        </PopoverContent>
      </Popover>
    </>
  );
}
