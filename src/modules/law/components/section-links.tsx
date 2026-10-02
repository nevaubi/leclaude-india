"use client";
import * as React from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink, Gavel, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { courtById } from "@/lib/india/courts";
import { cn } from "@/lib/utils";
import { caseHref } from "@/modules/caselaw/shared";
import { citatorActFor, linkableSectionKey, type InterpretingResponse } from "../interpreting";
import type { LawInstrument } from "../shared";
import { asLawApiError, fetchLawJson } from "./fetch";

/**
 * Two quiet panels under a section's text: the judgments in the case-law collection linked to the section (from their
 * full text or their official headnote, never merged into one claim), and the section's amendment history as India Code
 * prints it. Each has its own loading, empty, not-built and error state; neither blocks the reading text.
 */

const fmt = (n: number) => n.toLocaleString("en-IN");
const fmtDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "Date not recorded");

export function SectionJudgments({ instrument, section }: { instrument: LawInstrument; section: string }) {
  const applicable = Boolean(citatorActFor(instrument) && linkableSectionKey(section));
  const [data, setData] = React.useState<InterpretingResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => { setData(null); setOffset(0); setError(null); }, [instrument.id, section]);
  React.useEffect(() => {
    if (!applicable) return;
    const ac = new AbortController();
    setLoading(true);
    fetchLawJson<InterpretingResponse>(`/api/law/interpreting?act=${encodeURIComponent(instrument.id)}&section=${encodeURIComponent(section)}&offset=${offset}`, ac.signal)
      .then((r) => setData((prev) => (offset && prev ? { ...r, judgments: [...prev.judgments, ...r.judgments] } : r)))
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(asLawApiError(e).message); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [applicable, instrument.id, section, offset]);
  if (!applicable) return null;
  return (
    <section aria-label="Judgments on this section" className="mt-7 border-t pt-4">
      <h3 className="flex items-center gap-2 text-[12.5px] font-semibold"><Gavel className="size-3.5 text-muted-foreground" aria-hidden />Judgments on this section</h3>
      {error ? <p className="mt-2 text-[12px] text-muted-foreground">The judgments could not be loaded ({error}).</p>
        : !data ? <div className="mt-2 space-y-1.5" aria-busy><Skeleton className="h-3 w-56" /><Skeleton className="h-3 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>
          : data.state === "not_built" ? <p className="mt-2 text-[12px] text-muted-foreground">{data.coverage} Links appear once they are built.</p>
            : data.state === "not_applicable" ? <p className="mt-2 text-[12px] text-muted-foreground">{data.note}</p>
              : (
                <>
                  <p className="mt-1.5 text-[12px] text-muted-foreground">
                    {data.total ? <><span className="font-medium text-foreground/85 tabular">{fmt(data.total)}</span> judgment{data.total === 1 ? "" : "s"}: {fmt(data.fromText)} cite it in their text, {fmt(data.headnoteOnly)} only in the headnote; {fmt(data.textAvailable)} with full text available.</> : "No judgment in the collection is linked to this section yet."}
                  </p>
                  {data.judgments.length ? (
                    <ul className="mt-2 divide-y rounded-md border">
                      {data.judgments.map((j) => (
                        <li key={j.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2 text-[12.5px]">
                          <Link href={caseHref(j.id)} className="min-w-0 max-w-full truncate font-medium text-foreground underline-offset-2 hover:underline">{j.title}</Link>
                          <span className="text-[11.5px] text-muted-foreground">{courtById(j.courtId)?.shortName ?? j.courtId ?? "Court not resolved"} · {fmtDate(j.decisionDate)}{j.citation ? ` · ${j.citation}` : ""}</span>
                          <span className="ml-auto flex gap-1">
                            {j.fromText ? <Chip tone="muted" title="The judgment's text cites this section">Cited in text</Chip> : <Chip tone="outline" title="Only the official headnote names this section">Headnote only</Chip>}
                            {j.textAvailable ? null : <Chip tone="outline" title="Only metadata is in the collection">Metadata only</Chip>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {data.hasMore ? <Button size="xs" variant="ghost" className="mt-1" disabled={loading} onClick={() => setOffset(data.judgments.length)}>Show more</Button> : null}
                  <p className="mt-1.5 text-[11px] text-muted-foreground">Coverage: {data.coverage}. {data.note}</p>
                </>
              )}
    </section>
  );
}

interface Amendment { marker: number; action: string; amendingAct: string | null; amendingProvision: string | null; withEffectFrom: string | null; actFromIbid: boolean; text: string }
type OfficialLookup =
  | { state: "not_loaded" | "no_section" }
  | { state: "act_pending" | "act_unlinked" | "act_failed"; reason: string | null }
  | { state: "found"; section: { amendments: Amendment[]; icUrl: string | null; linkMethod: string | null; fetchedAt: string | null } };

const VERB: Record<string, string> = { substituted: "Substituted", inserted: "Inserted", omitted: "Omitted", repealed: "Repealed", renumbered: "Renumbered", added: "Added", amended: "Amended", other: "Note" };

export function SectionAmendments({ instrument, section }: { instrument: LawInstrument; section: string }) {
  const [data, setData] = React.useState<OfficialLookup | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const applicable = instrument.jurisdiction === "central" && Boolean(linkableSectionKey(section));
  React.useEffect(() => {
    if (!applicable) return;
    const ac = new AbortController();
    setData(null); setError(null);
    fetchLawJson<OfficialLookup>(`/api/law/official?act=${encodeURIComponent(instrument.id)}&section=${encodeURIComponent(section)}`, ac.signal)
      .then(setData)
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(asLawApiError(e).message); });
    return () => ac.abort();
  }, [applicable, instrument.id, section]);
  if (!applicable || error || !data || data.state === "not_loaded") return null; // nothing loaded yet: stay silent, the text stands alone
  const found = data.state === "found" ? data.section : null;
  const n = found?.amendments.length ?? 0;
  return (
    <section aria-label="Amendment history" className="mt-4 rounded-md border border-line-quiet">
      <button type="button" disabled={!n} onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <History className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">Amendment history</span>
        <span className="text-muted-foreground">
          {found ? (n ? `${n} footnote${n === 1 ? "" : "s"} in India Code` : "India Code records no amendment footnote") : data.state === "no_section" ? "India Code has no section with this number" : data.state === "act_pending" ? "India Code record not loaded yet" : `Not linked to India Code${"reason" in data && data.reason ? `: ${data.reason}` : ""}`}
        </span>
        {n ? <ChevronDown className={cn("ml-auto size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden /> : null}
      </button>
      {open && found ? (
        <div className="border-t px-3 py-2">
          <ol className="space-y-1.5 text-[12px]">
            {found.amendments.map((a) => (
              <li key={a.marker} className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-1">
                <span className="tabular text-muted-foreground">{a.marker}.</span>
                <span>
                  <span className="font-medium">{VERB[a.action] ?? "Note"}</span>
                  {a.amendingAct ? <> by {a.amendingAct}{a.amendingProvision ? `, ${a.amendingProvision}` : ""}</> : null}
                  {a.withEffectFrom ? <span className="text-muted-foreground"> · w.e.f. {fmtDate(a.withEffectFrom)}</span> : null}
                  <span className="block text-[11.5px] text-muted-foreground">{a.text}{a.actFromIbid ? " (amending Act from the previous footnote, “ibid.”)" : ""}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            Source: India Code (Legislative Department), section footnotes{found.fetchedAt ? `, read ${fmtDate(found.fetchedAt.slice(0, 10))}` : ""}.
            {found.icUrl ? <a href={found.icUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline">Open in India Code<ExternalLink className="size-3" aria-hidden /></a> : null}
          </p>
        </div>
      ) : null}
    </section>
  );
}
