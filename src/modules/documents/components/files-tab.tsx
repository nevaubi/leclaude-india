"use client";
import * as React from "react";
import { toast } from "sonner";
import {
  AlertCircle, Ban, Check, CheckCircle2, Copy, FileText, FolderUp, Loader2, RotateCcw, ScanLine, Search, Trash2, Upload, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";
import { DOCS_LIMITS, type DocFile, type DocFileStatus } from "../types";
import { docsApi, errorKind, errorMessage, isAbort, setUrl, type ApiErrorKind } from "./api";
import { formatBytes, formatPreciseDate, methodLabel, shortHash } from "./format";
import { FileStatus, Notice, SurfaceState } from "./notice";
import { openForOcr, rasterisePage } from "./pdf-read";
import { DOCS_ACCEPT_ATTR, filesFromDrop, type DocUploads, type UploadItem, type UploadState } from "./use-doc-uploads";
import type { ViewerTarget } from "./text-viewer";

const PAGE_SIZE = 200;
const ALL = "__all__";

type Load = { status: "loading" } | { status: "ready"; files: DocFile[]; total: number; more: boolean } | { status: "error"; message: string; kind: ApiErrorKind };

interface OcrJob { fileId: string; name: string; pages: number[]; done: number; failed: number; errors: string[]; ctrl: AbortController; finished?: boolean }

export function FilesTab({ setId, uploads, aiReady, storageFull, onView, onChanged, refreshKey }: {
  setId: string; uploads: DocUploads; aiReady: boolean | null; storageFull: string | null; onView: (t: ViewerTarget) => void; onChanged: () => void; refreshKey: number;
}) {
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState<string>(ALL);
  const [load, setLoad] = React.useState<Load>({ status: "loading" });
  const [reload, setReload] = React.useState(0);
  const [toDelete, setToDelete] = React.useState<DocFile | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [ocr, setOcr] = React.useState<OcrJob | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);
  const reselectInput = React.useRef<HTMLInputElement>(null);
  const reselectFor = React.useRef<DocFile | null>(null);
  const loadingMore = React.useRef(false);
  const { updateDoc } = uploads;

  const query = React.useCallback((offset: number, limit = PAGE_SIZE) => {
    const sp = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (q.trim()) sp.set("q", q.trim());
    if (status !== ALL) sp.set("status", status);
    return setUrl(setId, `/files?${sp}`);
  }, [q, setId, status]);

  React.useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      docsApi<{ files: DocFile[]; total: number }>(query(0), { signal: ac.signal })
        .then((r) => setLoad({ status: "ready", files: r.files, total: r.total, more: r.files.length < r.total }))
        .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorMessage(e), kind: errorKind(e) }); });
    }, q ? 250 : 0);
    return () => { clearTimeout(t); ac.abort(); };
  }, [query, reload, refreshKey, q]);

  const loadMore = React.useCallback(() => {
    if (load.status !== "ready" || !load.more || loadingMore.current) return;
    loadingMore.current = true;
    docsApi<{ files: DocFile[]; total: number }>(query(load.files.length))
      .then((r) => setLoad((l) => {
        if (l.status !== "ready") return l;
        const seen = new Set(l.files.map((f) => f.id));
        const files = [...l.files, ...r.files.filter((f) => !seen.has(f.id))];
        return { status: "ready", files, total: r.total, more: files.length < r.total && r.files.length > 0 };
      }))
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => { loadingMore.current = false; });
  }, [load, query]);

  const replaceFile = React.useCallback((f: DocFile) => {
    setLoad((l) => (l.status === "ready" ? { ...l, files: l.files.map((x) => (x.id === f.id ? f : x)) } : l));
  }, []);

  // ---- OCR ------------------------------------------------------------------------------------------------------

  const runOcr = React.useCallback(async (doc: DocFile, original: File) => {
    const ctrl = new AbortController();
    const pages = [...doc.ocrPages].sort((a, b) => a - b);
    const job: OcrJob = { fileId: doc.id, name: doc.name, pages, done: 0, failed: 0, errors: [], ctrl };
    setOcr({ ...job });
    let opened: Awaited<ReturnType<typeof openForOcr>> | null = null;
    try {
      opened = await openForOcr(original);
      if (opened.sha256 !== doc.sha256) throw new Error("The selected PDF is not the file that was uploaded (its SHA-256 differs).");
      for (const p of pages) {
        if (ctrl.signal.aborted) break;
        try {
          const image = await rasterisePage(opened.doc, p);
          const r = await docsApi<{ file: DocFile; page: number; chars: number }>(setUrl(setId, `/files/${encodeURIComponent(doc.id)}/ocr`), { json: { page: p, image }, signal: ctrl.signal });
          replaceFile(r.file);
          updateDoc(r.file);
          job.done++;
        } catch (e) {
          if (isAbort(e)) break;
          job.failed++;
          job.errors.push(`Page ${p}: ${errorMessage(e)}`);
          if (errorKind(e) === "unconfigured" || errorKind(e) === "denied" || errorKind(e) === "storage") break;
        }
        setOcr({ ...job });
      }
    } catch (e) {
      job.errors.push(errorMessage(e));
      job.failed = job.pages.length - job.done;
    } finally {
      void opened?.doc.loadingTask.destroy();
      setOcr({ ...job, finished: true });
      onChanged();
    }
  }, [onChanged, replaceFile, setId, updateDoc]);

  const startOcr = React.useCallback((doc: DocFile) => {
    if (ocr && !ocr.finished) { toast.message("Wait for the current OCR run to finish."); return; }
    const original = uploads.originalFor(doc);
    if (original) { void runOcr(doc, original); return; }
    reselectFor.current = doc;
    reselectInput.current?.click();
  }, [ocr, runOcr, uploads]);

  const onReselected = async (list: FileList | null) => {
    const doc = reselectFor.current;
    reselectFor.current = null;
    const file = list?.[0];
    if (!doc || !file) return;
    const ok = await uploads.adoptOriginal(doc, file);
    if (!ok) { toast.error("That PDF is not the file that was uploaded (its SHA-256 differs). Choose the original file."); return; }
    void runOcr(doc, file);
  };

  // ---- adding files ---------------------------------------------------------------------------------------------

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    if (storageFull) { toast.error(storageFull); return; }
    uploads.add(files);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(await filesFromDrop(e.dataTransfer));
  };

  const columns = React.useMemo<DataTableColumn<DocFile>[]>(() => [
    { id: "name", header: "File", width: 320, minWidth: 180, sortable: true, locked: true, accessor: (f) => f.name, render: (f) => (
      <span className="flex min-w-0 items-center gap-2" title={f.note ? `${f.name} — ${f.note}` : f.name}>
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground">{f.name}</span>
      </span>
    ) },
    { id: "status", header: "Status", width: 110, sortable: true, accessor: (f) => f.status, render: (f) => <FileStatus status={f.status} /> },
    { id: "method", header: "Read as", width: 170, accessor: (f) => methodLabel(f), render: (f) => <span className="truncate text-muted-foreground" title={f.note ?? undefined}>{methodLabel(f)}</span> },
    { id: "pages", header: "Pages", width: 70, align: "right", sortable: true, accessor: (f) => f.pages, render: (f) => <span className="tabular text-muted-foreground">{f.pages || "—"}</span> },
    { id: "size", header: "Size", width: 80, align: "right", sortable: true, accessor: (f) => f.size, render: (f) => <span className="tabular text-muted-foreground">{formatBytes(f.size)}</span> },
    { id: "docDate", header: "Doc date", width: 110, sortable: true, accessor: (f) => f.docDate ?? "", render: (f) => <span className="tabular text-muted-foreground">{f.docDate ? formatPreciseDate(f.docDate, "day") : "—"}</span> },
    { id: "hash", header: "SHA-256", width: 110, accessor: (f) => f.sha256, render: (f) => (
      <button type="button" className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground" title={`${f.sha256} (${f.hashOrigin === "browser" ? "browser" : "server"}) — click to copy`}
        onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(f.sha256).then(() => toast.success("Hash copied")); }}>
        {shortHash(f.sha256)} <Copy className="size-3 opacity-60" />
      </button>
    ) },
    { id: "uploaded", header: "Added", width: 120, sortable: true, defaultHidden: true, accessor: (f) => f.uploadedAt, render: (f) => <RelativeTime value={f.uploadedAt} className="text-muted-foreground" /> },
  ], []);

  const files = load.status === "ready" ? load.files : [];
  const hasFiles = load.status === "ready" && (load.total > 0 || !!q.trim() || status !== ALL);
  const busyOcr = !!ocr && !ocr.finished;

  const dropZone = (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center transition-colors",
        hasFiles ? "flex-row flex-wrap px-3 py-2" : "px-6 py-12", dragOver ? "border-ring bg-accent/60" : "bg-surface-quiet")}
    >
      {!hasFiles && <Upload className="size-5 text-muted-foreground/70" aria-hidden />}
      <div className={cn("text-muted-foreground", hasFiles ? "text-[12px]" : "text-[13px]")}>
        {hasFiles ? "Drop files or a folder here, or" : <><span className="font-medium text-foreground">Drop files or a whole folder here</span><br /><span className="text-[12px]">PDF up to {formatBytes(DOCS_LIMITS.maxPdfBytes)} and {DOCS_LIMITS.maxPdfPages.toLocaleString("en-IN")} pages (read in your browser); Word, text, CSV, HTML, email and JSON up to {formatBytes(DOCS_LIMITS.maxServerFileBytes)}.</span></>}
      </div>
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" onClick={() => fileInput.current?.click()} disabled={!!storageFull}><Upload className="size-3.5" /> Add files</Button>
        <Button size="xs" variant="outline" onClick={() => folderInput.current?.click()} disabled={!!storageFull}><FolderUp className="size-3.5" /> Add folder</Button>
      </div>
      <input ref={fileInput} type="file" multiple hidden accept={DOCS_ACCEPT_ATTR} onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      <input ref={folderInput} type="file" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
      <input ref={reselectInput} type="file" hidden accept=".pdf,application/pdf" onChange={(e) => { void onReselected(e.target.files); e.target.value = ""; }} />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      {storageFull && <Notice tone="warning">{storageFull}</Notice>}
      {dropZone}
      {uploads.total > 0 && <UploadPanel uploads={uploads} onOcr={(doc) => startOcr(doc)} aiReady={aiReady} busyOcr={busyOcr} />}
      {ocr && <OcrPanel job={ocr} onCancel={() => ocr.ctrl.abort()} onClose={() => setOcr(null)} />}

      {load.status === "error" ? (
        load.kind === "denied"
          ? <SurfaceState title="Not found or no access">{load.message}</SurfaceState>
          : <SurfaceState icon={AlertCircle} title="Files could not be loaded" action={<Button size="xs" variant="ghost" onClick={() => setReload((n) => n + 1)}><RotateCcw className="size-3.5" /> Try again</Button>}>{load.message}</SurfaceState>
      ) : hasFiles || load.status === "loading" ? (
        <div className="flex min-h-[240px] flex-1 flex-col overflow-hidden rounded-md border">
          <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5">
            <div className="relative w-full max-w-[260px]">
              <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input size="xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search file names" aria-label="Search file names" className="ps-7" />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger size="xs" className="w-[140px]" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {(["ready", "partial", "needs_ocr", "empty", "failed"] as DocFileStatus[]).map((s) => <SelectItem key={s} value={s}><FileStatus status={s} /></SelectItem>)}
              </SelectContent>
            </Select>
            {load.status === "ready" && <span className="ms-auto text-[12px] tabular text-muted-foreground">{load.files.length < load.total ? `${load.files.length.toLocaleString("en-IN")} of ` : ""}{load.total.toLocaleString("en-IN")} file{load.total === 1 ? "" : "s"}</span>}
          </div>
          <div className="min-h-0 flex-1">
            <DataTable
              rows={files}
              columns={columns}
              rowId={(f) => f.id}
              noun="file"
              selectionMode="none"
              total={load.status === "ready" ? load.total : undefined}
              onRowClick={(f) => onView({ fileId: f.id, name: f.name })}
              onRowActivate={(f) => onView({ fileId: f.id, name: f.name })}
              onEndReached={loadMore}
              loading={load.status === "loading"}
              columnChooser={false}
              summary={false}
              rowActions={(f) => (
                <span className="flex items-center gap-0.5">
                  {f.ocrPages.length > 0 && (
                    <Button size="xs" variant="ghost" disabled={aiReady === false || busyOcr} title={aiReady === false ? "AI is not configured" : `Read ${f.ocrPages.length} scanned page${f.ocrPages.length === 1 ? "" : "s"} with AI`}
                      onClick={(e) => { e.stopPropagation(); startOcr(f); }}>
                      <ScanLine className="size-3.5" /> OCR {f.ocrPages.length}
                    </Button>
                  )}
                  <Button size="icon-xs" variant="ghost" aria-label={`Delete ${f.name}`} title="Delete file" onClick={(e) => { e.stopPropagation(); setToDelete(f); }}><Trash2 className="size-3.5" /></Button>
                </span>
              )}
              empty={<div className="px-6 py-10 text-center text-[13px] text-muted-foreground">No files match. <button type="button" className="underline underline-offset-2" onClick={() => { setQ(""); setStatus(ALL); }}>Clear filters</button></div>}
              ariaLabel="Files in this set"
            />
          </div>
        </div>
      ) : uploads.total === 0 ? (
        <p className="px-1 text-[12px] text-muted-foreground">Files are read into text with page numbers so answers, facts and events can point to the page they come from. Original files are not stored; each file&apos;s SHA-256 is recorded.</p>
      ) : null}

      <Dialog open={!!toDelete} onOpenChange={(o) => { if (!o) setToDelete(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete this file?</DialogTitle>
            <DialogDescription>“{toDelete?.name}”, its text and the facts and events taken from it will be removed from this set.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setToDelete(null)}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={async () => {
              const f = toDelete; if (!f) return;
              try {
                await docsApi(setUrl(setId, `/files/${encodeURIComponent(f.id)}`), { method: "DELETE" });
                setLoad((l) => (l.status === "ready" ? { ...l, files: l.files.filter((x) => x.id !== f.id), total: Math.max(0, l.total - 1) } : l));
                toast.success(`Deleted ${f.name}`);
                onChanged();
              } catch (e) { toast.error(errorMessage(e)); }
              setToDelete(null);
            }}>Delete file</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

const STATE_LABEL: Record<UploadState, string> = {
  queued: "Queued", reading: "Reading", uploading: "Uploading", created: "Added", duplicate: "Duplicate", rejected: "Rejected", failed: "Failed", cancelled: "Cancelled",
};

function StateIcon({ s }: { s: UploadState }) {
  if (s === "reading" || s === "uploading") return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
  if (s === "created") return <CheckCircle2 className="size-3.5 text-success" />;
  if (s === "duplicate") return <Check className="size-3.5 text-muted-foreground" />;
  if (s === "rejected" || s === "failed") return <AlertCircle className="size-3.5 text-destructive" />;
  if (s === "cancelled") return <Ban className="size-3.5 text-muted-foreground" />;
  return <span className="inline-block size-1.5 rounded-full bg-muted-foreground/45" />;
}

const ORDER: Record<UploadState, number> = { failed: 0, rejected: 1, reading: 2, uploading: 2, queued: 3, cancelled: 4, duplicate: 5, created: 6 };
const MAX_ROWS = 300;

function UploadPanel({ uploads, onOcr, aiReady, busyOcr }: { uploads: DocUploads; onOcr: (doc: DocFile) => void; aiReady: boolean | null; busyOcr: boolean }) {
  const { items, counts, total, settled, busy } = uploads;
  const [open, setOpen] = React.useState(true);
  const rows = React.useMemo(() => [...items].sort((a, b) => ORDER[a.state] - ORDER[b.state]).slice(0, MAX_ROWS), [items]);
  const pct = total ? Math.round((settled / total) * 100) : 0;
  const problems = counts.failed + counts.rejected;
  const summary = [
    counts.created && `${counts.created} added`,
    counts.duplicate && `${counts.duplicate} duplicate`,
    counts.rejected && `${counts.rejected} rejected`,
    counts.failed && `${counts.failed} failed`,
    counts.cancelled && `${counts.cancelled} cancelled`,
  ].filter(Boolean).join(" · ");

  return (
    <section className="rounded-md border" aria-label="Uploads">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
            <span className="font-medium">{busy ? `Uploading ${settled.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")}` : `${total.toLocaleString("en-IN")} file${total === 1 ? "" : "s"} processed`}</span>
            <span className="truncate text-[12px] text-muted-foreground">{summary}</span>
          </div>
          <Progress value={pct} className="mt-1.5 h-1" aria-label="Upload progress" />
        </div>
        <div className="flex items-center gap-1">
          {busy && <Button size="xs" variant="ghost" onClick={uploads.cancelAll}><X className="size-3.5" /> Cancel</Button>}
          {!busy && (counts.failed > 0 || counts.cancelled > 0) && <Button size="xs" variant="ghost" onClick={uploads.retryFailed}><RotateCcw className="size-3.5" /> Retry {counts.failed + counts.cancelled}</Button>}
          {!busy && <Button size="xs" variant="ghost" onClick={uploads.clearFinished}>Clear</Button>}
          <Button size="xs" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Hide" : `Show${problems ? ` (${problems} need attention)` : ""}`}</Button>
        </div>
      </header>
      {open && (
        <ul className="max-h-[210px] divide-y overflow-y-auto border-t scrollbar-thin">
          {rows.map((it) => <UploadRow key={it.key} it={it} onRetry={() => uploads.retry(it.key)} onOcr={onOcr} aiReady={aiReady} busyOcr={busyOcr} />)}
          {items.length > MAX_ROWS && <li className="px-3 py-1.5 text-[11.5px] text-muted-foreground">{(items.length - MAX_ROWS).toLocaleString("en-IN")} more not shown (problems are listed first).</li>}
        </ul>
      )}
    </section>
  );
}

function UploadRow({ it, onRetry, onOcr, aiReady, busyOcr }: { it: UploadItem; onRetry: () => void; onOcr: (doc: DocFile) => void; aiReady: boolean | null; busyOcr: boolean }) {
  const scanned = it.doc && it.state === "created" ? it.doc.ocrPages.length : 0;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-[12px] sm:flex-nowrap">
      <StateIcon s={it.state} />
      <span className="min-w-[30%] flex-1 truncate" title={it.name}>{it.name}</span>
      {it.progress != null && (it.state === "reading" || it.state === "uploading") && <Progress value={Math.round(it.progress * 100)} className="h-1 w-20" aria-label={`${it.name} progress`} />}
      <span className="shrink-0 tabular text-muted-foreground">{formatBytes(it.size)}</span>
      <span className={cn("line-clamp-2 min-w-0 basis-full break-words ps-5 sm:max-w-[55%] sm:basis-auto sm:ps-0", it.state === "failed" || it.state === "rejected" ? "text-destructive" : "text-muted-foreground")} title={it.reason}>
        {STATE_LABEL[it.state]}{it.reason ? ` — ${it.reason}` : it.doc && it.state === "created" ? ` · ${methodLabel(it.doc)}` : ""}
      </span>
      {scanned > 0 && (
        <Button size="xs" variant="ghost" className="h-6" disabled={aiReady === false || busyOcr} title={aiReady === false ? "AI is not configured" : undefined} onClick={() => it.doc && onOcr(it.doc)}>
          <ScanLine className="size-3.5" /> Read {scanned} scanned page{scanned === 1 ? "" : "s"} with AI
        </Button>
      )}
      {(it.state === "failed" || it.state === "cancelled") && <Button size="xs" variant="ghost" className="h-6" onClick={onRetry}><RotateCcw className="size-3.5" /> Retry</Button>}
    </li>
  );
}

function OcrPanel({ job, onCancel, onClose }: { job: OcrJob; onCancel: () => void; onClose: () => void }) {
  const total = job.pages.length;
  const pct = total ? Math.round(((job.done + job.failed) / total) * 100) : 100;
  return (
    <section className="rounded-md border px-3 py-2" aria-label="OCR progress">
      <div className="flex items-center gap-3 text-[12.5px]">
        {job.finished ? <ScanLine className="size-3.5 text-muted-foreground" /> : <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{job.finished ? "AI OCR finished" : "Reading scanned pages with AI"}</span>
          <span className="text-muted-foreground"> · {job.name} · {job.done} of {total} page{total === 1 ? "" : "s"} read{job.failed ? ` · ${job.failed} failed` : ""}</span>
        </span>
        {job.finished ? <Button size="xs" variant="ghost" onClick={onClose}>Dismiss</Button> : <Button size="xs" variant="ghost" onClick={onCancel}><X className="size-3.5" /> Stop</Button>}
      </div>
      <Progress value={pct} className="mt-1.5 h-1" aria-label="OCR progress" />
      {job.errors.length > 0 && <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-destructive">{job.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}{job.errors.length > 5 && <li>…and {job.errors.length - 5} more</li>}</ul>}
      <p className="mt-1 text-[11px] text-muted-foreground">Page images are sent to the vision model one at a time; the text is stored as “AI OCR” and should be checked against the original.</p>
    </section>
  );
}

