"use client";
import * as React from "react";
import Link from "next/link";
import type { CoramMatch, CoramResponse } from "../shared";
import { judgeHref } from "../shared";
import { JudgeAvatar } from "./judge-avatar";

/**
 * The coram of a judgment record, each name as printed. A name links to a judge profile only when the judges
 * directory has a judge of the same court with exactly that normalized name; otherwise it stays plain text.
 */
export function CoramJudges({ courtId, judges, author }: { courtId: string | null; judges: string[]; author?: string | null }) {
  const [matches, setMatches] = React.useState<CoramMatch[] | null>(null);
  const key = `${courtId ?? ""}|${judges.join("|")}`;
  React.useEffect(() => {
    if (!courtId || !judges.length) { setMatches(null); return; }
    const ac = new AbortController();
    const qs = new URLSearchParams({ court: courtId });
    for (const j of judges) qs.append("name", j);
    fetch(`/api/judges/coram?${qs}`, { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (r) => (r.ok ? ((await r.json()) as CoramResponse).matches : null))
      .then((m) => setMatches(m))
      .catch(() => { if (!ac.signal.aborted) setMatches(null); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures courtId and the names
  }, [key]);

  const linked = matches?.some((m) => m.judge) ?? false;
  return (
    <div>
      <ul className="space-y-1">
        {judges.map((name, i) => {
          const m = matches?.[i]?.name === name ? matches[i] : null;
          const isAuthor = Boolean(author && name === author);
          return (
            <li key={`${name}-${i}`} className="flex items-center gap-2">
              {m?.judge ? (
                <Link href={judgeHref(m.judge.id)} className="inline-flex min-w-0 items-center gap-2 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  <JudgeAvatar name={m.judge.name} photo={m.judge.photo} size={22} />
                  <span className="min-w-0 truncate">{name}</span>
                </Link>
              ) : <span className="min-w-0">{name}</span>}
              {isAuthor ? <span className="text-[11px] text-muted-foreground">author</span> : null}
            </li>
          );
        })}
      </ul>
      {linked ? <p className="mt-1.5 text-[11px] text-muted-foreground">Profiles are linked where the printed name matches a judge of this court.</p> : null}
    </div>
  );
}
