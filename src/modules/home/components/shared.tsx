"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Gavel, Maximize2, MessageSquareText, Minimize2, Scale, Workflow, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/ui/avatar";
import { Tip } from "@/components/ui/tooltip";
import type { CalendarEvent, Task } from "@/lib/types/domain";
import { countdown, dueText, type Urgency } from "../time";
import { EVENT_KIND_LABEL } from "../types";
import { useHome } from "./home-provider";

/** Event kind → token classes (dot, chip background/text, calendar bar). */
export const KIND_STYLE: Record<CalendarEvent["kind"], { dot: string; chip: string; bar: string; label: string }> = {
  deadline: { dot: "bg-destructive", chip: "bg-destructive/10 text-destructive border-destructive/20", bar: "border-l-destructive", label: EVENT_KIND_LABEL.deadline },
  filing: { dot: "bg-chart-5", chip: "bg-chart-5/10 text-chart-5 border-chart-5/20", bar: "border-l-chart-5", label: EVENT_KIND_LABEL.filing },
  hearing: { dot: "bg-primary", chip: "bg-primary/10 text-primary border-primary/20", bar: "border-l-primary", label: EVENT_KIND_LABEL.hearing },
  deposition: { dot: "bg-chart-2", chip: "bg-chart-2/12 text-chart-2 border-chart-2/25", bar: "border-l-chart-2", label: EVENT_KIND_LABEL.deposition },
  meeting: { dot: "bg-chart-4", chip: "bg-chart-4/12 text-chart-4 border-chart-4/25", bar: "border-l-chart-4", label: EVENT_KIND_LABEL.meeting },
  internal: { dot: "bg-muted-foreground", chip: "bg-muted text-muted-foreground border-border", bar: "border-l-muted-foreground", label: EVENT_KIND_LABEL.internal },
  cle: { dot: "bg-chart-3", chip: "bg-chart-3/15 text-warning-foreground dark:text-chart-3 border-chart-3/30", bar: "border-l-chart-3", label: EVENT_KIND_LABEL.cle },
  other: { dot: "bg-foreground/50", chip: "bg-accent text-accent-foreground border-transparent", bar: "border-l-foreground/40", label: EVENT_KIND_LABEL.other },
};

export const PRIORITY_STYLE: Record<Task["priority"], { label: string; className: string; dot: string }> = {
  urgent: { label: "Urgent", className: "bg-destructive/10 text-destructive border-destructive/20", dot: "bg-destructive" },
  high: { label: "High", className: "bg-chart-3/15 text-warning-foreground dark:text-chart-3 border-chart-3/30", dot: "bg-warning" },
  medium: { label: "Medium", className: "bg-primary/8 text-primary border-primary/15", dot: "bg-muted-foreground/50" },
  low: { label: "Low", className: "bg-muted text-muted-foreground border-transparent", dot: "bg-muted-foreground/25" },
};

export const URGENCY_STYLE: Record<Urgency, string> = {
  overdue: "bg-destructive/10 text-destructive border-destructive/25",
  today: "bg-chart-3/15 text-warning-foreground dark:text-chart-3 border-chart-3/30",
  soon: "bg-primary/10 text-primary border-primary/20",
  upcoming: "bg-accent text-accent-foreground border-transparent",
  later: "bg-muted text-muted-foreground border-transparent",
  past: "bg-muted text-muted-foreground border-transparent",
};

export function KindDot({ kind, className }: { kind: CalendarEvent["kind"]; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", KIND_STYLE[kind].dot, className)} aria-hidden />;
}

export function KindBadge({ kind, className }: { kind: CalendarEvent["kind"]; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] leading-4 text-muted-foreground", className)}><KindDot kind={kind} className="size-1.5" />{KIND_STYLE[kind].label}</span>;
}

export function PriorityBadge({ priority, className, compact }: { priority: Task["priority"]; className?: string; compact?: boolean }) {
  const s = PRIORITY_STYLE[priority];
  if (compact) return <Tip label={`${s.label} priority`}><span className={cn("inline-block size-1.5 rounded-full", s.dot, className)} /></Tip>;
  return <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] leading-4 text-muted-foreground", className)}><span className={cn("inline-block size-1.5 rounded-full", s.dot)} aria-hidden />{s.label}</span>;
}

/** Due-date text, e.g. "in 3 days", "9 days overdue", "today"; plain text, danger color only when overdue. */
export function CountdownChip({ date, deadline, className, prefix }: { date?: string | null; deadline?: boolean; className?: string; prefix?: string }) {
  const { now } = useHome();
  if (!date) return null;
  const c = countdown(date, now, { deadline });
  const d = deadline ? dueText(date, now) : null;
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap text-[11.5px] leading-none tabular", c.urgency === "overdue" ? "text-destructive" : "text-muted-foreground", className)} title={new Date(date).toLocaleString()}>
      {prefix}{d ? d.text : c.label}
    </span>
  );
}

export function MatterBadge({ matterId, className, link }: { matterId?: string | null; className?: string; link?: boolean }) {
  const { matterById } = useHome();
  const m = matterById(matterId);
  if (!m) return null;
  const inner = <span className={cn("inline-flex max-w-[160px] items-center gap-1 truncate text-[11px] text-muted-foreground", link && "hover:text-primary", className)} title={m.name}><Scale className="size-2.5 shrink-0" /><span className="truncate">{m.shortName}</span></span>;
  return link ? <Link href={`/ediscovery?matter=${m.id}`} onClick={(e) => e.stopPropagation()}>{inner}</Link> : inner;
}

export function SourceIcon({ source, className }: { source?: Task["source"]; className?: string }) {
  if (!source || source === "manual") return null;
  const map: Record<Exclude<Task["source"], "manual" | undefined>, { icon: LucideIcon; label: string }> = { workflow: { icon: Workflow, label: "Created by a workflow" }, agent: { icon: MessageSquareText, label: "Created by an agent" }, docket: { icon: Gavel, label: "From the docket monitor" } };
  const it = map[source];
  const Icon = it.icon;
  return <Tip label={it.label}><span className={cn("inline-flex items-center text-muted-foreground", className)}><Icon className="size-3" /></span></Tip>;
}

export function PeopleStack({ ids, max = 4, size = "xs", className }: { ids: string[]; max?: number; size?: "xs" | "sm"; className?: string }) {
  const { personById } = useHome();
  const people = ids.map((id) => personById(id)).filter(Boolean);
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span className={cn("inline-flex items-center", className)}>
      {shown.map((p, i) => (
        <PersonAvatar key={p!.id} name={p!.name} size={size} className={cn("ring-2 ring-card", i > 0 && "-ml-1.5")} />
      ))}
      {extra > 0 && <span className={cn("-ml-1.5 inline-flex items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-card", size === "xs" ? "size-5" : "size-6")}>+{extra}</span>}
    </span>
  );
}

export function PersonChip({ id, className, size = "xs" }: { id?: string | null; className?: string; size?: "xs" | "sm" }) {
  const { personById } = useHome();
  const p = personById(id);
  if (!p) return null;
  return <span className={cn("inline-flex items-center gap-1.5 text-xs", className)}><PersonAvatar name={p.name} size={size} /><span className="truncate">{p.name}</span></span>;
}

/** Section wrapper with a dense header and optional expand/collapse toggle. */
export function Section({ id, title, icon: Icon, count, actions, children, className, bodyClassName, onExpand, expanded, description }: { id?: string; title: React.ReactNode; icon?: LucideIcon; count?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string; onExpand?: () => void; expanded?: boolean; description?: React.ReactNode }) {
  const t = useT();
  return (
    <section id={id} className={cn("@container flex min-w-0 flex-col", expanded && "h-full rounded-md border bg-card", className)}>
      <header className={cn("section-header h-9", !expanded && "px-1")}>
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
        <h2 className="section-title">{title}</h2>
        {count != null && <span className="section-count">{count}</span>}
        {description && <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground @lg:inline">{description}</span>}
        <div className="flex-1" />
        <div className="flex items-center gap-1">{actions}</div>
        {onExpand && (
          <Tip label={expanded ? t("common.backToOverview") : t("common.expand")} shortcut={expanded ? "Esc" : undefined}>
            <Button variant="ghost" size="icon-xs" onClick={onExpand} aria-label={expanded ? t("common.collapse") : t("common.expand")}>{expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</Button>
          </Tip>
        )}
      </header>
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyRow({ icon: Icon, title, hint, action, className }: { icon?: LucideIcon; title: string; hint?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1 px-4 py-6 text-center", className)}>
      {Icon && <Icon className="size-4 text-muted-foreground/70" />}
      <div className="text-[12.5px] font-medium">{title}</div>
      {hint && <div className="max-w-xs text-[11.5px] text-muted-foreground">{hint}</div>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className={cn("inline-flex items-center gap-0.5 text-primary hover:underline underline-offset-2", className)} onClick={(e) => e.stopPropagation()}>{children}<ArrowUpRight className="size-3" /></a>;
}

/** Native date/time inputs styled like our Input. */
export function DateInput({ value, onChange, className, ...rest }: { value: string; onChange: (v: string) => void; className?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={cn("h-8 w-full rounded-md border border-input bg-background px-2.5 text-[12.5px] shadow-xs focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none tabular", className)} {...rest} />;
}

export function TimeInput({ value, onChange, className, ...rest }: { value: string; onChange: (v: string) => void; className?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  return <input type="time" value={value} onChange={(e) => onChange(e.target.value)} className={cn("h-8 w-full rounded-md border border-input bg-background px-2.5 text-[12.5px] shadow-xs focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none tabular", className)} {...rest} />;
}

export function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mb-1 text-[11.5px] font-medium text-muted-foreground", className)}>{children}</div>;
}

/** Sentinel for "none" in Radix selects (empty string is not allowed). */
export const NONE = "__none__";
