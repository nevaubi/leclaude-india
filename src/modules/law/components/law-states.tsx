"use client";
import * as React from "react";
import { Database, Info, Lock, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/modules/caselaw/shared";
import { LAW_DATASET, statusLabel, statusTone, type LawFacets } from "../shared";
import type { LawApiError } from "./fetch";

/** Not configured / not loaded / no access: the states where nothing is shown from any other source in its place. */
export function LawUnavailable({ error, className }: { error: LawApiError; className?: string }) {
  if (error.notConfigured) {
    return <EmptyState className={className} icon={Database} title="The statutes corpus is not configured" description="This deployment has no corpus database (DATABASE_URL is not set). Acts and regulations are read from Postgres; nothing is shown from any other source in their place." />;
  }
  if (error.notLoaded) {
    return <EmptyState className={className} icon={Database} title="The statutes corpus has not been loaded yet" description="The database is reachable, but the law tables have not been created by the loader. Once the Open India Law files are loaded, Acts and regulations appear here." />;
  }
  if (error.forbidden || error.unauthenticated) {
    return <EmptyState className={className} icon={Lock} title={error.unauthenticated ? "Sign in to view statutes" : "You do not have access to the statutes corpus"} description={error.unauthenticated ? "Your session has ended." : "Ask an administrator for research access."} />;
  }
  return null;
}

export function isUnavailable(e: LawApiError | null | undefined): boolean {
  return Boolean(e && (e.notConfigured || e.notLoaded || e.forbidden || e.unauthenticated));
}

export function LawErrorState({ title, error, onRetry, className }: { title: string; error: LawApiError; onRetry?: () => void; className?: string }) {
  return <EmptyState className={className} icon={TriangleAlert} title={title} description={error.message} action={onRetry ? <Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3.5" />Retry</Button> : undefined} />;
}

/** In force / Repealed / Status not recorded, with a quiet dot. Never green for anything but in force. */
export function StatusText({ status, className }: { status: string | null | undefined; className?: string }) {
  const tone = statusTone(status);
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", tone === "off" && "text-warning-foreground dark:text-warning", tone === "unknown" && "text-muted-foreground", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone === "ok" ? "bg-success/75" : tone === "off" ? "bg-warning" : "bg-muted-foreground/45")} />
      {statusLabel(status)}
    </span>
  );
}

export function AttributionNote({ version, className }: { version?: string | null; className?: string }) {
  return (
    <span className={cn("text-[11.5px] text-muted-foreground", className)}>
      Source: <a href={LAW_DATASET.licenceUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">{LAW_DATASET.attribution}</a>{version ? ` · dataset ${version}` : ""}
    </span>
  );
}

const fmt = (n: number) => n.toLocaleString("en-IN");

/** One quiet line: what is in the corpus, per jurisdiction, with load progress and the dataset attribution. */
export function LawCoverageStrip({ facets, loading, error, onRetry, onPick, active }: { facets: LawFacets | null; loading: boolean; error: LawApiError | null; onRetry?: () => void; onPick?: (j: "central" | "state" | "regulator") => void; active?: string }) {
  if (loading && !facets) return <div className="flex h-8 items-center gap-3 border-b px-4" aria-busy><Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-32" /><Skeleton className="h-3 w-28" /></div>;
  if (!facets) {
    return error ? (
      <div className="flex h-8 items-center gap-2 border-b px-4 text-[11.5px] text-muted-foreground">
        <span className="truncate">Coverage unavailable: {error.message}</span>
        {onRetry ? <button type="button" className="shrink-0 text-primary hover:underline" onClick={onRetry}>Retry</button> : null}
      </div>
    ) : null;
  }
  const label: Record<string, string> = { central: "Central", state: "State", regulator: "Regulators" };
  const loadingFiles = facets.datasets.filter((d) => d.status !== "done");
  const failed = facets.datasets.filter((d) => d.status === "error");
  const finished = facets.datasets.map((d) => d.finished_at).filter((x): x is string => Boolean(x)).sort().pop() ?? null;
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-1 gap-y-0.5 border-b px-4 py-1 text-[11.5px] text-muted-foreground" aria-label="Corpus coverage">
      <span className="mr-1 font-medium text-foreground">In the corpus</span>
      {facets.jurisdictions.map((j, i) => (
        <React.Fragment key={j.value}>
          {i > 0 && <span aria-hidden className="text-muted-foreground/50">·</span>}
          {onPick && (j.value === "central" || j.value === "state" || j.value === "regulator") ? (
            <button type="button" aria-pressed={active === j.value} onClick={() => onPick(j.value as "central" | "state" | "regulator")} className={cn("rounded px-1 py-0.5 tabular hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", active === j.value && "bg-primary/8 text-primary")}>
              <span className="text-foreground/85">{label[j.value] ?? j.value}</span> {fmt(j.instruments)}
            </button>
          ) : <span className="px-1 tabular">{label[j.value] ?? j.value} {fmt(j.instruments)}</span>}
        </React.Fragment>
      ))}
      <span aria-hidden className="text-muted-foreground/50">·</span>
      <span className="px-1 tabular">{fmt(facets.sections)} sections</span>
      {loadingFiles.length ? (
        <Tip label={loadingFiles.map((d) => `${d.label}: ${d.status}`).join("; ")}>
          <span tabIndex={0} className="px-1 text-warning-foreground dark:text-warning">· loading {facets.datasets.length - loadingFiles.length} of {facets.datasets.length} files{failed.length ? `, ${failed.length} failed` : ""}</span>
        </Tip>
      ) : null}
      <span className="flex-1" />
      <span className="flex items-center gap-1">
        <Tip label={`${LAW_DATASET.attribution}. A section-level parse of India Code (Central, State and Union Territory legislation) and regulator publications. Each instrument links to its publisher's page; rely on the official text.`}>
          <span tabIndex={0} className="inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><Info className="size-3" aria-hidden />{LAW_DATASET.name}{facets.versions.length ? ` ${facets.versions.join(", ")}` : ""}</span>
        </Tip>
        {finished ? <span>· loaded {formatTimestamp(finished)}</span> : null}
        {facets.stale ? <span className="text-warning-foreground dark:text-warning">· counts may be out of date</span> : null}
      </span>
    </div>
  );
}
