"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Building2, Landmark, Map as MapIcon, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { VisualImage } from "@/components/corpus/visual-image";
import { regulatorVisual, useVisuals } from "@/modules/media/use-visuals";
import { exactCentralAct } from "../reader";
import { citationTitle, lawHref, type LawFacets, type LawFilters, type LawInstrumentHit, type LawListResponse } from "../shared";
import { asLawApiError, fetchLawJson, type LawApiError } from "./fetch";
import { StatusText } from "./law-states";
import { groupKeyActs, KEY_ACT_TITLES, NEW_CRIMINAL_LAWS } from "./law-subjects";

const fmt = (n: number) => n.toLocaleString("en-IN");

const EXAMPLE_PROVISION_SEARCHES = ["anticipatory bail", "dishonour of cheque", "specific performance", "setting aside arbitral award", "default bail", "oppression and mismanagement"];

type KeyActsState = { found: { wanted: string; hit: LawInstrumentHit }[]; failed: number; checked: number };

// Resolved once per page session: the key Acts do not change while the page is open.
let keyActsMemo: KeyActsState | null = null;

/** Look each curated title up by exact title (bounded concurrency). A title that does not resolve is left out. */
async function resolveKeyActs(signal: AbortSignal): Promise<KeyActsState> {
  const titles = KEY_ACT_TITLES;
  const results: ({ wanted: string; hit: LawInstrumentHit | null } | "failed")[] = new Array(titles.length);
  let next = 0;
  let lastError: LawApiError | null = null;
  const worker = async () => {
    while (next < titles.length) {
      const i = next++;
      const wanted = titles[i];
      try {
        const r = await fetchLawJson<LawListResponse>(`/api/law?q=${encodeURIComponent(wanted)}&j=central&status=all&limit=5`, signal);
        results[i] = { wanted, hit: exactCentralAct(wanted, r.hits) };
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        lastError = asLawApiError(e);
        results[i] = "failed";
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const failed = results.filter((r) => r === "failed").length;
  if (failed === results.length && lastError) throw lastError;
  const found = results.flatMap((r) => (r !== "failed" && r.hit ? [{ wanted: r.wanted, hit: r.hit }] : []));
  return { found, failed, checked: results.length - failed };
}

function useKeyActs() {
  const [state, setState] = React.useState<KeyActsState | null>(keyActsMemo);
  const [error, setError] = React.useState<LawApiError | null>(null);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (keyActsMemo && !nonce) return;
    const ac = new AbortController();
    setError(null);
    resolveKeyActs(ac.signal)
      .then((r) => { if (!r.failed) keyActsMemo = r; setState(r); })
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(asLawApiError(e)); });
    return () => ac.abort();
  }, [nonce]);
  return { state, error, retry: () => setNonce((n) => n + 1) };
}

/** /law with no query or filter: a visual start page instead of an endless table. */
export function LawLanding({ facets, facetsLoading, facetsError, onRetryFacets, onPick, sectionsMode }: {
  facets: LawFacets | null;
  facetsLoading: boolean;
  facetsError: LawApiError | null;
  onRetryFacets: () => void;
  onPick: (patch: Partial<LawFilters>) => void;
  sectionsMode: boolean;
}) {
  const j = (v: string) => facets?.jurisdictions.find((x) => x.value === v) ?? null;
  const keyActs = useKeyActs();
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1180px] space-y-10 px-4 pb-12 pt-5 sm:px-6">
        {sectionsMode ? (
          <section aria-labelledby="law-examples">
            <SectionTitle id="law-examples" title="Search inside the provisions" note="Words or a phrase; results are sections grouped by Act" />
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_PROVISION_SEARCHES.map((q) => (
                <button key={q} type="button" onClick={() => onPick({ q, mode: "sections" })} className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2.5 text-[12.5px] text-foreground/85 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  <Search className="size-3 text-muted-foreground" aria-hidden />{q}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="law-jurisdictions">
          <h2 id="law-jurisdictions" className="sr-only">Browse by jurisdiction</h2>
          {facetsLoading && !facets ? (
            <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[112px] rounded-xl" />)}</div>
          ) : !facets ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">
              Coverage could not be loaded{facetsError ? `: ${facetsError.message}` : "."}
              <Button size="xs" variant="outline" onClick={onRetryFacets}><RotateCcw className="size-3.5" />Retry</Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <JurisdictionTile icon={Landmark} label="Central" sub="Acts of Parliament" stat={j("central")} onClick={() => onPick({ jurisdiction: "central" })} />
              <JurisdictionTile icon={MapIcon} label="States and Union Territories" sub={`${facets.states.length} legislatures`} stat={j("state")} onClick={() => onPick({ jurisdiction: "state" })} />
              <JurisdictionTile icon={Building2} label="Regulators" sub={`${facets.regulators.length} publishers`} stat={j("regulator")} onClick={() => onPick({ jurisdiction: "regulator" })} />
            </div>
          )}
        </section>

        <NewCriminalLaws keyActs={keyActs} />
        <KeyActsBySubject keyActs={keyActs} />

        {facets || facetsLoading ? (
          <section aria-labelledby="law-states">
            <SectionTitle id="law-states" title="States and Union Territories" note="State and UT legislation from India Code" />
            {facetsLoading && !facets ? <TileSkeleton n={12} h="h-[60px]" /> : facets?.states.length ? (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-2">
                {facets.states.map((s) => (
                  <li key={s.code}>
                    <button type="button" onClick={() => onPick({ jurisdiction: "state", state: s.code })} className="group flex w-full items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                      <span aria-hidden className="flex h-8 w-9 shrink-0 items-center justify-center rounded-md bg-muted font-serif text-[13px] tracking-[0.02em] text-foreground/70">{s.code}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-[12.5px] font-medium text-foreground/90">{s.name}</span>
                        <span className="block text-[11px] text-muted-foreground tabular">{fmt(s.instruments)} instruments</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-[12px] text-muted-foreground">No State legislation is loaded.</p>}
          </section>
        ) : null}

        {facets || facetsLoading ? (
          <section aria-labelledby="law-regulators">
            <SectionTitle id="law-regulators" title="Regulators" note="Regulations, circulars and rules as published" />
            {facetsLoading && !facets ? <TileSkeleton n={8} h="h-[64px]" /> : facets?.regulators.length ? (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
                {facets.regulators.map((r) => <li key={r.value}><RegulatorCard value={r.value} label={r.label} count={r.instruments} onPick={() => onPick({ jurisdiction: "regulator", regulator: r.value })} /></li>)}
              </ul>
            ) : <p className="text-[12px] text-muted-foreground">No regulator publications are loaded.</p>}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function SectionTitle({ id, title, note, action }: { id: string; title: string; note?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 id={id} className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h2>
      {note ? <span className="min-w-0 truncate text-[12px] text-muted-foreground">{note}</span> : null}
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  );
}

function TileSkeleton({ n, h }: { n: number; h: string }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-2" aria-busy>{Array.from({ length: n }, (_, i) => <Skeleton key={i} className={cn(h, "rounded-lg")} />)}</div>;
}

function JurisdictionTile({ icon: Icon, label, sub, stat, onClick }: { icon: typeof Landmark; label: string; sub: string; stat: { instruments: number; sections: number } | null; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex items-start gap-3.5 rounded-xl border bg-card px-4 py-4 text-left transition-colors hover:border-foreground/20 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/70"><Icon className="size-[18px]" strokeWidth={1.6} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground/90">{label}<ArrowUpRight className="ml-auto size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden /></span>
        <span className="mt-1.5 block text-[24px] font-semibold leading-none tracking-[-0.02em] tabular">{stat ? fmt(stat.instruments) : "—"}</span>
        <span className="mt-1.5 block text-[11.5px] text-muted-foreground tabular">{stat ? `${fmt(stat.sections)} sections · ${sub}` : sub}</span>
      </span>
    </button>
  );
}

type KeyActs = ReturnType<typeof useKeyActs>;

function KeyActsError({ keyActs }: { keyActs: KeyActs }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">
      The Acts could not be looked up: {keyActs.error?.message}
      <Button size="xs" variant="outline" onClick={keyActs.retry}><RotateCcw className="size-3.5" />Retry</Button>
    </div>
  );
}

function NewCriminalLaws({ keyActs }: { keyActs: KeyActs }) {
  const { state, error } = keyActs;
  const hitOf = (title: string) => state?.found.find((f) => f.wanted === title)?.hit ?? null;
  const laws = NEW_CRIMINAL_LAWS.map((l) => ({ ...l, hit: hitOf(l.title), prev: hitOf(l.predecessor.title) }));
  if (state && !laws.some((l) => l.hit)) return null;
  return (
    <section aria-labelledby="law-criminal">
      <SectionTitle id="law-criminal" title="The new criminal laws" note="The 2023 Sanhitas and Adhiniyam with the Acts they replaced" />
      {error && !state ? <KeyActsError keyActs={keyActs} /> : (
        <ul className="grid gap-3 md:grid-cols-3">
          {laws.map((l) => (
            <li key={l.short}>
              {!state ? <Skeleton className="h-[176px] rounded-xl" /> : (
                <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card">
                  {l.hit ? (
                    <Link href={lawHref(l.hit.id)} className="group flex flex-1 flex-col px-4 pb-3.5 pt-4 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="font-serif text-[30px] leading-none tracking-[-0.01em] text-foreground">{l.short}</span>
                        <span className="text-[11px] text-muted-foreground">{l.subject}</span>
                      </span>
                      <span className="mt-2.5 text-[13px] font-medium leading-snug text-foreground group-hover:underline">{citationTitle(l.hit)}</span>
                      <span className="mt-auto flex items-center gap-2 pt-2 text-[11.5px] text-muted-foreground tabular">
                        {l.hit.sections ? <span>{fmt(l.hit.sections)} sections</span> : null}
                        <StatusText status={l.hit.status} />
                      </span>
                    </Link>
                  ) : (
                    <div className="flex flex-1 flex-col px-4 pb-3.5 pt-4">
                      <span className="font-serif text-[30px] leading-none text-foreground/40">{l.short}</span>
                      <span className="mt-2.5 text-[13px] font-medium leading-snug text-foreground/70">{l.title}</span>
                      <span className="mt-auto pt-2 text-[11.5px] text-muted-foreground">Not available yet</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 border-t border-line-quiet bg-[var(--surface-quiet)] px-4 py-2 text-[11.5px]">
                    <span className="shrink-0 text-muted-foreground">Replaced</span>
                    {l.prev ? (
                      <Link href={lawHref(l.prev.id)} className="min-w-0 truncate text-foreground/85 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" title={citationTitle(l.prev)}>{citationTitle(l.prev)}</Link>
                    ) : <span className="min-w-0 truncate text-foreground/70">{l.predecessor.title}</span>}
                    {l.prev ? <StatusText status={l.prev.status} className="ml-auto shrink-0" /> : null}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function KeyActsBySubject({ keyActs }: { keyActs: KeyActs }) {
  const { state, error } = keyActs;
  const groups = React.useMemo(() => (state ? groupKeyActs(state.found) : []), [state]);
  const listed = groups.reduce((n, g) => n + g.items.length, 0);
  const wanted = KEY_ACT_TITLES.length - NEW_CRIMINAL_LAWS.length * 2;
  return (
    <section aria-labelledby="law-key-acts">
      <SectionTitle id="law-key-acts" title="Key Central Acts" note="Frequently used legislation, by subject" />
      {error && !state ? <KeyActsError keyActs={keyActs} /> : !state ? (
        <div className="space-y-4" aria-busy>{[0, 1, 2].map((i) => <div key={i} className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]"><Skeleton className="h-4 w-28" /><div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">{[0, 1, 2].map((k) => <Skeleton key={k} className="h-[68px] rounded-lg" />)}</div></div>)}</div>
      ) : !groups.length ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">None of these Acts are available yet. Search by title above or browse Central legislation.</p>
      ) : (
        <>
          <div className="divide-y divide-line-quiet rounded-xl border bg-card">
            {groups.map((g) => (
              <div key={g.key} className="grid gap-x-4 gap-y-2 px-4 py-3.5 md:grid-cols-[180px_minmax(0,1fr)]">
                <h3 className="pt-1 text-[12px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{g.label}</h3>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
                  {g.items.map(({ act, hit }) => (
                    <li key={hit.id}>
                      <Link href={lawHref(hit.id)} className="group flex h-full flex-col rounded-lg border border-transparent px-2.5 py-2 transition-colors hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 text-[13px] font-medium leading-snug text-foreground group-hover:underline">{citationTitle(hit)}</span>
                        </span>
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground tabular">
                          {act.short ? <span className="rounded-[var(--radius-chip)] bg-muted px-1 font-medium text-foreground/70">{act.short}</span> : null}
                          {hit.sections ? <span>{fmt(hit.sections)} sections</span> : null}
                          {hit.status !== "in_force" ? <StatusText status={hit.status} /> : null}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {state.failed ? (
            <p className="mt-2 text-[11.5px] text-muted-foreground">{state.failed} of {KEY_ACT_TITLES.length} could not be checked just now. <button type="button" className="text-primary hover:underline" onClick={keyActs.retry}>Retry</button></p>
          ) : listed < wanted ? (
            <p className="mt-2 text-[11.5px] text-muted-foreground">{wanted - listed} of the {wanted} listed Acts {wanted - listed === 1 ? "is" : "are"} not available yet.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

function RegulatorCard({ value, label, count, onPick }: { value: string; label: string; count: number; onPick: () => void }) {
  const data = useVisuals();
  const logo = regulatorVisual(data, value, label);
  const publisher = logo?.kind === "regulator_logo" ? logo.credit.sourceName : null;
  return (
    <button type="button" onClick={onPick} title={publisher ?? label} className="group flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      <VisualImage
        visual={logo}
        pending={!data}
        contain
        credit="none"
        className="size-10 shrink-0 rounded-md bg-background ring-1 ring-border"
        fallback={<span aria-hidden className="flex size-full items-center justify-center bg-muted font-serif text-[12px] tracking-[0.02em] text-foreground/65">{label.length <= 5 ? label : label.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase()}</span>}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground/90">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground tabular">{publisher ? <>{publisher} · </> : null}{fmt(count)}</span>
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
    </button>
  );
}
