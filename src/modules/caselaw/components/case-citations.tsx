"use client";
import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { isNegativeSignal, SIGNAL_LABEL } from "@/modules/india/citator/signals";
import type { CitatorResponse, CitedByEntry, CiteEntry } from "@/modules/india/citator/types";
import { caseHref, formatCaseDate } from "../shared";
import { CaseApiError, fetchCaseJson } from "./fetch";

export type CitatorState = { loading: boolean; data: CitatorResponse | null; error: CaseApiError | null; retry: () => void };

/** Citator data for one record (/api/cases/citator), shared by the top notice and the Citations section. */
export function useCitator(id: string): CitatorState {
  const [data, setData] = React.useState<CitatorResponse | null>(null);
  const [error, setError] = React.useState<CaseApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchCaseJson<CitatorResponse>(`/api/cases/citator?id=${encodeURIComponent(id)}`, ac.signal)
      .then((d) => setData(d))
      .catch((e) => { if ((e as Error).name !== "AbortError") { setData(null); setError(e instanceof CaseApiError ? e : new CaseApiError(String(e), 0, null)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [id, nonce]);
  return { loading, data, error, retry: () => setNonce((n) => n + 1) };
}

/** Top-of-record notice when a later judgment's text uses negative language about this one. */
export function NegativeSignalNotice({ state }: { state: CitatorState }) {
  const d = state.data;
  if (!d || d.status !== "built" || !d.negative.length) return null;
  const first = d.negative[0];
  const word = first.cue ?? (first.signal ? SIGNAL_LABEL[first.signal] : "");
  const strong = d.goodLaw.status === "negative_signal";
  return (
    <div role="note" className={cn("mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-snug", strong ? "border-warning/60 bg-warning/10" : "bg-[var(--surface-quiet)]")}>
      <TriangleAlert className={cn("mt-0.5 size-3.5 shrink-0", strong ? "text-warning-foreground dark:text-warning" : "text-muted-foreground")} aria-hidden />
      <p className="min-w-0">
        A later judgment&apos;s text uses &lsquo;{word}&rsquo; about this judgment{d.negative.length > 1 ? ` (${d.negative.length} citing judgments use negative language)` : ""} — verify by reading the passage.
        {!strong ? <span className="text-muted-foreground"> It is not from the Supreme Court or a bench of equal or greater strength.</span> : null}{" "}
        <a href="#citations" className="text-primary hover:underline">Review citations</a>
      </p>
    </div>
  );
}

/** Highlight the cue inside the context (case-insensitive, first occurrence). */
function Sentence({ context, cue }: { context: string; cue: string | null }) {
  const at = cue ? context.toLowerCase().indexOf(cue.toLowerCase()) : -1;
  if (!cue || at < 0) return <>{context}</>;
  return <>{context.slice(0, at)}<mark className="rounded-sm bg-warning/25 px-0.5 text-foreground">{context.slice(at, at + cue.length)}</mark>{context.slice(at + cue.length)}</>;
}

function SignalChip({ e }: { e: Pick<CitedByEntry, "signal" | "kind"> }) {
  if (e.kind === "mention") return <Chip tone="muted" title="The citation appears in this judgment's text. No treatment was assessed.">mention (text match)</Chip>;
  if (!e.signal) return null;
  return <Chip tone={isNegativeSignal(e.signal) ? "warning" : "outline"} title="Words found in the citing sentence by fixed rules; not a verified treatment.">Text says: {SIGNAL_LABEL[e.signal]}</Chip>;
}

function CitedByRow({ e }: { e: CitedByEntry }) {
  const [open, setOpen] = React.useState(false);
  const date = formatCaseDate(e.decisionDate);
  const title = e.title ?? e.citation ?? "Untitled judgment";
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        {e.citingId ? <Link href={caseHref(e.citingId)} className="min-w-0 flex-1 text-[12.5px] font-medium hover:underline">{title}</Link> : <span className="min-w-0 flex-1 text-[12.5px] font-medium">{title}</span>}
        <SignalChip e={e} />
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
        {e.court ? <span>{e.court}</span> : null}
        {e.benchStrength ? <span className="tabular">{e.benchStrength}-judge bench</span> : null}
        {date ? <span className="tabular">{date}</span> : null}
        {e.citation ? <span className="tabular">{e.citation}</span> : null}
        {e.page != null ? <span className="tabular">p. {e.page}</span> : null}
        {e.context ? (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-0.5 rounded text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}{e.kind === "mention" ? "Passage" : "Sentence"}
          </button>
        ) : null}
      </div>
      {open && e.context ? <p className="mt-1.5 max-w-[72ch] border-l-2 pl-2 font-serif text-[13.5px] leading-relaxed text-foreground/90"><Sentence context={e.context} cue={e.cue} /></p> : null}
    </li>
  );
}

function CiteRow({ c }: { c: CiteEntry }) {
  const [open, setOpen] = React.useState(false);
  const date = formatCaseDate(c.decisionDate);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        {c.resolution === "resolved" && c.citedId ? (
          <Link href={caseHref(c.citedId)} className="min-w-0 flex-1 text-[12.5px] font-medium hover:underline">{c.title ?? c.raw}</Link>
        ) : (
          <span className="min-w-0 flex-1 text-[12.5px] tabular">{c.raw}</span>
        )}
        {c.resolution === "unresolved" ? <Chip tone="muted" title="No judgment in this corpus carries this citation. It was not matched to any other judgment.">not in corpus</Chip> : null}
        {c.resolution === "ambiguous" ? <Chip tone="muted" title="Several judgments in the corpus carry this citation; none was chosen.">{c.candidates} matches · not linked</Chip> : null}
        {c.signal ? <SignalChip e={{ signal: c.signal, kind: "citation" }} /> : null}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
        {c.resolution === "resolved" ? <span className="tabular">{c.raw}</span> : null}
        {c.court ? <span>{c.court}</span> : null}
        {date ? <span className="tabular">{date}</span> : null}
        {c.page != null ? <span className="tabular">cited at p. {c.page}</span> : null}
        {c.occurrences > 1 ? <span className="tabular">{c.occurrences}×</span> : null}
        {c.context ? (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-0.5 rounded text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}Sentence
          </button>
        ) : null}
      </div>
      {open && c.context ? <p className="mt-1.5 max-w-[72ch] border-l-2 pl-2 font-serif text-[13.5px] leading-relaxed text-foreground/90"><Sentence context={c.context} cue={c.cue} /></p> : null}
    </li>
  );
}

const PAGE = 15;

function List<T>({ items, render, empty }: { items: T[]; render: (x: T, i: number) => React.ReactNode; empty: React.ReactNode }) {
  const [all, setAll] = React.useState(false);
  if (!items.length) return <p className="py-2 text-[12px] text-muted-foreground">{empty}</p>;
  const shown = all ? items : items.slice(0, PAGE);
  return (
    <>
      <ul className="divide-y">{shown.map(render)}</ul>
      {items.length > PAGE ? <Button size="xs" variant="ghost" className="mt-1" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${items.length}`}</Button> : null}
    </>
  );
}

/** "Citations" section: cited by (with text cues) and cites (exact-match resolution). */
export function CitationsSection({ state, initialTab = "citedBy" }: { state: CitatorState; initialTab?: "citedBy" | "cites" }) {
  const { data, error, loading } = state;
  const [tab, setTab] = React.useState<"citedBy" | "cites">(initialTab);
  const tabs = data ? ([["citedBy", "Cited by", data.counts.citedBy], ...(data.status === "built" ? [["cites", "Cites", data.counts.cites] as const] : [])] as const) : [];
  return (
    <section id="citations" aria-label="Citations" className="scroll-mt-4 rounded-lg border">
      <header className="flex h-8 items-center gap-1 border-b px-3">
        <h2 className="mr-2 text-[12.5px] font-medium">Citations</h2>
        {tabs.map(([k, label, n]) => (
          <button key={k} type="button" onClick={() => setTab(k)} aria-pressed={tab === k}
            className={cn("inline-flex h-6 items-center gap-1 rounded px-1.5 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", tab === k ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {label}<span className="tabular text-[11px] text-muted-foreground">{n}</span>
          </button>
        ))}
      </header>
      <div className="px-3 py-1.5">
        {loading && !data ? (
          <div className="space-y-2 py-1.5" aria-busy><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>
        ) : error ? (
          error.notConfigured ? <p className="py-2 text-[12px] text-muted-foreground">Citations are not available on this workspace.</p>
            : error.forbidden || error.unauthenticated ? <p className="py-2 text-[12px] text-muted-foreground">You do not have access to citations.</p>
              : <div className="flex flex-wrap items-center gap-2 py-2 text-[12px] text-muted-foreground">Citations could not be loaded. {error.message}<Button size="xs" variant="outline" onClick={state.retry}><RotateCcw className="size-3.5" />Retry</Button></div>
        ) : data ? (
          <>
            {data.status === "not_built" ? (
              <p className="py-1.5 text-[11.5px] text-muted-foreground">Citations have not been indexed for this judgment yet. Below are later judgments whose text mentions its citation (text match); no treatment was assessed.</p>
            ) : null}
            {tab === "citedBy" || data.status !== "built" ? (
              <List items={data.citedBy} render={(e) => <CitedByRow key={`${e.citingId ?? e.citation}-${e.page ?? ""}`} e={e} />}
                empty={data.status === "built" ? "No judgment in this corpus cites this judgment by its neutral or reporter citation." : "No later judgment in the full-text corpus mentions this judgment's citation."} />
            ) : (
              <List items={data.cites} render={(c) => <CiteRow key={c.seq} c={c} />} empty="No case citation was found in this judgment's text." />
            )}
            <footer className="mt-1.5 space-y-1 border-t pt-2 text-[11px] leading-snug text-muted-foreground">
              {data.status === "built" ? <p className="text-foreground/80">{data.goodLaw.summary}</p> : null}
              <p>{data.goodLaw.coverage.note}</p>
              {data.status === "built" ? <p>{data.signalNote}</p> : null}
            </footer>
          </>
        ) : null}
      </div>
    </section>
  );
}
