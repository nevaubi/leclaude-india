"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Check, Copy, ExternalLink, FileText, Library, ListFilter, Search, SearchX, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Chip, EmptyState, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { OfficialListResult, OfficialSearchResult, OfficialStatus } from "@/modules/official/service";
import type { SourceDocument, SourceId, SourceKind, SourceSearchHit } from "@/modules/official/types";
import { asOfficialApiError, fetchOfficialJson, OfficialApiError } from "../fetch";
import {
  COVERAGE_NOTE, coverageRows, docStatusLabel, extractionLabel, forumOptions, formatDocDate, formatFetchedAt, hasSourceFilters, hostOf, isOcrText, kindLabel,
  lastRunOf, listApiQuery, MATCH_LABEL, MODE_LABEL, pageLabel, parseSourcesFilters, safeHttp, searchApiQuery, searchHitKey, sourceDocHref, sourcesFiltersToParams, storageLine,
  type SourcesFilters, type SourcesTab,
} from "../shared";
import { isOfficialUnavailable, OcrBadge, OfficialErrorState, OfficialUnavailable, useOfficialStatus } from "./states";

import {retiredCollectionReason} from '@/modules/official/collection-policy';
import {CollectionOverview} from './collection-overview';
import {CorpusQualityPanel} from './corpus-quality-panel';
const fmt = (n: number) => n.toLocaleString("en-IN");
const ALL = "all";
const NOT_CONFIGURED = new OfficialApiError("Official sources are not configured on this workspace.", 503, "official_not_configured");

/**
 * /sources — the official sources library: hybrid search over the text of court, tribunal, regulator, Gazette and
 * Parliament documents, a newest-first browse list, and per-source coverage. Filters (source, kind, forum, dates) and
 * the tab live in the URL. Every result links to the publisher's copy, which is the text of record.
 */
export function SourcesLibrary() {
  const sp = useSearchParams();
  const pathname = usePathname();
  const filters = React.useMemo(() => parseSourcesFilters(new URLSearchParams(sp.toString())), [sp]);
  const update = React.useCallback((patch: Partial<SourcesFilters>) => {
    const qs = sourcesFiltersToParams({ ...filters, ...patch }).toString();
    window.history.replaceState(null, "", `${pathname}${qs ? `?${qs}` : ""}`);
  }, [filters, pathname]);
  const { status, error, loading, retry } = useOfficialStatus();
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  // The reader's back link returns here with the same tab, query and filters.
  const here = React.useMemo(() => { const qs = sourcesFiltersToParams(filters).toString(); return `/sources${qs ? `?${qs}` : ""}`; }, [filters]);
  const total = status ? status.sources.reduce((n, s) => n + (s.stats?.documents ?? 0), 0) : 0;
  const notSetUp = status && !status.configured;

  let body: React.ReactNode;
  if (loading && !status) body = <LibrarySkeleton />;
  else if (error) body = <div className="flex flex-1 items-center justify-center p-6">{isOfficialUnavailable(error) ? <OfficialUnavailable error={error} /> : <OfficialErrorState title="Official sources could not be loaded" error={error} onRetry={retry} />}</div>;
  else if (notSetUp) body = <div className="flex flex-1 items-center justify-center p-6"><OfficialUnavailable error={NOT_CONFIGURED} /></div>;
  else if (status) {
    const rail = <FilterRail status={status} filters={filters} onChange={update} />;
    body = filters.tab === "coverage" ? (
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin"><CoverageTab status={status} /></div>
    ) : (
      <div className="grid min-h-0 flex-1 md:grid-cols-[236px_minmax(0,1fr)]">
        <aside aria-label="Filters" className="hidden min-h-0 overflow-auto border-r scrollbar-thin md:block">{rail}</aside>
        <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
          <SheetContent side="left" width="max-w-[300px]" className="p-0" aria-describedby={undefined}>
            <SheetTitle className="border-b px-4 py-3 text-[13px]">Filters</SheetTitle>
            <div className="min-h-0 flex-1 overflow-auto">{rail}</div>
          </SheetContent>
        </Sheet>
        <main className="min-h-0 min-w-0 overflow-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-[920px] px-4 pb-10 pt-4 sm:px-6">
            {filters.tab === "search" && !filters.q && !hasSourceFilters(filters) ? <CollectionOverview status={status} /> : null}
            {filters.tab === "browse"
              ? <BrowseTab filters={filters} onChange={update} empty={total === 0} onOpenFilters={() => setFiltersOpen(true)} from={here} />
              : <SearchTab filters={filters} onChange={update} empty={total === 0} onOpenFilters={() => setFiltersOpen(true)} from={here} />}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 pt-3 sm:px-6">
        {/* The Law section tab already names the page; the heading stays for screen readers. */}
        <h1 className="sr-only">Official sources</h1>
        <p className="min-w-0 text-[12px] text-muted-foreground">Judgments, regulatory materials and legislative history — grouped by source and legal function</p>
        <Tabs value={filters.tab} onValueChange={(v) => update({ tab: v as SourcesTab })} className="mt-1">
          <TabsList variant="underline" className="h-9 gap-3">
            <TabsTrigger value="search">Collections & search</TabsTrigger>
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="coverage">Quality & coverage</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>
      {body}
    </div>
  );
}

function LibrarySkeleton() {
  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[236px_minmax(0,1fr)]" aria-busy>
      <div className="hidden space-y-2 border-r p-3 md:block">{Array.from({ length: 10 }, (_, k) => <Skeleton key={k} className="h-3.5" style={{ width: `${55 + ((k * 13) % 40)}%` }} />)}</div>
      <div className="mx-auto w-full max-w-[920px] space-y-3 px-6 py-5"><Skeleton className="h-8 w-full" />{Array.from({ length: 5 }, (_, k) => <Skeleton key={k} className="h-20 w-full" />)}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter rail
// ---------------------------------------------------------------------------

function FilterRail({ status, filters, onChange }: { status: OfficialStatus; filters: SourcesFilters; onChange: (p: Partial<SourcesFilters>) => void }) {
  const sources = status.sources.filter(s => !retiredCollectionReason(s.id)).sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const kinds = [...new Set(status.sources.flatMap((s) => (s.kinds ?? []).filter(k => !retiredCollectionReason(s.id, k))))] as SourceKind[];
  const forums = forumOptions(status);
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="space-y-4 px-3 py-3 text-[12.5px]">
      {hasSourceFilters(filters) ? <Button size="xs" variant="ghost" className="-ml-1" onClick={() => onChange({ sources: [], kinds: [], forum: "", from: "", to: "" })}><X className="size-3.5" />Clear filters</Button> : null}
      <fieldset>
        <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Source</legend>
        <ul className="space-y-0.5">
          {sources.map((s) => {
            const id = `src-${s.id}`;
            return (
              <li key={s.id} className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-accent/50">
                <Checkbox id={id} size="sm" className="mt-0.5" checked={filters.sources.includes(s.id)} onCheckedChange={() => onChange({ sources: toggle<SourceId>(filters.sources, s.id) })} />
                <label htmlFor={id} className={cn("min-w-0 flex-1 cursor-pointer leading-snug", !s.enabled && "text-muted-foreground")} title={s.publisher}>
                  {s.name}
                  <span className="ml-1 text-[11px] text-muted-foreground tabular">{s.enabled ? fmt(s.stats?.documents ?? 0) : "disabled"}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {kinds.length ? (
        <fieldset>
          <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Kind</legend>
          <ul className="space-y-0.5">
            {kinds.map((k) => (
              <li key={k} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-accent/50">
                <Checkbox id={`kind-${k}`} size="sm" checked={filters.kinds.includes(k)} onCheckedChange={() => onChange({ kinds: toggle<SourceKind>(filters.kinds, k) })} />
                <label htmlFor={`kind-${k}`} className="min-w-0 flex-1 cursor-pointer">{kindLabel(k)}</label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      {forums.length ? (
        <div>
          <label htmlFor="src-forum" className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Forum</label>
          <Select value={filters.forum || ALL} onValueChange={(v) => onChange({ forum: v === ALL ? "" : v })}>
            <SelectTrigger id="src-forum" size="xs" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All forums</SelectItem>
              {forums.map((f) => <SelectItem key={f.forum} value={f.forum}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <fieldset>
        <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Document date</legend>
        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
          <label htmlFor="src-from" className="text-[11.5px] text-muted-foreground">From</label>
          <Input id="src-from" type="date" size="xs" value={filters.from} onChange={(e) => onChange({ from: e.target.value })} className="tabular dark:[color-scheme:dark]" />
          <label htmlFor="src-to" className="text-[11.5px] text-muted-foreground">To</label>
          <Input id="src-to" type="date" size="xs" value={filters.to} onChange={(e) => onChange({ to: e.target.value })} className="tabular dark:[color-scheme:dark]" />
        </div>
      </fieldset>
    </div>
  );
}

function ActiveFilters({ filters, onOpenFilters }: { filters: SourcesFilters; onOpenFilters: () => void }) {
  const n = filters.sources.length + filters.kinds.length + (filters.forum ? 1 : 0) + (filters.from || filters.to ? 1 : 0);
  return (
    <Button size="xs" variant="outline" className="md:hidden" onClick={onOpenFilters}><ListFilter className="size-3.5" />Filters{n ? <span className="tabular text-muted-foreground"> · {n}</span> : null}</Button>
  );
}

function QueryBox({ value, onSubmit, placeholder, label }: { value: string; onSubmit: (q: string) => void; placeholder: string; label: string }) {
  const [q, setQ] = React.useState(value);
  React.useEffect(() => { setQ(value); }, [value]);
  return (
    <form role="search" aria-label={label} className="relative min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); onSubmit(q.trim()); }}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={label} maxLength={300} className="pl-8 pr-8" onKeyDown={(e) => { if (e.key === "Escape" && q) { e.preventDefault(); setQ(""); onSubmit(""); } }} />
      {q ? <button type="button" aria-label="Clear" onClick={() => { setQ(""); onSubmit(""); }} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><X className="size-3.5" /></button> : null}
    </form>
  );
}

function EmptyCorpus() {
  return <EmptyState icon={Library} title="No official documents have been collected yet" description="Documents appear here as each publisher is fetched and indexed. The Coverage tab shows each source's progress." action={<Button asChild size="xs" variant="outline"><Link href="/sources?tab=coverage">Open coverage</Link></Button>} />;
}

function CopyRef({ value }: { value: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button type="button" title="Copy the source reference" onClick={async () => {
      try { await navigator.clipboard.writeText(value); setDone(true); toast.success("Reference copied"); setTimeout(() => setDone(false), 1500); } catch { toast.error("Could not copy to the clipboard"); }
    }} className="inline-flex h-6 items-center gap-1 rounded px-1.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      {done ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}<span className="max-w-[220px] truncate">{value}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function SearchTab({ filters, onChange, empty, onOpenFilters, from }: { filters: SourcesFilters; onChange: (p: Partial<SourcesFilters>) => void; empty: boolean; onOpenFilters: () => void; from: string }) {
  const qs = searchApiQuery(filters);
  const [res, setRes] = React.useState<OfficialSearchResult | null>(null);
  const [error, setError] = React.useState<OfficialApiError | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (!qs) { setRes(null); setError(null); return; }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchOfficialJson<OfficialSearchResult>(`/api/official/search?${qs}`, ac.signal)
      .then(setRes)
      .catch((e) => { if ((e as Error).name !== "AbortError") { setRes(null); setError(asOfficialApiError(e)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [qs, nonce]);

  return (
    <>
      <div className="flex items-center gap-2">
        <QueryBox value={filters.q} onSubmit={(q) => onChange({ q })} placeholder="Search the text, e.g. moratorium under section 14, SLP(C) 1234/2026" label="Search official documents" />
        <ActiveFilters filters={filters} onOpenFilters={onOpenFilters} />
      </div>
      <div className="mt-4" aria-live="polite">
        {!qs ? (
          empty ? <EmptyCorpus /> : <EmptyState icon={Search} title="Search the text of official documents" description="Results match by keyword and, where embeddings exist, by meaning. Each one quotes the passage, gives its page and links to the publisher's copy." />
        ) : error ? (
          isOfficialUnavailable(error) ? <OfficialUnavailable error={error} /> : <OfficialErrorState title={error.badRequest ? "This search cannot be run" : "The search failed"} error={error} onRetry={error.badRequest ? undefined : () => setNonce((n) => n + 1)} />
        ) : loading && !res ? (
          <ul className="space-y-3" aria-busy>{Array.from({ length: 4 }, (_, k) => <li key={k}><Skeleton className="h-4 w-2/3" /><Skeleton className="mt-1.5 h-3 w-1/2" /><Skeleton className="mt-2 h-12 w-full" /></li>)}</ul>
        ) : res ? (
          res.empty || !res.hits.length ? (
            <EmptyState icon={SearchX} title="No document matches" description={`Nothing in the collected documents matches “${filters.q}”${hasSourceFilters(filters) ? " with these filters" : ""}. Unrelated documents are not shown in its place.`} />
          ) : (
            <>
              <p className={cn("mb-2 text-[11.5px] text-muted-foreground", loading && "opacity-60")}>
                {res.hits.length} passage{res.hits.length === 1 ? "" : "s"} · {MODE_LABEL[res.mode]}{res.candidates ? <> · <span className="tabular">{fmt(res.candidates)}</span> keyword candidates considered</> : null}
              </p>
              <ul className={cn("divide-y rounded-lg border", loading && "opacity-60")}>
                {res.hits.map((h) => <HitRow key={searchHitKey(h)} h={h} from={from} />)}
              </ul>
            </>
          )
        ) : null}
      </div>
    </>
  );
}

function HitRow({ h, from }: { h: SourceSearchHit; from: string }) {
  const official = safeHttp(h.url);
  const page = pageLabel(h.pageStart, h.pageEnd);
  return (
    <li className="px-3.5 py-3">
      <Link href={sourceDocHref(h.documentId, h.pageStart != null ? { page: h.pageStart } : { chunk: h.chunkIndex }, from)} className="text-[13px] font-medium leading-snug hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">{h.title}</Link>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
        <span className="text-foreground/80">{h.publisher}</span>
        <span aria-hidden>·</span><span>{kindLabel(h.kind)}</span>
        <span aria-hidden>·</span><span className="tabular">{formatDocDate(h.docDate) ?? "undated"}</span>
        {page ? <><span aria-hidden>·</span><span className="tabular">{page}</span></> : null}
        <Chip tone="muted">{MATCH_LABEL[h.match]}</Chip>
        {isOcrText(h.extraction) ? <OcrBadge /> : null}
      </div>
      <p className="mt-1.5 line-clamp-4 whitespace-pre-line font-serif text-[13.5px] leading-relaxed text-foreground/90">{h.text}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {official ? (
          <Button asChild size="xs" variant="ghost" className="-ml-1.5"><a href={official} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5" />Publisher&apos;s copy<span className="text-muted-foreground">· {hostOf(official)}</span></a></Button>
        ) : <span className="text-[11.5px] text-muted-foreground">Official link not recorded</span>}
        <CopyRef value={h.ref} />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

function BrowseTab({ filters, onChange, empty, onOpenFilters, from }: { filters: SourcesFilters; onChange: (p: Partial<SourcesFilters>) => void; empty: boolean; onOpenFilters: () => void; from: string }) {
  const qs = listApiQuery(filters, null);
  const [docs, setDocs] = React.useState<SourceDocument[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [error, setError] = React.useState<OfficialApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [more, setMore] = React.useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchOfficialJson<OfficialListResult>(`/api/official/documents?${qs}`, ac.signal)
      .then((r) => { setDocs(r.documents ?? []); setCursor(r.nextCursor ?? null); })
      .catch((e) => { if ((e as Error).name !== "AbortError") { setDocs(null); setError(asOfficialApiError(e)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [qs, nonce]);
  const loadMore = () => {
    if (!cursor || more.loading) return;
    setMore({ loading: true, error: null });
    fetchOfficialJson<OfficialListResult>(`/api/official/documents?${listApiQuery(filters, cursor)}`)
      .then((r) => { setDocs((d) => [...(d ?? []), ...(r.documents ?? [])]); setCursor(r.nextCursor ?? null); setMore({ loading: false, error: null }); })
      .catch((e) => setMore({ loading: false, error: asOfficialApiError(e).message }));
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <QueryBox value={filters.q} onSubmit={(q) => onChange({ q })} placeholder="Narrow by title, case or diary number" label="Narrow the list by title, case or diary number" />
        <ActiveFilters filters={filters} onOpenFilters={onOpenFilters} />
      </div>
      <div className="mt-4" aria-live="polite">
        {loading && !docs ? (
          <ul className="divide-y rounded-lg border" aria-busy>{Array.from({ length: 8 }, (_, k) => <li key={k} className="flex gap-3 px-3.5 py-2.5"><Skeleton className="h-3.5 w-20" /><Skeleton className="h-3.5 flex-1" /></li>)}</ul>
        ) : error ? (
          isOfficialUnavailable(error) ? <OfficialUnavailable error={error} /> : <OfficialErrorState title="The list could not be loaded" error={error} onRetry={() => setNonce((n) => n + 1)} />
        ) : docs && !docs.length ? (
          empty && !filters.q && !hasSourceFilters(filters) ? <EmptyCorpus /> : (
            <EmptyState
              icon={SearchX}
              title="No documents match"
              description={filters.q
                ? <>No collected document has &ldquo;{filters.q}&rdquo; in its title, case number or diary number{hasSourceFilters(filters) ? " with these filters" : ""}. The list does not look inside the text: use Search for that.</>
                : "No collected document matches these filters."}
              action={filters.q ? <Button size="xs" variant="outline" onClick={() => onChange({ tab: "search" })}><Search className="size-3.5" />Search the text</Button> : undefined}
            />
          )
        ) : docs ? (
          <>
            <ul className={cn("divide-y rounded-lg border", loading && "opacity-60")}>
              {docs.map((d) => <DocRow key={d.id} d={d} from={from} />)}
            </ul>
            <div className="mt-3 flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <span className="tabular">{fmt(docs.length)} shown, newest first</span>
              {cursor ? <Button size="xs" variant="outline" disabled={more.loading} onClick={loadMore}>{more.loading ? <Spinner size={12} /> : null}Load more</Button> : <span>· end of list</span>}
              {more.error ? <span className="text-destructive">{more.error}</span> : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

function DocRow({ d, from }: { d: SourceDocument; from: string }) {
  const official = safeHttp(d.fileUrl ?? d.url);
  return (
    <li className="grid gap-x-3 gap-y-0.5 px-3.5 py-2.5 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto]">
      <span className="text-[11.5px] text-muted-foreground tabular">{formatDocDate(d.docDate) ?? "undated"}</span>
      <div className="min-w-0">
        <Link href={sourceDocHref(d.id, undefined, from)} className="line-clamp-2 text-[12.5px] font-medium leading-snug hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">{d.title}</Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
          <span>{kindLabel(d.kind)}</span>
          {d.pages ? <span className="tabular">· {d.pages} page{d.pages === 1 ? "" : "s"}</span> : null}
          <span>· {d.status === "indexed" ? extractionLabel(d.extraction) : docStatusLabel(d.status)}</span>
          {isOcrText(d.extraction, d.ocrPages) ? <OcrBadge /> : null}
          <span title="Stored content version; not an independent legal-validity finding">· v{d.version}</span>
          {d.sha256 ? <span title="Source content fingerprint recorded for change detection">· Hash recorded</span> : null}
          {typeof d.meta?.editionLabel === 'string' ? <span title={d.meta.editionLabel}>· Publisher edition</span> : null}
        </div>
      </div>
      {official ? <a href={official} target="_blank" rel="noopener noreferrer" className="inline-flex h-6 items-center gap-1 self-start rounded px-1.5 text-[11.5px] text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" title={official}><FileText className="size-3.5" aria-hidden />{hostOf(official)}<ExternalLink className="size-3" aria-hidden /></a> : <span />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function CoverageTab({ status }: { status: OfficialStatus }) {
  const rows = coverageRows(status).filter(r => !retiredCollectionReason(r.id));
  const storage = storageLine(status);
  const embeddings = status.embeddings === "none" ? "No embeddings: search is by keyword only" : `Embeddings stored (${status.embeddings})`;
  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pb-10 pt-4 sm:px-6">
      <CorpusQualityPanel />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
        <span className="tabular"><span className="font-medium text-foreground/85">{fmt(rows.reduce((n, r) => n + r.documents, 0))}</span> documents collected</span>
        <span aria-hidden>·</span><span>{embeddings}</span>
        {storage ? <><span aria-hidden>·</span><span className="tabular">{storage}</span></> : null}
        <span aria-hidden>·</span>
        <span className="tabular">Queue: {fmt(status.queue.pending)} pending, {fmt(status.queue.running)} running, {fmt(status.queue.failed)} failed</span>
      </div>
      <p className="mt-1 max-w-[100ch] text-[11.5px] leading-snug text-muted-foreground">{COVERAGE_NOTE}</p>
      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[860px] border-collapse text-[12.5px]">
          <thead className="bg-[var(--surface-quiet)] text-left text-[11px] text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:font-medium">
              <th scope="col">Source</th>
              <th scope="col" className="text-right">Documents</th>
              <th scope="col" className="text-right">Text searchable</th>
              <th scope="col" className="text-right" title="Text chunks with an embedding, of all stored chunks (chunks, not documents)">Embedded chunks</th>
              <th scope="col" className="text-right">Waiting</th>
              <th scope="col" className="text-right">OCR needed</th>
              <th scope="col" className="text-right">Failed</th>
              <th scope="col">Last run</th>
              <th scope="col">Last error</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => {
              const last = lastRunOf(r);
              return (
                <tr key={r.id} className="align-top [&>td]:px-3 [&>td]:py-2">
                  <td className="min-w-[220px]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.documents ? <Link href={`/sources?tab=browse&source=${r.id}`} className="font-medium hover:underline">{r.name}</Link> : <span className="font-medium">{r.name}</span>}
                      {!r.enabled ? <Chip tone="muted">Disabled</Chip> : null}
                    </div>
                    <div className="text-[11.5px] text-muted-foreground">{r.publisher}{r.homepage ? <> · <a href={r.homepage} target="_blank" rel="noopener noreferrer" className="hover:text-foreground hover:underline">{hostOf(r.homepage)}</a></> : null}</div>
                    {r.notes.length ? <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{r.notes.join(" ")}</div> : null}
                  </td>
                  <td className="text-right font-medium tabular">{fmt(r.documents)}</td>
                  <td className="text-right tabular">{fmt(r.indexed)}</td>
                  <td className="whitespace-nowrap text-right tabular">{fmt(r.embedded)}<span className="text-muted-foreground"> / {fmt(r.chunks)}</span></td>
                  <td className="text-right tabular text-muted-foreground">{fmt(r.waiting)}</td>
                  <td className={cn("text-right tabular", r.ocrNeeded ? "text-warning-foreground dark:text-warning" : "text-muted-foreground")}>{fmt(r.ocrNeeded)}</td>
                  <td className={cn("text-right tabular", r.failed ? "text-destructive" : "text-muted-foreground")}>{fmt(r.failed)}</td>
                  <td className="whitespace-nowrap text-[11.5px] text-muted-foreground">{last ? formatFetchedAt(last) : "Not run yet"}</td>
                  <td className="max-w-[260px] text-[11.5px]">{r.lastError ? <span className="line-clamp-2 text-destructive" title={r.lastError}>{r.lastError}</span> : <span className="text-muted-foreground">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!rows.length ? <EmptyState className="mt-4" icon={Library} title="No sources are registered" /> : null}
    </div>
  );
}
