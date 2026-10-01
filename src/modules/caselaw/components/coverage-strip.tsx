"use client";
import * as React from "react";
import { Info } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatTimestamp, yearSpan, type CaseFacets } from "../shared";
import { shortName } from "./court-filter";

/**
 * What is in the index and what is not: one quiet line of courts with the years covered and the record count. A court
 * whose source archives are not all stored is marked "in progress". Clicking a court filters to it.
 */
export function CoverageStrip({ facets, loading, error, selected, onToggle, onRetry }: { facets: CaseFacets | null; loading: boolean; error: string | null; selected: string[]; onToggle: (key: string) => void; onRetry?: () => void }) {
  if (loading && !facets) {
    return <div className="flex h-8 items-center gap-3 border-b px-4" aria-busy><Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-32" /><Skeleton className="h-3 w-28" /></div>;
  }
  if (!facets) {
    return error ? (
      <div className="flex h-8 items-center gap-2 border-b px-4 text-[11.5px] text-muted-foreground">
        <span className="truncate">Coverage unavailable: {error}</span>
        {onRetry ? <button type="button" className="shrink-0 text-primary hover:underline" onClick={onRetry}>Retry</button> : null}
      </div>
    ) : null;
  }
  const sel = new Set(selected);
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-1 gap-y-0.5 border-b px-4 py-1 text-[11.5px] text-muted-foreground" aria-label="Index coverage">
      <span className="mr-1 font-medium text-foreground">In the index</span>
      {facets.courts.map((c, i) => {
        const partial = c.archives && c.archives.done < c.archives.total;
        const span = yearSpan(c.minYear, c.maxYear);
        return (
          <React.Fragment key={c.key}>
            {i > 0 && <span aria-hidden className="text-muted-foreground/50">·</span>}
            <Tip label={`${c.name}: ${c.records.toLocaleString("en-IN")} records${c.minDate && c.maxDate ? `, decided ${c.minDate} to ${c.maxDate}` : ""}${c.archives ? `; ${c.archives.done} of ${c.archives.total} source archives stored` : ""}${c.level === "unmapped" ? "; court code not in the registry" : ""}`}>
              <button
                type="button"
                onClick={() => onToggle(c.key)}
                aria-pressed={sel.has(c.key)}
                className={cn("rounded px-1 py-0.5 tabular hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", sel.has(c.key) && "bg-primary/8 text-primary")}
              >
                <span className={cn(c.level !== "unmapped" && "text-foreground/85")}>{shortName(c)}</span>
                {span ? ` ${span}` : ""}
                <span className="text-muted-foreground/80"> ({c.records.toLocaleString("en-IN")})</span>
                {partial ? <span className="text-warning-foreground dark:text-warning"> in progress</span> : null}
              </button>
            </Tip>
          </React.Fragment>
        );
      })}
      <span className="flex-1" />
      <span className="flex items-center gap-1">
        <Tip label="The index holds the court-published metadata (title, parties, citations, coram, dates, disposal, source snippet) and a link to the official PDF. Judgment text is not indexed, so a search does not look inside the judgment.">
          <span tabIndex={0} className="inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><Info className="size-3" aria-hidden />Metadata only</span>
        </Tip>
        {facets.lastIngestedAt ? <span>· updated {formatTimestamp(facets.lastIngestedAt)}</span> : null}
        {facets.stale ? <span className="text-warning-foreground dark:text-warning">· counts may be out of date</span> : null}
      </span>
    </div>
  );
}
