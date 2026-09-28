"use client";
import * as React from "react";
import { ChevronDown, Clock, Files, Flame, ShieldAlert, ListChecks, CircleDashed, X, PanelLeftOpen, ListFilter, Users, Lock, Plus, Trash2, Layers } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { SAVED_VIEWS, type FacetBucket, type SavedView, type SearchFilters, type SearchResponse, type SavedSearchRecord, type SortKey } from "../types";
import { useReviewStore } from "./store";
import { useReview } from "./review-page";
import { api, useBatches, useSavedSearches } from "./use-review-data";
import { SectionLabel, issueColorClasses } from "./shared";
import { activeFacetCount } from "./rail-helpers";
import { CustodianHistogram, DateHistogram } from "./histograms";
import { batchDueTone } from "./review-helpers";

export { activeFacetCount };

const VIEW_ICONS: Record<SavedView, React.ElementType> = { all: Files, needs_review: CircleDashed, hot: Flame, privileged: ShieldAlert, ai_responsive: ListChecks, recent: Clock };

export function SearchRail({ response, loading, onSaveSearch }: { response: SearchResponse | null; loading: boolean; onSaveSearch: () => void }) {
  const { issueCodes, viewCounts } = useReview();
  const view = useReviewStore((s) => s.view);
  const setView = useReviewStore((s) => s.setView);
  const filters = useReviewStore((s) => s.filters);
  const toggleFilter = useReviewStore((s) => s.toggleFilter);
  const clearFilters = useReviewStore((s) => s.clearFilters);
  const batchId = useReviewStore((s) => s.batchId);
  const chartsOpen = useReviewStore((s) => s.chartsOpen);
  const setChartsOpen = useReviewStore((s) => s.setChartsOpen);
  // Counts come from the page-level stats fetch so they refresh with the header after every coding change.
  const counts = React.useMemo(() => new Map(viewCounts?.map((v) => [v.view, v.count]) ?? []), [viewCounts]);
  const activeCount = activeFacetCount(filters);
  const facets = response?.facets;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto scrollbar-thin pb-4">
      <SectionLabel>Views</SectionLabel>
      <nav className="px-1.5" aria-label="Views">
        {SAVED_VIEWS.map((v) => {
          const Icon = VIEW_ICONS[v.id];
          const n = counts.get(v.id);
          const on = view === v.id && !batchId;
          return (
            <button key={v.id} onClick={() => setView(v.id)} title={v.hint} className={cn("group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition-colors cursor-pointer", on ? "bg-accent font-medium text-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent")} aria-current={on ? "true" : undefined}>
              <Icon className={cn("size-3.5 shrink-0", on ? "text-primary" : "text-muted-foreground")} />
              <span className="min-w-0 flex-1 truncate">{v.label}</span>
              {n != null ? <span className={cn("tabular text-[11px]", on ? "text-accent-foreground/80" : "text-muted-foreground")}>{n.toLocaleString()}</span> : <Skeleton className="h-3 w-6" />}
            </button>
          );
        })}
      </nav>

      <SavedSearchesSection onSave={onSaveSearch} />
      <BatchesSection />

      <SectionLabel className="pt-3" action={<button type="button" onClick={() => setChartsOpen(!chartsOpen)} className="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer" aria-expanded={chartsOpen}>{chartsOpen ? "Hide" : "Show"}</button>}>Charts</SectionLabel>
      {chartsOpen && (loading || !facets ? <div className="px-3"><Skeleton className="h-20 w-full" /></div> : (
        <div className="space-y-2 px-2.5">
          <div className="text-[11px] text-muted-foreground">Sources · click to filter</div>
          <CustodianHistogram buckets={facets.custodian} selected={filters.custodians ?? []} onToggle={(id) => toggleFilter("custodians", id)} />
          <div className="text-[11px] text-muted-foreground">Dates · click to filter</div>
          <DateHistogram months={facets.months} years={facets.years} selectedMonths={filters.months ?? []} selectedYears={filters.years ?? []} onToggleMonth={(m) => toggleFilter("months", m)} onToggleYear={(y) => toggleFilter("years", y)} />
          {((filters.years?.length ?? 0) > 0 || (filters.months?.length ?? 0) > 0) && (
            <div className="flex flex-wrap gap-1">{[...(filters.years ?? []), ...(filters.months ?? [])].sort().map((k) => <button key={k} onClick={() => toggleFilter(k.length === 4 ? "years" : "months", k)} className="rounded px-1 py-px font-mono text-[10.5px] text-foreground/80 hover:bg-accent cursor-pointer">{k} ×</button>)}</div>
          )}
        </div>
      ))}

      <SectionLabel className="pt-3" action={activeCount > 0 ? <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[11px]" onClick={clearFilters}><X className="size-3" /> Clear {activeCount}</Button> : undefined}>Facets</SectionLabel>
      {loading || !facets ? (
        <div className="space-y-2 px-3 pt-1">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}</div>
      ) : (
        <>
          <FacetGroup title="Source" facetKey="custodians" buckets={facets.custodian} filters={filters} onToggle={toggleFilter} />
          <FacetGroup title="Document type" facetKey="types" buckets={facets.type} filters={filters} onToggle={toggleFilter} />
          <FacetGroup title="Coding status" facetKey="statuses" buckets={facets.status} filters={filters} onToggle={toggleFilter} hideZero={false} />
          <FacetGroup title="Issue codes" facetKey="issues" buckets={facets.issues} filters={filters} onToggle={toggleFilter} renderLabel={(b) => { const ic = issueCodes.find((c) => c.code === b.value); const cls = issueColorClasses(ic?.color); return <span className="flex min-w-0 items-center gap-1.5"><span className={cn("size-1.5 shrink-0 rounded-full", cls.dot)} /><span className="font-mono text-[11px]">{b.value}</span><span className="truncate text-muted-foreground">{b.label}</span></span>; }} />
          {facets.score.some((b) => b.value !== "unscored" && b.count > 0) && <FacetGroup title="Suggested score" facetKey="scores" buckets={facets.score} filters={filters} onToggle={toggleFilter} hideZero={false} />}
          {!response?.totalWorkspace && <p className="px-3 pt-1 text-[11.5px] text-muted-foreground">Facets appear once the matter has documents.</p>}
        </>
      )}
    </div>
  );
}

/** Saved searches of the matter (own + shared): apply, delete own, save the current one. */
function SavedSearchesSection({ onSave }: { onSave: () => void }) {
  const { matterId, currentUserId } = useReview();
  const saved = useSavedSearches(matterId);
  const q = useReviewStore((s) => s.q);
  const [open, setOpen] = React.useState(true);
  const apply = (s: SavedSearchRecord) => {
    const st = useReviewStore.getState();
    st.setBatch(null);
    st.setQ(s.q);
    st.setView((s.view as SavedView | undefined) ?? "all");
    st.setFilters((s.filters as SearchFilters | undefined) ?? {});
    st.setSemantic(!!s.semantic);
    st.setSortState((s.sort as SortKey | undefined) ?? undefined, s.dir);
    void api(`/api/ediscovery/saved-searches/${encodeURIComponent(s.id)}`, { method: "POST" }).then(() => saved.refresh()).catch(() => {});
  };
  const remove = async (s: SavedSearchRecord) => {
    try { await api(`/api/ediscovery/saved-searches/${encodeURIComponent(s.id)}`, { method: "DELETE" }); saved.refresh(); toast.success(`Deleted “${s.name}”`); } catch (e) { toast.error("Could not delete", { description: (e as Error).message }); }
  };
  const list = saved.data?.searches ?? [];
  return (
    <div className="pt-3">
      <SectionLabel className="pt-0" action={<span className="flex items-center gap-0.5"><Tip label="Save the current query, view and facets"><Button variant="ghost" size="icon-xs" className="size-5" onClick={onSave} aria-label="Save current search"><Plus className="size-3" /></Button></Tip><button type="button" onClick={() => setOpen(!open)} className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" aria-expanded={open} aria-label="Toggle saved searches"><ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} /></button></span>}>Saved searches</SectionLabel>
      {open && (
        <ul className="px-1.5" aria-label="Saved searches">
          {!saved.data && <li className="px-2 py-1"><Skeleton className="h-4 w-full" /></li>}
          {saved.data && !list.length && <li className="px-2 py-1 text-[11px] text-muted-foreground">None yet — save a query with +.</li>}
          {list.map((s) => {
            const on = q === s.q && !!s.q;
            return (
              <li key={s.id} className="group/ss flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] hover:bg-sidebar-accent">
                <button type="button" onClick={() => apply(s)} title={`${s.description ?? ""}\n${s.q}`.trim()} className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-left cursor-pointer", on && "font-medium text-foreground")}>
                  {s.shared ? <Users className="size-3 shrink-0 text-muted-foreground" aria-label="Shared" /> : <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />}
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {s.lastRunCount != null && <span className="tabular text-[11px] text-muted-foreground">{s.lastRunCount.toLocaleString()}</span>}
                </button>
                {s.ownerId === currentUserId && <button type="button" onClick={() => void remove(s)} className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover/ss:opacity-100 focus-visible:opacity-100 cursor-pointer" aria-label={`Delete ${s.name}`}><Trash2 className="size-3" /></button>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Batches assigned to the signed-in reviewer (all open batches when none are); click opens batch review mode. */
function BatchesSection() {
  const { matterId, currentUserId, setTab } = useReview();
  const batches = useBatches(matterId);
  const batchId = useReviewStore((s) => s.batchId);
  const setBatch = useReviewStore((s) => s.setBatch);
  const [open, setOpen] = React.useState(true);
  const all = (batches.data?.batches ?? []).filter((b) => b.status !== "complete");
  const mine = all.filter((b) => b.assigneeId === currentUserId);
  const list = mine.length ? mine : all;
  return (
    <div className="pt-3">
      <SectionLabel className="pt-0" action={<span className="flex items-center gap-0.5"><Tip label="Manage batches"><Button variant="ghost" size="icon-xs" className="size-5" onClick={() => setTab("batches")} aria-label="Manage batches"><Layers className="size-3" /></Button></Tip><button type="button" onClick={() => setOpen(!open)} className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" aria-expanded={open} aria-label="Toggle batches"><ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} /></button></span>}>{mine.length ? "My batches" : "Open batches"}</SectionLabel>
      {open && (
        <ul className="px-1.5" aria-label="Batches">
          {!batches.data && <li className="px-2 py-1"><Skeleton className="h-4 w-full" /></li>}
          {batches.data && !list.length && <li className="px-2 py-1 text-[11px] text-muted-foreground">No open batches.</li>}
          {list.slice(0, 8).map((b) => {
            const on = batchId === b.id;
            const tone = batchDueTone(b.dueAt, b.status);
            return (
              <li key={b.id}>
                <button type="button" onClick={() => setBatch(on ? null : b.id)} title={`${b.name}${b.dueAt ? ` · due ${b.dueAt}` : ""} · ${b.progress.coded}/${b.progress.total} coded`} className={cn("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] cursor-pointer", on ? "bg-accent font-medium text-accent-foreground" : "hover:bg-sidebar-accent")} aria-pressed={on}>
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  <span className={cn("shrink-0 tabular text-[11px]", tone === "destructive" ? "text-destructive" : tone === "warning" ? "text-warning-foreground dark:text-warning" : "text-muted-foreground")}>{b.progress.coded}/{b.progress.total}</span>
                </button>
              </li>
            );
          })}
          {list.length > 8 && <li><button type="button" onClick={() => setTab("batches")} className="px-2 py-1 text-[11px] text-primary hover:underline cursor-pointer">All {list.length} batches</button></li>}
        </ul>
      )}
    </div>
  );
}

/** Collapsed rail: the views as an icon column with counts, plus a badge for active facets. */
export function SearchRailCollapsed({ onExpand }: { onExpand: () => void }) {
  const { viewCounts } = useReview();
  const view = useReviewStore((s) => s.view);
  const setView = useReviewStore((s) => s.setView);
  const filters = useReviewStore((s) => s.filters);
  const counts = React.useMemo(() => new Map(viewCounts?.map((v) => [v.view, v.count]) ?? []), [viewCounts]);
  const active = activeFacetCount(filters);
  return (
    <div className="flex h-full flex-col items-center gap-1 py-2" aria-label="Views (collapsed)">
      <Tip label="Show views, saved searches and facets" side="right"><Button variant="ghost" size="icon-xs" onClick={onExpand} aria-label="Expand rail"><PanelLeftOpen className="size-4" /></Button></Tip>
      <span className="my-1 h-px w-6 bg-border" aria-hidden />
      {SAVED_VIEWS.map((v) => {
        const Icon = VIEW_ICONS[v.id];
        const n = counts.get(v.id);
        const on = view === v.id;
        return (
          <Tip key={v.id} label={`${v.label}${n != null ? ` · ${n.toLocaleString()}` : ""}`} side="right">
            <button onClick={() => setView(v.id)} aria-label={v.label} aria-current={on ? "true" : undefined} className={cn("relative flex size-8 items-center justify-center rounded-md transition-colors cursor-pointer", on ? "bg-accent text-primary" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground")}>
              <Icon className="size-4" />
              {n != null && n > 0 && <span className="absolute -right-1 -top-0.5 min-w-[14px] text-center text-[9.5px] tabular leading-[14px] text-muted-foreground">{n > 999 ? "1k" : n}</span>}
            </button>
          </Tip>
        );
      })}
      {active > 0 && (
        <>
          <span className="my-1 h-px w-6 bg-border" aria-hidden />
          <Tip label={`${active} facet filter${active === 1 ? "" : "s"} active · expand to edit`} side="right">
            <button onClick={onExpand} className="relative flex size-8 items-center justify-center rounded-md text-primary hover:bg-sidebar-accent cursor-pointer" aria-label="Active filters"><ListFilter className="size-4" /><span className="absolute -right-1 -top-0.5 min-w-[14px] text-center text-[9.5px] font-medium tabular leading-[14px] text-foreground">{active}</span></button>
          </Tip>
        </>
      )}
    </div>
  );
}

function FacetGroup({ title, facetKey, buckets, filters, onToggle, hideZero = true, renderLabel }: { title: string; facetKey: keyof SearchFilters; buckets: FacetBucket[]; filters: SearchFilters; onToggle: (k: keyof SearchFilters, v: string) => void; hideZero?: boolean; renderLabel?: (b: FacetBucket) => React.ReactNode }) {
  const [open, setOpen] = React.useState(true);
  const [showAll, setShowAll] = React.useState(false);
  const active = (filters[facetKey] as string[] | undefined) ?? [];
  const visible = buckets.filter((b) => !hideZero || b.count > 0 || active.includes(b.value));
  const list = showAll ? visible : visible.slice(0, 8);
  if (!visible.length) return null;
  return (
    <div className="px-1.5 pt-1.5">
      <button onClick={() => setOpen(!open)} className="flex h-6 w-full items-center justify-between rounded px-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground cursor-pointer" aria-expanded={open}>
        <span>{title}{active.length > 0 && <span className="ml-1.5 tabular text-[11px] text-foreground">{active.length}</span>}</span>
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <ul className="pb-1">
          {list.map((b) => {
            const checked = active.includes(b.value);
            return (
              <li key={b.value}>
                <label className={cn("flex h-6 cursor-pointer items-center gap-2 rounded px-1.5 text-[11.5px] hover:bg-sidebar-accent", checked && "bg-accent/60")}>
                  <Checkbox size="xs" checked={checked} onCheckedChange={() => onToggle(facetKey, b.value)} aria-label={b.label} />
                  <span className="min-w-0 flex-1 truncate">{renderLabel ? renderLabel(b) : b.label}</span>
                  <span className={cn("tabular text-[11px]", b.count === 0 ? "text-muted-foreground/50" : "text-muted-foreground")}>{b.count.toLocaleString()}</span>
                </label>
              </li>
            );
          })}
          {visible.length > 8 && <li><button onClick={() => setShowAll(!showAll)} className="px-1.5 py-1 text-[11px] text-primary hover:underline cursor-pointer">{showAll ? "Show fewer" : `Show all ${visible.length}`}</button></li>}
        </ul>
      )}
    </div>
  );
}
