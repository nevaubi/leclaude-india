"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Briefcase, Copy, Download, ExternalLink, FolderOpen, History, Library, MessageSquare, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { PersonAvatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { OfficeDocument } from "@/lib/types/domain";
import { KIND_META, type OfficeDocSummary } from "./types";
import { OfficeAppIcon } from "../shared/office-app-icon";

export interface DocActions {
  rename: (doc: OfficeDocSummary, title: string) => Promise<void>;
  duplicate: (doc: OfficeDocSummary) => Promise<void>;
  remove: (doc: OfficeDocSummary) => Promise<void>;
}

export function docHref(doc: Pick<OfficeDocSummary, "kind" | "id">) { return `/office/${doc.kind}/${doc.id}`; }

/** Duplicate = GET the document (with content) then POST a copy with the same content. */
export async function duplicateOfficeDoc(doc: OfficeDocSummary): Promise<OfficeDocument> {
  const r = await fetch(`/api/office/docs/${doc.id}`);
  if (!r.ok) throw new Error("Could not read the document");
  const { doc: full } = (await r.json()) as { doc: OfficeDocument };
  const res = await fetch("/api/office/docs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: full.kind, title: `Copy of ${full.title}`, content: full.content, matterId: full.matterId, folderId: full.folderId, tags: full.tags, meta: full.meta }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
  return ((await res.json()) as { doc: OfficeDocument }).doc;
}

/**
 * Download the native file for a document through its export route (.xlsx / .pptx / .pdf). A Word document opens in the
 * editor with its filing-check gate (citations, citator, quotations; AI-use declaration) before the .docx is written.
 */
export async function downloadOfficeDoc(doc: OfficeDocSummary) {
  if (doc.kind === "word") { window.location.assign(`${docHref(doc)}?export=docx`); return; }
  const routes: Record<Exclude<OfficeDocSummary["kind"], "word">, { url: string; body: Record<string, unknown> }> = {
    sheet: { url: "/api/office/sheet/export", body: { docId: doc.id, format: "xlsx" } },
    slides: { url: "/api/office/slides/export", body: { docId: doc.id, format: "pptx" } },
    pdf: { url: "/api/office/pdf/export", body: { docId: doc.id, options: { flattenAnnotations: true, applyRedactions: true, bates: true, bookmarks: true } } },
  };
  const { url, body } = routes[doc.kind];
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? "Export failed");
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = href; a.download = `${doc.title.replace(/[\\/:*?"<>|]+/g, "-")}.${KIND_META[doc.kind].ext}`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

function useRename(doc: OfficeDocSummary, actions: DocActions) {
  const [renaming, setRenaming] = React.useState(false);
  const [title, setTitle] = React.useState(doc.title);
  React.useEffect(() => setTitle(doc.title), [doc.title]);
  const commit = async () => { setRenaming(false); if (title.trim() && title.trim() !== doc.title) await actions.rename(doc, title.trim()); else setTitle(doc.title); };
  const input = renaming ? (
    <input
      autoFocus
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void commit(); if (e.key === "Escape") { setRenaming(false); setTitle(doc.title); } }}
      onClick={(e) => e.stopPropagation()}
      className="w-full rounded border border-ring bg-background px-1 py-0.5 text-[13px] font-medium outline-none ring-2 ring-ring/30"
      aria-label="Rename document"
    />
  ) : null;
  return { renaming, setRenaming, input };
}

function MenuItems({ doc, actions, onRename, Item, Sep }: { doc: OfficeDocSummary; actions: DocActions; onRename: () => void; Item: typeof DropdownMenuItem; Sep: typeof DropdownMenuSeparator }) {
  const router = useRouter();
  return (
    <>
      <Item onClick={() => router.push(docHref(doc))}><ExternalLink /> Open</Item>
      <Item onClick={() => window.open(docHref(doc), "_blank")}><ExternalLink /> Open in new tab</Item>
      <Sep />
      <Item onClick={onRename}><Pencil /> Rename <kbd className="ml-auto">F2</kbd></Item>
      <Item onClick={() => void actions.duplicate(doc)}><Copy /> Duplicate</Item>
      <Item onClick={() => downloadOfficeDoc(doc).catch((e: Error) => toast.error("Download failed", { description: e.message }))}><Download /> {doc.kind === "word" ? "Export .docx (filing check)…" : `Download .${KIND_META[doc.kind].ext}`}</Item>
      {doc.libraryItemId && <Item onClick={() => router.push(`/library?item=${doc.libraryItemId}`)}><Library /> Show in Library</Item>}
      <Sep />
      <Item destructive onClick={() => void actions.remove(doc)}><Trash2 /> Delete</Item>
    </>
  );
}

/** Matter chip: quiet outline pill with the briefcase glyph. */
export function MatterChip({ name, className }: { name: string; className?: string }) {
  return <span className={cn("inline-flex h-5 max-w-full items-center gap-1 truncate rounded-full border px-2 text-[11px] text-muted-foreground", className)} title={name}><Briefcase className="size-3 shrink-0" /><span className="truncate">{name}</span></span>;
}

export function DocCard({ doc, actions }: { doc: OfficeDocSummary; actions: DocActions }) {
  const router = useRouter();
  const { renaming, setRenaming, input } = useRename(doc, actions);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="link"
          tabIndex={0}
          onClick={() => { if (!renaming) router.push(docHref(doc)); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !renaming) router.push(docHref(doc)); if (e.key === "F2") { e.preventDefault(); setRenaming(true); } }}
          className="group flex h-[152px] cursor-pointer flex-col rounded-lg border bg-card p-3 outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <div className="flex items-start gap-2.5">
            <OfficeAppIcon kind={doc.kind} size={20} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              {input ?? <div className="line-clamp-2 text-[13px] font-medium leading-snug" title={doc.title}>{doc.title}</div>}
              <div className="mt-0.5 text-[11px] text-muted-foreground">{KIND_META[doc.kind].label}{doc.templateId ? " · from template" : ""}{doc.folderName ? ` · ${doc.folderName}` : ""}</div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" onClick={(e) => e.stopPropagation()} aria-label="Actions"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
                <MenuItems doc={doc} actions={actions} onRename={() => setRenaming(true)} Item={DropdownMenuItem} Sep={DropdownMenuSeparator} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {doc.matterShortName && <MatterChip name={doc.matterShortName} className="max-w-[170px]" />}
            {(doc.tags ?? []).slice(0, 2).map((t) => <span key={t} className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">{t}</span>)}
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 tabular" title={`Content version ${doc.contentVersion} · ${doc.versionCount} saved`}><History className="size-3" /> v{doc.contentVersion}</span>
            {doc.commentCount > 0 && <span className="inline-flex items-center gap-1 tabular"><MessageSquare className="size-3" /> {doc.commentCount}</span>}
            <span className="flex-1" />
            {doc.ownerName && <PersonAvatar name={doc.ownerName} size="xs" />}
            <RelativeTime value={doc.updatedAt} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <MenuItems doc={doc} actions={actions} onRename={() => setRenaming(true)} Item={ContextMenuItem as unknown as typeof DropdownMenuItem} Sep={ContextMenuSeparator as unknown as typeof DropdownMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Column template shared by the header row and the rows so the list lines up without a fixed min width. */
export const DOC_ROW_GRID = "grid items-center gap-3 grid-cols-[minmax(0,1fr)_minmax(120px,180px)_96px_32px] lg:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_minmax(120px,160px)_96px_72px_72px_32px]";

export function DocRowHeader() {
  return (
    <div className={cn(DOC_ROW_GRID, "h-8 border-b px-3 text-[11.5px] text-muted-foreground")} role="row">
      <span>Title</span>
      <span>Matter</span>
      <span className="hidden lg:block">Owner</span>
      <span>Updated</span>
      <span className="hidden lg:block">Versions</span>
      <span className="hidden text-right lg:block">Size</span>
      <span />
    </div>
  );
}

export function DocRow({ doc, actions }: { doc: OfficeDocSummary; actions: DocActions }) {
  const router = useRouter();
  const { renaming, setRenaming, input } = useRename(doc, actions);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="row"
          tabIndex={0}
          onClick={() => { if (!renaming) router.push(docHref(doc)); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !renaming) router.push(docHref(doc)); if (e.key === "F2") { e.preventDefault(); setRenaming(true); } }}
          className={cn(DOC_ROW_GRID, "group h-9 cursor-pointer border-b border-line-quiet px-3 text-[13px] outline-none transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:bg-accent/40")}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span title={KIND_META[doc.kind].label} className="inline-flex"><OfficeAppIcon kind={doc.kind} size={16} /></span>
            <div className="min-w-0 flex-1">
              {input ?? <div className="truncate" title={doc.title}>{doc.title}</div>}
            </div>
          </div>
          <div className="min-w-0 truncate text-[12px] text-muted-foreground" title={doc.matterShortName}>{doc.matterShortName ?? "—"}</div>
          <div className="hidden min-w-0 truncate text-[12px] text-muted-foreground lg:block">{doc.ownerName ?? "—"}</div>
          <div className="text-[12px] text-muted-foreground"><RelativeTime value={doc.updatedAt} /></div>
          <div className="hidden text-[12px] tabular text-muted-foreground lg:block" title={`Content version ${doc.contentVersion} · ${doc.versionCount} saved`}>v{doc.contentVersion} · {doc.versionCount}</div>
          <div className="hidden text-right text-[12px] tabular text-muted-foreground lg:block">{doc.size ? formatBytes(doc.size) : "—"}</div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" onClick={(e) => e.stopPropagation()} aria-label="Actions"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
              <MenuItems doc={doc} actions={actions} onRename={() => setRenaming(true)} Item={DropdownMenuItem} Sep={DropdownMenuSeparator} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <MenuItems doc={doc} actions={actions} onRename={() => setRenaming(true)} Item={ContextMenuItem as unknown as typeof DropdownMenuItem} Sep={ContextMenuSeparator as unknown as typeof DropdownMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function OpenFolderLink({ doc }: { doc: OfficeDocSummary }) {
  if (!doc.libraryItemId) return null;
  return <Link href={`/library?item=${doc.libraryItemId}`} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><FolderOpen className="size-3" /> Library</Link>;
}
