"use client";
import * as React from "react";
import { ChevronLeft, ChevronRight, Loader2, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { DocFile } from "../types";
import { docsApi, errorKind, errorMessage, setUrl } from "./api";
import { formatBytes, formatPreciseDate, methodLabel, shortHash } from "./format";
import { FileStatus, Notice } from "./notice";

export interface ViewerTarget { fileId: string; page?: number | null; /** Text to highlight (citation snippet or fact quote). */ highlight?: string | null; name?: string }

type Load = { status: "loading" } | { status: "ready"; file: DocFile; pages: { page: number; text: string }[] } | { status: "error"; message: string };

/** Escape regex and let any whitespace run match any other, so a quote is found across line breaks. */
function highlightPattern(q: string): RegExp | null {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 60);
  if (!words.length || q.trim().length < 4) return null;
  return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "i");
}

function Highlighted({ text, pattern }: { text: string; pattern: RegExp | null }) {
  if (!pattern) return <>{text}</>;
  const m = pattern.exec(text);
  if (!m) return <>{text}</>;
  return <>{text.slice(0, m.index)}<mark data-hit className="rounded-sm bg-warning/30 text-foreground">{m[0]}</mark>{text.slice(m.index + m[0].length)}</>;
}

/** Right-hand drawer showing a file's stored text with page numbers, opened at a page (citations, facts, events). */
export function TextViewer({ setId, target, onClose }: { setId: string; target: ViewerTarget | null; onClose: () => void }) {
  const [page, setPage] = React.useState<number | null>(null);
  const [load, setLoad] = React.useState<Load>({ status: "loading" });
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const fileId = target?.fileId;

  React.useEffect(() => { setPage(target?.page ?? null); }, [target]);

  React.useEffect(() => {
    if (!fileId) return;
    const ac = new AbortController();
    setLoad({ status: "loading" });
    const q = page ? `?page=${page}` : "";
    docsApi<{ file: DocFile; pages: { page: number; text: string }[] }>(setUrl(setId, `/files/${encodeURIComponent(fileId)}${q}`), { signal: ac.signal })
      .then((r) => setLoad({ status: "ready", file: r.file, pages: r.pages }))
      .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorKind(e) === "denied" ? "This file was not found, or you do not have access to it." : errorMessage(e) }); });
    return () => ac.abort();
  }, [setId, fileId, page]);

  const pattern = React.useMemo(() => highlightPattern(target?.highlight ?? ""), [target?.highlight]);

  // Bring the requested page (and the highlight, when found) into view.
  React.useEffect(() => {
    if (load.status !== "ready") return;
    const root = bodyRef.current;
    if (!root) return;
    const el = (root.querySelector("mark[data-hit]") ?? (page ? root.querySelector(`[data-page="${page}"]`) : null)) as HTMLElement | null;
    el?.scrollIntoView({ block: el.tagName === "MARK" ? "center" : "start" });
  }, [load, page]);

  const file = load.status === "ready" ? load.file : null;
  const total = file?.pages ?? 0;
  const ocr = new Set(file?.ocrPages ?? []);

  return (
    <Sheet open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent width="sm:max-w-2xl" className="w-full" aria-describedby={undefined}>
        <SheetHeader className="pe-12">
          <SheetTitle className="truncate text-[14px]" title={file?.name ?? target?.name}>{file?.name ?? target?.name ?? "File"}</SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              {file ? (
                <>
                  <FileStatus status={file.status} />
                  <span>{methodLabel(file)}</span>
                  {file.pages > 0 && <span className="tabular">{file.pages.toLocaleString("en-IN")} page{file.pages === 1 ? "" : "s"}</span>}
                  <span className="tabular">{formatBytes(file.size)}</span>
                  {file.docDate && <span>Dated {formatPreciseDate(file.docDate, "day")}</span>}
                  <span className="font-mono text-[11px]" title={`SHA-256 (${file.hashOrigin === "browser" ? "computed in the browser" : "computed on the server"}): ${file.sha256}`}>{shortHash(file.sha256)}</span>
                </>
              ) : <span>Loading…</span>}
            </div>
          </SheetDescription>
          {total > 1 && (
            <div className="mt-1 flex items-center gap-1">
              <Button size="icon-xs" variant="ghost" aria-label="Previous page" disabled={!page || page <= 1} onClick={() => setPage((p) => Math.max(1, (p ?? 1) - 1))}><ChevronLeft /></Button>
              <span className="text-[12px] tabular text-muted-foreground">{page ? `Page ${page} of ${total}` : `All ${total} pages`}</span>
              <Button size="icon-xs" variant="ghost" aria-label="Next page" disabled={!!page && page >= total} onClick={() => setPage((p) => Math.min(total, (p ?? 0) + 1))}><ChevronRight /></Button>
              {page && <Button size="xs" variant="ghost" onClick={() => setPage(null)}>All pages</Button>}
            </div>
          )}
        </SheetHeader>
        <SheetBody className="bg-surface-quiet"><div ref={bodyRef}>
          {load.status === "loading" && <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading text…</div>}
          {load.status === "error" && <Notice tone="destructive">{load.message}</Notice>}
          {load.status === "ready" && (
            load.pages.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{file?.status === "needs_ocr" ? "This file has no text layer yet. Read its scanned pages with AI from the Files tab." : "No text is stored for this file."}</p>
            ) : (
              <div className="space-y-3">
                {target?.highlight && !load.pages.some((p) => pattern?.test(p.text)) && (
                  <Notice tone="warning">The quoted words were not found on {page ? `page ${page}` : "these pages"}.</Notice>
                )}
                {load.pages.map((p) => (
                  <section key={p.page} data-page={p.page} className={cn("rounded-md border bg-background", p.page === page && "ring-1 ring-ring/40")}>
                    <header className="flex items-center justify-between border-b px-3 py-1.5 text-[11.5px] text-muted-foreground">
                      <span className="tabular">{p.page > 0 ? `Page ${p.page}` : "Text"}</span>
                      {ocr.has(p.page) && !p.text && <span className="inline-flex items-center gap-1"><ScanLine className="size-3" /> Scanned, not read yet</span>}
                    </header>
                    <div className="whitespace-pre-wrap break-words px-3 py-2.5 font-serif text-[13.5px] leading-relaxed text-foreground">
                      {p.text ? <Highlighted text={p.text} pattern={pattern} /> : <span className="font-sans text-[12px] text-muted-foreground">No text on this page.</span>}
                    </div>
                  </section>
                ))}
              </div>
            )
          )}
        </div></SheetBody>
      </SheetContent>
    </Sheet>
  );
}
