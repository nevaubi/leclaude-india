"use client";
import * as React from "react";
import { AlertTriangle, BookOpen, Check, FileText, Loader2, RotateCcw, TableProperties } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Inspector } from "@/components/ui/inspector";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { CODING_LABEL, type Coding, type DocReview, type DocReviewRow, type ReviewCell, type ReviewColumn, type ReviewEvidence } from "../../review-types";
import { formatPreciseDate } from "../format";
import { Notice } from "../notice";
import type { ViewerTarget } from "../text-viewer";
import { CellValue, hasEarlierValues, partlyReadText, PrivilegeMark } from "./review-grid";
import { CODING_KEYS, KIND_LABEL, RELEVANCE_LABEL, rankedIssues } from "./review-helpers";

export interface CodingDraft { coding: Coding | null; issues: string[]; note: string | null }

const W = 380;

function openTarget(row: DocReviewRow, ev: ReviewEvidence | null): ViewerTarget {
  return { fileId: row.fileId, page: ev?.page ?? null, highlight: ev?.quote || null, name: row.fileName };
}

/** Quote + page + whether the quote was found in the file, for one piece of evidence, with "Open at page". */
function Evidence({ ev, row, onView, compact }: { ev: ReviewEvidence; row: DocReviewRow; onView: (t: ViewerTarget) => void; compact?: boolean }) {
  if (!ev.quote) return null;
  return (
    <div className={cn("space-y-1", compact ? "mt-1" : "mt-1.5")}>
      <blockquote className={cn("border-l-2 pl-2.5 text-[12px] italic leading-snug", ev.quoteFound ? "text-muted-foreground" : "border-warning/60 text-muted-foreground/80")}>“{ev.quote}”</blockquote>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]">
        {ev.quoteFound
          ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Check className="size-3" /> Quote found in the file text</span>
          : <span className="inline-flex items-center gap-1 font-medium text-warning-foreground dark:text-warning"><AlertTriangle className="size-3" /> Quote not found in the file text</span>}
        <button type="button" onClick={() => onView(openTarget(row, ev))} className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          <BookOpen className="size-3" /> {ev.page != null ? `Open at page ${ev.page}` : "Open file"}
        </button>
      </div>
    </div>
  );
}

function cellStatusText(cell: ReviewCell | undefined): { text: string; tone: "muted" | "warning" } {
  if (!cell) return { text: "This file has not been reviewed yet.", tone: "muted" };
  if (cell.status === "not_stated") return { text: "The document does not state this.", tone: "muted" };
  if (cell.status === "not_read") return { text: "Not found in the part of the file that was read. Some pages were not read (scanned pages awaiting OCR, or past the length limit), so the file may still state it.", tone: "warning" };
  if (cell.status === "conflict") return { text: "Different parts of the file give different values. Each is listed below with its page; decide which applies.", tone: "warning" };
  if (cell.status === "unverified" && cell.quoteFound) return { text: "The quote is in the file, but it does not contain or support this value. Check the page before relying on it.", tone: "warning" };
  if (cell.status === "unverified" || !cell.quoteFound) return { text: "The quote was not found in the stored text of this file. Check the page before relying on this value.", tone: "warning" };
  return { text: "Value taken from a quote found in the file text.", tone: "muted" };
}

// ---- cell ----------------------------------------------------------------------------------------------------------

export function CellInspector({ row, column, onClose, onRow, onView }: { row: DocReviewRow; column: ReviewColumn; onClose: () => void; onRow: () => void; onView: (t: ViewerTarget) => void }) {
  const cell = row.cells[column.id];
  const earlier = hasEarlierValues(row);
  const pendingNoValues = row.status === "pending" && !earlier;
  const st = cellStatusText(pendingNoValues ? undefined : cell);
  return (
    <Inspector title={column.label} subtitle={row.fileName} icon={TableProperties} onClose={onClose} closeShortcut="Esc" width={W} ariaLabel="Cell details"
      actions={<Button size="xs" variant="ghost" onClick={onRow}>File details</Button>}>
      <div className="space-y-3 px-3 py-3">
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">{KIND_LABEL[column.kind] ?? column.kind} · {column.prompt}</div>
          <div className="text-[14px] leading-snug">{pendingNoValues ? <span className="text-muted-foreground">Pending</span> : cell?.value && cell.status !== "not_stated" && cell.status !== "not_read"
            ? <span className={cn("whitespace-pre-wrap break-words", cell.status === "unverified" && "text-muted-foreground")}>{cell.value}</span>
            : <CellValue cell={cell} label={column.label} />}</div>
          {earlier && <p className="text-[11.5px] text-muted-foreground">From the earlier run; this file is pending a re-run after the columns or issues changed.</p>}
        </div>
        <p className={cn("text-[12px] leading-snug", st.tone === "warning" ? "text-warning-foreground dark:text-warning" : "text-muted-foreground")}>{st.text}</p>
        {cell && cell.status !== "not_stated" && cell.status !== "not_read" && <Evidence ev={cell} row={row} onView={onView} />}
        {cell?.status === "conflict" && (cell.alternatives?.length ?? 0) > 0 && (
          <section className="space-y-2" aria-label="Other values in the file">
            <h3 className="text-[11.5px] font-medium text-muted-foreground">Other values in the file</h3>
            {cell.alternatives!.map((a, i) => (
              <div key={i}>
                <div className="text-[12.5px] leading-snug">{a.value}</div>
                <Evidence ev={a} row={row} onView={onView} compact />
              </div>
            ))}
          </section>
        )}
        {(cell?.status === "not_stated" || cell?.status === "not_read") && <Button size="xs" variant="outline" onClick={() => onView(openTarget(row, null))}><FileText className="size-3.5" /> Open file</Button>}
      </div>
    </Inspector>
  );
}

// ---- row ------------------------------------------------------------------------------------------------------------

export function RowInspector({ row, review, onClose, onView, onCode, saving, conflict, onReload, error, onOpenFiles }: {
  row: DocReviewRow; review: DocReview; onClose: () => void; onView: (t: ViewerTarget) => void; onOpenFiles?: () => void;
  onCode: (d: CodingDraft) => void; saving: boolean; conflict: boolean; onReload: () => void; error: string | null;
}) {
  const issueLabel = new Map(review.issues.map((i) => [i.id, i.label]));
  const ranked = rankedIssues(row, review.issues.map((i) => i.id));
  const notRelevant = row.issues.filter((i) => i.relevance === "none");
  const earlier = hasEarlierValues(row);
  const done = row.status === "done" || row.status === "partial" || earlier;
  const partialCoverage = row.status === "partial" || (row.coverage.total > 0 && row.coverage.read < row.coverage.total);
  return (
    <Inspector title={row.fileName} subtitle={[row.docType, row.pages ? `${row.pages} page${row.pages === 1 ? "" : "s"}` : null, row.status === "pending" ? "Not reviewed yet" : row.status === "failed" ? "Review failed" : null].filter(Boolean).join(" · ")}
      icon={FileText} onClose={onClose} closeShortcut="Esc" width={W} ariaLabel="File review details"
      actions={<Button size="xs" variant="ghost" onClick={() => onView(openTarget(row, null))}>Open file</Button>}>
      <div className="divide-y">
        <CodingControl key={`${row.fileId}:${row.rowHash ?? ""}:${row.decision?.at ?? ""}`} row={row} review={review} onCode={onCode} saving={saving} conflict={conflict} onReload={onReload} error={error} />
        {row.status === "failed" && <div className="px-3 py-2.5"><Notice tone="destructive">The review could not read this file{row.error ? `: ${row.error}` : "."} Run the review again to retry it.</Notice></div>}
        {partialCoverage && (
          <div className="px-3 py-2.5">
            <Notice tone="warning" action={(row.coverage.unreadPages?.length ?? 0) > 0 && onOpenFiles ? <Button size="xs" variant="ghost" onClick={onOpenFiles}>OCR in Files</Button> : undefined}>
              {partlyReadText(row)} Values, issues and the privilege screen cover the part that was read.
            </Notice>
          </div>
        )}
        {earlier && <div className="px-3 py-2.5"><Notice>Columns or issues changed since this file was reviewed. The values below are from the earlier run until it is re-run.</Notice></div>}
        {done && row.summary && (
          <section className="space-y-1 px-3 py-2.5">
            <h3 className="text-[11.5px] font-medium text-muted-foreground">Summary</h3>
            <p className="text-[12.5px] leading-snug">{row.summary}</p>
            {row.importance != null && <p className="text-[11.5px] text-muted-foreground">Importance {Math.round(row.importance)} of 5 (model estimate)</p>}
          </section>
        )}
        {done && (
          <section className="space-y-2 px-3 py-2.5" aria-label="Issues">
            <h3 className="text-[11.5px] font-medium text-muted-foreground">Issues</h3>
            {ranked.length === 0 && <p className="text-[12px] text-muted-foreground">Not relevant to any issue in this review.</p>}
            {ranked.map((i) => (
              <div key={i.issueId}>
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span className="font-medium">{issueLabel.get(i.issueId) ?? "Issue"}</span>
                  <span className={cn("text-[11.5px]", i.relevance === "high" ? "text-foreground" : "text-muted-foreground")}>{RELEVANCE_LABEL[i.relevance]}</span>
                </div>
                {i.reason && <p className="text-[12px] leading-snug text-muted-foreground">{i.reason}</p>}
                <Evidence ev={i} row={row} onView={onView} compact />
              </div>
            ))}
            {notRelevant.length > 0 && <p className="text-[11.5px] text-muted-foreground">Not relevant: {notRelevant.map((i) => issueLabel.get(i.issueId) ?? "Issue").join(", ")}</p>}
          </section>
        )}
        {done && (
          <section className="space-y-1 px-3 py-2.5" aria-label="Privilege screen">
            <h3 className="text-[11.5px] font-medium text-muted-foreground">Privilege screen</h3>
            <div className="text-[12.5px]">{row.privilege && row.privilege.flag !== "none" ? <PrivilegeMark flag={row.privilege.flag} /> : "No privilege indicators found"}</div>
            {row.privilege?.basis && <p className="text-[12px] leading-snug text-muted-foreground">{row.privilege.basis}</p>}
            {row.privilege && row.privilege.flag !== "none" && <Evidence ev={row.privilege} row={row} onView={onView} compact />}
            <p className="text-[11px] text-muted-foreground">A suggestion only. An advocate merely copied on a business communication is not privileged by that alone; the reviewer decides.</p>
          </section>
        )}
        {done && review.columns.length > 0 && (
          <section className="space-y-2 px-3 py-2.5" aria-label="Columns">
            <h3 className="text-[11.5px] font-medium text-muted-foreground">Columns</h3>
            <dl className="space-y-2">
              {review.columns.map((c) => {
                const cell = row.cells[c.id];
                return (
                  <div key={c.id}>
                    <dt className="text-[11.5px] text-muted-foreground">{c.label}</dt>
                    <dd className="text-[12.5px] leading-snug">
                      {cell?.status === "not_read" ? <span className="italic text-muted-foreground">Not read — not found in the part of the file that was read</span>
                        : cell?.value && cell.status !== "not_stated" ? <span className={cn("break-words", cell.status === "unverified" && "text-muted-foreground")}>{cell.value}</span>
                        : <span className="text-muted-foreground">— not stated</span>}
                      {cell?.status === "conflict" && <span className="ms-1.5 text-[11px] font-medium text-warning-foreground dark:text-warning">conflicting values</span>}
                      {cell && cell.status !== "not_stated" && cell.status !== "not_read" && <Evidence ev={cell} row={row} onView={onView} compact />}
                      {cell?.status === "conflict" && cell.alternatives?.map((a, j) => (
                        <div key={j} className="mt-1.5 border-t border-dashed pt-1.5">
                          <span className="break-words">{a.value}</span>
                          <Evidence ev={a} row={row} onView={onView} compact />
                        </div>
                      ))}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        )}
        {row.status === "pending" && !earlier && <p className="px-3 py-3 text-[12px] text-muted-foreground">This file has not been reviewed yet. Run or continue the review to fill its row.</p>}
      </div>
    </Inspector>
  );
}

function CodingControl({ row, review, onCode, saving, conflict, onReload, error }: {
  row: DocReviewRow; review: DocReview; onCode: (d: CodingDraft) => void; saving: boolean; conflict: boolean; onReload: () => void; error: string | null;
}) {
  const d = row.decision;
  const [issues, setIssues] = React.useState<string[]>(() => d?.issues ?? rankedIssues(row, []).filter((i) => i.relevance === "high").map((i) => i.issueId));
  const [note, setNote] = React.useState(d?.note ?? "");
  const dirty = !!d && (note.trim() !== (d.note ?? "").trim() || [...issues].sort().join() !== [...d.issues].sort().join());
  // Unreviewed rows can be coded too (bound to an empty row hash); the decision goes stale once the row is reviewed.
  const save = (coding: Coding | null) => onCode({ coding, issues, note: note.trim() || null });

  return (
    <section className="space-y-2 px-3 py-2.5" aria-label="Coding">
      <div className="flex items-center gap-2">
        <h3 className="text-[11.5px] font-medium text-muted-foreground">Coding</h3>
        {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="Saving" />}
        {d && !row.decisionStale && <span className="ms-auto text-[11px] text-muted-foreground">{d.reviewerName ?? "Reviewer"} · {formatPreciseDate(d.at.slice(0, 10), "day")}</span>}
      </div>
      {conflict && (
        <Notice tone="warning" action={<Button size="xs" variant="ghost" onClick={onReload}><RotateCcw className="size-3.5" /> Reload</Button>}>This row changed since you opened it — reload.</Notice>
      )}
      {d && row.decisionStale && (
        <Notice tone="warning">Coded “{CODING_LABEL[d.coding]}” by {d.reviewerName ?? "a reviewer"} on {formatPreciseDate(d.at.slice(0, 10), "day")}, on an earlier version of this row. The review has re-run since; check the row and code it again.</Notice>
      )}
      {!row.rowHash && <p className="text-[12px] text-muted-foreground">This file has not been reviewed yet; a decision recorded now is marked stale once the review reads it.</p>}
      <div role="radiogroup" aria-label="Coding decision" className="grid grid-cols-1 gap-1">
        {CODING_KEYS.map((k, i) => {
          const on = d?.coding === k && !row.decisionStale;
          return (
            <button key={k} type="button" role="radio" aria-checked={on} disabled={saving} onClick={() => save(k)}
              className={cn("flex h-7 items-center gap-2 rounded-md border px-2 text-left text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                on ? "border-ring bg-accent font-medium" : "hover:bg-accent/60")}>
              <kbd className="h-4 min-w-4 px-1 text-[10px]">{i + 1}</kbd>
              <span className="flex-1">{CODING_LABEL[k]}</span>
              {on && <Check className="size-3.5" />}
              {d?.coding === k && row.decisionStale && <span className="text-[11px] text-warning-foreground dark:text-warning">earlier version</span>}
            </button>
          );
        })}
      </div>
      {review.issues.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11.5px] text-muted-foreground">Issue tags</div>
          <div className="flex flex-wrap gap-1">
            {review.issues.map((x) => {
              const on = issues.includes(x.id);
              return (
                <button key={x.id} type="button" aria-pressed={on}  onClick={() => setIssues((l) => (on ? l.filter((y) => y !== x.id) : [...l, x.id]))}
                  className={cn("inline-flex h-6 items-center gap-1 rounded-[var(--radius-chip)] border px-1.5 text-[11.5px] ", on ? "border-ring bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")}>
                  {on && <Check className="size-3" />}{x.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note (optional)" aria-label="Coding note" maxLength={2000} className="min-h-0 px-2 py-1.5 text-[12.5px]" />
      <div className="flex items-center gap-1.5">
        {d && dirty && <Button size="xs" onClick={() => save(d.coding)} disabled={saving}>Save tags and note</Button>}
        {d && <Button size="xs" variant="ghost" onClick={() => save(null)} disabled={saving}>Clear decision</Button>}
        <span className="ms-auto text-[11px] text-muted-foreground"><kbd>j</kbd> <kbd>k</kbd> move · <kbd>1</kbd>–<kbd>5</kbd> code</span>
      </div>
      {error && !conflict && <Notice tone="destructive">{error}</Notice>}
    </section>
  );
}
