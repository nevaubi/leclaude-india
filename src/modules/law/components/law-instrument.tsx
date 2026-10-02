"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, Hash, Info, ListTree, Search, SearchX, TextSearch, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip, EmptyState, Kbd, Spinner } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { displayChapterTitle, displayHeading, groupToc, lawBlocks, type LawBlock } from "../reader";
import {
  citationTitle, displayLawCitation, jurisdictionLabel, legacyIndiaCodeNote, statusTone, LAW_ATTRIBUTION_LINE, LAW_DATASET, lawApiHref, lawHref, repeatedProvisionLabel, NO_SECTION, normSectionKey, normVariant, provisionUnit, publisherLabel, safeHttpUrl, snippetParts,
  type LawInstrument, type LawInstrumentResponse, type LawProvisionHit, type LawSearchResponse, type LawSectionRef, type LawSectionResponse, type LawTocEntry,
} from "../shared";
import { asLawApiError, fetchLawJson, type LawApiError } from "./fetch";
import { isUnavailable, LawErrorState, LawUnavailable, StatusText } from "./law-states";
import { CodeCorrespondence, LegacyLinkNote, SectionStatusChip, StatusBreakdownLine } from "./section-insights";

const fmt = (n: number) => n.toLocaleString("en-IN");
const unitOf = (i: Pick<LawInstrument, "kind" | "title">) => provisionUnit(i).toLowerCase();
const kindLabel = (k: string) => (k === "regulation" ? "Regulation" : k === "report" ? "Report" : "Act");
const sameRef = (a: { section: string; variant: number } | null, b: { section: string; variant: number } | null) => Boolean(a && b && a.section.toLowerCase() === b.section.toLowerCase() && a.variant === b.variant);
const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || Boolean((t as HTMLElement | null)?.isContentEditable);

/** /law/<actId>[?s=<section>&v=<variant>]: one instrument with its table of contents and the selected section. */
export function LawInstrumentView({ id }: { id: string }) {
  const sp = useSearchParams();
  const section = normSectionKey(sp.get("s"));
  const variant = normVariant(sp.get("v"));

  const [data, setData] = React.useState<LawInstrumentResponse | null>(null);
  const [error, setError] = React.useState<LawApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
  const [moreLoading, setMoreLoading] = React.useState(false);
  const [moreError, setMoreError] = React.useState<string | null>(null);
  const [tocOpen, setTocOpen] = React.useState(false);
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchLawJson<LawInstrumentResponse>(lawApiHref(id), ac.signal)
      .then((d) => setData(d))
      .catch((e) => { if ((e as Error).name !== "AbortError") { setData(null); setError(asLawApiError(e)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [id, nonce]);

  const loadMoreToc = React.useCallback(() => {
    if (!data?.toc.hasMore || moreLoading) return;
    setMoreLoading(true);
    setMoreError(null);
    fetchLawJson<LawInstrumentResponse>(lawApiHref(id, { tocOffset: data.toc.offset + data.toc.entries.length }))
      .then((d) => setData((prev) => prev ? { ...prev, toc: { ...d.toc, offset: prev.toc.offset, entries: [...prev.toc.entries, ...d.toc.entries] } } : prev))
      .catch((e) => setMoreError(asLawApiError(e).message))
      .finally(() => setMoreLoading(false));
  }, [data, id, moreLoading]);

  React.useEffect(() => { setTocOpen(false); }, [section, variant]);
  const selected = section ? { section, variant } : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {loading && !data ? <InstrumentSkeleton /> : error ? (
        <>
          <div className="shrink-0 px-4 pt-3 sm:px-6"><BackLink /></div>
          <div className="flex flex-1 items-center justify-center p-6">
            {isUnavailable(error) ? <LawUnavailable error={error} /> : error.notFound || error.status === 400 ? (
              <EmptyState icon={SearchX} title="Act or regulation not found" description="This link does not match an Act or regulation. It may have been mistyped." action={<Button asChild size="xs" variant="outline"><Link href="/law">Open the directory</Link></Button>} />
            ) : <LawErrorState title="The instrument could not be loaded" error={error} onRetry={() => setNonce((n) => n + 1)} />}
          </div>
        </>
      ) : data ? (
        <>
          <InstrumentHeader i={data.instrument} total={data.toc.total} />
          <div className="grid min-h-0 flex-1 border-t md:grid-cols-[296px_minmax(0,1fr)]">
            <div className="hidden min-h-0 border-r md:flex md:flex-col">
              <Toc instrument={data.instrument} toc={data.toc} selected={selected} onMore={loadMoreToc} moreLoading={moreLoading} moreError={moreError} />
            </div>
            <Sheet open={tocOpen} onOpenChange={setTocOpen}>
              <SheetContent side="left" width="max-w-[340px]" className="p-0" aria-describedby={undefined}>
                <SheetTitle className="border-b px-4 py-3 text-[13px]">Contents</SheetTitle>
                <div className="flex min-h-0 flex-1 flex-col">
                  <Toc instrument={data.instrument} toc={data.toc} selected={selected} onMore={loadMoreToc} moreLoading={moreLoading} moreError={moreError} />
                </div>
              </SheetContent>
            </Sheet>
            <main className="min-h-0 min-w-0">
              {section
                ? <SectionPane key={id} instrument={data.instrument} toc={data.toc.entries} section={section} variant={variant} onOpenToc={() => setTocOpen(true)} />
                : <Overview i={data.instrument} toc={data.toc} onOpenToc={() => setTocOpen(true)} />}
            </main>
          </div>
        </>
      ) : null}
    </div>
  );
}

function BackLink({ i }: { i?: LawInstrument }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
      <Link href="/law" className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={(e) => {
        if (typeof window !== "undefined" && window.history.length > 1 && document.referrer) {
          try { if (new URL(document.referrer).pathname === "/law") { e.preventDefault(); window.history.back(); } } catch { /* follow the link */ }
        }
      }}>
        <ArrowLeft className="size-3.5" aria-hidden />Statutes
      </Link>
      {i ? (
        <>
          <span aria-hidden className="text-muted-foreground/50">/</span>
          <Link className="truncate rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" href={i.jurisdiction === "state" && i.state_code ? `/law?j=state&state=${i.state_code}` : i.jurisdiction === "regulator" && i.regulator ? `/law?j=regulator&reg=${encodeURIComponent(i.regulator)}` : `/law?j=${encodeURIComponent(i.jurisdiction)}`}>{jurisdictionLabel(i)}</Link>
        </>
      ) : null}
    </nav>
  );
}

function InstrumentSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy>
      <div className="space-y-2 px-4 pb-3 pt-3 sm:px-6">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-6 w-[min(560px,80%)]" />
        <Skeleton className="h-3.5 w-[min(420px,60%)]" />
      </div>
      <div className="grid min-h-0 flex-1 border-t md:grid-cols-[296px_1fr]">
        <div className="hidden space-y-2 border-r p-3 md:block">{Array.from({ length: 14 }, (_, k) => <Skeleton key={k} className="h-3.5" style={{ width: `${60 + ((k * 13) % 35)}%` }} />)}</div>
        <div className="mx-auto w-full max-w-[76ch] space-y-3 px-6 py-6">
          <Skeleton className="h-3 w-40" /><Skeleton className="h-6 w-2/3" />
          {Array.from({ length: 7 }, (_, k) => <Skeleton key={k} className="h-3.5" style={{ width: `${80 + ((k * 7) % 20)}%` }} />)}
        </div>
      </div>
    </div>
  );
}

function useCopy() {
  const [done, setDone] = React.useState<string | null>(null);
  const copy = React.useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(label);
      toast.success(`${label} copied`);
      setTimeout(() => setDone((d) => (d === label ? null : d)), 1500);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }, []);
  return { done, copy };
}

function OfficialLink({ i, url, size = "xs", variant = "outline", label }: { i: LawInstrument; url: string | null; size?: "xs"; variant?: "outline" | "ghost"; label?: React.ReactNode }) {
  const href = safeHttpUrl(url);
  if (!href) return <span className="text-[12px] text-muted-foreground">Official text link not available</span>;
  const publisher = publisherLabel({ ...i, source_url: href });
  const legacy = legacyIndiaCodeNote(href);
  return (
    <Button asChild size={size} variant={variant} className="max-w-full">
      <a href={href} target="_blank" rel="noopener noreferrer" title={legacy ? `${publisher}. ${legacy}.` : publisher}>
        <ExternalLink className="size-3.5" /><span className="truncate">{label ?? `Official text · ${publisher}`}</span>
      </a>
    </Button>
  );
}

function SourcePopover({ i }: { i: LawInstrument }) {
  const official = safeHttpUrl(i.source_url);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="ghost" aria-label="Source"><Info className="size-3.5" />Source</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0">
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3.5 py-3 text-[12px]">
          <dt className="text-muted-foreground">Published by</dt>
          <dd className="min-w-0 break-words">{i.publisher ?? publisherLabel(i)}</dd>
          <dt className="text-muted-foreground">Official text</dt>
          <dd className="min-w-0">{official ? <><a className="inline-flex items-center gap-1 break-words text-primary hover:underline" href={official} target="_blank" rel="noopener noreferrer">{publisherLabel(i)}<ExternalLink className="size-3" aria-hidden /></a><LegacyLinkNote url={official} className="mt-0.5" /></> : <span className="text-muted-foreground">Not available</span>}</dd>
          {i.amendment_count ? <><dt className="text-muted-foreground">Amendments</dt><dd className="tabular">{i.amendment_count}</dd></> : null}
          {i.subjects.length ? <><dt className="text-muted-foreground">Subjects</dt><dd className="min-w-0">{i.subjects.join(", ")}</dd></> : null}
        </dl>
        <p className="border-t px-3.5 py-2 text-[11px] leading-snug text-muted-foreground">
          Text from Open India Law by {LAW_DATASET.publisher}, licensed under <a className="hover:text-foreground hover:underline" href={LAW_DATASET.licenceUrl} target="_blank" rel="noopener noreferrer">{LAW_DATASET.licence}</a>. It can lag recent amendments; the official text is authoritative.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function InstrumentHeader({ i, total }: { i: LawInstrument; total: number }) {
  return (
    <header className="shrink-0 px-4 pb-3.5 pt-3 sm:px-6">
      <BackLink i={i} />
      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="max-w-[880px] font-serif text-[23px] leading-tight tracking-[-0.01em]">{citationTitle(i)}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
            <span className={cn("inline-flex items-center rounded-full border px-2 py-px", i.status === "in_force" ? "border-success/30 bg-success/5" : statusTone(i.status) === "off" ? "border-warning/40 bg-warning/5" : "")}>
              <StatusText status={i.status} className={cn("text-[11.5px]", i.status === "in_force" && "text-foreground/85")} />
            </span>
            <span>{jurisdictionLabel(i)}</span>
            <span aria-hidden className="text-muted-foreground/50">·</span>
            <span>{kindLabel(i.kind)}{i.year ? <span className="tabular">, {i.year}</span> : null}</span>
            <span aria-hidden className="text-muted-foreground/50">·</span>
            <span className="tabular">{fmt(total || i.sections)} sections</span>
            <StatusBreakdownLine i={i} className="basis-full sm:basis-auto" />
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <OfficialLink i={i} url={i.source_url} label={<>Official text<span className="hidden xl:inline"> · {publisherLabel(i)}</span></>} />
          <LegacyLinkNote url={i.source_url} compact />
          <Button asChild size="xs" variant="ghost"><Link href={`/search?q=${encodeURIComponent(citationTitle(i))}`}><Search className="size-3.5" />Research</Link></Button>
          <SourcePopover i={i} />
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Table of contents (chapter groups, heading filter, full-text search in this instrument)
// ---------------------------------------------------------------------------

function Toc({ instrument, toc, selected, onMore, moreLoading, moreError }: { instrument: LawInstrument; toc: LawInstrumentResponse["toc"]; selected: LawSectionRef | null; onMore: () => void; moreLoading: boolean; moreError: string | null }) {
  const [filter, setFilter] = React.useState("");
  const [textQuery, setTextQuery] = React.useState<string | null>(null);
  const f = filter.trim().toLowerCase();
  const groups = React.useMemo(() => {
    const entries = f ? toc.entries.filter((e) => `${e.section} ${displayHeading(e.heading) ?? ""} ${displayChapterTitle(e.chapter_title) ?? ""}`.toLowerCase().includes(f)) : toc.entries;
    return groupToc(entries);
  }, [f, toc.entries]);
  const count = groups.reduce((n, g) => n + g.entries.length, 0);
  const selRef = React.useRef<HTMLAnchorElement | null>(null);
  React.useEffect(() => { selRef.current?.scrollIntoView({ block: "center" }); }, [selected?.section, selected?.variant]);

  return (
    <nav className="flex min-h-0 flex-1 flex-col" aria-label="Table of contents">
      <form className="shrink-0 border-b p-2" role="search" onSubmit={(e) => { e.preventDefault(); if (filter.trim().length >= 2) setTextQuery(filter.trim()); }}>
        <div className="relative">
          <TextSearch className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input size="xs" value={filter} onChange={(e) => { setFilter(e.target.value); if (!e.target.value) setTextQuery(null); }} onKeyDown={(e) => { if (e.key === "Escape" && filter) { e.preventDefault(); setFilter(""); setTextQuery(null); } }} placeholder={`Search ${fmt(toc.total)} sections`} aria-label="Search this instrument" className="pl-7 pr-7" maxLength={120} />
          {filter ? <button type="button" aria-label="Clear" onClick={() => { setFilter(""); setTextQuery(null); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button> : null}
        </div>
        {f && !textQuery ? (
          <button type="submit" disabled={filter.trim().length < 2} className="mt-1.5 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] text-primary hover:bg-accent disabled:text-muted-foreground">
            <Search className="size-3" aria-hidden /><span className="min-w-0 truncate">Search the text for “{filter.trim()}”</span><Kbd className="ml-auto rounded border px-1 text-[10px] text-muted-foreground">↵</Kbd>
          </button>
        ) : null}
      </form>
      {textQuery ? (
        <InActSearch instrument={instrument} q={textQuery} onClose={() => setTextQuery(null)} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pb-2 scrollbar-thin">
          {!toc.entries.length ? <p className="px-3 py-3 text-[12px] text-muted-foreground">No provisions are stored for this instrument.</p> : null}
          {f && !count ? <p className="px-3 py-3 text-[12px] text-muted-foreground">No loaded heading matches “{filter}”. Press Enter to search the text{toc.hasMore ? ", or load more sections" : ""}.</p> : null}
          {groups.map((g, gi) => (
            <div key={`${g.key}|${gi}`}>
              {g.title || g.chapter ? (
                <div className="sticky top-0 z-[1] border-b border-line-quiet bg-background/95 px-3 pb-1.5 pt-2.5 backdrop-blur-sm">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {g.chapter ? <span className="tabular">Chapter {g.chapter}</span> : null}
                    {g.outOfSequence ? (
                      <Tip label="These entries appear out of statutory order under this chapter (often preamble or objects text). Check the official text for their placement.">
                        <span tabIndex={0} className="ml-auto rounded px-1 normal-case tracking-normal text-warning-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-warning">out of order</span>
                      </Tip>
                    ) : null}
                  </div>
                  {g.title ? <div className="truncate text-[12px] font-medium text-foreground/85 lowercase first-letter:uppercase" title={g.title}>{g.title}</div> : null}
                </div>
              ) : gi > 0 ? <div className="mx-3 my-1 border-t border-line-quiet" /> : null}
              <ul className="py-0.5">
                {g.entries.map((e) => {
                  const sel = sameRef(selected, e);
                  const heading = displayHeading(e.heading);
                  return (
                    <li key={`${e.section}|${e.variant}`}>
                      <Link
                        ref={sel ? selRef : undefined}
                        href={lawHref(instrument.id, e.section, e.variant)}
                        scroll={false}
                        aria-current={sel ? "page" : undefined}
                        className={cn(
                          "grid grid-cols-[2.6rem_minmax(0,1fr)] items-baseline gap-1 border-l-2 py-[3px] pl-2.5 pr-3 text-[12.5px] leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
                          sel ? "border-primary bg-primary/8 text-foreground" : "border-transparent text-foreground/80 hover:bg-accent hover:text-foreground",
                        )}
                        title={heading ? `${e.section === NO_SECTION ? "" : `${e.section}. `}${heading}` : undefined}
                      >
                        <span className={cn("truncate text-right tabular", sel ? "font-semibold text-primary" : "text-muted-foreground")}>{e.section === NO_SECTION ? "—" : e.section}</span>
                        <span className="truncate">
                          {e.section === NO_SECTION ? heading ?? "Preamble and unnumbered text" : heading ?? <span className="text-muted-foreground">Untitled</span>}
                          {e.variant ? <span className="text-muted-foreground"> · {repeatedProvisionLabel(instrument, e.section, e.variant)}</span> : null}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {toc.hasMore ? (
            <div className="px-3 py-2">
              <Button size="xs" variant="ghost" disabled={moreLoading} onClick={onMore}>{moreLoading ? <Spinner size={12} /> : null}Load more ({fmt(toc.entries.length)} of {fmt(toc.total)} shown)</Button>
              {moreError ? <p className="mt-1 text-[11.5px] text-destructive">{moreError}</p> : null}
            </div>
          ) : null}
        </div>
      )}
    </nav>
  );
}

function Snippet({ text }: { text: string }) {
  return <>{snippetParts(text).map((p, k) => (p.mark ? <mark key={k} className="rounded-[2px] bg-primary/12 px-px text-foreground">{p.text}</mark> : <React.Fragment key={k}>{p.text}</React.Fragment>))}</>;
}

function InActSearch({ instrument, q, onClose }: { instrument: LawInstrument; q: string; onClose: () => void }) {
  const [res, setRes] = React.useState<LawSearchResponse | null>(null);
  const [error, setError] = React.useState<LawApiError | null>(null);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    setRes(null);
    setError(null);
    const qs = new URLSearchParams({ q, act: instrument.id, status: "all", limit: "50" });
    fetchLawJson<LawSearchResponse>(`/api/law/search?${qs}`, ac.signal)
      .then(setRes)
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(asLawApiError(e)); });
    return () => ac.abort();
  }, [instrument.id, q, nonce]);
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin" aria-live="polite">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11.5px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{res ? `${res.hits.length}${res.hasMore ? "+" : ""} section${res.hits.length === 1 ? "" : "s"} mention “${q}”` : error ? "Search failed" : <span className="inline-flex items-center gap-1.5"><Spinner size={11} />Searching the text…</span>}</span>
        <button type="button" onClick={onClose} className="shrink-0 text-primary hover:underline">Contents</button>
      </div>
      {error ? <LawErrorState className="p-5" title="The text could not be searched" error={error} onRetry={() => setNonce((n) => n + 1)} /> : null}
      {res?.broadened ? <p className="border-b px-3 py-1.5 text-[11.5px] text-warning-foreground dark:text-warning">No section has every word; showing sections with some of them.</p> : null}
      {res && !res.hits.length ? <p className="px-3 py-3 text-[12px] text-muted-foreground">No section of this instrument contains “{q}”.</p> : null}
      <ul className="divide-y divide-line-quiet">
        {res?.hits.map((h: LawProvisionHit) => (
          <li key={`${h.section}|${h.variant}`}>
            <Link href={lawHref(instrument.id, h.section, h.variant)} scroll={false} className="block px-3 py-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50">
              <div className="truncate text-[12.5px]"><span className="font-medium tabular">{h.section === NO_SECTION ? "Unnumbered" : h.section}</span>{displayHeading(h.heading) ? <span className="text-foreground/80"> · {displayHeading(h.heading)}</span> : null}</div>
              {h.snippet ? <p className="mt-0.5 line-clamp-3 text-[11.5px] leading-snug text-muted-foreground"><Snippet text={h.snippet} /></p> : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview (no section selected)
// ---------------------------------------------------------------------------

function Overview({ i, toc, onOpenToc }: { i: LawInstrument; toc: LawInstrumentResponse["toc"]; onOpenToc: () => void }) {
  const groups = React.useMemo(() => {
    // Statutory arrangement: runs the dataset puts out of order are left out here (they stay in the contents), and
    // a chapter split around such a run is shown once.
    const out: ReturnType<typeof groupToc> = [];
    for (const g of groupToc(toc.entries)) {
      if (!(g.title || g.chapter) || g.outOfSequence) continue;
      const last = out[out.length - 1];
      if (last && last.key === g.key) out[out.length - 1] = { ...last, entries: [...last.entries, ...g.entries] };
      else out.push(g);
    }
    return out;
  }, [toc.entries]);
  const first = toc.entries.find((e) => e.section !== NO_SECTION) ?? toc.entries[0] ?? null;
  return (
    <div className="h-full overflow-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[76ch] px-5 py-6 sm:px-8">
        <div className="flex flex-wrap items-center gap-2">
          {first ? <Button asChild size="sm"><Link href={lawHref(i.id, first.section, first.variant)} scroll={false}>Start reading at {first.section === NO_SECTION ? "the preamble" : `${unitOf(i)} ${first.section}`}<ChevronRight className="size-3.5" /></Link></Button> : null}
          <Button size="sm" variant="outline" className="md:hidden" onClick={onOpenToc}><ListTree className="size-3.5" />Contents</Button>
        </div>
        {groups.length ? (
          <section className="mt-6" aria-labelledby="law-outline">
            <h2 id="law-outline" className="text-[12px] font-medium text-muted-foreground">Arrangement</h2>
            <ol className="mt-2 divide-y rounded-lg border">
              {groups.map((g, k) => {
                const a = g.entries[0];
                const b = g.entries[g.entries.length - 1];
                return (
                  <li key={`${g.key}|${k}`}>
                    <Link href={lawHref(i.id, a.section, a.variant)} scroll={false} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-baseline gap-3 px-3 py-2 text-[12.5px] hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50">
                      <span className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground tabular">{g.chapter ? `Chapter ${g.chapter}` : ""}</span>
                      <span className="truncate text-foreground/90 lowercase first-letter:uppercase">{g.title}</span>
                      <span className="text-[11.5px] text-muted-foreground tabular">{a.section === b.section ? a.section : `${a.section}–${b.section}`}</span>
                    </Link>
                  </li>
                );
              })}
            </ol>
            {toc.hasMore ? <p className="mt-1.5 text-[11.5px] text-muted-foreground">Arrangement of the first {fmt(toc.entries.length)} of {fmt(toc.total)} sections.</p> : null}
          </section>
        ) : null}
        <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground">{LAW_ATTRIBUTION_LINE}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section reader
// ---------------------------------------------------------------------------

function SectionPane({ instrument, toc, section, variant, onOpenToc }: { instrument: LawInstrument; toc: LawTocEntry[]; section: string; variant: number; onOpenToc: () => void }) {
  const router = useRouter();
  const [data, setData] = React.useState<LawSectionResponse | null>(null);
  const [error, setError] = React.useState<LawApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
  const [flash, setFlash] = React.useState<string | null>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const { done, copy } = useCopy();

  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchLawJson<LawSectionResponse>(lawApiHref(instrument.id, { section, variant }), ac.signal)
      .then((d) => setData(d))
      .catch((e) => { if ((e as Error).name !== "AbortError") { setData(null); setError(asLawApiError(e)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [instrument.id, section, variant, nonce]);

  // New section: start at the top, or at the deep-linked paragraph when the URL carries one.
  const shownKey = data ? `${data.section.section}|${data.section.variant}` : null;
  React.useEffect(() => {
    if (!shownKey) return;
    const hash = typeof window !== "undefined" ? decodeURIComponent(window.location.hash.slice(1)) : "";
    const el = hash ? document.getElementById(hash) : null;
    if (el) { el.scrollIntoView({ block: "start" }); setFlash(hash); const t = setTimeout(() => setFlash(null), 1800); return () => clearTimeout(t); }
    scroller.current?.scrollTo({ top: 0 });
  }, [shownKey]);

  const go = React.useCallback((ref: LawSectionRef | null | undefined) => { if (ref) router.push(lawHref(instrument.id, ref.section, ref.variant), { scroll: false }); }, [instrument.id, router]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !data) return;
      if (e.key === "[" || e.key === "ArrowLeft") { if (data.prev) { e.preventDefault(); go(data.prev); } }
      else if (e.key === "]" || e.key === "ArrowRight") { if (data.next) { e.preventDefault(); go(data.next); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, go]);

  const sectionUrl = (anchor?: string | null) => `${typeof window !== "undefined" ? window.location.origin : ""}${lawHref(instrument.id, section, variant)}${anchor ? `#${anchor}` : ""}`;
  const copyAnchor = (anchor: string) => {
    window.history.replaceState(window.history.state, "", `${lawHref(instrument.id, section, variant)}#${anchor}`);
    setFlash(anchor);
    setTimeout(() => setFlash((f) => (f === anchor ? null : f)), 1800);
    void copy(sectionUrl(anchor), "Link to paragraph");
  };
  const headingOf = (ref: LawSectionRef | null | undefined) => (ref ? displayHeading(toc.find((e) => sameRef(e, ref))?.heading) : null);
  const cite = displayLawCitation(instrument, section, variant);
  const shortCite = cite.split(",")[0];

  const toolbar = (
    <div className="sticky-actions flex h-10 shrink-0 items-center gap-1 border-b px-3 sm:px-5">
      <Button size="xs" variant="ghost" className="md:hidden" onClick={onOpenToc} aria-label="Contents"><ListTree className="size-3.5" />Contents</Button>
      <span className="min-w-0 truncate text-[12.5px] font-medium tabular">{shortCite}</span>
      <div className="ml-auto flex items-center gap-0.5">
        <Tip label="Previous section" shortcut="[">
          <Button size="icon-xs" variant="ghost" aria-label="Previous section" disabled={!data?.prev} onClick={() => go(data?.prev)}><ChevronLeft className="size-4" /></Button>
        </Tip>
        <Tip label="Next section" shortcut="]">
          <Button size="icon-xs" variant="ghost" aria-label="Next section" disabled={!data?.next} onClick={() => go(data?.next)}><ChevronRight className="size-4" /></Button>
        </Tip>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <Button size="xs" variant="ghost" disabled={!data} onClick={() => data && copy(cite, "Citation")} aria-label="Copy citation">{done === "Citation" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}<span className="hidden sm:inline">Cite</span></Button>
        <Button size="xs" variant="ghost" onClick={() => copy(sectionUrl(), "Link")} aria-label="Copy link to this section">{done === "Link" ? <Check className="size-3.5" /> : <Hash className="size-3.5" />}<span className="hidden sm:inline">Link</span></Button>
        <Button asChild size="xs" variant="ghost"><Link href={`/search?q=${encodeURIComponent(data?.citation ?? cite)}`} aria-label="Research this section"><Search className="size-3.5" /><span className="hidden lg:inline">Research this section</span></Link></Button>
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (loading && !data) {
    body = <div className="mx-auto w-full max-w-[76ch] space-y-3 px-5 py-7 sm:px-8" aria-busy><Skeleton className="h-3 w-48" /><Skeleton className="h-6 w-1/2" />{Array.from({ length: 8 }, (_, k) => <Skeleton key={k} className="h-3.5" style={{ width: `${78 + ((k * 9) % 22)}%` }} />)}</div>;
  } else if (error) {
    body = error.notFound || error.status === 400
      ? <EmptyState className="mt-10" icon={SearchX} title={`No ${section === NO_SECTION ? "unnumbered provisions" : `section ${section}`} in this instrument`} description={<>{instrument.title} has no provision {section === NO_SECTION ? "without a number" : <>numbered <strong>{section}</strong></>} here. Pick one from the contents.</>} />
      : isUnavailable(error) ? <div className="mt-10"><LawUnavailable error={error} /></div>
      : <LawErrorState className="mt-10" title="The section could not be loaded" error={error} onRetry={() => setNonce((n) => n + 1)} />;
  } else if (data) {
    const s = data.section;
    const heading = displayHeading(s.heading);
    const blocks = lawBlocks(s.text, s.section);
    const chapter = displayChapterTitle(s.chapter_title);
    body = (
      <article className={cn("mx-auto w-full max-w-[74ch] px-5 pb-12 pt-7 sm:px-8", loading && "opacity-70")} aria-label={cite}>
        {chapter || s.chapter ? <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{s.chapter ? `Chapter ${s.chapter}` : ""}{s.chapter && chapter ? " · " : ""}{chapter ? <span className="normal-case tracking-normal text-[12px]"><span className="inline-block lowercase first-letter:uppercase">{chapter}</span></span> : null}</div> : null}
        <h2 className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {section === NO_SECTION ? <span className="font-serif text-[24px] leading-snug tracking-[-0.01em]">{heading ?? "Preamble and unnumbered text"}</span> : <>
            <span className="inline-flex items-baseline gap-1 rounded-md bg-muted px-2 py-0.5 text-[13px] font-semibold text-foreground/80 tabular"><span className="sr-only">{shortCite}</span><span aria-hidden>{shortCite.replace(/^(Section|Rule|Regulation|Clause) /, (m) => (m.startsWith("Section") ? "§ " : m))}</span></span>
            {heading ? <span className="font-serif text-[24px] leading-snug tracking-[-0.01em]">{heading}</span> : null}
          </>}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <SectionStatusChip status={s.status} inForce={s.in_force} />
          {s.has_proviso ? <Chip tone="muted">Proviso</Chip> : null}
          {s.has_non_obstante ? <Chip tone="muted">Non obstante clause</Chip> : null}
          {s.provision_type ? <Chip tone="muted">{s.provision_type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</Chip> : null}
          <OfficialLink i={instrument} url={s.source_url ?? instrument.source_url} variant="ghost" label="Official text" />
        </div>
        <LegacyLinkNote url={safeHttpUrl(s.source_url ?? instrument.source_url)} className="mt-1" />
        <CodeCorrespondence instrument={instrument} section={s.section} />
        {data.variants.length ? (
          <p className="mt-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] text-foreground/85">This {unitOf(instrument)} number appears more than once in this instrument. Also see the{" "}
            {data.variants.map((v, k) => <React.Fragment key={v}>{k ? ", " : ""}<Link className="text-primary underline-offset-2 hover:underline" href={lawHref(instrument.id, section, v)} scroll={false}>{repeatedProvisionLabel(instrument, section, v)}</Link></React.Fragment>)}. Check the official text.
          </p>
        ) : null}
        <div className="mt-5">
          {blocks.length ? <StatuteText blocks={blocks} flash={flash} onAnchor={copyAnchor} /> : <p className="text-[13px] text-muted-foreground">No text is available for this provision. Read it in the official text.</p>}
        </div>
        {s.truncated ? <p className="mt-4 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] text-foreground/85">Shown in part: the section has {fmt(s.chars)} characters. Read the rest in the official text.</p> : null}
        {s.defined_terms.length || s.acts_referenced.length ? (
          <dl className="mt-6 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t pt-3 text-[12px]">
            {s.defined_terms.length ? <><dt className="text-muted-foreground">Defines</dt><dd className="flex flex-wrap gap-1">{s.defined_terms.map((t) => <Chip key={t} tone="muted">{t}</Chip>)}</dd></> : null}
            {s.acts_referenced.length ? <><dt className="text-muted-foreground">Refers to</dt><dd className="flex flex-wrap gap-1">{s.acts_referenced.map((t) => <Link key={t} href={`/law?q=${encodeURIComponent(t)}&status=all`} className="rounded-[var(--radius-chip)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><Chip tone="muted" className="hover:text-foreground">{t}</Chip></Link>)}</dd></> : null}
          </dl>
        ) : null}
        <nav className="mt-8 grid gap-2 sm:grid-cols-2" aria-label="Adjacent sections">
          {data.prev ? <AdjacentLink dir="prev" href={lawHref(instrument.id, data.prev.section, data.prev.variant)} label={data.prev.section === NO_SECTION ? "Unnumbered text" : `${instrument.kind === "regulation" ? "" : "Section "}${data.prev.section}`} heading={headingOf(data.prev)} /> : <span />}
          {data.next ? <AdjacentLink dir="next" href={lawHref(instrument.id, data.next.section, data.next.variant)} label={data.next.section === NO_SECTION ? "Unnumbered text" : `${instrument.kind === "regulation" ? "" : "Section "}${data.next.section}`} heading={headingOf(data.next)} /> : null}
        </nav>
        <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground">
          Text: {LAW_DATASET.name} ({LAW_DATASET.licence}). The authoritative version is published by {publisherLabel(instrument)}.
        </p>
      </article>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto scroll-pt-14 scrollbar-thin">{body}</div>
    </div>
  );
}

function AdjacentLink({ dir, href, label, heading }: { dir: "prev" | "next"; href: string; label: string; heading: string | null }) {
  return (
    <Link href={href} scroll={false} className={cn("group flex min-w-0 flex-col rounded-lg border px-3 py-2 transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", dir === "next" && "items-end text-right sm:col-start-2")}>
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">{dir === "prev" ? <><ChevronLeft className="size-3" aria-hidden />Previous</> : <>Next<ChevronRight className="size-3" aria-hidden /></>}</span>
      <span className="mt-0.5 max-w-full truncate text-[12.5px] font-medium tabular">{label}{heading ? <span className="font-normal text-foreground/75"> · {heading}</span> : null}</span>
    </Link>
  );
}

/** The statute body: serif reading text with hanging labels for sub-sections and clauses, ruled provisos and explanations. */
function StatuteText({ blocks, flash, onAnchor }: { blocks: LawBlock[]; flash: string | null; onAnchor: (a: string) => void }) {
  return (
    <div className="font-serif text-[15.5px] leading-[1.72] text-foreground">
      {blocks.map((b, k) => {
        const anchorBtn = b.anchor ? (
          <button type="button" onClick={() => onAnchor(b.anchor!)} aria-label="Copy link to this paragraph" className="absolute -left-5 top-[0.35em] rounded p-0.5 font-sans text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100">
            <Hash className="size-3.5" />
          </button>
        ) : null;
        const wrap = (cls: string, children: React.ReactNode) => (
          <div key={k} id={b.anchor ?? undefined} className={cn("group relative scroll-mt-14 rounded-sm transition-colors duration-700", flash && b.anchor === flash && "bg-primary/8", cls)}>
            {anchorBtn}{children}
          </div>
        );
        switch (b.kind) {
          case "headnote":
            return <div key={k} className={cn("text-center font-sans text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground", k === 0 ? "" : "mt-0.5", blocks[k + 1]?.kind !== "headnote" && "mb-5")}>{b.text}</div>;
          case "lead":
            return wrap("mt-0", <p className="whitespace-pre-line"><span className="font-semibold">{b.label}</span>{b.text}</p>);
          case "subsection":
            return wrap("mt-4 pl-9", <p className="whitespace-pre-line"><span className="absolute left-0 font-sans text-[13px] font-medium text-muted-foreground tabular" style={{ top: "0.2em" }}>{b.label.trim()}</span>{b.text}</p>);
          case "clause":
            return wrap("mt-2 pl-[4.25rem]", <p className="whitespace-pre-line"><span className="absolute left-9 font-sans text-[13px] text-muted-foreground" style={{ top: "0.2em" }}>{b.label.trim()}</span>{b.text}</p>);
          case "explanation":
            return wrap("mt-4 border-l-2 border-line-quiet pl-4", <p className="whitespace-pre-line text-foreground/90"><span className="font-semibold text-foreground/75">{b.label}</span>{b.text}</p>);
          case "illustrations":
            return wrap("mt-6 mb-1", <p className="font-sans text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{b.label}</p>);
          case "illustration":
            return wrap("mt-2 pl-9 text-[14.5px] text-foreground/85", <p className="whitespace-pre-line"><span className="absolute left-2 font-sans text-[12.5px] italic text-muted-foreground" style={{ top: "0.2em" }}>{b.label.trim()}</span>{b.text}</p>);
          case "proviso":
            return wrap("mt-4 ml-9 border-l-2 border-primary/25 pl-4", <p className="whitespace-pre-line"><span className="italic">{b.label}</span>{b.text}</p>);
          default:
            return wrap("mt-4", <p className="whitespace-pre-line">{b.text}</p>);
        }
      })}
    </div>
  );
}
