"use client";
import * as React from "react";
import { T } from "@/lib/i18n/client";
import Link from "next/link";
import { TrustBadge } from "@/components/ai/trust-badge";
import { useHome } from "./home-provider";
import { Section } from "./shared";
import { INSIGHT_KIND_LABEL, parseInsights, type ForYouInsight } from "./for-you-model";

export { parseInsights, type ForYouInsight } from "./for-you-model";

/**
 * "For you": personalised, source-backed insights from the intelligence layer.
 * Renders nothing until GET /api/intel/insights exists and returns rows, so the
 * overview stays quiet before the intel round lands.
 */
export function ForYouSection() {
  const { userId, matterFilter, matterById, intelInsights } = useHome();
  const [items, setItems] = React.useState<ForYouInsight[] | null>(null);
  React.useEffect(() => {
    if (!intelInsights) { setItems([]); return; }
    let alive = true;
    const qs = new URLSearchParams({ userId, limit: "6", status: "published" });
    if (matterFilter) qs.set("matterId", matterFilter);
    fetch(`/api/intel/insights?${qs}`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive) setItems(j ? parseInsights(j) : []); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [userId, matterFilter, intelInsights]);
  if (!items || items.length === 0) return null;
  return (
    <Section id="for-you" title={<T k="home.section.forYou" />} count={items.length} description={<T k="home.section.forYouDesc" />} actions={<Link href="/intel" className="text-[11px] text-muted-foreground hover:text-primary"><T k="home.section.intelligence" /></Link>}>
      <ul className="divide-y divide-line-quiet">
        {items.map((it) => {
          const matter = matterById(it.scope?.matterId);
          const body = (
            <>
              <span className="w-[76px] shrink-0 text-[11.5px] text-muted-foreground">{INSIGHT_KIND_LABEL[it.kind ?? ""] ?? it.kind ?? "Insight"}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{it.title}</span>
                {it.summary && <span className="block truncate text-[11.5px] text-muted-foreground">{it.summary}</span>}
              </span>
              {matter && <span className="hidden shrink-0 text-[11px] text-muted-foreground lg:inline">{matter.shortName}</span>}
              <TrustBadge provenance={it.provenance} compact />
            </>
          );
          const cls = "flex min-h-[34px] w-full items-center gap-3 px-1 py-1 text-left hover:bg-accent/40";
          return <li key={it.id}>{it.href ? <Link href={it.href} className={cls}>{body}</Link> : <Link href={`/intel?insight=${encodeURIComponent(it.id)}`} className={cls}>{body}</Link>}</li>;
        })}
      </ul>
    </Section>
  );
}
