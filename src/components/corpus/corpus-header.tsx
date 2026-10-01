import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * One header for the research corpora (Statutes, Case law): title, a one-line description, a quiet coverage line and
 * right-aligned actions. Server- and client-safe (no hooks).
 */
export function CorpusHeader({ icon: Icon, title, description, coverage, actions, className, children }: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** One quiet line of what is in the corpus (counts, dataset, freshness). */
  coverage?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className={cn("shrink-0 px-4 pb-3 pt-4 sm:px-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden /> : null}
            <h1 className="text-[18px] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
          </div>
          {description ? <p className="mt-1 max-w-[760px] text-[12.5px] leading-snug text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      {coverage ? <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-muted-foreground">{coverage}</div> : null}
      {children}
    </header>
  );
}

/** The header's shape while its data loads (same height, no layout shift). */
export function CorpusHeaderSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("shrink-0 px-4 pb-3 pt-4 sm:px-6", className)} aria-busy>
      <Skeleton className="h-[22px] w-36" />
      <Skeleton className="mt-1.5 h-3.5 w-[min(520px,80%)]" />
      <Skeleton className="mt-2.5 h-3 w-[min(380px,60%)]" />
    </div>
  );
}

/** A quiet "·" separator for coverage lines. */
export function CoverageSep() {
  return <span aria-hidden className="text-muted-foreground/50">·</span>;
}
