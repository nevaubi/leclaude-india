"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  AlertCircle, ArrowDownUp, ChevronDown, Download, FileSpreadsheet, ListChecks, Loader2, MoreHorizontal, Pencil, Play, Plus, RotateCcw, ScrollText, ShieldAlert, Table2, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Filterbar, type FilterbarFilter, type FilterValues } from "@/components/ui/filterbar";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { CODING_LABEL, PRACTICE_AREA_LABEL, type DocReview, type DocReviewRow, type RowQuery } from "../../review-types";
import { docsApi, downloadFrom, errorKind, errorMessage, UNCONFIGURED_MESSAGE, type ApiErrorKind } from "../api";
import { safeFileName } from "../format";
import { Notice, SurfaceState } from "../notice";
import type { ViewerTarget } from "../text-viewer";
import { PlaybookPicker } from "./playbook-picker";
import { ReviewEditor, type ReviewDefinitionValue } from "./review-editor";
import { ReviewGrid, type GridSelection } from "./review-grid";
import { CODING_KEYS, pct, RELEVANCE_LABEL, reviewsUrl, reviewUrl, rowQueryFromFilters } from "./review-helpers";
import { CellInspector, RowInspector, type CodingDraft } from "./review-inspector";
import { ReviewReportView } from "./review-report";
import { useReviewRows } from "./use-review-rows";
import { useReviewRun } from "./use-review-run";

type ListLoad = { status: "loading" } | { status: "ready"; reviews: DocReview[] } | { status: "error"; message: string; kind: ApiErrorKind };
type View = "grid" | "report";
const SORT_LABEL = { importance: "Importance", name: "File name", updated: "Last reviewed" } as const;

/** Review tab: AI discovery over the set (playbook or custom columns), coded by a reviewer, with a cross-set report. */
export function ReviewTab({ setId, setName, aiReady, fileCount, active, onView, onOpenFiles }: {
  setId: string; setName: string; aiReady: boolean | null; fileCount: number; active: boolean; onView: (t: ViewerTarget) => void; onOpenFiles?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const paramReview = params.get("review");
  const [list, setList] = React.useState<ListLoad>({ status: "loading" });
  const [reload, setReload] = React.useState(0);
  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => {
    const ac = new AbortController();
    docsApi<{ reviews: DocReview[] }>(reviewsUrl(setId), { signal: ac.signal })
      .then((r) => setList({ status: "ready", reviews: [...(r.reviews ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
      .catch((e) => { if (!ac.signal.aborted) setList({ status: "error", message: errorMessage(e), kind: errorKind(e) }); });
    return () => ac.abort();
  }, [setId, reload]);

  const selectReview = React.useCallback((id: string | null) => {
    const sp = new URLSearchParams(params.toString());
    if (id) sp.set("review", id); else sp.delete("review");
    sp.set("tab", "review");
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  const upsert = React.useCallback((r: DocReview) => {
    setList((l) => (l.status === "ready" ? { ...l, reviews: l.reviews.some((x) => x.id === r.id) ? l.reviews.map((x) => (x.id === r.id ? r : x)) : [r, ...l.reviews] } : { status: "ready", reviews: [r] }));
  }, []);

  if (list.status === "loading") return <div className="space-y-2 p-3" aria-busy="true"><div className="h-14 animate-pulse rounded-md bg-muted" /><div className="h-64 animate-pulse rounded-md bg-muted/60" /></div>;
  if (list.status === "error") {
    if (list.kind === "denied" || list.kind === "auth") return <SurfaceState icon={ShieldAlert} title="Not found or no access">{list.message}</SurfaceState>;
    return <SurfaceState icon={AlertCircle} title="Reviews could not be loaded" action={<Button size="xs" variant="ghost" onClick={() => { setList({ status: "loading" }); setReload((n) => n + 1); }}><RotateCcw className="size-3.5" /> Try again</Button>}>{list.kind === "unconfigured" ? UNCONFIGURED_MESSAGE : list.message}</SurfaceState>;
  }

  const reviews = list.reviews;
  if (creating || reviews.length === 0) {
    return <PlaybookPicker setId={setId} aiReady={aiReady} fileCount={fileCount} onBack={reviews.length ? () => setCreating(false) : undefined}
      onCreated={(r) => { upsert(r); setCreating(false); selectReview(r.id); toast.success("Review created. Run it to review the files."); }} />;
  }
  const current = paramReview ? reviews.find((r) => r.id === paramReview) ?? null : reviews[0];
  if (!current) {
    return (
      <SurfaceState icon={ShieldAlert} title="Review not found" action={<Button size="xs" variant="outline" onClick={() => selectReview(reviews[0].id)}>Open the latest review</Button>}>
        The review in this link was not found in this set, or you do not have access to it.
      </SurfaceState>
    );
  }
  return (
    <ReviewWorkspace key={current.id} setId={setId} setName={setName} review={current} reviews={reviews} aiReady={aiReady} active={active} onView={onView} onOpenFiles={onOpenFiles}
      onSelect={selectReview} onNew={() => setCreating(true)} onChanged={upsert}
      onDeleted={(id) => { setList((l) => (l.status === "ready" ? { ...l, reviews: l.reviews.filter((r) => r.id !== id) } : l)); selectReview(null); }} />
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function ReviewWorkspace({ setId, setName, review, reviews, aiReady, active, onView, onOpenFiles, onSelect, onNew, onChanged, onDeleted }: {
  setId: string; setName: string; review: DocReview; reviews: DocReview[]; aiReady: boolean | null; active: boolean; onView: (t: ViewerTarget) => void; onOpenFiles?: () => void;
  onSelect: (id: string) => void; onNew: () => void; onChanged: (r: DocReview) => void; onDeleted: (id: string) => void;
}) {
  const [view, setView] = React.useState<View>("grid");
  const [q, setQ] = React.useState("");
  const [filters, setFilters] = React.useState<FilterValues>({});
  const [sort, setSort] = React.useState<NonNullable<RowQuery["sort"]>>("importance");
  const [selection, setSelection] = React.useState<GridSelection | null>(null);
  const [inspector, setInspector] = React.useState<"cell" | "row" | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState<string | null>(null);
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [editBusy, setEditBusy] = React.useState(false);
  const [editError, setEditError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [exporting, setExporting] = React.useState<"csv" | "xlsx" | null>(null);
  const [exportDenied, setExportDenied] = React.useState(false);

  const str = (k: string) => { const v = filters[k]; return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined; };
  const query = React.useMemo(() => rowQueryFromFilters({ q, issue: str("issue"), minRelevance: str("minRelevance"), docType: str("docType"), privilege: str("privilege"), coding: str("coding"), status: str("status"), sort }), // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, filters, sort]);
  const rows = useReviewRows(setId, review.id, query);

  const refreshReview = React.useCallback(() => {
    docsApi<{ review: DocReview }>(reviewUrl(setId, review.id)).then((r) => onChanged(r.review)).catch(() => {});
  }, [onChanged, review.id, setId]);
  const { refresh } = rows;
  const runner = useReviewRun(setId, review.id, React.useCallback(() => { refresh(); refreshReview(); }, [refresh, refreshReview]));
  const run = runner.run;

  const loaded = rows.load.status === "ready" ? rows.load.rows : [];
  const selRow = selection ? loaded.find((r) => r.fileId === selection.fileId) ?? null : null;
  const selColumn = selection?.column.startsWith("col:") ? review.columns.find((c) => c.id === selection.column.slice(4)) ?? null : null;

  const select = React.useCallback((s: GridSelection) => {
    setSelection(s);
    setConflict(null); setCodeError(null);
    setInspector(s.column.startsWith("col:") ? "cell" : "row");
  }, []);
  const close = React.useCallback(() => { setInspector(null); }, []);

  // ---- coding -------------------------------------------------------------------------------------------------------

  const code = React.useCallback(async (row: DocReviewRow, d: CodingDraft) => {
    setSaving(true); setCodeError(null); setConflict(null);
    try {
      const r = await docsApi<{ row: DocReviewRow }>(reviewUrl(setId, review.id, `/rows/${encodeURIComponent(row.fileId)}`), { method: "PATCH", json: { coding: d.coding, issues: d.issues, note: d.note, rowHash: row.rowHash ?? "" } });
      rows.replaceRow(r.row);
      refreshReview();
      toast.success(d.coding ? `${row.fileName}: ${CODING_LABEL[d.coding]}` : `${row.fileName}: decision cleared`);
    } catch (e) {
      if (errorKind(e) === "conflict") { setConflict(row.fileId); setSelection((s) => s ?? { fileId: row.fileId, column: "coding" }); setInspector("row"); rows.refresh(); }
      else { setCodeError(errorMessage(e)); toast.error(errorMessage(e)); }
    } finally { setSaving(false); }
  }, [refreshReview, review.id, rows, setId]);

  // ---- keyboard: j/k move, 1–5 code, Esc close ---------------------------------------------------------------------

  const keyState = React.useRef({ loaded, selection, inspector, saving, code, view });
  keyState.current = { loaded, selection, inspector, saving, code, view };
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const s = keyState.current;
      if (s.view !== "grid" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]"))) return;
      if (document.querySelector("[role=dialog][data-state=open]")) return;
      if (e.key === "Escape" && s.inspector) { e.preventDefault(); setInspector(null); return; }
      if (e.key === "j" || e.key === "k" || e.key === "ArrowDown" && s.inspector || e.key === "ArrowUp" && s.inspector) {
        if (!s.loaded.length) return;
        e.preventDefault();
        const i = s.selection ? s.loaded.findIndex((r) => r.fileId === s.selection!.fileId) : -1;
        const next = e.key === "j" || e.key === "ArrowDown" ? Math.min(s.loaded.length - 1, i + 1) : Math.max(0, i - 1);
        const row = s.loaded[next];
        setSelection({ fileId: row.fileId, column: s.selection?.column ?? "file" });
        setConflict(null); setCodeError(null);
        if (!s.inspector) setInspector(s.selection?.column.startsWith("col:") ? "cell" : "row");
        return;
      }
      if (/^[1-5]$/.test(e.key) && s.selection && !s.saving) {
        const row = s.loaded.find((r) => r.fileId === s.selection!.fileId);
        if (!row) return;
        e.preventDefault();
        const coding = CODING_KEYS[Number(e.key) - 1];
        void s.code(row, { coding, issues: row.decision?.issues ?? row.issues.filter((x) => x.relevance === "high").map((x) => x.issueId), note: row.decision?.note ?? null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // ---- edit / delete / export ---------------------------------------------------------------------------------------

  const saveDefinition = async (v: ReviewDefinitionValue) => {
    setEditBusy(true); setEditError(null);
    try {
      const r = await docsApi<{ review: DocReview }>(reviewUrl(setId, review.id), { method: "PATCH", json: { name: v.name || review.name, columns: v.columns, issues: v.issues, version: review.version } });
      onChanged(r.review);
      setEditing(false);
      rows.reload();
      toast.success(r.review.version !== review.version ? "Saved. Changed columns and issues will be re-run when you continue the review." : "Saved.");
    } catch (e) {
      if (errorKind(e) === "conflict") { setEditError("Someone else changed this review since you opened it. It has been reloaded; reopen the editor to make your change."); refreshReview(); }
      else setEditError(errorMessage(e));
    }
    finally { setEditBusy(false); }
  };

  const doExport = async (format: "csv" | "xlsx") => {
    setExporting(format);
    try { await downloadFrom(reviewUrl(setId, review.id, `/export?format=${format}`), `${safeFileName(`${setName} - ${review.name}`)}.${format}`); }
    catch (e) {
      if (errorKind(e) === "denied") { setExportDenied(true); toast.error("You do not have permission to export from this matter."); }
      else toast.error(errorMessage(e));
    }
    finally { setExporting(null); }
  };

  const doDelete = async () => {
    try {
      await docsApi(reviewUrl(setId, review.id), { method: "DELETE" });
      toast.success(`Deleted review “${review.name}”`);
      setDeleting(false);
      onDeleted(review.id);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  // ---- filters ------------------------------------------------------------------------------------------------------

  const facets = rows.load.status === "ready" ? rows.load.facets : null;
  const filterDefs = React.useMemo<FilterbarFilter[]>(() => {
    const issueCount = (id: string) => { const f = facets?.issues.find((x) => x.issueId === id); return f ? f.high + f.medium + f.low : undefined; };
    const docTypes = facets?.docTypes.length ? facets.docTypes : review.docTypes.map((value) => ({ value, count: undefined as number | undefined }));
    const cnt = facets?.coding ?? {};
    const out: FilterbarFilter[] = [
      { id: "issue", label: "Issue", options: review.issues.map((i) => ({ value: i.id, label: i.label, count: issueCount(i.id) })) },
    ];
    if (filters.issue) out.push({ id: "minRelevance", label: "Relevance", options: (["high", "medium", "low"] as const).map((r) => ({ value: r, label: `${RELEVANCE_LABEL[r]}${r === "high" ? "" : " or higher"}` })) });
    out.push(
      { id: "docType", label: "Doc type", options: docTypes.map((d) => ({ value: d.value, label: d.value, count: d.count })) },
      { id: "privilege", label: "Privilege", options: [{ value: "likely", label: "Likely", count: facets?.privilege.likely }, { value: "possible", label: "Possible", count: facets?.privilege.possible }, { value: "none", label: "None found" }] },
      { id: "coding", label: "Coding", options: [
        ...CODING_KEYS.map((k) => ({ value: k, label: CODING_LABEL[k], count: cnt[k] })),
        { value: "uncoded", label: "Uncoded", count: cnt.uncoded }, { value: "stale", label: "Stale decision", count: cnt.stale },
      ] },
      { id: "status", label: "Status", pinned: false, options: [{ value: "done", label: "Reviewed" }, { value: "partial", label: "Partly read" }, { value: "pending", label: "Pending" }, { value: "failed", label: "Failed" }] },
    );
    return out;
  }, [facets, filters.issue, review.docTypes, review.issues]);

  const onFilters = (v: FilterValues) => setFilters(v.issue ? v : { ...v, minRelevance: undefined });
  const filtered = !!q.trim() || Object.values(filters).some((v) => (Array.isArray(v) ? v.length : v));

  // ---- render -------------------------------------------------------------------------------------------------------

  const c = review.counts;
  const partly = c.partial ?? 0;
  const reviewed = c.done + partly + c.failed;
  const runError = run?.stopped === "error" ? run : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 space-y-1.5 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" title={`${PRACTICE_AREA_LABEL[review.area] ?? review.area}${review.playbookId ? "" : " · custom"} · ${review.columns.length} columns · ${review.issues.length} issues`} className="inline-flex min-w-0 max-w-[340px] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13.5px] font-semibold hover:bg-accent">
                <span className="truncate">{review.name}</span><ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>Reviews in this set</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={review.id} onValueChange={onSelect}>
                {reviews.map((r) => <DropdownMenuRadioItem key={r.id} value={r.id}><span className="truncate">{r.name}</span><span className="ms-auto ps-2 text-[11px] tabular text-muted-foreground">{r.counts.done + (r.counts.partial ?? 0)}/{r.counts.files}</span></DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onNew}><Plus className="size-3.5" /> New review</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="hidden truncate text-[12px] text-muted-foreground xl:inline">{PRACTICE_AREA_LABEL[review.area] ?? review.area}{review.playbookId ? "" : " · custom"} · {review.columns.length} column{review.columns.length === 1 ? "" : "s"} · {review.issues.length} issue{review.issues.length === 1 ? "" : "s"}</span>
          <div className="ms-auto flex flex-wrap items-center gap-1">
            <div role="tablist" aria-label="Review view" className="me-1 inline-flex h-7 items-center rounded-md border p-0.5">
              {([["grid", "Grid", Table2], ["report", "Report", ScrollText]] as const).map(([v, label, Icon]) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                  className={cn("inline-flex h-6 items-center gap-1 rounded px-2 text-[12px]", view === v ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </div>
            <Button size="xs" variant="ghost" onClick={() => { setEditError(null); setEditing(true); }} disabled={run?.running}><Pencil className="size-3.5" /> Columns & issues</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="xs" variant="ghost" disabled={!!exporting || exportDenied} title={exportDenied ? "You do not have permission to export from this matter." : undefined}>{exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Export</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => void doExport("xlsx")}><FileSpreadsheet className="size-3.5" /> Excel workbook (.xlsx)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void doExport("csv")}><ListChecks className="size-3.5" /> CSV</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon-xs" variant="ghost" aria-label="More review actions"><MoreHorizontal className="size-3.5" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onNew}><Plus className="size-3.5" /> New review</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDeleting(true)} className="text-destructive"><Trash2 className="size-3.5" /> Delete review</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {run?.running ? (
            <Button size="xs" variant="outline" onClick={runner.cancel}><X className="size-3.5" /> Cancel</Button>
          ) : (
            <Button size="xs" onClick={() => void runner.start()} disabled={aiReady === false || c.files === 0 || (c.pending === 0 && c.failed === 0)} variant={c.pending === 0 && c.failed === 0 ? "outline" : "default"}>
              <Play className="size-3.5" /> {c.pending === 0 && c.failed === 0 ? "Up to date" : c.done + partly > 0 || c.failed > 0 ? `Continue · ${(c.pending + c.failed).toLocaleString("en-IN")} left` : "Run review"}
            </Button>
          )}
          <div className="flex min-w-[180px] flex-1 items-center gap-2 sm:max-w-[360px]">
            <Progress value={pct(reviewed, c.files)} className="h-1 flex-1" aria-label="Review progress" />
            <span className="shrink-0 text-[12px] tabular text-muted-foreground">{(c.done + partly).toLocaleString("en-IN")} of {c.files.toLocaleString("en-IN")} reviewed</span>
          </div>
          <span className="flex flex-wrap items-center gap-x-3 text-[12px] tabular text-muted-foreground">
            {partly > 0 && <button type="button" className="hover:text-foreground hover:underline" title="Reviewed, but part of the file could not be read (scanned pages or length limit)" onClick={() => setFilters({ status: "partial" })}>{partly.toLocaleString("en-IN")} partly read</button>}
            {c.pending > 0 && <span>{c.pending.toLocaleString("en-IN")} pending</span>}
            {c.failed > 0 && <button type="button" className="text-destructive hover:underline" onClick={() => setFilters({ status: "failed" })}>{c.failed.toLocaleString("en-IN")} failed</button>}
            <span>{c.coded.toLocaleString("en-IN")} coded</span>
            {c.stale > 0 && <button type="button" className="text-warning-foreground hover:underline dark:text-warning" onClick={() => setFilters({ coding: "stale" })}>{c.stale.toLocaleString("en-IN")} stale</button>}
            {c.privilegeFlags > 0 && <button type="button" className="hover:text-foreground hover:underline" onClick={() => setFilters({ privilege: "likely" })}>{c.privilegeFlags.toLocaleString("en-IN")} privilege flag{c.privilegeFlags === 1 ? "" : "s"}</button>}
          </span>
        </div>
        {run && (run.running || run.stopped || run.errors.length > 0) && (
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1 text-[12px]" aria-live="polite">
            <span className={cn(run.stopped === "error" ? "text-destructive" : "text-muted-foreground")}>
              {run.running ? <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" /> Reviewing files · batch {run.calls + 1} · {run.processed.toLocaleString("en-IN")} done this run{run.remaining ? ` · ${run.remaining.toLocaleString("en-IN")} remaining` : ""}</span>
                : run.stopped === "cancelled" ? `Stopped after ${run.processed.toLocaleString("en-IN")} file${run.processed === 1 ? "" : "s"}. Continue to pick up where it left off.`
                : run.stopped === "stalled" ? run.message
                : run.stopped === "error" ? run.message
                : `Run finished: ${run.processed.toLocaleString("en-IN")} reviewed${run.failed ? `, ${run.failed} failed` : ""}.`}
            </span>
            {run.errors.length > 0 && (
              <details className="min-w-0">
                <summary className="cursor-pointer text-destructive">{run.errors.length} file{run.errors.length === 1 ? "" : "s"} failed</summary>
                <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-[11.5px] scrollbar-thin">
                  {run.errors.map((e, i) => <li key={`${e.fileId}-${i}`}><span className="font-medium">{e.name}</span> <span className="text-destructive">— {e.error}</span></li>)}
                </ul>
              </details>
            )}
            {!run.running && <Button size="xs" variant="ghost" className="h-5 px-1.5 text-[11.5px]" onClick={runner.dismiss}>Dismiss</Button>}
          </div>
        )}
        {aiReady === false && <Notice tone="warning">{UNCONFIGURED_MESSAGE} Existing results and coding remain available.</Notice>}
        {runError?.kind === "denied" && <Notice tone="denied">You do not have permission to run this review.</Notice>}
      </div>

      {view === "report" ? (
        <div className="min-h-0 flex-1"><ReviewReportView setId={setId} review={review} aiReady={aiReady} onView={onView} onReviewChange={onChanged} /></div>
      ) : (
        <>
          <Filterbar filters={filterDefs} values={filters} onChange={onFilters} query={q} onQueryChange={setQ} queryPlaceholder="Search files"
            queryLoading={rows.load.status === "ready" && rows.load.refreshing}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="xs" variant="ghost" className="text-[11.5px] text-muted-foreground"><ArrowDownUp className="size-3.5" /> {SORT_LABEL[sort]}</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Sort rows by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
                  {(Object.keys(SORT_LABEL) as (keyof typeof SORT_LABEL)[]).map((k) => <DropdownMenuRadioItem key={k} value={k}>{SORT_LABEL[k]}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="px-1 text-[12px] tabular text-muted-foreground">
              {rows.load.status === "ready" ? `${rows.load.rows.length < rows.load.total ? `${rows.load.rows.length.toLocaleString("en-IN")} of ` : ""}${rows.load.total.toLocaleString("en-IN")} file${rows.load.total === 1 ? "" : "s"}` : ""}
            </span>
          </Filterbar>
          <div className="flex min-h-0 flex-1">
            {rows.load.status === "error" ? (
              <div className="flex-1">
                {rows.load.kind === "denied"
                  ? <SurfaceState icon={ShieldAlert} title="Not found or no access">{rows.load.message}</SurfaceState>
                  : <SurfaceState icon={AlertCircle} title="Rows could not be loaded" action={<Button size="xs" variant="ghost" onClick={rows.reload}><RotateCcw className="size-3.5" /> Try again</Button>}>{rows.load.message}</SurfaceState>}
              </div>
            ) : (
              <ReviewGrid review={review} rows={loaded} total={rows.load.status === "ready" ? rows.load.total : 0} more={rows.load.status === "ready" && rows.load.more}
                loading={rows.load.status === "loading"} refreshing={rows.load.status === "ready" && rows.load.refreshing}
                selection={selection} onSelect={select} onEndReached={rows.loadMore} scrollToFileId={selection?.fileId ?? null}
                empty={filtered
                  ? <SurfaceState title="No files match these filters" action={<Button size="xs" variant="ghost" onClick={() => { setQ(""); setFilters({}); }}>Clear filters</Button>} />
                  : <SurfaceState title="No files in this review yet">Add files to the set, then run the review.</SurfaceState>} />
            )}
            {inspector === "cell" && selRow && selColumn && (
              <CellInspector row={selRow} column={selColumn} onClose={close} onRow={() => setInspector("row")} onView={onView} />
            )}
            {(inspector === "row" || (inspector === "cell" && selRow && !selColumn)) && selRow && (
              <RowInspector row={selRow} review={review} onClose={close} onView={onView} onCode={(d) => void code(selRow, d)} saving={saving}
                conflict={conflict === selRow.fileId} onReload={() => { setConflict(null); rows.refresh(); }} error={codeError} onOpenFiles={onOpenFiles} />
            )}
          </div>
        </>
      )}

      <Dialog open={editing} onOpenChange={(o) => { if (!o && !editBusy) setEditing(false); }}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[720px]">
          <DialogHeader>
            <DialogTitle>Columns & issues</DialogTitle>
            <DialogDescription>Changing a column or issue re-runs the review on the affected files the next time you continue it.</DialogDescription>
          </DialogHeader>
          {editing && <ReviewEditor initial={{ name: review.name, columns: review.columns, issues: review.issues }} review={review} submitLabel="Save changes" busy={editBusy} error={editError} onSubmit={(v) => void saveDefinition(v)} onCancel={() => setEditing(false)} />}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting} onOpenChange={(o) => { if (!o) setDeleting(false); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete this review?</DialogTitle>
            <DialogDescription>“{review.name}”, its rows, coding decisions and report will be removed. The files in the set are not affected.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={() => void doDelete()}>Delete review</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

