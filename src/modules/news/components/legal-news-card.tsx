"use client";
import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Lock, Newspaper, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { EmptyRow, Section } from "@/modules/home/components/shared";
import type { NewsListResponse } from "../types";
import { HeadlineRow, NewsApiError, TimeAgo, newsApi, newsQueryString, requestRefresh, useNow } from "./news-ui";

const AUTO_REFRESH_AFTER_MS = 15 * 60_000;

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string; denied: boolean }
  | { kind: "ready"; data: NewsListResponse };

/**
 * Home card: latest Indian legal headlines from the registered feeds (see /news for sources). Loads on mount and,
 * when the last check is older than 15 minutes, asks the server to refresh (the server throttles independently).
 */
export function LegalNewsCard({ expanded, onExpand }: { expanded?: boolean; onExpand?: () => void }) {
  const limit = expanded ? 60 : 8;
  const [state, setState] = React.useState<State>({ kind: "loading" });
  const [refreshing, setRefreshing] = React.useState(false);
  const now = useNow();
  const autoTried = React.useRef(false);

  const load = React.useCallback(async () => {
    try {
      const data = await newsApi<NewsListResponse>(`/api/news${newsQueryString({ limit })}`);
      setState({ kind: "ready", data });
      return data;
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "Could not load headlines", denied: e instanceof NewsApiError && e.status === 403 });
      return null;
    }
  }, [limit]);

  const refresh = React.useCallback(async (notify: boolean) => {
    setRefreshing(true);
    try {
      const r = await requestRefresh({ notify });
      if (r?.status === "ran" || notify) await load();
    } finally { setRefreshing(false); }
  }, [load]);

  React.useEffect(() => {
    void (async () => {
      const data = await load();
      if (!data || autoTried.current) return;
      autoTried.current = true;
      const last = data.lastRun ? Date.parse(data.lastRun.startedAt) : NaN;
      if (!Number.isFinite(last) || Date.now() - last > AUTO_REFRESH_AFTER_MS) void refresh(false);
    })();
  }, [load, refresh]);

  const data = state.kind === "ready" ? state.data : null;
  const items = data?.items ?? [];
  const allFailed = !!data?.lastRun && data.lastRun.feeds.length > 0 && data.lastRun.feeds.every((f) => !f.ok);

  const actions = (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {data && (data.lastSuccessAt
        ? <span className="hidden @md:inline">Updated <TimeAgo iso={data.lastSuccessAt} now={now} /></span>
        : <span className="hidden @md:inline">Not updated yet</span>)}
      <Tip label="Check the publishers' feeds now (at most once every 15 minutes)">
        <Button variant="ghost" size="xs" className="h-6 px-1.5 text-[11px] text-muted-foreground" onClick={() => void refresh(true)} disabled={refreshing} aria-label="Refresh legal news">
          <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />Refresh
        </Button>
      </Tip>
      {!expanded && <Link href="/news" className="hidden items-center gap-0.5 rounded-sm px-1 hover:text-foreground @sm:inline-flex">All news<ArrowUpRight className="size-3" /></Link>}
    </div>
  );

  return (
    <Section
      id="news"
      title="Legal news"
      icon={expanded ? Newspaper : undefined}
      count={data ? data.total : undefined}
      description="LiveLaw, Bar & Bench, Verdictum and others"
      actions={actions}
      expanded={expanded}
      onExpand={onExpand}
      bodyClassName={expanded ? "overflow-auto scrollbar-thin" : undefined}
    >
      {state.kind === "loading" && (
        <ul className="divide-y border-t" aria-busy="true" aria-label="Loading headlines">
          {Array.from({ length: expanded ? 8 : 5 }, (_, i) => (
            <li key={i} className="space-y-1.5 px-3 py-2.5"><Skeleton className="h-3 w-40" /><Skeleton className="h-3.5 w-[85%]" /></li>
          ))}
        </ul>
      )}
      {state.kind === "error" && (
        state.denied
          ? <EmptyRow icon={Lock} title="No access to news" hint="Your role does not include the news feed. Ask an administrator if you need it." />
          : <EmptyRow icon={AlertTriangle} title="Headlines could not be loaded" hint={state.message} action={<Button size="xs" variant="outline" onClick={() => { setState({ kind: "loading" }); void load(); }}>Try again</Button>} />
      )}
      {data && items.length === 0 && (
        refreshing
          ? <EmptyRow icon={RefreshCw} title="Checking the feeds…" hint="Fetching the latest headlines from the publishers." />
          : allFailed
            ? <EmptyRow icon={AlertTriangle} title="The news feeds could not be reached" hint={`${data.lastRun!.feeds[0]?.error ?? "Every feed failed."} Headlines appear here after the next successful check.`} action={<Link href="/news#sources" className="text-[11.5px] text-primary hover:underline">See source status</Link>} />
            : <EmptyRow icon={Newspaper} title="No headlines yet" hint="Headlines from Indian legal publishers appear here after the first check." action={<Button size="xs" variant="outline" onClick={() => void refresh(true)}>Check now</Button>} />
      )}
      {data && items.length > 0 && (
        <>
          {(data.stale || allFailed) && (
            <div className="flex items-center gap-1.5 border-t bg-warning/10 px-3 py-1.5 text-[11px] text-foreground/80" role="status">
              <AlertTriangle className="size-3 shrink-0 text-warning" />
              <span className="min-w-0 truncate">{data.lastSuccessAt ? <>Feeds last reached <TimeAgo iso={data.lastSuccessAt} now={now} />; showing stored headlines.</> : "Feeds have not been reached; showing stored headlines."}</span>
              <Link href="/news#sources" className="ml-auto shrink-0 text-primary hover:underline">Status</Link>
            </div>
          )}
          <ul className={cn("divide-y border-t", expanded && "mx-auto w-full max-w-4xl")}>
            {items.map((n) => <HeadlineRow key={n.id} item={n} now={now} compact={!expanded} summary={expanded} />)}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate">Headlines link to the publisher; summaries are the publisher&apos;s own.</span>
            <Link href="/news" className="inline-flex shrink-0 items-center gap-0.5 hover:text-foreground">{data.total > items.length ? `All ${data.total} headlines` : "News & sources"}<ArrowUpRight className="size-3" /></Link>
          </div>
        </>
      )}
    </Section>
  );
}
