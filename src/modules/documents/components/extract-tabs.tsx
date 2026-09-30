"use client";
import * as React from "react";
import { AlertCircle, CalendarRange, Download, ListChecks, Loader2, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { DocEvent, DocFact, ExtractProgress } from "../types";
import { docsApi, downloadText, errorKind, errorMessage, isAbort, setUrl, UNCONFIGURED_MESSAGE, type ApiErrorKind } from "./api";
import { formatPreciseDate, groupByYear, safeFileName, sortEvents, toCsv } from "./format";
import { FilePicker } from "./file-picker";
import { Notice, SurfaceState } from "./notice";
import type { ViewerTarget } from "./text-viewer";

// ---- extraction driver ----------------------------------------------------------------------------------------------

export interface ExtractionRun {
  running: boolean;
  processed: number;
  failed: number;
  remaining: number;
  errors: ExtractProgress["errors"];
  /** Why the run ended when it did not simply finish. */
  stopped?: "cancelled" | "stalled" | "error";
  message?: string;
  kind?: ApiErrorKind;
  finishedAt?: number;
}

/** Drives POST /extract until `remaining` is 0 (each call processes a few files), with cancel. */
export function useExtraction(setId: string, onProgress: () => void) {
  const [run, setRun] = React.useState<ExtractionRun | null>(null);
  const ctrlRef = React.useRef<AbortController | null>(null);
  const onProgressRef = React.useRef(onProgress);
  onProgressRef.current = onProgress;

  const start = React.useCallback(async () => {
    if (ctrlRef.current) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const acc: ExtractionRun = { running: true, processed: 0, failed: 0, remaining: 0, errors: [] };
    setRun({ ...acc });
    let lastRemaining = Infinity;
    let stalls = 0;
    try {
      for (;;) {
        const r = await docsApi<ExtractProgress>(setUrl(setId, "/extract"), { json: {}, signal: ctrl.signal });
        acc.processed += r.processed; acc.failed += r.failed; acc.remaining = r.remaining;
        acc.errors = [...acc.errors, ...r.errors];
        setRun({ ...acc });
        onProgressRef.current();
        if (r.remaining <= 0) break;
        // Guard against a server that makes no progress (e.g. files that keep failing stay "remaining").
        if (r.processed === 0 && r.remaining >= lastRemaining) { if (++stalls >= 2) { acc.stopped = "stalled"; acc.message = `${r.remaining} file${r.remaining === 1 ? "" : "s"} could not be processed; try again later.`; break; } } else stalls = 0;
        lastRemaining = r.remaining;
      }
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) acc.stopped = "cancelled";
      else { acc.stopped = "error"; acc.kind = errorKind(e); acc.message = acc.kind === "unconfigured" ? UNCONFIGURED_MESSAGE : errorMessage(e); }
    } finally {
      ctrlRef.current = null;
      setRun({ ...acc, running: false, finishedAt: Date.now() });
      onProgressRef.current();
    }
  }, [setId]);

  const cancel = React.useCallback(() => ctrlRef.current?.abort(), []);
  React.useEffect(() => () => ctrlRef.current?.abort(), []);
  return { run, start, cancel, dismiss: () => setRun(null) };
}

export type Extraction = ReturnType<typeof useExtraction>;

function ExtractBar({ extraction, aiReady, extracted, total }: { extraction: Extraction; aiReady: boolean | null; extracted: number | null; total: number | null }) {
  const { run } = extraction;
  const all = run ? run.processed + run.failed + run.remaining : 0;
  const pct = run && all ? Math.round(((run.processed + run.failed) / all) * 100) : 0;
  const upToDate = extracted != null && total != null && total > 0 && extracted >= total;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void extraction.start()} disabled={!!run?.running || aiReady === false || total === 0} variant={upToDate ? "outline" : "default"}>
          {run?.running ? <Loader2 className="size-3.5 animate-spin" /> : upToDate ? <RefreshCw className="size-3.5" /> : <ListChecks className="size-3.5" />}
          {upToDate ? "Check for new files" : "Extract facts & events"}
        </Button>
        {run?.running && <Button size="sm" variant="ghost" onClick={extraction.cancel}><X className="size-3.5" /> Cancel</Button>}
        <span className="text-[12px] text-muted-foreground">
          {extracted != null && total != null ? (total === 0 ? "No files in this set yet." : `${extracted.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} file${total === 1 ? "" : "s"} extracted`) : null}
        </span>
      </div>
      {aiReady === false && <Notice tone="warning">{UNCONFIGURED_MESSAGE}</Notice>}
      {run && (run.running || run.processed || run.failed || run.stopped) ? (
        <div className="rounded-md border px-3 py-2">
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="font-medium">{run.running ? "Extracting" : run.stopped === "cancelled" ? "Extraction cancelled" : run.stopped ? "Extraction stopped" : "Extraction finished"}</span>
            <span className="text-muted-foreground">{run.processed} processed · {run.remaining} remaining{run.failed ? ` · ${run.failed} failed` : ""}</span>
            {!run.running && <Button size="xs" variant="ghost" className="ms-auto" onClick={extraction.dismiss}>Dismiss</Button>}
          </div>
          <Progress value={run.running || run.remaining ? pct : 100} className="mt-1.5 h-1" aria-label="Extraction progress" />
          {run.message && <p className={cn("mt-1.5 text-[12px]", run.stopped === "error" ? "text-destructive" : "text-muted-foreground")}>{run.message}</p>}
          {run.errors.length > 0 && (
            <ul className="mt-1.5 max-h-24 space-y-0.5 overflow-y-auto text-[11.5px] scrollbar-thin">
              {run.errors.map((e, i) => <li key={`${e.fileId}-${i}`}><span className="font-medium">{e.name}</span> <span className="text-destructive">— {e.error}</span></li>)}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---- shared list pieces ---------------------------------------------------------------------------------------------

type ListLoad<T> = { status: "loading" } | { status: "ready"; items: T[]; extracted: number; total: number } | { status: "error"; message: string; kind: ApiErrorKind };

function useList<T>(url: string, key: string, refreshKey: number) {
  const [load, setLoad] = React.useState<ListLoad<T>>({ status: "loading" });
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      docsApi<Record<string, unknown> & { extracted: number; total: number }>(url, { signal: ac.signal })
        .then((r) => setLoad({ status: "ready", items: (r[key] as T[]) ?? [], extracted: r.extracted, total: r.total }))
        .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorMessage(e), kind: errorKind(e) }); });
    }, 200);
    return () => { clearTimeout(t); ac.abort(); };
  }, [url, key, refreshKey, reload]);
  return { load, retry: () => setReload((n) => n + 1) };
}

function SourceLink({ fileName, page, onOpen }: { fileName: string; page: number | null; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="inline-flex max-w-full items-center gap-1 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" title={`Open ${fileName}${page != null ? ` at page ${page}` : ""}`}>
      <span className="truncate">{fileName}</span>{page != null && <span className="shrink-0 tabular">· p. {page}</span>}
    </button>
  );
}

function Quote({ quote, found }: { quote: string; found: boolean }) {
  if (!quote) return null;
  return (
    <div className="mt-1 text-[12px] leading-snug">
      <span className="italic text-muted-foreground">“{quote}”</span>
      {!found && <span className="ms-1.5 whitespace-nowrap rounded-sm border border-dashed border-warning/60 px-1 text-[10.5px] font-medium not-italic text-warning-foreground dark:text-warning" title="The quoted words were not found in the stored text of this file. Check the page before relying on this item.">quote not found in text</span>}
    </div>
  );
}

const STEP = 200;

function ListBody<T>({ load, retry, render, emptyTitle, emptyText, filtered, onClear }: {
  load: ListLoad<T>; retry: () => void; render: (items: T[]) => React.ReactNode; emptyTitle: string; emptyText: string; filtered: boolean; onClear: () => void;
}) {
  if (load.status === "loading") return <div className="flex items-center gap-2 px-1 py-6 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>;
  if (load.status === "error") {
    return load.kind === "denied"
      ? <SurfaceState title="Not found or no access">{load.message}</SurfaceState>
      : <SurfaceState icon={AlertCircle} title="Could not load" action={<Button size="xs" variant="ghost" onClick={retry}><RotateCcw className="size-3.5" /> Try again</Button>}>{load.message}</SurfaceState>;
  }
  if (!load.items.length) {
    return filtered
      ? <SurfaceState title="Nothing matches these filters" action={<Button size="xs" variant="ghost" onClick={onClear}>Clear filters</Button>} />
      : <SurfaceState title={emptyTitle}>{emptyText}</SurfaceState>;
  }
  return <>{render(load.items)}</>;
}

function Toolbar({ setId, q, setQ, fileIds, setFileIds, children, count, onExport }: {
  setId: string; q: string; setQ: (v: string) => void; fileIds: string[]; setFileIds: (v: string[]) => void; children?: React.ReactNode; count: React.ReactNode; onExport?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-[240px]">
        <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input size="xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text" aria-label="Search text" className="ps-7" />
      </div>
      <FilePicker setId={setId} value={fileIds} onChange={(ids) => setFileIds(ids)} placeholder="All files" />
      {children}
      <span className="ms-auto text-[12px] tabular text-muted-foreground">{count}</span>
      {onExport && <Button size="xs" variant="outline" onClick={onExport}><Download className="size-3.5" /> CSV</Button>}
    </div>
  );
}

function PartialNote({ load }: { load: ListLoad<unknown> }) {
  if (load.status !== "ready" || load.total === 0 || load.extracted >= load.total) return null;
  return <Notice>Showing results from {load.extracted.toLocaleString("en-IN")} of {load.total.toLocaleString("en-IN")} files. Run extraction to include the rest.</Notice>;
}

// ---- Facts ----------------------------------------------------------------------------------------------------------

const CATEGORIES: DocFact["category"][] = ["party", "date", "amount", "obligation", "event", "admission", "claim", "other"];
const CATEGORY_LABEL: Record<DocFact["category"], string> = { party: "Party", date: "Date", amount: "Amount", obligation: "Obligation", event: "Event", admission: "Admission", claim: "Claim", other: "Other" };
const ALL = "__all__";

export function FactsTab({ setId, setName, extraction, aiReady, refreshKey, onView }: { setId: string; setName: string; extraction: Extraction; aiReady: boolean | null; refreshKey: number; onView: (t: ViewerTarget) => void }) {
  const [q, setQ] = React.useState("");
  const [fileIds, setFileIds] = React.useState<string[]>([]);
  const [category, setCategory] = React.useState<string>(ALL);
  const [shown, setShown] = React.useState(STEP);
  const sp = new URLSearchParams();
  if (fileIds[0]) sp.set("file", fileIds[0]);
  if (q.trim()) sp.set("q", q.trim());
  if (category !== ALL) sp.set("category", category);
  const { load, retry } = useList<DocFact>(setUrl(setId, `/facts${sp.size ? `?${sp}` : ""}`), "facts", refreshKey);
  React.useEffect(() => setShown(STEP), [q, fileIds, category]);
  const items = load.status === "ready" ? load.items : [];
  const filtered = !!q.trim() || fileIds.length > 0 || category !== ALL;

  const exportCsv = () => downloadText(`${safeFileName(setName)} - facts.csv`, toCsv(
    ["Statement", "Category", "Parties", "Date", "File", "Page", "Quote", "Quote found in text"],
    items.map((f) => [f.statement, CATEGORY_LABEL[f.category] ?? f.category, f.parties, f.date ? formatPreciseDate(f.date, f.datePrecision) : "", f.fileName, f.page ?? "", f.quote, f.quoteFound ? "yes" : "no"]),
  ));

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1100px] space-y-3 p-3">
        <ExtractBar extraction={extraction} aiReady={aiReady} extracted={load.status === "ready" ? load.extracted : null} total={load.status === "ready" ? load.total : null} />
        <Toolbar setId={setId} q={q} setQ={setQ} fileIds={fileIds} setFileIds={setFileIds}
          count={load.status === "ready" ? `${items.length.toLocaleString("en-IN")} fact${items.length === 1 ? "" : "s"}` : null}
          onExport={items.length ? exportCsv : undefined}>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger size="xs" className="w-[140px]" aria-label="Category"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}</SelectItem>)}
            </SelectContent>
          </Select>
        </Toolbar>
        <PartialNote load={load} />
        <ListBody load={load} retry={retry} filtered={filtered} onClear={() => { setQ(""); setFileIds([]); setCategory(ALL); }}
          emptyTitle="No facts yet" emptyText="Extract facts & events to list the key facts stated in these files, each with the page and the words it comes from."
          render={(list) => (
            <>
              <ul className="divide-y rounded-md border">
                {list.slice(0, shown).map((f) => (
                  <li key={f.id} className="grid gap-x-4 gap-y-1 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(160px,220px)]">
                    <div className="min-w-0">
                      <div className="text-[13px] leading-snug">{f.statement}</div>
                      <Quote quote={f.quote} found={f.quoteFound} />
                    </div>
                    <div className="min-w-0 space-y-0.5 text-[12px] sm:text-right">
                      <div className="flex flex-wrap items-center gap-x-2 sm:justify-end">
                        <span className="rounded-sm bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{CATEGORY_LABEL[f.category] ?? f.category}</span>
                        {f.date && <span className="tabular text-muted-foreground">{formatPreciseDate(f.date, f.datePrecision)}</span>}
                      </div>
                      {f.parties.length > 0 && <div className="truncate text-muted-foreground" title={f.parties.join(", ")}>{f.parties.join(", ")}</div>}
                      <SourceLink fileName={f.fileName} page={f.page} onOpen={() => onView({ fileId: f.fileId, page: f.page, highlight: f.quote, name: f.fileName })} />
                    </div>
                  </li>
                ))}
              </ul>
              {list.length > shown && <div className="text-center"><Button size="xs" variant="ghost" onClick={() => setShown((n) => n + STEP)}>Show {Math.min(STEP, list.length - shown)} more of {(list.length - shown).toLocaleString("en-IN")}</Button></div>}
            </>
          )}
        />
      </div>
    </div>
  );
}

// ---- Timeline -------------------------------------------------------------------------------------------------------

export function TimelineTab({ setId, setName, extraction, aiReady, refreshKey, onView }: { setId: string; setName: string; extraction: Extraction; aiReady: boolean | null; refreshKey: number; onView: (t: ViewerTarget) => void }) {
  const [q, setQ] = React.useState("");
  const [fileIds, setFileIds] = React.useState<string[]>([]);
  const [shown, setShown] = React.useState(STEP);
  const sp = new URLSearchParams();
  if (fileIds[0]) sp.set("file", fileIds[0]);
  if (q.trim()) sp.set("q", q.trim());
  const { load, retry } = useList<DocEvent>(setUrl(setId, `/timeline${sp.size ? `?${sp}` : ""}`), "events", refreshKey);
  React.useEffect(() => setShown(STEP), [q, fileIds]);
  const sorted = React.useMemo(() => (load.status === "ready" ? sortEvents(load.items) : []), [load]);
  const filtered = !!q.trim() || fileIds.length > 0;

  const exportCsv = () => downloadText(`${safeFileName(setName)} - timeline.csv`, toCsv(
    ["Date", "Precision", "Date as written", "Event", "Parties", "File", "Page", "Quote", "Quote found in text"],
    sorted.map((e) => [e.date, e.datePrecision, e.dateText, e.description, e.parties, e.fileName, e.page ?? "", e.quote, e.quoteFound ? "yes" : "no"]),
  ));

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1100px] space-y-3 p-3">
        <ExtractBar extraction={extraction} aiReady={aiReady} extracted={load.status === "ready" ? load.extracted : null} total={load.status === "ready" ? load.total : null} />
        <Toolbar setId={setId} q={q} setQ={setQ} fileIds={fileIds} setFileIds={setFileIds}
          count={load.status === "ready" ? `${sorted.length.toLocaleString("en-IN")} event${sorted.length === 1 ? "" : "s"}` : null}
          onExport={sorted.length ? exportCsv : undefined} />
        <PartialNote load={load} />
        <ListBody load={{ ...load, ...(load.status === "ready" ? { items: sorted } : {}) } as ListLoad<DocEvent>} retry={retry} filtered={filtered} onClear={() => { setQ(""); setFileIds([]); }}
          emptyTitle="No events yet" emptyText="Extract facts & events to build a dated timeline from these files. Events without a date the documents state are left out."
          render={(list) => (
            <>
              <div className="space-y-4">
                {groupByYear(list.slice(0, shown)).map((g) => (
                  <section key={g.year} aria-label={g.year}>
                    <h3 className="sticky top-0 z-[1] bg-background/95 py-1 text-[12px] font-semibold tabular text-muted-foreground backdrop-blur">{g.year}</h3>
                    <ol className="divide-y rounded-md border">
                      {g.items.map((e) => (
                        <li key={e.id} className="grid gap-x-4 gap-y-1 px-3 py-2.5 sm:grid-cols-[110px_minmax(0,1fr)_minmax(150px,220px)]">
                          <div className="text-[12.5px] font-medium tabular" title={e.dateText ? `As written: ${e.dateText}` : undefined}>
                            {formatPreciseDate(e.date, e.datePrecision)}
                            {e.datePrecision !== "day" && <div className="text-[10.5px] font-normal text-muted-foreground">{e.datePrecision === "month" ? "month only" : "year only"}</div>}
                          </div>
                          <div className="min-w-0">
                            <div className="text-[13px] leading-snug">{e.description}</div>
                            {e.parties.length > 0 && <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{e.parties.join(", ")}</div>}
                            <Quote quote={e.quote} found={e.quoteFound} />
                          </div>
                          <div className="min-w-0 sm:text-right">
                            <SourceLink fileName={e.fileName} page={e.page} onOpen={() => onView({ fileId: e.fileId, page: e.page, highlight: e.quote, name: e.fileName })} />
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
              </div>
              {list.length > shown && <div className="text-center"><Button size="xs" variant="ghost" onClick={() => setShown((n) => n + STEP)}>Show {Math.min(STEP, list.length - shown)} more of {(list.length - shown).toLocaleString("en-IN")}</Button></div>}
            </>
          )}
        />
      </div>
    </div>
  );
}

export const TAB_ICONS = { facts: ListChecks, timeline: CalendarRange };
