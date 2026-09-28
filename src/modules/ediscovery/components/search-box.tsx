"use client";
import * as React from "react";
import { Search, X, Loader2, HelpCircle, AlertTriangle, Bookmark, ListChecks, ArrowRight, ShieldCheck, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { SegmentedControl } from "@/components/ui/form";
import type { GroupBy, SearchResponse } from "../types";
import { QUERY_FIELDS } from "../query";
import { useReviewStore } from "./store";
import { useReview } from "./review-page";
import { useBatch } from "./use-review-data";
import { Kbd, StateChip } from "./shared";

const EXAMPLES: { q: string; hint: string }[] = [
  { q: 'contract AND (termination OR breach) NOT invoice', hint: "Boolean with grouping" },
  { q: '"board meeting" custodian:smith type:email', hint: "Phrase + field prefixes" },
  { q: "defect w/5 report", hint: "Within 5 words, either order" },
  { q: '"test results" pre/3 draft', hint: "Ordered proximity" },
  { q: "Ex.P7", hint: "Exhibit mark (exact: Ex.P1 is not Ex.P12)" },
  { q: 'exhibit:"Ex.D1 to D18"', hint: "Range of exhibits" },
  { q: "ABC-0100–ABC-0250", hint: "Document reference range" },
  { q: "from:smith date:2024-03-01..2024-03-31", hint: "Sender + date range" },
  { q: "priv:yes -priv:wp cc:counsel", hint: "Privilege basis, exclude" },
  { q: "type:email hasattachment:yes responsive:none", hint: "Uncoded email families" },
  { q: "family:ABC-0000100 OR dupes:near", hint: "Family members, near-dups" },
];

const GROUP_OPTIONS: { value: GroupBy; label: string; title: string }[] = [
  { value: "none", label: "Flat", title: "One row per document" },
  { value: "family", label: "Family", title: "Parents with their attachments" },
  { value: "thread", label: "Thread", title: "Email threads together" },
  { value: "neardup", label: "Near-dup", title: "Near-duplicate clusters together" },
];

export function SearchBox({ response, loading, onSaveSearch, onTermReport }: { response: SearchResponse | null; loading: boolean; onSaveSearch: () => void; onTermReport: () => void }) {
  const { aiConfigured } = useReview();
  const q = useReviewStore((s) => s.q);
  const setQ = useReviewStore((s) => s.setQ);
  const semantic = useReviewStore((s) => s.semantic);
  const setSemantic = useReviewStore((s) => s.setSemantic);
  const groupBy = useReviewStore((s) => s.groupBy);
  const setGroupBy = useReviewStore((s) => s.setGroupBy);
  const [local, setLocal] = React.useState(q);
  React.useEffect(() => setLocal(q), [q]);
  const commit = React.useCallback((v: string) => setQ(v), [setQ]);
  // Debounce typing → store
  React.useEffect(() => { const t = setTimeout(() => { if (local !== q) commit(local); }, 220); return () => clearTimeout(t); }, [local, q, commit]);
  const warnings = response?.parsed.warnings ?? [];
  const parsed = response?.parsed;

  return (
    <div className="shrink-0 border-b bg-background">
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 px-2 py-1">
        <div className="relative min-w-[200px] flex-1">
          {loading ? <Loader2 className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" /> : <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />}
          <input
            id="ediscovery-search"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(local); if (e.key === "Escape") { setLocal(""); commit(""); (e.target as HTMLInputElement).blur(); } }}
            placeholder={semantic ? "Describe what you are looking for — e.g. admissions that the invoices were due" : 'Search — boolean, "phrases", w/5, Ex.P7, exhibit:, from:, date:, priv:, document references'}
            className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 font-mono text-[12px] placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label="Search documents"
            autoComplete="off"
            spellCheck={false}
          />
          {local ? <button onClick={() => { setLocal(""); commit(""); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer" aria-label="Clear search"><X className="size-3" /></button> : <kbd className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 sm:inline">/</kbd>}
        </div>
        <Tip label={aiConfigured ? "Semantic: hybrid embedding + keyword ranking" : "Semantic mode ranks with BM25 only until an AI provider is configured"}>
          <Toggle pressed={semantic} onPressedChange={setSemantic} size="sm" variant="outline" className={cn("h-7 border-transparent px-2 text-[12px] text-muted-foreground shadow-none hover:text-foreground", semantic && "text-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground")} aria-label="Toggle semantic search">Semantic</Toggle>
        </Tip>
        <Popover>
          <PopoverTrigger asChild><Button variant="ghost" size="icon-xs" aria-label="Search syntax help"><HelpCircle className="size-3.5" /></Button></PopoverTrigger>
          <PopoverContent align="start" className="w-[420px] p-3">
            <div className="text-xs font-medium">Query syntax</div>
            <p className="mt-1 text-[11px] text-muted-foreground">Terms are AND-ed. <Kbd>OR</Kbd>, <Kbd>NOT</Kbd> or <Kbd>-term</Kbd>, parentheses, quoted phrases, <Kbd>w/N</Kbd> (within N words) and <Kbd>pre/N</Kbd> (ordered). Precedence: NOT, proximity, AND, OR.</p>
            <ul className="mt-2 space-y-0.5">
              {EXAMPLES.map((ex) => (
                <li key={ex.q}><button onClick={() => { setLocal(ex.q); commit(ex.q); }} className="flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-0.5 text-left hover:bg-accent cursor-pointer"><code className="font-mono text-[11px]">{ex.q}</code><span className="shrink-0 text-[10.5px] text-muted-foreground">{ex.hint}</span></button></li>
              ))}
            </ul>
            <div className="mt-2 text-[12px] font-medium text-muted-foreground">Fields</div>
            <dl className="mt-1 grid max-h-44 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 overflow-y-auto text-[11px] scrollbar-thin">
              {QUERY_FIELDS.map((f) => <React.Fragment key={f.field}><dt className="font-mono text-foreground">{f.field}:</dt><dd className="text-muted-foreground">{f.hint}</dd></React.Fragment>)}
            </dl>
          </PopoverContent>
        </Popover>
        <div className="hidden h-4 w-px bg-border sm:block" aria-hidden />
        <SegmentedControl size="xs" ariaLabel="Group rows" value={groupBy} onChange={setGroupBy} options={GROUP_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />
        <div className="hidden h-4 w-px bg-border sm:block" aria-hidden />
        <Tip label="Save this search (query, view, facets) for the matter team"><Button variant="ghost" size="xs" className="h-7 gap-1 px-2 text-[11.5px]" onClick={onSaveSearch}><Bookmark className="size-3" /> Save</Button></Tip>
        <Tip label="Search-term report: hits, unique documents and families per term"><Button variant="ghost" size="xs" className="h-7 gap-1 px-2 text-[11.5px]" onClick={onTermReport}><ListChecks className="size-3" /> Terms</Button></Tip>
      </div>
      {(warnings.length > 0 || (parsed && (parsed.bates.length > 0 || parsed.fields.length > 0))) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5 text-[11px]">
          {parsed?.bates.map((b, i) => <span key={i} className="font-mono text-muted-foreground">Doc. ref. {b.start}{b.end !== b.start ? ` – ${b.end}` : ""}</span>)}
          {parsed?.fields.map((f, i) => <span key={i} className="font-mono text-muted-foreground">{f.field}:{f.value}</span>)}
          {warnings.map((w, i) => <span key={i} className="inline-flex items-center gap-1 text-warning-foreground dark:text-warning"><AlertTriangle className="size-3" />{w}</span>)}
        </div>
      )}
    </div>
  );
}

/**
 * Batch review mode strip: which batch is open, what is left, next-uncoded (x),
 * QC-sample mode for batches with a sample, and the way out.
 */
export function BatchModeStrip({ onNext, rows }: { onNext: () => void; rows: unknown[] }) {
  const batchId = useReviewStore((s) => s.batchId);
  const qcMode = useReviewStore((s) => s.qcMode);
  const setBatch = useReviewStore((s) => s.setBatch);
  const batch = useBatch(batchId);
  const refresh = batch.refresh;
  // Progress follows the grid: every coding change patches the rows, so re-read the batch then.
  const first = React.useRef(true);
  React.useEffect(() => { if (first.current) { first.current = false; return; } if (batchId) refresh(); }, [rows, batchId, refresh]);
  const b = batch.data?.batch;
  if (!batchId) return null;
  const remaining = qcMode ? Math.max(0, (b?.progress.qcSampled ?? 0) - (b?.progress.qcDone ?? 0)) : b?.progress.remaining ?? 0;
  return (
    <div className="flex h-8 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-3 text-[11.5px]" role="status" aria-label="Batch review mode">
      <span className="font-medium">{qcMode ? "QC sample" : "Batch"}:</span>
      <span className="min-w-0 truncate">{b?.name ?? "…"}</span>
      {b && <span className="tabular text-muted-foreground">{qcMode ? `${b.progress.qcDone} of ${b.progress.qcSampled} checked` : `${b.progress.coded} of ${b.progress.total} coded`} · {remaining} left</span>}
      {b && qcMode && b.progress.disagreements > 0 && <StateChip tone="warning">{b.progress.disagreements} disagree</StateChip>}
      <div className="flex-1" />
      <Tip label="Open the next document that still needs a decision" shortcut="x"><Button size="xs" variant="outline" className="h-6 gap-1" onClick={onNext} disabled={remaining === 0}><ArrowRight className="size-3" /> Next uncoded</Button></Tip>
      {b && b.qcSamplePercent > 0 && (
        <Tip label={qcMode ? "Back to the full batch" : `Review the ${b.qcSamplePercent}% QC sample: your call is compared with the first pass`}><Button size="xs" variant={qcMode ? "secondary" : "ghost"} className="h-6 gap-1" onClick={() => setBatch(batchId, !qcMode)}><ShieldCheck className="size-3" /> QC {qcMode ? "on" : "sample"}</Button></Tip>
      )}
      <Tip label="Leave batch mode"><Button size="xs" variant="ghost" className="h-6 gap-1" onClick={() => setBatch(null)}><LogOut className="size-3" /> Exit</Button></Tip>
    </div>
  );
}
