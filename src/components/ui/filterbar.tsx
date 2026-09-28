"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import { Bookmark, Check, ChevronDown, Loader2, Plus, Search, Trash2, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu";
import { activeFilterCount, chipLabel, clearFilters, findMatchingView, toggleFilterValue, type FilterOption, type FilterValues, type SavedView } from "./filterbar-helpers";

export type { FilterOption, FilterValues, SavedView } from "./filterbar-helpers";

export interface FilterbarFilter {
  id: string;
  label: string;
  options: FilterOption[];
  multi?: boolean;
  icon?: LucideIcon;
  /** Free-text date (YYYY-MM-DD) instead of an option list. */
  kind?: "select" | "date";
  /** Show even when the chip has no value (default true). Hidden chips appear under the "+ Filter" menu. */
  pinned?: boolean;
}

export interface FilterbarProps {
  filters: FilterbarFilter[];
  values: FilterValues;
  onChange: (values: FilterValues) => void;
  query?: string;
  onQueryChange?: (q: string) => void;
  queryPlaceholder?: string;
  queryLoading?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  savedViews?: SavedView[];
  onSaveView?: (name: string) => void;
  onApplyView?: (view: SavedView) => void;
  onDeleteView?: (id: string) => void;
  /** Left slot (breadcrumb, title). */
  leading?: React.ReactNode;
  /** Right slot (sort, view mode, primary action). */
  children?: React.ReactNode;
  /** One-line status under the chips ("42 results · 120 ms"). */
  status?: React.ReactNode;
  className?: string;
  size?: "xs" | "sm";
}

/**
 * One 36px toolbar for every list: quick search, chip filters (single or multi
 * select popovers, dates), a clear action, saved views and a trailing slot for
 * sort and view controls.
 */
export function Filterbar(p: FilterbarProps) {
  const t = useT();
  const n = activeFilterCount(p.values);
  const snapshot = React.useMemo(() => ({ values: p.values, query: p.query }), [p.values, p.query]);
  const activeView = p.savedViews ? findMatchingView(p.savedViews, snapshot) : undefined;
  const unpinned = p.filters.filter((f) => f.pinned === false && !p.values[f.id]);
  const [reveal, setReveal] = React.useState<string[]>([]);
  const visible = p.filters.filter((f) => f.pinned !== false || p.values[f.id] || reveal.includes(f.id));
  const inputSize = p.size ?? "xs";
  return (
    <div className={cn("shrink-0 border-b bg-background", p.className)}>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 px-2 py-1">
        {p.leading}
        {p.onQueryChange && (
          <div className="relative w-full sm:w-44 xl:w-56">
            {p.queryLoading ? <Loader2 className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" /> : <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />}
            <Input ref={p.inputRef} size={inputSize} value={p.query ?? ""} onChange={(e) => p.onQueryChange?.(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { p.onQueryChange?.(""); (e.target as HTMLInputElement).blur(); } }} placeholder={p.queryPlaceholder ?? t("common.searchEllipsis")} className="ps-7 pe-7" aria-label={p.queryPlaceholder ?? t("common.search")} />
            <div className="absolute end-1.5 top-1/2 -translate-y-1/2">
              {p.query ? <button type="button" onClick={() => p.onQueryChange?.("")} className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" aria-label={t("ui.clearSearch")}><X className="size-3" /></button> : <kbd className="hidden sm:inline">/</kbd>}
            </div>
          </div>
        )}
        {visible.map((f) => <FilterChip key={f.id} filter={f} value={p.values[f.id]} onChange={(next) => p.onChange(next)} values={p.values} />)}
        {unpinned.some((f) => !reveal.includes(f.id)) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="xs" className="h-7 gap-1 px-2 text-[11.5px] text-muted-foreground"><Plus className="size-3" /> {t("common.filter")}</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              {unpinned.filter((f) => !reveal.includes(f.id)).map((f) => <DropdownMenuItem key={f.id} onClick={() => setReveal((r) => [...r, f.id])}>{f.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {n > 0 && <Button variant="ghost" size="xs" className="h-7 px-2 text-[11.5px] text-muted-foreground" onClick={() => { p.onChange(clearFilters(p.values)); setReveal([]); }}>Clear{n > 1 ? ` ${n}` : ""}</Button>}
        {p.savedViews && (
          <SavedViewsMenu views={p.savedViews} active={activeView} canSave={Boolean(p.onSaveView) && (n > 0 || Boolean(p.query?.trim()))} onSave={p.onSaveView} onApply={p.onApplyView} onDelete={p.onDeleteView} />
        )}
        <div className="flex-1" />
        {p.children}
      </div>
      {p.status && <div className="flex items-center gap-2 px-3 pb-1.5 text-[11px] text-muted-foreground">{p.status}</div>}
    </div>
  );
}

function FilterChip({ filter: f, value, values, onChange }: { filter: FilterbarFilter; value: FilterValues[string]; values: FilterValues; onChange: (v: FilterValues) => void }) {
  const t = useT();
  const active = Array.isArray(value) ? value.length > 0 : Boolean(value);
  const label = chipLabel(f.label, value, (v) => f.options.find((o) => o.value === v)?.label);
  const Icon = f.icon;
  const clear = (e: React.MouseEvent) => { e.stopPropagation(); onChange({ ...values, [f.id]: undefined }); };
  const chipCls = cn("inline-flex h-7 max-w-[240px] items-center gap-1 rounded-[var(--radius-chip)] border border-transparent px-2 text-[11.5px] font-medium transition-colors cursor-pointer", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground");
  if (f.kind === "date") {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={chipCls} aria-pressed={active}>{Icon && <Icon className="size-3" />}<span className="truncate">{label}</span>{active ? <span role="button" aria-label={`Clear ${f.label}`} onClick={clear} className="ml-0.5 rounded p-0.5 hover:bg-foreground/10"><X className="size-3" /></span> : <ChevronDown className="size-3 opacity-60" />}</button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">{f.label}</div>
          <Input type="date" size="xs" value={typeof value === "string" ? value : ""} onChange={(e) => onChange({ ...values, [f.id]: e.target.value || undefined })} className="tabular" />
        </PopoverContent>
      </Popover>
    );
  }
  const selectedSet = new Set(Array.isArray(value) ? value : value ? [String(value)] : []);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={chipCls} aria-pressed={active}>{Icon && <Icon className="size-3" />}<span className="truncate">{label}</span>{active ? <span role="button" aria-label={`Clear ${f.label}`} onClick={clear} className="ml-0.5 rounded p-0.5 hover:bg-foreground/10"><X className="size-3" /></span> : <ChevronDown className="size-3 opacity-60" />}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-80 w-60 overflow-y-auto p-1 scrollbar-thin">
        <div className="px-2 py-1 text-[11.5px] text-muted-foreground">{f.label}{f.multi ? " · any of" : ""}</div>
        {f.options.length === 0 && <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground">{t("ui.noOptions")}</div>}
        {f.options.map((o) => {
          const on = selectedSet.has(o.value);
          return (
            <button key={o.value} type="button" onClick={() => onChange(toggleFilterValue(values, f.id, o.value, { multi: f.multi }))} className={cn("flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent cursor-pointer", on && "bg-accent/70")} role={f.multi ? "menuitemcheckbox" : "menuitemradio"} aria-checked={on}>
              <span className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>{on && <Check className="size-2.5" />}</span>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.count != null && <span className="tabular text-[10.5px] text-muted-foreground">{o.count}</span>}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function SavedViewsMenu({ views, active, canSave, onSave, onApply, onDelete }: { views: SavedView[]; active?: SavedView; canSave: boolean; onSave?: (name: string) => void; onApply?: (v: SavedView) => void; onDelete?: (id: string) => void }) {
  const t = useT();
  const [saving, setSaving] = React.useState(false);
  const [name, setName] = React.useState("");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className={cn("h-7 gap-1 px-2 text-[11.5px]", active ? "text-foreground" : "text-muted-foreground")} aria-label={t("ui.savedViews")}><Bookmark className={cn("size-3", active && "fill-current")} /><span className="hidden xl:inline">{active ? active.name : t("ui.views")}</span><ChevronDown className="size-3 opacity-60" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>{t("ui.savedViews")}</DropdownMenuLabel>
          {views.length === 0 && <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground">{t("ui.noSavedViews")}</div>}
          {views.map((v) => (
            <DropdownMenuItem key={v.id} onClick={() => onApply?.(v)} className="group/view">
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              {active?.id === v.id && <Check className="size-3.5 text-primary" />}
              {onDelete && <button type="button" onClick={(e) => { e.stopPropagation(); e.preventDefault(); onDelete(v.id); }} className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover/view:opacity-100" aria-label={`Delete view ${v.name}`}><Trash2 className="size-3" /></button>}
            </DropdownMenuItem>
          ))}
          {onSave && (<><DropdownMenuSeparator /><DropdownMenuItem disabled={!canSave} onClick={() => { setName(""); setSaving(true); }}><Plus /> {t("ui.saveCurrentView")}</DropdownMenuItem></>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover open={saving} onOpenChange={setSaving}>
        <PopoverTrigger asChild><span className="sr-only" aria-hidden /></PopoverTrigger>
        <PopoverContent align="start" className="w-64 space-y-2 p-3">
          <div className="text-[12px] font-medium">{t("ui.saveView")}</div>
          <Input size="sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ui.viewNamePlaceholder")} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { onSave?.(name.trim()); setSaving(false); } }} />
          <div className="flex justify-end gap-1.5"><Button variant="ghost" size="xs" onClick={() => setSaving(false)}>{t("common.cancel")}</Button><Button size="xs" disabled={!name.trim()} onClick={() => { onSave?.(name.trim()); setSaving(false); }}>{t("common.save")}</Button></div>
        </PopoverContent>
      </Popover>
    </>
  );
}
