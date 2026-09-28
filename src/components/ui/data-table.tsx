"use client";
import * as React from "react";
import { useI18n } from "@/lib/i18n/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, ArrowDown, ArrowUp, Columns3, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "./checkbox";
import { Button } from "./button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu";
import { Tip } from "./tooltip";
import {
  ACTIONS_COLUMN_WIDTH, HEADER_HEIGHT, NAV_KEYS, ROW_HEIGHT, SELECT_COLUMN_WIDTH,
  applyRowClick, columnWidth, defaultHiddenColumns, keyboardNav, resizeColumn, selectionSummary, sortRows, toggleColumn, toggleSort, visibleColumns,
  type Density, type SelectionMode, type SortState, pluralNoun } from "./data-table-helpers";

export type { Density, SelectionMode, SortState } from "./data-table-helpers";

export interface DataTableColumn<T> {
  id: string;
  header: React.ReactNode;
  /** Initial width in px (default 160). Users can resize; `minWidth` bounds it. */
  width?: number;
  minWidth?: number;
  align?: "left" | "right" | "center";
  sortable?: boolean;
  /** Value used for sorting and for the default cell text. */
  accessor?: (row: T) => unknown;
  render?: (row: T, ctx: { index: number; selected: boolean; active: boolean }) => React.ReactNode;
  className?: string;
  /** Cannot be hidden from the column chooser. */
  locked?: boolean;
  /** Hidden until the user turns it on. */
  defaultHidden?: boolean;
  /** Short label for the column chooser when `header` is a node. */
  label?: string;
  /** Tooltip on the header. */
  title?: string;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: DataTableColumn<T>[];
  rowId: (row: T) => string;
  // Sorting (uncontrolled when `sort` is omitted). Rows are sorted client-side unless `serverSort` is set.
  sort?: SortState | null;
  defaultSort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  serverSort?: boolean;
  // Selection
  selectionMode?: SelectionMode;
  selected?: string[];
  defaultSelected?: string[];
  onSelectedChange?: (ids: string[]) => void;
  activeId?: string | null;
  onActiveChange?: (id: string | null) => void;
  /** Enter or double-click on a row. */
  onRowActivate?: (row: T) => void;
  onRowClick?: (row: T, e: React.MouseEvent) => void;
  /** Trailing per-row slot (menus, quick actions); shown on hover and when the row is active. */
  rowActions?: (row: T) => React.ReactNode;
  rowClassName?: (row: T, ctx: { selected: boolean; active: boolean }) => string | undefined;
  /** Extra attributes/handlers spread onto each row element (drag-and-drop, data-* hooks). */
  rowProps?: (row: T) => React.HTMLAttributes<HTMLDivElement> | undefined;
  // Presentation
  density?: Density;
  defaultDensity?: Density;
  onDensityChange?: (d: Density) => void;
  hiddenColumns?: string[];
  onHiddenColumnsChange?: (ids: string[]) => void;
  columnWidths?: Record<string, number>;
  onColumnWidthsChange?: (widths: Record<string, number>) => void;
  /** Column chooser + density menu in the strip (default true). */
  columnChooser?: boolean;
  /** Selection summary strip above the header (default true when selectable). */
  summary?: boolean;
  /** Noun used in the summary ("document", "matter"). */
  noun?: string;
  /** Extra controls on the right of the strip. */
  stripActions?: React.ReactNode;
  /** Total count when the rows are a page of a larger set. */
  total?: number;
  loading?: boolean;
  error?: string | null;
  empty?: React.ReactNode;
  /** Virtualize rows (default true). Turn off for short tables that live inside a scrolling page. */
  virtualize?: boolean;
  overscan?: number;
  /** Called when the last rows scroll into view (infinite loading). */
  onEndReached?: () => void;
  className?: string;
  /** Fill the parent (default) or size to content. */
  fill?: boolean;
  ariaLabel?: string;
  /** Focus the grid on mount. */
  autoFocus?: boolean;
}

function useControlled<V>(value: V | undefined, defaultValue: V, onChange?: (v: V) => void): [V, (v: V) => void] {
  const [inner, setInner] = React.useState<V>(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? (value as V) : inner;
  const set = React.useCallback((v: V) => { if (!controlled) setInner(v); onChange?.(v); }, [controlled, onChange]);
  return [current, set];
}

const EMPTY: string[] = [];

/**
 * Dense, virtualized data grid: sticky header, sortable and resizable
 * columns, a column chooser, compact/comfortable density, j/k and arrow
 * keyboard navigation, single or multi selection with Shift/⌘, Enter or
 * double-click activation, a per-row actions slot and empty/loading/error
 * states. Sort, selection, active row, hidden columns, widths and density are
 * all optionally controlled.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const { rows, columns, rowId, selectionMode = "none", noun = "row", virtualize = true, fill = true } = props;
  const i18n = useI18n();
  const { t } = i18n;
  // Counted nouns come from the catalogue when it knows the noun ("noun.matter"), else the English plural.
  const countText = (n: number) => i18n.tx(`noun.${noun}`, `${n.toLocaleString("en-IN")} ${pluralNoun(noun, n)}`, { count: n });
  const [sort, setSort] = useControlled<SortState | null>(props.sort, props.defaultSort ?? null, props.onSortChange);
  const [selected, setSelected] = useControlled<string[]>(props.selected, props.defaultSelected ?? EMPTY, props.onSelectedChange);
  const [activeId, setActiveId] = useControlled<string | null>(props.activeId, null, props.onActiveChange);
  const [density, setDensity] = useControlled<Density>(props.density, props.defaultDensity ?? "compact", props.onDensityChange);
  const [hidden, setHidden] = useControlled<string[]>(props.hiddenColumns, React.useMemo(() => defaultHiddenColumns(columns), [columns]), props.onHiddenColumnsChange);
  const [widths, setWidths] = useControlled<Record<string, number>>(props.columnWidths, {}, props.onColumnWidthsChange);
  const [anchorId, setAnchorId] = React.useState<string | null>(null);

  const cols = React.useMemo(() => visibleColumns(columns, hidden), [columns, hidden]);
  const accessor = React.useCallback((row: T, columnId: string) => columns.find((c) => c.id === columnId)?.accessor?.(row), [columns]);
  const sorted = React.useMemo(() => (props.serverSort ? rows : sortRows(rows, sort, accessor)), [rows, sort, accessor, props.serverSort]);
  const ids = React.useMemo(() => sorted.map(rowId), [sorted, rowId]);
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  const rowH = ROW_HEIGHT[density];
  const hasSelectColumn = selectionMode === "multi";
  const hasActions = Boolean(props.rowActions);
  const leadWidth = hasSelectColumn ? SELECT_COLUMN_WIDTH : 0;
  const trailWidth = hasActions ? ACTIONS_COLUMN_WIDTH : 0;
  const gridWidth = cols.reduce((n, c) => n + columnWidth(c, widths), leadWidth + trailWidth);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: sorted.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowH, overscan: props.overscan ?? 12, getItemKey: (i) => ids[i] ?? i, enabled: virtualize });
  React.useEffect(() => { if (virtualize) virtualizer.measure(); }, [rowH, virtualize, virtualizer]);

  const activeIndex = activeId ? ids.indexOf(activeId) : -1;
  React.useEffect(() => { if (virtualize && activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" }); }, [activeIndex, virtualize, virtualizer]);
  React.useEffect(() => { if (props.autoFocus) scrollRef.current?.focus({ preventScroll: true }); }, [props.autoFocus]);

  // Infinite loading: fire when the last virtual row is within the overscan.
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1].index : -1;
  const endRef = React.useRef(-1);
  React.useEffect(() => {
    if (!props.onEndReached || props.loading || !sorted.length) return;
    if (lastIndex >= sorted.length - 1 && endRef.current !== sorted.length) { endRef.current = sorted.length; props.onEndReached(); }
  }, [lastIndex, sorted.length, props]);

  const applyNav = (next: { selected: string[]; anchorId: string | null; activeIndex: number }) => {
    if (selectionMode !== "none" && next.selected !== selected) setSelected(next.selected);
    setAnchorId(next.anchorId);
    const id = next.activeIndex >= 0 ? ids[next.activeIndex] ?? null : null;
    if (id !== activeId) setActiveId(id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest("input,textarea,select,[contenteditable=true],button[data-row-action]")) return;
    const key = e.key;
    const isSelectAll = (e.metaKey || e.ctrlKey) && key.toLowerCase() === "a";
    if (!NAV_KEYS.has(key) && !isSelectAll) return;
    if (e.metaKey || e.ctrlKey || e.altKey) { if (!isSelectAll) return; }
    const { next, action } = keyboardNav({ selected, anchorId, activeIndex }, key, { ids, shift: e.shiftKey, meta: e.metaKey || e.ctrlKey, pageSize: Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowH) - 1), mode: selectionMode });
    if (action === "activate") { e.preventDefault(); e.stopPropagation(); const row = sorted[activeIndex]; if (row) props.onRowActivate?.(row); return; }
    // Escape with nothing selected is left to the page (close a panel, leave a section).
    if (key === "Escape" && selected.length === 0) return;
    if (action === "none" && !sorted.length) return;
    e.preventDefault();
    // Handled keys stop here so window-level shortcuts (arrow navigation on cards, page hotkeys) do not act twice.
    e.stopPropagation();
    applyNav(next);
  };

  const onRowClick = (e: React.MouseEvent, row: T, id: string) => {
    if ((e.target as HTMLElement).closest("button,a,input,[role=menuitem],[data-row-action]")) return;
    props.onRowClick?.(row, e);
    if (selectionMode !== "none") {
      const next = applyRowClick({ selected, anchorId }, ids, id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }, selectionMode);
      setSelected(next.selected);
      setAnchorId(next.anchorId);
    }
    setActiveId(id);
  };

  const onCheck = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (e.shiftKey) { const next = applyRowClick({ selected, anchorId }, ids, id, { shift: true, meta: true }, "multi"); setSelected(next.selected); setAnchorId(next.anchorId); return; }
    setSelected(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    setAnchorId(id);
    setActiveId(id);
  };

  const allSelected = sorted.length > 0 && ids.every((id) => selectedSet.has(id));
  const someSelected = !allSelected && ids.some((id) => selectedSet.has(id));

  const startResize = (e: React.PointerEvent, col: DataTableColumn<T>) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = columnWidth(col, widths);
    let latest = widths;
    const move = (ev: PointerEvent) => { latest = resizeColumn(latest, col, startW, ev.clientX - startX); setWidths(latest); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const showStrip = props.summary ?? (selectionMode !== "none" || props.columnChooser !== false);
  const chooser = props.columnChooser !== false;
  const total = props.total ?? sorted.length;
  const cellPad = "px-2";
  const textSize = density === "compact" ? "text-[12.5px]" : "text-[13px]";

  const renderRow = (row: T, index: number, style?: React.CSSProperties) => {
    const id = ids[index];
    const isSelected = selectedSet.has(id);
    const isActive = activeId === id;
    const extra = props.rowProps?.(row);
    return (
      <div
        key={id}
        {...extra}
        role="row"
        aria-selected={selectionMode !== "none" ? isSelected : undefined}
        data-row-id={id}
        data-active={isActive || undefined}
        className={cn("group/row absolute left-0 top-0 flex w-full items-center border-b border-line-quiet outline-none transition-colors row-hover", textSize, isSelected && "row-selected", isActive && "row-active", props.rowClassName?.(row, { selected: isSelected, active: isActive }), extra?.className)}
        style={{ height: rowH, minWidth: gridWidth, ...style, ...extra?.style }}
        onClick={(e) => { extra?.onClick?.(e); if (!e.defaultPrevented) onRowClick(e, row, id); }}
        onDoubleClick={(e) => { extra?.onDoubleClick?.(e); if (!e.defaultPrevented) props.onRowActivate?.(row); }}
      >
        {hasSelectColumn && (
          <div role="gridcell" className="flex shrink-0 items-center justify-center" style={{ width: SELECT_COLUMN_WIDTH }}>
            <Checkbox size="sm" checked={isSelected} onClick={(e) => onCheck(e, id)} onCheckedChange={() => {}} aria-label={t("ui.selectRow")} tabIndex={-1} />
          </div>
        )}
        {cols.map((c) => {
          const w = columnWidth(c, widths);
          const content = c.render ? c.render(row, { index, selected: isSelected, active: isActive }) : formatCell(c.accessor?.(row));
          return (
            <div key={c.id} role="gridcell" className={cn("min-w-0 shrink-0 truncate", cellPad, c.align === "right" && "text-right tabular", c.align === "center" && "text-center", c.className)} style={{ width: w }}>{content}</div>
          );
        })}
        {hasActions && (
          <div role="gridcell" data-row-action className={cn("flex shrink-0 items-center justify-end pr-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100", isActive && "opacity-100")} style={{ width: ACTIONS_COLUMN_WIDTH }}>{props.rowActions!(row)}</div>
        )}
      </div>
    );
  };

  return (
    <div className={cn("flex min-w-0 flex-col", fill && "h-full min-h-0", props.className)} data-density={density}>
      {showStrip && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-[11.5px] text-muted-foreground">
          <span className="tabular">{selectionMode !== "none" ? (i18n.locale === "en" ? selectionSummary(selected.length, total, noun) : selected.length > 0 ? t("table.selected", { selected: selected.length, total: countText(total) }) : countText(total)) : countText(total)}</span>
          {selectionMode === "multi" && selected.length > 0 && <Button variant="ghost" size="xs" className="h-6 px-1.5 text-[11px]" onClick={() => { setSelected([]); setAnchorId(null); }}>{t("common.clear")}</Button>}
          {props.loading && sorted.length > 0 && <Loader2 className="size-3 animate-spin" aria-label={t("common.loading")} />}
          <div className="flex-1" />
          {props.stripActions}
          {chooser && (
            <DropdownMenu>
              <Tip label={t("ui.columnsDensity")}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={t("ui.columnsDensity")}><Columns3 className="size-3.5" /></Button></DropdownMenuTrigger></Tip>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>{t("ui.density")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={density} onValueChange={(v) => setDensity(v as Density)}>
                  <DropdownMenuRadioItem value="compact">{t("ui.compact")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="comfortable">{t("ui.comfortable")}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("ui.columns")}</DropdownMenuLabel>
                {columns.map((c) => (
                  <DropdownMenuCheckboxItem key={c.id} checked={c.locked || !hidden.includes(c.id)} disabled={c.locked} onCheckedChange={() => setHidden(toggleColumn(columns, hidden, c.id))} onSelect={(e) => e.preventDefault()}>{c.label ?? (typeof c.header === "string" ? c.header : c.id)}</DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        role="grid"
        aria-label={props.ariaLabel}
        aria-rowcount={sorted.length}
        aria-multiselectable={selectionMode === "multi" || undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={cn("relative min-h-0 flex-1 overflow-auto scrollbar-thin outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40", !fill && "max-h-full")}
      >
        {/* Header */}
        <div role="row" className="sticky top-0 z-10 flex border-b bg-background grid-head" style={{ height: HEADER_HEIGHT, minWidth: gridWidth }}>
          {hasSelectColumn && (
            <div role="columnheader" className="flex shrink-0 items-center justify-center" style={{ width: SELECT_COLUMN_WIDTH }}>
              <Checkbox size="sm" checked={allSelected ? true : someSelected ? "indeterminate" : false} onCheckedChange={(v) => { setSelected(v ? [...ids] : []); setAnchorId(null); }} aria-label={t("ui.selectAll")} disabled={!sorted.length} />
            </div>
          )}
          {cols.map((c) => {
            const w = columnWidth(c, widths);
            const isSorted = sort?.columnId === c.id;
            const label = (
              <span className={cn("flex min-w-0 items-center gap-1", c.align === "right" && "flex-row-reverse text-right", c.align === "center" && "justify-center")}>
                <span className="truncate">{c.header}</span>
                {isSorted && (sort!.dir === "asc" ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />)}
              </span>
            );
            return (
              <div key={c.id} role="columnheader" aria-sort={isSorted ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined} title={c.title} className={cn("relative flex shrink-0 items-center", cellPad)} style={{ width: w }}>
                {c.sortable ? (
                  <button type="button" onClick={() => setSort(toggleSort(sort, c.id))} className={cn("flex h-full w-full min-w-0 items-center text-left hover:text-foreground cursor-pointer", isSorted && "text-foreground", c.align === "right" && "justify-end")}>{label}</button>
                ) : (
                  <div className={cn("flex w-full min-w-0 items-center", c.align === "right" && "justify-end")}>{label}</div>
                )}
                <div role="separator" aria-orientation="vertical" onPointerDown={(e) => startResize(e, c)} onDoubleClick={() => setWidths({ ...widths, [c.id]: c.width ?? 160 })} className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-ring/40" />
              </div>
            );
          })}
          {hasActions && <div role="columnheader" className="shrink-0" style={{ width: ACTIONS_COLUMN_WIDTH }} />}
        </div>

        {/* Body */}
        {props.error ? (
          <StateRow icon={<AlertCircle className="size-4 text-destructive" />} title={t("state.couldNotLoad")} detail={props.error} />
        ) : props.loading && sorted.length === 0 ? (
          <div className="p-2" aria-busy>
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="mb-1 rounded bg-muted/60" style={{ height: rowH - 8, width: `${92 - (i % 4) * 8}%` }} />)}
          </div>
        ) : sorted.length === 0 ? (
          props.empty ?? <StateRow title={i18n.locale === "en" ? `No ${pluralNoun(noun, 0)}` : t("state.empty")} />
        ) : virtualize ? (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize(), minWidth: gridWidth }}>
            {items.map((v) => renderRow(sorted[v.index], v.index, { transform: `translateY(${v.start}px)` }))}
          </div>
        ) : (
          <div className="relative w-full" style={{ minWidth: gridWidth }}>
            {sorted.map((row, i) => renderRow(row, i, { position: "relative" }))}
          </div>
        )}
      </div>
    </div>
  );
}

function StateRow({ icon, title, detail }: { icon?: React.ReactNode; title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center" role="status">
      {icon}
      <div className="text-[12.5px] font-medium">{title}</div>
      {detail && <div className="max-w-sm text-[11.5px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

function formatCell(v: unknown): React.ReactNode {
  if (v == null || v === "") return <span className="text-muted-foreground">—</span>;
  if (typeof v === "number") return v.toLocaleString();
  if (v instanceof Date) return v.toLocaleDateString();
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}
