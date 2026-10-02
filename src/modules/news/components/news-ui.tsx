"use client";
import * as React from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { courtById } from "@/lib/india/courts";
import type { NewsArticle, NewsLabel, NewsListResponse, RefreshResult } from "../types";
import { newsSourceById } from "../sources";
import { exactCourtNames } from "../labels";
import { BRAND } from "@/lib/brand";

// ---------------------------------------------------------------------------
// Time (IST)
// ---------------------------------------------------------------------------

export const IST = "Asia/Kolkata";

// Formatting is done by hand (India has a fixed +05:30 offset and no DST) so server and browser ICU data cannot
// disagree and break hydration.
const IST_OFFSET_MS = 330 * 60_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function istParts(d: Date) {
  const x = new Date(d.getTime() + IST_OFFSET_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), wd: x.getUTCDay(), h: x.getUTCHours(), min: x.getUTCMinutes() };
}

function shortDay(d: Date): string {
  const p = istParts(d);
  return `${p.d} ${MONTHS[p.m].slice(0, 3)}`;
}

/** "1 Oct 2026, 3:45 pm IST". */
export function fmtIST(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const p = istParts(t);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${p.d} ${MONTHS[p.m].slice(0, 3)} ${p.y}, ${h12}:${String(p.min).padStart(2, "0")} ${p.h < 12 ? "am" : "pm"} IST`;
}

/** Calendar day in India (YYYY-MM-DD). */
export function istDayKey(iso: string | Date): string {
  const p = istParts(typeof iso === "string" ? new Date(iso) : iso);
  return `${p.y}-${String(p.m + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "Today · Thursday, 1 October 2026"; without a clock (before mount) just the date. */
export function istDayLabel(key: string, now: Date | null): string {
  const [y, m, d] = key.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const label0 = `${DAYS[wd]}, ${d} ${MONTHS[m - 1]} ${y}`;
  if (!now) return label0;
  const today = istDayKey(now);
  const yesterday = istDayKey(new Date(now.getTime() - 86_400_000));
  if (key === today) return `Today · ${label0}`;
  if (key === yesterday) return `Yesterday · ${label0}`;
  return label0;
}

export function relativeShort(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.round((now.getTime() - t) / 1000);
  if (s < -60) return shortDay(new Date(t));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return shortDay(new Date(t));
}

/** A clock that is null during SSR/hydration and ticks every minute after mount (avoids hydration mismatches). */
export function useNow(intervalMs = 60_000): Date | null {
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Relative time with the absolute IST time on hover; renders the absolute time until mounted. */
export function TimeAgo({ iso, now, className, prefix }: { iso: string; now: Date | null; className?: string; prefix?: string }) {
  const abs = fmtIST(iso);
  return (
    <time dateTime={iso} title={`${prefix ? `${prefix} ` : ""}${abs}`} className={cn("tabular whitespace-nowrap", className)} suppressHydrationWarning>
      {prefix ? `${prefix} ` : ""}{now ? relativeShort(iso, now) : shortDay(new Date(iso))}
    </time>
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export class NewsApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function newsApi<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, { cache: "no-store", ...rest, headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) }, body: json !== undefined ? JSON.stringify(json) : rest.body });
  const text = await res.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!res.ok) throw new NewsApiError((payload as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`, res.status);
  return payload as T;
}

export function newsQueryString(q: { source?: string | null; court?: string | null; q?: string | null; limit?: number; before?: string | null }): string {
  const sp = new URLSearchParams();
  if (q.source) sp.set("source", q.source);
  if (q.court) sp.set("court", q.court);
  if (q.q?.trim()) sp.set("q", q.q.trim());
  if (q.limit) sp.set("limit", String(q.limit));
  if (q.before) sp.set("before", q.before);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Ask the server to refresh the feeds (server-side throttle applies) and explain the outcome in a toast when `notify`.
 * Returns the result, or null on failure.
 */
export async function requestRefresh(opts: { notify: boolean; force?: boolean }): Promise<RefreshResult | null> {
  try {
    const r = await newsApi<RefreshResult>("/api/news/refresh", { method: "POST", json: { force: opts.force ?? false } });
    if (opts.notify) {
      if (r.status === "ran" && r.run) {
        const failed = r.run.feeds.filter((f) => !f.ok);
        const names = failed.map((f) => newsSourceById(f.sourceId)?.publisher ?? "a publisher").join(", ");
        if (failed.length === r.run.feeds.length) toast.error("Could not update the news", { description: "The publishers could not be reached; earlier headlines are shown." });
        else toast.success(r.run.added ? `${r.run.added} new headline${r.run.added === 1 ? "" : "s"}` : "Headlines are up to date", { description: failed.length ? `Not reachable: ${names}.` : undefined });
      } else if (r.status === "skipped") {
        const next = r.nextAllowedAt ? new Date(r.nextAllowedAt) : null;
        const mins = next ? Math.max(1, Math.ceil((next.getTime() - Date.now()) / 60_000)) : null;
        toast.message("Headlines were updated recently", { description: mins ? `The next update is available in about ${mins} min.` : "An update is already running." });
      }
    }
    return r;
  } catch (e) {
    if (opts.notify) toast.error(e instanceof NewsApiError && e.status === 403 ? "You do not have permission to refresh news" : "News refresh failed", { description: e instanceof Error ? e.message : undefined });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Labels and rows
// ---------------------------------------------------------------------------

function labelTitle(l: NewsLabel): string {
  if (l.kind === "court") return l.labelSource === "title" ? `Court label from the headline text "${l.matched}"` : `Court label from the publisher's ${l.labelSource === "feed tag" ? "tag" : "category"} "${l.matched}"`;
  return `Topic from the publisher's category "${l.matched}"`;
}

/** The name publishers use ("Bombay High Court", "Supreme Court"); falls back to the registry name. */
export function courtShort(id: string): string {
  if (id === "sci") return "Supreme Court";
  return exactCourtNames(id)[1] ?? courtById(id)?.name ?? id;
}

export function LabelList({ labels, maxTopics = 2, className }: { labels: NewsLabel[]; maxTopics?: number; className?: string }) {
  const courts = labels.filter((l) => l.kind === "court");
  const topics = labels.filter((l) => l.kind === "topic").slice(0, maxTopics);
  if (!courts.length && !topics.length) return null;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      {courts.map((l) => (
        <Tip key={`c-${l.id}`} label={labelTitle(l)}>
          <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-primary"><span className="size-1.5 rounded-full bg-primary/70" aria-hidden />{courtShort(l.id)}</span>
        </Tip>
      ))}
      {topics.map((l) => (
        <Tip key={`t-${l.id}`} label={labelTitle(l)}>
          <span className="max-w-[16rem] truncate text-[10.5px] text-muted-foreground">{l.label}</span>
        </Tip>
      ))}
    </span>
  );
}

/** One headline: publisher · time, linked title (new tab), optional summary, labels. Never full article text. */
export function HeadlineRow({ item, now, summary, compact }: { item: NewsArticle; now: Date | null; summary?: boolean; compact?: boolean }) {
  const undated = !item.publishedAt;
  const syndicated = item.syndicatedBy.map((s) => newsSourceById(s.sourceId)?.publisher ?? s.sourceId);
  return (
    <li className={cn("group px-3 transition-colors hover:bg-accent/40", compact ? "py-2" : "py-2.5")}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="truncate font-medium text-foreground/80">{item.publisher}</span>
        <span aria-hidden>·</span>
        {undated
          ? <Tip label={`The feed gave no publish date${item.publishedRaw ? ` (it said "${item.publishedRaw}")` : ""}; sorted by when ${BRAND.name} first saw it.`}><span className="whitespace-nowrap"><TimeAgo iso={item.firstSeenAt} now={now} prefix="first seen" /></span></Tip>
          : <TimeAgo iso={item.publishedAt!} now={now} />}
        {syndicated.length > 0 && <Tip label={`Also carried by ${syndicated.join(", ")}`}><span className="hidden truncate sm:inline">· also {syndicated[0]}{syndicated.length > 1 ? ` +${syndicated.length - 1}` : ""}</span></Tip>}
      </div>
      <h3 className={cn("mt-0.5 font-medium leading-snug text-foreground", compact ? "text-[12.5px]" : "text-[13px]")}>
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:underline underline-offset-2 focus-visible:underline focus-visible:outline-none">{item.title}<span className="sr-only"> (opens {item.publisher} in a new tab)</span></a>
      </h3>
      {summary && item.summary && <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">{item.summary}</p>}
      <LabelList labels={item.labels} maxTopics={compact ? 1 : 3} className="mt-1" />
    </li>
  );
}

export type NewsList = NewsListResponse;
