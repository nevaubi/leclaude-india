"use client";
import * as React from "react";
import Link from "next/link";
import { BookOpen, ChevronDown, FolderOpen, Globe, Library, Loader2, Scale } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { DEFAULT_KNOWLEDGE, MAX_DOC_SETS, type ChatKnowledge } from "../types";

/** A document set as the menu needs it (from GET /api/documents/sets). */
export interface DocSetOption { id: string; name: string; fileCount?: number }

type SetsState =
  | { state: "idle" | "loading" }
  | { state: "ready"; sets: DocSetOption[] }
  | { state: "unavailable" | "denied" | "error" };

const STORAGE_KEY = "leclaude.chat.knowledge";

/** The knowledge switch, remembered per browser (never authoritative: the server validates every set id). */
export function useStoredKnowledge(): [ChatKnowledge, (k: ChatKnowledge) => void] {
  const [k, setK] = React.useState<ChatKnowledge>(DEFAULT_KNOWLEDGE);
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as Partial<ChatKnowledge>;
      setK({
        web: typeof v.web === "boolean" ? v.web : DEFAULT_KNOWLEDGE.web,
        law: typeof v.law === "boolean" ? v.law : DEFAULT_KNOWLEDGE.law,
        library: typeof v.library === "boolean" ? v.library : DEFAULT_KNOWLEDGE.library,
        docSetIds: Array.isArray(v.docSetIds) ? v.docSetIds.filter((x): x is string => typeof x === "string").slice(0, MAX_DOC_SETS) : [],
      });
    } catch { /* storage blocked or malformed: defaults */ }
  }, []);
  const set = React.useCallback((next: ChatKnowledge) => {
    setK(next);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  }, []);
  return [k, set];
}

/** "Web, Indian law +2" — what the button shows (the count is shown instead on narrow screens). */
export function knowledgeSummary(k: ChatKnowledge): { label: string; count: number } {
  const parts = [k.web && "Web", k.law && "Indian law", k.library && "Library", k.docSetIds.length ? `${k.docSetIds.length} doc set${k.docSetIds.length === 1 ? "" : "s"}` : null].filter(Boolean) as string[];
  if (!parts.length) return { label: "No sources", count: 0 };
  return { label: parts.length > 2 ? `${parts[0]}, ${parts[1]} +${parts.length - 2}` : parts.join(", "), count: parts.length };
}

export function KnowledgeMenu({ value, onChange, disabled }: { value: ChatKnowledge; onChange: (k: ChatKnowledge) => void; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [sets, setSets] = React.useState<SetsState>({ state: "idle" });
  const valueRef = React.useRef(value);
  valueRef.current = value;

  const load = React.useCallback(async () => {
    setSets({ state: "loading" });
    try {
      const res = await fetch("/api/documents/sets", { headers: { accept: "application/json" } });
      if (res.status === 404) { setSets({ state: "unavailable" }); return; }
      if (res.status === 401 || res.status === 403) { setSets({ state: "denied" }); return; }
      if (!res.ok) { setSets({ state: "error" }); return; }
      const body = (await res.json()) as { sets?: { id?: unknown; name?: unknown; fileCount?: unknown }[] };
      const list = (body.sets ?? []).filter((s) => typeof s.id === "string").map((s) => ({ id: s.id as string, name: typeof s.name === "string" && s.name ? s.name : "Untitled set", fileCount: typeof s.fileCount === "number" ? s.fileCount : undefined }));
      setSets({ state: "ready", sets: list });
      // Forget remembered sets that no longer exist (or are no longer readable).
      const cur = valueRef.current;
      const keep = cur.docSetIds.filter((id) => list.some((s) => s.id === id));
      if (keep.length !== cur.docSetIds.length) onChange({ ...cur, docSetIds: keep });
    } catch {
      setSets({ state: "error" });
    }
  }, [onChange]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Load on each open unless a list is already loading or loaded for this page view.
    if (next && sets.state !== "loading" && sets.state !== "ready") void load();
  };

  const summary = knowledgeSummary(value);
  const toggleSet = (id: string, on: boolean) => {
    const next = on ? Array.from(new Set([...value.docSetIds, id])).slice(0, MAX_DOC_SETS) : value.docSetIds.filter((x) => x !== id);
    onChange({ ...value, docSetIds: next });
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} aria-label={`Sources: ${summary.label}`} title="Choose what the assistant may consult"
          className={cn("inline-flex h-8 max-w-[220px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] sm:px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            open ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
          <BookOpen className="size-4 shrink-0" />
          <span className="hidden truncate sm:inline">{summary.label}</span>
          <span className="tabular-nums sm:hidden">{summary.count}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-1.5">
        <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sources</div>
        <SourceRow icon={Globe} label="Web" hint="Current, public information" checked={value.web} onChange={(v) => onChange({ ...value, web: v })} />
        <SourceRow icon={Scale} label="Indian law" hint="Judgments and statutes" checked={value.law} onChange={(v) => onChange({ ...value, law: v })} />
        <SourceRow icon={Library} label="Firm library" hint="Templates, precedents, notes" checked={value.library} onChange={(v) => onChange({ ...value, library: v })} />
        <div className="mx-2 my-1.5 border-t" />
        <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Document sets</span>
          {value.docSetIds.length > 0 && <button type="button" onClick={() => onChange({ ...value, docSetIds: [] })} className="rounded text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Clear</button>}
        </div>
        <DocSetList state={sets} selected={value.docSetIds} onToggle={toggleSet} onRetry={() => void load()} />
      </PopoverContent>
    </Popover>
  );
}

function SourceRow({ icon: Icon, label, hint, checked, onChange }: { icon: typeof Globe; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = React.useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-foreground">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{hint}</span>
      </span>
      <Switch id={id} size="sm" checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

function DocSetList({ state, selected, onToggle, onRetry }: { state: SetsState; selected: string[]; onToggle: (id: string, on: boolean) => void; onRetry: () => void }) {
  if (state.state === "idle" || state.state === "loading") {
    return <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading document sets…</div>;
  }
  if (state.state === "denied") return <p className="px-2 py-2 text-[12px] text-muted-foreground">You do not have access to document sets.</p>;
  if (state.state === "error") {
    return (
      <p className="px-2 py-2 text-[12px] text-muted-foreground">
        Document sets could not be loaded. <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Retry</button>
      </p>
    );
  }
  const sets = state.state === "ready" ? state.sets : [];
  if (!sets.length) {
    return (
      <p className="px-2 py-2 text-[12px] leading-5 text-muted-foreground">
        No document sets yet — <Link href="/documents" className="text-foreground underline underline-offset-2 hover:opacity-80">create one in Documents</Link>.
      </p>
    );
  }
  return (
    <ul className="max-h-[220px] overflow-y-auto scrollbar-thin">
      {sets.map((s) => {
        const on = selected.includes(s.id);
        const id = `docset-${s.id}`;
        return (
          <li key={s.id}>
            <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent">
              <Checkbox id={id} size="sm" checked={on} onCheckedChange={(v) => onToggle(s.id, v === true)} />
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{s.name}</span>
              {s.fileCount != null && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{s.fileCount} file{s.fileCount === 1 ? "" : "s"}</span>}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
