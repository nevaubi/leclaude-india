"use client";
import * as React from "react";
import { BookOpen, Check, Copy, Pin, Search } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { TrustStateBadge } from "@/components/ai/trust-badge";
import { courtAbbreviation } from "../jurisdictions";
import { ALL_SOURCES, SOURCE_LABEL, type SearchSource } from "../types";
import type { ResearchSource } from "../engine/types";
import { sourceTrustState } from "../engine/trust";
import { AuthorityBadge, SOURCE_ICON } from "./result-card";
import { useResearchActions } from "./research-context";
import { humanizeCitation } from "@/modules/law/shared";

const ORDER: SearchSource[] = ["caselaw", "statutes", "regulations", "federal_register", "dockets", "ediscovery", "library", "web"];

export function SourcesPanel({ sources }: { sources: ResearchSource[] }) {
  const [filter, setFilter] = React.useState("");
  const [onlyCited, setOnlyCited] = React.useState(false);
  const groups = React.useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = sources.filter((s) => (!onlyCited || s.n != null) && (!f || `${s.title} ${s.cite ?? ""} ${s.court ?? ""} ${s.snippet ?? ""}`.toLowerCase().includes(f)));
    return ORDER.filter((k) => ALL_SOURCES.includes(k)).map((k) => ({ kind: k, items: list.filter((s) => s.kind === k).sort((a, b) => (a.n ?? 999) - (b.n ?? 999) || Number(b.read) - Number(a.read)) })).filter((g) => g.items.length);
  }, [sources, filter, onlyCited]);
  const cited = sources.filter((s) => s.n != null).length;

  if (!sources.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"><BookOpen className="size-5" /></span>
        <div className="text-sm font-medium">No sources yet</div>
        <div className="max-w-[260px] text-xs text-muted-foreground">Every authority, page and record document the lanes find or read is listed here, deduped and grouped by kind.</div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <div className="relative flex-1"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${sources.length} sources`} className="h-7 pl-7 text-xs" /></div>
        <button onClick={() => setOnlyCited((v) => !v)} className={cn("h-7 rounded-md border px-2 text-[11px] cursor-pointer", onlyCited ? "border-transparent bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>Cited {cited}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {groups.map((g) => {
          const Icon = SOURCE_ICON[g.kind];
          return (
            <section key={g.kind}>
              <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b bg-background/95 px-3 py-1.5 text-[11.5px] font-medium text-muted-foreground backdrop-blur"><Icon className="size-3" /> {SOURCE_LABEL[g.kind]} <span className="tabular font-normal">{g.items.length}</span></div>
              <ul className="divide-y">{g.items.map((s) => <SourceRow key={s.id} s={s} />)}</ul>
            </section>
          );
        })}
        {!groups.length && <div className="p-4 text-center text-xs text-muted-foreground">No sources match.</div>}
      </div>
    </div>
  );
}

export function SourceRow({ s, compact }: { s: ResearchSource; compact?: boolean }) {
  const a = useResearchActions();
  const [copied, setCopied] = React.useState(false);
  const pinned = a.isPinned(s.id);
  const hover = a.hoverN != null && a.hoverN === s.n;
  const meta = [s.court ? courtAbbreviation(s.court, s.hit.court) : null, s.date ? formatDate(s.date) : null, s.read ? `${((s.chars ?? 0) / 1000).toFixed(1)}k chars read` : null].filter(Boolean).join(" · ");
  const state = sourceTrustState(s, a.trustContext);
  return (
    <li className={cn("group px-3 py-2 transition-colors", hover && "bg-primary/5")} onMouseEnter={() => a.setHoverN(s.n ?? null)} onMouseLeave={() => a.setHoverN(null)} data-source-state={state}>
      <div className="flex items-start gap-2">
        <span className={cn("mt-0.5 inline-flex h-[18px] min-w-[22px] shrink-0 items-center justify-center rounded px-1 text-[10.5px] font-semibold tabular", s.n != null ? "bg-accent text-foreground" : "text-muted-foreground")}>{s.n != null ? s.n : "·"}</span>
        <div className="min-w-0 flex-1">
          <button onClick={() => a.openSource(s)} className="block w-full text-left text-[12.5px] font-medium leading-snug text-foreground hover:text-primary cursor-pointer">{s.title}</button>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-muted-foreground">
            <TrustStateBadge state={state} size="xs" />
            {s.cite && <span className="font-mono text-foreground/80">{humanizeCitation(s.cite)}</span>}
            {meta && <span>{meta}</span>}
            <AuthorityBadge authority={s.authority} />
            {s.treatment?.signal === "possibly_negative" && <Tip label={<span className="block max-w-xs">{s.treatment.note}{s.treatment.examples?.length ? <span className="mt-1 block opacity-80">{s.treatment.examples.map((e) => `${e.title}${e.phrase ? ` (“${e.phrase}”)` : ""}`).join("; ")}</span> : null}</span>}><Badge variant="warning" className="cursor-help py-0" data-treatment="possibly_negative">Treatment: review</Badge></Tip>}
            {s.treatment?.signal === "no_negative_signal" && <Tip label={s.treatment.note}><span className="cursor-help text-[10px] text-muted-foreground" data-treatment="no_negative_signal">no negative signal</span></Tip>}
            {s.currentness && (s.currentness.flag === "dated" || s.currentness.flag === "proposed") && <Tip label={s.currentness.label}><Badge variant="muted" className="cursor-help py-0" data-currentness={s.currentness.flag}>{s.currentness.flag === "proposed" ? "Proposed" : `${s.currentness.years}y old`}</Badge></Tip>}
            {s.scope === "record" && <Badge variant="info" className="py-0">Record</Badge>}
            {s.scope === "internal" && <Badge variant="accent" className="py-0">Library</Badge>}
          </div>
          {!compact && s.snippet && <div className="mt-1 line-clamp-2 font-serif text-[12px] leading-snug text-muted-foreground">{s.snippet}</div>}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-0.5 pl-8 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button variant="ghost" size="xs" onClick={() => a.openSource(s)}><BookOpen className="size-3" /> Open</Button>
        <Button variant="ghost" size="xs" onClick={() => { a.copyCite(s.hit); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />} Cite</Button>
        <Tip label={pinned ? "Pinned" : "Pin to the memo"}><Button variant="ghost" size="xs" onClick={() => a.pinSource(s)} disabled={pinned}><Pin className={cn("size-3", pinned && "fill-current text-primary")} /> {pinned ? "Pinned" : "Pin"}</Button></Tip>
      </div>
    </li>
  );
}
