"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import Link from "next/link";
import { AlertTriangle, Calculator, CalendarClock, CheckSquare, ExternalLink, Gavel, KeyRound, ListChecks, MoreHorizontal, Newspaper, PenLine, RefreshCw, Scale, StickyNote, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TrustBadge } from "@/components/ai/trust-badge";
import type { Provenance } from "@/lib/integrity/types";
import type { BriefItem, DailyBrief } from "../types";
import { relativeLabel } from "../time";
import { useHome } from "./home-provider";
import { useHomeUI, type HomeSection } from "../store";
import { MatterBadge } from "./shared";
import { isHiddenHref } from "@/lib/features";

const KIND_ICON: Record<BriefItem["kind"], LucideIcon> = { deadline: CalendarClock, hearing: Gavel, task: CheckSquare, news: Newspaper, update: Users, matter: Scale, note: StickyNote };
const KIND_TONE: Record<BriefItem["kind"], string> = { deadline: "text-muted-foreground", hearing: "text-muted-foreground", task: "text-muted-foreground", news: "text-muted-foreground", update: "text-muted-foreground", matter: "text-muted-foreground", note: "text-muted-foreground" };

/** Minimal inline markdown: **bold**, `code`, and [text](url). */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, i = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={i++} className="font-semibold text-foreground">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={i++} className="rounded bg-muted px-1 font-mono text-[11px]">{tok.slice(1, -1)}</code>);
    else { const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok); if (mm) out.push(<a key={i++} href={mm[2]} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{mm[1]}</a>); }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const SECTION_FROM_HASH: Record<string, HomeSection> = { calendar: "calendar", tasks: "tasks", news: "news", updates: "updates", matters: "matters" };

/** The brief may carry provenance (AI generations do); computed briefs do not. Rendered defensively. */
export function briefProvenance(brief: DailyBrief | (DailyBrief & { provenance?: Provenance })): Provenance | undefined {
  const p = (brief as { provenance?: unknown }).provenance;
  return p && typeof p === "object" && "sources" in (p as object) ? (p as Provenance) : undefined;
}

const SHOW = 5;

export function DailyBriefCard({ className }: { className?: string }) {
  const { brief, briefLoading, regenerateBrief, aiConfigured, now } = useHome();
  const setFocus = useHomeUI((s) => s.setFocus);
  const t = useT();
  const [showAll, setShowAll] = React.useState(false);
  const items = showAll ? brief.items : brief.items.slice(0, SHOW);
  const provenance = briefProvenance(brief);

  const go = (href?: string | null) => (e: React.MouseEvent) => {
    if (!href) return;
    if (href.startsWith("/#")) {
      e.preventDefault();
      const key = href.slice(2);
      const section = SECTION_FROM_HASH[key];
      setFocus(null);
      if (section) setFocus(section);
      else requestAnimationFrame(() => document.getElementById(key)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };

  return (
    <section className={cn("flex min-w-0 flex-col", className)} aria-label={t("home.brief.title")}>
      <header className="section-header h-9 px-1">
        <h2 className="section-title">{t("home.brief.title")}</h2>
        {brief.source === "ai" ? (
          <TrustBadge provenance={provenance} compact={!provenance} />
        ) : (
          <span className="text-[11.5px] text-muted-foreground" title={aiConfigured ? "Computed from your calendar, tasks, news and updates. Regenerate for an AI brief." : "No model provider is configured. This brief is computed from your data."}>Computed</span>
        )}
        <span className="hidden text-[11px] text-muted-foreground sm:inline">{relativeLabel(brief.generatedAt, now)}</span>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label="Brief options" disabled={briefLoading}>{briefLoading ? <RefreshCw className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>{t("home.brief.title")}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => void regenerateBrief("ai")}><PenLine /> Draft with AI<span className="ml-auto text-[10px] text-muted-foreground">fast model</span></DropdownMenuItem>
            <DropdownMenuItem onClick={() => void regenerateBrief("computed")}><Calculator /> Recompute from data</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild><Link href="/settings#ai"><KeyRound /> AI configuration</Link></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-1 py-3">
        {briefLoading ? (
          <div className="space-y-2.5">
            <Skeleton className="h-4 w-3/4" />
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-3.5" style={{ width: `${88 - (i % 3) * 9}%` }} />)}
          </div>
        ) : (
          <>
            <p className="text-[13.5px] font-medium leading-snug text-foreground text-balance">{brief.headline}</p>
            {!aiConfigured && (
              <p className="text-[11.5px] text-muted-foreground">Computed from deadlines, tasks and updates. <Link href="/settings#ai" className="underline underline-offset-2 hover:text-foreground">Connect a model provider</Link> for a written brief.</p>
            )}
            <ol className="space-y-0.5">
              {items.map((it, i) => {
                const Icon = KIND_ICON[it.kind] ?? StickyNote;
                const external = it.href && /^https?:/.test(it.href);
                const body = (
                  <li key={i} className="group -mx-1.5 flex items-start gap-2 rounded px-1.5 py-0.5 transition-colors hover:bg-accent/50">
                    <Icon className={cn("mt-0.5 size-3.5 shrink-0", KIND_TONE[it.kind] ?? "text-muted-foreground")} />
                    <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-foreground/90">
                      {inline(it.text)}
                      {it.matterId && <MatterBadge matterId={it.matterId} className="ml-1.5 inline-flex align-middle" />}
                      {external && <ExternalLink className="ml-1 inline size-3 align-middle text-muted-foreground opacity-0 group-hover:opacity-100" />}
                    </span>
                  </li>
                );
                if (!it.href || isHiddenHref(it.href)) return body;
                return external ? (
                  <a key={i} href={it.href} target="_blank" rel="noreferrer" className="block">{body}</a>
                ) : (
                  <Link key={i} href={it.href} onClick={go(it.href)} className="block">{body}</Link>
                );
              })}
            </ol>
            {brief.items.length > SHOW && (
              <button onClick={() => setShowAll((v) => !v)} className="self-start text-[11.5px] text-muted-foreground hover:text-foreground cursor-pointer">{showAll ? "Show fewer" : `Show ${brief.items.length - SHOW} more`}</button>
            )}
            <BriefFooter />
          </>
        )}
      </div>
    </section>
  );
}

/** The four numbers behind the brief, as one quiet line. */
function BriefFooter() {
  const { brief } = useHome();
  const setFocus = useHomeUI((s) => s.setFocus);
  const setTaskFilter = useHomeUI((s) => s.setTaskFilter);
  const s = brief.stats;
  const item = (icon: LucideIcon, label: string, value: number, onClick: () => void, tone?: string) => {
    const Icon = icon;
    return <button onClick={onClick} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/60 cursor-pointer focus-ring"><Icon className={cn("size-3", tone ?? "text-muted-foreground")} /><span className={cn("tabular font-medium", tone)}>{value}</span><span>{label}</span></button>;
  };
  return (
    <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
      {item(CalendarClock, "today", s.eventsToday, () => setFocus("calendar"))}
      {item(AlertTriangle, "overdue", s.overdueTasks, () => { setTaskFilter({ overdue: true }); setFocus("tasks"); }, s.overdueTasks ? "text-destructive" : undefined)}
      {item(ListChecks, "due in 7d", s.dueSoonTasks, () => { setTaskFilter({ overdue: false }); setFocus("tasks"); })}
      {item(Newspaper, "hot news", s.hotNews, () => setFocus("news"))}
    </div>
  );
}

/** Kept for callers that still render the stat tiles; the card now shows the same numbers in its footer. */
export function BriefStats({ className }: { className?: string }) {
  return <div className={className}><BriefFooter /></div>;
}
