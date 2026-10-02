"use client";
import * as React from "react";
import { ChevronLeft, ChevronRight, Languages, Loader2, ScanLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { DocFile } from "../types";
import { docsApi, errorKind, errorMessage, isAbort, setUrl, UNCONFIGURED_MESSAGE } from "./api";
import { TRANSLATION_LABEL, TRANSLATION_LANGUAGES, languageLabel, type TranslationRecord } from "../drafting";
import { translationsApi } from "./drafting/drafting-api";
import { formatBytes, formatPreciseDate, methodLabel } from "./format";
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
  const tr = useTranslations(setId, fileId ?? null, page);

  return (
    <Sheet open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent width={tr.to ? "sm:max-w-5xl" : "sm:max-w-2xl"} className="w-full" aria-describedby={undefined}>
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
          {file && load.status === "ready" && load.pages.some((p) => p.text) && <TranslateBar tr={tr} page={page} pages={total} />}
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
                    <div className={cn(tr.to && "grid divide-y md:grid-cols-2 md:divide-x md:divide-y-0")}>
                      <div className="whitespace-pre-wrap break-words px-3 py-2.5 font-serif text-[13.5px] leading-relaxed text-foreground">
                        {p.text ? <Highlighted text={p.text} pattern={pattern} /> : <span className="font-sans text-[12px] text-muted-foreground">No text on this page.</span>}
                      </div>
                      {tr.to && <TranslationCell rec={tr.byPage.get(p.page ?? 0) ?? null} to={tr.to} loading={tr.loading} />}
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

// ---- working translations (side by side) ------------------------------------------------------------------------------

type TranslationRec = TranslationRecord & { stale: boolean };

/** Translations of the open file into one language, and the action that creates them (bounded batches, cancellable). */
function useTranslations(setId: string, fileId: string | null, page: number | null) {
  const [to, setTo] = React.useState<string>("");
  const [from, setFrom] = React.useState<string>("auto");
  const [byPage, setByPage] = React.useState<Map<number, TranslationRec>>(new Map());
  const [loading, setLoading] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ctrl = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => ctrl.current?.abort(), []);
  React.useEffect(() => { setTo(""); setByPage(new Map()); setError(null); }, [fileId]);
  React.useEffect(() => {
    if (!fileId || !to) { setByPage(new Map()); return; }
    const ac = new AbortController();
    setLoading(true); setError(null);
    translationsApi.list(setId, fileId, to, ac.signal)
      .then((r) => setByPage(new Map(r.records.map((x) => [x.page ?? 0, x]))))
      .catch((e) => { if (!ac.signal.aborted) setError(errorMessage(e)); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [setId, fileId, to]);
  const translate = async (force = false) => {
    if (!fileId || !to) return;
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setRunning(true); setError(null);
    try {
      for (let i = 0; i < 30; i++) {
        const r = await translationsApi.translate(setId, { fileId, from, to, ...(page ? { pageFrom: page, pageTo: page } : {}), force }, ac.signal);
        // A call returns only the pages it translated: merge them into the listed ones.
        if (r.records.length) setByPage((cur) => { const next = new Map(cur); for (const x of r.records) next.set(x.page ?? 0, x); return next; });
        if (!r.remaining || !r.translated) break;
      }
    } catch (e) {
      if (!isAbort(e)) setError(errorKind(e) === "unconfigured" ? UNCONFIGURED_MESSAGE : errorMessage(e));
    } finally { setRunning(false); ctrl.current = null; }
  };
  return { to, setTo, from, setFrom, byPage, loading, running, error, translate, cancel: () => ctrl.current?.abort() };
}

function TranslateBar({ tr, page, pages }: { tr: ReturnType<typeof useTranslations>; page: number | null; pages: number }) {
  const missing = tr.to && !tr.loading ? (page ? (tr.byPage.has(page) ? 0 : 1) : Math.max(0, (pages || 1) - tr.byPage.size)) : 0;
  const stale = Array.from(tr.byPage.values()).filter((r) => r.stale).length;
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Languages className="size-3.5 text-muted-foreground" aria-hidden />
        <Select value={tr.to || "__none__"} onValueChange={(v) => tr.setTo(v === "__none__" ? "" : v)}>
          <SelectTrigger size="xs" className="w-[150px]" aria-label="Translate into"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">No translation</SelectItem>
            {TRANSLATION_LANGUAGES.map((l) => <SelectItem key={l.code} value={l.code}>Into {l.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {tr.to && (
          <>
            <Select value={tr.from} onValueChange={tr.setFrom}>
              <SelectTrigger size="xs" className="w-[140px]" aria-label="Source language"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">From: detect</SelectItem>
                {TRANSLATION_LANGUAGES.filter((l) => l.code !== tr.to).map((l) => <SelectItem key={l.code} value={l.code}>From {l.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {tr.running
              ? <Button size="xs" variant="ghost" onClick={tr.cancel}><X className="size-3.5" /> Stop</Button>
              : <Button size="xs" variant="outline" onClick={() => void tr.translate(false)} disabled={tr.loading}>{missing || stale ? `Translate ${page ? `page ${page}` : `${missing + stale} page${missing + stale === 1 ? "" : "s"}`}` : "Re-check"}</Button>}
            {tr.running && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Translating" />}
          </>
        )}
      </div>
      {tr.to && <p className="text-[11px] text-warning-foreground dark:text-warning">{TRANSLATION_LABEL}</p>}
      {tr.error && <Notice tone="destructive">{tr.error}</Notice>}
    </div>
  );
}

function TranslationCell({ rec, to, loading }: { rec: TranslationRec | null; to: string; loading: boolean }) {
  if (loading) return <div className="px-3 py-2.5 text-[12px] text-muted-foreground">Loading translation…</div>;
  if (!rec) return <div className="px-3 py-2.5 text-[12px] text-muted-foreground">Not translated into {languageLabel(to)} yet.</div>;
  return (
    <div className="bg-surface-quiet/60 px-3 py-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted-foreground">
        <span>Working translation · {languageLabel(rec.to)}</span>
        {rec.stale && <span className="font-medium text-warning-foreground dark:text-warning">Original changed since — re-translate</span>}
      </div>
      <div lang={rec.to} className="whitespace-pre-wrap break-words font-serif text-[13.5px] leading-relaxed text-foreground">{rec.text}</div>
    </div>
  );
}
