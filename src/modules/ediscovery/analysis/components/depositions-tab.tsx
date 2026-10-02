"use client";
import * as React from "react";
import { Search, ScrollText, Highlighter, Download, FileText, Loader2, RefreshCw, X, Gavel, Paperclip, Flag, CalendarClock, ChevronRight, Trash2, Pencil, Check, BookOpenText, PanelRightClose, PanelRightOpen, ListChecks, Link2, Upload, PenLine } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/misc";
import { PersonAvatar } from "@/components/ui/avatar";
import { Tip } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Markdown } from "@/components/ai/markdown";
import type { Deposition, DepositionQA } from "@/lib/types/domain";
import { OBJECTION_RULINGS, QA_FLAGS, formatPageLine, formatRange, type AnalysisTabProps, type Designation, type DepositionSummary, type ObjectionRuling, type QAFlag } from "../types";
import { designationTotals, resolvePageLine } from "../transcript";
import { OBJECTION_BASES } from "../types";
import { TranscriptViewer } from "./transcript-viewer";
import { FLAG_STYLES, FlagBadge, ListSkeleton, NoKeyCallout, ObjectionBadge, KeyHint, ProvenanceBadge, formatShortDate, typingTarget, useNarrowViewport, OBJECTION_STYLES } from "./shared";
import { ImportTranscriptDialog } from "./import-dialog";
import { CrossReferencesPanel } from "./cross-references-panel";
import { api, downloadFile, exportMarkdownToWord, isNoKey, useDeposition, useDepositions, useOverview, useTranscriptSearch, type DepositionDetail } from "./use-analysis-data";

type SidePanel = "digest" | "designations" | "objections" | "exhibits" | "references" | "flags";

const STATUS_BADGE: Record<Deposition["status"], { label: string; variant: "success" | "info" | "muted" }> = { reviewed: { label: "Reviewed", variant: "success" }, transcribed: { label: "Transcribed", variant: "info" }, scheduled: { label: "Scheduled", variant: "muted" } };

export function DepositionsTab({ matterId, onOpenDocument }: AnalysisTabProps) {
  const deps = useDepositions(matterId);
  const overview = useOverview(matterId);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [jumpIndex, setJumpIndex] = React.useState<number | string | null>(null);
  const [q, setQ] = React.useState("");
  const [outlineOpen, setOutlineOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const list = React.useMemo(() => deps.data?.depositions ?? [], [deps.data]);

  React.useEffect(() => {
    if (!selectedId && list.length) {
      const url = new URL(window.location.href);
      const fromUrl = url.searchParams.get("depo");
      const qa = url.searchParams.get("qa");
      setSelectedId(fromUrl && list.some((d) => d.id === fromUrl) ? fromUrl : list.find((d) => d.status !== "scheduled")?.id ?? list[0].id);
      // ?qa= is a Q/A index or a page:line locator ("24:5"); the transcript resolves the latter.
      if (fromUrl && qa && /^\d+$/.test(qa)) setJumpIndex(Number(qa));
      else if (fromUrl && qa && /^\d+:\d+$/.test(qa)) setJumpIndex(qa);
    }
  }, [list, selectedId]);

  React.useEffect(() => {
    if (!selectedId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("depo", selectedId);
    window.history.replaceState(window.history.state, "", url.toString());
    return () => { const u = new URL(window.location.href); u.searchParams.delete("depo"); u.searchParams.delete("qa"); window.history.replaceState(window.history.state, "", u.toString()); };
  }, [selectedId]);

  const openHit = (depositionId: string, index: number) => { setSelectedId(depositionId); setJumpIndex(index); };

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[300px] shrink-0 flex-col border-r bg-sidebar/40">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input id="depo-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={'Search all transcripts…  (" for phrase)'} className="h-8 pl-7 pr-7 text-xs" aria-label="Search transcripts" />
            {q && <button type="button" onClick={() => setQ("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent cursor-pointer" aria-label="Clear"><X className="size-3.5" /></button>}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
          {q.trim() ? <SearchResults matterId={matterId} q={q} onOpen={openHit} /> : (
            deps.loading && !deps.data ? <ListSkeleton rows={5} /> : !list.length ? <div className="p-4"><EmptyState icon={ScrollText} title="No depositions yet" description="Import a transcript (.txt, .ptx, .asc or .docx) to read it by page and line, flag testimony and designate ranges." compact /></div> : (
              <ul className="p-1.5">
                {list.map((d) => <DepositionRow key={d.id} d={d} active={d.id === selectedId} onClick={() => { setSelectedId(d.id); setJumpIndex(null); }} />)}
              </ul>
            )
          )}
        </div>
        <div className="grid grid-cols-2 gap-1.5 border-t p-2">
          <Button size="sm" variant="outline" className="justify-start" onClick={() => setImportOpen(true)}><Upload className="size-4" /> Import</Button>
          <KeyHint configured={!!overview.data?.aiConfigured}>
            <Button size="sm" variant="outline" className="justify-start" onClick={() => setOutlineOpen(true)}><BookOpenText className="size-4" /> Prepare outline</Button>
          </KeyHint>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {selectedId ? (
          <DepositionView key={selectedId} id={selectedId} matterId={matterId} jumpIndex={jumpIndex} onJumped={() => setJumpIndex(null)} aiConfigured={!!overview.data?.aiConfigured} onOpenDocument={onOpenDocument} onChanged={deps.refresh} />
        ) : (
          <div className="flex h-full items-center justify-center p-8">{deps.loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : !list.length ? <EmptyState icon={ScrollText} title="No transcripts in this matter" description="Imported transcripts are parsed into page:line Q/A, speakers, objections and exhibits." action={<Button size="sm" onClick={() => setImportOpen(true)}><Upload className="size-4" /> Import transcript</Button>} /> : <EmptyState icon={ScrollText} title="Select a deposition" description="Choose a witness on the left to read the transcript, flag testimony and designate ranges." />}</div>
        )}
      </div>
      <OutlineDialog open={outlineOpen} onOpenChange={setOutlineOpen} matterId={matterId} depositions={list} aiConfigured={!!overview.data?.aiConfigured} />
      <ImportTranscriptDialog open={importOpen} onOpenChange={setImportOpen} matterId={matterId} depositions={list} onImported={(dep) => { deps.refresh(); overview.refresh(); setSelectedId(dep.id); setJumpIndex(null); }} />
    </div>
  );
}

function DepositionRow({ d, active, onClick }: { d: DepositionSummary; active: boolean; onClick: () => void }) {
  const s = STATUS_BADGE[d.status];
  return (
    <li>
      <button type="button" onClick={onClick} className={cn("flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors cursor-pointer", active ? "bg-accent text-accent-foreground" : "hover:bg-sidebar-accent")} aria-current={active ? "true" : undefined}>
        <PersonAvatar name={d.witnessName} size="sm" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5"><span className="truncate text-[13px] font-medium">{d.witnessName}</span>{d.volume && d.volume > 1 && <span className="text-[10px] text-muted-foreground">Vol. {d.volume}</span>}</div>
          <div className="truncate text-[11px] text-muted-foreground">{d.witnessTitle?.split(",")[0] ?? "Witness"}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10.5px] text-muted-foreground">
            <span className="tabular">{formatShortDate(d.date)}</span>
            <span>·</span>
            <span>{d.status === "scheduled" ? "not yet taken" : `${d.pages} pp · ${d.qaCount} Q/A`}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge variant={s.variant} className="h-[16px] px-1 py-0 text-[10px]">{s.label}</Badge>
            {d.hasDigest && <span className="text-[10px] text-muted-foreground">digest</span>}
            {d.flagCounts.admission > 0 && <span className="inline-flex items-center gap-0.5 text-[10px] text-success"><FLAG_STYLES.admission.icon className="size-2.5" />{d.flagCounts.admission}</span>}
            {d.flagCounts.contradiction > 0 && <span className="inline-flex items-center gap-0.5 text-[10px] text-destructive"><FLAG_STYLES.contradiction.icon className="size-2.5" />{d.flagCounts.contradiction}</span>}
            {d.designationCount > 0 && <span className="inline-flex items-center gap-0.5 text-[10px] text-chart-2"><Highlighter className="size-2.5" />{d.designationCount}</span>}
          </div>
        </div>
      </button>
    </li>
  );
}

function SearchResults({ matterId, q, onOpen }: { matterId: string; q: string; onOpen: (depositionId: string, index: number) => void }) {
  const [debounced, setDebounced] = React.useState(q);
  React.useEffect(() => { const t = setTimeout(() => setDebounced(q), 150); return () => clearTimeout(t); }, [q]);
  const res = useTranscriptSearch(matterId, debounced);
  if (res.loading && !res.data) return <ListSkeleton rows={4} />;
  const hits = res.data?.hits ?? [];
  if (!hits.length) return <div className="p-4 text-center text-xs text-muted-foreground">No testimony matches “{debounced}”.</div>;
  return (
    <div>
      <div className="px-3 pt-2 pb-1 text-[12px] font-medium text-muted-foreground">{hits.length} hit{hits.length === 1 ? "" : "s"} across transcripts</div>
      <ul className="px-1.5 pb-2">
        {hits.map((h) => (
          <li key={`${h.depositionId}:${h.index}:${h.field}`}>
            <button type="button" onClick={() => onOpen(h.depositionId, h.index)} className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent cursor-pointer">
              <div className="flex items-center gap-1.5 text-[11px]"><span className="font-medium">{h.witnessName}</span><span className="font-mono text-muted-foreground">{formatPageLine(h.page, h.line)}</span><span className="text-[10.5px] text-muted-foreground">{h.field === "answer" ? "A" : h.field === "question" ? "Q" : h.field}</span></div>
              <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted-foreground">{h.snippet}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DepositionView({ id, matterId, jumpIndex, onJumped, aiConfigured, onOpenDocument, onChanged }: { id: string; matterId: string; jumpIndex: number | string | null; onJumped: () => void; aiConfigured: boolean; onOpenDocument?: (docId: string) => void; onChanged: () => void }) {
  const detail = useDeposition(id);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [find, setFind] = React.useState("");
  const [flagFilter, setFlagFilter] = React.useState<QAFlag | null>(null);
  const [panel, setPanel] = React.useState<SidePanel>("digest");
  const [designating, setDesignating] = React.useState(false);
  const [selection, setSelection] = React.useState<{ start?: { page: number; line: number; index: number }; end?: { page: number; line: number; index: number } }>({});
  const [purpose, setPurpose] = React.useState<Designation["purpose"]>("affirmative");
  const [digesting, setDigesting] = React.useState(false);
  const [noKey, setNoKey] = React.useState(false);
  // Below 1280px the transcript column cannot share the width with the 340px side panel (the shell sidebar and the
  // deposition list already take ~540px), so the panel becomes an overlay that is closed by default.
  const narrow = useNarrowViewport(1280);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const panelVisible = !narrow || panelOpen;
  const showPanel = (p: SidePanel) => { setPanel(p); if (narrow) setPanelOpen(true); };
  const dep = detail.data?.deposition;
  const transcript = React.useMemo(() => dep?.transcript ?? [], [dep]);
  const exhibitDocIds = React.useMemo(() => Object.fromEntries((detail.data?.exhibits ?? []).map((e) => [e.id, e.docId])), [detail.data]);

  React.useEffect(() => {
    if (jumpIndex == null || !transcript.length) return;
    const idx = typeof jumpIndex === "number" ? Math.min(transcript.length - 1, Math.max(0, jumpIndex)) : resolvePageLine(transcript, jumpIndex);
    if (idx >= 0) { setActiveIndex(idx); setFlagFilter(null); }
    else toast.info(`${jumpIndex} is not in the excerpted transcript`, { description: "Use find-in-transcript to locate nearby testimony." });
    onJumped();
  }, [jumpIndex, transcript, onJumped]);

  const findHits = React.useMemo(() => {
    const t = find.trim().toLowerCase();
    if (!t) return [] as number[];
    return transcript.map((qa, i) => (`${qa.question} ${qa.answer} ${qa.objection?.text ?? ""} ${qa.note ?? ""}`.toLowerCase().includes(t) ? i : -1)).filter((i) => i >= 0);
  }, [find, transcript]);
  const findPos = findHits.indexOf(activeIndex);
  const stepFind = (dir: 1 | -1) => { if (!findHits.length) return; const next = findHits[(findPos + dir + findHits.length) % findHits.length]; setActiveIndex(next); };

  const patchQA = React.useCallback((index: number, qa: DepositionQA) => detail.mutate((cur) => (cur ? { ...cur, deposition: { ...cur.deposition, transcript: cur.deposition.transcript.map((x, i) => (i === index ? qa : x)) } } : cur)), [detail]);
  const toggleFlag = async (index: number, flag: QAFlag) => {
    try { const r = await api<{ qa: DepositionQA }>(`/api/ediscovery/analysis/depositions/${id}`, { method: "PATCH", json: { index, toggle: flag } }); patchQA(index, r.qa); onChanged(); }
    catch (e) { toast.error("Could not update flag", { description: (e as Error).message }); }
  };
  const saveNote = async (index: number, note: string) => {
    try { const r = await api<{ qa: DepositionQA }>(`/api/ediscovery/analysis/depositions/${id}`, { method: "PATCH", json: { index, note: note.trim() || null } }); patchQA(index, r.qa); toast.success(note.trim() ? "Note saved" : "Note cleared"); }
    catch (e) { toast.error("Could not save note", { description: (e as Error).message }); }
  };

  const pickBoundary = (qa: DepositionQA, index: number) => {
    setSelection((s) => {
      if (!s.start || s.end) return { start: { page: qa.page, line: qa.line, index } };
      return { ...s, end: { page: qa.page, line: qa.line, index } };
    });
  };
  const commitDesignation = async () => {
    if (!selection.start) return;
    const end = selection.end ?? selection.start;
    try {
      const r = await api<{ designation: Designation }>(`/api/ediscovery/analysis/depositions/${id}/designations`, { method: "POST", json: { startPage: selection.start.page, startLine: selection.start.line, endPage: end.page, endLine: end.line, purpose } });
      detail.mutate((cur) => (cur ? { ...cur, designations: [...cur.designations, r.designation].sort((a, b) => a.startPage - b.startPage || a.startLine - b.startLine) } : cur));
      setSelection({});
      showPanel("designations");
      onChanged();
      toast.success(`Designated ${formatRange(r.designation)}`, { description: purpose });
    } catch (e) { toast.error("Could not save designation", { description: (e as Error).message }); }
  };
  const removeDesignation = async (d: Designation) => {
    try { await api(`/api/ediscovery/analysis/depositions/${id}/designations?id=${d.id}`, { method: "DELETE" }); detail.mutate((cur) => (cur ? { ...cur, designations: cur.designations.filter((x) => x.id !== d.id) } : cur)); onChanged(); }
    catch (e) { toast.error("Could not delete designation", { description: (e as Error).message }); }
  };
  const updateDesignation = async (d: Designation, patch: Partial<Designation>) => {
    try { const r = await api<{ designation: Designation }>(`/api/ediscovery/analysis/depositions/${id}/designations`, { method: "PATCH", json: { id: d.id, ...patch } }); detail.mutate((cur) => (cur ? { ...cur, designations: cur.designations.map((x) => (x.id === d.id ? r.designation : x)) } : cur)); }
    catch (e) { toast.error("Could not update designation", { description: (e as Error).message }); }
  };

  const setRuling = async (index: number, ruling: ObjectionRuling) => {
    try {
      const r = await api<{ objections: DepositionDetail["objections"]; rulings: Record<number, ObjectionRuling> }>(`/api/ediscovery/analysis/depositions/${id}`, { method: "PATCH", json: { index, ruling } });
      detail.mutate((cur) => (cur ? { ...cur, objections: r.objections, rulings: r.rulings } : cur));
    } catch (e) { toast.error("Could not record ruling", { description: (e as Error).message }); }
  };

  const runDigest = async (force = false) => {
    setDigesting(true);
    setNoKey(false);
    try {
      const r = await api<{ digest: NonNullable<Deposition["aiDigest"]> }>(`/api/ediscovery/analysis/depositions/${id}/digest`, { method: "POST", json: { force } });
      detail.mutate((cur) => (cur ? { ...cur, deposition: { ...cur.deposition, aiDigest: r.digest } } : cur));
      onChanged();
      toast.success("Digest ready", { description: `${r.digest.keyAdmissions.length} key admissions · ${r.digest.themes.length} themes` });
    } catch (e) { if (isNoKey(e)) setNoKey(true); else toast.error("Digest failed", { description: (e as Error).message }); }
    finally { setDigesting(false); }
  };

  const exportDesignations = async (format: "csv" | "word") => {
    if (format === "csv") { downloadFile(`/api/ediscovery/analysis/depositions/${id}/designations?format=csv`); return; }
    try {
      const md = await api<{ title: string; markdown: string; count: number }>(`/api/ediscovery/analysis/depositions/${id}/designations?format=markdown`);
      await exportMarkdownToWord({ title: md.title, markdown: md.markdown, matterId, tags: ["designations", "deposition", "ediscovery"], meta: { depositionId: id, count: md.count }, description: `${md.count} designation${md.count === 1 ? "" : "s"} · filed in the matter folder` });
    } catch (e) { toast.error("Export failed", { description: (e as Error).message }); }
  };

  const openExhibit = (ref: string) => {
    const docId = exhibitDocIds[ref];
    if (docId && onOpenDocument) onOpenDocument(docId);
    else toast.info(`Exhibit ${ref} is not in this workspace`, { description: detail.data?.exhibits.find((e) => e.id === ref)?.description });
  };

  // Keyboard: j/k move, a/c/e/x flags, d designate mode, Enter commits designation, Esc cancels.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!transcript.length) return;
      if (e.key === "j") { e.preventDefault(); setActiveIndex((i) => Math.min(transcript.length - 1, i + 1)); }
      else if (e.key === "k") { e.preventDefault(); setActiveIndex((i) => Math.max(0, i - 1)); }
      else if (e.key === "a") void toggleFlag(activeIndex, "admission");
      else if (e.key === "c") void toggleFlag(activeIndex, "contradiction");
      else if (e.key === "e") void toggleFlag(activeIndex, "evasive");
      else if (e.key === "x") void toggleFlag(activeIndex, "key");
      else if (e.key === "d") { setDesignating((v) => !v); setSelection({}); }
      else if (e.key === "Enter" && designating && selection.start) void commitDesignation();
      else if (e.key === "Escape" && designating) { setDesignating(false); setSelection({}); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript.length, activeIndex, designating, selection]);

  if (detail.loading && !detail.data) return <div className="p-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="mt-3 h-4 w-1/3" /><div className="mt-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div></div>;
  if (!dep) return <div className="p-8"><EmptyState icon={ScrollText} title="Deposition not found" /></div>;

  const status = STATUS_BADGE[dep.status];
  const summaryCounts = QA_FLAGS.map((f) => ({ ...f, count: transcript.filter((qa) => qa.flags?.includes(f.id)).length })).filter((f) => f.count > 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 pt-3 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <PersonAvatar name={dep.witnessName} size="lg" />
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-base font-semibold leading-tight">Deposition of {dep.witnessName}{dep.volume ? <span className="text-sm font-normal text-muted-foreground">Vol. {dep.volume}</span> : null}<Badge variant={status.variant} className="h-[18px] px-1.5 py-0 text-[10.5px]">{status.label}</Badge></h2>
              <div className="mt-0.5 text-xs text-muted-foreground">{dep.witnessTitle}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><CalendarClock className="size-3" />{formatShortDate(dep.date)}</span>
                <span>Taken by <span className="text-foreground/80">{dep.takenBy}</span></span>
                {dep.defendingBy && <span>Defended by <span className="text-foreground/80">{dep.defendingBy}</span></span>}
                <span className="tabular">{dep.pages} pages · {transcript.length} Q/A excerpted</span>
                {dep.location && <span className="hidden truncate xl:inline">{dep.location}</span>}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <KeyHint configured={aiConfigured}>
              <Button size="sm" variant={dep.aiDigest ? "outline" : "default"} onClick={() => runDigest(!!dep.aiDigest)} disabled={digesting || !transcript.length}>{digesting ? <Loader2 className="size-4 animate-spin" /> : dep.aiDigest ? <RefreshCw className="size-4" /> : <ListChecks className="size-4" />} {dep.aiDigest ? "Re-digest" : "Digest"}</Button>
            </KeyHint>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="outline" disabled={!detail.data?.designations.length}><Download className="size-4" /> Designations</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => exportDesignations("csv")}><Download className="size-4" /> CSV (page/line)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportDesignations("word")}><FileText className="size-4" /> Word document</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {!transcript.length ? (
        <div className="flex flex-1 items-center justify-center p-8"><EmptyState icon={CalendarClock} title={dep.status === "scheduled" ? `Scheduled for ${formatShortDate(dep.date)}` : "No transcript yet"} description={dep.status === "scheduled" ? `${dep.location ?? ""}. Use “Prepare outline for next witness” to build the examination outline from the documents and prior testimony.` : "The transcript has not been loaded."} /></div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); } if (e.key === "Escape") setFind(""); }} placeholder="Find in transcript" className="h-7 w-56 pl-7 pr-16 text-xs" aria-label="Find in transcript" />
                {find && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10.5px] tabular text-muted-foreground">{findHits.length ? `${findPos + 1}/${findHits.length}` : "0/0"}</span>}
              </div>
              <div className="ml-1 flex flex-wrap items-center gap-1">
                <button type="button" onClick={() => setFlagFilter(null)} className={cn("h-6 rounded border px-2 text-[11px] transition-colors cursor-pointer", !flagFilter ? "border-foreground/25 bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}>All</button>
                {summaryCounts.map((f) => { const Icon = FLAG_STYLES[f.id].icon; return <button key={f.id} type="button" onClick={() => setFlagFilter(flagFilter === f.id ? null : f.id)} className={cn("inline-flex h-6 items-center gap-1 rounded border px-2 text-[11px] transition-colors cursor-pointer", flagFilter === f.id ? FLAG_STYLES[f.id].cls : "text-muted-foreground hover:bg-accent")}><Icon className="size-3" />{f.label} <span className="tabular">{f.count}</span></button>; })}
              </div>
              <div className="flex-1" />
              {designating ? (
                <div className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/8 px-2 py-0.5 text-[11px]">
                  <Highlighter className="size-3.5 text-primary" />
                  <span className="text-foreground/90">{selection.start ? (selection.end ? `${formatPageLine(selection.start.page, selection.start.line)} – ${formatPageLine(selection.end.page, selection.end.line)}` : `from ${formatPageLine(selection.start.page, selection.start.line)} — click the end`) : "click the first Q/A"}</span>
                  <Select value={purpose} onValueChange={(v) => setPurpose(v as Designation["purpose"])}>
                    <SelectTrigger size="sm" className="h-6 w-auto gap-1 px-2 text-[11px]"><SelectValue /></SelectTrigger>
                    <SelectContent>{(["affirmative", "counter", "impeachment", "objection"] as const).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                  </Select>
                  <Button size="xs" onClick={commitDesignation} disabled={!selection.start}><Check className="size-3" /> Save</Button>
                  <Button size="xs" variant="ghost" onClick={() => { setDesignating(false); setSelection({}); }}>Cancel</Button>
                </div>
              ) : (
                <Tip label="Designate a page:line range" shortcut="D"><Button size="xs" variant="outline" onClick={() => setDesignating(true)}><Highlighter className="size-3.5" /> Designate</Button></Tip>
              )}
              {narrow && (
                <Tip label={panelOpen ? "Hide digest, designations, objections, exhibits and flags" : "Show digest, designations, objections, exhibits and flags"}>
                  <Button size="icon-xs" variant="ghost" onClick={() => setPanelOpen((v) => !v)} aria-label="Toggle side panel" aria-pressed={panelOpen}>{panelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}</Button>
                </Tip>
              )}
            </div>
            <TranscriptViewer transcript={transcript} activeIndex={activeIndex} onActiveIndex={setActiveIndex} query={find} flagFilter={flagFilter} designations={detail.data?.designations ?? []} selection={selection} designating={designating} onPickBoundary={pickBoundary} onToggleFlag={toggleFlag} onSaveNote={saveNote} onOpenExhibit={openExhibit} exhibitDocIds={exhibitDocIds} className="flex-1" />
            <div className="flex h-7 shrink-0 items-center gap-3 border-t px-3 text-[10.5px] text-muted-foreground">
              <span className="tabular">{formatPageLine(transcript[activeIndex]?.page ?? 0, transcript[activeIndex]?.line ?? 0)} · {activeIndex + 1} of {transcript.length}</span>
              <span className="hidden md:inline"><kbd className="px-1 text-[9.5px]">j</kbd>/<kbd className="px-1 text-[9.5px]">k</kbd> move · <kbd className="px-1 text-[9.5px]">a</kbd> admission · <kbd className="px-1 text-[9.5px]">c</kbd> contradiction · <kbd className="px-1 text-[9.5px]">e</kbd> evasive · <kbd className="px-1 text-[9.5px]">x</kbd> key · <kbd className="px-1 text-[9.5px]">d</kbd> designate</span>
            </div>
          </div>
          {panelVisible && (
          <aside className={cn("flex w-[340px] shrink-0 flex-col border-l bg-background", narrow && "absolute inset-y-0 right-0 z-20 max-w-[85%] shadow-xl")} aria-label="Deposition side panel">
            <nav className="flex shrink-0 items-center gap-0 overflow-x-auto border-b px-1 no-scrollbar" aria-label="Deposition panels">
              {([["digest", "Digest", ListChecks], ["designations", "Designations", Highlighter], ["objections", "Objections", Gavel], ["exhibits", "Exhibits", Paperclip], ["references", "References", Link2], ["flags", "Flags", Flag]] as [SidePanel, string, React.ElementType][]).map(([id, label, Icon]) => (
                <button key={id} type="button" onClick={() => setPanel(id)} className={cn("relative flex h-8 shrink-0 items-center gap-1 px-1.5 text-[11.5px] font-medium transition-colors cursor-pointer", panel === id ? "text-foreground" : "text-muted-foreground hover:text-foreground")} aria-current={panel === id ? "true" : undefined} title={label}>
                  <Icon className="size-3.5" />{label}
                  {panel === id && <span className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary" />}
                </button>
              ))}
              {narrow && <Button size="icon-xs" variant="ghost" className="ml-auto shrink-0" onClick={() => setPanelOpen(false)} aria-label="Close side panel"><X className="size-3.5" /></Button>}
            </nav>
            <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
              {panel === "digest" && <DigestPanel dep={dep} digesting={digesting} noKey={noKey || !aiConfigured} onRun={() => runDigest(false)} onJump={(cite) => { const m = cite.match(/(\d+):(\d+)/); if (!m) return; const idx = resolvePageLine(transcript, `${Number(m[1])}:${Number(m[2])}`); if (idx >= 0) { setFlagFilter(null); setActiveIndex(idx); } else toast.info(`${cite} is not in the excerpted transcript`); }} />}
              {panel === "designations" && <DesignationsPanel detail={detail.data!} onJump={(d) => { const idx = resolvePageLine(transcript, `${d.startPage}:${d.startLine}`); if (idx >= 0) { setFlagFilter(null); setActiveIndex(idx); } }} onRemove={removeDesignation} onUpdate={updateDesignation} onStart={() => { setDesignating(true); setSelection({}); }} />}
              {panel === "objections" && <ObjectionsPanel detail={detail.data!} onJump={(i) => { setFlagFilter(null); setActiveIndex(i); }} onRule={setRuling} />}
              {panel === "references" && <CrossReferencesPanel depositionId={id} onOpenDocument={onOpenDocument} onJump={(i) => { setFlagFilter(null); setActiveIndex(i); }} />}
              {panel === "exhibits" && <ExhibitsPanel detail={detail.data!} onOpen={openExhibit} onJump={(ref) => { const idx = transcript.findIndex((qa) => qa.exhibit === ref); if (idx >= 0) { setFlagFilter(null); setActiveIndex(idx); } }} />}
              {panel === "flags" && <FlagsPanel transcript={transcript} onJump={(i) => { setFlagFilter(null); setActiveIndex(i); }} />}
            </div>
          </aside>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DigestPanel({ dep, digesting, noKey, onRun, onJump }: { dep: Deposition; digesting: boolean; noKey: boolean; onRun: () => void; onJump: (cite: string) => void }) {
  const d = dep.aiDigest;
  if (!d) {
    return (
      <div className="space-y-3 p-3">
        {noKey ? <NoKeyCallout feature="Deposition digests" compact /> : (
          <EmptyState icon={ListChecks} title="No digest yet" description="Summary, key admissions with page:line cites, themes, credibility notes and follow-up questions; every cite is checked against the transcript and the result carries a trust badge." action={<Button size="sm" onClick={onRun} disabled={digesting || !dep.transcript.length}>{digesting ? <Loader2 className="size-4 animate-spin" /> : <ListChecks className="size-4" />} Digest transcript</Button>} />
        )}
      </div>
    );
  }
  const Cite = ({ text }: { text: string }) => {
    const m = text.match(/^(\d+:\d+)\s*[—–-]\s*(.*)$/s);
    if (!m) return <span>{text}</span>;
    return <><button type="button" onClick={() => onJump(m[1])} className="mr-1.5 rounded border border-chart-2/25 bg-chart-2/10 px-1 font-mono text-[10.5px] text-chart-2 hover:bg-accent cursor-pointer">{m[1]}</button><span>{m[2]}</span></>;
  };
  const withCites = (text: string) => {
    const parts = text.split(/(\b\d{1,3}:\d{2}\b)/g);
    return parts.map((p, i) => (/^\d{1,3}:\d{2}$/.test(p) ? <button key={i} type="button" onClick={() => onJump(p)} className="rounded border border-chart-2/25 bg-chart-2/10 px-1 font-mono text-[10.5px] text-chart-2 hover:bg-accent cursor-pointer">{p}</button> : <React.Fragment key={i}>{p}</React.Fragment>));
  };
  return (
    <div className="space-y-4 p-3 text-[12.5px]">
      <section>
        <h4 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">Summary <ProvenanceBadge record={d} compact={false} className="normal-case tracking-normal" /></h4>
        <p className="leading-relaxed">{withCites(d.summary)}</p>
      </section>
      {d.themes.length > 0 && <section><h4 className="mb-1 text-[12px] font-medium text-muted-foreground">Themes</h4><div className="flex flex-wrap gap-1">{d.themes.map((t) => <Badge key={t} variant="secondary" className="font-normal">{t}</Badge>)}</div></section>}
      <section>
        <h4 className="mb-1 text-[12px] font-medium text-muted-foreground">Key admissions ({d.keyAdmissions.length})</h4>
        <ul className="space-y-1.5">{d.keyAdmissions.map((k, i) => <li key={i} className="rounded-md border-l-2 border-success/60 bg-success/5 px-2 py-1 leading-relaxed"><Cite text={k} /></li>)}</ul>
      </section>
      {d.credibilityNotes?.length ? <section><h4 className="mb-1 text-[12px] font-medium text-muted-foreground">Credibility</h4><ul className="list-disc space-y-1 pl-4 leading-relaxed">{d.credibilityNotes.map((n, i) => <li key={i}>{withCites(n)}</li>)}</ul></section> : null}
      {d.followUps?.length ? <section><h4 className="mb-1 text-[12px] font-medium text-muted-foreground">Follow-up questions</h4><ol className="list-decimal space-y-1 pl-4 leading-relaxed">{d.followUps.map((n, i) => <li key={i}>{withCites(n)}</li>)}</ol></section> : null}
    </div>
  );
}

function DesignationsPanel({ detail, onJump, onRemove, onUpdate, onStart }: { detail: DepositionDetail; onJump: (d: Designation) => void; onRemove: (d: Designation) => void; onUpdate: (d: Designation, patch: Partial<Designation>) => void; onStart: () => void }) {
  const [editing, setEditing] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const list = detail.designations;
  const totals = React.useMemo(() => designationTotals(list), [list]);
  if (!list.length) return <div className="p-3"><EmptyState icon={Highlighter} title="No designations" description="Press D (or click Designate), then click the first and last Q/A of the range. Mark counters against a designation, record objections, and export CSV or Word for the trial-presentation vendor." action={<Button size="sm" variant="outline" onClick={onStart}><Highlighter className="size-4" /> Start designating</Button>} /></div>;
  const PURPOSE: Record<Designation["purpose"], string> = { affirmative: "border-border text-foreground/80", counter: "border-border text-foreground/80", impeachment: "border-destructive/30 text-destructive", objection: "bg-muted text-muted-foreground border-border" };
  const targets = list.filter((x) => x.purpose === "affirmative" || x.purpose === "impeachment");
  return (
    <div>
      <div className="grid grid-cols-4 gap-px border-b bg-border text-[11px]">
        {([["Lines", totals.lines.all], ["Affirmative", totals.lines.affirmative], ["Counter", totals.lines.counter], ["≈ min", totals.estimatedMinutes]] as [string, number][]).map(([k, v]) => <div key={k} className="bg-background px-2 py-1.5"><div className="text-[11px] text-muted-foreground">{k}</div><div className="tabular font-medium">{v}</div></div>)}
      </div>
      {(totals.danglingCounters > 0 || totals.detachedCounters > 0 || totals.objections.pending > 0) && <div className="border-b bg-warning/10 px-3 py-1 text-[11px] text-warning-foreground dark:text-warning">{[totals.danglingCounters ? `${totals.danglingCounters} counter${totals.danglingCounters === 1 ? "" : "s"} without a designation` : "", totals.detachedCounters ? `${totals.detachedCounters} counter${totals.detachedCounters === 1 ? "" : "s"} far from its designation` : "", totals.objections.pending ? `${totals.objections.pending} objection${totals.objections.pending === 1 ? "" : "s"} pending ruling` : ""].filter(Boolean).join(" · ")}</div>}
    <ul className="divide-y">
      {list.map((d) => (
        <li key={d.id} className="group px-3 py-2">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => onJump(d)} className="font-mono text-[12px] font-medium text-chart-2 hover:underline cursor-pointer">{formatRange(d)}</button>
            <Select value={d.purpose} onValueChange={(v) => onUpdate(d, { purpose: v as Designation["purpose"] })}>
              <SelectTrigger size="sm" className={cn("h-5 w-auto gap-1 rounded border px-1.5 text-[10.5px] capitalize shadow-none", PURPOSE[d.purpose])}><SelectValue /></SelectTrigger>
              <SelectContent>{(["affirmative", "counter", "impeachment", "objection"] as const).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
            </Select>
            {d.purpose === "counter" && (
              <select value={d.counterTo ?? ""} onChange={(e) => onUpdate(d, { counterTo: e.target.value || undefined })} className={cn("h-5 max-w-[120px] rounded border bg-background px-1 text-[10.5px]", !d.counterTo && "border-warning/60")} aria-label="Counter to designation" title="Designation this counter completes">
                <option value="">counter to…</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{formatRange(t)}</option>)}
              </select>
            )}
            <span className="flex-1" />
            <Tip label={d.objection ? "Edit objection" : "Record an objection to this designation"}><Button size="icon-xs" variant="ghost" className={cn(!d.objection && "opacity-0 group-hover:opacity-100")} onClick={() => onUpdate(d, { objection: d.objection ? undefined : { basis: "relevance", ruling: "pending" } })} aria-label="Toggle objection" aria-pressed={!!d.objection}><Gavel className={cn("size-3.5", d.objection && "text-foreground")} /></Button></Tip>
            <Tip label="Edit note"><Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={() => { setEditing(d.id); setNote(d.note ?? ""); }} aria-label="Edit note"><Pencil className="size-3.5" /></Button></Tip>
            <Tip label="Delete"><Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100 hover:text-destructive" onClick={() => onRemove(d)} aria-label="Delete designation"><Trash2 className="size-3.5" /></Button></Tip>
          </div>
          {d.objection && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-muted-foreground">Objection</span>
              <select value={d.objection.basis} onChange={(e) => onUpdate(d, { objection: { ...d.objection!, basis: e.target.value } })} className="h-5 rounded border bg-background px-1 text-[10.5px]" aria-label="Objection basis">{OBJECTION_BASES.map((b) => <option key={b} value={b}>{b}</option>)}</select>
              <select value={d.objection.ruling ?? "pending"} onChange={(e) => onUpdate(d, { objection: { ...d.objection!, ruling: e.target.value as NonNullable<Designation["objection"]>["ruling"] } })} className={cn("h-5 rounded border bg-background px-1 text-[10.5px]", d.objection.ruling === "sustained" && "text-success", d.objection.ruling === "overruled" && "text-destructive")} aria-label="Ruling">{OBJECTION_RULINGS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
            </div>
          )}
          {editing === d.id ? (
            <div className="mt-1.5">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="text-xs" autoFocus onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { onUpdate(d, { note: note.trim() }); setEditing(null); } if (e.key === "Escape") setEditing(null); }} />
              <div className="mt-1 flex justify-end gap-1"><Button size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button size="xs" onClick={() => { onUpdate(d, { note: note.trim() }); setEditing(null); }}>Save</Button></div>
            </div>
          ) : d.note ? <div className="mt-1 text-[11.5px] text-muted-foreground">{d.note}</div> : null}
        </li>
      ))}
    </ul>
    </div>
  );
}

const RULING_CLS: Record<ObjectionRuling, string> = { pending: "text-muted-foreground", sustained: "border-foreground/25 bg-accent text-foreground", overruled: "border-destructive/40 text-destructive" };

function ObjectionsPanel({ detail, onJump, onRule }: { detail: DepositionDetail; onJump: (index: number) => void; onRule: (index: number, ruling: ObjectionRuling) => void }) {
  const s = detail.objections;
  const rulings = detail.rulings ?? {};
  const rows = detail.deposition.transcript.map((qa, i) => ({ qa, i })).filter(({ qa }) => qa.objection);
  if (!s || !s.total) return <div className="p-3"><EmptyState icon={Gavel} title="No objections on the record" /></div>;
  const max = Math.max(...s.byBasis.map((b) => b.count), 1);
  return (
    <div className="space-y-4 p-3">
      <div className="grid grid-cols-3 gap-2">
        {[["Total", s.total], ["Sustained", s.rulings.sustained], ["Overruled", s.rulings.overruled]].map(([k, v]) => <div key={String(k)} className="rounded-md border bg-card px-2 py-1.5"><div className="text-[11px] text-muted-foreground">{k}</div><div className="text-base font-semibold tabular">{v}</div></div>)}
      </div>
      <p className="text-[11px] text-muted-foreground">{s.rulings.pending === s.total ? `All ${s.total} objections are pending — record the court's rulings on designated testimony below.` : `${s.rulings.pending} of ${s.total} pending.`}</p>
      <section>
        <h4 className="mb-1.5 text-[12px] font-medium text-muted-foreground">By basis</h4>
        <ul className="space-y-1">{s.byBasis.map((b) => (
          <li key={b.basis} className="flex items-center gap-2 text-xs">
            <ObjectionBadge basis={b.basis} className="w-32 justify-start" />
            <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><span className={cn("absolute inset-y-0 left-0 rounded-full", (OBJECTION_STYLES[b.basis] ?? "").split(" ").find((c) => c.startsWith("bg-"))?.replace(/\/\d+$/, "") ?? "bg-muted-foreground")} style={{ width: `${(b.count / max) * 100}%` }} /></span>
            <span className="w-5 text-right tabular text-muted-foreground">{b.count}</span>
          </li>
        ))}</ul>
      </section>
      <section>
        <h4 className="mb-1.5 text-[12px] font-medium text-muted-foreground">By attorney</h4>
        <ul className="space-y-1">{s.byAttorney.map((a) => <li key={a.attorney} className="flex items-center justify-between text-xs"><span className="flex items-center gap-1.5"><PersonAvatar name={a.attorney} size="xs" />{a.attorney}</span><span className="tabular text-muted-foreground">{a.count}</span></li>)}</ul>
      </section>
      <section>
        <h4 className="mb-1.5 text-[12px] font-medium text-muted-foreground">On the record</h4>
        <ul className="space-y-0.5">{rows.map(({ qa, i }) => {
          const ruling = rulings[i] ?? "pending";
          return (
            <li key={i} className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent/60">
              <button type="button" onClick={() => onJump(i)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[11.5px] cursor-pointer"><span className="w-12 shrink-0 font-mono text-muted-foreground">{formatPageLine(qa.page, qa.line)}</span><ObjectionBadge basis={qa.objection!.basis} /><span className="truncate text-muted-foreground">{qa.objection!.text ?? qa.question}</span></button>
              <Select value={ruling} onValueChange={(v) => onRule(i, v as ObjectionRuling)}>
                <SelectTrigger size="sm" className={cn("h-5 w-auto shrink-0 gap-1 rounded border px-1.5 text-[10.5px] shadow-none", RULING_CLS[ruling])} aria-label={`Ruling at ${formatPageLine(qa.page, qa.line)}`}><SelectValue /></SelectTrigger>
                <SelectContent>{OBJECTION_RULINGS.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}</SelectContent>
              </Select>
            </li>
          );
        })}</ul>
      </section>
    </div>
  );
}

function ExhibitsPanel({ detail, onOpen, onJump }: { detail: DepositionDetail; onOpen: (ref: string) => void; onJump: (ref: string) => void }) {
  const list = detail.exhibits;
  if (!list.length) return <div className="p-3"><EmptyState icon={Paperclip} title="No exhibits marked" /></div>;
  const used = new Set(detail.deposition.transcript.map((qa) => qa.exhibit).filter(Boolean));
  return (
    <ul className="divide-y">
      {list.map((e) => (
        <li key={e.id} className="px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="rounded border bg-muted px-1.5 font-mono text-[11px] font-medium">{e.id}</span>
            {e.bates && <span className="font-mono text-[11px] text-muted-foreground">{e.bates}</span>}
            <span className="flex-1" />
            {used.has(e.id) && <Tip label="Jump to where it was used"><Button size="icon-xs" variant="ghost" onClick={() => onJump(e.id)} aria-label="Jump to exhibit"><ChevronRight className="size-3.5" /></Button></Tip>}
            <Tip label={e.docId ? "Open in the review viewer" : "Not in this workspace"}><Button size="icon-xs" variant="ghost" disabled={!e.docId} onClick={() => onOpen(e.id)} aria-label="Open exhibit"><FileText className="size-3.5" /></Button></Tip>
          </div>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">{e.description}</div>
        </li>
      ))}
    </ul>
  );
}

function FlagsPanel({ transcript, onJump }: { transcript: DepositionQA[]; onJump: (index: number) => void }) {
  const groups = QA_FLAGS.map((f) => ({ ...f, items: transcript.map((qa, i) => ({ qa, i })).filter(({ qa }) => qa.flags?.includes(f.id)) })).filter((g) => g.items.length);
  if (!groups.length) return <div className="p-3"><EmptyState icon={Flag} title="Nothing flagged yet" description="Hover a Q/A and click Flag, or use a / c / e / x on the active row." /></div>;
  return (
    <div className="divide-y">
      {groups.map((g) => (
        <section key={g.id} className="px-3 py-2">
          <h4 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground"><FlagBadge flag={g.id} /> {g.items.length}</h4>
          <ul className="space-y-0.5">{g.items.map(({ qa, i }) => <li key={i}><button type="button" onClick={() => onJump(i)} className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-[11.5px] hover:bg-accent cursor-pointer"><span className="w-12 shrink-0 font-mono text-muted-foreground">{formatPageLine(qa.page, qa.line)}</span><span className="line-clamp-2 text-foreground/90">{qa.answer}</span></button></li>)}</ul>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function OutlineDialog({ open, onOpenChange, matterId, depositions, aiConfigured }: { open: boolean; onOpenChange: (o: boolean) => void; matterId: string; depositions: DepositionSummary[]; aiConfigured: boolean }) {
  const witnesses = React.useMemo(() => { const m = new Map<string, { id: string; name: string; title?: string; status: string }>(); for (const d of depositions) if (!m.has(d.witnessId) || d.status === "scheduled") m.set(d.witnessId, { id: d.witnessId, name: d.witnessName, title: d.witnessTitle, status: d.status }); return Array.from(m.values()); }, [depositions]);
  const [witnessId, setWitnessId] = React.useState<string>("");
  const [custom, setCustom] = React.useState("");
  const [topics, setTopics] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<{ markdown: string; title: string; sources: string[] } | null>(null);
  const [noKey, setNoKey] = React.useState(false);
  React.useEffect(() => { if (open && !witnessId) { const next = witnesses.find((w) => w.status === "scheduled") ?? witnesses[0]; if (next) setWitnessId(next.id); } }, [open, witnesses, witnessId]);
  const witness = witnesses.find((w) => w.id === witnessId);
  const name = witnessId === "__custom" ? custom.trim() : witness?.name ?? "";
  const run = async () => {
    if (!name) return;
    setRunning(true); setNoKey(false);
    try {
      const r = await api<{ markdown: string; title: string; sources: string[] }>("/api/ediscovery/analysis/depositions/outline", { method: "POST", json: { matterId, witnessName: name, witnessId: witnessId === "__custom" ? undefined : witnessId, topics: topics.split(/[;\n]/).map((t) => t.trim()).filter(Boolean) } });
      setResult(r);
    } catch (e) { if (isNoKey(e)) setNoKey(true); else toast.error("Outline failed", { description: (e as Error).message }); }
    finally { setRunning(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setResult(null); setNoKey(false); } }}>
      <DialogContent size={result ? "xl" : "lg"} className="flex max-h-[92vh] flex-col">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><BookOpenText className="size-4" /> Prepare outline for next witness</DialogTitle><DialogDescription>Builds an examination/defence outline from the documents the witness authored or received, the chronology, open conflicts and every prior transcript that mentions them.</DialogDescription></DialogHeader>
        {!result ? (
          <div className="grid gap-3">
            {(noKey || !aiConfigured) && <NoKeyCallout feature="Outline drafting" compact />}
            <div className="grid gap-1.5">
              <Label>Witness</Label>
              <Select value={witnessId} onValueChange={setWitnessId}>
                <SelectTrigger><SelectValue placeholder="Choose a witness" /></SelectTrigger>
                <SelectContent>
                  {witnesses.map((w) => <SelectItem key={w.id} value={w.id}><span className="flex items-center gap-2">{w.name}<span className="text-xs text-muted-foreground">{w.status === "scheduled" ? "scheduled" : "prior volume taken"}</span></span></SelectItem>)}
                  <SelectItem value="__custom">Other witness…</SelectItem>
                </SelectContent>
              </Select>
              {witnessId === "__custom" && <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Witness name, e.g. Pankaj Malhotra" />}
            </div>
            <div className="grid gap-1.5">
              <Label>Topics (one per line; optional)</Label>
              <Textarea value={topics} onChange={(e) => setTopics(e.target.value)} rows={4} placeholder={"One topic per line, e.g.\nWhen the defect was first reported\nWho approved the recall decision"} />
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card p-4 scrollbar-thin">
            <Markdown>{result.markdown}</Markdown>
            {result.sources.length > 0 && <div className="mt-4 border-t pt-2 text-[11px] text-muted-foreground">Sources considered: {result.sources.join(" · ")}</div>}
          </div>
        )}
        <DialogFooter>
          {result ? (
            <>
              <Button variant="ghost" onClick={() => setResult(null)}>Back</Button>
              <Button variant="outline" onClick={() => void navigator.clipboard.writeText(result.markdown).then(() => toast.success("Copied outline"))}>Copy markdown</Button>
              <Button onClick={() => exportMarkdownToWord({ title: result.title, markdown: result.markdown, matterId, tags: ["deposition-outline", "ediscovery"], meta: { witness: name } })}><FileText className="size-4" /> Export to Word</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <KeyHint configured={aiConfigured}><Button onClick={run} disabled={running || !name}>{running ? <Loader2 className="size-4 animate-spin" /> : <PenLine className="size-4" />} {running ? "Drafting…" : "Draft outline"}</Button></KeyHint>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

