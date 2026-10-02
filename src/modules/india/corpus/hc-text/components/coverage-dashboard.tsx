"use client";
import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Database, Lock, RotateCcw, Scale, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState } from "@/components/ui/misc";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { coverageRows, formatFetchedAt, lastRunOf, storageLine } from "@/modules/official-ui/shared";
import { isOfficialUnavailable, OfficialErrorState, OfficialUnavailable, useOfficialStatus } from "@/modules/official-ui/components/states";
import { sumYears, textShare, yearsInRange, type HcCoverage, type HcCoverageCourt, type HcCoverageTotals, type HcCoverageYear } from "../shared";

const fmt = (n: number) => n.toLocaleString("en-IN");
const RECENT_FROM = 2016;
type Range = "recent" | "older" | "all";
const RANGE_LABEL: Record<Range, string> = { recent: `${RECENT_FROM}–present`, older: `Before ${RECENT_FROM}`, all: "All years" };
const rangeBounds = (r: Range): [number | null, number | null] => (r === "recent" ? [RECENT_FROM, null] : r === "older" ? [null, RECENT_FROM - 1] : [null, null]);

class CoverageError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function useHcCoverage(): { data: HcCoverage | null; error: CoverageError | null; loading: boolean; retry: () => void } {
  const [data, setData] = React.useState<HcCoverage | null>(null);
  const [error, setError] = React.useState<CoverageError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetch("/api/india/hc-text/coverage", { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as (HcCoverage & { error?: string }) | null;
        if (!r.ok || !body) throw new CoverageError(body?.error ?? `Coverage could not be loaded (${r.status})`, r.status);
        setData(body);
      })
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(e instanceof CoverageError ? e : new CoverageError((e as Error).message, 0)); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [nonce]);
  return { data, error, loading, retry: () => setNonce((n) => n + 1) };
}

/**
 * /sources/coverage — private coverage dashboard: High Court judgments per court × year (records, text from Open India
 * Law or the court's PDF, OCR, partial, failed, metadata only, last update) and the official sources' counts.
 */
export function CoverageDashboard() {
  const { data, error, loading, retry } = useHcCoverage();
  const [range, setRange] = React.useState<Range>("recent");
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  let judgments: React.ReactNode;
  if (loading && !data) judgments = <TableSkeleton />;
  else if (error) judgments = <CoverageErrorState error={error} onRetry={retry} />;
  else if (data && !data.configured) judgments = <EmptyState icon={Database} title="Judgment coverage is not set up" description="This workspace has no Postgres database for the judgment corpus." />;
  else if (data && !data.courts.length) judgments = <EmptyState icon={Scale} title="No High Court records yet" description="Records appear once the judgment metadata backfill has loaded High Court archives." />;
  else if (data) {
    const [from, to] = rangeBounds(range);
    const needle = q.trim().toLowerCase();
    const courts = data.courts
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.shortName.toLowerCase().includes(needle))
      .map((c) => ({ court: c, years: yearsInRange(c.years, from, to) }))
      .map((x) => ({ ...x, totals: sumYears(x.years) }));
    const all = sumYears(courts.flatMap((c) => c.years));
    judgments = (
      <>
        <SummaryLine totals={all} data={data} range={range} />
        <div className="mt-3 overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[980px] border-collapse text-[12.5px]">
            <thead className="sticky top-0 bg-[var(--surface-quiet)] text-left text-[11px] text-muted-foreground">
              <tr className="[&>th]:whitespace-nowrap [&>th]:px-3 [&>th]:py-2 [&>th]:font-medium">
                <th scope="col">Court / year</th>
                <th scope="col" className="text-right">Judgments</th>
                <th scope="col" className="text-right" title="Records with text of any origin">With text</th>
                <th scope="col" className="w-[120px]">Share</th>
                <th scope="col" className="text-right" title="Open India Law text (CC BY 4.0)">Open India Law</th>
                <th scope="col" className="text-right" title="Text layer of the court's PDF">PDF text</th>
                <th scope="col" className="text-right" title="Some or all pages transcribed by OCR">OCR</th>
                <th scope="col" className="text-right" title="Some pages could not be read">Partial</th>
                <th scope="col" className="text-right">Failed</th>
                <th scope="col" className="text-right">Metadata only</th>
                <th scope="col">Last update</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {courts.map(({ court, years, totals }) => (
                <React.Fragment key={court.courtId}>
                  <CourtRow court={court} totals={totals} expanded={open.has(court.courtId)} onToggle={() => toggle(court.courtId)} hasYears={years.length > 0} />
                  {open.has(court.courtId) ? years.map((y) => <YearRow key={`${court.courtId}:${y.year ?? "none"}`} y={y} />) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!courts.length ? <EmptyState compact className="mt-3" icon={Scale} title="No court matches the filter" action={<Button size="xs" variant="outline" onClick={() => setQ("")}>Clear filter</Button>} /> : null}
        {data.stale ? <p className="mt-2 text-[11.5px] text-warning-foreground dark:text-warning">The latest refresh failed; these figures are from an earlier check.</p> : null}
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 pb-2 pt-3 sm:px-6">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em]">Coverage</h1>
          <span className="min-w-0 text-[12px] text-muted-foreground">What the corpus holds: High Court judgment text by court and year, and official sources</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
            <TabsList className="h-7">
              {(Object.keys(RANGE_LABEL) as Range[]).map((r) => <TabsTrigger key={r} value={r} className="h-6 px-2 text-[11.5px]">{RANGE_LABEL[r]}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter courts" aria-label="Filter courts" className="h-7 w-[200px] text-[12px]" />
          <Button size="xs" variant="ghost" onClick={retry} disabled={loading} aria-label="Refresh coverage"><RotateCcw className={cn("size-3.5", loading && "animate-spin")} />Refresh</Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-[1240px] px-4 pb-10 pt-4 sm:px-6">
          <section aria-labelledby="hc-cov">
            <h2 id="hc-cov" className="text-[13px] font-semibold">High Court judgments</h2>
            <p className="mt-0.5 max-w-[110ch] text-[11.5px] leading-snug text-muted-foreground">
              Text is linked to a record only by its CNR and decision date. Open India Law text is kept wherever it exists; PDF text comes from the court&apos;s own PDF in the AWS open dataset, and OCR pages are model transcriptions. The PDF is always the text of record.
            </p>
            <div className="mt-2">{judgments}</div>
          </section>
          <OfficialSection />
        </div>
      </main>
    </div>
  );
}

function SummaryLine({ totals, data, range }: { totals: HcCoverageTotals; data: HcCoverage; range: Range }) {
  const share = textShare(totals);
  const storage = storageLine({ dbBytes: data.dbBytes, limitBytes: data.limitBytes });
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
      <span className="tabular"><span className="font-medium text-foreground/85">{fmt(totals.judgments)}</span> judgments ({RANGE_LABEL[range]})</span>
      <span aria-hidden>·</span>
      <span className="tabular"><span className="font-medium text-foreground/85">{fmt(totals.withText)}</span> with text{share != null ? ` (${share}%)` : ""}</span>
      <span aria-hidden>·</span>
      <span className="tabular">{fmt(totals.ocr)} OCR · {fmt(totals.partial)} partial · {fmt(totals.failed)} failed</span>
      {data.queue ? <><span aria-hidden>·</span><span className="tabular">Queue: {fmt(data.queue.pending)} waiting, {fmt(data.queue.running)} running</span></> : null}
      {storage ? <><span aria-hidden>·</span><span className="tabular">{storage}</span></> : null}
      <span aria-hidden>·</span>
      {data.ingestEnabled ? <Chip tone="success">PDF text worker on</Chip> : <Chip tone="muted" title="Set HC_TEXT_INGEST=1 on the deployment to run the worker">PDF text worker off</Chip>}
      {data.checkedAt ? <span className="text-[11.5px]">Checked {formatFetchedAt(data.checkedAt)}</span> : null}
    </div>
  );
}

function ShareBar({ t }: { t: HcCoverageTotals }) {
  const share = textShare(t);
  if (share == null) return <span className="text-muted-foreground">—</span>;
  const part = (n: number) => `${t.judgments ? (n / t.judgments) * 100 : 0}%`;
  return (
    <div className="flex items-center gap-2" title={`${share}% with text`}>
      <div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className="h-full bg-foreground/55" style={{ width: part(t.openIndiaLaw + t.pdfText) }} />
        <span className="h-full bg-warning/70" style={{ width: part(t.ocr + t.partial) }} />
      </div>
      <span className="tabular text-[11.5px] text-muted-foreground">{share}%</span>
    </div>
  );
}

function Num({ n, tone }: { n: number; tone?: "warn" | "bad" }) {
  return <td className={cn("text-right tabular", !n ? "text-muted-foreground" : tone === "bad" ? "text-destructive" : tone === "warn" ? "text-warning-foreground dark:text-warning" : "")}>{fmt(n)}</td>;
}

function CourtRow({ court, totals, expanded, onToggle, hasYears }: { court: HcCoverageCourt; totals: HcCoverageTotals; expanded: boolean; onToggle: () => void; hasYears: boolean }) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <tr className="align-middle [&>td]:px-3 [&>td]:py-1.5">
      <td className="min-w-[260px] whitespace-nowrap">
        <button type="button" onClick={onToggle} disabled={!hasYears} aria-expanded={expanded} className="inline-flex items-center gap-1 rounded text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:no-underline disabled:opacity-60">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {court.name}
        </button>
        {court.priority < 9 ? <span className="ml-1.5 text-[10.5px] text-muted-foreground">priority {court.priority + 1}</span> : null}
      </td>
      <td className="text-right font-medium tabular">{fmt(totals.judgments)}</td>
      <td className="text-right tabular">{fmt(totals.withText)}</td>
      <td><ShareBar t={totals} /></td>
      <Num n={totals.openIndiaLaw} />
      <Num n={totals.pdfText} />
      <Num n={totals.ocr} tone="warn" />
      <Num n={totals.partial} tone="warn" />
      <Num n={totals.failed} tone="bad" />
      <td className="text-right tabular text-muted-foreground">{fmt(totals.metadataOnly)}</td>
      <td className="whitespace-nowrap text-[11.5px] text-muted-foreground" title={court.countedAt ? `Counts as of ${formatFetchedAt(court.countedAt)}` : undefined}>{totals.lastUpdate ? formatFetchedAt(totals.lastUpdate) : "—"}</td>
    </tr>
  );
}

function YearRow({ y }: { y: HcCoverageYear }) {
  return (
    <tr className="bg-[var(--surface-quiet)]/40 align-middle text-[12px] [&>td]:px-3 [&>td]:py-1">
      <td className="pl-9 tabular text-muted-foreground">{y.year ?? "Year unknown"}</td>
      <td className="text-right tabular">{fmt(y.judgments)}</td>
      <td className="text-right tabular">{fmt(y.withText)}</td>
      <td><ShareBar t={y} /></td>
      <Num n={y.openIndiaLaw} />
      <Num n={y.pdfText} />
      <Num n={y.ocr} tone="warn" />
      <Num n={y.partial} tone="warn" />
      <Num n={y.failed} tone="bad" />
      <td className="text-right tabular text-muted-foreground">{fmt(y.metadataOnly)}</td>
      <td className="whitespace-nowrap text-[11px] text-muted-foreground">{y.lastUpdate ? formatFetchedAt(y.lastUpdate) : "—"}</td>
    </tr>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2" aria-busy aria-label="Loading coverage">
      <Skeleton className="h-3.5 w-[420px] max-w-full" />
      <div className="space-y-1.5 rounded-lg border p-3">{Array.from({ length: 9 }, (_, k) => <Skeleton key={k} className="h-4" style={{ width: `${70 + ((k * 7) % 30)}%` }} />)}</div>
    </div>
  );
}

function CoverageErrorState({ error, onRetry }: { error: CoverageError; onRetry: () => void }) {
  if (error.status === 401) return <EmptyState icon={Lock} title="Sign in to view coverage" description="Your session has ended." action={<Button asChild size="xs" variant="outline"><Link href="/login?next=/sources/coverage">Sign in</Link></Button>} />;
  if (error.status === 403) return <EmptyState icon={Lock} title="You do not have access to coverage" description="Ask an administrator for research access." />;
  if (error.status === 503) return <EmptyState icon={Database} title="Judgment coverage is not set up" description={error.message} />;
  return <EmptyState icon={TriangleAlert} title="Coverage could not be loaded" description={error.message} action={<Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3.5" />Retry</Button>} />;
}

function OfficialSection() {
  const { status, error, loading, retry } = useOfficialStatus();
  let body: React.ReactNode;
  if (loading && !status) body = <TableSkeleton />;
  else if (error) body = isOfficialUnavailable(error) ? <OfficialUnavailable compact error={error} /> : <OfficialErrorState compact title="Official sources could not be loaded" error={error} onRetry={retry} />;
  else if (status && !status.configured) body = <EmptyState compact icon={Database} title="Official sources are not set up" />;
  else if (status) {
    const rows = coverageRows(status).filter((r) => r.enabled || r.documents);
    const storage = storageLine(status);
    body = (
      <>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
          <span className="tabular"><span className="font-medium text-foreground/85">{fmt(rows.reduce((n, r) => n + r.documents, 0))}</span> documents</span>
          <span aria-hidden>·</span><span className="tabular">Queue: {fmt(status.queue.pending)} pending, {fmt(status.queue.failed)} failed</span>
          {storage ? <><span aria-hidden>·</span><span className="tabular">{storage}</span></> : null}
          <span aria-hidden>·</span><Link href="/sources?tab=coverage" className="text-primary hover:underline">Per-source detail</Link>
        </div>
        <div className="mt-2 overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
            <thead className="bg-[var(--surface-quiet)] text-left text-[11px] text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:font-medium">
                <th scope="col">Source</th><th scope="col" className="text-right">Documents</th><th scope="col" className="text-right">Indexed</th>
                <th scope="col" className="text-right">OCR needed</th><th scope="col" className="text-right">Failed</th><th scope="col">Last run</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => {
                const last = lastRunOf(r);
                return (
                  <tr key={r.id} className="[&>td]:px-3 [&>td]:py-1.5">
                    <td className="font-medium">{r.name}{!r.enabled ? <Chip tone="muted" className="ml-1.5">Disabled</Chip> : null}</td>
                    <td className="text-right tabular">{fmt(r.documents)}</td>
                    <td className="text-right tabular">{fmt(r.indexed)}</td>
                    <Num n={r.ocrNeeded} tone="warn" />
                    <Num n={r.failed} tone="bad" />
                    <td className="whitespace-nowrap text-[11.5px] text-muted-foreground">{last ? formatFetchedAt(last) : "Not run yet"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!rows.length ? <EmptyState compact className="mt-2" icon={Database} title="No official documents collected yet" /> : null}
      </>
    );
  }
  return (
    <section aria-labelledby="off-cov" className="mt-8">
      <h2 id="off-cov" className="text-[13px] font-semibold">Official sources</h2>
      <p className="mt-0.5 text-[11.5px] text-muted-foreground">Court, tribunal, regulator, Gazette and Parliament documents as published.</p>
      <div className="mt-2">{body}</div>
    </section>
  );
}
