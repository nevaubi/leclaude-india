"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRightLeft, Info } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { sectionCorrespondence } from "../code-correspondence";
import { hasMixedStatus, legacyIndiaCodeNote, lawHref, sectionStatusBadge, statusBreakdown, type LawInstrument, type StatusTone } from "../shared";
import { useExactCentralActs } from "./use-exact-acts";

const fmt = (n: number) => n.toLocaleString("en-IN");

function toneClasses(tone: StatusTone) {
  return tone === "ok"
    ? { box: "border-success/30 bg-success/5 text-foreground/85", dot: "bg-success/75" }
    : tone === "off"
      ? { box: "border-warning/40 bg-warning/5 text-warning-foreground dark:text-warning", dot: "bg-warning" }
      : { box: "border-border bg-muted/40 text-muted-foreground", dot: "bg-muted-foreground/45" };
}

/** The section's recorded status ("In force", "Repealed", "Status not recorded" …). Green only for in force. */
export function SectionStatusChip({ status, inForce }: { status: string | null; inForce: boolean | null }) {
  const b = sectionStatusBadge({ status, in_force: inForce });
  const c = toneClasses(b.tone);
  return (
    <Tip label={b.title}>
      <span tabIndex={0} data-tone={b.tone} className={cn("inline-flex h-5 items-center gap-1.5 rounded-[var(--radius-chip)] border px-1.5 text-[11px] font-medium leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", c.box)}>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", c.dot)} />
        {b.label}
      </span>
    </Tip>
  );
}

/** "Link from the dataset (India Code moved …)" next to an old indiacode.nic.in link; nothing for other links. */
export function LegacyLinkNote({ url, compact, className }: { url: string | null | undefined; compact?: boolean; className?: string }) {
  const note = legacyIndiaCodeNote(url);
  if (!note) return null;
  if (compact) {
    return (
      <Tip label={note}>
        <span tabIndex={0} aria-label={note} className={cn("inline-flex items-center rounded text-warning-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-warning", className)}><Info className="size-3.5" aria-hidden /></span>
      </Tip>
    );
  }
  return <p className={cn("text-[11.5px] leading-snug text-muted-foreground", className)}>{note}.</p>;
}

/** "Mixed: 412 in force · 3 repealed" for an instrument whose provisions do not share one status (loader v2 data). */
export function StatusBreakdownLine({ i, className }: { i: Pick<LawInstrument, "status_counts">; className?: string }) {
  const rows = statusBreakdown(i.status_counts);
  if (!hasMixedStatus(i.status_counts)) return null;
  return (
    <Tip label="Provisions of this instrument by the status the dataset records for them. The headline status is the most common one.">
      <span tabIndex={0} className={cn("inline-flex flex-wrap items-center gap-x-1.5 rounded text-[11.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)} aria-label="Provision status breakdown">
        <span className="text-muted-foreground">Provisions:</span>
        {rows.map((r, k) => (
          <React.Fragment key={r.status}>
            {k ? <span aria-hidden className="text-muted-foreground/50">·</span> : null}
            <span className={cn("tabular", r.tone === "off" ? "text-warning-foreground dark:text-warning" : r.tone === "ok" ? "text-foreground/85" : "text-muted-foreground")}>{fmt(r.count)} {r.label.toLowerCase()}</span>
          </React.Fragment>
        ))}
      </span>
    </Tip>
  );
}

/**
 * For a section of the IPC, CrPC or Evidence Act (and the 2023 codes), the corresponding provision(s) in the other
 * code from the coded table, linked into the reader when the other code resolves in the corpus by exact title.
 */
export function CodeCorrespondence({ instrument, section }: { instrument: LawInstrument; section: string }) {
  const c = React.useMemo(() => sectionCorrespondence(instrument, section), [instrument, section]);
  const titles = React.useMemo(() => (c ? [c.otherTitle] : []), [c]);
  const { acts } = useExactCentralActs(titles);
  if (!c) return null;
  const other = acts.get(c.otherTitle);
  const unmapped = c.status === "unmapped";
  return (
    <aside aria-label="Correspondence with the other criminal code" className={cn("mt-3 rounded-md border px-3 py-2 text-[12px]", unmapped ? "border-dashed" : "border-line-quiet bg-[var(--surface-quiet)]")}>
      <div className="flex items-start gap-2">
        <ArrowRightLeft className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="leading-snug text-foreground/85">{c.headline}</p>
          {c.targets.length ? (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {c.targets.map((t) => (
                <li key={`${t.code}-${t.section}`} className="min-w-0">
                  {other ? (
                    <Link href={lawHref(other.id, t.readerSection)} className="font-medium text-primary tabular underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">{t.label}</Link>
                  ) : <span className="font-medium tabular">{t.label}</span>}
                  {t.note ? <span className="text-muted-foreground"> ({t.note})</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {c.subject ? <p className="mt-1 text-muted-foreground">{c.subject}{c.confidence === "medium" ? " · correspondence marked medium confidence" : ""}</p> : c.confidence === "medium" ? <p className="mt-1 text-muted-foreground">Correspondence marked medium confidence.</p> : null}
          {c.notes.length ? <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">{c.notes.map((n, k) => <li key={k}>{n}</li>)}</ul> : null}
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            From a coded correspondence table ({c.source}), not the Gazette. Which code applies depends on the dates; use the{" "}
            <Link href="/tools?tool=codes" className="underline-offset-2 hover:text-foreground hover:underline">converter</Link>.
            {other === null ? <> The {c.otherTitle} is not in the statutes collection, so the provisions are not linked.</> : null}
          </p>
        </div>
      </div>
    </aside>
  );
}
