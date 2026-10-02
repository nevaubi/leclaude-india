"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRightLeft, Info } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { codeRepeal, sectionCorrespondence } from "../code-correspondence";
import { legacyIndiaCodeNote, lawHref, sectionStatusBadge, statusLabel, statusTone, type LawInstrument, type StatusTone } from "../shared";
import { useExactCentralActs } from "./use-exact-acts";

function toneClasses(tone: StatusTone) {
  return tone === "ok"
    ? { box: "border-success/30 bg-success/5 text-foreground/85", dot: "bg-success/75" }
    : tone === "off"
      ? { box: "border-warning/40 bg-warning/5 text-warning-foreground dark:text-warning", dot: "bg-warning" }
      : { box: "border-border bg-muted/40 text-muted-foreground", dot: "bg-muted-foreground/45" };
}

/**
 * The section's status ("In force", "Act in force", "Repealed (1 July 2024)", "Status not recorded" …). Green only when
 * the dataset flags the provision itself in force; the IPC, CrPC and Evidence Act always read as repealed.
 */
export function SectionStatusChip({ instrument, status, inForce }: { instrument: Pick<LawInstrument, "title" | "year" | "jurisdiction">; status: string | null; inForce: boolean | null }) {
  const repeal = codeRepeal(instrument);
  const b = sectionStatusBadge({ status, in_force: inForce, repealedOn: repeal?.on ?? null, repealedNote: repeal?.note ?? null });
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

/**
 * The instrument's status in its header: as the dataset records it, except that the IPC, CrPC and Evidence Act always
 * read "Repealed (1 July 2024)" (coded, with the savings note).
 */
export function InstrumentStatus({ i }: { i: Pick<LawInstrument, "title" | "year" | "jurisdiction" | "status"> }) {
  const repeal = codeRepeal(i);
  const tone: StatusTone = repeal ? "off" : statusTone(i.status);
  const label = repeal ? `Repealed (${repeal.on})` : statusLabel(i.status);
  const c = toneClasses(tone);
  const chip = (
    <span tabIndex={repeal ? 0 : undefined} data-tone={tone} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-px text-[11.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", c.box)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", c.dot)} />
      {label}
    </span>
  );
  return repeal ? <Tip label={repeal.note}>{chip}</Tip> : chip;
}

/**
 * For a section of the IPC, CrPC or Evidence Act (and the 2023 codes), the corresponding provision(s) in the other
 * code from the coded table, linked into the reader when the other code resolves in the corpus by exact title.
 */
export function CodeCorrespondence({ instrument, section, onCompare }: { instrument: LawInstrument; section: string; onCompare?: () => void }) {
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
            Source: {c.source}. Which code applies depends on the dates; use the{" "}
            <Link href="/tools?tool=codes" className="underline-offset-2 hover:text-foreground hover:underline">converter</Link>.
            {other === null ? <> The {c.otherTitle} is not in the statutes collection, so the provisions are not linked.</> : null}
            {onCompare ? <>{" "}<button type="button" onClick={onCompare} className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">Compare side by side</button>.</> : null}
          </p>
        </div>
      </div>
    </aside>
  );
}
