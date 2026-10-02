"use client";
import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { DocCitation } from "../../types";
import type { ReportAnswer } from "../../review-types";
import { CITE_HREF, linkCitationMarkers, markersIn } from "../format";
import type { ViewerTarget } from "../text-viewer";
import { mapCitations } from "./review-helpers";

/**
 * A report answer in markdown with its [n] markers as chips: resolved markers open the file at the cited page; markers
 * with no citation (or listed as unresolved) are shown as unresolved and never re-bound. Same chip style as Ask.
 */
export function CitedAnswer({ answer, onView }: { answer: ReportAnswer; onView: (t: ViewerTarget) => void }) {
  const md = React.useMemo(() => linkCitationMarkers(answer.answer), [answer.answer]);
  const { byN } = React.useMemo(() => mapCitations(answer, markersIn(answer.answer)), [answer]);
  const open = (c: DocCitation) => onView({ fileId: c.fileId, page: c.page, highlight: c.snippet, name: c.fileName });
  return (
    <div className="space-y-2 text-[13px] leading-6 [&>*:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1">{children}</p>,
          ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>,
          h1: ({ children }) => <h4 className="mt-2 text-[13px] font-semibold">{children}</h4>,
          h2: ({ children }) => <h4 className="mt-2 text-[13px] font-semibold">{children}</h4>,
          h3: ({ children }) => <h4 className="mt-2 text-[13px] font-semibold">{children}</h4>,
          blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
          table: ({ children }) => <div className="my-2 overflow-x-auto rounded-md border"><table className="w-full text-[12px]">{children}</table></div>,
          th: ({ children }) => <th className="border-b px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
          a: ({ href, children }) => {
            if (href?.startsWith(CITE_HREF)) {
              const n = Number(href.slice(CITE_HREF.length));
              return <CiteChip n={n} c={byN.get(n)} onOpen={open} />;
            }
            return <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{children}</a>;
          },
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}

export function CiteChip({ n, c, onOpen }: { n: number; c?: DocCitation; onOpen: (c: DocCitation) => void }) {
  const base = "mx-0.5 inline-flex h-[18px] items-center gap-1 rounded px-1 align-[1px] text-[11px] font-medium leading-none tabular";
  if (c) {
    return (
      <button type="button" onClick={() => onOpen(c)} title={`${c.fileName}${c.page != null ? `, page ${c.page}` : ""}\n${c.snippet}`}
        className={cn(base, "bg-accent text-foreground hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40")}>
        {n}{c.page != null && <span className="font-normal text-muted-foreground">p.{c.page}</span>}
      </button>
    );
  }
  return <span className={cn(base, "border border-dashed border-destructive/50 text-destructive")} title={`[${n}] is unresolved: it points to no passage that was searched.`}>{n}?</span>;
}

/** Source list under an answer. */
export function SourceList({ citations, onView }: { citations: DocCitation[]; onView: (t: ViewerTarget) => void }) {
  if (!citations.length) return null;
  return (
    <ol className="flex flex-wrap gap-1.5">
      {citations.map((c) => (
        <li key={c.n}>
          <button type="button" onClick={() => onView({ fileId: c.fileId, page: c.page, highlight: c.snippet, name: c.fileName })} title={c.snippet}
            className="inline-flex max-w-[300px] items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 text-[11.5px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
            <span className="tabular text-muted-foreground">{c.n}</span>
            <span className="truncate">{c.fileName}</span>
            {c.page != null && <span className="shrink-0 tabular text-muted-foreground">p. {c.page}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}
