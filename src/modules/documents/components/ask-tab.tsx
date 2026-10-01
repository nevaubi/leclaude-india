"use client";
import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { ArrowUp, Copy, FileSearch, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readSSE } from "@/lib/ai/sse";
import { cn } from "@/lib/utils";
import type { DocAnswer, DocCitation } from "../types";
import { classify, errorMessage, setUrl, UNCONFIGURED_MESSAGE } from "./api";
import { CITE_HREF, linkCitationMarkers } from "./format";
import { FilePicker } from "./file-picker";
import { Notice } from "./notice";
import type { ViewerTarget } from "./text-viewer";

interface Turn {
  id: string;
  question: string;
  fileIds: string[];
  fileLabel?: string;
  status: "streaming" | "done" | "error" | "stopped";
  statusText?: string;
  passages?: number;
  text: string;
  answer?: DocAnswer;
  error?: string;
}

type AskEvent =
  | { type: "status"; message?: string; label?: string; text?: string }
  | { type: "passages"; count: number }
  | { type: "delta"; text: string }
  | { type: "done"; answer: DocAnswer }
  | { type: "error"; message: string; code?: string };

/** Ask questions across the set; answers stream with [n] markers bound to file + page passages. */
export function AskTab({ setId, aiReady, fileCount, onView }: { setId: string; aiReady: boolean | null; fileCount: number; onView: (t: ViewerTarget) => void }) {
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [input, setInput] = React.useState("");
  const [fileIds, setFileIds] = React.useState<string[]>([]);
  const [fileNames, setFileNames] = React.useState<Record<string, string>>({});
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const streaming = turns.some((t) => t.status === "streaming");

  React.useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [turns]);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const update = (id: string, p: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)));

  const ask = async () => {
    const question = input.trim();
    if (!question || streaming) return;
    const id = `q${Date.now()}`;
    const fileLabel = fileIds.length === 1 ? fileNames[fileIds[0]] : fileIds.length > 1 ? `${fileIds.length} files` : undefined;
    setTurns((list) => [...list, { id, question, fileIds, fileLabel, status: "streaming", text: "" }]);
    setInput("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let done = false;
    try {
      const res = await fetch(setUrl(setId, "/ask"), {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ question, fileIds: fileIds.length ? fileIds : undefined }),
      });
      if (!res.ok) throw classify(res.status, (await res.json().catch(() => ({}))) as { error?: string });
      await readSSE<AskEvent>(res, (ev) => {
        if (ev.type === "status") update(id, { statusText: ev.message ?? ev.label ?? ev.text });
        else if (ev.type === "passages") update(id, { passages: ev.count, statusText: undefined });
        else if (ev.type === "delta") update(id, (t) => ({ text: t.text + ev.text, statusText: undefined }));
        else if (ev.type === "done") { done = true; update(id, { status: "done", answer: ev.answer, text: ev.answer.answer, passages: ev.answer.passagesSearched }); }
        else if (ev.type === "error") throw new Error(ev.code === "503" ? UNCONFIGURED_MESSAGE : ev.message);
      }, ctrl.signal);
      if (!done) throw new Error("The answer was interrupted before it finished.");
    } catch (e) {
      if (ctrl.signal.aborted) update(id, { status: "stopped", statusText: undefined });
      else update(id, { status: "error", error: errorMessage(e), statusText: undefined });
    } finally {
      abortRef.current = null;
    }
  };

  const disabled = aiReady === false || fileCount === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-[820px] space-y-6 px-4 py-4">
          {aiReady === false && <Notice tone="warning">{UNCONFIGURED_MESSAGE}</Notice>}
          {aiReady !== false && fileCount === 0 && <Notice>Add files to this set before asking questions.</Notice>}
          {turns.length === 0 && !disabled && (
            <div className="flex flex-col items-center gap-1.5 py-12 text-center">
              <FileSearch className="size-5 text-muted-foreground/70" aria-hidden />
              <div className="text-[13px] font-medium">Ask across the documents in this set</div>
              <p className="max-w-md text-[12px] text-muted-foreground">Answers are drawn only from the text of these files, and every statement points to the file and page it came from. If the files do not answer the question, the answer says so.</p>
            </div>
          )}
          {turns.map((t) => <TurnView key={t.id} t={t} onView={onView} />)}
        </div>
      </div>
      <div className="shrink-0 border-t bg-background px-4 py-3">
        <div className="mx-auto w-full max-w-[820px]">
          <div className="rounded-lg border bg-background px-2.5 pb-2 pt-2 focus-within:ring-2 focus-within:ring-ring/30">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(); } }}
              rows={2}
              disabled={disabled}
              placeholder={disabled ? "Asking is unavailable" : "Ask a question about these documents"}
              aria-label="Question"
              className="block max-h-[180px] min-h-[44px] w-full resize-none bg-transparent px-1 text-[14px] leading-6 placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
            />
            <div className="mt-1 flex items-center gap-2">
              <FilePicker setId={setId} value={fileIds} multi placeholder="All files" onChange={(ids, names) => { setFileIds(ids); setFileNames(names); }} />
              <div className="ms-auto">
                {streaming ? (
                  <Button size="sm" variant="outline" onClick={() => abortRef.current?.abort()}><Square className="size-3 fill-current" /> Stop</Button>
                ) : (
                  <Button size="sm" onClick={() => void ask()} disabled={disabled || !input.trim()}><ArrowUp className="size-3.5" /> Ask</Button>
                )}
              </div>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Answers can be wrong. Open each citation to check the page before relying on it.</p>
        </div>
      </div>
    </div>
  );
}

function TurnView({ t, onView }: { t: Turn; onView: (v: ViewerTarget) => void }) {
  const byN = React.useMemo(() => new Map((t.answer?.citations ?? []).map((c) => [c.n, c])), [t.answer]);
  const unresolved = React.useMemo(() => new Set(t.answer?.unresolved ?? []), [t.answer]);
  const open = (c: DocCitation) => onView({ fileId: c.fileId, page: c.page, highlight: c.snippet, name: c.fileName });
  const md = React.useMemo(() => linkCitationMarkers(t.text), [t.text]);

  return (
    <article className="space-y-2.5">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-3.5 py-2 text-[14px] leading-6">
          <div className="whitespace-pre-wrap">{t.question}</div>
          {t.fileLabel && <div className="mt-0.5 text-[11px] text-muted-foreground">In {t.fileLabel}</div>}
        </div>
      </div>
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          {t.status === "streaming" && <Loader2 className="size-3.5 animate-spin" />}
          <span>
            {t.status === "streaming" && !t.text ? (t.statusText ?? "Searching the documents…") : null}
            {t.passages != null ? `${t.status === "streaming" && !t.text ? " · " : ""}${t.passages} passage${t.passages === 1 ? "" : "s"} searched` : null}
            {t.answer?.durationMs != null ? ` · ${(t.answer.durationMs / 1000).toFixed(1)}s` : null}
          </span>
        </div>
        {t.answer?.noEvidence && <Notice tone="warning">The documents in this set do not establish this.</Notice>}
        {t.text && (
          <div className="prose-legal space-y-2.5 text-[14px] leading-7 [&>*:first-child]:mt-0">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => <p className="my-1.5">{children}</p>,
                ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
                ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
                h1: ({ children }) => <h3 className="mt-3 text-[15px] font-semibold">{children}</h3>,
                h2: ({ children }) => <h3 className="mt-3 text-[15px] font-semibold">{children}</h3>,
                h3: ({ children }) => <h4 className="mt-2 text-[14px] font-semibold">{children}</h4>,
                blockquote: ({ children }) => <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
                table: ({ children }) => <div className="my-2 overflow-x-auto rounded-md border"><table className="w-full text-[12.5px]">{children}</table></div>,
                th: ({ children }) => <th className="border-b px-2 py-1.5 text-left font-medium">{children}</th>,
                td: ({ children }) => <td className="border-b px-2 py-1.5 align-top">{children}</td>,
                a: ({ href, children }) => {
                  if (href?.startsWith(CITE_HREF)) {
                    const n = Number(href.slice(CITE_HREF.length));
                    return <CiteChip n={n} c={byN.get(n)} unresolved={unresolved.has(n) || (t.status === "done" && !byN.has(n))} pending={t.status !== "done"} onOpen={open} />;
                  }
                  return <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{children}</a>;
                },
              }}
            >
              {md}
            </ReactMarkdown>
          </div>
        )}
        {t.status === "error" && <Notice tone="destructive">{t.error ?? "Something went wrong."}</Notice>}
        {t.status === "stopped" && <div className="text-[12px] text-muted-foreground">Stopped.</div>}
        {t.answer && t.answer.unresolved.length > 0 && (
          <Notice tone="warning">Marker{t.answer.unresolved.length === 1 ? "" : "s"} {t.answer.unresolved.map((n) => `[${n}]`).join(", ")} point{t.answer.unresolved.length === 1 ? "s" : ""} to no passage that was searched. {t.answer.unresolved.length === 1 ? "It is" : "They are"} shown as unresolved and should not be relied on.</Notice>
        )}
        {t.answer && t.answer.citations.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11.5px] font-medium text-muted-foreground">Sources</div>
            <ol className="flex flex-wrap gap-1.5">
              {t.answer.citations.map((c) => (
                <li key={c.n}>
                  <button type="button" onClick={() => open(c)} title={c.snippet}
                    className="inline-flex max-w-[320px] items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[12px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                    <span className="tabular text-muted-foreground">{c.n}</span>
                    <span className="truncate">{c.fileName}</span>
                    {c.page != null && <span className="shrink-0 tabular text-muted-foreground">p. {c.page}</span>}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
        {t.status === "done" && t.text && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Button size="icon-xs" variant="ghost" aria-label="Copy answer" title="Copy answer" onClick={() => { void navigator.clipboard?.writeText(t.text).then(() => toast.success("Copied")); }}><Copy className="size-3.5" /></Button>
          </div>
        )}
      </div>
    </article>
  );
}

function CiteChip({ n, c, unresolved, pending, onOpen }: { n: number; c?: DocCitation; unresolved: boolean; pending: boolean; onOpen: (c: DocCitation) => void }) {
  const base = "mx-0.5 inline-flex h-[18px] items-center gap-1 rounded px-1 align-[1px] text-[11px] font-medium leading-none tabular";
  if (c) {
    return (
      <button type="button" onClick={() => onOpen(c)} title={`${c.fileName}${c.page != null ? `, page ${c.page}` : ""}\n${c.snippet}`}
        className={cn(base, "bg-accent text-foreground hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40")}>
        {n}{c.page != null && <span className="font-normal text-muted-foreground">p.{c.page}</span>}
      </button>
    );
  }
  if (pending) return <span className={cn(base, "bg-muted text-muted-foreground")}>{n}</span>;
  return <span className={cn(base, "border border-dashed border-destructive/50 text-destructive")} title={unresolved ? `[${n}] is unresolved: it points to no passage that was searched.` : undefined}>{n}?</span>;
}
