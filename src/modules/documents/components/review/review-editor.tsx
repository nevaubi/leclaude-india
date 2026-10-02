"use client";
import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { REVIEW_LIMITS, type ColumnKind, type DocReview, type ReviewColumn, type ReviewIssue } from "../../review-types";
import { Notice } from "../notice";
import { buildReviewDefinition, definitionChanges, KIND_LABEL, toDraftColumn, toDraftIssue, type DraftColumn, type DraftIssue } from "./review-helpers";

const KINDS = Object.keys(KIND_LABEL) as ColumnKind[];
const blankColumn = (): DraftColumn => ({ label: "", prompt: "", kind: "text", choices: "" });
const blankIssue = (): DraftIssue => ({ label: "", description: "" });

export interface ReviewDefinitionValue { name: string; columns: ReviewColumn[]; issues: ReviewIssue[] }

/**
 * Columns and issues of a review: label, what to extract, kind and choices per column; label and relevance test per
 * issue. Used to start a custom review and to edit an existing one (`review` given: changes are counted and the user is
 * told the affected files are re-run).
 */
export function ReviewEditor({ initial, review, submitLabel, busy, error, onSubmit, onCancel, requireName = true }: {
  initial: { name: string; columns: ReviewColumn[]; issues: ReviewIssue[] };
  review?: DocReview | null;
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (v: ReviewDefinitionValue) => void;
  onCancel?: () => void;
  requireName?: boolean;
}) {
  const [name, setName] = React.useState(initial.name);
  const [columns, setColumns] = React.useState<DraftColumn[]>(() => (initial.columns.length ? initial.columns.map(toDraftColumn) : [blankColumn()]));
  const [issues, setIssues] = React.useState<DraftIssue[]>(() => initial.issues.map(toDraftIssue));
  const [errors, setErrors] = React.useState<string[]>([]);

  const built = buildReviewDefinition({ name, columns, issues }, { requireName });
  const changes = review && built.ok ? definitionChanges(review, built) : null;
  const changed = changes ? changes.columns + changes.issues : 0;

  const setCol = (i: number, p: Partial<DraftColumn>) => setColumns((l) => l.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const setIssue = (i: number, p: Partial<DraftIssue>) => setIssues((l) => l.map((c, j) => (j === i ? { ...c, ...p } : c)));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = buildReviewDefinition({ name, columns, issues }, { requireName });
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors([]);
    onSubmit({ name: r.name, columns: r.columns, issues: r.issues });
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <label className="block space-y-1">
        <span className="text-[12px] font-medium">Review name</span>
        <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Share purchase dispute — first pass" maxLength={120} />
      </label>

      <section className="space-y-2" aria-label="Columns">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[12.5px] font-medium">Columns</h3>
          <span className="text-[11.5px] text-muted-foreground">One value per file, each with the quote and page it comes from.</span>
          <span className="ms-auto text-[11px] tabular text-muted-foreground">{columns.length} / {REVIEW_LIMITS.maxColumns}</span>
        </div>
        <ol className="space-y-2">
          {columns.map((c, i) => (
            <li key={i} className="space-y-1.5 rounded-md border px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <span className="w-5 shrink-0 text-[11px] tabular text-muted-foreground">{i + 1}</span>
                <Input size="xs" value={c.label} onChange={(e) => setCol(i, { label: e.target.value })} placeholder="Label (e.g. Seat of arbitration)" aria-label={`Column ${i + 1} label`} className="min-w-0 flex-1" maxLength={80} />
                <Select value={c.kind} onValueChange={(v) => setCol(i, { kind: v as ColumnKind })}>
                  <SelectTrigger size="xs" className="w-[112px] shrink-0" aria-label={`Column ${i + 1} kind`}><SelectValue /></SelectTrigger>
                  <SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent>
                </Select>
                <Button size="icon-xs" variant="ghost" aria-label={`Remove column ${i + 1}`} title="Remove column" onClick={() => setColumns((l) => l.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
              </div>
              <Textarea value={c.prompt} onChange={(e) => setCol(i, { prompt: e.target.value })} rows={2} placeholder="What to extract, as you would tell a junior (e.g. Seat of arbitration as stated in the clause, not the venue of hearings)" aria-label={`Column ${i + 1} instruction`} className="min-h-0 px-2 py-1.5 text-[12.5px] leading-snug" maxLength={600} />
              {c.kind === "choice" && (
                <Input size="xs" value={c.choices} onChange={(e) => setCol(i, { choices: e.target.value })} placeholder="Allowed answers, comma separated (e.g. Delhi, Mumbai, Singapore, Other)" aria-label={`Column ${i + 1} choices`} />
              )}
            </li>
          ))}
        </ol>
        <Button size="xs" variant="outline" disabled={columns.length >= REVIEW_LIMITS.maxColumns} onClick={() => setColumns((l) => [...l, blankColumn()])}><Plus className="size-3.5" /> Add column</Button>
      </section>

      <section className="space-y-2" aria-label="Issues">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[12.5px] font-medium">Issues</h3>
          <span className="text-[11.5px] text-muted-foreground">Each file is rated high, medium, low or not relevant to each issue, with the reason.</span>
          <span className="ms-auto text-[11px] tabular text-muted-foreground">{issues.length} / {REVIEW_LIMITS.maxIssues}</span>
        </div>
        {issues.length > 0 && (
          <ol className="space-y-2">
            {issues.map((x, i) => (
              <li key={i} className="space-y-1.5 rounded-md border px-2.5 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="w-5 shrink-0 text-[11px] tabular text-muted-foreground">{i + 1}</span>
                  <Input size="xs" value={x.label} onChange={(e) => setIssue(i, { label: e.target.value })} placeholder="Issue (e.g. Notice of termination)" aria-label={`Issue ${i + 1} label`} className="min-w-0 flex-1" maxLength={80} />
                  <Button size="icon-xs" variant="ghost" aria-label={`Remove issue ${i + 1}`} title="Remove issue" onClick={() => setIssues((l) => l.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
                </div>
                <Textarea value={x.description} onChange={(e) => setIssue(i, { description: e.target.value })} rows={2} placeholder="What makes a document relevant to this issue" aria-label={`Issue ${i + 1} description`} className="min-h-0 px-2 py-1.5 text-[12.5px] leading-snug" maxLength={600} />
              </li>
            ))}
          </ol>
        )}
        <Button size="xs" variant="outline" disabled={issues.length >= REVIEW_LIMITS.maxIssues} onClick={() => setIssues((l) => [...l, blankIssue()])}><Plus className="size-3.5" /> Add issue</Button>
      </section>

      {review && (
        <Notice tone={changed ? "warning" : "info"}>
          {changed
            ? `${changes!.columns ? `${changes!.columns} column${changes!.columns === 1 ? "" : "s"}` : ""}${changes!.columns && changes!.issues ? " and " : ""}${changes!.issues ? `${changes!.issues} issue${changes!.issues === 1 ? "" : "s"}` : ""} changed. Saving re-runs the review on the affected files; coding already recorded on them is kept but marked as made on an earlier version.`
            : "Changing columns or issues re-runs the review on the affected files. Renaming alone does not."}
        </Notice>
      )}
      {(errors.length > 0 || error) && (
        <Notice tone="destructive">
          <ul className="space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}{error && <li>{error}</li>}</ul>
        </Notice>
      )}
      <div className="flex items-center justify-end gap-2">
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>}
        <Button size="sm" type="submit" disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />}{submitLabel}</Button>
      </div>
    </form>
  );
}
