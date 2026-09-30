"use client";
import * as React from "react";
import { Check, ChevronDown, FileText, Loader2, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { DocFile } from "../types";
import { docsApi, setUrl } from "./api";

/**
 * Pick one or more files of a set. The list is searched on the server (`/files?q=`), so it works for sets with
 * thousands of files. Selected names are remembered for the chip label.
 */
export function FilePicker({ setId, value, onChange, multi, placeholder = "All files", className }: {
  setId: string; value: string[]; onChange: (ids: string[], names: Record<string, string>) => void; multi?: boolean; placeholder?: string; className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [rows, setRows] = React.useState<DocFile[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const names = React.useRef<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      docsApi<{ files: DocFile[]; total: number }>(setUrl(setId, `/files?limit=50&offset=0${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`), { signal: ac.signal })
        .then((r) => { setRows(r.files); setTotal(r.total); for (const f of r.files) names.current[f.id] = f.name; })
        .catch(() => { if (!ac.signal.aborted) setRows([]); })
        .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    }, q ? 200 : 0);
    return () => { clearTimeout(t); ac.abort(); };
  }, [open, q, setId]);

  const toggle = (f: DocFile) => {
    names.current[f.id] = f.name;
    const next = multi ? (value.includes(f.id) ? value.filter((x) => x !== f.id) : [...value, f.id]) : value[0] === f.id ? [] : [f.id];
    onChange(next, { ...names.current });
    if (!multi) setOpen(false);
  };

  const label = value.length === 0 ? placeholder : value.length === 1 ? names.current[value[0]] ?? "1 file" : `${value.length} files`;

  return (
    <div className={cn("inline-flex min-w-0 items-center", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={cn("inline-flex h-7 min-w-0 max-w-[260px] items-center gap-1.5 rounded-md border px-2 text-[12.5px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40", value.length ? "text-foreground" : "text-muted-foreground")}>
            <FileText className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[340px] p-0">
          <div className="flex items-center gap-2 border-b px-2.5">
            <Search className="size-3.5 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files" aria-label="Search files" autoFocus className="h-9 w-full bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground" />
            {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          <ul className="max-h-[300px] overflow-y-auto p-1 scrollbar-thin" role="listbox" aria-multiselectable={multi}>
            {rows && rows.length === 0 && !loading && <li className="px-2.5 py-4 text-center text-[12px] text-muted-foreground">No files match.</li>}
            {rows?.map((f) => {
              const on = value.includes(f.id);
              return (
                <li key={f.id}>
                  <button type="button" role="option" aria-selected={on} onClick={() => toggle(f)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-accent">
                    <Check className={cn("size-3.5 shrink-0", on ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
                    {f.pages > 0 && <span className="shrink-0 text-[11px] tabular text-muted-foreground">{f.pages} pp</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {rows && total > rows.length && <div className="border-t px-2.5 py-1.5 text-[11px] text-muted-foreground">Showing {rows.length} of {total.toLocaleString("en-IN")}; search to narrow.</div>}
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <button type="button" aria-label="Clear file filter" onClick={() => onChange([], names.current)} className="ms-0.5 inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
