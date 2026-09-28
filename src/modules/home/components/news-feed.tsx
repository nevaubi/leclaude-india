"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import Link from "next/link";
import { ArrowDownWideNarrow, BookmarkPlus, Building2, Clock, ExternalLink, Gavel, Info, Landmark, MessageSquareText, Newspaper, RefreshCw, Scale, Search, Briefcase, Factory, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { NewsItem, PracticeArea } from "@/lib/types/domain";
import { NEWS_CATEGORIES, PRACTICE_AREAS } from "../types";
import { fmtDate, relativeLabel, toDate } from "../time";
import { useHomeUI } from "../store";
import { useHome } from "./home-provider";
import { EmptyRow, MatterBadge, Section } from "./shared";

const CATEGORY: Record<NewsItem["category"], { label: string; icon: LucideIcon; className: string }> = {
  court: { label: "Court", icon: Gavel, className: "text-primary" },
  regulatory: { label: "Regulatory", icon: Landmark, className: "text-foreground/80" },
  legislative: { label: "Legislative", icon: Scale, className: "text-foreground/80" },
  industry: { label: "Industry", icon: Factory, className: "text-muted-foreground" },
  firm: { label: "Firm", icon: Building2, className: "text-foreground/80" },
  client: { label: "Client", icon: Briefcase, className: "text-foreground/80" },
};

/** Category as icon + text; no chip, so a row carries at most the one "New" marker. */
export function CategoryBadge({ category, className }: { category: NewsItem["category"]; className?: string }) {
  const c = CATEGORY[category];
  const Icon = c.icon;
  return <span className={cn("inline-flex items-center gap-1 text-[10.5px] font-medium", c.className, className)}><Icon className="size-3" />{c.label}</span>;
}

export function useVisibleNews() {
  const { news, matterFilter } = useHome();
  const f = useHomeUI((s) => s.news);
  return React.useMemo(() => {
    const q = f.query.trim().toLowerCase();
    const list = news.filter((n) =>
      (f.category === "all" || n.category === f.category) &&
      (f.practiceArea === "all" || (n.practiceAreas ?? []).includes(f.practiceArea)) &&
      (!matterFilter || (n.matterIds ?? []).includes(matterFilter)) &&
      (!q || `${n.title} ${n.summary} ${n.source}`.toLowerCase().includes(q)),
    );
    list.sort(f.sort === "newest" ? (a, b) => b.publishedAt.localeCompare(a.publishedAt) : (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || b.publishedAt.localeCompare(a.publishedAt));
    const counts: Record<string, number> = { all: news.length };
    for (const n of news) counts[n.category] = (counts[n.category] ?? 0) + 1;
    return { list, counts };
  }, [news, matterFilter, f]);
}

function NewsToolbar({ full }: { full?: boolean }) {
  const { refreshNews, newsRefreshing } = useHome();
  const f = useHomeUI((s) => s.news);
  const setNews = useHomeUI((s) => s.setNews);
  return (
    <>
      {full && (
        <div className="relative hidden md:block">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input size="xs" value={f.query} onChange={(e) => setNews({ query: e.target.value })} placeholder="Search news…" className="w-48 pl-7" />
        </div>
      )}
      {full && (
        <Select value={f.practiceArea} onValueChange={(v) => setNews({ practiceArea: v as PracticeArea | "all" })}>
          <SelectTrigger size="xs" className="w-44 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All practice areas</SelectItem>{PRACTICE_AREAS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
        </Select>
      )}
      <Tip label={f.sort === "relevance" ? "Sorted by relevance · click for newest" : "Sorted by newest · click for relevance"}>
        <Button variant="ghost" size="xs" className="text-[11px] text-muted-foreground" onClick={() => setNews({ sort: f.sort === "relevance" ? "newest" : "relevance" })}>{f.sort === "relevance" ? <ArrowDownWideNarrow className="size-3" /> : <Clock className="size-3" />}{f.sort === "relevance" ? "Relevance" : "Newest"}</Button>
      </Tip>
      <Tip label="Pull the last 7 days from the Federal Register (fails quietly offline)"><Button variant="ghost" size="icon-xs" onClick={() => void refreshNews()} disabled={newsRefreshing} aria-label="Refresh news"><RefreshCw className={cn("size-3.5", newsRefreshing && "animate-spin")} /></Button></Tip>
    </>
  );
}

function CategoryChips({ counts }: { counts: Record<string, number> }) {
  const f = useHomeUI((s) => s.news);
  const setNews = useHomeUI((s) => s.setNews);
  const chip = (key: NewsItem["category"] | "all", label: string) => (
    <button key={key} onClick={() => setNews({ category: key })} className={cn("flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] transition-colors cursor-pointer", f.category === key ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>{label}<span className="tabular opacity-60">{counts[key] ?? 0}</span></button>
  );
  // Only categories that have items (plus the active one) are offered; no row of zeros.
  const present = NEWS_CATEGORIES.filter((c) => (counts[c] ?? 0) > 0 || f.category === c);
  if (present.length < 2 && f.category === "all") return null;
  return <div className="flex gap-1 overflow-x-auto no-scrollbar px-1 py-1.5">{chip("all", "All")}{present.map((c) => chip(c, CATEGORY[c].label))}</div>;
}

export function NewsOverview() {
  const { list, counts } = useVisibleNews();
  const setFocus = useHomeUI((s) => s.setFocus);
  const t = useT();
  const shown = list.slice(0, 8);
  return (
    <Section id="news" title={t("home.section.news")} count={list.length} actions={<NewsToolbar />} onExpand={() => setFocus("news")}>
      <CategoryChips counts={counts} />
      {shown.length === 0 ? <EmptyRow icon={Newspaper} title={t("home.section.noNews")} hint={t("home.news.emptyHint")} /> : (
        <ul className="divide-y border-t">{shown.map((n, i) => <NewsCard key={n.id} item={n} index={i} />)}</ul>
      )}
      {list.length > shown.length && <button onClick={() => setFocus("news")} className="flex w-full items-center justify-center gap-1 border-t py-2 text-[11.5px] text-muted-foreground hover:text-foreground cursor-pointer">Show all {list.length}</button>}
    </Section>
  );
}

export function NewsFocus() {
  const { list, counts } = useVisibleNews();
  const setFocus = useHomeUI((s) => s.setFocus);
  const t = useT();
  return (
    <Section id="news" title={t("home.section.news")} icon={Newspaper} count={list.length} expanded onExpand={() => setFocus(null)} actions={<NewsToolbar full />} bodyClassName="overflow-auto scrollbar-thin">
      <CategoryChips counts={counts} />
      {list.length === 0 ? <EmptyRow icon={Newspaper} title={t("home.section.noNews")} hint={t("home.news.emptyFocusHint")} /> : (
        <ul className="mx-auto max-w-4xl divide-y border-t">{list.map((n, i) => <NewsCard key={n.id} item={n} index={i} full />)}</ul>
      )}
    </Section>
  );
}

function NewsCard({ item: n, index, full }: { item: NewsItem; index: number; full?: boolean }) {
  const { now, matterById, saveNews, newNewsIds } = useHome();
  const askAssistant = useHomeUI((s) => s.askAssistant);
  const [expanded, setExpanded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const isNew = newNewsIds.has(n.id);
  const matters = (n.matterIds ?? []).map((id) => matterById(id)).filter(Boolean);
  const relevance = n.relevance ?? 0;

  const save = async () => {
    setSaving(true);
    const href = await saveNews(n.id);
    setSaving(false);
    if (href) toast.success("Saved to Library → News clippings", { description: n.title, action: { label: "Open", onClick: () => { window.location.href = href; } } });
  };
  const ask = () => askAssistant(`About this news item (${n.source}, ${fmtDate(n.publishedAt, { month: "long", day: "numeric", year: "numeric" })}): "${n.title}"\n\n${n.summary}${n.url ? `\nSource: ${n.url}` : ""}\n\nWhat does this mean for ${matters.length ? matters.map((m) => m!.shortName).join(" and ") : "our matters"}, and what should we do about it this week?`);

  return (
    <li className={cn("group px-3 py-2 transition-colors hover:bg-accent/40", isNew && "bg-primary/5")} data-index={index}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <CategoryBadge category={n.category} />
        {isNew && <Badge variant="info" size="xs">New</Badge>}
        <span className="truncate font-medium text-foreground/80">{n.source}</span>
        <span>·</span>
        <time dateTime={n.publishedAt} title={fmtDate(n.publishedAt, { month: "long", day: "numeric", year: "numeric" })}>{relativeLabel(n.publishedAt, now)}</time>
        <div className="flex-1" />
        <Tip label={`Relevance ${relevance}/100 to active matters`}>
          <span className="flex items-center gap-1"><span className="h-1 w-10 overflow-hidden rounded-full bg-muted"><span className={cn("block h-full rounded-full", relevance >= 85 ? "bg-primary" : relevance >= 65 ? "bg-chart-2" : "bg-muted-foreground/50")} style={{ width: `${relevance}%` }} /></span><span className="tabular text-[10px]">{relevance}</span></span>
        </Tip>
      </div>
      <h3 className="mt-0.5 text-[12.5px] font-medium leading-snug text-foreground">
        {n.url ? <a href={n.url} target="_blank" rel="noreferrer" className="hover:underline underline-offset-2">{n.title}</a> : n.title}
      </h3>
      <p className={cn("mt-0.5 text-[12px] leading-relaxed text-muted-foreground", !expanded && !full && "line-clamp-2")} onClick={() => setExpanded((v) => !v)}>{n.summary}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {matters.map((m) => <MatterBadge key={m!.id} matterId={m!.id} link />)}
        {(n.practiceAreas ?? []).slice(0, 2).map((p) => <span key={p} className="text-[10.5px] text-muted-foreground">{p}</span>)}
        <div className="ml-auto flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
          <Popover>
            <PopoverTrigger asChild><Button variant="ghost" size="xs" className="h-6 px-1.5 text-[11px] text-muted-foreground"><Info className="size-3" /> Why relevant</Button></PopoverTrigger>
            <PopoverContent align="end" className="w-72 text-xs">
              <div className="text-[11.5px] font-medium text-muted-foreground">Why this is in your feed</div>
              <p className="mt-1 leading-relaxed">{whyRelevant(n, matters.map((m) => m!.shortName))}</p>
              {matters.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {matters.map((m) => <li key={m!.id}><Link href={`/ediscovery?matter=${m!.id}`} className="inline-flex items-center gap-1 text-primary hover:underline"><Scale className="size-3" />{m!.shortName}<span className="text-muted-foreground">· {m!.practiceArea}</span></Link></li>)}
                </ul>
              )}
              <div className="mt-2 flex items-center gap-1 text-[10.5px] text-muted-foreground">Relevance score <span className="tabular font-medium text-foreground">{relevance}</span>/100 · published {fmtDate(n.publishedAt, { month: "short", day: "numeric", year: "numeric" })}{toDate(n.publishedAt).getTime() > now.getTime() ? " (future-dated)" : ""}</div>
            </PopoverContent>
          </Popover>
          <Tip label="Save to Library (News clippings)"><Button variant="ghost" size="icon-xs" className="size-6 text-muted-foreground" onClick={() => void save()} disabled={saving} aria-label="Save to library"><BookmarkPlus className="size-3.5" /></Button></Tip>
          <Tip label="Ask the assistant about this item"><Button variant="ghost" size="icon-xs" className="size-6 text-muted-foreground" onClick={ask} aria-label="Ask about this"><MessageSquareText className="size-3.5" /></Button></Tip>
          {n.url && <Tip label="Open source"><a href={n.url} target="_blank" rel="noreferrer" className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Open source"><ExternalLink className="size-3.5" /></a></Tip>}
        </div>
      </div>
    </li>
  );
}

function whyRelevant(n: NewsItem, matterNames: string[]): string {
  const parts: string[] = [];
  if (matterNames.length) parts.push(`Tagged to ${matterNames.join(" and ")}`);
  if (n.practiceAreas?.length) parts.push(`${matterNames.length ? "and matches" : "Matches"} the firm's ${n.practiceAreas.join(" / ")} practice`);
  if (n.category === "court") parts.push("a court development in a forum where the firm has an active matter");
  if (n.category === "regulatory") parts.push("a regulatory change that can shift strategy or deadlines");
  if (n.category === "client") parts.push("news about a current client");
  if (n.category === "firm") parts.push("an internal firm announcement");
  return (parts.length ? parts.join("; ") : "General interest for the firm") + ".";
}
