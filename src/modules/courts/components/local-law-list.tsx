"use client";
import * as React from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { LocalLawPointer } from "@/lib/india/forums";

/** Client mirror of the server resolver's result (`src/modules/courts/local-law.ts`). */
export interface LocalLawActView { id: string; title: string; year?: number; status?: string; sourceUrl?: string }
export interface LocalLawItemView { pointer: LocalLawPointer; status: "resolved" | "ambiguous" | "not_found" | "unavailable"; acts: LocalLawActView[] }
export interface LocalLawView { state: string | null; stateName: string; configured: boolean; error?: string; items: LocalLawItemView[] }

export type LocalLawState =
  | { phase: "loading" }
  | { phase: "error"; message: string; status?: number }
  | { phase: "ready"; data: LocalLawView };

const TOPIC: Record<string, string> = {
  rent: "Rent and tenancy", court_fees: "Court fees and valuation", stamp: "Stamp duty", registration: "Registration", municipal: "Municipal",
  land_revenue: "Land revenue", courts: "Civil courts", property: "Property", cooperative: "Co-operative societies",
};

/** Fetch the city's resolved local-law pointers (cancelled when the city changes). */
export function useLocalLaw(cityId: string | null): LocalLawState {
  const [state, setState] = React.useState<LocalLawState>({ phase: "loading" });
  React.useEffect(() => {
    if (!cityId) return;
    const ctl = new AbortController();
    setState({ phase: "loading" });
    fetch(`/api/courts/local-law?city=${encodeURIComponent(cityId)}`, { signal: ctl.signal, cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) setState({ phase: "error", status: res.status, message: res.status === 403 ? "You do not have access to statutes." : (body as { error?: string }).error ?? `Request failed (${res.status})` });
        else setState({ phase: "ready", data: body as LocalLawView });
      })
      .catch((e: unknown) => { if ((e as Error).name !== "AbortError") setState({ phase: "error", message: (e as Error).message || "Network error" }); });
    return () => ctl.abort();
  }, [cityId]);
  return state;
}

function actHref(id: string): string {
  return `/law/${id.split("/").map(encodeURIComponent).join("/")}`;
}

/** `noted`: the list already says statutes could not be checked, so unchecked rows carry no repeated status line. */
function ItemRow({ item, noted }: { item: LocalLawItemView; noted?: boolean }) {
  return (
    <li className="py-1.5">
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{TOPIC[item.pointer.topic] ?? item.pointer.topic}</div>
      {item.status === "resolved" && item.acts[0] && (
        <Link href={actHref(item.acts[0].id)} className="text-[12.5px] text-primary underline-offset-2 hover:underline">{item.acts[0].title}</Link>
      )}
      {item.status === "ambiguous" && (
        <div>
          <div className="text-[12.5px]">{item.pointer.title}</div>
          <div className="text-[11px] text-muted-foreground">{item.acts.length} Acts carry this title:</div>
          <ul className="ml-3 list-disc">{item.acts.map((a) => <li key={a.id}><Link href={actHref(a.id)} className="text-[11.5px] text-primary hover:underline">{a.title}{a.year ? ` (${a.year})` : ""}</Link></li>)}</ul>
        </div>
      )}
      {(item.status === "not_found" || item.status === "unavailable") && (
        <div>
          <div className="text-[12.5px]">{item.pointer.title}</div>
          {item.status === "not_found" || !noted ? <div className="text-[11px] text-muted-foreground">{item.status === "not_found" ? "Not available in Statutes" : "Not checked: Statutes unavailable"}</div> : null}
        </div>
      )}
      {item.pointer.jurisdiction === "central" && <div className="text-[10.5px] text-muted-foreground">Act of Parliament</div>}
    </li>
  );
}

export function LocalLawList({ state }: { state: LocalLawState }) {
  if (state.phase === "loading") {
    return <div className="space-y-2" aria-busy="true" aria-label="Loading local law">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  }
  if (state.phase === "error") {
    return <div className="flex items-start gap-1.5 text-[11.5px]" role="alert"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden /><span>{state.message}</span></div>;
  }
  const { data } = state;
  if (!data.items.length) return <p className="text-[11.5px] text-muted-foreground">No local-law pointers are recorded for {data.stateName || "this State"}.</p>;
  return (
    <>
      {(!data.configured || data.error) && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px]" role="status">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>{!data.configured ? "Statutes are not set up here, so the titles below have not been checked." : "Statutes could not be reached just now, so the titles below have not been checked."}</span>
        </div>
      )}
      <ul className="divide-y divide-line-quiet">{data.items.map((it) => <ItemRow key={it.pointer.title} item={it} noted={!data.configured || Boolean(data.error)} />)}</ul>
    </>
  );
}
