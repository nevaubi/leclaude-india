"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { courtById } from "@/lib/india/courts";
import type { CourtEmblemInfo, CourtEmblemsResponse } from "../shared";

/**
 * A court's identity image: the vision-checked emblem or logo taken from its official website (served from our media
 * store), or a quiet monogram when none is stored, the deployment has no database, or the image fails to load.
 */

let emblems: Promise<Record<string, CourtEmblemInfo>> | null = null;

function loadEmblems(): Promise<Record<string, CourtEmblemInfo>> {
  if (!emblems) {
    emblems = fetch("/api/courts/emblems", { headers: { accept: "application/json" } })
      .then(async (r) => (r.ok ? ((await r.json()) as CourtEmblemsResponse).emblems ?? {} : {}))
      .catch(() => ({}));
  }
  return emblems;
}

export function useCourtEmblem(courtId: string | null | undefined): CourtEmblemInfo | null {
  const [info, setInfo] = React.useState<CourtEmblemInfo | null>(null);
  React.useEffect(() => {
    if (!courtId) { setInfo(null); return; }
    let live = true;
    loadEmblems().then((m) => { if (live) setInfo(m[courtId] ?? null); });
    return () => { live = false; };
  }, [courtId]);
  return info;
}

const STOP = new Set(["high", "court", "of", "the", "for", "state", "at", "judicature", "and", "&"]);

/** Monogram letters: "SC" for the Supreme Court; otherwise the initials of the court's place name(s). */
export function courtMonogram(courtId: string | null | undefined, name?: string | null): string {
  if (courtId === "sci") return "SC";
  const n = courtById(courtId)?.name ?? name ?? "";
  const words = n.split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  const letters = words.map((w) => w[0]).join("").toUpperCase();
  return letters.slice(0, 2) || "C";
}

export function CourtEmblem({ courtId, name, size = 28, className }: { courtId: string | null | undefined; name?: string | null; size?: number; className?: string }) {
  const info = useCourtEmblem(courtId);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [info?.mediaId]);
  const label = courtById(courtId)?.name ?? name ?? "Court";
  const style = { width: size, height: size };
  if (info && !failed) {
    return (
      <span className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-background", className)} style={style} title={`${label} — ${info.kind} from ${hostOf(info.pageUrl ?? info.sourceUrl)}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- served from our media store (content-addressed, cached) */}
        <img src={info.url} alt={`${label} ${info.kind}`} className="size-full object-contain" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-md border border-line-quiet bg-muted font-semibold tracking-[0.02em] text-muted-foreground", className)}
      style={{ ...style, fontSize: Math.max(9, Math.round(size * 0.36)) }}
      aria-hidden
    >
      {courtMonogram(courtId, name)}
    </span>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
