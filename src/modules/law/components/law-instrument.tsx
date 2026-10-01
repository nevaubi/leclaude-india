"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FileText, Search, SearchX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Spinner } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  jurisdictionLabel, LAW_DATASET, lawApiHref, lawCitation, lawHref, normSectionKey, normVariant, publisherLabel, safeHttpUrl, tocLabel, urlHostOf,
  type LawInstrument, type LawInstrumentResponse, type LawSectionResponse, type LawTocEntry,
} from "../shared";
import { asLawApiError, fetchLawJson, type LawApiError } from "./fetch";
import { AttributionNote, isUnavailable, LawErrorState, LawUnavailable, StatusText } from "./law-states";

const fmt = (n: number) => n.toLocaleString("en-IN");

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3 sm:px-6"><BackLink /></div>
      {loading && !data ? <InstrumentSkeleton /> : error ? (
        <div className="flex flex-1 items-center justify-center p-6">
          {isUnavailable(error) ? <LawUnavailable error={error} /> : error.notFound || error.status === 400 ? (
            <EmptyState icon={SearchX} title="No instrument with this id in the statutes corpus" description={<>The id <code className="break-all text-[11px]">{id}</code> does not match any Act or regulation. It may have been mistyped; no other instrument is shown in its place.</>} action={<Button asChild size="xs" variant="outline"><Link href="/law">Open the directory</Link></Button>} />
          ) : <LawErrorState title="The instrument could not be loaded" error={error} onRetry={() => setNonce((n) => n + 1)} />}
        </div>
      ) : data ? (
        <>
          <InstrumentHeader i={data.instrument} />
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,40%)_minmax(0,1fr)] border-t md:grid-cols-[300px_minmax(0,1fr)] md:grid-rows-1">
            <Toc instrument={data.instrument} toc={data.toc} selected={section ? { section, variant } : null} onMore={loadMoreToc} moreLoading={moreLoading} moreError={moreError} />
            <div className="min-h-0 overflow-auto border-t scrollbar-thin md:border-l md:border-t-0">
              {section ? <SectionPane instrument={data.instrument} section={section} variant={variant} /> : <Overview i={data.instrument} total={data.toc.total} first={data.toc.entries[0] ?? null} />}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/law" className="inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={(e) => {
      if (typeof window !== "undefined" && window.history.length > 1 && document.referrer && new URL(document.referrer).pathname === "/law") { e.preventDefault(); window.history.back(); }
    }}>
      <ArrowLeft className="size-3.5" aria-hidden />Statutes
    </Link>
  );
}

function InstrumentSkeleton() {
  return (
    <div className="space-y-3 px-4 pt-3 sm:px-6" aria-busy>
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      <div className="grid gap-4 md:grid-cols-[300px_1fr]"><Skeleton className="h-80" /><Skeleton className="h-80" /></div>
    </div>
  );
}

function CopyButton({ value, label, text }: { value: string; label: string; text?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      aria-label={`Copy ${label}`}
      title={value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast.success(`${label} copied`);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Could not copy to the clipboard");
        }
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{text ?? label}
    </Button>
  );
}

function OfficialLink({ i, url, compact }: { i: LawInstrument; url: string | null; compact?: boolean }) {
  const href = safeHttpUrl(url);
  if (!href) return <span className="text-[12px] text-muted-foreground">No publisher link in the dataset</span>;
  const publisher = publisherLabel({ ...i, source_url: href });
  return (
    <Button asChild size="xs" variant="outline" className="max-w-full">
      <a href={href} target="_blank" rel="noopener noreferrer" title={href}>
        <ExternalLink className="size-3.5" />{compact ? "Official text" : `Official text · ${publisher}`}<span className="min-w-0 truncate text-muted-foreground">{compact ? ` · ${publisher}` : ""}</span>
      </a>
    </Button>
  );
}

function InstrumentHeader({ i }: { i: LawInstrument }) {
  const mirror = safeHttpUrl(i.mirror_url);
  return (
    <div className="shrink-0 px-4 pb-3 pt-2 sm:px-6">
      <h1 className="max-w-[960px] text-[18px] font-semibold leading-snug tracking-[-0.01em]">{i.title}</h1>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
        <span className="text-foreground/85">{jurisdictionLabel(i)}</span>
        <span aria-hidden>·</span>
        <span>{i.kind === "regulation" ? "Regulation" : i.kind === "report" ? "Report" : "Act"}</span>
        {i.year ? <><span aria-hidden>·</span><span className="tabular">{i.year}</span></> : null}
        <span aria-hidden>·</span>
        <StatusText status={i.status} />
        {i.amendment_count != null ? <><span aria-hidden>·</span><span className="tabular">{i.amendment_count} amendment{i.amendment_count === 1 ? "" : "s"} recorded</span></> : null}
        {i.publisher ? <><span aria-hidden>·</span><span className="truncate">{i.publisher}</span></> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <OfficialLink i={i} url={i.source_url} />
        {mirror ? (
          <Button asChild size="xs" variant="ghost">
            <a href={mirror} target="_blank" rel="noopener noreferrer" title={`Dataset mirror of the publisher's PDF (${urlHostOf(mirror)}) — not the official source`}><FileText className="size-3.5" />Dataset mirror (PDF)</a>
          </Button>
        ) : null}
        <Button asChild size="xs" variant="ghost"><Link href={`/search?q=${encodeURIComponent(i.title)}`}><Search className="size-3.5" />Research this</Link></Button>
      </div>
      <AttributionNote version={i.dataset_version} className="mt-1.5 block" />
    </div>
  );
}

function Toc({ instrument, toc, selected, onMore, moreLoading, moreError }: { instrument: LawInstrument; toc: LawInstrumentResponse["toc"]; selected: { section: string; variant: number } | null; onMore: () => void; moreLoading: boolean; moreError: string | null }) {
  const [filter, setFilter] = React.useState("");
  const f = filter.trim().toLowerCase();
  const entries = f ? toc.entries.filter((e) => tocLabel(e).toLowerCase().includes(f) || (e.chapter_title ?? "").toLowerCase().includes(f)) : toc.entries;
  const selRef = React.useRef<HTMLAnchorElement | null>(null);
  React.useEffect(() => { selRef.current?.scrollIntoView({ block: "nearest" }); }, [selected?.section, selected?.variant]);
  const isSel = (e: LawTocEntry) => Boolean(selected && e.section.toLowerCase() === selected.section.toLowerCase() && e.variant === selected.variant);
  let lastChapter: string | null = null;
  return (
    <nav className="flex min-h-0 flex-col" aria-label="Table of contents">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <Input size="xs" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${fmt(toc.total)} sections`} aria-label="Filter sections" className="flex-1" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 scrollbar-thin">
        {!toc.entries.length ? <p className="px-3 py-3 text-[12px] text-muted-foreground">No provisions are stored for this instrument.</p> : null}
        {f && !entries.length ? <p className="px-3 py-3 text-[12px] text-muted-foreground">No loaded section matches “{filter}”.{toc.hasMore ? " Load more sections to search further." : ""}</p> : null}
        <ul>
          {entries.map((e) => {
            const chapter = e.chapter_title && e.chapter_title !== lastChapter ? e.chapter_title : null;
            if (e.chapter_title) lastChapter = e.chapter_title;
            const sel = isSel(e);
            return (
              <li key={`${e.section}|${e.variant}`}>
                {chapter && !f ? <div className="px-3 pb-0.5 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">{e.chapter ? `Chapter ${e.chapter} · ` : ""}{chapter}</div> : null}
                <Link
                  ref={sel ? selRef : undefined}
                  href={lawHref(instrument.id, e.section, e.variant)}
                  scroll={false}
                  aria-current={sel ? "true" : undefined}
                  className={cn("block truncate px-3 py-[3px] text-[12.5px] leading-snug hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50", sel ? "bg-primary/8 font-medium text-primary" : "text-foreground/85")}
                  title={tocLabel(e)}
                >
                  {tocLabel(e)}{e.variant ? <span className="text-muted-foreground"> (variant {e.variant + 1})</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
        {toc.hasMore ? (
          <div className="px-3 py-2">
            <Button size="xs" variant="ghost" disabled={moreLoading} onClick={onMore}>{moreLoading ? <Spinner size={12} /> : null}Load next sections ({fmt(toc.entries.length)} of {fmt(toc.total)} shown)</Button>
            {moreError ? <p className="mt-1 text-[11.5px] text-destructive">{moreError}</p> : null}
          </div>
        ) : null}
      </div>
    </nav>
  );
}

function Overview({ i, total, first }: { i: LawInstrument; total: number; first: LawTocEntry | null }) {
  return (
    <div className="max-w-[820px] px-4 py-4 sm:px-6">
      <p className="text-[13px] text-foreground/85">Select a section from the table of contents{first ? <> or <Link className="text-primary hover:underline" href={lawHref(i.id, first.section, first.variant)} scroll={false}>start at {tocLabel(first)}</Link></> : null}.</p>
      <dl className="mt-4 grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
        <dt className="text-muted-foreground">Sections</dt><dd className="tabular">{fmt(total)}{i.provisions ? ` (${fmt(i.provisions)} provision records)` : ""}</dd>
        <dt className="text-muted-foreground">Jurisdiction</dt><dd>{jurisdictionLabel(i)}</dd>
        <dt className="text-muted-foreground">Status</dt><dd><StatusText status={i.status} /></dd>
        <dt className="text-muted-foreground">Official source</dt><dd>{safeHttpUrl(i.source_url) ? publisherLabel(i) : "Not recorded"}</dd>
        {i.subjects.length ? <><dt className="text-muted-foreground">Subjects</dt><dd>{i.subjects.join(", ")}</dd></> : null}
        <dt className="text-muted-foreground">Dataset</dt><dd>{LAW_DATASET.name} {i.dataset_version} · {i.dataset_file}</dd>
        <dt className="text-muted-foreground">Instrument id</dt><dd className="font-mono text-[11.5px]">{i.id}</dd>
      </dl>
      <p className="mt-4 text-[11.5px] leading-relaxed text-muted-foreground">The text shown here is a third-party, section-level parse ({LAW_DATASET.attribution}). It can lag amendments or mis-split provisions; rely on the official text at the publisher&apos;s page.</p>
    </div>
  );
}

function SectionPane({ instrument, section, variant }: { instrument: LawInstrument; section: string; variant: number }) {
  const [data, setData] = React.useState<LawSectionResponse | null>(null);
  const [error, setError] = React.useState<LawApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
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

  const cite = lawCitation(instrument, section, variant);
  if (loading && !data) {
    return <div className="space-y-2 px-4 py-4 sm:px-6" aria-busy><Skeleton className="h-4 w-1/3" /><Skeleton className="h-5 w-1/2" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div>;
  }
  if (error) {
    if (error.notFound || error.status === 400) {
      return <EmptyState className="mt-10" icon={SearchX} title={`No ${section === "_" ? "unnumbered provisions" : `section ${section}`} in this instrument`} description={<>The corpus has no provision {section === "_" ? "without a number" : <>numbered <strong>{section}</strong>{variant ? ` (variant ${variant + 1})` : ""}</>} in {instrument.title}. No other section is shown in its place; pick one from the table of contents.</>} />;
    }
    if (isUnavailable(error)) return <div className="mt-10"><LawUnavailable error={error} /></div>;
    return <LawErrorState className="mt-10" title="The section could not be loaded" error={error} onRetry={() => setNonce((n) => n + 1)} />;
  }
  if (!data) return null;
  const s = data.section;
  return (
    <article className={cn("max-w-[860px] px-4 py-4 sm:px-6", loading && "opacity-70")} aria-label={data.citation}>
      {s.chapter_title ? <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{s.chapter ? `Chapter ${s.chapter} · ` : ""}{s.chapter_title}</div> : null}
      <h2 className="mt-1 text-[15.5px] font-semibold leading-snug">{section === "_" ? s.heading ?? "Preamble and unnumbered text" : <>{cite.split(",")[0]}{s.heading ? <span className="font-normal text-foreground/85"> — {s.heading}</span> : null}</>}</h2>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <CopyButton value={data.citation} label="Citation" text="Copy citation" />
        <OfficialLink i={instrument} url={s.source_url ?? instrument.source_url} compact />
        {s.in_force === false ? <span className="text-[12px] text-warning-foreground dark:text-warning">Marked not in force in the dataset</span> : null}
        {s.has_non_obstante ? <span className="rounded-[var(--radius-chip)] bg-muted px-1.5 text-[11px] text-muted-foreground">non obstante clause</span> : null}
        {s.has_proviso ? <span className="rounded-[var(--radius-chip)] bg-muted px-1.5 text-[11px] text-muted-foreground">proviso</span> : null}
      </div>
      {data.variants.length ? (
        <p className="mt-2 text-[12px] text-warning-foreground dark:text-warning">The dataset holds {data.variants.length === 1 ? "another provision" : `${data.variants.length} other provisions`} numbered {section} in this instrument:{" "}
          {data.variants.map((v, k) => <React.Fragment key={v}>{k ? ", " : ""}<Link className="underline underline-offset-2" href={lawHref(instrument.id, section, v)} scroll={false}>variant {v + 1}</Link></React.Fragment>)}. They are kept separate; check the official text.
        </p>
      ) : null}
      <div className="mt-3 whitespace-pre-wrap break-words text-[13.5px] leading-[1.65] text-foreground">{s.text || <span className="text-muted-foreground">This provision has no text in the dataset.</span>}</div>
      {s.truncated ? <p className="mt-2 text-[12px] text-warning-foreground dark:text-warning">Shown in part: the section has {fmt(s.chars)} characters. Read the rest in the official text.</p> : null}
      {s.defined_terms.length ? <p className="mt-3 text-[12px] text-muted-foreground">Defines: {s.defined_terms.join(", ")}</p> : null}
      {s.acts_referenced.length ? <p className="mt-1 text-[12px] text-muted-foreground">Refers to: {s.acts_referenced.join(", ")}</p> : null}
      <div className="mt-4 flex items-center justify-between gap-2 border-t pt-2">
        {data.prev ? <Button asChild size="xs" variant="ghost"><Link href={lawHref(instrument.id, data.prev.section, data.prev.variant)} scroll={false}><ChevronLeft className="size-3.5" />{data.prev.section === "_" ? "Unnumbered text" : data.prev.section}</Link></Button> : <span />}
        {data.next ? <Button asChild size="xs" variant="ghost"><Link href={lawHref(instrument.id, data.next.section, data.next.variant)} scroll={false}>{data.next.section === "_" ? "Unnumbered text" : data.next.section}<ChevronRight className="size-3.5" /></Link></Button> : <span />}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        Text: {LAW_DATASET.attribution}. Dataset {instrument.dataset_version}. Not the official text; the authoritative version is published by {publisherLabel(instrument)}.
      </p>
    </article>
  );
}
