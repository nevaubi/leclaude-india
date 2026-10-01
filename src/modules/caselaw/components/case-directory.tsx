"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Database, Lock, RotateCcw, Scale, Search, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { EmptyState, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { courtById } from "@/lib/india/courts";
import {
  caseFiltersToParams, caseHref, formatCaseDate, hasActiveFilters, MATCH_LABEL, MAX_YEAR, MIN_YEAR, parseCaseFilters,
  type CaseFacets, type CaseFilters, type CaseHit, type CaseListResponse, type CaseSort,
} from "../shared";
import { CourtFilter, courtShortName } from "./court-filter";
import { CoverageStrip } from "./coverage-strip";
import { CaseApiError, fetchCaseJson } from "./fetch";

type ListState = { hits: CaseHit[]; mode: "search" | "browse"; hasMore: boolean; nextCursor: string | null; tookMs: number | null };

export function courtLabel(h: Pick<CaseHit, "court" | "court_id" | "court_code">): string {
  if (h.court) return h.court_id === "sci" ? "Supreme Court" : courtShortName(h.court);
  return h.court_code ? `Unmapped court ${h.court_code}` : "Court not recorded";
}

export function benchLabel(h: Pick<CaseHit, "court_id" | "bench_id" | "bench_code" | "bench_strength">): string | null {
  const bench = courtById(h.court_id)?.benches.find((b) => b.id === h.bench_id);
  const where = h.court_id === "sci" ? null : bench ? bench.city : h.bench_code ? `bench ${h.bench_code}` : null;
  const strength = h.bench_strength ? `${h.bench_strength}-judge` : null;
  return [where, strength].filter(Boolean).join(" · ") || null;
}

const dash = <span className="text-muted-foreground/60">—</span>;

/** /cases: the case law directory (browse and search the judgment metadata index). All filters live in the URL. */
export function CaseDirectory() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const paramString = sp.toString();
  const filters = React.useMemo(() => parseCaseFilters(new URLSearchParams(paramString)), [paramString]);
  const apiQuery = caseFiltersToParams(filters).toString();

  // Latest requested filters: two quick edits before the URL settles must not overwrite each other.
  const latest = React.useRef(filters);
  React.useEffect(() => { latest.current = filters; }, [filters]);
  const setFilters = React.useCallback((patch: Partial<CaseFilters>) => {
    const prev = latest.current;
    const next = { ...prev, ...patch };
    // A new query resets an explicit relevance/newest choice that only made sense for the previous mode.
    if (patch.q !== undefined && !patch.sort && !next.q && next.sort === "relevance") next.sort = "newest";
    if (patch.q !== undefined && !patch.sort && next.q && !prev.q) next.sort = "relevance";
    latest.current = next;
    const qs = caseFiltersToParams(next).toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router]);
  const clearAll = React.useCallback(() => {
    latest.current = parseCaseFilters(new URLSearchParams());
    setQDraft("");
    router.replace(pathname, { scroll: false });
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
      .catch((e) => { if ((e as Error).name !== "AbortError") setFacetsError(e instanceof CaseApiError ? e : new CaseApiError(String(e), 0, null)); })
      .finally(() => { if (!ac.signal.aborted) setFacetsLoading(false); });
    return () => ac.abort();
  }, [facetsNonce]);

  // Results.
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
      .catch((e) => { if ((e as Error).name !== "AbortError") { setList(null); setError(e instanceof CaseApiError ? e : new CaseApiError(String(e), 0, null)); } })
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
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(e instanceof CaseApiError ? e : new CaseApiError(String(e), 0, null)); })
      .finally(() => { if (!ac.signal.aborted) setLoadingMore(false); });
  }, [apiQuery, list, loading, loadingMore]);

  // Query box: committed on Enter or after a pause.
  const [qDraft, setQDraft] = React.useState(filters.q);
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

  const notConfigured = (error?.notConfigured || facetsError?.notConfigured) ?? false;
  const forbidden = (error?.forbidden || error?.unauthenticated) ?? false;

  const columns = React.useMemo<DataTableColumn<CaseHit>[]>(() => [
    {
      id: "title", header: "Title", width: 340, minWidth: 220, locked: true, accessor: (h) => h.title,
      render: (h) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Link href={caseHref(h.id)} className="min-w-0 truncate font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()} title={h.title}>{h.title}</Link>
          {h.match === "exact" ? <span className="shrink-0 rounded-[var(--radius-chip)] bg-primary/8 px-1 text-[10.5px] font-medium text-primary" title="Matched an identifier exactly (CNR, neutral citation or case number)">exact</span> : null}
          {h.match === "partial" ? <span className="shrink-0 text-[10.5px] text-muted-foreground" title="Matched some of the query words">partial</span> : null}
        </span>
      ),
    },
    {
      id: "court", header: "Court", width: 190, accessor: (h) => courtLabel(h),
      render: (h) => {
        const bench = benchLabel(h);
        return <span className="min-w-0 truncate" title={[h.court ?? (h.court_code ? `Unmapped court code ${h.court_code}` : ""), bench].filter(Boolean).join(" · ")}>
          <span className={cn(!h.court && "text-warning-foreground dark:text-warning")}>{courtLabel(h)}</span>
          {bench ? <span className="text-muted-foreground"> · {bench}</span> : null}
        </span>;
      },
    },
    { id: "decided", header: "Decided", width: 104, accessor: (h) => h.decision_date ?? "", render: (h) => <span className="tabular">{formatCaseDate(h.decision_date) ?? dash}</span> },
    { id: "case", header: "Case no.", width: 170, accessor: (h) => h.case_number ?? "", render: (h) => <span className="truncate tabular" title={h.case_number ?? undefined}>{h.case_number ?? dash}</span> },
    { id: "neutral", header: "Neutral citation", width: 150, accessor: (h) => h.neutral_citation ?? "", render: (h) => <span className="truncate tabular" title={h.neutral_citation ?? undefined}>{h.neutral_citation ?? dash}</span> },
    { id: "reporter", header: "Reporter", width: 150, defaultHidden: true, label: "Reporter citation", accessor: (h) => h.reporter_citation ?? "", render: (h) => <span className="truncate tabular">{h.reporter_citation ?? dash}</span> },
    { id: "cnr", header: "CNR", width: 150, defaultHidden: true, accessor: (h) => h.cnr ?? "", render: (h) => <span className="truncate tabular">{h.cnr ?? dash}</span> },
    { id: "judges", header: "Judges", width: 240, accessor: (h) => h.judges.join(", "), render: (h) => <span className="truncate" title={h.judges.join(", ")}>{h.judges.length ? h.judges.join(", ") : dash}</span> },
    { id: "disposal", header: "Disposal", width: 130, accessor: (h) => h.disposal ?? "", render: (h) => <span className="truncate" title={h.disposal ?? undefined}>{h.disposal ?? dash}</span> },
  ], []);

  const sortOptions: { value: CaseSort; label: string }[] = filters.q
    ? [{ value: "relevance", label: "Best match" }, { value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]
    : [{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }];

  const hits = list?.hits ?? [];
  const exactCount = hits.filter((h) => h.match === "exact").length;
  const active = hasActiveFilters(filters);

  if (notConfigured) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState icon={Database} title="The case law index is not configured" description="This deployment has no judgment corpus database (DATABASE_URL is not set). The directory reads the corpus from Postgres; nothing is shown from any other source in its place." />
        </div>
      </div>
    );
  }
  if (forbidden) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState icon={Lock} title={error?.unauthenticated ? "Sign in to view case law" : "You do not have access to the case law index"} description={error?.unauthenticated ? "Your session has ended." : "Ask an administrator for research access."} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header />
      <CoverageStrip facets={facets} loading={facetsLoading} error={facetsError?.message ?? null} selected={filters.courts} onRetry={() => setFacetsNonce((n) => n + 1)} onToggle={(key) => setFilters({ courts: filters.courts.includes(key) ? filters.courts.filter((c) => c !== key) : [...filters.courts, key] })} />

      {/* Toolbar */}
      <form
        className="flex flex-wrap items-center gap-1.5 border-b px-4 py-1.5"
        role="search"
        onSubmit={(e) => { e.preventDefault(); setFilters({ q: qDraft.trim() }); }}
      >
        <div className="relative w-full min-w-[220px] sm:w-[320px] md:w-[380px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={inputRef}
            size="xs"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && qDraft) { e.preventDefault(); setQDraft(""); setFilters({ q: "" }); } }}
            placeholder="Title, party, citation, CNR or case no."
            aria-label="Search case law"
            className="pl-7 pr-7"
            maxLength={200}
          />
          {qDraft ? (
            <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear search" onClick={() => { setQDraft(""); setFilters({ q: "" }); }}>
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <CourtFilter courts={facets?.courts ?? null} loading={facetsLoading} value={filters.courts} onChange={(courts) => setFilters({ courts })} />
        <YearRange from={filters.yearFrom} to={filters.yearTo} onChange={(yearFrom, yearTo) => setFilters({ yearFrom, yearTo })} />
        <TextFilter value={filters.judge} placeholder="Judge" ariaLabel="Filter by judge" onCommit={(judge) => setFilters({ judge })} width="w-[130px]" />
        <Select value={filters.disposal || "__any"} onValueChange={(v) => setFilters({ disposal: v === "__any" ? "" : v })}>
          <SelectTrigger size="xs" className="w-[150px]" aria-label="Disposal"><SelectValue placeholder="Any disposal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">Any disposal</SelectItem>
            {filters.disposal && !facets?.disposals.some((d) => d.value === filters.disposal) ? <SelectItem value={filters.disposal}>{filters.disposal}</SelectItem> : null}
            {(facets?.disposals ?? []).map((d) => <SelectItem key={d.value} value={d.value}>{d.value} <span className="text-muted-foreground tabular">({d.records.toLocaleString("en-IN")})</span></SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filters.sort} onValueChange={(v) => setFilters({ sort: v as CaseSort })}>
          <SelectTrigger size="xs" className="w-[128px]" aria-label="Sort"><SelectValue /></SelectTrigger>
          <SelectContent>{sortOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
        </Select>
        {active ? <Button type="button" variant="ghost" size="xs" onClick={() => clearAll}>Clear</Button> : null}
      </form>

      {/* Status line */}
      <div className="flex min-h-7 shrink-0 items-center gap-x-2 px-4 py-1 text-[11.5px] text-muted-foreground" aria-live="polite">
        {loading && !list ? <><Spinner size={12} /> Loading records…</> : error && !list ? <span className="text-destructive">Could not load records</span> : list ? (
          <>
            <span className="shrink-0 whitespace-nowrap tabular">{hits.length.toLocaleString("en-IN")} record{hits.length === 1 ? "" : "s"} shown{list.hasMore ? ", more available" : ""}</span>
            {list.mode === "search" ? <span className="min-w-0 truncate">· {exactCount ? `${exactCount} exact identifier match${exactCount === 1 ? "" : "es"} first, then ` : ""}{filters.sort === "relevance" ? "best match" : filters.sort === "newest" ? "newest first" : "oldest first"} over title, parties, citations, coram and source snippet</span> : <span>· {filters.sort === "oldest" ? "oldest" : "newest"} decisions first</span>}
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
              description={<>The index covers the courts and years listed above, and it searches metadata (title, parties, citations, coram, snippet), not judgment text.{active ? " Try fewer filters." : ""}</>}
              action={active ? <Button size="xs" variant="outline" onClick={() => clearAll}>Clear filters</Button> : undefined}
            />
          </div>
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
      <MatchLegend show={list?.mode === "search"} />
    </div>
  );
}

function Header() {
  return (
    <div className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 pb-2 pt-3">
      <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Case law</h1>
      <p className="text-[12.5px] text-muted-foreground">Indian judgments from the court-published open datasets: metadata, citations and the official PDF.</p>
    </div>
  );
}

function MatchLegend({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="hidden h-7 shrink-0 items-center gap-3 border-t px-4 text-[11px] text-muted-foreground md:flex">
      <span><span className="rounded-[var(--radius-chip)] bg-primary/8 px-1 font-medium text-primary">exact</span> {MATCH_LABEL.exact}: CNR, neutral citation or case number</span>
      <span>Unmarked: every query word matched</span>
      <span>partial: some query words matched</span>
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
