"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Building2, Landmark, Map as MapIcon, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { exactCentralAct, KEY_CENTRAL_ACTS } from "../reader";
import { citationTitle, lawHref, type LawFacets, type LawFilters, type LawInstrumentHit, type LawListResponse } from "../shared";
import { asLawApiError, fetchLawJson, type LawApiError } from "./fetch";
import { StatusText } from "./law-states";

const fmt = (n: number) => n.toLocaleString("en-IN");

const EXAMPLE_PROVISION_SEARCHES = ["anticipatory bail", "dishonour of cheque", "specific performance", "setting aside arbitral award", "default bail", "oppression and mismanagement"];

type KeyActsState = { found: { wanted: string; hit: LawInstrumentHit }[]; failed: number; checked: number };

// Resolved once per page session: the key Acts do not change while the page is open.
let keyActsMemo: KeyActsState | null = null;

async function resolveKeyActs(signal: AbortSignal): Promise<KeyActsState> {
  const results: ({ wanted: string; hit: LawInstrumentHit | null } | "failed")[] = new Array(KEY_CENTRAL_ACTS.length);
  let next = 0;
  let lastError: LawApiError | null = null;
  const worker = async () => {
    while (next < KEY_CENTRAL_ACTS.length) {
      const i = next++;
      const wanted = KEY_CENTRAL_ACTS[i];
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
  await Promise.all([worker(), worker(), worker(), worker()]);
  const failed = results.filter((r) => r === "failed").length;
  if (failed === results.length && lastError) throw lastError;
  const found = results.flatMap((r) => (r !== "failed" && r.hit ? [{ wanted: r.wanted, hit: r.hit }] : []));
  return { found, failed, checked: results.length - failed };
}

/** /law with no query or filter: a curated start page instead of an endless table. */
export function LawLanding({ facets, facetsLoading, facetsError, onRetryFacets, onPick, sectionsMode }: {
  facets: LawFacets | null;
  facetsLoading: boolean;
  facetsError: LawApiError | null;
  onRetryFacets: () => void;
  onPick: (patch: Partial<LawFilters>) => void;
  sectionsMode: boolean;
}) {
  const j = (v: string) => facets?.jurisdictions.find((x) => x.value === v) ?? null;
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1180px] space-y-7 px-4 pb-10 pt-4 sm:px-6">
        {sectionsMode ? (
          <section aria-labelledby="law-examples">
            <h2 id="law-examples" className="text-[12px] font-medium text-muted-foreground">Try a provision search</h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLE_PROVISION_SEARCHES.map((q) => (
                <button key={q} type="button" onClick={() => onPick({ q, mode: "sections" })} className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2.5 text-[12.5px] text-foreground/85 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  <Search className="size-3 text-muted-foreground" aria-hidden />{q}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="law-jurisdictions">
          <SectionTitle id="law-jurisdictions" title="Browse by jurisdiction" />
          {facetsLoading && !facets ? (
            <div className="mt-2.5 grid gap-2.5 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[88px] rounded-lg" />)}</div>
          ) : !facets ? (
            <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">
              Coverage could not be loaded{facetsError ? `: ${facetsError.message}` : "."}
              <Button size="xs" variant="outline" onClick={onRetryFacets}><RotateCcw className="size-3.5" />Retry</Button>
            </div>
          ) : (
            <div className="mt-2.5 grid gap-2.5 sm:grid-cols-3">
              <JurisdictionTile icon={Landmark} label="Central" sub="Acts of Parliament" stat={j("central")} onClick={() => onPick({ jurisdiction: "central" })} />
              <JurisdictionTile icon={MapIcon} label="States and Union Territories" sub={`${facets.states.length} legislatures`} stat={j("state")} onClick={() => onPick({ jurisdiction: "state" })} />
              <JurisdictionTile icon={Building2} label="Regulators" sub={`${facets.regulators.length} publishers`} stat={j("regulator")} onClick={() => onPick({ jurisdiction: "regulator" })} />
            </div>
          )}
        </section>

        <div className="grid gap-7 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <KeyActs />
          {facets || facetsLoading ? <section aria-labelledby="law-regulators">
            <SectionTitle id="law-regulators" title="Regulators" note="Regulations, circulars and rules as published" />
            {facetsLoading && !facets ? <ListSkeleton rows={8} /> : facets?.regulators.length ? (
              <ul className="mt-2 divide-y rounded-lg border">
                {facets.regulators.map((r) => (
                  <li key={r.value}>
                    <button type="button" onClick={() => onPick({ jurisdiction: "regulator", regulator: r.value })} className="flex w-full items-center gap-2 px-3 py-[7px] text-left text-[12.5px] transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50">
                      <span className="min-w-0 flex-1 truncate text-foreground/90">{r.label}</span>
                      <span className="shrink-0 text-[11.5px] text-muted-foreground tabular">{fmt(r.instruments)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-[12px] text-muted-foreground">No regulator publications are loaded.</p>}
          </section> : null}
        </div>

        {facets || facetsLoading ? <section aria-labelledby="law-states">
          <SectionTitle id="law-states" title="States and Union Territories" note="State and UT legislation from India Code" />
          {facetsLoading && !facets ? <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="h-6" />)}</div> : facets?.states.length ? (
            <ul className="mt-2 grid gap-x-5 sm:grid-cols-2 lg:grid-cols-4">
              {facets.states.map((s) => (
                <li key={s.code} className="border-b border-line-quiet">
                  <button type="button" onClick={() => onPick({ jurisdiction: "state", state: s.code })} className="flex w-full items-center gap-2 rounded-sm py-[6px] text-left text-[12.5px] transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                    <span className="min-w-0 flex-1 truncate text-foreground/90">{s.name}</span>
                    <span className="shrink-0 text-[11.5px] text-muted-foreground tabular">{fmt(s.instruments)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-[12px] text-muted-foreground">No State legislation is loaded.</p>}
        </section> : null}
      </div>
    </div>
  );
}

function SectionTitle({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h2 id={id} className="text-[13px] font-semibold tracking-[-0.005em]">{title}</h2>
      {note ? <span className="truncate text-[11.5px] text-muted-foreground">{note}</span> : null}
    </div>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return <div className="mt-2 space-y-px overflow-hidden rounded-lg border">{Array.from({ length: rows }, (_, i) => <div key={i} className="px-3 py-2"><Skeleton className="h-3.5" style={{ width: `${55 + ((i * 17) % 35)}%` }} /></div>)}</div>;
}

function JurisdictionTile({ icon: Icon, label, sub, stat, onClick }: { icon: typeof Landmark; label: string; sub: string; stat: { instruments: number; sections: number } | null; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex flex-col items-start rounded-lg border bg-card px-3.5 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      <span className="flex w-full items-center gap-1.5 text-[12.5px] font-medium text-foreground/90">
        <Icon className="size-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden />{label}
        <ArrowUpRight className="ml-auto size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </span>
      <span className="mt-1.5 text-[20px] font-semibold leading-none tracking-[-0.02em] tabular">{stat ? fmt(stat.instruments) : "—"}</span>
      <span className="mt-1 text-[11.5px] text-muted-foreground tabular">{stat ? `${fmt(stat.sections)} sections · ${sub}` : sub}</span>
    </button>
  );
}

function KeyActs() {
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

  return (
    <section aria-labelledby="law-key-acts">
      <SectionTitle id="law-key-acts" title="Key Central Acts" note="Frequently cited Central legislation" />
      {error && !state ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">
          The key Acts could not be looked up: {error.message}
          <Button size="xs" variant="outline" onClick={() => setNonce((n) => n + 1)}><RotateCcw className="size-3.5" />Retry</Button>
        </div>
      ) : !state ? <ListSkeleton rows={10} /> : !state.found.length ? (
        <p className="mt-2 rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">None of the key Central Acts are available yet. Search by title above or browse Central legislation.</p>
      ) : (
        <>
          <ul className="mt-2 divide-y rounded-lg border">
            {state.found.map(({ hit }) => (
              <li key={hit.id}>
                <Link href={lawHref(hit.id)} className="flex items-center gap-3 px-3 py-[7px] transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{citationTitle(hit)}</span>
                  <span className="hidden shrink-0 text-[11.5px] text-muted-foreground tabular sm:inline">{hit.sections ? `${fmt(hit.sections)} sections` : ""}</span>
                  <StatusText status={hit.status} className={cn("w-[92px] shrink-0 text-[11.5px]", hit.status === "in_force" && "text-muted-foreground")} />
                </Link>
              </li>
            ))}
          </ul>
          {state.failed ? (
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
              {state.failed} of {KEY_CENTRAL_ACTS.length} could not be checked just now.{" "}
              <button type="button" className="text-primary hover:underline" onClick={() => setNonce((n) => n + 1)}>Retry</button>
            </p>
          ) : state.found.length < KEY_CENTRAL_ACTS.length ? (
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">{KEY_CENTRAL_ACTS.length - state.found.length} of the {KEY_CENTRAL_ACTS.length} listed Acts are not available yet.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
