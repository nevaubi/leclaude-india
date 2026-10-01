"use client";
import * as React from "react";
import { ArrowUpRight, Info, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatCaseDate, formatTimestamp, yearSpan, type CaseFacets, type CourtFacet } from "../shared";

const fmt = (n: number) => n.toLocaleString("en-IN");
const Sep = () => <span aria-hidden className="text-muted-foreground/50">·</span>;

const INDEX_NOTE = "The index holds the court-published metadata (title, parties, citations, coram, dates, disposal, source snippet) and a link to the official PDF. Directory search looks at that metadata; records marked Full text also have the judgment text stored.";

/** The header's coverage line: totals, courts and freshness. */
export function CaseCoverageLine({ facets, loading, error, onRetry }: { facets: CaseFacets | null; loading: boolean; error: string | null; onRetry?: () => void }) {
  if (loading && !facets) return <><Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-24" /></>;
  if (!facets) {
    return error ? (
      <>
        <span title={error}>Coverage unavailable</span>
        {onRetry ? <button type="button" className="rounded text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={onRetry}>Retry</button> : null}
      </>
    ) : null;
  }
  const mapped = facets.courts.filter((c) => c.level !== "unmapped");
  const partial = facets.courts.filter((c) => c.archives && c.archives.done < c.archives.total).length;
  return (
    <>
      <span className="tabular"><span className="font-medium text-foreground/85">{fmt(facets.total)}</span> records</span>
      <Sep />
      <span className="tabular">{mapped.length} court{mapped.length === 1 ? "" : "s"}</span>
      <Sep />
      <Tip label={INDEX_NOTE}>
        <span tabIndex={0} className="inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><Info className="size-3" aria-hidden />Court-published open datasets</span>
      </Tip>
      {facets.lastIngestedAt ? <><Sep /><span>updated {formatTimestamp(facets.lastIngestedAt)}</span></> : null}
      {partial ? <><Sep /><span className="text-warning-foreground dark:text-warning">{partial} court{partial === 1 ? "" : "s"} still loading</span></> : null}
      {facets.stale ? <><Sep /><span className="text-warning-foreground dark:text-warning">counts may be out of date</span></> : null}
    </>
  );
}

/** Records per year, oldest to newest, as quiet bars. Pure presentation of the facet counts. */
function YearBars({ years }: { years: CourtFacet["years"] }) {
  const ys = years.filter((y): y is { year: number; records: number } => y.year != null).sort((a, b) => a.year - b.year);
  if (ys.length < 2) return null;
  const max = Math.max(...ys.map((y) => y.records), 1);
  return (
    <div className="mt-3 flex h-7 items-end gap-px" aria-hidden>
      {ys.map((y) => <span key={y.year} className="min-w-px max-w-3 flex-1 rounded-[1px] bg-foreground/15 group-hover:bg-primary/35" style={{ height: `${Math.max(6, (y.records / max) * 100)}%` }} title={`${y.year}: ${fmt(y.records)}`} />)}
    </div>
  );
}

/** Landing: one card per court in the index with its records, years and load progress. Clicking filters to it. */
export function CourtCoverageCards({ facets, loading, error, onRetry, onPick }: { facets: CaseFacets | null; loading: boolean; error: string | null; onRetry: () => void; onPick: (key: string) => void }) {
  if (loading && !facets) return <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((k) => <Skeleton key={k} className="h-[132px] rounded-lg" />)}</div>;
  if (!facets) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">
        Court coverage could not be loaded{error ? `: ${error}` : "."}
        <Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3.5" />Retry</Button>
      </div>
    );
  }
  if (!facets.courts.length) return <p className="rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">No court has records in the index yet.</p>;
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
      {facets.courts.map((c) => {
        const partial = c.archives && c.archives.done < c.archives.total;
        const span = yearSpan(c.minYear, c.maxYear);
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onPick(c.key)}
            className="group flex min-w-0 flex-col rounded-lg border bg-card px-3.5 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="flex w-full items-start gap-1.5">
              <span className={cn("min-w-0 flex-1 text-[12.5px] font-medium leading-snug", c.level === "unmapped" ? "text-warning-foreground dark:text-warning" : "text-foreground/90")}>{c.name}</span>
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            </span>
            <span className="mt-1.5 text-[20px] font-semibold leading-none tracking-[-0.02em] tabular">{fmt(c.records)}</span>
            <span className="mt-1 text-[11.5px] text-muted-foreground tabular">
              records{span ? ` · ${span}` : ""}{c.level === "supreme" ? " · Supreme Court" : c.level === "high" ? " · High Court" : " · code not in the registry"}
            </span>
            <YearBars years={c.years} />
            <span className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground tabular">
              {c.maxDate ? <span className="truncate">Latest {formatCaseDate(c.maxDate)}</span> : <span>No dated records</span>}
              {c.archives ? <span className={cn("ml-auto shrink-0", partial && "text-warning-foreground dark:text-warning")}>{partial ? `${c.archives.done}/${c.archives.total} archives` : "archives complete"}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
