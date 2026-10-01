"use client";
import * as React from "react";
import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ClaimVerdictView, ResearchSource } from "../engine/types";
import type { LaneView } from "./use-research";
import { useResearchActions } from "./research-context";
import { humanizeCitation } from "@/modules/law/shared";

/**
 * Research map: question → lanes → sources → claims they support. Pure SVG
 * (no layout library) so it renders instantly and never shifts the answer
 * column. Hovering a source lights up the answer sentences that cite it.
 */
export function MapPanel({ question, lanes, sources, verdicts }: { question: string; lanes: LaneView[]; sources: ResearchSource[]; verdicts: ClaimVerdictView[] }) {
  const a = useResearchActions();
  const shownSources = React.useMemo(() => sources.filter((s) => s.n != null || s.read).slice(0, 30).sort((x, y) => (x.n ?? 999) - (y.n ?? 999)), [sources]);
  const claims = React.useMemo(() => verdicts.filter((v) => v.sourceN != null).slice(0, 24), [verdicts]);
  const laneList = lanes.filter((l) => l.sourceIds.length > 0 || l.status !== "done");
  if (!question || (!laneList.length && !shownSources.length)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"><GitBranch className="size-5" /></span>
        <div className="text-sm font-medium">Research map</div>
        <div className="max-w-[260px] text-xs text-muted-foreground">Question → lanes → sources → the claims each source supports. Hover a node to see where the answer relies on it.</div>
      </div>
    );
  }

  const W = 360, ROW = 26, PAD = 12;
  const cols = { q: 14, lane: 100, src: 200, claim: 300 };
  const rows = Math.max(1, laneList.length, shownSources.length, claims.length);
  const H = Math.max(160, rows * ROW + PAD * 2);
  const yFor = (i: number, n: number) => (n <= 1 ? H / 2 : PAD + ROW / 2 + i * ((H - PAD * 2 - ROW) / (n - 1)));
  const laneY = new Map(laneList.map((l, i) => [l.lane.id, yFor(i, laneList.length)]));
  const srcY = new Map(shownSources.map((s, i) => [s.id, yFor(i, shownSources.length)]));
  const srcByN = new Map(shownSources.map((s) => [s.n, s]));
  const hoverId = a.hoverN != null ? srcByN.get(a.hoverN)?.id ?? null : a.hoverSourceId;
  const link = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;

  return (
    <div className="h-full overflow-auto p-2 scrollbar-thin">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img" aria-label="Research map">
        {/* question → lanes */}
        {laneList.map((l) => <path key={`ql-${l.lane.id}`} d={link(cols.q + 10, H / 2, cols.lane - 6, laneY.get(l.lane.id)!)} fill="none" className="stroke-border" strokeWidth={1} />)}
        {/* lanes → sources */}
        {shownSources.flatMap((s) => s.laneIds.filter((id) => laneY.has(id)).map((id) => {
          const hot = hoverId === s.id;
          return <path key={`ls-${id}-${s.id}`} d={link(cols.lane + 84, laneY.get(id)!, cols.src - 6, srcY.get(s.id)!)} fill="none" className={cn(hot ? "stroke-primary" : "stroke-border")} strokeWidth={hot ? 1.5 : 1} />;
        }))}
        {/* sources → claims */}
        {claims.map((c, i) => {
          const s = srcByN.get(c.sourceN!);
          if (!s || !srcY.has(s.id)) return null;
          const hot = hoverId === s.id;
          return <path key={`sc-${i}`} d={link(cols.src + 84, srcY.get(s.id)!, cols.claim - 6, yFor(i, claims.length))} fill="none" className={cn(hot ? "stroke-primary" : c.status === "supported" ? "stroke-success/50" : "stroke-warning/70")} strokeWidth={hot ? 1.5 : 1} strokeDasharray={c.status === "supported" ? undefined : "3 2"} />;
        })}

        {/* question node */}
        <g transform={`translate(${cols.q},${H / 2})`}>
          <circle r={7} className="fill-primary" />
          <title>{question}</title>
        </g>
        {/* lane nodes */}
        {laneList.map((l) => (
          <g key={l.lane.id} transform={`translate(${cols.lane},${laneY.get(l.lane.id)! - 9})`}>
            <rect width={84} height={18} rx={4} className={cn("fill-card", l.status === "done" ? "stroke-border" : "stroke-primary/50")} strokeWidth={1} />
            <text x={6} y={12.5} className="fill-foreground" fontSize={9.5}>{truncate(l.lane.name, 15)}</text>
            <title>{l.lane.name} · {l.sourceIds.length} sources</title>
          </g>
        ))}
        {/* source nodes */}
        {shownSources.map((s) => {
          const hot = hoverId === s.id;
          return (
            <g key={s.id} transform={`translate(${cols.src},${srcY.get(s.id)! - 9})`} className="cursor-pointer" onMouseEnter={() => { a.setHoverN(s.n ?? null); a.setHoverSourceId(s.id); }} onMouseLeave={() => { a.setHoverN(null); a.setHoverSourceId(null); }} onClick={() => a.openSource(s)}>
              <rect width={84} height={18} rx={4} className={cn(hot ? "fill-primary" : "fill-card", hot ? "stroke-primary" : s.read ? "stroke-border" : "stroke-warning/60")} strokeWidth={1} />
              <text x={5} y={12.5} className={cn(hot ? "fill-primary-foreground" : "fill-foreground")} fontSize={9.5}>{s.n != null ? `[${s.n}] ` : ""}{truncate(s.cite ?? s.title, s.n != null ? 11 : 14)}</text>
              <title>{s.title}{s.cite ? ` — ${humanizeCitation(s.cite)}` : ""}{s.read ? "" : " (not read)"}</title>
            </g>
          );
        })}
        {/* claim nodes */}
        {claims.map((c, i) => {
          const s = srcByN.get(c.sourceN!);
          const hot = s && hoverId === s.id;
          return (
            <g key={i} transform={`translate(${cols.claim},${yFor(i, claims.length) - 9})`} onMouseEnter={() => s && a.setHoverN(s.n ?? null)} onMouseLeave={() => a.setHoverN(null)}>
              <rect width={54} height={18} rx={9} className={cn(hot ? "fill-primary/15" : "fill-muted")} />
              <circle cx={9} cy={9} r={3} className={c.status === "supported" ? "fill-success" : c.status === "contradicted" ? "fill-destructive" : "fill-warning"} />
              <text x={16} y={12.5} className="fill-foreground" fontSize={9}>{truncate(c.claim, 7)}</text>
              <title>{c.claim} — {c.status}{c.quote ? `\n“${c.quote}”` : ""}</title>
            </g>
          );
        })}
        {/* column labels */}
        <text x={cols.q - 6} y={H - 2} fontSize={8} className="fill-muted-foreground">question</text>
        <text x={cols.lane} y={H - 2} fontSize={8} className="fill-muted-foreground">lanes</text>
        <text x={cols.src} y={H - 2} fontSize={8} className="fill-muted-foreground">sources</text>
        {claims.length > 0 && <text x={cols.claim} y={H - 2} fontSize={8} className="fill-muted-foreground">claims</text>}
      </svg>
    </div>
  );
}

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
