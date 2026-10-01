"use client";
import * as React from "react";
import { ArrowUpRight, Rss } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/ui/misc";
import { Tip } from "@/components/ui/tooltip";
import type { NewsSourceView, NewsSourcesResponse } from "../types";
import { TimeAgo, fmtIST } from "./news-ui";

function sourceState(s: NewsSourceView): { tone: "success" | "warning" | "destructive" | "muted"; label: string } {
  const st = s.status;
  if (!s.enabled) return { tone: "muted", label: "Disabled" };
  if (!st || !st.lastAttemptAt) return { tone: "muted", label: "Not checked yet" };
  const failingNow = st.lastError && (!st.lastSuccessAt || st.lastError.at > st.lastSuccessAt);
  if (failingNow && !st.lastSuccessAt) return { tone: "destructive", label: "Never reached" };
  if (failingNow) return { tone: "warning", label: `Last check failed${st.consecutiveFailures > 1 ? ` (${st.consecutiveFailures}×)` : ""}` };
  return { tone: "success", label: st.notModified ? "Up to date (not modified)" : "OK" };
}

function SourceRow({ s, now }: { s: NewsSourceView; now: Date | null }) {
  const state = sourceState(s);
  const st = s.status;
  const failingNow = st?.lastError && (!st.lastSuccessAt || st.lastError.at > st.lastSuccessAt);
  return (
    <li className="space-y-1 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={state.tone} label={state.label} />
        <a href={s.homepage} target="_blank" rel="noopener noreferrer" className="truncate text-[12.5px] font-medium hover:underline underline-offset-2">{s.publisher}</a>
        <span className="shrink-0 text-[10.5px] text-muted-foreground">{s.type}</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">{state.label}</span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted-foreground">Last updated</dt>
        <dd className="min-w-0 truncate">{st?.lastSuccessAt ? <TimeAgo iso={st.lastSuccessAt} now={now} /> : "—"}</dd>
        <dt className="text-muted-foreground">Items</dt>
        <dd className="tabular">{st?.lastSuccessAt ? `${st.itemCount} in feed` : "—"} · {s.stored} stored</dd>
        {failingNow && st?.lastError && (
          <>
            <dt className="text-muted-foreground">Error</dt>
            <dd className="min-w-0 break-words text-destructive" title={`${st.lastError.code} · ${fmtIST(st.lastError.at)}`}>{st.lastError.message}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Feed</dt>
        <dd className="min-w-0 truncate font-mono text-[10.5px]"><a href={s.feedUrl} target="_blank" rel="noopener noreferrer" className="hover:underline" title={s.feedUrl}>{s.feedUrl.replace(/^https?:\/\//, "")}</a></dd>
      </dl>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{s.carries}</p>
    </li>
  );
}

/** The feed registry with live status: exactly where the headlines come from. */
export function SourcesPanel({ data, now, className }: { data: NewsSourcesResponse | null; now: Date | null; className?: string }) {
  return (
    <section id="sources" aria-labelledby="sources-title" className={cn("flex min-h-0 flex-col", className)}>
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3">
        <Rss className="size-3.5 text-muted-foreground" aria-hidden />
        <h2 id="sources-title" className="text-[12.5px] font-semibold">Sources</h2>
        {data && <span className="text-[11px] text-muted-foreground">{data.sources.filter((s) => s.enabled).length} feeds · checked every {data.refreshIntervalMinutes} min</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {!data ? <p className="px-3 py-4 text-[11.5px] text-muted-foreground">Source status is unavailable.</p> : (
          <>
            <ul className="divide-y">{data.sources.map((s) => <SourceRow key={s.id} s={s} now={now} />)}</ul>
            <div className="space-y-2 border-t px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <p>Headlines and summaries are the publishers&apos; own, taken from their public RSS feeds. Every headline links to the original article; LeClaude does not copy article text.</p>
              <p>Court labels come only from a publisher&apos;s own category or tag naming the court exactly, or a headline that says &quot;Supreme Court&quot;. Hover a label to see where it came from.</p>
              {data.excluded.length > 0 && (
                <details>
                  <summary className="cursor-pointer select-none text-foreground/80">Feeds checked and not included ({data.excluded.length})</summary>
                  <ul className="mt-1 space-y-0.5">
                    {data.excluded.map((x) => (
                      <li key={x.url} className="flex min-w-0 items-center gap-1">
                        <span className="truncate">{x.publisher}</span>
                        <span className="shrink-0">· {x.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {data.lastRun && (
                <p>
                  Last check <Tip label={fmtIST(data.lastRun.startedAt)}><span><TimeAgo iso={data.lastRun.startedAt} now={now} /></span></Tip>: {data.lastRun.feeds.filter((f) => f.ok).length} of {data.lastRun.feeds.length} feeds reached, {data.lastRun.added} new.
                  <a href="/api/news/sources" target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 hover:text-foreground">JSON<ArrowUpRight className="size-3" /></a>
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
