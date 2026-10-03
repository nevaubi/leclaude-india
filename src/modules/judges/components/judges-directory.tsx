"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Database, ExternalLink, LayoutGrid, List, Lock, RotateCcw, Search, SearchX, TriangleAlert, UserRound, X } from "lucide-react";
import { LawHubMeta } from "@/components/corpus/law-hub";
import { PhotoBackdrop } from "@/components/corpus/visual-image";
import { courtVisual, useVisuals } from "@/modules/media/use-visuals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { COURTS, courtById } from "@/lib/india/courts";
import { formatCaseDate, formatTimestamp } from "@/modules/caselaw/shared";
import { CaseApiError, fetchCaseJson } from "@/modules/caselaw/components/fetch";
import { displayJudgeName } from "../names";
import { judgeHref, STATUS_LABEL, type JudgeSummary, type JudgesListResponse, type RosterSourceInfo } from "../shared";
import { JudgeAvatar } from "./judge-avatar";

const ALL = "__all";
type View = "grid" | "list";

function readView(): View {
  try { return window.localStorage.getItem("judges.view") === "list" ? "list" : "grid"; } catch { return "grid"; }
}

/** /judges?court=&q=&status= — judges from official court rosters (filters live in the URL). */
export function JudgesDirectory() {
  const pathname = usePathname();
  const sp = useSearchParams();
  const court = sp.get("court") ?? "";
  const q = sp.get("q") ?? "";
  const status = sp.get("status") ?? "sitting";
  const [qDraft, setQDraft] = React.useState(q);
  React.useEffect(() => setQDraft(q), [q]);
  const [view, setView] = React.useState<View>("grid");
  React.useEffect(() => setView(readView()), []);
  const chooseView = (v: View) => { setView(v); try { window.localStorage.setItem("judges.view", v); } catch { /* per-viewer convenience only */ } };

  const setParam = React.useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    if (next.get("status") === "sitting") next.delete("status");
    const qs = next.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  }, [pathname, sp]);

  // Debounced search.
  React.useEffect(() => {
    if (qDraft.trim() === q) return;
    const t = setTimeout(() => setParam({ q: qDraft.trim() }), 250);
    return () => clearTimeout(t);
  }, [qDraft, q, setParam]);

  const [data, setData] = React.useState<JudgesListResponse | null>(null);
  const [error, setError] = React.useState<CaseApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
  const apiQuery = new URLSearchParams({ ...(court ? { court } : {}), ...(q ? { q } : {}), ...(status !== "all" ? { status } : {}) }).toString();
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchCaseJson<JudgesListResponse>(`/api/judges${apiQuery ? `?${apiQuery}` : ""}`, ac.signal)
      .then(setData)
      .catch((e) => { if ((e as Error).name !== "AbortError") { setData(null); setError(e instanceof CaseApiError ? e : new CaseApiError(String(e), 0, null)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [apiQuery, nonce]);

  const totalLoaded = data?.courts.reduce((n, c) => n + c.total, 0) ?? 0;
  const filtered = Boolean(court || q || status !== "sitting");
  const groups = React.useMemo(() => {
    const m = new Map<string, JudgeSummary[]>();
    for (const j of data?.judges ?? []) m.set(j.courtId, [...(m.get(j.courtId) ?? []), j]);
    const order = COURTS.map((c) => c.id);
    return [...m.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [data]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LawHubMeta>
        {data ? <span className="tabular"><span className="font-medium text-foreground/85">{totalLoaded.toLocaleString("en-IN")}</span> judges</span> : <span>Supreme Court and High Court judges</span>}
        <span aria-hidden className="text-muted-foreground/50">·</span>
        <span>From official court rosters</span>
        {data?.lastRun ? <><span aria-hidden className="text-muted-foreground/50">·</span><span>updated {formatTimestamp(data.lastRun.at) ?? data.lastRun.at}</span></> : null}
      </LawHubMeta>
      <form className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2 sm:px-6" role="search" onSubmit={(e) => { e.preventDefault(); setParam({ q: qDraft.trim() }); }}>
        <div className="relative w-full min-w-[200px] sm:w-[280px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input size="xs" value={qDraft} onChange={(e) => setQDraft(e.target.value)} placeholder="Judge's name" aria-label="Search judges" className="pl-7 pr-7" maxLength={80}
            onKeyDown={(e) => { if (e.key === "Escape" && qDraft) { e.preventDefault(); setQDraft(""); setParam({ q: "" }); } }} />
          {qDraft ? (
            <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear search" onClick={() => { setQDraft(""); setParam({ q: "" }); }}>
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <Select value={court || ALL} onValueChange={(v) => setParam({ court: v === ALL ? "" : v })}>
          <SelectTrigger size="xs" className="w-[230px]" aria-label="Court"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All courts</SelectItem>
            {COURTS.map((c) => {
              const n = data?.courts.find((x) => x.courtId === c.id)?.total;
              return <SelectItem key={c.id} value={c.id}>{c.name}{n ? <span className="ml-1 text-muted-foreground tabular">({n})</span> : null}</SelectItem>;
            })}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setParam({ status: v })}>
          <SelectTrigger size="xs" className="w-[180px]" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="sitting">{STATUS_LABEL.sitting}</SelectItem>
            <SelectItem value="off_roster">{STATUS_LABEL.off_roster}</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>
        <span className="flex-1" />
        <div className="flex items-center rounded-md border p-0.5" role="group" aria-label="Layout">
          <button type="button" aria-pressed={view === "grid"} aria-label="Photo grid" className={cn("rounded p-1 text-muted-foreground hover:text-foreground", view === "grid" && "bg-accent text-foreground")} onClick={() => chooseView("grid")}><LayoutGrid className="size-3.5" /></button>
          <button type="button" aria-pressed={view === "list"} aria-label="List" className={cn("rounded p-1 text-muted-foreground hover:text-foreground", view === "list" && "bg-accent text-foreground")} onClick={() => chooseView("list")}><List className="size-3.5" /></button>
        </div>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-12 pt-5 sm:px-6">
          {loading && !data ? <DirectorySkeleton /> : error ? <DirectoryError error={error} onRetry={() => setNonce((n) => n + 1)} /> : !data ? null
            : totalLoaded === 0 ? <NotLoaded sources={data.sources} />
            : !data.judges.length ? (
              <EmptyState icon={SearchX} title="No judges match these filters" description={filtered ? "Only judges listed on an official court roster are shown." : undefined}
                action={filtered ? <Button size="xs" variant="outline" onClick={() => { setQDraft(""); window.history.replaceState(null, "", pathname); }}>Clear filters</Button> : null} />
            ) : (
              <div className={cn("space-y-8", loading && "opacity-60 transition-opacity")} aria-busy={loading || undefined}>
                {groups.map(([courtId, judges]) => <CourtGroup key={courtId} courtId={courtId} judges={judges} view={view} source={data.sources.find((s) => s.courtId === courtId) ?? null} />)}
                <p className="text-[10.5px] text-muted-foreground">Names, designations, dates and photographs are as published on each court&apos;s official roster page when it was last read; photographs are reproduced with attribution and shown only after an automated check that the image is a single-person portrait. Confirm on the official page before relying on a date.</p>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

function CourtGroup({ courtId, judges, view, source }: { courtId: string; judges: JudgeSummary[]; view: View; source: RosterSourceInfo | null }) {
  const court = courtById(courtId);
  const visuals = useVisuals();
  const photo = courtVisual(visuals, courtId);
  return (
    <section aria-labelledby={`court-${courtId}`}>
      <header className={cn("relative isolate mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 overflow-hidden rounded-lg border px-4", photo ? "min-h-[76px] py-3 pb-5" : "py-2.5")}>
        <PhotoBackdrop visual={photo} />
        <h2 id={`court-${courtId}`} className="font-serif text-[18px] leading-tight tracking-[-0.005em]">{court?.name ?? "Other court"}</h2>
        <span className="text-[12px] text-muted-foreground tabular">{judges.length} judge{judges.length === 1 ? "" : "s"}</span>
        <span className="flex-1" />
        {source ? (
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded bg-background/70 px-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline" title={source.title}>
            Official roster · {hostOf(source.url)}<ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
      </header>
      {view === "grid" ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {judges.map((j) => (
            <li key={j.id}>
              <Link href={judgeHref(j.id)} className="group flex h-full flex-col gap-2 rounded-lg border bg-card p-1.5 pb-2 transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                <JudgeAvatar name={j.name} photo={j.photo} fill rounded="md" className="aspect-[4/5] w-full text-[22px]" />
                <div className="min-w-0 px-1">
                  <div className="line-clamp-2 text-[12.5px] font-medium leading-snug group-hover:underline">{displayJudgeName(j.name)}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{[j.designation, j.status !== "sitting" ? STATUS_LABEL[j.status] : null].filter(Boolean).join(" · ") || " "}</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y rounded-md border">
          {judges.map((j) => (
            <li key={j.id}>
              <Link href={judgeHref(j.id)} className="flex items-center gap-3 px-3 py-2 hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none">
                <JudgeAvatar name={j.name} photo={j.photo} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{displayJudgeName(j.name)}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{[j.designation, j.status !== "sitting" ? STATUS_LABEL[j.status] : null].filter(Boolean).join(" · ") || "Designation not printed on the roster"}</span>
                </span>
                <span className="hidden w-[150px] shrink-0 text-[11.5px] text-muted-foreground tabular sm:block">{j.dateOfAppointment ? `Appointed ${formatCaseDate(j.dateOfAppointment)}` : ""}</span>
                <span className="hidden w-[150px] shrink-0 text-[11.5px] text-muted-foreground tabular md:block">{j.retirementDate ? `Retires ${formatCaseDate(j.retirementDate)}` : j.termExpires ? `Term to ${formatCaseDate(j.termExpires)}` : ""}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NotLoaded({ sources }: { sources: RosterSourceInfo[] }) {
  return (
    <div className="mx-auto max-w-xl">
      <EmptyState icon={UserRound} title="Judges are not available yet"
        description="Judge profiles appear here once the official court rosters have been read. The rosters are linked below." />
      {sources.length ? (
        <div className="rounded-md border">
          <div className="border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Official roster pages</div>
          <ul className="divide-y">
            {sources.map((s) => (
              <li key={s.courtId} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate">{courtById(s.courtId)?.name ?? hostOf(s.url)}</span>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[11px] text-primary hover:underline">{hostOf(s.url)}<ExternalLink className="size-3" aria-hidden /></a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DirectoryError({ error, onRetry }: { error: CaseApiError; onRetry: () => void }) {
  if (error.status === 503 && error.code === "judges_not_configured") {
    return <EmptyState className="mt-6" icon={Database} title="The judges directory is not available" description="It has not been set up for this workspace yet." />;
  }
  if (error.forbidden || error.unauthenticated) {
    return <EmptyState className="mt-6" icon={Lock} title={error.unauthenticated ? "Sign in to view judges" : "You do not have access to the judges directory"} />;
  }
  return <EmptyState className="mt-6" icon={TriangleAlert} title="The judges directory could not be loaded" description={error.message} action={<Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3.5" />Retry</Button>} />;
}

function DirectorySkeleton() {
  return (
    <div className="space-y-3" aria-busy>
      <Skeleton className="h-5 w-56" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="aspect-[4/5] w-full" />)}
      </div>
    </div>
  );
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
