"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Database, FileText, Lock, RotateCcw, Scale, Search, SearchX, X } from "lucide-react";
import { LawHubMeta } from "@/components/corpus/law-hub";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Chip, EmptyState, Kbd, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  caseFiltersToParams, caseHref, formatCaseDate, hasActiveFilters, MATCH_LABEL, MAX_YEAR, MIN_YEAR, parseCaseFilters,
  type CaseFacets, type CaseFilters, type CaseHit, type CaseListResponse, type CaseSort,
} from "../shared";
import { CourtFilter } from "./court-filter";
import { CaseCoverageLine } from "./coverage-strip";
import { benchLabel, courtLabel } from "./case-labels";
import { CaseLanding } from "./case-landing";
import { CaseApiError, fetchCaseJson } from "./fetch";

type ListState = { hits: CaseHit[]; mode: "search" | "browse"; hasMore: boolean; nextCursor: string | null; tookMs: number | null };

export { benchLabel, courtLabel };

const dash = <span className="text-muted-foreground/60">—</span>;
const fmt = (n: number) => n.toLocaleString("en-IN");
const asCaseError = (e: unknown) => (e instanceof CaseApiError ? e : new CaseApiError(String((e as Error)?.message ?? e), 0, null));

/** /cases: the case law directory (browse and search the judgment metadata index). All filters live in the URL. */
export function CaseDirectory() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const paramString = sp.toString();
  const filters = React.useMemo(() => parseCaseFilters(new URLSearchParams(paramString)), [paramString]);
  const apiQuery = caseFiltersToParams(filters).toString();
  const browseAll = sp.get("view") === "all";
  const active = hasActiveFilters(filters);
  const landing = !active && !browseAll;

  // Latest requested filters: two quick edits before the URL settles must not overwrite each other.
  const latest = React.useRef(filters);
  React.useEffect(() => { latest.current = filters; }, [filters]);
  const keepAll = React.useRef(browseAll);
  React.useEffect(() => { keepAll.current = browseAll; }, [browseAll]);
  const setFilters = React.useCallback((patch: Partial<CaseFilters>) => {
    const prev = latest.current;
    const next = { ...prev, ...patch };
    // A new query resets an explicit relevance/newest choice that only made sense for the previous mode.
    if (patch.q !== undefined && !patch.sort && !next.q && next.sort === "relevance") next.sort = "newest";
    if (patch.q !== undefined && !patch.sort && next.q && !prev.q) next.sort = "relevance";
    latest.current = next;
    const params = caseFiltersToParams(next);
    if (keepAll.current) params.set("view", "all");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router]);
  const [qDraft, setQDraft] = React.useState(filters.q);
  const clearAll = React.useCallback(() => {
    keepAll.current = false;
    latest.current = parseCaseFilters(new URLSearchParams());
    setQDraft("");
    router.replace(pathname, { scroll: false });
  }, [pathname, router]);
  const showAll = React.useCallback(() => {
    keepAll.current = true;
    router.replace(`${pathname}?view=all`, { scroll: false });
  }, [pathname, router]);

  // Facets (coverage, court counts, disposals).
  const [facets, setFacets] = React.useState<CaseFacets | null>(null);
  const [facetsError, setFacetsError] = React.useState<CaseApiError | null>(null);
  const [facetsLoading, setFacetsLoading] = React.useState(true);
  const [facetsNonce, setFacetsNonce] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    setFacetsLoading(true);
    fetchCaseJson<CaseFacets>("/api/cases/facets", ac.signal)
      .then((f) => { setFacets(f); setFacetsError(null); })
      .catch((e) => { if ((e as Error).name !== "AbortError") setFacetsError(asCaseError(e)); })
      .finally(() => { if (!ac.signal.aborted) setFacetsLoading(false); });
    return () => ac.abort();
  }, [facetsNonce]);

  // Results (on the start page: the newest decisions, first page only).
  const [list, setList] = React.useState<ListState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<CaseApiError | null>(null);
  const [nonce, setNonce] = React.useState(0);
  const moreAbort = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const ac = new AbortController();
    moreAbort.current?.abort();
    setLoading(true);
    setError(null);
    fetchCaseJson<CaseListResponse>(`/api/cases${apiQuery ? `?${apiQuery}` : ""}`, ac.signal)
      .then((r) => setList({ hits: r.hits, mode: r.mode, hasMore: r.hasMore, nextCursor: r.nextCursor, tookMs: r.tookMs }))
      .catch((e) => { if ((e as Error).name !== "AbortError") { setList(null); setError(asCaseError(e)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [apiQuery, nonce]);

  const loadMore = React.useCallback(() => {
    if (!list?.hasMore || !list.nextCursor || loadingMore || loading) return;
    const ac = new AbortController();
    moreAbort.current = ac;
    setLoadingMore(true);
    const qs = new URLSearchParams(apiQuery);
    qs.set("cursor", list.nextCursor);
    fetchCaseJson<CaseListResponse>(`/api/cases?${qs}`, ac.signal)
      .then((r) => setList((prev) => {
        if (!prev) return prev;
        const seen = new Set(prev.hits.map((h) => h.id));
        return { ...prev, hits: [...prev.hits, ...r.hits.filter((h) => !seen.has(h.id))], hasMore: r.hasMore, nextCursor: r.nextCursor };
      }))
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(asCaseError(e)); })
      .finally(() => { if (!ac.signal.aborted) setLoadingMore(false); });
  }, [apiQuery, list, loading, loadingMore]);

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
      if (e.key === "/" && inputRef.current && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable)) { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const notConfigured = (error?.notConfigured || facetsError?.notConfigured) ?? false;
  const forbidden = (error?.forbidden || error?.unauthenticated || facetsError?.forbidden || facetsError?.unauthenticated) ?? false;
  const unauthenticated = (error?.unauthenticated || facetsError?.unauthenticated) ?? false;

  const columns = React.useMemo<DataTableColumn<CaseHit>[]>(() => [
    {
      id: "title", header: "Title", width: 360, minWidth: 220, locked: true, accessor: (h) => h.title,
      render: (h) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Link href={caseHref(h.id)} className="min-w-0 truncate font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()} title={h.title}>{h.title}</Link>
          {h.match === "exact" ? <MatchChip match="exact" /> : null}
        </span>
      ),
    },
    {
      id: "court", header: "Court", width: 220, accessor: (h) => courtLabel(h),
      render: (h) => {
        const bench = benchLabel(h);
        return <span className="min-w-0 truncate" title={[h.court ?? "", bench].filter(Boolean).join(" · ")}>
          <span className={cn(!h.court && "text-muted-foreground")}>{courtLabel(h)}</span>
          {bench ? <span className="text-muted-foreground"> · {bench}</span> : null}
        </span>;
      },
    },
    { id: "decided", header: "Decided", width: 104, accessor: (h) => h.decision_date ?? "", render: (h) => <span className="tabular">{formatCaseDate(h.decision_date) ?? dash}</span> },
    { id: "text", header: "Text", width: 96, accessor: (h) => h.text_status, render: (h) => (h.text_status === "full" ? <FullTextChip /> : <span className="text-[11.5px] text-muted-foreground">PDF only</span>) },
    { id: "neutral", header: "Neutral citation", width: 140, accessor: (h) => h.neutral_citation ?? "", render: (h) => <span className="truncate tabular" title={h.neutral_citation ?? undefined}>{h.neutral_citation ?? dash}</span> },
    { id: "case", header: "Case no.", width: 170, accessor: (h) => h.case_number ?? "", render: (h) => <span className="truncate tabular" title={h.case_number ?? undefined}>{h.case_number ?? dash}</span> },
    { id: "reporter", header: "Reporter", width: 150, defaultHidden: true, label: "Reporter citation", accessor: (h) => h.reporter_citation ?? "", render: (h) => <span className="truncate tabular">{h.reporter_citation ?? dash}</span> },
    { id: "cnr", header: "CNR", width: 150, defaultHidden: true, accessor: (h) => h.cnr ?? "", render: (h) => <span className="truncate tabular">{h.cnr ?? dash}</span> },
    { id: "judges", header: "Coram", width: 220, accessor: (h) => h.judges.join(", "), render: (h) => <span className="truncate" title={h.judges.join(", ")}>{h.judges.length ? h.judges.join(", ") : dash}</span> },
    { id: "disposal", header: "Disposal", width: 130, defaultHidden: true, accessor: (h) => h.disposal ?? "", render: (h) => <span className="truncate" title={h.disposal ?? undefined}>{h.disposal ?? dash}</span> },
  ], []);

  const sortOptions: { value: CaseSort; label: string }[] = filters.q
    ? [{ value: "relevance", label: "Best match" }, { value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]
    : [{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }];

  const hits = list?.hits ?? [];
  const exactCount = hits.filter((h) => h.match === "exact").length;

  const meta = notConfigured || forbidden ? null : (
    <LawHubMeta><CaseCoverageLine facets={facets} loading={facetsLoading} error={facetsError?.message ?? null} onRetry={() => setFacetsNonce((n) => n + 1)} /></LawHubMeta>
  );

  if (notConfigured || forbidden) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-center justify-center p-6">
          {notConfigured
            ? <EmptyState icon={Database} title="Case law is not available" description="Case law has not been set up for this workspace yet." />
            : <EmptyState icon={Lock} title={unauthenticated ? "Sign in to view case law" : "You do not have access to case law"} description={unauthenticated ? "Your session has ended." : "Ask an administrator for research access."} />}
        </div>
      </div>
    );
  }

  if (landing) {
    return (
      <>
        {meta}
        <CaseLanding
          facets={facets}
          facetsLoading={facetsLoading}
          facetsError={facetsError?.message ?? null}
          onRetryFacets={() => setFacetsNonce((n) => n + 1)}
          onPickCourt={(keys) => setFilters({ courts: keys })}
          hits={hits}
          loading={loading}
          error={error && !list ? error.message : null}
          onRetry={() => setNonce((n) => n + 1)}
          onBrowseAll={showAll}
        />
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {meta}

      <form className="shrink-0 border-b px-4 pb-2 pt-3 sm:px-6" role="search" onSubmit={(e) => { e.preventDefault(); setFilters({ q: qDraft.trim() }); }}>
        <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-[480px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={inputRef}
            size="sm"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && qDraft) { e.preventDefault(); setQDraft(""); setFilters({ q: "" }); } }}
            placeholder="Title, party, neutral citation, CNR or case number"
            aria-label="Search case law"
            className="pl-8 pr-8"
            maxLength={200}
          />
          {qDraft ? (
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label="Clear search" onClick={() => { setQDraft(""); setFilters({ q: "" }); }}>
              <X className="size-3.5" />
            </button>
          ) : <Kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border px-1 text-[10.5px] text-muted-foreground sm:inline-flex">/</Kbd>}
        </div>
        {!active ? <Button type="button" size="xs" variant="ghost" className="ml-auto" onClick={clearAll}>Start page</Button> : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
            <CourtFilter courts={facets?.courts ?? null} loading={facetsLoading} value={filters.courts} onChange={(courts) => setFilters({ courts })} />
            <YearRange from={filters.yearFrom} to={filters.yearTo} onChange={(yearFrom, yearTo) => setFilters({ yearFrom, yearTo })} />
            <TextFilter value={filters.judge} placeholder="Judge" ariaLabel="Filter by judge" onCommit={(judge) => setFilters({ judge })} width="w-[130px]" />
            <Select value={filters.disposal || "__any"} onValueChange={(v) => setFilters({ disposal: v === "__any" ? "" : v })}>
              <SelectTrigger size="xs" className="w-[150px]" aria-label="Disposal"><SelectValue placeholder="Any disposal" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">Any disposal</SelectItem>
                {filters.disposal && !facets?.disposals.some((d) => d.value === filters.disposal) ? <SelectItem value={filters.disposal}>{filters.disposal}</SelectItem> : null}
                {(facets?.disposals ?? []).map((d) => <SelectItem key={d.value} value={d.value}>{d.value} <span className="text-muted-foreground tabular">({fmt(d.records)})</span></SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filters.sort} onValueChange={(v) => setFilters({ sort: v as CaseSort })}>
              <SelectTrigger size="xs" className="w-[128px]" aria-label="Sort"><SelectValue /></SelectTrigger>
              <SelectContent>{sortOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
            {active ? <Button type="button" variant="ghost" size="xs" onClick={clearAll}><X className="size-3.5" />Clear filters</Button> : null}
        </div>
      </form>

          <div className="flex min-h-8 shrink-0 items-center gap-x-2 px-4 py-1 text-[11.5px] text-muted-foreground sm:px-6" aria-live="polite">
            {loading && !list ? <><Spinner size={12} /> {filters.q ? "Searching records…" : "Loading records…"}</> : error && !list ? <span className="text-destructive">Could not load records</span> : list ? (
              <>
                <span className="shrink-0 whitespace-nowrap tabular"><span className="font-medium text-foreground/85">{fmt(hits.length)}</span> record{hits.length === 1 ? "" : "s"} shown{list.hasMore ? ", more available" : ""}</span>
                {list.mode === "search" ? <span className="min-w-0 truncate">· {exactCount ? `${exactCount} exact identifier match${exactCount === 1 ? "" : "es"} first, then ` : ""}{filters.sort === "relevance" ? "best match" : filters.sort === "newest" ? "newest first" : "oldest first"}</span> : <span>· {filters.sort === "oldest" ? "oldest" : "newest"} decisions first</span>}
                {loading ? <Spinner size={12} /> : null}
              </>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 border-t">
            {error && !list ? (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState icon={SearchX} title="Records could not be loaded" description={error.message} action={<Button size="xs" variant="outline" onClick={() => setNonce((n) => n + 1)}><RotateCcw className="size-3.5" />Retry</Button>} />
              </div>
            ) : !loading && list && !hits.length ? (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState
                  icon={Scale}
                  title={filters.q ? "No records match this search" : "No records match these filters"}
                  description={<>Search covers case titles, parties, citations and coram, not the full judgment text.{active ? " Try fewer filters." : ""}</>}
                  action={active ? <Button size="xs" variant="outline" onClick={clearAll}>Clear filters</Button> : undefined}
                />
              </div>
            ) : filters.q ? (
              <ResultList hits={hits} loading={loading} hasMore={Boolean(list?.hasMore)} loadingMore={loadingMore} onMore={loadMore} />
            ) : (
              <DataTable<CaseHit>
                rows={hits}
                columns={columns}
                rowId={(h) => h.id}
                serverSort
                loading={loading}
                noun="record"
                onRowActivate={(h) => router.push(caseHref(h.id))}
                onRowClick={(h, e) => { if (!(e.metaKey || e.ctrlKey || e.shiftKey)) router.push(caseHref(h.id)); }}
                onEndReached={list?.hasMore ? loadMore : undefined}
                ariaLabel="Case law records"
                stripActions={list?.hasMore ? <Button variant="ghost" size="xs" disabled={loadingMore} onClick={loadMore}>{loadingMore ? <Spinner size={12} /> : null}Load more</Button> : undefined}
              />
            )}
          </div>
          {error && list ? (
            <div className="flex h-8 shrink-0 items-center gap-2 border-t px-4 text-[11.5px] text-destructive">
              Could not load more records: {error.message}
              <Button variant="ghost" size="xs" onClick={() => { setError(null); loadMore(); }}>Retry</Button>
            </div>
          ) : null}
    </div>
  );
}

function FullTextChip() {
  return <Chip tone="muted" icon={FileText} title="The judgment text can be read on the case page" className="text-foreground/75">Full text</Chip>;
}

function MatchChip({ match }: { match: CaseHit["match"] }) {
  if (match === "exact") return <Chip tone="accent" title="Matched an identifier exactly (CNR, neutral citation or case number)">{MATCH_LABEL.exact}</Chip>;
  if (match === "partial") return <Chip tone="warning" title="Matched some of the query words, not all">{MATCH_LABEL.partial}</Chip>;
  if (match === "text") return <span className="text-[11px] text-muted-foreground" title="Every search word matched">{MATCH_LABEL.text}</span>;
  return null;
}

function ResultRow({ h, compact }: { h: CaseHit; compact?: boolean }) {
  const bench = benchLabel(h);
  const date = formatCaseDate(h.decision_date);
  return (
    <li>
      <Link href={caseHref(h.id)} className={cn("block transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50", compact ? "px-3 py-2" : "px-4 py-3 sm:px-6")}>
        <div className="flex items-start gap-2">
          <span className={cn("min-w-0 flex-1 font-medium leading-snug text-foreground", compact ? "truncate text-[12.5px]" : "line-clamp-2 text-[13.5px]")} title={h.title}>{h.title}</span>
          {!compact ? <span className="shrink-0 pt-px"><MatchChip match={h.match} /></span> : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted-foreground">
          <span className={cn(h.court ? "text-foreground/80" : "text-muted-foreground")}>{courtLabel(h)}</span>
          {bench ? <><span aria-hidden>·</span><span>{bench}</span></> : null}
          {date ? <><span aria-hidden>·</span><span className="tabular">{date}</span></> : null}
          {h.neutral_citation ? <Chip tone="muted" className="ml-1 tabular text-foreground/75" title="Neutral citation">{h.neutral_citation}</Chip> : null}
          {h.reporter_citation ? <Chip tone="muted" className="tabular" title="Reporter citation">{h.reporter_citation}</Chip> : null}
          {!compact && h.case_number ? <Chip tone="outline" className="tabular" title="Case number">{h.case_number}</Chip> : null}
          {h.text_status === "full" ? <FullTextChip /> : null}
        </div>
        {!compact && h.snippet ? <p className="mt-1 line-clamp-2 max-w-[100ch] text-[12.5px] leading-relaxed text-foreground/70">{h.snippet}</p> : null}
        {!compact && (h.judges.length || h.disposal) ? (
          <div className="mt-1 truncate text-[11.5px] text-muted-foreground">
            {h.judges.length ? <>Coram: {h.judges.join(", ")}</> : null}{h.judges.length && h.disposal ? " · " : ""}{h.disposal ? <>Disposal: {h.disposal}</> : null}
          </div>
        ) : null}
      </Link>
    </li>
  );
}

function ResultSkeleton({ rows, className }: { rows: number; className?: string }) {
  return (
    <div className={cn("divide-y", className)} aria-busy>
      {Array.from({ length: rows }, (_, k) => (
        <div key={k} className="space-y-1.5 px-3 py-2.5"><Skeleton className="h-3.5" style={{ width: `${50 + ((k * 13) % 40)}%` }} /><Skeleton className="h-3 w-[min(360px,60%)]" /></div>
      ))}
    </div>
  );
}

function ResultList({ hits, loading, hasMore, loadingMore, onMore }: { hits: CaseHit[]; loading: boolean; hasMore: boolean; loadingMore: boolean; onMore: () => void }) {
  if (loading && !hits.length) return <ResultSkeleton rows={8} />;
  return (
    <div className={cn("h-full overflow-auto scrollbar-thin", loading && "opacity-70")} aria-busy={loading}>
      <ol className="divide-y" aria-label="Matching case law records">{hits.map((h) => <ResultRow key={h.id} h={h} />)}</ol>
      {hasMore ? (
        <div className="flex justify-center border-t py-2">
          <Button variant="ghost" size="xs" disabled={loadingMore} onClick={onMore}>{loadingMore ? <Spinner size={12} /> : null}Load more records</Button>
        </div>
      ) : hits.length ? <div className="border-t px-4 py-2 text-[11px] text-muted-foreground sm:px-6">End of results.</div> : null}
    </div>
  );
}

function YearRange({ from, to, onChange }: { from?: number; to?: number; onChange: (from?: number, to?: number) => void }) {
  const [a, setA] = React.useState(from ? String(from) : "");
  const [b, setB] = React.useState(to ? String(to) : "");
  React.useEffect(() => { setA(from ? String(from) : ""); }, [from]);
  React.useEffect(() => { setB(to ? String(to) : ""); }, [to]);
  const parse = (s: string) => { const n = Number(s); return s.trim() && Number.isInteger(n) && n >= MIN_YEAR && n <= MAX_YEAR ? n : undefined; };
  const commit = () => { const fa = parse(a), fb = parse(b); if (fa !== from || fb !== to) onChange(fa, fb); };
  const invalid = (s: string) => Boolean(s.trim()) && parse(s) === undefined;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Decision year range">
      <Input size="xs" inputMode="numeric" placeholder="From" aria-label="From year" aria-invalid={invalid(a) || undefined} className="w-[62px] tabular" value={a} onChange={(e) => setA(e.target.value.replace(/[^\d]/g, "").slice(0, 4))} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
      <span className="text-[11px] text-muted-foreground">–</span>
      <Input size="xs" inputMode="numeric" placeholder="To" aria-label="To year" aria-invalid={invalid(b) || undefined} className="w-[62px] tabular" value={b} onChange={(e) => setB(e.target.value.replace(/[^\d]/g, "").slice(0, 4))} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
    </div>
  );
}

function TextFilter({ value, placeholder, ariaLabel, onCommit, width }: { value: string; placeholder: string; ariaLabel: string; onCommit: (v: string) => void; width: string }) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => { setV(value); }, [value]);
  const commit = () => { if (v.trim() !== value) onCommit(v.trim()); };
  return <Input size="xs" placeholder={placeholder} aria-label={ariaLabel} className={width} value={v} maxLength={80} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />;
}
