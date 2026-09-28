"use client";
import * as React from "react";
import { ChevronLeft, ChevronRight, X, Maximize2, Minimize2, Paperclip, MessagesSquare, Copy, Files, ArrowUpLeft, PanelRightClose, PanelRightOpen, Search, ClipboardCopy, Loader2, AlertTriangle, CircleCheck, CircleX, Flame, Save, ShieldAlert, EyeOff, Layers, History, ArrowRight, Download } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { ScoreBar } from "@/components/ui/progress";
import { KeyValueList } from "@/components/ui/form";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { CodingDecision, Redaction } from "@/lib/types/domain";
import type { DocRow, SimilarDoc } from "../types";
import { highlightRegex, parseBates, formatBates } from "../query";
import { docClassLabel, type IndiaEDocument } from "../india";
import { languageInfo } from "@/lib/india/languages";
import { useReviewStore, type ViewerTab } from "./store";
import { api, useDoc, useDocHistory, useRedactions, useSimilar, type DocDetailResponse } from "./use-review-data";
import { useReview } from "./review-page";
import { ReviewListContext } from "./review-tab";
import { CodingPanel } from "./coding-panel";
import { CODING_COLUMN_MIN_WIDTH, codingColumnWidth } from "./viewer-layout";
import { SuggestedTab } from "./suggested-tab";
import { DecisionCell, IssueChip, StateChip, TypeIcon, formatDateTime, formatShortDate } from "./shared";
import { NewRedactionPopover, RedactedSpan, RedactionPopover, type PendingRedaction } from "./redactions";
import { cssToPageRect, dragRect, pageRectToCss, pageSpans, parsePageMap, splitRanges, type CssRect, type TextRangeMark } from "./review-helpers";
import { applyCodingKey, codingKeyAction } from "./review-helpers";

export { CODING_COLUMN_MIN_WIDTH, codingColumnWidth };

const TABS: { id: ViewerTab; label: string }[] = [
  { id: "text", label: "Text" }, { id: "image", label: "Image" }, { id: "metadata", label: "Metadata" }, { id: "family", label: "Family" }, { id: "similar", label: "Similar" }, { id: "suggested", label: "Suggested" }, { id: "history", label: "History" },
];

export function DocViewer({ docId, terms, onNavigate, onClose, index, count, onNextUncoded }: { docId: string; terms: string[]; onNavigate: (delta: number) => void; onClose: () => void; index: number; count: number; onNextUncoded?: () => void }) {
  const { currentUserId, issueCodes } = useReview();
  const list = React.useContext(ReviewListContext);
  const detail = useDoc(docId);
  const redactions = useRedactions(docId);
  const tab = useReviewStore((s) => s.viewerTab);
  const setTab = useReviewStore((s) => s.setViewerTab);
  const fullscreen = useReviewStore((s) => s.fullscreen);
  const setFullscreen = useReviewStore((s) => s.setFullscreen);
  const codingOpen = useReviewStore((s) => s.codingPanelOpen);
  const setCodingOpen = useReviewStore((s) => s.setCodingPanelOpen);
  const autoAdvance = useReviewStore((s) => s.autoAdvance);
  const setOpenDocId = useReviewStore((s) => s.setOpenDocId);
  const redactMode = useReviewStore((s) => s.redactMode);
  const setRedactMode = useReviewStore((s) => s.setRedactMode);
  const qcMode = useReviewStore((s) => s.qcMode);
  const [draft, setDraft] = React.useState<CodingDecision | null>(null);
  const [saving, setSaving] = React.useState(false);
  const doc = detail.data?.doc;
  // Ingested documents carry their original-file record (hash, mime, extraction status); seeded or API-created ones do not.
  const original = (doc as (typeof doc & { original?: { name: string; extraction: { status: string } } }) | undefined)?.original;
  const dirty = !!doc && !!draft && JSON.stringify(normalise(draft)) !== JSON.stringify(normalise(doc.coding));

  React.useEffect(() => { if (doc) setDraft({ ...doc.coding, issues: [...(doc.coding.issues ?? [])] }); }, [doc]);
  React.useEffect(() => { if (detail.error) toast.error("Could not load document", { description: detail.error.message }); }, [detail.error]);

  const save = React.useCallback(async (advance = true) => {
    if (!doc || !draft) return;
    setSaving(true);
    try {
      const st = useReviewStore.getState();
      const res = await api<{ doc: { id: string; coding: CodingDecision }; qc?: { agree: boolean } }>(`/api/ediscovery/docs/${encodeURIComponent(doc.id)}`, { method: "PATCH", json: { coding: draft, reviewerId: draft.reviewerId ?? currentUserId, ...(st.batchId && st.qcMode ? { batchId: st.batchId, qc: true } : {}) } });
      detail.mutate((cur) => (cur ? { ...cur, doc: { ...cur.doc, coding: res.doc.coding } } : cur));
      list.patchCoding([doc.id], res.doc.coding);
      // propagate to exact duplicates
      const dupIds = [...(detail.data?.family.duplicates ?? []).map((d) => d.id), ...(detail.data?.family.duplicateOf ? [detail.data.family.duplicateOf.id] : [])];
      if (dupIds.length) { await api("/api/ediscovery/docs/bulk", { method: "POST", json: { ids: dupIds, patch: res.doc.coding } }); list.patchCoding(dupIds, res.doc.coding); }
      if (res.qc) toast[res.qc.agree ? "success" : "warning"](res.qc.agree ? `QC: agrees with the first pass · ${doc.bates}` : `QC: disagrees with the first pass · ${doc.bates}`, { duration: 2200 });
      else toast.success(`Saved ${doc.bates}`, { description: dupIds.length ? `Coding propagated to ${dupIds.length} duplicate${dupIds.length === 1 ? "" : "s"}` : undefined, duration: 1800 });
      if (advance && autoAdvance) { if (st.batchId && onNextUncoded) onNextUncoded(); else if (index < count - 1) onNavigate(1); }
    } catch (e) { toast.error("Save failed", { description: (e as Error).message }); }
    finally { setSaving(false); }
  }, [doc, draft, currentUserId, detail, list, autoAdvance, index, count, onNavigate, onNextUncoded]);

  // Viewer shortcuts: ⌘S save; r/n/p/h and 1–9 edit the draft; [ ] prev/next
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.getAttribute("role") === "combobox" || t.closest("[role=dialog]"));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!t?.closest("[data-doc-viewer]") && useReviewStore.getState().selected.length) return; // the grid owns keys while rows are selected
      const action = codingKeyAction(e.key);
      if (!action || action.kind === "next-uncoded") return;
      setDraft((d) => { if (!d) return d; const patch = applyCodingKey(d, action, issueCodes.map((c) => c.code)); return patch ? { ...d, ...patch } : d; });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, issueCodes]);

  const family = detail.data?.family;
  const thread = family?.thread ?? [];
  const threadIdx = thread.findIndex((t) => t.id === docId);

  // At 560px and wider the coding panel is a fixed right column (never an overlay), so the
  // primary decisions stay one glance away; narrower than that it opens as an overlay so the
  // document itself stays readable.
  const sectionRef = React.useRef<HTMLElement>(null);
  const [width, setWidth] = React.useState(0);
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  React.useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setWidth(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = width > 0 && width < CODING_COLUMN_MIN_WIDTH;
  const codingWidth = codingColumnWidth(width);
  const codingVisible = narrow ? overlayOpen : codingOpen;
  const toggleCoding = () => (narrow ? setOverlayOpen((v) => !v) : setCodingOpen(!codingOpen));

  const reds = React.useMemo(() => redactions.data?.redactions ?? [], [redactions.data]);
  // Keep the grid row's redaction count current without refetching the whole list.
  const onRedactionsChanged = React.useCallback((next: Redaction[]) => {
    redactions.mutate(() => ({ redactions: next }));
    list.patchRow(docId, { redactions: next.length || undefined });
  }, [redactions, list, docId]);
  const onCreated = React.useCallback((r: Redaction) => onRedactionsChanged([...reds, r]), [reds, onRedactionsChanged]);
  const onRemoved = React.useCallback((id: string) => onRedactionsChanged(reds.filter((r) => r.id !== id)), [reds, onRedactionsChanged]);

  return (
    <section ref={sectionRef} className="flex h-full min-h-0 flex-col bg-background" data-doc-viewer aria-label="Document viewer">
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5">
        <div className="flex items-center gap-0.5">
          <Tip label="Previous document" shortcut="["><Button variant="ghost" size="icon-xs" onClick={() => onNavigate(-1)} disabled={index <= 0} aria-label="Previous"><ChevronLeft className="size-4" /></Button></Tip>
          <span className="tabular text-[11px] text-muted-foreground">{index >= 0 ? index + 1 : "–"} / {count}</span>
          <Tip label="Next document" shortcut="]"><Button variant="ghost" size="icon-xs" onClick={() => onNavigate(1)} disabled={index < 0 || index >= count - 1} aria-label="Next"><ChevronRight className="size-4" /></Button></Tip>
          {onNextUncoded && <Tip label="Next document without a decision" shortcut="x"><Button variant="ghost" size="icon-xs" onClick={onNextUncoded} aria-label="Next uncoded"><ArrowRight className="size-4" /></Button></Tip>}
        </div>
        <div className="mx-1 h-4 w-px bg-border" />
        {doc ? (
          <div className="flex min-w-[160px] flex-1 items-center gap-2">
            <TypeIcon type={doc.type} />
            {(doc as IndiaEDocument).india?.exhibit && <span className="shrink-0 rounded border border-foreground/25 bg-accent px-1.5 font-mono text-[12px] font-semibold leading-5 tabular" title={(doc as IndiaEDocument).india?.markedThrough ? `Marked through ${(doc as IndiaEDocument).india?.markedThrough}` : undefined}>{(doc as IndiaEDocument).india?.exhibit}</span>}
            <span className="shrink-0 font-mono text-[12.5px] font-semibold tabular">{doc.bates}{doc.batesEnd && <span className="font-normal text-muted-foreground"> – {doc.batesEnd.slice(-4)}</span>}</span>
            {(doc as IndiaEDocument).india?.docClass === "translation" && <span className="shrink-0 rounded border border-dashed px-1 text-[10.5px] leading-4 text-muted-foreground" title="The original-language document is the text of record">Translation</span>}
            <span className="min-w-0 truncate text-[13px] font-medium" title={doc.subject}>{doc.subject}</span>
            {dirty && <Badge variant="warning" size="sm" className="shrink-0">Unsaved</Badge>}
            {qcMode && <StateChip tone="info">QC call</StateChip>}
          </div>
        ) : <Skeleton className="h-4 flex-1" />}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <FamilyNav family={family} threadIdx={threadIdx} onOpen={setOpenDocId} />
          {original && <Tip label={`Download original (${original.name})`}><Button asChild variant="ghost" size="icon-xs"><a href={`/api/ediscovery/docs/${encodeURIComponent(docId)}/original`} download aria-label="Download original file"><Download className="size-4" /></a></Button></Tip>}
          <Tip label={redactMode ? "Leave redaction mode" : "Redact: select text or drag on a page image"}><Button variant={redactMode ? "secondary" : "ghost"} size="icon-xs" onClick={() => setRedactMode(!redactMode)} aria-label="Toggle redaction mode" aria-pressed={redactMode}><EyeOff className="size-4" /></Button></Tip>
          <Tip label={codingVisible ? "Hide coding panel" : "Show coding panel"}><Button variant="ghost" size="icon-xs" onClick={toggleCoding} aria-label="Toggle coding panel" aria-pressed={codingVisible}>{codingVisible ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}</Button></Tip>
          <Tip label={fullscreen ? "Exit full screen" : "Full screen"} shortcut="F"><Button variant="ghost" size="icon-xs" onClick={() => setFullscreen(!fullscreen)} aria-label="Toggle full screen">{fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</Button></Tip>
          <Tip label="Close" shortcut="Esc"><Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close viewer"><X className="size-4" /></Button></Tip>
        </div>
      </header>
      <div className="flex shrink-0 items-center border-b px-2" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("relative h-8 px-2.5 text-xs font-medium transition-colors cursor-pointer", tab === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {t.label}
            {t.id === "family" && family && <span className="ml-1 tabular text-[10px] text-muted-foreground">{(family.attachments.length + (family.parent ? 1 : 0) + Math.max(0, family.thread.length - 1) + family.duplicates.length + family.nearDuplicates.length + (family.duplicateOf ? 1 : 0))}</span>}
            {t.id === "suggested" && doc?.aiScore != null && <span className="ml-1 tabular text-[10px] text-muted-foreground">{doc.aiScore}</span>}
            {t.id === "image" && reds.length > 0 && <span className="ml-1 tabular text-[10px] text-muted-foreground">{reds.length}</span>}
            {tab === t.id && <span className="absolute inset-x-1.5 -bottom-px h-0.5 bg-primary" />}
          </button>
        ))}
        {doc && <div className="ml-auto flex items-center gap-2 pr-1"><DecisionCell coding={draft ?? doc.coding} /></div>}
      </div>
      {!narrow && !codingVisible && draft && doc && (
        <QuickDecisionRow draft={draft} onChange={setDraft} onSave={() => save()} saving={saving} dirty={dirty} onOpenPanel={() => setCodingOpen(true)} />
      )}
      {original?.extraction.status === "needs_ocr" && <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-muted/40 px-3 text-[11.5px] text-muted-foreground" role="status">No text layer — this file needs OCR before search and analysis can read it. The original is stored unchanged.</div>}
      {redactMode && <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-muted/50 px-3 text-[11.5px] text-foreground" role="status"><EyeOff className="size-3.5" /> Redaction mode — select text in the Text tab or drag a rectangle on a page image. Existing redactions open on click.<div className="flex-1" /><Button size="xs" variant="ghost" className="h-5 px-1.5" onClick={() => setRedactMode(false)}>Done</Button></div>}
      <div className="relative flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          {!detail.data ? (
            <div className="space-y-2 p-4">{Array.from({ length: 14 }).map((_, i) => <Skeleton key={i} className={cn("h-3.5", i % 4 === 3 ? "w-2/3" : "w-full")} />)}</div>
          ) : tab === "text" ? (
            <TextView detail={detail.data} terms={terms} redactions={reds} redactMode={redactMode} onCreated={onCreated} onRemoved={onRemoved} />
          ) : tab === "image" ? (
            <ImageView detail={detail.data} redactions={reds} redactMode={redactMode} onCreated={onCreated} onRemoved={onRemoved} />
          ) : tab === "metadata" ? (
            <MetadataView detail={detail.data} />
          ) : tab === "family" ? (
            <FamilyView detail={detail.data} onOpen={setOpenDocId} />
          ) : tab === "similar" ? (
            <SimilarView docId={docId} active={tab === "similar"} onOpen={setOpenDocId} />
          ) : tab === "history" ? (
            <HistoryView docId={docId} active={tab === "history"} redactions={reds} />
          ) : (
            <SuggestedTab detail={detail.data} analysis={detail.data.analysis} onAnalysis={(a) => detail.mutate((cur) => (cur ? { ...cur, analysis: a } : cur))} onApply={(patch) => setDraft((d) => (d ? { ...d, ...patch } : d))} onApplied={(coding, aiProvenance) => { detail.mutate((cur) => (cur ? { ...cur, doc: { ...cur.doc, coding, ...(aiProvenance ? { aiProvenance } : {}) } } : cur)); setDraft({ ...coding, issues: [...(coding.issues ?? [])] }); list.patchCoding([docId], coding); }} />
          )}
        </div>
        {codingVisible && draft && doc && (
          <CodingPanel draft={draft} onChange={setDraft} onSave={() => save()} saving={saving} dirty={dirty} reviewedBy={detail.data?.reviewerName} reviewedAt={doc.coding.reviewedAt} width={narrow ? 272 : codingWidth} className={narrow ? "absolute inset-y-0 right-0 z-20 bg-card shadow-xl" : undefined} />
        )}
        {narrow && !overlayOpen && draft && doc && (
          <Button variant="secondary" size="sm" className="absolute bottom-3 right-3 z-10 shadow-md" onClick={() => setOverlayOpen(true)}><PanelRightOpen className="size-4" /> Coding{dirty ? " · unsaved" : ""}</Button>
        )}
      </div>
    </section>
  );
}

function normalise(c: CodingDecision) {
  const { reviewedAt: _a, reviewerId: _b, ...rest } = c;
  void _a; void _b;
  return { ...rest, issues: [...(rest.issues ?? [])].sort(), notes: rest.notes ?? "" };
}

/** Sticky one-row decision bar shown when the coding column is collapsed: Responsive / Not / Privileged / Hot / Save & next. */
function QuickDecisionRow({ draft, onChange, onSave, saving, dirty, onOpenPanel }: { draft: CodingDecision; onChange: (c: CodingDecision) => void; onSave: () => void; saving: boolean; dirty: boolean; onOpenPanel: () => void }) {
  const autoAdvance = useReviewStore((s) => s.autoAdvance);
  const seg = "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  const off = "border-border text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <div className="sticky-actions flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1.5" role="toolbar" aria-label="Coding decisions">
      <Tip label="Responsive" shortcut="R"><button type="button" onClick={() => onChange({ ...draft, responsive: draft.responsive === true ? null : true })} aria-pressed={draft.responsive === true} className={cn(seg, draft.responsive === true ? "border-foreground/25 bg-accent text-foreground" : off)}><CircleCheck className="size-3.5" /> Responsive</button></Tip>
      <Tip label="Not responsive" shortcut="N"><button type="button" onClick={() => onChange({ ...draft, responsive: draft.responsive === false ? null : false })} aria-pressed={draft.responsive === false} className={cn(seg, draft.responsive === false ? "border-foreground/25 bg-muted text-foreground" : off)}><CircleX className="size-3.5" /> Not</button></Tip>
      <Tip label="Privileged (withhold)" shortcut="P"><button type="button" onClick={() => onChange({ ...draft, privileged: !draft.privileged, privilegeBasis: draft.privileged ? undefined : (draft.privilegeBasis ?? "attorney-client") })} aria-pressed={!!draft.privileged} className={cn(seg, draft.privileged ? "border-foreground/25 bg-accent text-foreground" : off)}><ShieldAlert className="size-3.5" /> Privileged</button></Tip>
      <Tip label="Hot document" shortcut="H"><button type="button" onClick={() => onChange({ ...draft, hot: !draft.hot })} aria-pressed={!!draft.hot} className={cn(seg, draft.hot ? "border-destructive/40 text-destructive" : off)}><Flame className="size-3.5" /> Hot</button></Tip>
      <div className="flex-1" />
      <Tip label="Open the coding panel for issue codes, notes and reviewer"><Button variant="ghost" size="xs" className="h-7" onClick={onOpenPanel}><PanelRightOpen className="size-3.5" /> Details</Button></Tip>
      <Tip label={autoAdvance ? "Save coding and open the next document" : "Save coding"} shortcut="⌘S"><Button size="xs" className="h-7" onClick={onSave} disabled={saving} variant={dirty ? "default" : "secondary"}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} {dirty ? (autoAdvance ? "Save & next" : "Save") : "Saved"}</Button></Tip>
    </div>
  );
}

function FamilyNav({ family, threadIdx, onOpen }: { family: DocDetailResponse["family"] | undefined; threadIdx: number; onOpen: (id: string) => void }) {
  if (!family) return null;
  const thread = family.thread;
  return (
    <div className="flex items-center gap-0.5">
      {family.parent && <Tip label={`Parent: ${family.parent.bates}`}><Button variant="ghost" size="icon-xs" onClick={() => onOpen(family.parent!.id)} aria-label="Open parent"><ArrowUpLeft className="size-4" /></Button></Tip>}
      {family.attachments.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="xs" className="gap-1 px-1.5" aria-label="Attachments"><Paperclip className="size-3.5" /><span className="tabular text-[11px]">{family.attachments.length}</span></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuLabel>Attachments</DropdownMenuLabel>
            {family.attachments.map((a) => <DropdownMenuItem key={a.id} onClick={() => onOpen(a.id)}><span className="font-mono text-[11px]">{a.bates}</span><span className="ml-2 truncate">{a.subject}</span></DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {thread.length > 1 && (
        <span className="flex items-center rounded-md border">
          <Tip label="Previous in thread"><Button variant="ghost" size="icon-xs" className="size-6" disabled={threadIdx <= 0} onClick={() => onOpen(thread[threadIdx - 1].id)} aria-label="Previous in thread"><ChevronLeft className="size-3.5" /></Button></Tip>
          <span className="flex items-center gap-1 px-1 text-[11px] tabular text-muted-foreground"><MessagesSquare className="size-3" />{threadIdx + 1}/{thread.length}</span>
          <Tip label="Next in thread"><Button variant="ghost" size="icon-xs" className="size-6" disabled={threadIdx < 0 || threadIdx >= thread.length - 1} onClick={() => onOpen(thread[threadIdx + 1].id)} aria-label="Next in thread"><ChevronRight className="size-3.5" /></Button></Tip>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text view: search-hit highlighting with next/prev, page markers, text redactions, copy-with-cite
// ---------------------------------------------------------------------------

function TextView({ detail, terms, redactions, redactMode, onCreated, onRemoved }: { detail: DocDetailResponse; terms: string[]; redactions: Redaction[]; redactMode: boolean; onCreated: (r: Redaction) => void; onRemoved: (id: string) => void }) {
  const { doc } = detail;
  const [find, setFind] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  const jumpTo = useReviewStore((s) => s.jumpTo);
  const allTerms = React.useMemo(() => Array.from(new Set([...terms, ...(find.trim().length > 1 ? [find.trim().toLowerCase()] : [])])), [terms, find]);
  const regex = React.useMemo(() => highlightRegex(allTerms), [allTerms]);
  const spans = React.useMemo(() => pageSpans(doc.text, doc.pages ?? 1), [doc.text, doc.pages]);
  const start = parseBates(doc.bates);
  const hitCount = React.useMemo(() => (regex ? (doc.text.match(regex) ?? []).length : 0), [regex, doc.text]);
  const [hitIdx, setHitIdx] = React.useState(0);
  const [pending, setPending] = React.useState<PendingRedaction | null>(null);
  const [open, setOpen] = React.useState<{ redaction: Redaction; anchor: { x: number; y: number } } | null>(null);
  const textRedactions = React.useMemo(() => redactions.filter((r) => r.kind === "text" && r.start != null && r.end != null), [redactions]);
  // Start from the first hit again whenever the terms or the document change (the viewer is reused across j/k navigation).
  React.useEffect(() => setHitIdx(0), [regex, doc.id]);
  React.useEffect(() => {
    const marks = containerRef.current?.querySelectorAll("mark:not([data-jump])");
    if (!marks?.length) return;
    marks.forEach((m) => m.removeAttribute("data-current"));
    const m = marks[Math.min(hitIdx, marks.length - 1)];
    m?.setAttribute("data-current", "true");
    m?.scrollIntoView({ block: "center" });
  }, [hitIdx, regex, doc.id]);
  React.useEffect(() => {
    if (!jumpTo) return;
    const el = containerRef.current?.querySelector("mark[data-jump]");
    el?.scrollIntoView({ block: "center" });
  }, [jumpTo]);

  const copyWithCite = async () => {
    const sel = window.getSelection();
    let text = sel && sel.toString().trim() && containerRef.current?.contains(sel.anchorNode) ? sel.toString().trim() : doc.text;
    let cite = doc.bates;
    const pageEl = sel?.anchorNode ? (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement)?.closest<HTMLElement>("[data-page-bates]") : null;
    if (pageEl?.dataset.pageBates && sel?.toString().trim()) cite = pageEl.dataset.pageBates;
    else if (doc.batesEnd) cite = `${doc.bates} at -${doc.batesEnd.slice(-3)}`;
    if (text.length > 4000 && text === doc.text) text = text.slice(0, 4000) + "…";
    try { await navigator.clipboard.writeText(`${text}\n\n(${cite}.)`); toast.success("Copied with Bates cite", { description: `(${cite}.)` }); } catch { toast.error("Clipboard unavailable"); }
  };

  /** Redaction mode: a text selection inside one page becomes a pending redaction anchored under the selection. */
  const onMouseUp = () => {
    if (!redactMode) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const preOf = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>("pre[data-page-start]") ?? null;
    const a = preOf(range.startContainer), b = preOf(range.endContainer);
    if (!a || a !== b) { toast.message("Select text within a single page"); return; }
    const pageStart = Number(a.dataset.pageStart ?? 0);
    const before = document.createRange();
    before.setStart(a, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const startOffset = pageStart + before.toString().length;
    const endOffset = startOffset + range.toString().length;
    if (endOffset <= startOffset) return;
    const box = range.getBoundingClientRect();
    const host = containerRef.current!.getBoundingClientRect();
    setPending({ input: { docId: doc.id, kind: "text", start: startOffset, end: endOffset }, preview: doc.text.slice(startOffset, endOffset).slice(0, 240), anchor: { x: box.left - host.left + containerRef.current!.scrollLeft, y: box.bottom - host.top + containerRef.current!.scrollTop } });
  };
  const openRedaction = (r: Redaction, e: React.MouseEvent) => {
    e.stopPropagation();
    const host = containerRef.current!.getBoundingClientRect();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOpen({ redaction: r, anchor: { x: box.left - host.left + containerRef.current!.scrollLeft, y: box.bottom - host.top + containerRef.current!.scrollTop } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/30 px-3 py-1">
        <div className="relative w-56 max-w-full">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setHitIdx((i) => (hitCount ? (i + (e.shiftKey ? -1 : 1) + hitCount) % hitCount : 0)); }} placeholder="Find in document" className="h-7 w-full rounded border border-input bg-background pl-7 pr-2 text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-label="Find in document" />
        </div>
        {regex && <span className="tabular text-[11px] text-muted-foreground">{hitCount ? `${Math.min(hitIdx + 1, hitCount)} of ${hitCount} hits` : "no hits"}</span>}
        {hitCount > 0 && <span className="flex items-center"><Tip label="Previous hit" shortcut="⇧⏎"><Button variant="ghost" size="icon-xs" className="size-6" onClick={() => setHitIdx((i) => (i - 1 + hitCount) % hitCount)} aria-label="Previous hit"><ChevronLeft className="size-3.5" /></Button></Tip><Tip label="Next hit" shortcut="⏎"><Button variant="ghost" size="icon-xs" className="size-6" onClick={() => setHitIdx((i) => (i + 1) % hitCount)} aria-label="Next hit"><ChevronRight className="size-3.5" /></Button></Tip></span>}
        <div className="flex-1" />
        {textRedactions.length > 0 && <span className="tabular text-[11px] text-muted-foreground">{textRedactions.length} text redaction{textRedactions.length === 1 ? "" : "s"}</span>}
        <span className="hidden whitespace-nowrap text-[11px] text-muted-foreground sm:inline">{(doc.pages ?? 1)} page{(doc.pages ?? 1) === 1 ? "" : "s"} · {doc.text.length.toLocaleString()} chars</span>
        <Tip label="Copy selection (or whole document) with a Bates cite"><Button variant="ghost" size="xs" onClick={copyWithCite}><ClipboardCopy className="size-3.5" /> Copy w/ cite</Button></Tip>
      </div>
      <div ref={containerRef} onMouseUp={onMouseUp} className={cn("relative min-h-0 flex-1 overflow-auto scrollbar-thin bg-muted/20 px-4 py-4 [&_mark]:rounded-sm [&_mark]:bg-warning/40 [&_mark]:px-px [&_mark]:text-foreground [&_mark[data-current=true]]:bg-chart-3 [&_mark[data-current=true]]:ring-2 [&_mark[data-current=true]]:ring-chart-3/50 [&_mark[data-jump]]:bg-primary/20 [&_mark[data-jump]]:ring-2 [&_mark[data-jump]]:ring-primary/40", redactMode && "cursor-text selection:bg-foreground/80 selection:text-background")}>
        {spans.map((span, i) => {
          const pageBates = start ? formatBates(start.prefix, start.number + i, start.width) : `${doc.bates} p.${i + 1}`;
          const pageText = doc.text.slice(span.start, span.end);
          const ranges: TextRangeMark<"redaction" | "jump">[] = textRedactions.filter((r) => r.end! > span.start && r.start! < span.end).map((r) => ({ start: r.start! - span.start, end: r.end! - span.start, kind: "redaction" as const, id: r.id }));
          if (jumpTo && jumpTo.end > span.start && jumpTo.start < span.end) ranges.push({ start: jumpTo.start - span.start, end: jumpTo.end - span.start, kind: "jump" });
          const pieces = splitRanges(pageText, ranges);
          return (
            <article key={i} data-page-bates={pageBates} className="paper mx-auto mb-4 max-w-[760px] rounded-md border px-5 py-5 sm:px-8 sm:py-6">
              <div className="mb-3 flex items-center justify-between border-b pb-1.5 font-mono text-[11px] text-muted-foreground">
                <span>Page {i + 1} of {spans.length}</span>
                <span>{pageBates}</span>
              </div>
              <pre data-page-start={span.start} className="whitespace-pre-wrap break-words font-serif text-[13.5px] leading-[1.65] text-foreground/95">
                {pieces.map((p, j) => p.kind === "plain" ? <React.Fragment key={j}>{highlight(p.text, regex, `${i}-${j}`)}</React.Fragment> : p.kind === "jump" ? <mark key={j} data-jump>{p.text}</mark> : <RedactedSpan key={j} redaction={textRedactions.find((r) => r.id === p.id)!} text={p.text} onClick={(e) => openRedaction(textRedactions.find((r) => r.id === p.id)!, e)} />)}
              </pre>
              <div className="mt-4 text-center font-mono text-[10px] text-muted-foreground">{pageBates}{doc.coding.confidentiality ? ` · ${doc.coding.confidentiality.toUpperCase()} — SUBJECT TO PROTECTIVE ORDER` : ""}</div>
            </article>
          );
        })}
        <NewRedactionPopover pending={pending} onClose={() => { setPending(null); window.getSelection()?.removeAllRanges(); }} onCreated={(r) => { setPending(null); window.getSelection()?.removeAllRanges(); onCreated(r); }} />
        <RedactionPopover redaction={open?.redaction ?? null} anchor={open?.anchor ?? null} onClose={() => setOpen(null)} onRemoved={(id) => { setOpen(null); onRemoved(id); }} />
      </div>
    </div>
  );
}

function highlight(text: string, regex: RegExp | null, keyPrefix: string): React.ReactNode {
  if (!regex) return text;
  const parts = text.split(regex);
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={`${keyPrefix}-${i}`}>{p}</mark> : p));
}

// ---------------------------------------------------------------------------
// Image view: the rendered production sheets (pdf.js) with page-rectangle redactions
// ---------------------------------------------------------------------------

interface Sheet { url: string; width: number; height: number; logical: number; first: boolean }

function ImageView({ detail, redactions, redactMode, onCreated, onRemoved }: { detail: DocDetailResponse; redactions: Redaction[]; redactMode: boolean; onCreated: (r: Redaction) => void; onRemoved: (id: string) => void }) {
  const { doc } = detail;
  const [sheets, setSheets] = React.useState<Sheet[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [pending, setPending] = React.useState<PendingRedaction | null>(null);
  const [open, setOpen] = React.useState<{ redaction: Redaction; anchor: { x: number; y: number } } | null>(null);
  const [drag, setDrag] = React.useState<{ sheet: number; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pageRedactions = React.useMemo(() => redactions.filter((r) => r.kind === "page" && r.rect), [redactions]);

  React.useEffect(() => {
    let alive = true;
    let pdf: { destroy?: () => unknown } | null = null;
    setSheets(null); setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/ediscovery/docs/${encodeURIComponent(doc.id)}/pdf`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText })) as { error?: string }).error ?? res.statusText);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const map = res.headers.get("X-Page-Map");
        const lib = await import("@/modules/office/pdf/pdfjs");
        const opened = await lib.openPdf(bytes);
        pdf = opened as unknown as { destroy?: () => unknown };
        const pageMap = parsePageMap(map, opened.numPages);
        const out: Sheet[] = [];
        const seen = new Set<number>();
        for (let i = 1; i <= opened.numPages; i++) {
          const page = await opened.getPage(i);
          const r = await lib.renderPageToDataUrl(page, { width: 900, type: "image/png" });
          const logical = pageMap[i - 1];
          out.push({ url: r.dataUrl, width: r.width, height: r.height, logical, first: !seen.has(logical) });
          seen.add(logical);
          if (!alive) return;
          setSheets([...out]);
        }
      } catch (e) { if (alive) setError((e as Error).message); }
    })();
    return () => { alive = false; void pdf?.destroy?.(); };
  }, [doc.id]);

  const hostAnchor = (clientX: number, clientY: number) => { const h = hostRef.current!.getBoundingClientRect(); return { x: clientX - h.left + hostRef.current!.scrollLeft, y: clientY - h.top + hostRef.current!.scrollTop }; };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, sheetIdx: number) => {
    if (!redactMode || (e.target as HTMLElement).closest("[data-redaction]")) return;
    const box = e.currentTarget.getBoundingClientRect();
    setDrag({ sheet: sheetIdx, x0: e.clientX - box.left, y0: e.clientY - box.top, x1: e.clientX - box.left, y1: e.clientY - box.top });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const box = e.currentTarget.getBoundingClientRect();
    setDrag({ ...drag, x1: Math.max(0, Math.min(box.width, e.clientX - box.left)), y1: Math.max(0, Math.min(box.height, e.clientY - box.top)) });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>, sheet: Sheet) => {
    if (!drag) return;
    const box = e.currentTarget.getBoundingClientRect();
    const css = dragRect(drag.x0, drag.y0, drag.x1, drag.y1);
    setDrag(null);
    const rect = cssToPageRect(css, box.width, box.height);
    if (!rect) return;
    setPending({ input: { docId: doc.id, kind: "page", page: sheet.logical, rect }, preview: `Page ${sheet.logical} · ${Math.round(rect.w * 100)}% × ${Math.round(rect.h * 100)}% of the printable area`, anchor: hostAnchor(box.left + css.left, box.top + css.top + css.height) });
  };

  if (error) return <div className="flex items-center gap-2 p-6 text-sm text-destructive"><AlertTriangle className="size-4" /> {error}</div>;
  return (
    <div ref={hostRef} className="relative h-full min-h-0 overflow-auto scrollbar-thin bg-muted/20 px-4 py-4">
      {!sheets && <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Rendering pages…</div>}
      {sheets?.map((sheet, idx) => (
        <div key={idx} className="mx-auto mb-4 w-full max-w-[720px]">
          <div className="mb-1 flex items-center justify-between font-mono text-[11px] text-muted-foreground"><span>Sheet {idx + 1} of {sheets.length} · page {sheet.logical}{!sheet.first && " (continued)"}</span>{pageRedactions.filter((r) => r.page === sheet.logical).length > 0 && sheet.first && <span>{pageRedactions.filter((r) => r.page === sheet.logical).length} redaction{pageRedactions.filter((r) => r.page === sheet.logical).length === 1 ? "" : "s"}</span>}</div>
          <div className={cn("relative select-none rounded-md border bg-white shadow-sm", redactMode && sheet.first && "cursor-crosshair", drag?.sheet === idx && "touch-none")} onPointerDown={(e) => sheet.first && onPointerDown(e, idx)} onPointerMove={onPointerMove} onPointerUp={(e) => onPointerUp(e, sheet)} style={{ aspectRatio: `${sheet.width} / ${sheet.height}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sheet.url} alt={`${doc.bates} sheet ${idx + 1}`} className="block h-auto w-full rounded-md" draggable={false} />
            {sheet.first && <SheetOverlay sheetIdx={idx} sheet={sheet} redactions={pageRedactions.filter((r) => r.page === sheet.logical)} drag={drag?.sheet === idx ? drag : null} onOpen={(r, e) => { e.stopPropagation(); setOpen({ redaction: r, anchor: hostAnchor(e.clientX, e.clientY) }); }} />}
          </div>
          {!sheet.first && <div className="mt-1 text-[10.5px] text-muted-foreground">Continuation sheet — page redactions attach to the page&apos;s first sheet.</div>}
        </div>
      ))}
      <NewRedactionPopover pending={pending} onClose={() => setPending(null)} onCreated={(r) => { setPending(null); onCreated(r); }} />
      <RedactionPopover redaction={open?.redaction ?? null} anchor={open?.anchor ?? null} onClose={() => setOpen(null)} onRemoved={(id) => { setOpen(null); onRemoved(id); }} />
    </div>
  );
}

function SheetOverlay({ sheet, redactions, drag, onOpen }: { sheetIdx: number; sheet: Sheet; redactions: Redaction[]; drag: { x0: number; y0: number; x1: number; y1: number } | null; onOpen: (r: Redaction, e: React.MouseEvent) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setSize({ w: e.contentRect.width, h: e.contentRect.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const boxes = size.w ? redactions.map((r) => ({ r, css: pageRectToCss(r.rect!, size.w, size.h) })) : [];
  const dragCss: CssRect | null = drag ? dragRect(drag.x0, drag.y0, drag.x1, drag.y1) : null;
  return (
    <div ref={ref} className="absolute inset-0" aria-label={`Page ${sheet.logical} redactions`}>
      {boxes.map(({ r, css }) => (
        <button key={r.id} type="button" data-redaction={r.id} onClick={(e) => onOpen(r, e)} title={`${r.label} — click for details`} style={{ position: "absolute", left: css.left, top: css.top, width: css.width, height: css.height }} className="flex items-center justify-center overflow-hidden bg-black text-[9px] font-semibold text-white hover:outline hover:outline-2 hover:outline-primary/70 cursor-pointer" aria-label={`Redacted: ${r.label}`}>{css.height > 12 && css.width > 60 ? r.label : null}</button>
      ))}
      {dragCss && dragCss.width > 2 && dragCss.height > 2 && <div style={{ position: "absolute", left: dragCss.left, top: dragCss.top, width: dragCss.width, height: dragCss.height }} className="border border-dashed border-primary bg-primary/15 pointer-events-none" aria-hidden />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Indian record fields: exhibit mark and marking, record class, number in the list of documents, language / translation. */
function indiaMetadata(doc: IndiaEDocument): { label: string; value: React.ReactNode; mono?: boolean }[] {
  const i = doc.india;
  if (!i) return [];
  const lang = (code?: string) => (code ? languageInfo(code)?.name ?? code : undefined);
  return [
    { label: "Exhibit", value: i.exhibit ? `${i.exhibit}${i.markedThrough ? ` · marked through ${i.markedThrough}` : ""}${i.markedOn ? ` on ${formatShortDate(i.markedOn)}` : ""}${i.markedSubjectToObjection ? " (subject to objection)" : ""}` : "Not marked", mono: !!i.exhibit },
    { label: "Record", value: `${docClassLabel(i.docClass)}${i.title ? ` — ${i.title}` : ""}` },
    { label: "Doc. no.", value: i.docNumber },
    { label: "Filed by", value: i.filedBy ? i.filedBy.charAt(0).toUpperCase() + i.filedBy.slice(1).replace(/_/g, " ") : undefined },
    { label: "Language", value: i.docClass === "translation" ? `${lang(i.language) ?? "—"} (translation${i.translationOrigin === "machine" ? ", machine" : i.translationOrigin === "provider" ? ", filed by a party" : ""}; the original is the text of record)` : lang(i.language) ? `${lang(i.language)} (original, text of record)` : undefined },
    { label: "Translation of", value: i.translationOf, mono: true },
  ];
}

function MetadataView({ detail }: { detail: DocDetailResponse }) {
  const { doc } = detail;
  const { issueCodes } = useReview();
  const items = [
    ...indiaMetadata(doc as IndiaEDocument),
    { label: "Doc. ref.", value: `${doc.bates}${doc.batesEnd ? ` – ${doc.batesEnd}` : ""}`, mono: true },
    { label: "Document id", value: doc.id, mono: true },
    { label: "Date", value: formatShortDate(doc.date) },
    { label: "Type", value: <span className="flex items-center gap-1.5"><TypeIcon type={doc.type} />{doc.type}</span> },
    { label: "Source", value: doc.custodianName },
    { label: "From", value: doc.from },
    { label: "To", value: doc.to?.length ? doc.to.join("; ") : undefined },
    { label: "Cc", value: doc.cc?.length ? doc.cc.join("; ") : undefined },
    { label: "Pages", value: String(doc.pages ?? 1) },
    { label: "Collection", value: doc.source },
    { label: "MD5 / hash", value: doc.hash, mono: true },
    { label: "Thread id", value: doc.family?.threadId, mono: true },
    { label: "Parent", value: detail.family.parent?.bates, mono: true },
    { label: "Duplicate of", value: detail.family.duplicateOf?.bates, mono: true },
    { label: "Near-duplicates", value: detail.family.nearDuplicates.length ? detail.family.nearDuplicates.map((n) => `${n.bates}${doc.nearDuplicateScores?.[n.id] != null ? ` (${Math.round(doc.nearDuplicateScores[n.id] * 100)}%)` : ""}`).join(", ") : undefined, mono: true },
    { label: "Tags", value: doc.tags?.length ? doc.tags.join(", ") : undefined },
    { label: "Suggested score", value: doc.aiScore != null ? <ScoreBar value={doc.aiScore} /> : undefined },
    { label: "Suggested issues", value: doc.aiIssues?.length ? <span className="flex flex-wrap gap-1">{doc.aiIssues.map((c) => <IssueChip key={c} code={c} codes={issueCodes} size="xs" />)}</span> : undefined },
    { label: "Reviewed by", value: detail.reviewerName ? `${detail.reviewerName}${doc.coding.reviewedAt ? ` · ${formatDateTime(doc.coding.reviewedAt)}` : ""}` : undefined },
  ];
  return (
    <div className="h-full overflow-auto scrollbar-thin p-4">
      <KeyValueList items={items} labelWidth={150} />
      {doc.entities && (
        <div className="mt-5 space-y-2">
          <div className="text-[12px] font-medium text-muted-foreground">Entities</div>
          {(["people", "orgs", "places", "chemicals"] as const).map((k) => doc.entities?.[k]?.length ? <div key={k} className="flex flex-wrap items-baseline gap-1 text-[12px]"><span className="w-20 text-[11px] capitalize text-muted-foreground">{k}</span>{doc.entities[k]!.map((e) => <Badge key={e} variant="outline" size="sm" className="font-normal">{e}</Badge>)}</div> : null)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Family (with "code the family")
// ---------------------------------------------------------------------------

function FamilyView({ detail, onOpen }: { detail: DocDetailResponse; onOpen: (id: string) => void }) {
  const f = detail.family;
  const list = React.useContext(ReviewListContext);
  const [busy, setBusy] = React.useState(false);
  const members = [...(f.parent ? [f.parent] : []), ...f.attachments].filter((m) => m.id !== detail.doc.id);
  const codeFamily = async () => {
    const c = detail.doc.coding;
    if (c.responsive == null && c.privileged == null && !c.hot && !(c.issues?.length)) { toast.message("Code this document first, then apply it to the family."); return; }
    setBusy(true);
    try { await list.codeDocs(members.map((m) => m.id), { responsive: c.responsive ?? null, privileged: c.privileged ?? null, privilegeBasis: c.privilegeBasis, hot: !!c.hot, issues: [...(c.issues ?? [])], confidentiality: c.confidentiality }); toast.success(`Family coded like ${detail.doc.bates}`, { description: `${members.length} document${members.length === 1 ? "" : "s"}` }); }
    finally { setBusy(false); }
  };
  const groups: { title: string; icon: React.ElementType; rows: DocRow[]; hint?: string }[] = [
    { title: "Parent", icon: ArrowUpLeft, rows: f.parent ? [f.parent] : [] },
    { title: "Attachments", icon: Paperclip, rows: f.attachments },
    { title: "Email thread", icon: MessagesSquare, rows: f.thread, hint: "chronological" },
    { title: "Exact duplicates", icon: Copy, rows: [...(f.duplicateOf ? [f.duplicateOf] : []), ...f.duplicates], hint: "same hash — coding propagates on save" },
    { title: "Near-duplicates", icon: Files, rows: f.nearDuplicates, hint: "MinHash similarity" },
  ].filter((g) => g.rows.length);
  if (!groups.length) return <div className="p-6 text-sm text-muted-foreground">This document has no family, thread or duplicate relationships.</div>;
  return (
    <div className="h-full overflow-auto scrollbar-thin p-3">
      {members.length > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-md border px-2.5 py-1.5 text-[11.5px]">
          <span className="text-muted-foreground">Families travel together in production. Apply this document&apos;s coding to its {members.length} family member{members.length === 1 ? "" : "s"}.</span>
          <Button size="xs" variant="outline" className="ml-3 shrink-0" onClick={() => void codeFamily()} disabled={busy}>{busy ? <Loader2 className="size-3 animate-spin" /> : <Layers className="size-3" />} Code the family</Button>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.title} className="mb-4">
          <div className="mb-1 flex items-center gap-1.5 px-1 text-[12px] font-medium text-muted-foreground"><g.icon className="size-3.5" />{g.title}<span className="font-normal normal-case tracking-normal">· {g.rows.length}{g.hint ? ` · ${g.hint}` : ""}</span></div>
          <ul className="divide-y rounded-md border">
            {g.rows.map((r) => <li key={r.id}><RowButton row={r} current={r.id === detail.doc.id} onClick={() => onOpen(r.id)} trailing={g.title === "Near-duplicates" && detail.doc.nearDuplicateScores?.[r.id] != null ? <span className="tabular text-[10.5px] text-muted-foreground">{Math.round(detail.doc.nearDuplicateScores[r.id] * 100)}%</span> : undefined} /></li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function RowButton({ row, current, onClick, trailing }: { row: DocRow; current?: boolean; onClick: () => void; trailing?: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={current} className={cn("flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs transition-colors cursor-pointer disabled:cursor-default", current ? "bg-primary/10" : "hover:bg-accent/60")}>
      <TypeIcon type={row.type} />
      <span className="w-[104px] shrink-0 font-mono tabular">{row.bates}</span>
      <span className="w-[76px] shrink-0 tabular text-muted-foreground">{formatShortDate(row.date)}</span>
      <span className="min-w-0 flex-1 truncate">{row.subject}</span>
      <span className="hidden w-24 shrink-0 truncate text-muted-foreground md:inline">{row.custodianName}</span>
      <DecisionCell coding={row.coding} />
      {trailing}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Similar
// ---------------------------------------------------------------------------

const REASON_LABEL: Record<SimilarDoc["reason"], string> = { semantic: "semantic", keyword: "keyword", duplicate: "duplicate", "near-duplicate": "near-dup", thread: "thread", family: "family" };

function SimilarView({ docId, active, onOpen }: { docId: string; active: boolean; onOpen: (id: string) => void }) {
  const { aiConfigured } = useReview();
  const sim = useSimilar(docId, active);
  if (sim.loading && !sim.data) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Finding similar documents…</div>;
  if (sim.error) return <div className="flex items-center gap-2 p-6 text-sm text-destructive"><AlertTriangle className="size-4" /> {sim.error.message}</div>;
  const rows = sim.data?.similar ?? [];
  return (
    <div className="h-full overflow-auto scrollbar-thin p-3">
      <p className="mb-2 px-1 text-[11px] text-muted-foreground">{aiConfigured ? "Hybrid ranking: embeddings fused with BM25 keyword scores." : "Keyword (BM25) similarity — configure an AI provider for embedding-based ranking."} Family, thread and duplicate relations are listed first.</p>
      {!rows.length ? <div className="p-4 text-sm text-muted-foreground">No similar documents found.</div> : (
        <ul className="divide-y rounded-md border">
          {rows.map((r) => (
            <li key={r.id}>
              <button onClick={() => onOpen(r.id)} className="flex w-full flex-col gap-1 px-2.5 py-2 text-left text-xs hover:bg-accent/60 cursor-pointer">
                <span className="flex items-center gap-2">
                  <TypeIcon type={r.type} />
                  <span className="font-mono tabular">{r.bates}</span>
                  <span className="tabular text-muted-foreground">{formatShortDate(r.date)}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{r.subject}</span>
                  <StateChip tone={r.reason === "semantic" ? "info" : "muted"}>{REASON_LABEL[r.reason]}</StateChip>
                  <ScoreBar value={Math.round(r.score * 100)} showValue={false} className="shrink-0" />
                </span>
                <span className="line-clamp-2 pl-5 text-[11px] text-muted-foreground">{r.passage}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History: the document's audit trail (coding, AI, redactions, exports), batches, redactions
// ---------------------------------------------------------------------------

function HistoryView({ docId, active, redactions }: { docId: string; active: boolean; redactions: Redaction[] }) {
  const h = useDocHistory(docId, active);
  if (h.loading && !h.data) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading the audit log…</div>;
  if (h.error) return <div className="flex items-center gap-2 p-6 text-sm text-destructive"><AlertTriangle className="size-4" /> {h.error.message}</div>;
  const rows = h.data?.history ?? [];
  const batches = h.data?.batches ?? [];
  return (
    <div className="h-full overflow-auto scrollbar-thin p-3">
      {batches.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 px-1 text-[12px] font-medium text-muted-foreground">Batches</div>
          <ul className="divide-y rounded-md border text-[11.5px]">{batches.map((b) => <li key={b.id} className="flex h-7 items-center gap-2 px-2.5"><Layers className="size-3 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{b.name}</span>{b.qc && <StateChip tone="info">QC sample</StateChip>}</li>)}</ul>
        </div>
      )}
      {redactions.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 px-1 text-[12px] font-medium text-muted-foreground">Redactions · {redactions.length}</div>
          <ul className="divide-y rounded-md border text-[11.5px]">{redactions.map((r) => <li key={r.id} className="flex h-7 items-center gap-2 px-2.5"><EyeOff className="size-3 text-muted-foreground" /><span className="font-mono text-[11px]">{r.label}</span><span className="min-w-0 flex-1 truncate text-muted-foreground">{r.kind === "text" ? r.quote ?? `chars ${r.start}–${r.end}` : `page ${r.page}`}</span><span className="tabular text-[10.5px] text-muted-foreground">{formatDateTime(r.createdAt)}</span></li>)}</ul>
        </div>
      )}
      <div className="mb-1 flex items-center gap-1.5 px-1 text-[12px] font-medium text-muted-foreground"><History className="size-3.5" /> Audit trail · {rows.length}</div>
      {!rows.length ? <div className="rounded-md border border-dashed p-4 text-center text-[12px] text-muted-foreground">No recorded events for this document yet.</div> : (
        <ol className="divide-y rounded-md border">
          {rows.map((e) => (
            <li key={e.id} className="px-2.5 py-1.5 text-[11.5px]">
              <div className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate font-medium">{e.summary}</span><span className="shrink-0 tabular text-[10.5px] text-muted-foreground">{formatDateTime(e.ts)}</span></div>
              <div className="text-[11px] text-muted-foreground">{e.actorName} · {e.action}{e.fields?.length ? ` · ${e.fields.join(", ")}` : ""}</div>
              {e.before && e.after && e.fields?.length ? <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{e.fields.map((f) => `${f}: ${fmt(e.before?.[f])} → ${fmt(e.after?.[f])}`).join(" · ")}</div> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function fmt(v: unknown): string {
  if (v == null) return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  if (typeof v === "boolean") return v ? "yes" : "no";
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}
