"use client";
import * as React from "react";
import Link from "next/link";
import { BarChart3, Database, Lock, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { COURTS } from "@/lib/india/courts";
import { ACTS } from "@/lib/india/statutes";
import type { SectionStat, SectionStatsResponse } from "@/modules/india/citator/types";
import { CaseApiError, fetchCaseJson } from "@/modules/caselaw/components/fetch";
import { badYear, citatorNotBuilt, EMPTY_SECTION_FILTERS, linkableSection, sectionStatsQuery, sparkPoints, statuteTitleFor, yearSeries, type SectionStatsFilters } from "../most-cited";
import { lawHref } from "../shared";
import { useExactCentralActs } from "./use-exact-acts";

const fmt = (n: number) => n.toLocaleString("en-IN");
const ALL = "all";
const ACT_OPTIONS = [...ACTS].filter((a) => a.jurisdiction !== "state").sort((a, b) => a.abbr.localeCompare(b.abbr));

/**
 * Statutes landing: the sections most cited by judgments in the case-law collection (GET /api/cases/sections), with
 * Act, court and year filters and a per-year sparkline. Counts cover only the judgments the citator has scanned.
 */
export function MostCitedSections() {
  const [filters, setFilters] = React.useState<SectionStatsFilters>(EMPTY_SECTION_FILTERS);
  const [years, setYears] = React.useState({ from: "", to: "" });
  const [data, setData] = React.useState<SectionStatsResponse | null>(null);
  const [error, setError] = React.useState<CaseApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);

  // Year inputs apply after a pause, and only when they read as whole years.
  React.useEffect(() => {
    if (badYear(years.from) || badYear(years.to)) return;
    const t = setTimeout(() => setFilters((f) => (f.from === years.from && f.to === years.to ? f : { ...f, from: years.from, to: years.to })), 450);
    return () => clearTimeout(t);
  }, [years]);

  const qs = sectionStatsQuery(filters);
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchCaseJson<SectionStatsResponse>(`/api/cases/sections?${qs}`, ac.signal)
      .then(setData)
      .catch((e) => { if ((e as Error).name !== "AbortError") { setData(null); setError(e instanceof CaseApiError ? e : new CaseApiError(String(e), 0, null)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [qs, nonce]);

  const titles = React.useMemo(() => [...new Set((data?.sections ?? []).map((s) => statuteTitleFor(s.actId)).filter((t): t is string => Boolean(t)))], [data]);
  const { acts } = useExactCentralActs(titles);
  const filtered = Boolean(filters.act || filters.court || filters.from || filters.to);
  const max = Math.max(1, ...(data?.sections ?? []).map((s) => s.judgments));

  return (
    <section aria-labelledby="law-most-cited">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id="law-most-cited" className="text-[14px] font-semibold tracking-[-0.01em]">Most-cited sections</h2>
        <span className="min-w-0 text-[12px] text-muted-foreground">Sections cited by judgments in the case-law collection</span>
      </div>
      <div className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-end gap-2 border-b px-3 py-2" role="group" aria-label="Filter most-cited sections">
          <Select value={filters.act || ALL} onValueChange={(v) => setFilters((f) => ({ ...f, act: v === ALL ? "" : v }))}>
            <SelectTrigger size="xs" aria-label="Act" className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-[320px]">
              <SelectItem value={ALL}>All Acts</SelectItem>
              {ACT_OPTIONS.map((a) => <SelectItem key={a.id} value={a.id} textValue={`${a.abbr} ${a.name}`}>{a.abbr === a.name ? a.name : `${a.abbr} · ${a.name}, ${a.year}`}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.court || ALL} onValueChange={(v) => setFilters((f) => ({ ...f, court: v === ALL ? "" : v }))}>
            <SelectTrigger size="xs" aria-label="Court" className="w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-[320px]">
              <SelectItem value={ALL}>All courts</SelectItem>
              {COURTS.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
            <Input size="xs" inputMode="numeric" maxLength={4} placeholder="From" aria-label="From year" aria-invalid={badYear(years.from)} value={years.from} onChange={(e) => setYears((y) => ({ ...y, from: e.target.value }))} className="w-[64px] tabular" />
            <span aria-hidden>–</span>
            <Input size="xs" inputMode="numeric" maxLength={4} placeholder="To" aria-label="To year" aria-invalid={badYear(years.to)} value={years.to} onChange={(e) => setYears((y) => ({ ...y, to: e.target.value }))} className="w-[64px] tabular" />
          </div>
          {filtered ? <Button size="xs" variant="ghost" onClick={() => { setFilters(EMPTY_SECTION_FILTERS); setYears({ from: "", to: "" }); }}>Clear</Button> : null}
          {badYear(years.from) || badYear(years.to) ? <span className="text-[11.5px] text-destructive">Years are whole years, 1860 to 2100.</span> : null}
        </div>

        {loading && !data ? (
          <ul className="divide-y divide-line-quiet" aria-busy>{Array.from({ length: 6 }, (_, k) => <li key={k} className="flex items-center gap-3 px-3 py-2"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-3 flex-1" /><Skeleton className="h-4 w-20" /></li>)}</ul>
        ) : error ? (
          error.notConfigured ? <EmptyState compact icon={Database} title="Case law is not available" description="Citation counts come from the case-law collection, which is not set up for this workspace." />
            : error.forbidden || error.unauthenticated ? <EmptyState compact icon={Lock} title={error.unauthenticated ? "Sign in to see citation counts" : "You do not have access to case law"} />
            : <EmptyState compact icon={TriangleAlert} title={error.status === 400 ? "These filters cannot be used" : "Citation counts could not be loaded"} description={error.message} action={<Button size="xs" variant="outline" onClick={() => setNonce((n) => n + 1)}><RotateCcw className="size-3.5" />Retry</Button>} />
        ) : data && citatorNotBuilt(data) ? (
          <EmptyState compact icon={BarChart3} title="Citator not built yet" description="Counts appear once judgments in the case-law collection have been scanned for statute citations." />
        ) : data && !data.sections.length ? (
          <EmptyState compact icon={BarChart3} title="No cited sections match these filters" description={filtered ? "Try another Act, court or year range." : undefined} />
        ) : data ? (
          <ol className={cn("divide-y divide-line-quiet", loading && "opacity-60")} aria-busy={loading || undefined}>
            {data.sections.map((s, k) => <SectionRow key={`${s.actId}|${s.section}`} rank={k + 1} s={s} max={max} actId={(() => { const t = statuteTitleFor(s.actId); const hit = t ? acts.get(t) : null; return hit ? hit.id : null; })()} />)}
          </ol>
        ) : null}

        {data ? (
          <p className="border-t px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            {data.note} {data.scannedJudgments ? <>Judgments scanned: <span className="tabular">{fmt(data.scannedJudgments)}</span>.</> : null} Citations are found by a parser and can be missed or misread.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function SectionRow({ rank, s, max, actId }: { rank: number; s: SectionStat; max: number; actId: string | null }) {
  const series = yearSeries(s.byYear);
  const first = series[0]?.year;
  const last = series[series.length - 1]?.year;
  const label = <span className="font-medium tabular">{s.label}</span>;
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-[12.5px] sm:grid-cols-[1.75rem_minmax(0,1fr)_120px_4.5rem]">
      <span className="text-right text-[11px] text-muted-foreground tabular">{rank}</span>
      <span className="min-w-0 truncate">
        {actId && linkableSection(s.section) ? <Link href={lawHref(actId, s.section)} className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">{label}</Link> : label}
        {s.act ? <span className="text-muted-foreground"> · {s.act}</span> : null}
      </span>
      <span className="hidden sm:block">
        {series.length ? <Sparkline series={series} label={`${s.label}: judgments citing it per year, ${first}–${last}`} /> : <span className="text-[11px] text-muted-foreground">no dated judgments</span>}
      </span>
      <span className="flex items-center justify-end gap-2">
        <span aria-hidden className="hidden h-1 w-10 overflow-hidden rounded-full bg-muted md:block"><span className="block h-full rounded-full bg-foreground/35" style={{ width: `${Math.max(4, (s.judgments / max) * 100)}%` }} /></span>
        <span className="text-right font-medium tabular" title={`${fmt(s.judgments)} citing judgments`}>{fmt(s.judgments)}</span>
      </span>
    </li>
  );
}

/** One neutral line, baseline-anchored; hover a year for its count. The number beside it carries the total. */
function Sparkline({ series, label }: { series: { year: number; judgments: number }[]; label: string }) {
  const w = 120, h = 22;
  const pts = sparkPoints(series, w, h);
  const lastPt = pts.split(" ").pop()?.split(",").map(Number) ?? [0, 0];
  const slot = w / Math.max(1, series.length);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="block overflow-visible text-foreground/55">
      <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} className="stroke-border" strokeWidth={1} />
      {series.length > 1 ? <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
      <circle cx={lastPt[0]} cy={lastPt[1]} r={2} fill="currentColor" />
      {series.map((p, i) => (
        <rect key={p.year} x={i * slot} y={0} width={slot} height={h} fill="transparent">
          <title>{`${p.year}: ${p.judgments.toLocaleString("en-IN")} judgment${p.judgments === 1 ? "" : "s"}`}</title>
        </rect>
      ))}
    </svg>
  );
}
