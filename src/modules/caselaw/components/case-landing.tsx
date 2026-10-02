"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, FileText, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CoramAvatars } from "@/modules/judges/components/coram-avatars";
import { caseHref, courtOptions, formatCaseDate, yearSpan, type CaseFacets, type CaseHit, type CourtOption } from "../shared";
import { benchLabel, courtLabel } from "./case-labels";
import { CourtPhoto, CourtThumb, courtPlace, YearSparkline } from "./court-visuals";

const fmt = (n: number) => n.toLocaleString("en-IN");

function SectionTitle({ id, title, note, action }: { id: string; title: string; note?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 id={id} className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h2>
      {note ? <span className="min-w-0 truncate text-[12px] text-muted-foreground">{note}</span> : null}
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  );
}

/** /cases start page: the courts as a gallery (Supreme Court featured) and the latest decisions. */
export function CaseLanding({ facets, facetsLoading, facetsError, onRetryFacets, onPickCourt, hits, loading, error, onRetry, onBrowseAll }: {
  facets: CaseFacets | null;
  facetsLoading: boolean;
  facetsError: string | null;
  onRetryFacets: () => void;
  onPickCourt: (keys: string[]) => void;
  hits: CaseHit[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onBrowseAll: () => void;
}) {
  const options = courtOptions(facets?.courts);
  const supreme = options.find((c) => c.level === "supreme") ?? null;
  const high = options.filter((c) => c.level === "high");
  const other = options.find((c) => c.level === "unmapped") ?? null;
  return (
    <div className="h-full overflow-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1180px] space-y-9 px-4 pb-12 pt-5 sm:px-6">
        <section aria-labelledby="cases-courts">
          <SectionTitle id="cases-courts" title="Courts" note="Choose a court to browse its decisions" />
          {facetsLoading && !facets ? <GallerySkeleton /> : !facets ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">
              Courts could not be loaded{facetsError ? `: ${facetsError}` : "."}
              <Button size="xs" variant="outline" onClick={onRetryFacets}><RotateCcw className="size-3.5" />Retry</Button>
            </div>
          ) : !options.length ? (
            <p className="rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">No decisions are available yet.</p>
          ) : (
            <div className="space-y-3">
              {supreme ? <SupremeCard c={supreme} onPick={onPickCourt} /> : null}
              {high.length || other ? (
                <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                  {high.map((c) => <li key={c.key}><HighCourtCard c={c} onPick={onPickCourt} /></li>)}
                  {other ? <li><OtherCourtsCard c={other} onPick={onPickCourt} /></li> : null}
                </ul>
              ) : null}
            </div>
          )}
        </section>

        <section aria-labelledby="cases-latest">
          <SectionTitle id="cases-latest" title="Latest decisions" note="Most recent first" action={<Button size="xs" variant="ghost" onClick={onBrowseAll}>Browse all records<ArrowRight className="size-3.5" /></Button>} />
          {error && !hits.length ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">Records could not be loaded: {error}<Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3.5" />Retry</Button></div>
          ) : loading && !hits.length ? <LatestSkeleton /> : hits.length ? (
            <ol className="divide-y divide-line-quiet overflow-hidden rounded-lg border bg-card">{hits.slice(0, 8).map((h) => <LatestRow key={h.id} h={h} />)}</ol>
          ) : <p className="rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">No decisions are available yet.</p>}
        </section>
      </div>
    </div>
  );
}

function Partial({ c }: { c: CourtOption }) {
  return c.archives && c.archives.done < c.archives.total ? <span className="text-[11px] text-muted-foreground">Loading more</span> : null;
}

function SupremeCard({ c, onPick }: { c: CourtOption; onPick: (keys: string[]) => void }) {
  const span = yearSpan(c.minYear, c.maxYear);
  return (
    <button type="button" onClick={() => onPick(c.keys)} className="group grid w-full overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <CourtPhoto courtId="sci" name={c.name} className="aspect-[16/9] md:aspect-auto md:min-h-[236px]" size="lg" credit="corner" eager />
      <span className="flex min-w-0 flex-col justify-between gap-4 p-5">
        <span>
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Apex court</span>
          <span className="mt-1 flex items-center gap-1.5 font-serif text-[22px] leading-tight tracking-[-0.01em] text-foreground">{c.name}<ArrowUpRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden /></span>
          <span className="mt-3 flex items-baseline gap-2">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em] tabular">{fmt(c.records)}</span>
            <span className="text-[12px] text-muted-foreground">decisions{span ? ` · ${span}` : ""}</span>
          </span>
        </span>
        <span className="block">
          <YearSparkline years={c.years} height={44} />
          <span className="mt-2 flex items-center gap-2 text-[11.5px] text-muted-foreground tabular">
            {c.maxDate ? <span>Latest {formatCaseDate(c.maxDate)}</span> : <span>No dated decisions</span>}
            <span className="ml-auto"><Partial c={c} /></span>
          </span>
        </span>
      </span>
    </button>
  );
}

function HighCourtCard({ c, onPick }: { c: CourtOption; onPick: (keys: string[]) => void }) {
  const span = yearSpan(c.minYear, c.maxYear);
  return (
    <button type="button" onClick={() => onPick(c.keys)} title={c.name} className="group flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      <CourtPhoto courtId={c.courtId} name={c.name} className="aspect-[3/2] w-full" />
      <span className="flex flex-1 flex-col px-3 pb-3 pt-2.5">
        <span className="truncate text-[13px] font-medium text-foreground">{courtPlace(c.courtId, c.name)} High Court</span>
        <span className="mt-1.5 flex items-end gap-3">
          <span className="min-w-0">
            <span className="block text-[17px] font-semibold leading-none tracking-[-0.015em] tabular">{fmt(c.records)}</span>
            <span className="mt-1 block truncate text-[11px] text-muted-foreground tabular">decisions{span ? ` · ${span}` : ""}</span>
          </span>
          <YearSparkline years={c.years} height={22} className="ml-auto w-[42%] justify-end" />
        </span>
        <Partial c={c} />
      </span>
    </button>
  );
}

function OtherCourtsCard({ c, onPick }: { c: CourtOption; onPick: (keys: string[]) => void }) {
  const span = yearSpan(c.minYear, c.maxYear);
  return (
    <button type="button" onClick={() => onPick(c.keys)} className="group flex h-full w-full flex-col justify-end rounded-lg border border-dashed bg-card px-3 pb-3 pt-6 text-left transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      <span className="text-[13px] font-medium">Other courts</span>
      <span className="mt-0.5 text-[11.5px] text-muted-foreground">Courts the source does not identify</span>
      <span className="mt-2 text-[17px] font-semibold leading-none tabular">{fmt(c.records)}</span>
      <span className="mt-1 text-[11px] text-muted-foreground tabular">decisions{span ? ` · ${span}` : ""}</span>
    </button>
  );
}

function LatestRow({ h }: { h: CaseHit }) {
  const bench = benchLabel(h);
  const date = formatCaseDate(h.decision_date);
  return (
    <li>
      <Link href={caseHref(h.id)} className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50">
        <CourtThumb courtId={h.court_id} name={h.court} size={38} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground group-hover:underline" title={h.title}>{h.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-x-1.5 text-[11.5px] text-muted-foreground">
            <span className={cn("shrink-0", h.court && "text-foreground/75")}>{courtLabel(h)}</span>
            {bench ? <><span aria-hidden>·</span><span className="truncate">{bench}</span></> : null}
            {date ? <><span aria-hidden>·</span><span className="shrink-0 tabular">{date}</span></> : null}
            {h.text_status === "full" ? <><span aria-hidden>·</span><span className="inline-flex shrink-0 items-center gap-1"><FileText className="size-3" aria-hidden />Full text</span></> : null}
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-3 sm:flex">
          {h.judges.length ? <CoramAvatars courtId={h.court_id} judges={h.judges} size={22} max={3} /> : null}
          <span className="flex w-[150px] justify-end">{h.neutral_citation ? <span className="max-w-full truncate rounded-[var(--radius-chip)] border bg-background px-1.5 py-0.5 text-[11.5px] text-foreground/80 tabular" title="Neutral citation">{h.neutral_citation}</span> : null}</span>
        </span>
      </Link>
    </li>
  );
}

function GallerySkeleton() {
  return (
    <div className="space-y-3" aria-busy>
      <div className="grid overflow-hidden rounded-xl border md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"><Skeleton className="aspect-[16/9] rounded-none md:aspect-auto md:min-h-[236px]" /><div className="space-y-3 p-5"><Skeleton className="h-3 w-20" /><Skeleton className="h-6 w-2/3" /><Skeleton className="h-7 w-32" /><Skeleton className="mt-8 h-11 w-full" /></div></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="overflow-hidden rounded-lg border"><Skeleton className="aspect-[3/2] rounded-none" /><div className="space-y-2 p-3"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-5 w-1/3" /></div></div>)}</div>
    </div>
  );
}

function LatestSkeleton() {
  return (
    <div className="divide-y divide-line-quiet rounded-lg border" aria-busy>
      {Array.from({ length: 6 }, (_, k) => (
        <div key={k} className="flex items-center gap-3 px-3.5 py-2.5"><Skeleton className="size-[38px] rounded-md" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5" style={{ width: `${45 + ((k * 13) % 35)}%` }} /><Skeleton className="h-3 w-[min(320px,50%)]" /></div></div>
      ))}
    </div>
  );
}
