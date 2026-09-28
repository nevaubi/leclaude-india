"use client";
import * as React from "react";
import { T } from "@/lib/i18n/client";
import Link from "next/link";
import { useHome } from "./home-provider";
import { Section } from "./shared";
import type { MatterActivity } from "@/modules/intel/context/types";
import { DOC_KIND_LABEL, fmtDate } from "@/modules/intel/analysis/pure";

/**
 * "Matter watch": docket and regulatory activity on the user's active
 * matters in the last 30 days, from the intelligence layer. Quiet, dense,
 * nothing rendered until the intelligence layer has records for a matter.
 */
export function MatterWatchSection() {
  const { userId, matterFilter, intelInsights } = useHome();
  const [items, setItems] = React.useState<MatterActivity[] | null>(null);
  React.useEffect(() => {
    if (!intelInsights) { setItems([]); return; }
    let alive = true;
    fetch(`/api/intel/context?userId=${encodeURIComponent(userId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setItems(Array.isArray(j?.user?.matterActivity) ? (j.user.matterActivity as MatterActivity[]) : []); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [userId, intelInsights]);
  const shown = (items ?? []).filter((a) => !matterFilter || a.matterId === matterFilter);
  if (!shown.length) return null;
  const total = shown.reduce((n, a) => n + a.total, 0);
  return (
    <Section id="matter-watch" title={<T k="home.section.matterWatch" />} count={total} description={<T k="home.section.matterWatchDesc" />} actions={<Link href="/intel/chronologies" className="text-[11px] text-muted-foreground hover:text-primary"><T k="home.section.chronologies" /></Link>}>
      <div className="grid gap-x-6 @3xl:grid-cols-2">
        {shown.slice(0, 4).map((a) => {
          const rows = [...a.docket.map((d) => ({ ...d, lane: "Docket" })), ...a.regulatory.map((d) => ({ ...d, lane: "Regulatory" })), ...a.other.map((d) => ({ ...d, lane: DOC_KIND_LABEL[d.kind] }))].sort((x, y) => (y.date ?? "").localeCompare(x.date ?? "")).slice(0, 5);
          return (
            <div key={a.matterId} className="min-w-0">
              <div className="flex h-7 items-center gap-2 border-b border-line-quiet px-1 text-[11.5px]"><Link href={`/intel/chronologies?matterId=${a.matterId}`} className="font-medium hover:text-primary">{a.shortName}</Link><span className="tabular text-muted-foreground">{a.total} record{a.total === 1 ? "" : "s"}</span><span className="flex-1" />{a.lastAt && <span className="tabular text-muted-foreground">latest {fmtDate(a.lastAt)}</span>}</div>
              <ul className="divide-y divide-line-quiet">
                {rows.map((d) => (
                  <li key={d.id}>
                    <Link href={`/intel/documents/${encodeURIComponent(d.id)}`} className="flex min-h-7 items-center gap-3 px-1 py-0.5 text-[12px] hover:bg-accent/40">
                      <span className="w-[80px] shrink-0 tabular text-[11px] text-muted-foreground">{fmtDate(d.date)}</span>
                      <span className="w-[70px] shrink-0 truncate text-[11px] text-muted-foreground">{d.lane}</span>
                      <span className="min-w-0 flex-1 truncate" title={d.title}>{d.title}</span>
                      {d.flags.length > 0 && <span className="shrink-0 text-[11px] text-muted-foreground">flagged</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
