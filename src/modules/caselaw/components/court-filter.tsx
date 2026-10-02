"use client";
import * as React from "react";
import { ChevronDown, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { courtOptions, courtShortName, filterLabel, OTHER_COURTS_LABEL, yearSpan, type CourtFacet, type CourtOption } from "../shared";

export { courtShortName };

/**
 * Court filter grouped as Supreme Court / High Courts / other courts, with the record count and the years
 * covered for each. Only courts that have records in the index are offered; the coverage strip says what is not in.
 */
export function CourtFilter({ courts, value, onChange, loading }: { courts: CourtFacet[] | null; value: string[]; onChange: (v: string[]) => void; loading?: boolean }) {
  const selected = new Set(value);
  const options = courtOptions(courts);
  const groups: { label: string | null; items: CourtOption[] }[] = [
    { label: "Supreme Court", items: options.filter((c) => c.level === "supreme") },
    { label: "High Courts", items: options.filter((c) => c.level === "high") },
    // The merged "Other courts" option is its own heading; no group label above it.
    { label: null, items: options.filter((c) => c.level === "unmapped") },
  ].filter((g) => g.items.length);
  const label = filterLabel(options, value);
  const state = (o: CourtOption): boolean | "indeterminate" => {
    const n = o.keys.filter((k) => selected.has(k)).length;
    return n === 0 ? false : n === o.keys.length ? true : "indeterminate";
  };
  const toggle = (o: CourtOption) => onChange(state(o) === true ? value.filter((v) => !o.keys.includes(v)) : [...value, ...o.keys.filter((k) => !selected.has(k))]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" className={cn("max-w-[220px] justify-between gap-1.5 font-normal", value.length && "border-primary/40 text-foreground")} aria-label={`Court filter: ${label}`}>
          <Landmark className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-0">
        <div className="max-h-[360px] overflow-auto py-1 scrollbar-thin">
          {loading && !courts ? <div className="px-3 py-3 text-[12px] text-muted-foreground">Loading courts…</div> : null}
          {!loading && !groups.length ? <div className="px-3 py-3 text-[12px] text-muted-foreground">Court coverage is unavailable.</div> : null}
          {groups.map((g, gi) => (
            <div key={g.label ?? "other"} className={cn("py-1", !g.label && gi > 0 && "border-t")}>
              {g.label ? <div className="px-3 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground">{g.label}</div> : null}
              {g.items.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-start gap-2 px-3 py-1 hover:bg-accent">
                  <Checkbox size="sm" className="mt-0.5" checked={state(c)} onCheckedChange={() => toggle(c)} aria-label={courtDisplayName(c)} />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[12.5px]" title={courtDisplayName(c)}>{courtDisplayName(c)}</span>
                    <span className="block text-[11px] text-muted-foreground tabular">
                      {yearSpan(c.minYear, c.maxYear) ?? "no dated decisions"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular">{c.records.toLocaleString("en-IN")}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">Counts are decisions</span>
          <Button variant="ghost" size="xs" disabled={!value.length} onClick={() => onChange([])}>Clear</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** User-facing court name; courts the source does not identify are shown as "Other courts", never by internal code. */
export function courtDisplayName(c: CourtFacet): string {
  return c.level === "unmapped" ? OTHER_COURTS_LABEL : c.name;
}
