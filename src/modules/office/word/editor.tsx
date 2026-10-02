"use client";
import * as React from "react";
import Link from "next/link";
import { EditorContent, useEditor } from "@tiptap/react";
import { Typography } from "@tiptap/extension-typography";
import { CharacterCount } from "@tiptap/extension-character-count";
import { Placeholder } from "@tiptap/extensions";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, FileCode2, FileText, FileType2, History, MessageSquare, PanelLeft, Printer, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Matter, OfficeComment } from "@/lib/types/domain";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/misc";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TopbarSlot } from "@/components/shell/app-shell";
import { OfficeAgentPanel, saveStateLabel, useOfficeDoc, type ApplyResult, type EditProposal, type OfficeScope } from "@/modules/office/shared";
import { ChromeToggle, OfficeChrome, ToolbarSkeleton, TrackedChangesStrip, useNarrowViewport, type DownloadItem } from "@/modules/office/shared/office-chrome";
import "./word.css";
import { applyProposal, revealBlock, revealPosition } from "./apply-proposals";
import { debounce, downloadDocx, downloadMarkdown, downloadText, printDocument, renderMermaidToImageUrl, uploadBlob } from "./client-utils";
import { CommentsSidebar, commentAnchorPos } from "./comments-sidebar";
import { DEFAULT_SETTINGS, FONT_FAMILIES, LANGUAGES, MARGIN_PRESETS, PAGE_SIZES, settingsForTemplate, type DocSettings } from "./constants";
import { DiagramDialog, PromptDialog, type PromptRequest } from "./dialogs";
import { collectFootnotes, docStats, emptyDoc, estimatePages, newId, type DocSection, type PMNode } from "./doc-model";
import { FindHighlights, ParagraphGutter, collectEditorChanges, findBlockPos, type EditorChange, type TrackChangesStorage } from "./extensions";
import { wordSchemaExtensions } from "./schema-extensions";
import { isDocxMeta, type DocxImportedComment, type DocxMeta } from "./ooxml/types";
import { buildTemplateSection, tableOfContents, type TemplateSectionId } from "./sections";
import { computeOutline, WordSidebar, type OutlineItem, type SidebarTab } from "./sidebar";
import { bodyHash, ExportGateDialog, recordAcknowledgement, type GateKind, type GateResult } from "./filing-check-ui";
import { declarationHtml, type CheckState } from "./provenance";
import { filingSummary } from "./filing-check";
import { buildSnapshot } from "./snapshot";
import { StatusBar } from "./status-bar";
import { applyParagraphStyle, WordToolbar, type InsertAction } from "./toolbar";
import { VersionsDialog } from "./versions-dialog";
import { useWorkspaceUserName } from "../shared/use-workspace-user";

const SUGGESTIONS = {
  draft: [
    "Draft a model 8-page comprehensive mock report on the current state of the case with headings, a timeline table and next steps",
    "Tighten the Legal standard section and add FRCP 56(a)",
    "Convert the argument to a numbered outline",
    "Insert a signature block and certificate of service",
    "Add a table of contents after the caption",
  ],
  review: ["Cite-check and flag placeholders", "Check defined terms and cross-references", "Review for consistency and tone", "What is missing for a D.S.C. filing?"],
  ask: ["Summarize the argument", "What authorities are cited?", "What is missing for a D.S.C. filing?"],
};

export interface WordEditorPageProps { id: string; templateId?: string | null; matterId?: string | null; matters: Matter[]; initialMode?: "draft" | "review" | "ask" }

interface CursorInfo { paraIndex: number; paraId: string | null; total: number; headingId: string | null; headingText: string; selectionText: string; selectionBlockIds: string[]; sectionText: string; paraText: string }

function computeCursor(editor: Editor): CursorInfo {
  const { from, to, empty } = editor.state.selection;
  let index = 0, paraIndex = 0, total = 0;
  let paraId: string | null = null, paraText = "";
  let headingId: string | null = null, headingText = "", headingLevel = 1;
  const sectionParts: string[] = [];
  let collecting = false, collected = 0, sectionDone = false;
  const selIds = new Set<string>();
  editor.state.doc.descendants((node, pos) => {
    const leaf = node.isTextblock || node.type.name === "image" || node.type.name === "pageBreak" || node.type.name === "horizontalRule";
    if (!leaf) return true;
    index++; total++;
    const end = pos + node.nodeSize;
    const isHeading = node.type.name === "heading";
    if (pos <= from) {
      if (isHeading) { headingId = String(node.attrs.id ?? ""); headingText = node.textContent; headingLevel = Number(node.attrs.level ?? 1); sectionParts.length = 0; collected = 0; collecting = true; sectionDone = false; }
      if (from < end || (from === end && pos <= from)) { paraIndex = index; paraId = String(node.attrs.id ?? ""); paraText = node.textContent; }
    } else if (isHeading && collecting && Number(node.attrs.level ?? 1) <= headingLevel) { collecting = false; sectionDone = true; }
    if (collecting && !sectionDone && collected < 8000 && node.isTextblock) { const t = node.textContent; sectionParts.push(t); collected += t.length; }
    if (!empty && pos < to && end > from) selIds.add(String(node.attrs.id ?? ""));
    return false;
  });
  return { paraIndex, paraId, total, headingId, headingText, selectionText: empty ? "" : editor.state.doc.textBetween(from, to, "\n"), selectionBlockIds: Array.from(selIds), sectionText: sectionParts.join("\n").slice(0, 8000), paraText };
}

export function WordEditorPage({ id, templateId, matterId, matters, initialMode }: WordEditorPageProps) {
  const office = useOfficeDoc<PMNode>({ id, kind: "word", emptyContent: emptyDoc, templateId: templateId ?? null, matterId: matterId ?? null, autosaveMs: 1500 });
  const { doc, loading, error } = office;
  const narrow = useNarrowViewport();
  const [settings, setSettings] = React.useState<DocSettings>(DEFAULT_SETTINGS);
  const [trackChanges, setTrackChangesState] = React.useState(true);
  const [ready, setReady] = React.useState(false);
  /** Mirrors `ready` for editor callbacks: updates before the document is loaded are never treated as edits. */
  const readyRef = React.useRef(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [sidebarTab, setSidebarTab] = React.useState<SidebarTab>("outline");
  const [findFocusKey, setFindFocusKey] = React.useState(0);
  const [commentsOpen, setCommentsOpen] = React.useState(true);
  const [agentOpen, setAgentOpen] = React.useState(true);
  const [view, setView] = React.useState<"edit" | "preview">("edit");
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [versionsCount, setVersionsCount] = React.useState<number | undefined>(undefined);
  const [diagramOpen, setDiagramOpen] = React.useState(false);
  const [diagramInitial, setDiagramInitial] = React.useState<{ source: string; pos: number } | null>(null);
  const [prompt, setPrompt] = React.useState<PromptRequest | null>(null);
  const promptResolver = React.useRef<((v: { value: string; secondary?: string } | null) => void) | null>(null);
  const [outline, setOutline] = React.useState<OutlineItem[]>([]);
  const [changes, setChanges] = React.useState<EditorChange[]>([]);
  const [changeIndex, setChangeIndex] = React.useState(0);
  const [cursor, setCursor] = React.useState<CursorInfo>({ paraIndex: 0, paraId: null, total: 0, headingId: null, headingText: "", selectionText: "", selectionBlockIds: [], sectionText: "", paraText: "" });
  const [words, setWords] = React.useState(0);
  const [footnotes, setFootnotes] = React.useState<{ id: string; text: string; index: number }[]>([]);
  const [dbComments, setComments] = React.useState<OfficeComment[]>([]);
  /** Comments that came with an imported .docx: kept in doc.meta.docx.comments with their Word author/date. */
  const [importedComments, setImportedComments] = React.useState<DocxImportedComment[]>([]);
  const importedCommentsRef = React.useRef<DocxImportedComment[]>([]);
  importedCommentsRef.current = importedComments;
  const importedIds = React.useMemo(() => new Set(importedComments.map((c) => c.id)), [importedComments]);
  const importedIdsRef = React.useRef(importedIds);
  importedIdsRef.current = importedIds;
  const comments = React.useMemo<OfficeComment[]>(() => [
    ...importedComments.map((c) => ({ id: c.id, docId: id, anchor: c.anchor, quote: c.quote, body: c.text, authorName: c.author, createdAt: c.date ?? "", resolved: c.resolved, replies: [] })),
    ...dbComments,
  ], [importedComments, dbComments, id]);
  const [activeComment, setActiveComment] = React.useState<string | null>(null);
  const [showResolved, setShowResolved] = React.useState(false);
  const [layoutKey, setLayoutKey] = React.useState(0);
  const [zoomMode, setZoomMode] = React.useState<"fit" | number>("fit");
  const [canvasWidth, setCanvasWidth] = React.useState(0);
  const [exporting, setExporting] = React.useState<string | null>(null);
  /** Pre-export filing check gate (docx / PDF). */
  const [gate, setGate] = React.useState<GateKind | null>(null);
  const [title, setTitle] = React.useState("");
  const canvasRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const matter = React.useMemo(() => matters.find((m) => m.id === (doc?.matterId ?? matterId)) ?? null, [matters, doc?.matterId, matterId]);

  // Narrow viewports (≤1180px) open with the outline and comment margin collapsed; the user can reopen them.
  const autoCollapsed = React.useRef(false);
  React.useEffect(() => { if (narrow && !autoCollapsed.current) { autoCollapsed.current = true; setSidebarOpen(false); setCommentsOpen(false); } }, [narrow]);
  // Mid-width viewports (≤1440px) cannot fit outline + page + comment margin + assistant side by side: fold the outline once when all three are open.
  const mid = useNarrowViewport(1440);
  const autoFolded = React.useRef(false);
  React.useEffect(() => { if (mid && !narrow && agentOpen && commentsOpen && sidebarOpen && !autoFolded.current) { autoFolded.current = true; setSidebarOpen(false); } }, [mid, narrow, agentOpen, commentsOpen, sidebarOpen]);

  const ask = React.useCallback((req: PromptRequest) => new Promise<{ value: string; secondary?: string } | null>((res) => { promptResolver.current = res; setPrompt(req); }), []);

  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: [
      ...wordSchemaExtensions({ trackChanges: true, author: "You" }),
      Typography, CharacterCount,
      Placeholder.configure({ placeholder: "Start drafting, or press ⌘/ to ask the assistant…" }),
      ParagraphGutter, FindHighlights,
    ],
    editorProps: {
      attributes: { class: "word-prose", spellcheck: "true" },
      handleDoubleClickOn: (_view, pos, node) => {
        if (node.type.name === "image" && node.attrs.mermaid) { setDiagramInitial({ source: String(node.attrs.mermaid), pos }); setDiagramOpen(true); return true; }
        return false;
      },
      handleClickOn: (_view, _pos, node, _nodePos, event) => {
        const el = (event.target as HTMLElement | null)?.closest?.("[data-comment-id]") as HTMLElement | null;
        if (el) { setActiveComment(el.getAttribute("data-comment-id")); setCommentsOpen(true); }
        void node;
        return false;
      },
    },
    onUpdate: ({ editor: e }) => { if (!readyRef.current) return; scheduleDirty(e); scheduleDerived(e); setLayoutKey((k) => k + 1); },
    onSelectionUpdate: ({ editor: e }) => scheduleCursor(e),
  });

  // ---- debounced derived state (stable across renders; office handle read through a ref) ----
  const officeRef = React.useRef(office);
  officeRef.current = office;
  const scheduleDirty = React.useMemo(() => debounce((e: Editor) => { officeRef.current.markDirty(e.getJSON() as PMNode); }, 500), []);
  const scheduleDerived = React.useMemo(() => debounce((e: Editor) => {
    if (e.isDestroyed) return;
    setOutline(computeOutline(e));
    setChanges(collectEditorChanges(e.state.doc));
    setWords((e.storage as unknown as { characterCount: { words: () => number } }).characterCount.words());
    setFootnotes(collectFootnotes(e.getJSON() as PMNode).map((f) => ({ id: f.id, text: f.text, index: f.index })));
  }, 300), []);
  const scheduleCursor = React.useMemo(() => debounce((e: Editor) => { if (!e.isDestroyed) setCursor(computeCursor(e)); }, 120), []);
  React.useEffect(() => () => { scheduleDirty.cancel(); scheduleDerived.cancel(); scheduleCursor.cancel(); }, [scheduleDirty, scheduleDerived, scheduleCursor]);
  /** Load content without tracking it as an edit. */
  const loadContent = React.useCallback((e: Editor, content: PMNode) => {
    const tc = (e.storage as unknown as { trackChanges: TrackChangesStorage }).trackChanges;
    const was = tc.enabled;
    tc.enabled = false;
    try { e.commands.setContent(content, { emitUpdate: false }); } finally { tc.enabled = was; }
  }, []);

  // Tracked changes are attributed to the signed-in user (read once from the workspace).
  const authorName = useWorkspaceUserName();
  React.useEffect(() => {
    if (editor && !editor.isDestroyed) (editor.storage as unknown as { trackChanges: TrackChangesStorage }).trackChanges.author = authorName;
  }, [editor, authorName]);

  // ---- load document into editor ----------------------------------------------
  React.useEffect(() => {
    if (!editor || !doc || ready) return;
    const meta = (doc.meta ?? {}) as { settings?: Partial<DocSettings>; trackChanges?: boolean };
    const s = { ...settingsForTemplate(doc.templateId ?? templateId), ...(meta.settings ?? {}) };
    setSettings(s);
    const tc = meta.trackChanges ?? true;
    setTrackChangesState(tc);
    (editor.storage as unknown as { trackChanges: TrackChangesStorage }).trackChanges.enabled = tc;
    loadContent(editor, (doc.content as PMNode) ?? emptyDoc());
    editor.setEditable(true, false);
    setTitle(doc.title);
    readyRef.current = true;
    setReady(true);
    scheduleDerived(editor);
    scheduleCursor(editor);
    const docxMeta = (doc.meta as { docx?: unknown } | undefined)?.docx;
    if (isDocxMeta(docxMeta)) setImportedComments(docxMeta.comments ?? []);
    if (doc.id !== "new") void office.comments.list().then(setComments).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, doc, ready]);

  const docTitle = doc?.title;
  React.useEffect(() => { if (docTitle && document.activeElement?.getAttribute("data-title-input") !== "1") setTitle(docTitle); }, [docTitle]);
  React.useEffect(() => { if (ready) editor?.setEditable(view === "edit", false); }, [view, editor, ready]);
  // Version count for the assistant header ("Versions (n)"); refreshed after each save.
  const contentVersion = doc?.contentVersion;
  React.useEffect(() => {
    if (!ready || !doc?.id) return;
    let alive = true;
    officeRef.current.versions.list().then((v) => { if (alive) setVersionsCount(v.length); }).catch(() => {});
    return () => { alive = false; };
  }, [ready, doc?.id, contentVersion]);
  // Development hook for browser automation / debugging (never in production builds).
  React.useEffect(() => { if (process.env.NODE_ENV !== "production" && editor) (window as unknown as { __leclaudeWordEditor?: Editor; __leclaudeWordApply?: unknown }).__leclaudeWordEditor = editor; }, [editor]);

  // ---- settings & track changes persistence ------------------------------------
  const persistMeta = React.useMemo(() => debounce((meta: Record<string, unknown>) => { void officeRef.current.save({ meta }); }, 800), []);
  const updateSettings = (patch: Partial<DocSettings>) => { setSettings((s) => { const next = { ...s, ...patch }; persistMeta({ settings: next }); return next; }); };
  const setTrackChanges = React.useCallback((on: boolean) => {
    setTrackChangesState(on);
    editor?.commands.setTrackChanges(on);
    persistMeta({ trackChanges: on });
    toast(on ? "Track changes on — edits are marked" : "Track changes off", { duration: 1500 });
  }, [editor, persistMeta]);

  // ---- save -------------------------------------------------------------------
  const saveNow = React.useCallback(async (version?: { summary?: string; label?: string; authorName?: string }) => {
    if (!editor) return;
    scheduleDirty.cancel();
    officeRef.current.contentRef.current = editor.getJSON() as PMNode;
    const r = await officeRef.current.save(version ? { version: { ...version, force: true } } : {});
    if (r && !version) toast.success("Saved", { duration: 1200 });
  }, [editor, scheduleDirty]);

  const commitTitle = async () => { const t = title.trim() || "Untitled document"; if (t !== doc?.title) await office.setTitle(t); };

  // ---- comments ---------------------------------------------------------------
  const refreshComments = React.useCallback(async () => { try { setComments(await office.comments.list()); } catch { /* ignore */ } }, [office]);
  /** Persist a change to the imported .docx comments (resolution, replies, deletion) in doc.meta.docx. */
  const updateImportedComments = React.useCallback(async (fn: (cs: DocxImportedComment[]) => DocxImportedComment[]) => {
    const meta = (officeRef.current.doc?.meta as { docx?: unknown } | undefined)?.docx;
    if (!isDocxMeta(meta)) return;
    const next = fn(importedCommentsRef.current);
    setImportedComments(next);
    importedCommentsRef.current = next;
    const docx: DocxMeta = { ...meta, comments: next };
    await officeRef.current.save({ meta: { docx } });
  }, []);
  const addCommentAtSelection = React.useCallback(async () => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const info = computeCursor(editor);
    if (!info.paraId) { toast.error("Place the cursor in a paragraph first"); return; }
    const quote = empty ? undefined : editor.state.doc.textBetween(from, to, " ").slice(0, 300);
    const r = await ask({ title: "Add comment", description: quote ? `On “${quote.slice(0, 80)}${quote.length > 80 ? "…" : ""}”` : `On ¶${info.paraIndex}`, placeholder: "Write a comment…", multiline: true, confirm: "Comment" });
    if (!r?.value) return;
    const c = await office.comments.add({ anchor: info.paraId, body: r.value, quote, source: "user" });
    if (!empty) editor.chain().focus().setMark("comment", { id: c.id }).setMeta("trackChanges", "ignore").run();
    setComments((cs) => [...cs, c]);
    setActiveComment(c.id);
    setCommentsOpen(true);
  }, [editor, office, ask]);

  const locateComment = React.useCallback((c: OfficeComment) => {
    if (!editor) return;
    const pos = commentAnchorPos(editor, c);
    if (pos == null) return;
    revealPosition(editor, pos - 1);
    canvasRef.current?.querySelectorAll(".comment-active").forEach((el) => el.classList.remove("comment-active"));
    canvasRef.current?.querySelectorAll(`[data-comment-id="${c.id}"]`).forEach((el) => el.classList.add("comment-active"));
  }, [editor]);

  // ---- tracked changes navigation ----------------------------------------------
  const goToChange = React.useCallback((idx: number) => {
    if (!editor || !changes.length) return;
    const i = ((idx % changes.length) + changes.length) % changes.length;
    setChangeIndex(i);
    const c = changes[i];
    try { editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, c.from, c.to)).scrollIntoView()); editor.view.focus(); } catch { /* ignore */ }
    const dom = editor.view.domAtPos(c.from).node; const el = dom instanceof HTMLElement ? dom : dom.parentElement; el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [editor, changes]);
  const resolveCurrent = (mode: "accept" | "reject") => { if (!editor || !changes.length) return; const c = changes[Math.min(changeIndex, changes.length - 1)]; if (mode === "accept") editor.commands.acceptChange(c.id); else editor.commands.rejectChange(c.id); toast.success(mode === "accept" ? "Change accepted" : "Change rejected", { duration: 1200 }); };
  const resolveAll = (mode: "accept" | "reject") => { if (!editor) return; const n = changes.length; if (mode === "accept") editor.commands.acceptAllChanges(); else editor.commands.rejectAllChanges(); toast.success(`${mode === "accept" ? "Accepted" : "Rejected"} ${n} change${n === 1 ? "" : "s"}`); void saveNow({ summary: `${mode === "accept" ? "Accepted" : "Rejected"} all tracked changes (${n})` }); };
  const changeAuthors = React.useMemo(() => Array.from(new Set(changes.map((c) => c.author).filter(Boolean))), [changes]);

  // ---- insert actions -----------------------------------------------------------
  const sectionsForToc = (): DocSection[] => outline.map((o) => ({ id: o.id, title: o.text, level: o.level, index: o.index, wordCount: o.words, blockCount: 0, start: o.index, end: o.index }));
  const insertBlocks = (blocks: PMNode[]) => { editor?.chain().focus().insertContent(blocks).run(); };
  const onInsert = async (action: InsertAction) => {
    if (!editor) return;
    switch (action) {
      case "table": editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
      case "image": fileInputRef.current?.click(); break;
      case "diagram": setDiagramInitial(null); setDiagramOpen(true); break;
      case "link": {
        const prev = editor.getAttributes("link").href as string | undefined;
        const r = await ask({ title: prev ? "Edit link" : "Insert link", label: "URL", placeholder: "https://", defaultValue: prev ?? "", confirm: prev ? "Update" : "Insert" });
        if (r === null) return;
        if (!r.value) editor.chain().focus().extendMarkRange("link").unsetLink().run();
        else editor.chain().focus().extendMarkRange("link").setLink({ href: /^(https?:|mailto:|\/)/.test(r.value) ? r.value : `https://${r.value}` }).run();
        break;
      }
      case "footnote": {
        if (editor.state.selection.empty) { toast.error("Select the text the footnote should follow"); return; }
        const r = await ask({ title: "Insert footnote", label: "Footnote text", placeholder: "See Fed. R. Civ. P. 56(c)(1)(A).", multiline: true, confirm: "Insert" });
        if (!r?.value) return;
        editor.chain().focus().setMark("footnote", { id: nanoid(6), text: r.value }).setMeta("trackChanges", "ignore").run();
        break;
      }
      case "pageBreak": editor.chain().focus().insertPageBreak().run(); break;
      case "toc": insertBlocks(tableOfContents(sectionsForToc())); break;
      case "caption": applyParagraphStyle(editor, "caption"); break;
      case "signature": case "certificate": case "captionBlock": case "toa": case "verification": case "proposedOrder": {
        const map: Record<string, TemplateSectionId> = { signature: "signature_block", certificate: "certificate_of_service", captionBlock: "caption_block", toa: "table_of_authorities_placeholder", verification: "verification", proposedOrder: "proposed_order" };
        insertBlocks(buildTemplateSection(map[action], { matter, documentTitle: doc?.title, date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) }));
        break;
      }
    }
  };
  const onImageFile = async (file: File) => {
    if (!editor) return;
    if (!file.type.startsWith("image/")) { toast.error("Choose an image file"); return; }
    const t = toast.loading("Uploading image…");
    try { const url = await uploadBlob(file, file.name); editor.chain().focus().setImage({ src: url, alt: file.name.replace(/\.[^.]+$/, ""), width: 480 }).run(); toast.success("Image inserted", { id: t }); } catch (e) { toast.error(`Upload failed: ${(e as Error).message}`, { id: t }); }
  };
  const insertDiagram = async (source: string, caption: string) => {
    if (!editor) return;
    const url = await renderMermaidToImageUrl(source);
    if (diagramInitial) { editor.view.dispatch(editor.state.tr.setNodeMarkup(diagramInitial.pos, undefined, { ...editor.state.doc.nodeAt(diagramInitial.pos)?.attrs, src: url, mermaid: source }).setMeta("trackChanges", "ignore")); toast.success("Diagram updated"); return; }
    const blocks: PMNode[] = [{ type: "image", attrs: { id: newId(), src: url, alt: caption || "Diagram", width: 560, align: "center", mermaid: source } }];
    if (caption) blocks.push({ type: "paragraph", attrs: { id: newId(), pStyle: "caption", textAlign: "center" }, content: [{ type: "text", text: caption }] });
    insertBlocks(blocks);
    toast.success("Diagram inserted");
  };

  // ---- exports ------------------------------------------------------------------
  // Word and PDF exports pass through the filing check gate first; Markdown / text are working copies and export directly.
  const doExport = async (kind: "docx" | "docx-clean" | "pdf" | "md" | "txt") => {
    if (!editor || !doc) return;
    if (kind === "docx" || kind === "docx-clean" || kind === "pdf") { setGate(kind); return; }
    const json = editor.getJSON() as PMNode;
    setExporting(kind);
    try {
      if (kind === "md") downloadMarkdown(json, doc.title);
      else downloadText(json, doc.title);
    } catch (e) { toast.error(`Export failed: ${(e as Error).message}`); } finally { setExporting(null); }
  };
  const exportAfterGate = async (kind: GateKind, r: GateResult) => {
    setGate(null);
    if (!editor || !doc) return;
    const json = editor.getJSON() as PMNode;
    const needsAck = r.issues.length > 0 || !r.report;
    setExporting(kind);
    try {
      if (kind === "pdf") {
        // The gate is modal: the content printed is the content it checked. Print first (the pop-up needs the click's user activation).
        const check: CheckState = r.report
          ? { state: "checked", checkedAt: r.report.checkedAt, counts: r.report.counts, summary: filingSummary(r.report.counts) }
          : { state: "not_run", reason: "the check could not run" };
        printDocument(editor.getHTML() + (r.declaration != null ? declarationHtml(r.declaration, check) : ""), json, doc.title, settings);
        void bodyHash(json).then((hash) => recordAcknowledgement(doc.id, json, { format: "pdf", docHash: hash, items: needsAck && r.acknowledged ? r.issues.length : 0, issueKeys: needsAck && r.acknowledged ? r.issues.map((i) => i.key) : [], declaration: r.declaration != null }));
      } else {
        await downloadDocx({
          docId: doc.id, content: json, title: doc.title, settings, changes: kind === "docx-clean" ? "accepted" : "revisions",
          provenance: { declaration: r.declaration != null ? { text: r.declaration } : null, appendix: r.appendix, acknowledgement: needsAck ? { acknowledged: r.acknowledged, docHash: r.report?.docHash ?? "", items: r.issues.length } : null },
        });
      }
    } catch (e) { toast.error(`Export failed: ${(e as Error).message}`); } finally { setExporting(null); }
  };
  const downloadItems: DownloadItem[] = [
    { id: "docx", label: "Word (.docx) with tracked changes", icon: FileText, onSelect: () => void doExport("docx") },
    { id: "docx-clean", label: "Word (.docx), changes accepted", icon: FileText, onSelect: () => void doExport("docx-clean") },
    { id: "pdf", label: "PDF (print)", icon: Printer, shortcut: "⌘P", onSelect: () => void doExport("pdf") },
    { id: "md", label: "Markdown (.md)", icon: FileCode2, separatorBefore: true, onSelect: () => void doExport("md") },
    { id: "txt", label: "Plain text (.txt)", icon: FileType2, onSelect: () => void doExport("txt") },
  ];

  // ---- agent integration ---------------------------------------------------------
  const scopes = React.useMemo<OfficeScope[]>(() => {
    const s: OfficeScope[] = [{ id: "document", label: "Whole document", kind: "document" }];
    if (cursor.headingId) s.push({ id: `section:${cursor.headingId}`, label: "This section", kind: "section", ref: cursor.headingId, text: cursor.sectionText });
    if (cursor.paraId) s.push({ id: `para:${cursor.paraId}`, label: `¶${cursor.paraIndex}`, kind: "paragraph", ref: cursor.paraId, text: cursor.paraText });
    if (cursor.selectionText.trim()) s.push({ id: "selection", label: "Selection", kind: "selection", text: cursor.selectionText.slice(0, 8000) });
    return s;
  }, [cursor]);

  const docxMeta = React.useMemo<DocxMeta | null>(() => { const m = (doc?.meta as { docx?: unknown } | undefined)?.docx; return isDocxMeta(m) ? m : null; }, [doc?.meta]);
  const getSnapshot = React.useCallback(() => {
    if (!editor) return null;
    const c = computeCursor(editor);
    return buildSnapshot(editor.getJSON() as PMNode, {
      title: doc?.title ?? "Untitled document",
      selection: c.selectionText ? { text: c.selectionText.slice(0, 4000), blockIds: c.selectionBlockIds } : null,
      trackChangesOn: trackChanges,
      page: { size: PAGE_SIZES[settings.pageSize].label, margins: MARGIN_PRESETS[settings.margins].label, orientation: settings.orientation },
      comments: comments.filter((x) => !x.resolved).map((x) => ({ id: x.id, anchor: x.anchor, body: x.body, author: x.authorName, resolved: x.resolved, quote: x.quote })),
      matterId: doc?.matterId ?? null,
      templateId: doc?.templateId ?? null,
      ...(docxMeta ? { styles: docxMeta.styles.filter((x) => x.type === "paragraph" || x.type === "character").map((x) => ({ id: x.id, name: x.name, type: x.type, outline: x.outlineLevel })), bookmarks: docxMeta.bookmarks } : {}),
    });
  }, [editor, doc, trackChanges, settings, comments, docxMeta]);

  const applyProposals = React.useCallback(async (proposals: EditProposal[]): Promise<ApplyResult> => {
    if (!editor) return { applied: [], failed: proposals.map((p) => ({ id: p.id, error: "Editor not ready" })) };
    const applied: string[] = []; const failed: { id: string; error: string }[] = [];
    let firstPos: number | null = null;
    let commentsAdded = false;
    for (const p of proposals) {
      try {
        const pos = await applyProposal(p, {
          editor, trackChanges, author: "Drafting assistant",
          addComment: async (input) => { const c = await office.comments.add(input); commentsAdded = true; setComments((cs) => [...cs, c]); return c; },
          setTitle: async (t) => { setTitle(t); await office.setTitle(t); },
          renderMermaid: renderMermaidToImageUrl,
          resolveComment: async (cid, note) => {
            if (importedIdsRef.current.has(cid)) { await updateImportedComments((cs) => cs.map((c) => (c.id === cid ? { ...c, resolved: true, text: note ? `${c.text}\nDrafting assistant: ${note}` : c.text } : c))); return; }
            await office.comments.update(cid, { resolved: true, ...(note ? { reply: note } : {}) });
            await refreshComments();
          },
          settings,
          updateSettings,
        });
        applied.push(p.id);
        if (firstPos == null && pos != null) firstPos = pos;
      } catch (e) { const msg = (e as Error).message; failed.push({ id: p.id, error: msg, ...(/^Stale proposal/.test(msg) ? { stale: true } : {}) }); }
    }
    if (firstPos != null) revealPosition(editor, firstPos);
    if (commentsAdded) setCommentsOpen(true);
    scheduleDerived(editor); scheduleCursor(editor);
    return { applied, failed };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, trackChanges, office, scheduleDerived, scheduleCursor, settings, updateImportedComments, refreshComments]);

  const onApplied = React.useCallback((summary: string) => { void saveNow({ summary, authorName: "Drafting assistant" }); }, [saveNow]);
  React.useEffect(() => { if (process.env.NODE_ENV !== "production") (window as unknown as { __leclaudeWordApply?: unknown }).__leclaudeWordApply = applyProposals; }, [applyProposals]);
  const onLocate = React.useCallback((target: string) => { if (!editor) return; if (!revealBlock(editor, target)) toast.error("That paragraph no longer exists"); }, [editor]);

  // ---- keyboard shortcuts --------------------------------------------------------
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const inEditor = Boolean(editor?.view.hasFocus());
      const target = e.target as HTMLElement | null;
      const typingElsewhere = !inEditor && target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (key === "s" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); void saveNow(); return; }
      if (key === "/" ) { e.preventDefault(); e.stopPropagation(); setAgentOpen((v) => !v); return; }
      if (key === "f" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); setSidebarOpen(true); setSidebarTab("find"); setFindFocusKey((k) => k + 1); return; }
      if (key === "e" && e.shiftKey && !typingElsewhere) { e.preventDefault(); e.stopPropagation(); setTrackChanges(!trackChanges); return; }
      if (key === "c" && e.shiftKey && inEditor) { e.preventDefault(); e.stopPropagation(); void addCommentAtSelection(); return; }
      if (key === "k" && inEditor) { e.preventDefault(); e.stopPropagation(); void onInsert("link"); return; }
      if (key === "o" && e.shiftKey && !typingElsewhere) { e.preventDefault(); e.stopPropagation(); setSidebarOpen((v) => !v); return; }
      if (key === "p" && !e.shiftKey && inEditor) { e.preventDefault(); e.stopPropagation(); void doExport("pdf"); return; }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, trackChanges, saveNow, addCommentAtSelection, setTrackChanges]);

  React.useEffect(() => { const ro = new ResizeObserver((entries) => { setLayoutKey((k) => k + 1); const w = entries[0]?.contentRect.width; if (w) setCanvasWidth(w); }); if (canvasRef.current) { ro.observe(canvasRef.current); setCanvasWidth(canvasRef.current.clientWidth); } return () => ro.disconnect(); }, [ready]);

  // ---- render --------------------------------------------------------------------
  const page = PAGE_SIZES[settings.pageSize];
  const m = MARGIN_PRESETS[settings.margins];
  const landscape = settings.orientation === "landscape";
  const font = FONT_FAMILIES.find((f) => f.id === settings.font) ?? FONT_FAMILIES[0];
  const pageWidthPx = (landscape ? page.height : page.width) * 96;
  const zoom = zoomMode === "fit" ? Math.min(1, Math.max(0.55, (canvasWidth - (commentsOpen ? 272 : 0) - 48) / pageWidthPx)) : zoomMode;
  const pageStyle = { "--page-w": `${(landscape ? page.height : page.width) * 96}px`, "--page-h": `${(landscape ? page.width : page.height) * 96}px`, "--page-pt": `${m.top * 96}px`, "--page-pr": `${m.right * 96}px`, "--page-pb": `${m.bottom * 96}px`, "--page-pl": `${m.left * 96}px`, "--doc-font": font.css, "--doc-size": `${settings.fontSize}pt`, "--doc-lh": settings.lineSpacing } as React.CSSProperties;
  const stats = React.useMemo(() => (editor && ready ? docStats(editor.getJSON() as PMNode) : null), [editor, ready, words, changes.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = stats ? estimatePages(stats) : 1;
  const saveLabel = saveStateLabel(office.saveState, office.lastSavedAt);
  const openComments = comments.filter((c) => !c.resolved).length;

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <TopbarSlot><Link href="/library" className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Back to Library</Link></TopbarSlot>
        <EmptyState icon={AlertTriangle} title={error} description="The document may have been deleted, or the link is wrong." action={<Button asChild variant="outline"><Link href="/office?kind=word">Open documents</Link></Button>} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OfficeChrome
        kind="word"
        title={title}
        onTitleChange={setTitle}
        onTitleCommit={commitTitle}
        titlePlaceholder="Untitled document"
        matter={matter}
        matters={matters}
        onMatterChange={(v) => void office.save({ matterId: v })}
        saveState={office.saveState}
        lastSavedAt={office.lastSavedAt}
        onSave={() => void saveNow()}
        ready={ready}
        download={{ items: downloadItems, busy: Boolean(exporting) }}
        tools={
          <>
            <Tip label="Version history"><Button variant="ghost" size="icon-sm" onClick={() => setVersionsOpen(true)} disabled={!ready} aria-label="Version history"><History className="size-4" /></Button></Tip>
            <ChromeToggle icon={MessageSquare} label="Comments" shortcut="⌘⇧C to add" pressed={commentsOpen} onClick={() => setCommentsOpen((v) => !v)} count={openComments} />
            <ChromeToggle icon={Sparkles} label="Drafting assistant" shortcut="⌘/" pressed={agentOpen} onClick={() => setAgentOpen((v) => !v)} />
          </>
        }
      />

      {editor && ready ? (
        <WordToolbar editor={editor} settings={settings} onSettings={updateSettings} onInsert={(a) => void onInsert(a)} trackChanges={trackChanges} onTrackChanges={setTrackChanges} view={view} onView={setView} disabled={view === "preview"} />
      ) : (
        <ToolbarSkeleton />
      )}
      {ready && view === "edit" && (
        <TrackedChangesStrip count={changes.length} index={Math.min(changeIndex, Math.max(0, changes.length - 1))} authors={changeAuthors} onPrev={() => goToChange(changeIndex - 1)} onNext={() => goToChange(changeIndex + 1)} onAcceptCurrent={() => resolveCurrent("accept")} onRejectCurrent={() => resolveCurrent("reject")} onAcceptAll={() => resolveAll("accept")} onRejectAll={() => resolveAll("reject")} />
      )}

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && editor && ready && <WordSidebar editor={editor} tab={sidebarTab} onTab={setSidebarTab} outline={outline} currentHeadingId={cursor.headingId} onClose={() => setSidebarOpen(false)} findFocusKey={findFocusKey} docId={doc?.id} onLocate={onLocate} />}
        {!sidebarOpen && (
          <div className="flex w-9 shrink-0 flex-col items-center border-r bg-background pt-2">
            <Tip label="Show outline" shortcut="⌘⇧O" side="right"><Button variant="ghost" size="icon-xs" onClick={() => setSidebarOpen(true)} aria-label="Show sidebar"><PanelLeft className="size-4" /></Button></Tip>
          </div>
        )}
        <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1">
          <ResizablePanel minSize={360}>
            <div ref={canvasRef} className="word-canvas relative h-full overflow-auto scrollbar-thin" onClick={(e) => { if (e.target === e.currentTarget) editor?.commands.focus("end"); }}>
              <div className={cn("flex min-h-full items-start justify-center gap-0 px-6 py-8", commentsOpen && "pr-2")}>
                <div style={{ ...pageStyle, zoom: canvasWidth ? zoom : 1 }} className={cn("word-editor shrink-0", view === "preview" && "preview")}>
                  {!ready || !editor ? (
                    <div className="word-page serif" style={pageStyle}><div className="space-y-3">{[90, 100, 96, 80, 100, 60, 0, 100, 94, 88, 100, 70].map((w, i) => (w ? <Skeleton key={i} className="h-3.5" style={{ width: `${w}%` }} /> : <div key={i} className="h-4" />))}</div></div>
                  ) : (
                    <div className={cn("word-page", settings.font)} style={pageStyle} lang={settings.language}>
                      <EditorContent editor={editor} />
                      {footnotes.length > 0 && (
                        <ol className="word-footnotes list-decimal pl-5" contentEditable={false}>{footnotes.map((f) => <li key={f.id} value={f.index}>{f.text}</li>)}</ol>
                      )}
                    </div>
                  )}
                </div>
                {commentsOpen && editor && ready && (
                  <CommentsSidebar editor={editor} comments={comments} activeId={activeComment} onActive={setActiveComment} onLocate={locateComment} canvasRef={canvasRef} layoutKey={layoutKey} showResolved={showResolved} onShowResolved={setShowResolved} onClose={() => setCommentsOpen(false)}
                    onReply={async (cid, body) => { if (importedIds.has(cid)) { await updateImportedComments((cs) => cs.map((c) => (c.id === cid ? { ...c, text: `${c.text}\n${authorName}: ${body}` } : c))); return; } await office.comments.update(cid, { reply: body }); await refreshComments(); }}
                    onResolve={async (cid, resolved) => { if (importedIds.has(cid)) await updateImportedComments((cs) => cs.map((c) => (c.id === cid ? { ...c, resolved } : c))); else { await office.comments.update(cid, { resolved }); await refreshComments(); } toast.success(resolved ? "Comment resolved" : "Comment reopened", { duration: 1200 }); }}
                    onDelete={async (cid) => { if (importedIds.has(cid)) await updateImportedComments((cs) => cs.filter((c) => c.id !== cid)); else await office.comments.remove(cid); editor.commands.command(({ tr, state, dispatch }) => { state.doc.descendants((n, p) => { if (n.isText && n.marks.some((mk) => mk.type.name === "comment" && mk.attrs.id === cid)) tr.removeMark(p, p + n.nodeSize, state.schema.marks.comment); }); tr.setMeta("trackChanges", "ignore"); dispatch?.(tr); return true; }); await refreshComments(); }}
                  />
                )}
              </div>
            </div>
          </ResizablePanel>
          {agentOpen && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={narrow ? 340 : 400} minSize={300} maxSize={640}>
                <OfficeAgentPanel endpoint="/api/office/word/agent" docId={doc?.id} docTitle={doc?.title ?? "Untitled document"} matterId={doc?.matterId ?? matterId ?? null} getSnapshot={getSnapshot} scopes={scopes} applyProposals={applyProposals} onUndo={() => editor?.chain().focus().undo().run()} onLocate={onLocate} suggestions={SUGGESTIONS} defaultMode={initialMode ?? "draft"} onApplied={onApplied} extraContext={() => ({ cursorParagraph: cursor.paraIndex, currentSection: cursor.headingText, settings })} onOpenVersions={() => setVersionsOpen(true)} versionsCount={versionsCount} onClose={() => setAgentOpen(false)} />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

      <StatusBar words={words} characters={stats?.characters ?? 0} pages={pages} pageLabel={`${page.label.split(" ")[0]} · ${m.label.split(" ")[0]} margins${landscape ? " · landscape" : ""}`} paraIndex={cursor.paraIndex} paraTotal={cursor.total} section={cursor.headingText} trackChanges={trackChanges} onTrackChanges={setTrackChanges} pending={changes.length} language={LANGUAGES.find((l) => l.id === settings.language)?.label ?? settings.language} onLanguage={(l) => updateSettings({ language: l })} saveLabel={saveLabel} saveState={office.saveState} comments={openComments} onComments={() => setCommentsOpen(true)} loading={loading} zoom={zoom} zoomMode={zoomMode} onZoom={setZoomMode} />

      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImageFile(f); e.target.value = ""; }} />
      <VersionsDialog open={versionsOpen} onOpenChange={setVersionsOpen} list={office.versions.list} get={office.versions.get} checkpoint={async (label) => { await saveNow(); return office.versions.checkpoint(label); }} restore={async (vid) => { const d = await office.versions.restore(vid); if (d && editor) { loadContent(editor, d.content as PMNode); scheduleDerived(editor); scheduleCursor(editor); } return d; }} currentContent={() => (editor?.getJSON() as PMNode) ?? emptyDoc()} />
      <DiagramDialog open={diagramOpen} onOpenChange={(o) => { setDiagramOpen(o); if (!o) setDiagramInitial(null); }} onInsert={insertDiagram} initial={diagramInitial?.source} />
      <ExportGateDialog kind={gate} docId={doc?.id} getContent={() => (editor?.getJSON() as PMNode) ?? emptyDoc()} onCancel={() => setGate(null)} onConfirm={(r) => { if (gate) void exportAfterGate(gate, r); }} />
      <PromptDialog request={prompt} onSubmit={(v, s) => { setPrompt(null); promptResolver.current?.({ value: v, secondary: s }); promptResolver.current = null; }} onCancel={() => { setPrompt(null); promptResolver.current?.(null); promptResolver.current = null; }} />
    </div>
  );
}

/** Position lookup exported for the page (used by deep links ?block=). */
export { findBlockPos };
