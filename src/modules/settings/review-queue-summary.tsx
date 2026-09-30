"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, Loader2, RefreshCw, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CountChip, EmptyState } from "@/components/ui/misc";
import type { ReviewQueueItem } from "@/lib/integrity/types";
import { isEndpointMissing, summarizeByMatter } from "@/modules/ediscovery/components/review-queue-helpers";
import { SettingsBlock } from "./settings-section";
import { FEATURES, matterHref } from "@/lib/features";

/**
 * Settings → Integrity → Review queue. Pending AI records grouped by matter,
 * each linking to that matter's "Needs review" section in E-Discovery.
 */
export function ReviewQueueSummary({ matters }: { matters: { id: string; shortName: string }[] }) {
  const [items, setItems] = React.useState<ReviewQueueItem[] | null>(null);
  const [state, setState] = React.useState<"loading" | "ok" | "missing" | "error">("loading");
  const load = React.useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch("/api/integrity/review?status=pending&limit=200", { cache: "no-store" });
      if (!res.ok) { setState(res.status === 404 || res.status === 405 ? "missing" : "error"); setItems([]); return; }
      const j = (await res.json()) as { items?: ReviewQueueItem[] };
      setItems(Array.isArray(j.items) ? j.items : []);
      setState("ok");
    } catch (e) { setState(isEndpointMissing(e) ? "missing" : "error"); setItems([]); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const nameOf = React.useCallback((id: string | undefined) => matters.find((m) => m.id === id)?.shortName, [matters]);
  const rows = React.useMemo(() => summarizeByMatter(items ?? [], nameOf), [items, nameOf]);
  const total = items?.length ?? 0;
  return (
    <SettingsBlock
      id="review"
      title={<span className="inline-flex items-center gap-1.5">Review queue {total > 0 && <CountChip tone="warning">{total}</CountChip>}</span>}
      description="AI-produced records awaiting a human decision: below the confidence gate, contradicted by their sources, or not source-backed. Approve or reject them inside the matter."
      actions={<Button size="icon-xs" variant="ghost" onClick={() => void load()} disabled={state === "loading"} aria-label="Refresh">{state === "loading" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}</Button>}
    >
      {state === "loading" && !items ? (
        <div className="text-[11.5px] text-muted-foreground">Loading…</div>
      ) : state === "missing" ? (
        <EmptyState compact icon={ShieldCheck} title="Review endpoint not available" description="/api/integrity/review is not deployed in this environment." />
      ) : state === "error" ? (
        <EmptyState compact icon={ShieldQuestion} title="Could not load the review queue" action={<Button size="xs" variant="outline" onClick={() => void load()}>Try again</Button>} />
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><span className="size-1.5 rounded-full bg-success" aria-hidden />Nothing waiting for review. Every AI record is verified or has a human decision.</div>
      ) : (
        <ul className="divide-y divide-line-quiet">
          {rows.map((r) => (
            <li key={r.matterId ?? "firm"} className="flex h-8 items-center gap-3 text-[12px]">
              <span className="w-8 shrink-0 text-right tabular font-medium text-warning-foreground dark:text-warning">{r.pending}</span>
              <div className="min-w-0 flex-1 truncate"><span className="font-medium">{r.matterName}</span><span className="ml-2 text-[11px] text-muted-foreground">{r.kinds.join(" · ")}</span></div>
              {r.matterId && FEATURES.ediscovery ? (
                <Button asChild size="xs" variant="ghost"><Link href={`/ediscovery?matter=${encodeURIComponent(r.matterId)}&tab=codes&view=review`}>Open queue <ArrowRight className="size-3" /></Link></Button>
              ) : r.matterId ? (
                <Button asChild size="xs" variant="ghost"><Link href={matterHref(r.matterId)}>Open matter <ArrowRight className="size-3" /></Link></Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">firm-wide records</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsBlock>
  );
}
