"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRightLeft, ChevronDown, Scale, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { OfficialRowRef } from "@/lib/india/criminal-code-map";
import { displayHeading, lawBlocks } from "../reader";
import { LAW_DATASET, lawApiHref, lawHref, type LawInstrument, type LawSectionResponse } from "../shared";
import { sideBySide, verificationLabel, type CompareColumn, type CompareProvision, type SideBySideModel } from "../side-by-side";
import { asLawApiError, fetchLawJson, type LawApiError } from "./fetch";
import { useExactCentralActs, type ActLookup } from "./use-exact-acts";

/**
 * Old code | new code, side by side, for a section of the IPC/BNS, CrPC/BNSS or Evidence Act/BSA. The provisions shown
 * opposite each other come only from the official concordance data; the texts are the statutes collection's, fetched
 * per provision; the transition rule is coded data with its basis linked into the reader.
 */
export function CodeCompare({ instrument, section, onClose }: { instrument: LawInstrument; section: string; onClose: () => void }) {
  const model = React.useMemo(() => sideBySide(instrument, section), [instrument, section]);
  const titles = React.useMemo(() => {
    if (!model) return [];
    const t = [model.old.title, model.next.title];
    for (const b of model.transition?.basis ?? []) if (b.title) t.push(b.title);
    return t;
  }, [model]);
  const { acts, failed } = useExactCentralActs(titles);
  if (!model) return null;
  const instrumentFor = (col: CompareColumn): ActLookup | undefined => (col.provisions.some((p) => p.current) ? instrument : acts.get(col.title));
  return (
    <section aria-label="Old and new code side by side" className="mx-auto w-full max-w-[1180px] px-4 pb-12 pt-5 sm:px-6">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <ArrowRightLeft className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold leading-snug">{model.headline}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Chip tone={model.verification === "official_cross_checked" ? "info" : model.verification ? "warning" : "outline"} title="How the mapping is backed">{verificationLabel(model.verification)}</Chip>
            {model.status === "split" ? <Chip tone="muted">Split</Chip> : null}
            {model.partial ? <Chip tone="warning" title="The table maps part of a provision, or a different level of detail than this page">Partial</Chip> : null}
            {model.newProvision ? <Chip tone="muted">New provision</Chip> : null}
            {model.confidence === "medium" ? <Chip tone="muted">Medium confidence</Chip> : null}
          </div>
        </div>
        <Button size="xs" variant="outline" onClick={onClose}>Back to the section</Button>
      </header>
      {model.notes.length ? <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[12px] text-muted-foreground">{model.notes.map((n, k) => <li key={k}>{n}</li>)}</ul> : null}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {[model.old, model.next].map((col) => (
          <Column key={col.code} col={col} target={instrumentFor(col)} lookupFailed={failed} />
        ))}
      </div>

      <OfficialRows model={model} />
      <Transition model={model} acts={acts} />

      <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground">
        Concordance: {model.officialSource ? <a href={model.officialSource.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline">{model.officialSource.title}</a> : "coded table"}
        {model.officialSource ? <>, {model.officialSource.publisher}. Government publication, read by machine from the PDF; check the Gazette text before relying on it.</> : null}{" "}
        Statute text: {LAW_DATASET.name} ({LAW_DATASET.licence}); the official text is authoritative.
      </p>
    </section>
  );
}

function Column({ col, target, lookupFailed }: { col: CompareColumn; target: ActLookup | undefined; lookupFailed: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-[var(--surface-quiet)] px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{col.code}</span>
        <span className="min-w-0 truncate text-[12.5px] text-foreground/85">{col.title}</span>
      </div>
      {!col.provisions.length ? (
        <EmptyState compact icon={Scale} title="No counterpart" description={`The concordance names no ${col.code} provision for this section.`} />
      ) : target === null ? (
        <p className="px-3 py-4 text-[12px] text-muted-foreground">The {col.title} is not in the statutes collection, so its text cannot be shown here. {col.provisions.map((p) => p.label).join(", ")}.</p>
      ) : target === undefined ? (
        lookupFailed ? <p className="px-3 py-4 text-[12px] text-muted-foreground">The {col.title} could not be looked up. Reload to try again.</p> : <div className="space-y-2 p-3" aria-busy><Skeleton className="h-3 w-32" />{Array.from({ length: 5 }, (_, k) => <Skeleton key={k} className="h-3" />)}</div>
      ) : (
        <div className="divide-y">{col.provisions.map((p) => <ProvisionText key={`${p.code}-${p.section}`} p={p} instrument={target} />)}</div>
      )}
    </div>
  );
}

function ProvisionText({ p, instrument }: { p: CompareProvision; instrument: Pick<LawInstrument, "id"> }) {
  const [data, setData] = React.useState<LawSectionResponse | null>(null);
  const [error, setError] = React.useState<LawApiError | null>(null);
  React.useEffect(() => {
    const ac = new AbortController();
    setData(null);
    setError(null);
    fetchLawJson<LawSectionResponse>(lawApiHref(instrument.id, { section: p.readerSection }), ac.signal)
      .then(setData)
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(asLawApiError(e)); });
    return () => ac.abort();
  }, [instrument.id, p.readerSection]);
  const href = `${lawHref(instrument.id, p.readerSection)}${p.anchor ? `#${p.anchor}` : ""}`;
  const blocks = data ? lawBlocks(data.section.text, data.section.section) : [];
  return (
    <article className="px-3 py-3" aria-label={p.label}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="rounded bg-muted px-1.5 py-px text-[12px] font-semibold tabular text-foreground/80">{p.label}</span>
        {data?.section.heading ? <span className="font-serif text-[15px] leading-snug">{displayHeading(data.section.heading)}</span> : null}
        {p.note ? <span className="text-[11.5px] text-muted-foreground">({p.note})</span> : null}
        {!p.current ? <Link href={href} className="ml-auto text-[11.5px] text-primary underline-offset-2 hover:underline">Open</Link> : null}
      </div>
      {error ? (
        error.notFound ? <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground"><SearchX className="size-3.5" aria-hidden />No section {p.readerSection} in the collection&apos;s text of this code.</p>
          : <p className="mt-2 text-[12px] text-muted-foreground">The text could not be loaded ({error.message}).</p>
      ) : !data ? (
        <div className="mt-2 space-y-1.5" aria-busy>{Array.from({ length: 4 }, (_, k) => <Skeleton key={k} className="h-3" style={{ width: `${70 + ((k * 11) % 28)}%` }} />)}</div>
      ) : (
        <div className="mt-2 max-h-[420px] overflow-auto pr-1 font-serif text-[14px] leading-[1.65] text-foreground/90 scrollbar-thin">
          {blocks.length ? blocks.filter((b) => b.kind !== "headnote").map((b, k) => (
            <p key={k} className={cn("whitespace-pre-line", k ? "mt-2" : "", (b.kind === "subsection" || b.kind === "clause") && "pl-4", b.kind === "proviso" && "border-l-2 border-primary/25 pl-3", b.kind === "explanation" && "border-l-2 border-line-quiet pl-3", p.anchor && b.anchor === p.anchor && "rounded-sm bg-primary/8")}>
              {b.label ? <span className={cn(b.kind === "lead" ? "font-semibold" : "font-sans text-[12.5px] text-muted-foreground")}>{b.label}</span> : null}{b.text}
            </p>
          )) : <span className="text-[12px] text-muted-foreground">No text is available for this provision.</span>}
          {data.section.truncated ? <p className="mt-2 text-[11.5px] text-muted-foreground">Shown in part; open the section for the rest.</p> : null}
        </div>
      )}
    </article>
  );
}

function OfficialRows({ model }: { model: SideBySideModel }) {
  const [open, setOpen] = React.useState(false);
  const [summaries, setSummaries] = React.useState<Record<string, string | null> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const idKey = model.official.map((r) => r.id).join(",");
  React.useEffect(() => {
    if (!open || summaries || !idKey) return;
    const ac = new AbortController();
    fetchLawJson<{ rows: { id: string; summary: string | null }[] }>(`/api/law/concordance?rows=${encodeURIComponent(idKey)}`, ac.signal)
      .then((r) => setSummaries(Object.fromEntries(r.rows.map((x) => [x.id, x.summary]))))
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(asLawApiError(e).message); });
    return () => ac.abort();
  }, [open, summaries, idKey]);
  if (!model.official.length) return <p className="mt-4 text-[12px] text-muted-foreground">The official correspondence table has no row for this section.</p>;
  return (
    <div className="mt-5 rounded-lg border">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] font-medium hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
        Official table rows ({model.official.length})
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">as printed, with page and reading state</span>
      </button>
      {open ? (
        <div className="overflow-x-auto border-t">
          <table className="w-full min-w-[640px] text-[12px]">
            <thead className="text-left text-[11px] text-muted-foreground">
              <tr className="border-b"><th className="px-3 py-1.5 font-medium">{model.next.code}</th><th className="px-3 py-1.5 font-medium">{model.old.code}</th><th className="px-3 py-1.5 font-medium">Subject</th><th className="px-3 py-1.5 font-medium">Page</th><th className="px-3 py-1.5 font-medium">Reading</th></tr>
            </thead>
            <tbody>
              {model.official.map((r) => <OfficialRow key={r.id} r={r} summary={summaries?.[r.id]} loading={!summaries && !error} />)}
            </tbody>
          </table>
          {error ? <p className="border-t px-3 py-2 text-[11.5px] text-muted-foreground">The comparison summaries could not be loaded ({error}).</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function OfficialRow({ r, summary, loading }: { r: OfficialRowRef; summary: string | null | undefined; loading: boolean }) {
  const blocked = r.verification === "requires_review";
  return (
    <>
      <tr className={cn("border-b align-top last:border-b-0", blocked && "bg-warning/5")}>
        <td className="px-3 pt-2 font-medium tabular">{r.newRaw || "—"}</td>
        <td className="px-3 pt-2 tabular">{r.oldRaw || "—"}</td>
        <td className="px-3 pt-2">{r.subject}</td>
        <td className="px-3 pt-2 tabular text-muted-foreground">{r.page}</td>
        <td className="px-3 pt-2">{blocked ? <Chip tone="warning" title={r.flags.join(", ")}>Unreadable, not used</Chip> : r.flags.length ? <span className="text-muted-foreground" title={r.flags.join(", ")}>Read ({r.flags.join(", ").replace(/_/g, " ")})</span> : <span className="text-muted-foreground">Read</span>}</td>
      </tr>
      <tr className="border-b last:border-b-0">
        <td colSpan={5} className="px-3 pb-2 pt-1 text-[11.5px] leading-snug text-muted-foreground">{loading ? <Skeleton className="h-3 w-2/3" /> : summary ? <>Summary of comparison: {summary}</> : "No summary printed."}</td>
      </tr>
    </>
  );
}

function Transition({ model, acts }: { model: SideBySideModel; acts: Map<string, ActLookup | undefined> }) {
  const t = model.transition;
  if (!t) return null;
  const on = new Date(`${t.on}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <aside aria-label="Which code applies" className="mt-5 rounded-lg border border-line-quiet bg-[var(--surface-quiet)] px-4 py-3 text-[12.5px]">
      <p className="font-medium">Which code applies: {t.decidedBy.toLowerCase()}</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[150px_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Before {on}</dt><dd>{t.before}</dd>
        <dt className="text-muted-foreground">On or after {on}</dt><dd>{t.onOrAfter}</dd>
      </dl>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">{t.caveats.map((c, k) => <li key={k}>{c}</li>)}</ul>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className="text-muted-foreground">Basis:</span>
        {t.basis.map((b) => {
          const a = b.title ? acts.get(b.title) : null;
          return a ? <Link key={b.label} href={lawHref(a.id, b.provision)} className="text-primary underline-offset-2 hover:underline">{b.label}</Link> : <span key={b.label}>{b.label}</span>;
        })}
        <Link href="/tools?tool=codes" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Date converter</Link>
      </p>
      <p className="mt-1.5 text-[11px] text-muted-foreground">The rule is a summary of the provisions linked above; read them before relying on it.</p>
    </aside>
  );
}
