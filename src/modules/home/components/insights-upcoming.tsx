"use client";
import * as React from "react";
import { T } from "@/lib/i18n/client";
import Link from "next/link";
import { useHome } from "./home-provider";
import { Section } from "./shared";
import type { UpcomingPrep } from "@/modules/intel/context/types";
import { fmtDate } from "../time";

/**
 * Upcoming events with preparation material: the insights and records the
 * intelligence layer links to each event in the next two weeks. Renders only
 * when at least one event has something to prepare with.
 */
export function UpcomingPrepSection() {
  const { userId, matterFilter, intelInsights } = useHome();
  const [items, setItems] = React.useState<UpcomingPrep[] | null>(null);
  React.useEffect(() => {
    if (!intelInsights) { setItems([]); return; }
    let alive = true;
    fetch(`/api/intel/context?userId=${encodeURIComponent(userId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setItems(Array.isArray(j?.user?.upcoming) ? (j.user.upcoming as UpcomingPrep[]) : []); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [userId, intelInsights]);
  const shown = (items ?? []).filter((u) => (u.insights.length || u.records.length) && (!matterFilter || u.event.matterId === matterFilter));
  if (!shown.length) return null;
  return (
    <Section id="upcoming-prep" title={<T k="home.section.prepare" />} count={shown.length} description={<T k="home.section.prepareDesc" />} actions={<Link href="/?section=calendar" className="text-[11.5px] text-muted-foreground hover:text-foreground"><T k="home.section.calendar" /></Link>}>
      <ul className="divide-y divide-line-quiet">
        {withLinks(shown.slice(0, 4)).map(({ u, link }) => {
          return (
            <li key={u.event.id} className="flex min-h-8 items-center gap-3 px-1 py-1 text-[12.5px]">
              <span className="w-[52px] shrink-0 tabular text-[11.5px] text-muted-foreground">{fmtDate(u.event.startsAt, { month: "short", day: "numeric" })}</span>
              <Link href={`/?event=${u.event.id}`} className="min-w-0 flex-1 truncate hover:text-primary">{u.event.title}{u.matter ? <span className="text-muted-foreground"> · {u.matter.shortName}</span> : null}</Link>
              {link && <Link href={link.href} className="hidden min-w-0 max-w-[40%] truncate text-[11.5px] text-muted-foreground hover:text-foreground md:inline" title={link.title}>{link.title}</Link>}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

type PrepLink = { href: string; title: string };

/**
 * At most one link per event, and never the same link on two rows: a record specific to the event
 * first, then an insight not already shown. Rows without a distinct link show only the event.
 */
function withLinks(rows: UpcomingPrep[]): { u: UpcomingPrep; link: PrepLink | null }[] {
  const used = new Set<string>();
  return rows.map((u) => {
    const options: PrepLink[] = [
      ...u.records.map((r) => ({ href: `/intel/documents/${encodeURIComponent(r.id)}`, title: r.title })),
      ...u.insights.map((i) => ({ href: `/intel/insights?insight=${encodeURIComponent(i.id)}`, title: i.title })),
    ];
    const link = options.find((o) => !used.has(o.href)) ?? null;
    if (link) used.add(link.href);
    return { u, link };
  });
}
