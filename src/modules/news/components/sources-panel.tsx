"use client";
import * as React from "react";
import { ArrowUpRight, Newspaper } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NewsSourceView, NewsSourcesResponse } from "../types";
import { TimeAgo } from "./news-ui";

function isFailing(s: NewsSourceView): boolean {
  const st = s.status;
  return Boolean(st?.lastError && (!st.lastSuccessAt || st.lastError.at > st.lastSuccessAt));
}

function SourceRow({ s, now }: { s: NewsSourceView; now: Date | null }) {
  const st = s.status;
  return (
    <li className="flex min-w-0 items-baseline gap-2 px-3 py-2">
      <a href={s.homepage} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-0.5 truncate text-[12.5px] font-medium underline-offset-2 hover:underline">
        <span className="truncate">{s.publisher}</span><ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </a>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
        {st?.lastSuccessAt ? <>updated <TimeAgo iso={st.lastSuccessAt} now={now} /></> : "not yet updated"}
        {isFailing(s) ? <span className="block text-right">temporarily unavailable</span> : null}
      </span>
    </li>
  );
}

/** The publishers the headlines come from, each linked to its site, with when it was last updated. */
export function SourcesPanel({ data, now, className }: { data: NewsSourcesResponse | null; now: Date | null; className?: string }) {
  const sources = data?.sources.filter((s) => s.enabled) ?? [];
  return (
    <section id="sources" aria-labelledby="sources-title" className={cn("flex min-h-0 flex-col", className)}>
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3">
        <Newspaper className="size-3.5 text-muted-foreground" aria-hidden />
        <h2 id="sources-title" className="text-[12.5px] font-semibold">Sources</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {!data ? <p className="px-3 py-4 text-[11.5px] text-muted-foreground">Sources are unavailable right now.</p> : !sources.length ? (
          <p className="px-3 py-4 text-[11.5px] text-muted-foreground">No sources are set up.</p>
        ) : (
          <>
            <ul className="divide-y">{sources.map((s) => <SourceRow key={s.id} s={s} now={now} />)}</ul>
            <p className="border-t px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              Headlines and summaries are the publishers&apos; own. Every headline links to the original article.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
