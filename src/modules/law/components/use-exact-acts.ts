"use client";
import * as React from "react";
import { exactCentralAct } from "../reader";
import type { LawInstrumentHit, LawListResponse } from "../shared";
import { fetchLawJson } from "./fetch";

/**
 * Resolve exact Central Act citation titles ("Bharatiya Nyaya Sanhita, 2023") to statutes-corpus instruments through
 * /api/law, by exact title only (`exactCentralAct`): a title that does not resolve stays null and is never replaced by
 * a similar Act. Results are cached for the page session; failed lookups are not cached so a later render retries.
 */

export type ActLookup = LawInstrumentHit | null;

const cache = new Map<string, ActLookup>();
const inflight = new Map<string, Promise<ActLookup>>();

async function lookup(title: string): Promise<ActLookup> {
  if (cache.has(title)) return cache.get(title)!;
  let p = inflight.get(title);
  if (!p) {
    p = fetchLawJson<LawListResponse>(`/api/law?q=${encodeURIComponent(title)}&j=central&status=all&limit=5`)
      .then((r) => { const hit = exactCentralAct(title, r.hits); cache.set(title, hit); return hit; })
      .finally(() => inflight.delete(title));
    inflight.set(title, p);
  }
  return p;
}

/** title → instrument (resolved), null (no exact match), undefined (still looking up or the lookup failed). */
export function useExactCentralActs(titles: readonly string[]): { acts: Map<string, ActLookup | undefined>; failed: boolean } {
  const key = [...new Set(titles)].sort().join("\u0000");
  const [, setTick] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    const wanted = key ? key.split("\u0000") : [];
    const missing = wanted.filter((t) => !cache.has(t));
    if (!missing.length) return;
    setFailed(false);
    let next = 0;
    const worker = async () => {
      while (next < missing.length) {
        const t = missing[next++];
        try { await lookup(t); } catch { if (live) setFailed(true); }
        if (live) setTick((n) => n + 1);
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
    return () => { live = false; };
  }, [key]);
  const acts = new Map<string, ActLookup | undefined>();
  for (const t of key ? key.split("\u0000") : []) acts.set(t, cache.has(t) ? cache.get(t)! : undefined);
  return { acts, failed };
}
