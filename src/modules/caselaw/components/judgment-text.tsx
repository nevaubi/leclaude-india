"use client";
import * as React from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CaseApiError, fetchCaseJson } from "./fetch";

interface Chunk { index: number; pageStart: number | null; pageEnd: number | null; section: string | null; text: string }
interface TextResponse { judgmentId: string; neutralCitation: string; title: string; totalChunks: number; chunks: Chunk[]; nextChunk: number | null; attribution: string }

/** Strip the dataset's light markup ("[SECTION] ## ", "[TITLE] # ") without touching the words. */
function clean(text: string): string {
  return text.replace(/\[(SECTION|TITLE|SUBSECTION|HEADER)\]\s*#*\s*/g, "").replace(/^#{1,6}\s+/gm, "");
}

/**
 * The judgment's text (Supreme Court full-text corpus), loaded in pages of chunks with page markers. Shown only for
 * records whose text_status is "full"; the official PDF stays the text of record.
 */
export function JudgmentTextSection({ id, citation }: { id: string; citation: string | null }) {
  const [chunks, setChunks] = React.useState<Chunk[]>([]);
  const [meta, setMeta] = React.useState<Pick<TextResponse, "totalChunks" | "nextChunk" | "attribution"> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const load = React.useCallback(async (from: number, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchCaseJson<TextResponse>(`/api/cases/text?id=${encodeURIComponent(id)}&chunk=${from}`, signal);
      setChunks((prev) => (from === 0 ? r.chunks : [...prev, ...r.chunks]));
      setMeta({ totalChunks: r.totalChunks, nextChunk: r.nextChunk, attribution: r.attribution });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof CaseApiError ? e.message : "The judgment text could not be loaded.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    const ac = new AbortController();
    void load(0, ac.signal);
    return () => ac.abort();
  }, [load]);

  const copyAll = async () => {
    const text = chunks.map((c) => clean(c.text)).join("\n\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { toast.error("Could not copy"); }
  };

  let lastPage: number | null = null;
  return (
    <section className="rounded-md border" aria-label="Judgment text">
      <header className="flex h-8 items-center gap-2 border-b px-3">
        <h2 className="text-[12.5px] font-medium">Judgment text</h2>
        <span className="flex-1" />
        {chunks.length ? <Button size="xs" variant="ghost" onClick={copyAll}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{meta?.nextChunk != null ? "Copy loaded text" : "Copy text"}</Button> : null}
      </header>
      <div className="max-h-[70vh] overflow-auto px-3 py-2.5 scrollbar-thin">
        {loading && !chunks.length ? (
          <div className="space-y-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-11/12" /><Skeleton className="h-3 w-10/12" /><Skeleton className="h-3 w-full" /></div>
        ) : error && !chunks.length ? (
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">{error}<Button size="xs" variant="outline" onClick={() => void load(0)}><RotateCcw className="size-3.5" />Retry</Button></div>
        ) : (
          <div className="space-y-3 text-[13px] leading-relaxed">
            {chunks.map((c) => {
              const marker = c.pageStart != null && c.pageStart !== lastPage ? c.pageStart : null;
              if (marker != null) lastPage = marker;
              return (
                <div key={c.index}>
                  {marker != null ? <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground tabular" id={`p${marker}`}>Page {marker}</div> : null}
                  <p className={cn("whitespace-pre-wrap", c.section === "conclusion" && "border-l-2 pl-2")}>{clean(c.text)}</p>
                </div>
              );
            })}
            {meta?.nextChunk != null ? (
              <Button size="xs" variant="outline" disabled={loading} onClick={() => void load(meta.nextChunk!)}>{loading ? "Loading…" : "Continue reading"}</Button>
            ) : null}
            {error && chunks.length ? <p className="text-[12px] text-destructive">{error}</p> : null}
          </div>
        )}
      </div>
      {meta ? <footer className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">{meta.attribution}{citation ? ` Cite as ${citation}, with the page.` : ""}</footer> : null}
    </section>
  );
}
