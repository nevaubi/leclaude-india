"use client";
import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { judgeHref, type CoramMatch, type CoramResponse } from "../shared";
import { JudgeAvatar } from "./judge-avatar";

/**
 * Coram names resolved to judge profiles for lists (many records at once). Requests are batched per court within a
 * tick and cached per (court, printed name). A name links to a profile only on an exact same-court match from the
 * judges directory; otherwise it stays a plain initials avatar. Failures leave names unresolved (never guessed).
 */

type Judge = NonNullable<CoramMatch["judge"]>;
const cache = new Map<string, Promise<Judge | null>>();
const queue = new Map<string, Map<string, (j: Judge | null) => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const batches = [...queue.entries()];
  queue.clear();
  for (const [court, pending] of batches) {
    const names = [...pending.keys()];
    for (let i = 0; i < names.length; i += 20) {
      const chunk = names.slice(i, i + 20);
      const qs = new URLSearchParams({ court });
      for (const n of chunk) qs.append("name", n);
      fetch(`/api/judges/coram?${qs}`, { headers: { accept: "application/json" } })
        .then(async (r) => (r.ok ? ((await r.json()) as CoramResponse).matches : []))
        .catch(() => [] as CoramMatch[])
        .then((matches) => {
          for (const n of chunk) {
            const m = matches.find((x) => x.name === n);
            pending.get(n)?.(m?.judge ?? null);
            // A failed lookup is not remembered, so a later view can try again.
            if (!m) cache.delete(`${court}|${n}`);
          }
        });
    }
  }
}

function lookup(court: string, name: string): Promise<Judge | null> {
  const key = `${court}|${name}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise<Judge | null>((resolve) => {
      const q = queue.get(court) ?? new Map<string, (j: Judge | null) => void>();
      q.set(name, resolve);
      queue.set(court, q);
      if (!timer) timer = setTimeout(flush, 0);
    });
    cache.set(key, p);
  }
  return p;
}

export function useCoramJudges(courtId: string | null | undefined, names: string[]): (Judge | null)[] | null {
  const key = `${courtId ?? ""}|${names.join("|")}`;
  const [out, setOut] = React.useState<(Judge | null)[] | null>(null);
  React.useEffect(() => {
    if (!courtId || !names.length) { setOut(null); return; }
    let live = true;
    Promise.all(names.slice(0, 20).map((n) => lookup(courtId, n))).then((r) => { if (live) setOut(r); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures courtId and the names
  }, [key]);
  return out;
}

/** Overlapping coram avatars (photo where the name resolves, initials otherwise), with the names as the label. */
export function CoramAvatars({ courtId, judges, size = 22, max = 4, className, linked = false }: { courtId: string | null | undefined; judges: string[]; size?: number; max?: number; className?: string; linked?: boolean }) {
  const matched = useCoramJudges(courtId, judges);
  if (!judges.length) return null;
  const shown = judges.slice(0, max);
  const extra = judges.length - shown.length;
  return (
    <span className={cn("inline-flex items-center", className)} title={`Coram: ${judges.join(", ")}`}>
      <span className="flex -space-x-1.5">
        {shown.map((name, i) => {
          const j = matched?.[i] ?? null;
          const av = <JudgeAvatar name={j?.name ?? name} photo={j?.photo ?? null} size={size} className="ring-2 ring-background" />;
          return linked && j ? (
            <Link key={`${name}-${i}`} href={judgeHref(j.id)} aria-label={name} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">{av}</Link>
          ) : <span key={`${name}-${i}`}>{av}</span>;
        })}
      </span>
      {extra > 0 ? <span className="ml-1 text-[11px] text-muted-foreground tabular">+{extra}</span> : null}
      <span className="sr-only">Coram: {judges.join(", ")}</span>
    </span>
  );
}
