"use client";
import * as React from "react";
import { ArrowUp, Briefcase, Check, ChevronDown, Globe, Layers, Mic, MicOff, PencilLine, Scale, Square } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tip } from "@/components/ui/tooltip";
import { JURISDICTIONS, jurisdictionByKey } from "../jurisdictions";
import { planLanes } from "../engine/planner";
import type { SearchSettings, SearchSource } from "../types";
import { QueryBuilder } from "./query-builder";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (q?: string) => void;
  settings: SearchSettings;
  setSettings: (patch: Partial<SearchSettings>) => void;
  toggleSource: (s: SearchSource) => void;
  matters: { id: string; shortName: string; caption?: string }[];
  streaming: boolean;
  onStop: () => void;
  onToggleLanes: () => void;
  lanesOpen: boolean;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}

interface SpeechRecognitionLike { start(): void; stop(): void; continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null }

/** Law scope groups shown in the "All law" popover; each maps onto one or more providers. */
const LAW_GROUPS: { id: string; label: string; sources: SearchSource[]; hint: string }[] = [
  { id: "cases", label: "Judgments", sources: ["caselaw"], hint: "Supreme Court and High Court judgments" },
  { id: "statutes", label: "Statutes", sources: ["statutes"], hint: "India Code: central and state Acts" },
  { id: "secondary", label: "Secondary", sources: ["library"], hint: "Firm library, memos, clause bank" },
];

export function Chip({ active, children, className, onClick, icon: Icon, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-[var(--radius-chip)] border px-2 text-[11.5px] font-medium transition-colors cursor-pointer", active ? "border-transparent bg-accent text-foreground" : "bg-background text-muted-foreground hover:border-foreground/25 hover:text-foreground", className)}
      {...rest}
    >
      {Icon && <Icon className="size-3.5 shrink-0" />}
      <span className="truncate [&>svg]:ml-1 [&>svg]:inline [&>svg]:align-[-2px]">{children}</span>
    </button>
  );
}

export function ResearchComposer(p: ComposerProps) {
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const ref = p.inputRef ?? taRef;
  const [listening, setListening] = React.useState(false);
  const recRef = React.useRef<SpeechRecognitionLike | null>(null);
  const [builderOpen, setBuilderOpen] = React.useState(false);
  const [lanesPreviewOpen, setLanesPreviewOpen] = React.useState(false);
  const s = p.settings;
  const matter = p.matters.find((m) => m.id === s.matterId) ?? null;
  const j = jurisdictionByKey(s.jurisdiction);
  const lawLabel = React.useMemo(() => {
    const on = LAW_GROUPS.filter((g) => g.sources.some((x) => s.sources.includes(x)));
    if (on.length === LAW_GROUPS.length) return "All law";
    if (on.length === 0) return "No law scope";
    return on.length > 2 ? `${on[0].label} +${on.length - 1}` : on.map((g) => g.label).join(", ");
  }, [s.sources]);
  const jurisdictionLabel = j.label.split(" (")[0];
  const preview = React.useMemo(() => planLanes({ question: p.value || "question", settings: s, mode: s.fast ? "fast" : "deep", hasMatter: Boolean(s.matterId) }), [p.value, s]);

  React.useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(200, Math.max(44, ta.scrollHeight)) + "px";
  }, [p.value, ref]);

  const submit = () => { if (p.streaming) { p.onStop(); return; } p.onSubmit(); };

  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); setListening(false); return; }
    const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike; SpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { toast.error("Voice input is not supported in this browser."); return; }
    const rec = new Ctor();
    rec.continuous = true; rec.interimResults = true; rec.lang = "en-US";
    const base = p.value ? p.value + " " : "";
    rec.onresult = (e) => {
      let finalText = "", interim = "";
      for (let i = 0; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finalText += r[0].transcript + " "; else interim += r[0].transcript; }
      p.onChange((base + finalText + interim).replace(/\s+/g, " "));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  const setGroup = (g: (typeof LAW_GROUPS)[number], on: boolean) => {
    const next = on ? Array.from(new Set([...s.sources, ...g.sources])) : s.sources.filter((x) => !g.sources.includes(x));
    p.setSettings({ sources: next.length ? next : s.sources });
  };
  const setMatter = (id: string | null) => {
    // Matter context pulls the record (documents, depositions) and the library into scope automatically.
    const sources = id ? Array.from(new Set([...s.sources, "ediscovery" as SearchSource, "library" as SearchSource])) : s.sources.filter((x) => x !== "ediscovery");
    p.setSettings({ matterId: id, sources });
  };

  return (
    <div className="rounded-lg border bg-card transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
      <textarea
        ref={ref}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
        placeholder={p.placeholder ?? "Ask a research question — e.g. “What is the clear-evidence standard for impossibility preemption after Albrecht?”"}
        autoFocus={p.autoFocus}
        rows={1}
        spellCheck
        aria-label="Research question"
        className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/80 scrollbar-thin"
      />
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pt-1.5">
        <Popover>
          <PopoverTrigger asChild>
            <Chip active={Boolean(matter)} icon={Briefcase} aria-label="Matter">{matter ? matter.shortName : "Matter (optional)"}<ChevronDown className="size-3 opacity-60" /></Chip>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-1.5">
            <div className="px-2 py-1 text-[11.5px] font-medium text-muted-foreground">Matter context</div>
            <button onClick={() => setMatter(null)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent cursor-pointer", !matter && "bg-accent")}>None{!matter && <Check className="ml-auto size-3.5" />}</button>
            {p.matters.map((m) => (
              <button key={m.id} onClick={() => setMatter(m.id)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent cursor-pointer", matter?.id === m.id && "bg-accent")}>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{m.shortName}</span>{m.caption && <span className="block truncate text-[10.5px] text-muted-foreground">{m.caption}</span>}</span>
                {matter?.id === m.id && <Check className="size-3.5" />}
              </button>
            ))}
            <div className="px-2 pt-1.5 text-[10.5px] text-muted-foreground">Selecting a matter adds its documents, depositions and library items to every run and separates the record from outside authority.</div>
          </PopoverContent>
        </Popover>

        <Tip label={s.sources.includes("web") ? "Web lane on: agency pages, court sites, the open web" : "Web lane off"}>
          <Chip active={s.sources.includes("web")} icon={Globe} onClick={() => p.toggleSource("web")} aria-pressed={s.sources.includes("web")}>Web</Chip>
        </Tip>

        <Popover>
          <PopoverTrigger asChild><Chip active icon={Scale} aria-label="Law scope">{lawLabel}<ChevronDown className="size-3 opacity-60" /></Chip></PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2">
            <div className="px-1 pb-1 text-[11.5px] font-medium text-muted-foreground">Law scope</div>
            {LAW_GROUPS.map((g) => {
              const on = g.sources.some((x) => s.sources.includes(x));
              return (
                <label key={g.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-xs hover:bg-accent">
                  <Checkbox checked={on} onCheckedChange={(v) => setGroup(g, Boolean(v))} />
                  <span className="flex-1"><span className="font-medium">{g.label}</span><span className="block text-[10.5px] text-muted-foreground">{g.hint}</span></span>
                </label>
              );
            })}
            <div className="mt-1 flex items-center justify-between border-t px-1.5 pt-2 text-[11px]">
              <button className="text-primary hover:underline cursor-pointer" onClick={() => p.setSettings({ sources: Array.from(new Set([...s.sources, ...LAW_GROUPS.flatMap((g) => g.sources)])) })}>All law</button>
              <span className="text-muted-foreground">Dates: {s.datePreset === "any" ? "any" : s.datePreset}</span>
              <div className="flex gap-1">{(["any", "5y", "10y"] as const).map((d) => <button key={d} onClick={() => p.setSettings({ datePreset: d })} className={cn("rounded px-1.5 py-0.5 cursor-pointer", s.datePreset === d ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>{d}</button>)}</div>
            </div>
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild><Chip active={s.jurisdiction !== "all-india"} aria-label="Jurisdiction">{jurisdictionLabel}<ChevronDown className="size-3 opacity-60" /></Chip></PopoverTrigger>
          <PopoverContent align="start" className="max-h-80 w-72 overflow-y-auto p-1.5 scrollbar-thin">
            {(["India", "Focus courts", "Other High Courts"] as const).map((group) => (
              <div key={group}>
                <div className="px-2 pb-0.5 pt-1.5 text-[11.5px] font-medium text-muted-foreground">{group}</div>
                {JURISDICTIONS.filter((x) => x.group === group).map((x) => (
                  <button key={x.key} onClick={() => p.setSettings({ jurisdiction: x.key })} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent cursor-pointer", s.jurisdiction === x.key && "bg-accent")}>
                    <span className="min-w-0 flex-1 truncate">{x.label}</span>
                    {s.jurisdiction === x.key && <Check className="size-3.5" />}
                  </button>
                ))}
              </div>
            ))}
          </PopoverContent>
        </Popover>

        <div className="flex-1" />

        <Tip label={listening ? "Stop dictation" : "Dictate the question"}>
          <Button variant="ghost" size="icon-sm" onClick={toggleMic} className={cn(listening && "text-destructive")} aria-label={listening ? "Stop dictation" : "Dictate"} aria-pressed={listening}>{listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}</Button>
        </Tip>
        <Popover open={builderOpen} onOpenChange={setBuilderOpen}>
          <PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Edit as a boolean query"><PencilLine className="size-4" /></Button></PopoverTrigger>
          <PopoverContent align="end" className="w-[420px] p-3">
            <div className="mb-2 text-[11.5px] font-medium text-muted-foreground">Boolean query builder</div>
            <QueryBuilder query={p.value} onApply={(q) => { p.onChange(q); setBuilderOpen(false); ref.current?.focus(); }} />
          </PopoverContent>
        </Popover>
        <Popover open={lanesPreviewOpen} onOpenChange={setLanesPreviewOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Research lanes" className={cn(p.lanesOpen && "text-primary")}><Layers className="size-4" /></Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-3">
            <div className="flex items-center justify-between">
              <div className="text-[11.5px] font-medium text-muted-foreground">Research lanes</div>
              <label className="flex items-center gap-1.5 text-[11.5px] cursor-pointer">Fast answer <Switch size="sm" checked={s.fast} onCheckedChange={(v) => p.setSettings({ fast: v })} aria-label="Fast answer" /></label>
            </div>
            <ul className="mt-2 space-y-1">
              {preview.map((l) => (
                <li key={l.id} className="rounded-md border bg-background px-2 py-1.5 text-xs">
                  <div className="font-medium">{l.name}</div>
                  <div className="text-[10.5px] text-muted-foreground">{l.brief} · reads up to {l.maxReads}</div>
                </li>
              ))}
            </ul>
            <div className="mt-2 text-[10.5px] text-muted-foreground">{s.fast ? "One lane, one round, the fast model. Good for a quick orientation." : `${preview.length} lanes run in parallel, up to 3 rounds; the primary model writes the synthesis from what the lanes read.`}</div>
            <Button variant="outline" size="xs" className="mt-2 w-full" onClick={() => { p.onToggleLanes(); setLanesPreviewOpen(false); }}>{p.lanesOpen ? "Hide the live panel" : "Show the live panel"}</Button>
          </PopoverContent>
        </Popover>
        <Button size="icon-sm" onClick={submit} disabled={!p.streaming && !p.value.trim()} className="rounded-md" aria-label={p.streaming ? "Stop" : "Ask"}>
          {p.streaming ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
