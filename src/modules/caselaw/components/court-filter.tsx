"use client";
import * as React from "react";
import { ChevronDown, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { yearSpan, type CourtFacet } from "../shared";

/**
 * Court filter grouped as Supreme Court / High Courts / unmapped court codes, with the record count and the years
 * covered for each. Only courts that have records in the index are offered; the coverage strip says what is not in.
 */
export function CourtFilter({ courts, value, onChange, loading }: { courts: CourtFacet[] | null; value: string[]; onChange: (v: string[]) => void; loading?: boolean }) {
  const selected = new Set(value);
  const groups: { label: string; items: CourtFacet[] }[] = [
    { label: "Supreme Court", items: (courts ?? []).filter((c) => c.level === "supreme") },
    { label: "High Courts", items: (courts ?? []).filter((c) => c.level === "high") },
    { label: "Unmapped court codes", items: (courts ?? []).filter((c) => c.level === "unmapped") },
  ].filter((g) => g.items.length);
  const byKey = new Map((courts ?? []).map((c) => [c.key, c]));
  const label = value.length === 0 ? "All courts" : value.length === 1 ? shortName(byKey.get(value[0])) ?? value[0] : `${value.length} courts`;
  const toggle = (key: string) => onChange(selected.has(key) ? value.filter((v) => v !== key) : [...value, key]);

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
          {groups.map((g) => (
            <div key={g.label} className="py-1">
              <div className="px-3 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground">{g.label}</div>
              {g.items.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-start gap-2 px-3 py-1 hover:bg-accent">
                  <Checkbox size="sm" className="mt-0.5" checked={selected.has(c.key)} onCheckedChange={() => toggle(c.key)} aria-label={c.name} />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[12.5px]">{c.name}</span>
                    <span className="block text-[11px] text-muted-foreground tabular">
                      {yearSpan(c.minYear, c.maxYear) ?? "no dated records"}
                      {c.level === "unmapped" ? " · code not in the court registry" : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular">{c.records.toLocaleString("en-IN")}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">Counts are index records</span>
          <Button variant="ghost" size="xs" disabled={!value.length} onClick={() => onChange([])}>Clear</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function shortName(c: CourtFacet | undefined): string | null {
  if (!c) return null;
  if (c.level === "supreme") return "Supreme Court";
  if (c.level === "unmapped") return `Court code ${c.courtCode ?? "?"}`;
  return courtShortName(c.name);
}

/** "High Court of Karnataka" → "Karnataka HC"; names in another form ("Gauhati High Court") are kept. */
export function courtShortName(name: string): string {
  const m = /^High Court (?:of Judicature at|for the State of|of|at) (.+)$/.exec(name);
  return m ? `${m[1]} HC` : name;
}
