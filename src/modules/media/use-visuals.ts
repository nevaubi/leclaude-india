"use client";
import * as React from "react";
import type { Visual, VisualsResponse } from "./visuals-types";

/**
 * Client access to the visual library (`GET /api/india/visuals`): court buildings, city landmarks and regulator logos.
 * One request per page session (module-level cache); a failed request resolves to empty maps, so every image slot
 * falls back to its typographic tile, and the next mount after a failure tries again.
 */

export const EMPTY_VISUALS: VisualsResponse = { courts: {}, cities: {}, regulators: {}, updatedAt: null };

let cached: VisualsResponse | null = null;
let inflight: Promise<VisualsResponse> | null = null;

function isVisualsResponse(v: unknown): v is VisualsResponse {
  const o = v as Partial<VisualsResponse> | null;
  return Boolean(o && typeof o === "object" && o.courts && o.cities && o.regulators);
}

export function loadVisuals(): Promise<VisualsResponse> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch("/api/india/visuals", { headers: { accept: "application/json" } })
      .then(async (r) => {
        const body: unknown = r.ok ? await r.json().catch(() => null) : null;
        if (isVisualsResponse(body)) { cached = body; return body; }
        return EMPTY_VISUALS;
      })
      .catch(() => EMPTY_VISUALS)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** The visual library, or null while it loads (render the placeholder tile meanwhile). */
export function useVisuals(): VisualsResponse | null {
  const [data, setData] = React.useState<VisualsResponse | null>(cached);
  React.useEffect(() => {
    if (cached) { setData(cached); return; }
    let live = true;
    loadVisuals().then((v) => { if (live) setData(v); });
    return () => { live = false; };
  }, []);
  return data;
}

/** Only images served from our own media store are shown (never a hotlink). */
function own(v: Visual | undefined): Visual | null {
  return v && typeof v.url === "string" && v.url.startsWith("/") && !v.url.startsWith("//") ? v : null;
}

export function courtVisual(data: VisualsResponse | null, courtId: string | null | undefined): Visual | null {
  return data && courtId ? own(data.courts[courtId]) : null;
}

export function cityVisual(data: VisualsResponse | null, cityId: string | null | undefined): Visual | null {
  return data && cityId ? own(data.cities[cityId]) : null;
}

/** Regulator logos are keyed by the stored regulator value ("rbi", "sebi"); uppercase and label keys are accepted too. */
export function regulatorVisual(data: VisualsResponse | null, key: string | null | undefined, label?: string | null): Visual | null {
  if (!data || !key) return null;
  const m = data.regulators;
  return own(m[key] ?? m[key.toUpperCase()] ?? (label ? m[label] ?? m[label.toUpperCase()] : undefined));
}
