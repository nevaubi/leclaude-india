"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, Newspaper, RefreshCw, Rss, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTopbar } from "@/components/shell/page-topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { NEWS_SOURCES } from "../sources";
import { articleSortKey, type NewsListItem, type NewsListResponse, type NewsSourcesResponse } from "../types";
import { TimeAgo, courtShort, istDayKey, istDayLabel, newsApi, newsQueryString, requestRefresh, useNow } from "./news-ui";
import { SourcesPanel } from "./sources-panel";
import { LeadStory, SideStory, StoryCard, StoryRow } from "./news-cards";
import { pickFeatured } from "../featured";

const ALL = "__all__";
const PAGE = 50;

export interface NewsFilters { source: string | null; court: string | null; q: string }

function groupByDay(items: NewsListItem[]): Array<{ key: string; items: NewsListItem[] }> {
  const groups: Array<{ key: string; items: NewsListItem[] }> = [];
  for (const it of items) {
    const key = istDayKey(articleSortKey(it));
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(it);
    else groups.push({ key, items: [it] });
  }
  return groups;
}

/**
 * /news: a reading surface for Indian legal headlines. Front page (lead story with a large image, side stories, a card
 * row) then every other headline grouped by day (IST); publisher chips, court and text filters; the feed sources panel.
 */
export function NewsBrowser({ initial, initialSources, initialFilters }: { initial: NewsListResponse; initialSources: NewsSourcesResponse; initialFilters: NewsFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  const now = useNow();
  const [filters, setFilters] = React.useState<NewsFilters>(initialFilters);
  const [query, setQuery] = React.useState(initialFilters.q);
  const [data, setData] = React.useState<NewsListResponse>(initial);
  const [sources, setSources] = React.useState<NewsSourcesResponse | null>(initialSources);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [mobileView, setMobileView] = React.useState<"list" | "sources">("list");
  const first = React.useRef(true);
  const reqId = React.useRef(0);

  React.useEffect(() => { if (window.location.hash === "#sources") setMobileView("sources"); }, []);

  // Debounced text search.
  React.useEffect(() => {
    const id = window.setTimeout(() => setFilters((f) => (f.q === query ? f : { ...f, q: query })), 250);
    return () => window.clearTimeout(id);
  }, [query]);

  const load = React.useCallback(async (f: NewsFilters) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const next = await newsApi<NewsListResponse>(`/api/news${newsQueryString({ ...f, limit: PAGE })}`);
      if (id === reqId.current) { setData(next); setError(null); }
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : "Could not load headlines");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  const loadSources = React.useCallback(async () => {
    try { setSources(await newsApi<NewsSourcesResponse>("/api/news/sources")); } catch { /* keep the last status */ }
  }, []);

  // Filters → URL (replace, so typing does not flood history) and data.
  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    const qs = newsQueryString({ source: filters.source, court: filters.court, q: filters.q });
    router.replace(`${pathname}${qs}`, { scroll: false });
    void load(filters);
  }, [filters, load, pathname, router]);

  // First visit after a quiet period: ask the server for fresh headlines (it throttles to one run per 15 min).
  React.useEffect(() => {
    const last = initial.lastRun ? Date.parse(initial.lastRun.startedAt) : NaN;
    if (Number.isFinite(last) && Date.now() - last < 15 * 60_000) return;
    void (async () => {
      setRefreshing(true);
      const r = await requestRefresh({ notify: false });
      setRefreshing(false);
      if (r?.status === "ran") { void loadSources(); void load(filters); }
    })();
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await requestRefresh({ notify: true });
    setRefreshing(false);
    await Promise.all([load(filters), loadSources()]);
  };

  const more = async () => {
    if (!data.nextBefore) return;
    setLoadingMore(true);
    try {
      const next = await newsApi<NewsListResponse>(`/api/news${newsQueryString({ ...filters, limit: PAGE, before: data.nextBefore })}`);
      setData((d) => ({ ...next, items: [...d.items, ...next.items.filter((n) => !d.items.some((x) => x.id === n.id))] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more headlines");
    } finally { setLoadingMore(false); }
  };

  const featured = React.useMemo(() => pickFeatured(data.items, !filters.q), [data.items, filters.q]);
  const groups = React.useMemo(() => groupByDay(featured.rest), [featured.rest]);
  const courtOptions = React.useMemo(() => Object.entries(data.facets.courts).sort((a, b) => b[1] - a[1] || courtShort(a[0]).localeCompare(courtShort(b[0]))), [data.facets.courts]);
  const filtered = !!(filters.source || filters.court || filters.q);
  const allFailed = !!data.lastRun && data.lastRun.feeds.length > 0 && data.lastRun.feeds.every((f) => !f.ok);
  const clear = () => { setQuery(""); setFilters({ source: null, court: null, q: "" }); };
  const totalAll = Object.values(data.facets.sources).reduce((n, x) => n + x, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar
        icon={<Newspaper />}
        title="News"
        context={<span suppressHydrationWarning>Indian legal headlines{data.lastSuccessAt ? <> · updated <TimeAgo iso={data.lastSuccessAt} now={now} /></> : null}{refreshing ? " · checking feeds…" : null}</span>}
      >
        <div className="flex-1" />
        <Button variant="ghost" size="xs" className="xl:hidden" onClick={() => setMobileView((v) => (v === "list" ? "sources" : "list"))} aria-pressed={mobileView === "sources"}>
          <Rss className="size-3.5" />{mobileView === "sources" ? "Headlines" : "Sources"}
        </Button>
        <Button variant="outline" size="xs" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh legal news">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} /><span className="hidden sm:inline">{refreshing ? "Refreshing…" : "Refresh"}</span>
        </Button>
      </PageTopbar>
      <div className="flex min-h-0 flex-1">
        <main className={cn("@container flex min-w-0 flex-1 flex-col", mobileView === "sources" && "hidden xl:flex")}>
          <div className="shrink-0 space-y-2 border-b px-3 py-2 @3xl:px-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-48 @2xl:max-w-xs">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input size="xs" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search headlines…" className="w-full pl-7" aria-label="Search headlines" />
              </div>
              <Select value={filters.court ?? ALL} onValueChange={(v) => setFilters((f) => ({ ...f, court: v === ALL ? null : v }))}>
                <SelectTrigger size="xs" className="w-[10.5rem] text-[11.5px]" aria-label="Court"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All courts</SelectItem>
                  {courtOptions.map(([id, n]) => <SelectItem key={id} value={id}>{courtShort(id)}<span className="ml-1 tabular text-muted-foreground">{n}</span></SelectItem>)}
                  {filters.court && !data.facets.courts[filters.court] && <SelectItem value={filters.court}>{courtShort(filters.court)}</SelectItem>}
                </SelectContent>
              </Select>
              {filtered && <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={clear}><X className="size-3" />Clear</Button>}
              <span className="ml-auto text-[11px] tabular text-muted-foreground" aria-live="polite">{loading ? "Loading…" : `${data.total.toLocaleString("en-IN")} headline${data.total === 1 ? "" : "s"}`}</span>
            </div>
            <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-0.5 scrollbar-thin" role="group" aria-label="Publisher">
              <Chip active={!filters.source} onClick={() => setFilters((f) => ({ ...f, source: null }))} count={totalAll}>All publishers</Chip>
              {NEWS_SOURCES.map((s) => (
                <Chip key={s.id} active={filters.source === s.id} onClick={() => setFilters((f) => ({ ...f, source: f.source === s.id ? null : s.id }))} count={data.facets.sources[s.id] ?? 0}>
                  {s.publisher.replace(/\s*\(.*\)$/, "")}
                </Chip>
              ))}
            </div>
          </div>
          {(data.stale || allFailed) && data.items.length > 0 && (
            <div className="flex shrink-0 items-center gap-1.5 border-b bg-warning/10 px-3 py-1.5 text-[11px]" role="status">
              <AlertTriangle className="size-3 shrink-0 text-warning" />
              <span className="min-w-0 truncate">{data.lastSuccessAt ? <>Feeds last reached <TimeAgo iso={data.lastSuccessAt} now={now} />; these are the stored headlines.</> : "The feeds have not been reached yet."}</span>
            </div>
          )}
          {error && (
            <div className="flex shrink-0 items-center gap-1.5 border-b bg-destructive/5 px-3 py-1.5 text-[11px] text-destructive" role="alert">
              <AlertTriangle className="size-3 shrink-0" /><span className="min-w-0 truncate">{error}</span>
              <Button variant="ghost" size="xs" className="ml-auto h-5" onClick={() => void load(filters)}>Retry</Button>
            </div>
          )}
          <div className={cn("min-h-0 flex-1 overflow-y-auto scrollbar-thin", loading && "opacity-60 transition-opacity")}>
            {data.items.length === 0 ? (
              loading || (refreshing && !filtered) ? (
                <NewsSkeleton />
              ) : filtered ? (
                <EmptyState icon={Search} title="No headlines match" description="Try another publisher, court or search term." action={<Button size="xs" variant="outline" onClick={clear}>Clear filters</Button>} />
              ) : allFailed ? (
                <EmptyState icon={AlertTriangle} title="The news feeds could not be reached" description={<>{data.lastRun?.feeds[0]?.error ?? "Every feed failed."} See Sources for each feed&apos;s status.</>} action={<Button size="xs" variant="outline" onClick={() => void refresh()}>Try again</Button>} />
              ) : (
                <EmptyState icon={Newspaper} title="No headlines yet" description="Headlines from Indian legal publishers appear here after the first check of their feeds." action={<Button size="xs" variant="outline" onClick={() => void refresh()}>Check now</Button>} />
              )
            ) : (
              <div className="mx-auto w-full max-w-[76rem] px-3 pb-8 @3xl:px-6">
                {featured.lead && (
                  <section aria-label="Top stories" className="grid gap-x-7 gap-y-5 border-b pb-6 pt-4 @2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                    <LeadStory item={featured.lead} now={now} />
                    {featured.side.length > 0 && <div className="divide-y @2xl:border-l @2xl:pl-6">{featured.side.map((n) => <SideStory key={n.id} item={n} now={now} />)}</div>}
                  </section>
                )}
                {featured.grid.length > 0 && (
                  <section aria-label="More stories" className="border-b py-5">
                    <div className="grid grid-cols-1 gap-x-5 gap-y-6 @lg:grid-cols-2 @4xl:grid-cols-4">{featured.grid.map((n) => <StoryCard key={n.id} item={n} now={now} />)}</div>
                  </section>
                )}
                {groups.map((g) => (
                  <section key={g.key} aria-label={istDayLabel(g.key, null)}>
                    <h2 className="sticky top-0 z-10 -mx-3 border-b bg-background/95 px-3 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground backdrop-blur @3xl:-mx-6 @3xl:px-6" suppressHydrationWarning>{istDayLabel(g.key, now)}</h2>
                    <ul className="-mx-3 divide-y">{g.items.map((n) => <StoryRow key={n.id} item={n} now={now} />)}</ul>
                  </section>
                ))}
                {data.nextBefore && (
                  <div className="flex justify-center border-t py-3">
                    <Button size="xs" variant="outline" onClick={() => void more()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load older headlines"}</Button>
                  </div>
                )}
                <p className="pt-4 text-center text-[11px] text-muted-foreground">Headlines and images link to and belong to their publishers; summaries are the publisher&apos;s own.</p>
              </div>
            )}
          </div>
        </main>
        <SourcesPanel data={sources} now={now} className={cn("w-full border-l xl:w-72 2xl:w-80", mobileView === "list" ? "hidden xl:flex" : "flex")} />
      </div>
    </div>
  );
}

function Chip({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[var(--radius-chip)] border px-2 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary/40 bg-primary/10 font-medium text-primary" : "border-border text-foreground/80 hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
      <span className={cn("tabular text-[10.5px]", active ? "text-primary/80" : "text-muted-foreground")}>{count}</span>
    </button>
  );
}

function NewsSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[76rem] px-3 pt-4 @3xl:px-6" aria-busy="true" aria-label="Loading headlines">
      <div className="grid gap-x-7 gap-y-5 border-b pb-6 @2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-2.5"><Skeleton className="aspect-[16/9] w-full" /><Skeleton className="h-3 w-40" /><Skeleton className="h-5 w-[90%]" /><Skeleton className="h-5 w-[70%]" /></div>
        <div className="space-y-5">{Array.from({ length: 3 }, (_, i) => <div key={i} className="flex gap-3"><div className="flex-1 space-y-2"><Skeleton className="h-3 w-32" /><Skeleton className="h-4 w-[90%]" /><Skeleton className="h-4 w-[60%]" /></div><Skeleton className="aspect-[4/3] w-[104px]" /></div>)}</div>
      </div>
      <ul className="divide-y">{Array.from({ length: 5 }, (_, i) => <li key={i} className="flex gap-3 py-3"><div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-44" /><Skeleton className="h-3.5 w-[80%]" /></div><Skeleton className="hidden aspect-[3/2] w-[120px] @md:block" /></li>)}</ul>
    </div>
  );
}
