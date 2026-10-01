"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BookOpen, Info, LayoutList, Scale, Search, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Chip, EmptyState, Kbd, Spinner } from "@/components/ui/misc";
import { CorpusHeader } from "@/components/corpus/corpus-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import {
  citationTitle, hasActiveLawFilters, jurisdictionLabel, displayLawCitation, lawFiltersToParams, lawHref, LAW_MAX_YEAR, LAW_MIN_YEAR, parseLawFilters, snippetParts,
  type LawFacets, type LawFilters, type LawInstrumentHit, type LawListResponse, type LawProvisionHit, type LawSearchResponse, type LawSort,
} from "../shared";
import { asLawApiError, fetchLawJson, type LawApiError } from "./fetch";
import { isUnavailable, LawCoverageLine, LawErrorState, LawUnavailable, StatusText } from "./law-states";
import { LawLanding } from "./law-landing";
import { displayChapterTitle, displayHeading } from "../reader";

const DASH = <span className="text-muted-foreground/60">—</span>;
const fmt = (n: number) => n.toLocaleString("en-IN");

type ActsState = { hits: LawInstrumentHit[]; mode: "search" | "browse"; hasMore: boolean; nextCursor: string | null };
type SectionsState = { hits: LawProvisionHit[]; hasMore: boolean; nextOffset: number | null; broadened: boolean };

function filterQuery(f: LawFilters, extra?: Record<string, string>): string {
  const sp = lawFiltersToParams(f);
  sp.delete("mode");
  for (const [k, v] of Object.entries(extra ?? {})) sp.set(k, v);
  return sp.toString();
}

/** /law: the statutes directory. Acts mode lists instruments; Sections mode searches provisions. Filters live in the URL. */
export function LawDirectory() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const paramString = sp.toString();
  const filters = React.useMemo(() => parseLawFilters(new URLSearchParams(paramString)), [paramString]);
  const apiQuery = filterQuery(filters);
  const browseAll = sp.get("view") === "all";
  const landing = !hasActiveLawFilters(filters) && !browseAll;

  const latest = React.useRef(filters);
  React.useEffect(() => { latest.current = filters; }, [filters]);
  const keepAll = React.useRef(browseAll);
  React.useEffect(() => { keepAll.current = browseAll; }, [browseAll]);
  const setFilters = React.useCallback((patch: Partial<LawFilters>) => {
    const prev = latest.current;
    const next = { ...prev, ...patch };
    if (patch.jurisdiction !== undefined && patch.jurisdiction !== prev.jurisdiction) { if (next.jurisdiction !== "state") next.state = patch.state ?? ""; if (next.jurisdiction !== "regulator") next.regulator = patch.regulator ?? ""; }
    if (patch.q !== undefined && !patch.sort) next.sort = next.q ? (prev.q ? prev.sort : "relevance") : prev.sort === "relevance" ? "title" : prev.sort;
    latest.current = next;
    const params = lawFiltersToParams(next);
    if (keepAll.current) params.set("view", "all");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router]);
  const [qDraft, setQDraft] = React.useState(filters.q);
  const clearAll = React.useCallback(() => {
    keepAll.current = false;
    latest.current = parseLawFilters(new URLSearchParams(filters.mode === "sections" ? "mode=sections" : ""));
    setQDraft("");
    router.replace(filters.mode === "sections" ? `${pathname}?mode=sections` : pathname, { scroll: false });
  }, [filters.mode, pathname, router]);
  const showAll = React.useCallback(() => {
    keepAll.current = true;
    const params = lawFiltersToParams({ ...latest.current, mode: "acts" });
    params.set("view", "all");
    router.replace(`${pathname}?${params}`, { scroll: false });
  }, [pathname, router]);

  // Facets
  const [facets, setFacets] = React.useState<LawFacets | null>(null);
  const [facetsError, setFacetsError] = React.useState<LawApiError | null>(null);
  const [facetsLoading, setFacetsLoading] = React.useState(true);
  const [facetsNonce, setFacetsNonce] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    setFacetsLoading(true);
    fetchLawJson<LawFacets>("/api/law/facets", ac.signal)
      .then((f) => { setFacets(f); setFacetsError(null); })
      .catch((e) => { if ((e as Error).name !== "AbortError") setFacetsError(asLawApiError(e)); })
      .finally(() => { if (!ac.signal.aborted) setFacetsLoading(false); });
    return () => ac.abort();
  }, [facetsNonce]);

  // Results
  const sectionsMode = filters.mode === "sections";
  const [acts, setActs] = React.useState<ActsState | null>(null);
  const [sections, setSections] = React.useState<SectionsState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<LawApiError | null>(null);
  const [nonce, setNonce] = React.useState(0);
  const moreAbort = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const ac = new AbortController();
    moreAbort.current?.abort();
    setError(null);
    if (landing) { setActs(null); setSections(null); setLoading(false); return () => ac.abort(); }
    if (sectionsMode) {
      setActs(null);
      if (!filters.q) { setSections(null); setLoading(false); return () => ac.abort(); }
      setLoading(true);
      fetchLawJson<LawSearchResponse>(`/api/law/search?${apiQuery}`, ac.signal)
        .then((r) => setSections({ hits: r.hits, hasMore: r.hasMore, nextOffset: r.nextOffset, broadened: Boolean(r.broadened) }))
        .catch((e) => { if ((e as Error).name !== "AbortError") { setSections(null); setError(asLawApiError(e)); } })
        .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    } else {
      setSections(null);
      setLoading(true);
      fetchLawJson<LawListResponse>(`/api/law${apiQuery ? `?${apiQuery}` : ""}`, ac.signal)
        .then((r) => setActs({ hits: r.hits, mode: r.mode, hasMore: r.hasMore, nextCursor: r.nextCursor }))
        .catch((e) => { if ((e as Error).name !== "AbortError") { setActs(null); setError(asLawApiError(e)); } })
        .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    }
    return () => ac.abort();
  }, [apiQuery, sectionsMode, filters.q, nonce, landing]);

  const loadMore = React.useCallback(() => {
    if (loadingMore || loading) return;
    const ac = new AbortController();
    moreAbort.current = ac;
    if (sectionsMode && sections?.hasMore && sections.nextOffset != null) {
      setLoadingMore(true);
      fetchLawJson<LawSearchResponse>(`/api/law/search?${filterQuery(filters, { offset: String(sections.nextOffset) })}`, ac.signal)
        .then((r) => setSections((prev) => prev ? { hits: [...prev.hits, ...r.hits.filter((h) => !prev.hits.some((p) => p.actId === h.actId && p.section === h.section && p.variant === h.variant))], hasMore: r.hasMore, nextOffset: r.nextOffset, broadened: prev.broadened || Boolean(r.broadened) } : prev))
        .catch((e) => { if ((e as Error).name !== "AbortError") setError(asLawApiError(e)); })
        .finally(() => { if (!ac.signal.aborted) setLoadingMore(false); });
    } else if (!sectionsMode && acts?.hasMore && acts.nextCursor) {
      setLoadingMore(true);
      fetchLawJson<LawListResponse>(`/api/law?${filterQuery(filters, { cursor: acts.nextCursor })}`, ac.signal)
        .then((r) => setActs((prev) => {
          if (!prev) return prev;
          const seen = new Set(prev.hits.map((h) => h.id));
          return { ...prev, hits: [...prev.hits, ...r.hits.filter((h) => !seen.has(h.id))], hasMore: r.hasMore, nextCursor: r.nextCursor };
        }))
        .catch((e) => { if ((e as Error).name !== "AbortError") setError(asLawApiError(e)); })
        .finally(() => { if (!ac.signal.aborted) setLoadingMore(false); });
    }
  }, [acts, filters, loading, loadingMore, sections, sectionsMode]);

  // Query box: committed on Enter or after a pause.
  React.useEffect(() => { setQDraft(filters.q); }, [filters.q]);
  React.useEffect(() => {
    if (qDraft.trim() === filters.q) return;
    const t = setTimeout(() => setFilters({ q: qDraft.trim() }), 500);
    return () => clearTimeout(t);
  }, [qDraft, filters.q, setFilters]);
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable)) { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const columns = React.useMemo<DataTableColumn<LawInstrumentHit>[]>(() => [
    {
      id: "title", header: "Title", width: 420, minWidth: 240, locked: true, accessor: (h) => h.title,
      render: (h) => <Link href={lawHref(h.id)} className="min-w-0 truncate font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()} title={h.title}>{h.title}</Link>,
    },
    { id: "jurisdiction", header: "Jurisdiction", width: 170, accessor: (h) => jurisdictionLabel(h), render: (h) => <span className="truncate" title={h.publisher ?? undefined}>{jurisdictionLabel(h)}</span> },
    { id: "kind", header: "Type", width: 96, accessor: (h) => h.kind, render: (h) => <span className="text-muted-foreground">{h.kind === "regulation" ? "Regulation" : h.kind === "report" ? "Report" : "Act"}</span> },
    { id: "year", header: "Year", width: 70, accessor: (h) => h.year ?? 0, render: (h) => <span className="tabular">{h.year ?? DASH}</span> },
    { id: "status", header: "Status", width: 160, accessor: (h) => h.status ?? "", render: (h) => <StatusText status={h.status} /> },
    { id: "sections", header: "Sections", width: 86, align: "right", accessor: (h) => h.sections, render: (h) => <span className="tabular">{h.sections ? fmt(h.sections) : DASH}</span> },
    { id: "amendments", header: "Amendments", width: 104, align: "right", defaultHidden: true, accessor: (h) => h.amendment_count ?? 0, render: (h) => <span className="tabular">{h.amendment_count ?? DASH}</span> },
  ], []);

  const unavailable = isUnavailable(error) ? error : isUnavailable(facetsError) ? facetsError : null;
  const active = hasActiveLawFilters(filters);
  const sortOptions: { value: LawSort; label: string }[] = [
    ...(filters.q ? [{ value: "relevance" as const, label: "Best match" }] : []),
    { value: "title", label: "Acts first, A–Z" }, { value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" },
  ];

  const header = (
    <CorpusHeader
      icon={Scale}
      title="Statutes"
      description="Central and State Acts and regulator publications, section by section, each linked to its publisher's official page."
      coverage={unavailable ? undefined : <LawCoverageLine facets={facets} loading={facetsLoading} error={facetsError} onRetry={() => setFacetsNonce((n) => n + 1)} />}
      actions={unavailable ? undefined : landing
        ? <Button size="xs" variant="outline" onClick={showAll}><LayoutList className="size-3.5" />Browse all Acts</Button>
        : <Button size="xs" variant="ghost" onClick={clearAll}>Start page</Button>}
    />
  );

  if (unavailable) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex flex-1 items-center justify-center border-t p-6"><LawUnavailable error={unavailable} /></div>
      </div>
    );
  }

  const shown = sectionsMode ? sections?.hits.length ?? 0 : acts?.hits.length ?? 0;
  const hasMore = sectionsMode ? sections?.hasMore : acts?.hasMore;
  const listLoaded = sectionsMode ? sections : acts;
  const actCount = sectionsMode && sections ? new Set(sections.hits.map((h) => h.actId)).size : 0;

  const searchRow = (
    <div className={cn("flex flex-wrap items-center gap-2", landing ? "max-w-[760px]" : "")}>
      <div className={cn("relative min-w-[220px] flex-1", landing ? "" : "sm:max-w-[420px]")}>
        <Search className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground", landing ? "left-3 size-4" : "left-2.5 size-3.5")} aria-hidden />
        <Input
          ref={inputRef}
          size={landing ? "default" : "sm"}
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && qDraft) { e.preventDefault(); setQDraft(""); setFilters({ q: "" }); } }}
          placeholder={sectionsMode ? "Words in the provisions, e.g. anticipatory bail" : "Act or regulation title, State or regulator"}
          aria-label={sectionsMode ? "Search provisions" : "Search Acts and regulations"}
          className={cn(landing ? "pl-9 pr-9" : "pl-8 pr-8")}
          maxLength={200}
        />
        {qDraft ? (
          <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label="Clear search" onClick={() => { setQDraft(""); setFilters({ q: "" }); }}>
            <X className="size-3.5" />
          </button>
        ) : <Kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border px-1 text-[10.5px] text-muted-foreground sm:inline-flex">/</Kbd>}
      </div>
      <ToggleGroup type="single" size={landing ? "default" : "sm"} variant="outline" value={filters.mode} onValueChange={(v) => { if (v === "acts" || v === "sections") setFilters({ mode: v }); }} aria-label="Search Acts or sections" className="shrink-0">
        <ToggleGroupItem value="acts" className="px-3 text-[12.5px]">Acts</ToggleGroupItem>
        <ToggleGroupItem value="sections" className="px-3 text-[12.5px]">Sections</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <form className={cn("shrink-0 border-b px-4 sm:px-6", landing ? "pb-4" : "pb-2")} role="search" onSubmit={(e) => { e.preventDefault(); setFilters({ q: qDraft.trim() }); }}>
        {searchRow}
        {!landing ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
            <Select value={filters.jurisdiction || "__all"} onValueChange={(v) => setFilters({ jurisdiction: v === "__all" ? "" : (v as LawFilters["jurisdiction"]) })}>
              <SelectTrigger size="xs" className="w-[132px]" aria-label="Jurisdiction"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All jurisdictions</SelectItem>
                <SelectItem value="central">Central</SelectItem>
                <SelectItem value="state">State</SelectItem>
                <SelectItem value="regulator">Regulators</SelectItem>
              </SelectContent>
            </Select>
            {filters.jurisdiction === "state" ? (
              <Select value={filters.state || "__any"} onValueChange={(v) => setFilters({ state: v === "__any" ? "" : v })}>
                <SelectTrigger size="xs" className="w-[168px]" aria-label="State"><SelectValue placeholder="Any State" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any">Any State</SelectItem>
                  {filters.state && !facets?.states.some((s) => s.code === filters.state) ? <SelectItem value={filters.state}>{filters.state}</SelectItem> : null}
                  {(facets?.states ?? []).map((s) => <SelectItem key={s.code} value={s.code}>{s.name} <span className="text-muted-foreground tabular">({fmt(s.instruments)})</span></SelectItem>)}
                </SelectContent>
              </Select>
            ) : null}
            {filters.jurisdiction === "regulator" ? (
              <Select value={filters.regulator || "__any"} onValueChange={(v) => setFilters({ regulator: v === "__any" ? "" : v })}>
                <SelectTrigger size="xs" className="w-[168px]" aria-label="Regulator"><SelectValue placeholder="Any regulator" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any">Any regulator</SelectItem>
                  {filters.regulator && !facets?.regulators.some((r) => r.value === filters.regulator) ? <SelectItem value={filters.regulator}>{filters.regulator}</SelectItem> : null}
                  {(facets?.regulators ?? []).map((r) => <SelectItem key={r.value} value={r.value}>{r.label} <span className="text-muted-foreground tabular">({fmt(r.instruments)})</span></SelectItem>)}
                </SelectContent>
              </Select>
            ) : null}
            <Select value={filters.status} onValueChange={(v) => setFilters({ status: v as LawFilters["status"] })}>
              <SelectTrigger size="xs" className="w-[124px]" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="in_force">In force</SelectItem>
                <SelectItem value="not_in_force">Not in force</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.kind || "__any"} onValueChange={(v) => setFilters({ kind: v === "__any" ? "" : (v as LawFilters["kind"]) })}>
              <SelectTrigger size="xs" className="w-[112px]" aria-label="Instrument type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">All types</SelectItem>
                <SelectItem value="act">Acts</SelectItem>
                <SelectItem value="regulation">Regulations</SelectItem>
              </SelectContent>
            </Select>
            <YearRange from={filters.yearFrom} to={filters.yearTo} onChange={(yearFrom, yearTo) => setFilters({ yearFrom, yearTo })} />
            {!sectionsMode ? (
              <Select value={filters.sort} onValueChange={(v) => setFilters({ sort: v as LawSort })}>
                <SelectTrigger size="xs" className="w-[132px]" aria-label="Sort"><SelectValue /></SelectTrigger>
                <SelectContent>{sortOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
            ) : null}
            {active ? <Button type="button" variant="ghost" size="xs" onClick={clearAll}><X className="size-3.5" />Clear filters</Button> : null}
          </div>
        ) : null}
      </form>

      {landing ? (
        <LawLanding facets={facets} facetsLoading={facetsLoading} facetsError={facetsError} onRetryFacets={() => setFacetsNonce((n) => n + 1)} onPick={(patch) => { if (patch.q) setQDraft(patch.q); setFilters(patch); }} sectionsMode={sectionsMode} />
      ) : (
        <>
          <div className="flex min-h-8 shrink-0 items-center gap-x-2 px-4 py-1 text-[11.5px] text-muted-foreground sm:px-6" aria-live="polite">
            {loading && !listLoaded ? <><Spinner size={12} /> {sectionsMode ? "Searching provisions…" : "Loading instruments…"}</>
              : error && !listLoaded ? <span className="text-destructive">{sectionsMode ? "Could not search provisions" : "Could not load instruments"}</span>
              : listLoaded ? (
                <>
                  <span className="shrink-0 whitespace-nowrap tabular">
                    <span className="font-medium text-foreground/85">{fmt(shown)}</span> {sectionsMode ? `section${shown === 1 ? "" : "s"}${actCount ? ` in ${fmt(actCount)} instrument${actCount === 1 ? "" : "s"}` : ""}` : `instrument${shown === 1 ? "" : "s"}`} shown{hasMore ? ", more available" : ""}
                  </span>
                  <span className="min-w-0 truncate">· {sectionsMode ? "best match over section headings and text" : acts?.mode === "search" ? "best match over titles, States and regulators" : "browsing"}{filters.status === "in_force" ? " · in force only" : ""}</span>
                  {loading ? <Spinner size={12} /> : null}
                </>
              ) : null}
          </div>

          <div className="min-h-0 flex-1 border-t">
            {error && !listLoaded ? (
              <div className="flex h-full items-center justify-center p-6">
                <LawErrorState title={error.timedOut ? "The search took too long" : sectionsMode ? "Provisions could not be searched" : "Instruments could not be loaded"} error={error} onRetry={() => setNonce((n) => n + 1)} />
              </div>
            ) : sectionsMode && !filters.q ? (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState icon={Search} title="Search inside the provisions" description="Type words or a phrase (quote it for an exact phrase). Results are sections, grouped by instrument, with the matching words highlighted. Narrow by jurisdiction, State, regulator or status." />
              </div>
            ) : !loading && listLoaded && !shown ? (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState
                  icon={sectionsMode ? SearchX : BookOpen}
                  title={sectionsMode ? "No provision matches this search" : filters.q ? "No instrument matches this search" : "No instrument matches these filters"}
                  description={<>{filters.status === "in_force" ? "Only instruments in force are shown; try All statuses." : ""}{active ? " Try fewer filters." : ""}{!sectionsMode && filters.q ? " To look inside the text, switch to Sections." : ""}</>}
                  action={<div className="flex gap-1.5">
                    {!sectionsMode && filters.q ? <Button size="xs" variant="outline" onClick={() => setFilters({ mode: "sections" })}>Search sections</Button> : null}
                    {filters.status === "in_force" ? <Button size="xs" variant="outline" onClick={() => setFilters({ status: "all" })}>All statuses</Button> : null}
                    {active ? <Button size="xs" variant="ghost" onClick={clearAll}>Clear filters</Button> : null}
                  </div>}
                />
              </div>
            ) : sectionsMode ? (
              <ProvisionResults hits={sections?.hits ?? []} broadened={Boolean(sections?.broadened)} query={filters.q} loading={loading} hasMore={Boolean(sections?.hasMore)} loadingMore={loadingMore} onMore={loadMore} />
            ) : (
              <DataTable<LawInstrumentHit>
                rows={acts?.hits ?? []}
                columns={columns}
                rowId={(h) => h.id}
                serverSort
                loading={loading}
                noun="instrument"
                onRowActivate={(h) => router.push(lawHref(h.id))}
                onRowClick={(h, e) => { if (!(e.metaKey || e.ctrlKey || e.shiftKey)) router.push(lawHref(h.id)); }}
                onEndReached={acts?.hasMore ? loadMore : undefined}
                ariaLabel="Acts and regulations"
                stripActions={acts?.hasMore ? <Button variant="ghost" size="xs" disabled={loadingMore} onClick={loadMore}>{loadingMore ? <Spinner size={12} /> : null}Load more</Button> : undefined}
              />
            )}
          </div>
          {error && listLoaded ? (
            <div className="flex h-8 shrink-0 items-center gap-2 border-t px-4 text-[11.5px] text-destructive">
              Could not load more: {error.message}
              <Button variant="ghost" size="xs" onClick={() => { setError(null); loadMore(); }}>Retry</Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Snippet({ text }: { text: string }) {
  return <>{snippetParts(text).map((p, i) => (p.mark ? <mark key={i} className="rounded-[2px] bg-primary/12 px-px font-medium text-foreground">{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</>;
}

type ProvisionGroup = { actId: string; first: LawProvisionHit; hits: LawProvisionHit[] };

/** Group section hits by instrument, in the order the search ranked them (first appearance). */
function groupByAct(hits: LawProvisionHit[]): ProvisionGroup[] {
  const map = new Map<string, ProvisionGroup>();
  for (const h of hits) {
    const g = map.get(h.actId);
    if (g) g.hits.push(h);
    else map.set(h.actId, { actId: h.actId, first: h, hits: [h] });
  }
  return [...map.values()];
}

function ProvisionResults({ hits, broadened, query, loading, hasMore, loadingMore, onMore }: { hits: LawProvisionHit[]; broadened: boolean; query: string; loading: boolean; hasMore: boolean; loadingMore: boolean; onMore: () => void }) {
  const groups = React.useMemo(() => groupByAct(hits), [hits]);
  return (
    <div className={cn("h-full overflow-auto scrollbar-thin", loading && "opacity-70")} aria-busy={loading}>
      {broadened ? (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] text-foreground/85 sm:mx-6" role="note">
          <Info className="mt-0.5 size-3.5 shrink-0 text-warning-foreground dark:text-warning" aria-hidden />
          <span>No provision contains every word of “{query}”. These results match <strong className="font-medium">some</strong> of the words; read each section before relying on it.</span>
        </div>
      ) : null}
      <ol className="divide-y" aria-label="Matching sections, grouped by instrument">
        {groups.map((g) => {
          const f = g.first;
          return (
            <li key={g.actId} className="px-4 py-3 sm:px-6">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link href={lawHref(g.actId)} className="min-w-0 text-[13.5px] font-semibold tracking-[-0.005em] text-foreground hover:underline">{citationTitle({ title: f.actTitle, year: f.year })}</Link>
                <Chip tone="muted">{jurisdictionLabel(f)}</Chip>
                <StatusText status={f.instrumentStatus} className="text-[11.5px]" />
                <span className="ml-auto text-[11.5px] text-muted-foreground tabular">{g.hits.length} section{g.hits.length === 1 ? "" : "s"}</span>
              </div>
              <ul className="mt-1.5 space-y-2 border-l border-line-quiet pl-3">
                {g.hits.map((h) => {
                  const cite = displayLawCitation({ kind: h.kind, title: h.actTitle, year: h.year }, h.section, h.variant).split(",")[0];
                  const heading = displayHeading(h.heading);
                  const chapter = displayChapterTitle(h.chapter_title);
                  return (
                    <li key={`${h.section}|${h.variant}`}>
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <Link href={lawHref(h.actId, h.section, h.variant)} className="text-[12.5px] font-medium text-primary hover:underline">{cite}</Link>
                        {heading ? <span className="text-[12.5px] text-foreground/90">{heading}</span> : null}
                        {chapter ? <span className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">{chapter}</span> : null}
                        {h.in_force === false ? <span className="text-[11.5px] text-warning-foreground dark:text-warning">not in force</span> : null}
                      </div>
                      {h.snippet ? <p className="mt-0.5 max-w-[86ch] text-[12.5px] leading-relaxed text-foreground/75"><Snippet text={h.snippet} /></p> : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
      {hasMore ? (
        <div className="flex justify-center border-t py-2">
          <Button variant="ghost" size="xs" disabled={loadingMore} onClick={onMore}>{loadingMore ? <Spinner size={12} /> : null}Load more sections</Button>
        </div>
      ) : hits.length ? <div className="border-t px-4 py-2 text-[11px] text-muted-foreground sm:px-6">End of results. Search ranks the first {hits.length >= 200 ? "200" : "matching"} sections; refine the words to go further.</div> : null}
    </div>
  );
}

function YearRange({ from, to, onChange }: { from?: number; to?: number; onChange: (from?: number, to?: number) => void }) {
  const [a, setA] = React.useState(from ? String(from) : "");
  const [b, setB] = React.useState(to ? String(to) : "");
  React.useEffect(() => { setA(from ? String(from) : ""); }, [from]);
  React.useEffect(() => { setB(to ? String(to) : ""); }, [to]);
  const parse = (s: string) => { const n = Number(s); return s.trim() && Number.isInteger(n) && n >= LAW_MIN_YEAR && n <= LAW_MAX_YEAR ? n : undefined; };
  const commit = () => { const fa = parse(a), fb = parse(b); if (fa !== from || fb !== to) onChange(fa, fb); };
  const invalid = (s: string) => Boolean(s.trim()) && parse(s) === undefined;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Year range">
      <Input size="xs" inputMode="numeric" placeholder="From" aria-label="From year" aria-invalid={invalid(a) || undefined} className="w-[62px] tabular" value={a} onChange={(e) => setA(e.target.value.replace(/[^\d]/g, "").slice(0, 4))} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
      <span className="text-[11px] text-muted-foreground">–</span>
      <Input size="xs" inputMode="numeric" placeholder="To" aria-label="To year" aria-invalid={invalid(b) || undefined} className="w-[62px] tabular" value={b} onChange={(e) => setB(e.target.value.replace(/[^\d]/g, "").slice(0, 4))} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
    </div>
  );
}
