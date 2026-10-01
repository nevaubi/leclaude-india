"use client";
import * as React from "react";
import { Check, ChevronRight, Globe, Loader2, Search, BookOpen, FileText, AlertCircle, Wrench, Landmark, Scale, Library } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolActivity, Citation } from "@/hooks/use-agent";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  web_search: Globe, fetch_url: Globe, search_case_law: Scale, get_opinion_text: Scale, search_dockets: Landmark, get_docket_entries: Landmark, verify_citations: Check,
  search_cfr: BookOpen, get_cfr_section: BookOpen, search_federal_register: BookOpen, get_federal_register_document: BookOpen, search_statutes: BookOpen, search_law: BookOpen, read_law_section: BookOpen, list_law_instruments: BookOpen,
  search_ediscovery: Search, get_ediscovery_document: FileText, search_library: Library, get_library_item: FileText, get_matter_context: FileText,
};

export function ToolActivityList({ tools, className, defaultOpen = false }: { tools: ToolActivity[]; className?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  if (!tools.length) return null;
  const running = tools.some((t) => t.status === "running");
  const done = tools.filter((t) => t.status !== "running").length;
  return (
    <div className={cn("rounded-md border text-xs", className)}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground cursor-pointer">
        {running ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5 text-muted-foreground" />}
        <span className="flex-1 truncate">{running ? tools[tools.length - 1].label : `${done} step${done === 1 ? "" : "s"} · ${summarize(tools)}`}</span>
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ul className="border-t divide-y">
          {tools.map((t) => <ToolRow key={t.id} tool={t} />)}
        </ul>
      )}
    </div>
  );
}

function summarize(tools: ToolActivity[]) {
  const names = Array.from(new Set(tools.map((t) => t.name.replace(/_/g, " "))));
  return names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
}

function ToolRow({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = React.useState(false);
  const Icon = ICONS[tool.name] ?? Wrench;
  return (
    <li>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-quiet cursor-pointer">
        <Icon className={cn("size-3.5 shrink-0", tool.status === "error" ? "text-destructive" : "text-muted-foreground")} />
        <span className="flex-1 truncate">{tool.label}</span>
        {tool.status === "running" && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        {tool.status === "done" && tool.durationMs != null && <span className="tabular text-[10px] text-muted-foreground">{(tool.durationMs / 1000).toFixed(1)}s</span>}
        {tool.status === "error" && <AlertCircle className="size-3 text-destructive" />}
      </button>
      {open && (
        <div className="space-y-1 bg-background/60 px-2.5 pb-2 pt-1 font-mono text-[11px]">
          <div className="text-muted-foreground">args</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1.5 scrollbar-thin">{JSON.stringify(tool.args, null, 1)}</pre>
          {tool.error ? (
            <div className="text-destructive">{tool.error}</div>
          ) : tool.result !== undefined ? (
            <>
              <div className="text-muted-foreground">result</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1.5 scrollbar-thin">{typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 1)}</pre>
            </>
          ) : null}
        </div>
      )}
    </li>
  );
}

export function CitationList({ citations, className }: { citations: Citation[]; className?: string }) {
  if (!citations.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {citations.map((c, i) => {
        const inner = (
          <span className="inline-flex max-w-full items-center gap-1 rounded-[var(--radius-chip)] bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
            <span className="tabular text-[10px] font-medium text-foreground/70">{i + 1}</span>
            <span className="truncate max-w-[220px]">{c.title}</span>
            {c.source && <span className="hidden sm:inline text-[10px] opacity-70">· {c.source}</span>}
          </span>
        );
        return c.url ? <a key={i} href={c.url} target="_blank" rel="noreferrer" title={c.snippet ?? c.title}>{inner}</a> : <span key={i} title={c.snippet ?? c.title}>{inner}</span>;
      })}
    </div>
  );
}
