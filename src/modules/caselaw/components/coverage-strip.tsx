"use client";
import * as React from "react";
import { Info } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { formatTimestamp, type CaseFacets } from "../shared";

const fmt = (n: number) => n.toLocaleString("en-IN");
const Sep = () => <span aria-hidden className="text-muted-foreground/50">·</span>;

const INDEX_NOTE = "Each decision links to the official PDF published by the court. Search covers titles, parties, citations and coram; decisions marked Full text can also be read here.";

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
      <span className="tabular"><span className="font-medium text-foreground/85">{fmt(facets.total)}</span> decisions</span>
      <Sep />
      <span className="tabular">{mapped.length} court{mapped.length === 1 ? "" : "s"}</span>
      <Sep />
      <Tip label={INDEX_NOTE}>
        <span tabIndex={0} className="inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><Info className="size-3" aria-hidden />Official court publications</span>
      </Tip>
      {facets.lastIngestedAt ? <><Sep /><span>updated {formatTimestamp(facets.lastIngestedAt)}</span></> : null}
      {partial ? <><Sep /><span>loading more decisions</span></> : null}
      {facets.stale ? <><Sep /><span>counts may be out of date</span></> : null}
    </>
  );
}
