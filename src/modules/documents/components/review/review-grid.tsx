"use client";
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, FileText, Loader2, Split } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DocReview, DocReviewRow, IssueAssessment, PrivilegeFlag, ReviewCell, ReviewColumn } from "../../review-types";
import { cellView, codingView, rankedIssues, RELEVANCE_LABEL } from "./review-helpers";

const ROW_H = 34;
const HEAD_H = 32;

export type GridColumnId = "file" | "docType" | "importance" | "issues" | "privilege" | "coding" | `col:${string}`;
export interface GridSelection { fileId: string; column: GridColumnId }

interface GridCol { id: GridColumnId; header: string; title?: string; width: number; sticky?: boolean; align?: "right" }

function widthFor(c: ReviewColumn): number {
  if (c.kind === "yes_no") return 110;
  if (c.kind === "date" || c.kind === "amount" || c.kind === "choice") return 150;
  return 200;
}

export function gridColumns(review: DocReview): GridCol[] {
  return [
    { id: "file", header: "File", width: 260, sticky: true },
    { id: "docType", header: "Doc type", width: 150 },
    { id: "importance", header: "Importance", title: "Model's 1–5 estimate of how important the document is (5 = likely key document)", width: 96 },
    { id: "issues", header: "Issues", title: "Relevance to the review's issues, strongest first", width: 290 },
    { id: "privilege", header: "Privilege", title: "Privilege screen (a suggestion; never decides privilege)", width: 104 },
    ...review.columns.map((c): GridCol => ({ id: `col:${c.id}`, header: c.label, title: c.prompt, width: widthFor(c) })),
    { id: "coding", header: "Coding", title: "Reviewer's decision", width: 150 },
  ];
}

/**
 * Rows = files, columns = File | Doc type | Importance | Issues | Privilege | review columns | Coding. Virtualised rows,
 * sticky header and first column, horizontal scroll inside the panel. Cells show found values normally, unverified
 * values muted with a marker, and "not stated" as an em dash.
 */
export function ReviewGrid({ review, rows, total, more, loading, refreshing, selection, onSelect, onEndReached, empty, scrollToFileId }: {
  review: DocReview; rows: DocReviewRow[]; total: number; more: boolean; loading: boolean; refreshing: boolean;
  selection: GridSelection | null; onSelect: (s: GridSelection) => void; onEndReached: () => void; empty: React.ReactNode; scrollToFileId: string | null;
}) {
  const cols = React.useMemo(() => gridColumns(review), [review]);
  const colById = React.useMemo(() => new Map(review.columns.map((c) => [c.id, c])), [review.columns]);
  const issueLabel = React.useMemo(() => new Map(review.issues.map((i) => [i.id, i.label])), [review.issues]);
  const issueOrder = React.useMemo(() => review.issues.map((i) => i.id), [review.issues]);
  const totalWidth = cols.reduce((n, c) => n + c.width, 0);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 12 });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1].index : -1;
  React.useEffect(() => { if (more && lastIndex >= rows.length - 25) onEndReached(); }, [lastIndex, more, onEndReached, rows.length]);

  // Keep the active row in view when it moves by keyboard.
  React.useEffect(() => {
    if (!scrollToFileId) return;
    const i = rows.findIndex((r) => r.fileId === scrollToFileId);
    if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [scrollToFileId, rows, virtualizer]);

  return (
    <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto scrollbar-thin" role="grid" aria-label="Review grid" aria-rowcount={total + 1} aria-colcount={cols.length} aria-busy={loading || refreshing}>
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        <div role="row" className="sticky top-0 z-20 flex border-b bg-background" style={{ height: HEAD_H, width: totalWidth, minWidth: "100%" }}>
          {cols.map((c) => (
            <div key={c.id} role="columnheader" title={c.title} style={{ width: c.width }}
              className={cn("flex shrink-0 items-center border-r px-2 text-[11.5px] font-medium text-muted-foreground last:border-r-0", c.sticky && "sticky left-0 z-10 bg-background shadow-[1px_0_0_var(--border)]")}>
              <span className="truncate">{c.header}</span>
              {c.sticky && refreshing && <Loader2 className="ms-auto size-3 animate-spin" aria-label="Refreshing" />}
            </div>
          ))}
        </div>
        {loading ? (
          <div className="space-y-px p-0" aria-busy="true">
            {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-[34px] animate-pulse border-b bg-muted/40" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="sticky left-0 w-full max-w-[100vw]">{empty}</div>
        ) : (
          <div className="relative" style={{ height: virtualizer.getTotalSize() + (more ? ROW_H : 0) }}>
            {items.map((vi) => {
              const row = rows[vi.index];
              const rowSelected = selection?.fileId === row.fileId;
              return (
                <div key={row.fileId} role="row" aria-rowindex={vi.index + 2} aria-selected={rowSelected}
                  className={cn("group absolute left-0 flex border-b text-[12.5px]", rowSelected ? "bg-accent/70" : "bg-background hover:bg-accent/40", hasEarlierValues(row) && "[&>[role=gridcell]:not(:first-child)]:opacity-60")}
                  style={{ height: ROW_H, width: totalWidth, minWidth: "100%", transform: `translateY(${vi.start}px)` }}>
                  {cols.map((c) => {
                    const active = rowSelected && selection?.column === c.id;
                    return (
                      <div key={c.id} role="gridcell" aria-selected={active} tabIndex={-1} style={{ width: c.width }}
                        onClick={() => onSelect({ fileId: row.fileId, column: c.id })}
                        className={cn("flex shrink-0 cursor-pointer items-center overflow-hidden border-r px-2 last:border-r-0",
                          c.sticky && cn("sticky left-0 z-[5] shadow-[1px_0_0_var(--border)]", rowSelected ? "bg-accent" : "bg-background group-hover:bg-accent"),
                          active && "outline outline-1 -outline-offset-1 outline-ring")}>
                        {renderCell(c.id, row, colById, issueLabel, issueOrder)}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {more && (
              <div className="absolute left-0 flex items-center gap-2 px-3 text-[12px] text-muted-foreground" style={{ top: virtualizer.getTotalSize(), height: ROW_H }}>
                <Loader2 className="size-3.5 animate-spin" /> Loading more…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A pending row with values from an earlier run (columns/issues edited since) shows them dimmed until it is re-run. */
export const hasEarlierValues = (row: DocReviewRow) => row.status === "pending" && Object.keys(row.cells ?? {}).length > 0;

function renderCell(id: GridColumnId, row: DocReviewRow, colById: Map<string, ReviewColumn>, issueLabel: Map<string, string>, issueOrder: string[]): React.ReactNode {
  const pending = row.status === "pending" && !hasEarlierValues(row);
  // Failed rows carry no values: their cells stay blank (the File cell says why), never an em dash ("not stated").
  if (row.status === "failed" && id !== "file" && id !== "coding") return null;
  switch (id) {
    case "file": return <FileCell row={row} />;
    case "docType": return pending ? <Pending /> : row.docType ? <span className="truncate" title={row.docType}>{row.docType}</span> : <Dash />;
    case "importance": return pending ? <Pending /> : <Importance value={row.importance} />;
    case "issues": return pending ? <Pending /> : <IssueChips issues={rankedIssues(row, issueOrder)} labels={issueLabel} />;
    case "privilege": return pending ? <Pending /> : <PrivilegeMark flag={row.privilege?.flag ?? null} />;
    case "coding": return <CodingMark row={row} />;
    default: {
      if (pending) return <Pending />;
      const colId = id.slice(4);
      return <CellValue cell={row.cells[colId]} label={colById.get(colId)?.label} />;
    }
  }
}

function Pending() { return <span className="text-[11.5px] text-muted-foreground/70">Pending</span>; }
function Dash() { return <span className="text-muted-foreground" aria-label="Not stated">—</span>; }

function FileCell({ row }: { row: DocReviewRow }) {
  const partialCoverage = row.status === "partial" || (row.coverage.total > 0 && row.coverage.read < row.coverage.total);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-foreground" title={row.fileName}>{row.fileName}</span>
      {row.status === "failed" && <Tip label={row.error ? `Review failed: ${row.error}` : "Review failed for this file"}><span className="shrink-0 text-[11px] font-medium text-destructive">Failed</span></Tip>}
      {row.status !== "failed" && partialCoverage && (
        <Tip label={partlyReadText(row)}>
          <span className="shrink-0 text-[11px] text-warning-foreground dark:text-warning">Partly read</span>
        </Tip>
      )}
      {hasEarlierValues(row) && <Tip label="Columns or issues changed since this file was reviewed. The values shown are from the earlier run until it is re-run."><span className="shrink-0 text-[11px] text-muted-foreground">Re-run pending</span></Tip>}
      {row.decisionStale && <span className="sr-only">Coding is stale</span>}
    </span>
  );
}

/** Why a row is partly read: scanned pages awaiting OCR and/or the per-file length cap. */
export function partlyReadText(row: DocReviewRow): string {
  const unread = row.coverage.unreadPages ?? [];
  const parts: string[] = [];
  if (unread.length) parts.push(`${unread.length} scanned page${unread.length === 1 ? "" : "s"} with no text yet (${unread.slice(0, 8).join(", ")}${unread.length > 8 ? "…" : ""}); read them with OCR in Files`);
  if (row.coverage.total > 0 && row.coverage.read < row.coverage.total) parts.push(`the review read ${Math.round((row.coverage.read / row.coverage.total) * 100)}% of the file's text (length limit)`);
  return `Partly read: ${parts.join("; ") || "part of the file could not be read"}.`;
}

function Importance({ value }: { value: number | null }) {
  if (value == null) return <Dash />;
  const v = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span className="flex items-center gap-1.5" aria-label={`Importance ${v} of 5`} title={`Importance ${v} of 5`}>
      <span className="flex gap-[2px]" aria-hidden>{[1, 2, 3, 4, 5].map((n) => <span key={n} className={cn("h-2.5 w-1 rounded-[1px]", n <= v ? (v >= 4 ? "bg-foreground/80" : "bg-muted-foreground/70") : "bg-muted")} />)}</span>
      <span className="tabular text-[11.5px] text-muted-foreground">{v}</span>
    </span>
  );
}

const REL_DOT: Record<string, string> = { high: "bg-primary", medium: "bg-warning", low: "bg-muted-foreground/45" };

function IssueChips({ issues, labels }: { issues: IssueAssessment[]; labels: Map<string, string> }) {
  if (!issues.length) return <Dash />;
  const shown = issues.slice(0, 2);
  const rest = issues.length - shown.length;
  return (
    <span className="flex min-w-0 items-center gap-1" title={issues.map((i) => `${labels.get(i.issueId) ?? "Issue"}: ${RELEVANCE_LABEL[i.relevance]}`).join("\n")}>
      {shown.map((i) => (
        <span key={i.issueId} className="inline-flex h-5 min-w-0 max-w-[124px] items-center gap-1 rounded-[var(--radius-chip)] bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
          <span className={cn("size-1.5 shrink-0 rounded-full", REL_DOT[i.relevance])} aria-hidden />
          <span className="truncate">{labels.get(i.issueId) ?? "Issue"}</span>
          <span className="sr-only"> ({RELEVANCE_LABEL[i.relevance]})</span>
        </span>
      ))}
      {rest > 0 && <span className="shrink-0 text-[11px] tabular text-muted-foreground">+{rest}</span>}
    </span>
  );
}

export function PrivilegeMark({ flag }: { flag: PrivilegeFlag | null }) {
  if (!flag || flag === "none") return <Dash />;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]">
      <span className={cn("size-1.5 shrink-0 rounded-full", flag === "likely" ? "bg-destructive" : "bg-warning")} aria-hidden />
      <span className={flag === "likely" ? "text-foreground" : "text-muted-foreground"}>{flag === "likely" ? "Likely" : "Possible"}</span>
    </span>
  );
}

function CodingMark({ row }: { row: DocReviewRow }) {
  const v = codingView(row);
  if (!v) return <span className="text-[11.5px] text-muted-foreground/70">Uncoded</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cn("truncate", v.stale ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-foreground")}>{v.label}</span>
      {v.stale && (
        <Tip label="Coded on an earlier version of this row; the review has re-run since. Check and code again.">
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-warning-foreground dark:text-warning"><AlertTriangle className="size-3" aria-hidden />Stale</span>
        </Tip>
      )}
    </span>
  );
}

export function CellValue({ cell, label }: { cell: ReviewCell | undefined; label?: string }) {
  const v = cellView(cell);
  if (v.kind === "empty") return null;
  if (v.kind === "not_stated") return <span className="text-muted-foreground" aria-label={`${label ?? "Value"}: not stated in the document`} title="Not stated in the document">—</span>;
  if (v.kind === "not_read") {
    return (
      <Tip label="Not found in the part of the file that was read; some pages were not read (scanned pages awaiting OCR, or past the length limit).">
        <span className="text-[11.5px] italic text-muted-foreground">Not read</span>
      </Tip>
    );
  }
  if (v.conflict) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate" title={v.text}>{v.text}</span>
        <Tip label={`Conflicting values: ${v.alternatives + 1} different values appear in different parts of the file. Review before relying on it.`}>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-warning-foreground dark:text-warning" aria-label="Conflicting values"><Split className="size-3" />{v.alternatives + 1}</span>
        </Tip>
      </span>
    );
  }
  if (v.quoteFound) return <span className="truncate" title={v.text}>{v.text}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate text-muted-foreground" title={v.text}>{v.text}</span>
      <Tip label="The quote does not support this value, or was not found in the file">
        <span className="inline-flex shrink-0 text-warning-foreground dark:text-warning" aria-label="The quote does not support this value, or was not found in the file"><AlertTriangle className="size-3" /></span>
      </Tip>
    </span>
  );
}
