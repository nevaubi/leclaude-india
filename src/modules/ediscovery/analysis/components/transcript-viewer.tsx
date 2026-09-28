"use client";
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Flag, MessageSquareText, Paperclip, Highlighter, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tip } from "@/components/ui/tooltip";
import type { DepositionQA } from "@/lib/types/domain";
import { QA_FLAGS, formatPageLine, type Designation, type QAFlag } from "../types";
import { highlightTerms, inRange } from "../transcript";
import { FLAG_STYLES, FlagBadge, ObjectionBadge } from "./shared";
import { segmentLabel } from "../../india";
import type { IndiaQA } from "../india-deposition";

/** Exhibit chip text: Indian marks ("Ex.P7", "M.O.2") are shown as recorded; other ids get the "Ex." prefix. */
function exhibitChip(ref: string) {
  return /^(?:Ex\.|M\.O\.)/i.test(ref) ? ref : `Ex. ${ref}`;
}

export interface TranscriptViewerProps {
  transcript: DepositionQA[];
  activeIndex: number;
  onActiveIndex: (i: number) => void;
  query?: string;
  flagFilter?: QAFlag | null;
  designations: Designation[];
  selection?: { start?: { page: number; line: number }; end?: { page: number; line: number } };
  designating?: boolean;
  onPickBoundary?: (qa: DepositionQA, index: number) => void;
  onToggleFlag: (index: number, flag: QAFlag) => void;
  onSaveNote: (index: number, note: string) => void;
  onOpenExhibit?: (ref: string) => void;
  exhibitDocIds?: Record<string, string | undefined>;
  className?: string;
}

function Highlighted({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <>{text}</>;
  const parts = text.split(re);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="rounded-sm bg-warning/40 px-px text-foreground">{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>))}</>;
}

export function TranscriptViewer(props: TranscriptViewerProps) {
  const { transcript, activeIndex, onActiveIndex, query, flagFilter, designations, selection, designating, onPickBoundary, onToggleFlag, onSaveNote, onOpenExhibit, exhibitDocIds } = props;
  const parentRef = React.useRef<HTMLDivElement>(null);
  const re = React.useMemo(() => (query ? highlightTerms(query) : null), [query]);
  const rows = React.useMemo(() => transcript.map((qa, index) => ({ qa, index })).filter(({ qa }) => !flagFilter || qa.flags?.includes(flagFilter)), [transcript, flagFilter]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 132, overscan: 8, getItemKey: (i) => rows[i].index });

  React.useEffect(() => {
    const pos = rows.findIndex((r) => r.index === activeIndex);
    if (pos >= 0) virtualizer.scrollToIndex(pos, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const rangeMark = (qa: DepositionQA) => {
    const inDesignation = designations.find((d) => inRange(qa.page, qa.line, d));
    const s = selection?.start;
    const e = selection?.end;
    const inSel = s && e ? inRange(qa.page, qa.line, { startPage: Math.min(s.page, e.page), startLine: s.page === e.page ? Math.min(s.line, e.line) : s.page < e.page ? s.line : e.line, endPage: Math.max(s.page, e.page), endLine: s.page === e.page ? Math.max(s.line, e.line) : s.page > e.page ? s.line : e.line }) : s && qa.page === s.page && qa.line === s.line;
    return { inDesignation, inSel: !!inSel };
  };

  return (
    <div ref={parentRef} className={cn("relative h-full overflow-auto scrollbar-thin bg-background", props.className)} role="list" aria-label="Transcript">
      {!rows.length && <div className="p-8 text-center text-sm text-muted-foreground">{flagFilter ? `No testimony flagged “${FLAG_STYLES[flagFilter].label}”.` : "No transcript."}</div>}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((v) => {
          const { qa, index } = rows[v.index];
          const iq = qa as IndiaQA;
          const prevSeg = v.index > 0 ? (rows[v.index - 1].qa as IndiaQA).segment : undefined;
          const segHeader = iq.segment && iq.segment !== prevSeg ? `${segmentLabel(iq.segment)}${iq.segment === "chief" && iq.para ? " (affidavit, Order XVIII Rule 4 CPC)" : ""}${iq.by ? ` · by ${iq.by}` : ""}` : null;
          const statementOnly = !!iq.segment && !qa.question;
          const active = index === activeIndex;
          const { inDesignation, inSel } = rangeMark(qa);
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              role="listitem"
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
              onClick={() => { onActiveIndex(index); if (designating) onPickBoundary?.(qa, index); }}
              className={cn("group grid cursor-pointer grid-cols-[64px_1fr] border-b transition-colors", active ? "bg-accent/60" : "hover:bg-accent/30", inSel && "bg-primary/8", designating && "cursor-crosshair")}
            >
              {segHeader && <div className="col-span-2 border-b bg-muted/50 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{segHeader}</div>}
              <div className={cn("relative flex flex-col items-end gap-1 border-r px-2 py-2 font-mono text-[10.5px] text-muted-foreground tabular", inDesignation && "border-r-2 border-r-chart-2")}>
                <span className={cn(active && "font-semibold text-foreground")}>{formatPageLine(qa.page, qa.line)}</span>
                {iq.para != null && <span className="text-[10px]">¶{iq.para}</span>}
                {inDesignation && <Tip label={`Designated ${inDesignation.purpose}`}><span><Highlighter className="size-3 text-chart-2" /></span></Tip>}
                {designating && <span className="text-[10.5px] text-primary">{selection?.start && !selection.end ? "end" : "start"}</span>}
              </div>
              <div className="min-w-0 px-3 py-2">
                {!statementOnly && (
                  <div className="flex items-start gap-2">
                    <span className="mt-px shrink-0 select-none font-semibold text-[12px] text-muted-foreground">Q.</span>
                    <p className="min-w-0 flex-1 text-[13px] leading-relaxed"><Highlighted text={qa.question} re={re} /></p>
                  </div>
                )}
                {qa.objection && (
                  <div className="ml-6 mt-1.5 flex flex-wrap items-start gap-1.5 rounded-md border border-dashed bg-muted/40 px-2 py-1 text-[12px] italic text-muted-foreground">
                    <span className="not-italic font-medium text-foreground/80">{qa.objection.by.toUpperCase()}:</span>
                    <span>Objection.</span>
                    <ObjectionBadge basis={qa.objection.basis} by={qa.objection.by} className="not-italic" />
                    {qa.objection.text && <span className="basis-full"><Highlighted text={qa.objection.text} re={re} /></span>}
                  </div>
                )}
                <div className={cn("flex items-start gap-2", !statementOnly && "mt-1.5")}>
                  <span className="mt-px w-4 shrink-0 select-none font-semibold text-[12px] text-muted-foreground">{statementOnly ? "" : "A."}</span>
                  <p className={cn("min-w-0 flex-1 text-[13px] leading-relaxed", qa.flags?.includes("admission") && "font-medium")}><Highlighted text={qa.answer} re={re} /></p>
                </div>
                <div className="mt-1.5 flex min-h-[18px] flex-wrap items-center gap-1 pl-6">
                  {qa.exhibit && (
                    <button type="button" onClick={(e) => { e.stopPropagation(); onOpenExhibit?.(qa.exhibit!); }} className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[10.5px] leading-4 transition-colors", exhibitDocIds?.[qa.exhibit] ? "cursor-pointer border-foreground/25 bg-accent text-foreground hover:bg-accent" : "border-border bg-muted text-muted-foreground")} title={exhibitDocIds?.[qa.exhibit] ? "Open the exhibit in the review viewer" : "Exhibit not in this workspace"}>
                      <Paperclip className="size-3" /> {exhibitChip(qa.exhibit)}
                    </button>
                  )}
                  {qa.flags?.map((f) => <FlagBadge key={f} flag={f} />)}
                  {qa.note && <span className="inline-flex items-center gap-1 rounded bg-warning/15 px-1.5 py-px text-[10.5px] leading-4 text-foreground/80" title={qa.note}><MessageSquareText className="size-3" /> note</span>}
                  <span className="flex-1" />
                  <FlagMenu qa={qa} index={index} onToggleFlag={onToggleFlag} onSaveNote={onSaveNote} />
                </div>
                {qa.note && <div className="ml-6 mt-1 rounded-md bg-warning/10 px-2 py-1 text-[12px] text-foreground/80"><span className="font-medium">Note:</span> {qa.note}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FlagMenu({ qa, index, onToggleFlag, onSaveNote }: { qa: DepositionQA; index: number; onToggleFlag: (i: number, f: QAFlag) => void; onSaveNote: (i: number, note: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState(qa.note ?? "");
  React.useEffect(() => { if (open) setNote(qa.note ?? ""); }, [open, qa.note]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className={cn("inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[10.5px] text-muted-foreground transition-opacity hover:bg-accent hover:text-accent-foreground cursor-pointer", open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")} aria-label="Flag testimony">
          <Flag className="size-3" /> Flag
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 px-1 text-[12px] font-medium text-muted-foreground">Flags</div>
        <div className="grid grid-cols-1 gap-0.5">
          {QA_FLAGS.map((f) => {
            const on = qa.flags?.includes(f.id);
            const s = FLAG_STYLES[f.id];
            const Icon = s.icon;
            return (
              <button key={f.id} type="button" onClick={() => onToggleFlag(index, f.id)} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent cursor-pointer", on && "bg-accent/70")} title={f.hint}>
                <span className={cn("flex size-5 items-center justify-center rounded border", s.cls)}><Icon className="size-3" /></span>
                <span className="flex-1">{f.label}</span>
                {on && <Check className="size-3.5 text-primary" />}
              </button>
            );
          })}
        </div>
        <div className="mt-2 border-t pt-2">
          <div className="mb-1 px-1 text-[12px] font-medium text-muted-foreground">Note</div>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Why this matters, what to confront it with…" className="text-xs" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { onSaveNote(index, note); setOpen(false); } }} />
          <div className="mt-1.5 flex justify-end gap-1">
            {qa.note && <Button size="xs" variant="ghost" onClick={() => { onSaveNote(index, ""); setOpen(false); }}>Clear</Button>}
            <Button size="xs" onClick={() => { onSaveNote(index, note); setOpen(false); }}>Save note</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
