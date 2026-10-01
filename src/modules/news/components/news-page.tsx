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
import { articleSortKey, type NewsArticle, type NewsListResponse, type NewsSourcesResponse } from "../types";
import { HeadlineRow, TimeAgo, courtShort, istDayKey, istDayLabel, newsApi, newsQueryString, requestRefresh, useNow } from "./news-ui";
import { SourcesPanel } from "./sources-panel";

const ALL = "__all__";
const PAGE = 50;

export interface NewsFilters { source: string | null; court: string | null; q: string }

function groupByDay(items: NewsArticle[]): Array<{ key: string; items: NewsArticle[] }> {
  const groups: Array<{ key: string; items: NewsArticle[] }> = [];
  for (const it of items) {
    const key = istDayKey(articleSortKey(it));
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(it);
    else groups.push({ key, items: [it] });
  }
  return groups;
}

/** /news: every stored headline, filterable by source, court label and text, grouped by day (IST), with the sources. */
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

  const groups = React.useMemo(() => groupByDay(data.items), [data.items]);
  const courtOptions = React.useMemo(() => Object.entries(data.facets.courts).sort((a, b) => b[1] - a[1] || courtShort(a[0]).localeCompare(courtShort(b[0]))), [data.facets.courts]);
  const filtered = !!(filters.source || filters.court || filters.q);
  const allFailed = !!data.lastRun && data.lastRun.feeds.length > 0 && data.lastRun.feeds.every((f) => !f.ok);
  const clear = () => { setQuery(""); setFilters({ source: null, court: null, q: "" }); };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar icon={<Newspaper />} title="News" context={data.lastSuccessAt ? <>Indian legal headlines · updated <TimeAgo iso={data.lastSuccessAt} now={now} /></> : "Indian legal headlines"}>
        <div className="flex-1" />
        <Button variant="ghost" size="xs" className="lg:hidden" onClick={() => setMobileView((v) => (v === "list" ? "sources" : "list"))} aria-pressed={mobileView === "sources"}>
          <Rss className="size-3.5" />{mobileView === "sources" ? "Headlines" : "Sources"}
        </Button>
        <Button variant="outline" size="xs" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh legal news">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} /><span className="hidden sm:inline">Refresh</span>
        </Button>
      </PageTopbar>
      <div className="flex min-h-0 flex-1">
        <main className={cn("flex min-w-0 flex-1 flex-col", mobileView === "sources" && "hidden lg:flex")}>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
            <div className="relative min-w-0 flex-1 basis-48 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input size="xs" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search headlines…" className="w-full pl-7" aria-label="Search headlines" />
            </div>
            <Select value={filters.source ?? ALL} onValueChange={(v) => setFilters((f) => ({ ...f, source: v === ALL ? null : v }))}>
              <SelectTrigger size="xs" className="w-[9.5rem] text-[11.5px]" aria-label="Source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All sources</SelectItem>
                {NEWS_SOURCES.map((s) => <SelectItem key={s.id} value={s.id}>{s.publisher}<span className="ml-1 tabular text-muted-foreground">{data.facets.sources[s.id] ?? 0}</span></SelectItem>)}
              </SelectContent>
            </Select>
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
                <ul className="mx-auto max-w-4xl divide-y" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <li key={i} className="space-y-1.5 px-3 py-3"><Skeleton className="h-3 w-44" /><Skeleton className="h-3.5 w-[80%]" /></li>)}</ul>
              ) : filtered ? (
                <EmptyState icon={Search} title="No headlines match" description="Try another source, court or search term." action={<Button size="xs" variant="outline" onClick={clear}>Clear filters</Button>} />
              ) : allFailed ? (
                <EmptyState icon={AlertTriangle} title="The news feeds could not be reached" description={<>{data.lastRun?.feeds[0]?.error ?? "Every feed failed."} See Sources for each feed&apos;s status.</>} action={<Button size="xs" variant="outline" onClick={() => void refresh()}>Try again</Button>} />
              ) : (
                <EmptyState icon={Newspaper} title="No headlines yet" description="Headlines from Indian legal publishers appear here after the first check of their feeds." action={<Button size="xs" variant="outline" onClick={() => void refresh()}>Check now</Button>} />
              )
            ) : (
              <div className="mx-auto w-full max-w-4xl pb-6">
                {groups.map((g) => (
                  <section key={g.key} aria-label={istDayLabel(g.key, null)}>
                    <h2 className="sticky top-0 z-10 border-b bg-background/95 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground backdrop-blur" suppressHydrationWarning>{istDayLabel(g.key, now)}</h2>
                    <ul className="divide-y">{g.items.map((n) => <HeadlineRow key={n.id} item={n} now={now} summary />)}</ul>
                  </section>
                ))}
                {data.nextBefore && (
                  <div className="flex justify-center border-t py-3">
                    <Button size="xs" variant="outline" onClick={() => void more()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load older headlines"}</Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
        <SourcesPanel data={sources} now={now} className={cn("w-full border-l lg:w-80 xl:w-[22rem]", mobileView === "list" ? "hidden lg:flex" : "flex")} />
      </div>
    </div>
  );
}
