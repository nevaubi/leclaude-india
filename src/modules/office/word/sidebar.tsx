"use client";
/** Word left sidebar: Outline | Find | Checks as segmented buttons: outline rows with word counts, find & replace, filing check. */
import * as React from "react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CaseSensitive, ChevronDown, ChevronUp, FileCheck2, ListTree, Regex, Replace, ReplaceAll, Search, WholeWord, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { PanelEmpty, SegmentedControl } from "@/modules/office/shared/office-chrome";
import { wordCount } from "./doc-model";
import { findKey, findRanges, type FindQuery } from "./extensions";
import { buildTrackedInline } from "./tracked-diff";
import { ChecksPanel } from "./filing-check-ui";
import type { PMNode } from "./doc-model";

export interface OutlineItem { id: string; level: number; text: string; pos: number; words: number; index: number }

/** Headings with word counts of the section that follows each. */
export function computeOutline(editor: Editor): OutlineItem[] {
  const out: OutlineItem[] = [];
  let n = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock || node.type.name === "image" || node.type.name === "pageBreak" || node.type.name === "horizontalRule") n++;
    if (node.type.name === "heading") { out.push({ id: String(node.attrs.id ?? ""), level: Number(node.attrs.level ?? 1), text: node.textContent, pos, words: 0, index: n }); return false; }
    if (node.isTextblock && out.length) { out[out.length - 1].words += wordCount(node.textContent); return false; }
    return true;
  });
  return out;
}

export type SidebarTab = "outline" | "find" | "checks";

const TABS: { id: SidebarTab; label: string; icon: typeof ListTree; shortcut?: string }[] = [
  { id: "outline", label: "Outline", icon: ListTree, shortcut: "⌘⇧O" },
  { id: "find", label: "Find", icon: Search, shortcut: "⌘F" },
  { id: "checks", label: "Checks", icon: FileCheck2 },
];

export function WordSidebar({ editor, tab, onTab, outline, currentHeadingId, onClose, findFocusKey, docId, onLocate }: { editor: Editor; tab: SidebarTab; onTab: (t: SidebarTab) => void; outline: OutlineItem[]; currentHeadingId: string | null; onClose: () => void; findFocusKey: number; docId?: string; onLocate?: (blockId: string) => void }) {
  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r bg-background" aria-label="Document sidebar">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <SegmentedControl ariaLabel="Sidebar view" grow size="xs" value={tab} onChange={onTab} options={TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, shortcut: t.shortcut }))} />
        <Tip label="Hide sidebar" shortcut="⌘⇧O"><Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Hide sidebar"><X className="size-3.5" /></Button></Tip>
      </div>
      {tab === "outline" ? <OutlinePanel editor={editor} outline={outline} currentHeadingId={currentHeadingId} /> : tab === "find" ? <FindReplacePanel editor={editor} focusKey={findFocusKey} /> : <ChecksPanel editor={editor} docId={docId} onLocate={onLocate ?? (() => undefined)} />}
    </aside>
  );
}

function OutlinePanel({ editor, outline, currentHeadingId }: { editor: Editor; outline: OutlineItem[]; currentHeadingId: string | null }) {
  const parentRef = React.useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: outline.length, getScrollElement: () => parentRef.current, estimateSize: () => 32, overscan: 12 });
  const go = (item: OutlineItem) => {
    editor.chain().focus().setTextSelection(item.pos + 1).run();
    const dom = editor.view.nodeDOM(item.pos) as HTMLElement | null;
    dom?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  if (!outline.length) return <PanelEmpty icon={ListTree} title="No headings yet" description="Use the Style menu (Heading 1–3, ⌘⌥1–3) to build an outline, or ask the assistant to structure the document." />;
  const total = outline.reduce((n, o) => n + o.words, 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 py-2 text-[11.5px] text-muted-foreground"><span>{outline.length} heading{outline.length === 1 ? "" : "s"}</span><span className="tabular">{total.toLocaleString()} words</span></div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => {
            const item = outline[v.index];
            const active = item.id === currentHeadingId;
            return (
              <button key={item.id || v.index} onClick={() => go(item)} title={item.text} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: v.size, transform: `translateY(${v.start}px)` }} className={cn("flex items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition-colors cursor-pointer", active ? "bg-primary/10 text-primary" : "text-foreground/85 hover:bg-accent")}>
                <span className="shrink-0" style={{ width: (item.level - 1) * 12 }} />
                <span className={cn("w-4 shrink-0 text-[10px] tabular", active ? "text-primary/80" : "text-muted-foreground/70")}>H{item.level}</span>
                <span className={cn("min-w-0 flex-1 truncate", item.level === 1 && "font-medium")}>{item.text || <span className="italic text-muted-foreground">Untitled heading</span>}</span>
                <span className="shrink-0 text-[10.5px] tabular text-muted-foreground">{item.words}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FindReplacePanel({ editor, focusKey }: { editor: Editor; focusKey: number }) {
  const [query, setQuery] = React.useState("");
  const [replace, setReplace] = React.useState("");
  const [regex, setRegex] = React.useState(false);
  const [caseSensitive, setCase] = React.useState(false);
  const [wholeWord, setWhole] = React.useState(false);
  const [current, setCurrent] = React.useState(0);
  const [count, setCount] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [focusKey]);

  const run = React.useCallback((q: FindQuery) => {
    const ranges = findRanges(editor.state.doc, q);
    setCount(ranges.length);
    const idx = ranges.length ? Math.min(Math.max(0, q.current ?? 0), ranges.length - 1) : -1;
    editor.view.dispatch(editor.state.tr.setMeta("find", { ...q, current: idx }));
    if (idx >= 0) {
      const r = ranges[idx];
      try { const dom = editor.view.domAtPos(r.from).node; const el = dom instanceof HTMLElement ? dom : dom.parentElement; el?.scrollIntoView({ block: "center" }); } catch { /* ignore */ }
    }
    return ranges;
  }, [editor]);

  React.useEffect(() => {
    const t = setTimeout(() => { setCurrent(0); run({ text: query, regex, caseSensitive, wholeWord, current: 0 }); }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, regex, caseSensitive, wholeWord]);

  React.useEffect(() => () => { editor.view.dispatch(editor.state.tr.setMeta("find", null)); }, [editor]);

  const step = (dir: 1 | -1) => {
    if (!count) return;
    const next = (current + dir + count) % count;
    setCurrent(next);
    run({ text: query, regex, caseSensitive, wholeWord, current: next });
  };

  const doReplace = (all: boolean) => {
    const state = findKey.getState(editor.state);
    if (!state?.ranges.length) return;
    const ranges = all ? state.ranges : [state.ranges[Math.max(0, state.current)]];
    const tracking = (editor.storage as unknown as { trackChanges: { enabled: boolean; author: string } }).trackChanges;
    const tr = editor.state.tr;
    const sorted = [...ranges].sort((a, b) => b.from - a.from);
    for (const r of sorted) {
      const matched = editor.state.doc.textBetween(r.from, r.to);
      let rep = replace;
      if (regex) { try { rep = matched.replace(new RegExp(query, `u${caseSensitive ? "" : "i"}`), replace); } catch { /* keep */ } }
      const $from = editor.state.doc.resolve(r.from);
      const marks = $from.marks();
      if (tracking?.enabled) {
        const old = [{ type: "text", text: matched, marks: marks.map((m) => m.toJSON() as { type: string; attrs?: Record<string, unknown> }) }] as PMNode[];
        const next = rep ? [{ type: "text", text: rep, marks: marks.map((m) => m.toJSON() as { type: string; attrs?: Record<string, unknown> }) }] as PMNode[] : [];
        const content = buildTrackedInline(old, next, { change: { id: `fr_${Date.now().toString(36)}`, author: tracking.author, date: new Date().toISOString() } });
        tr.replaceWith(r.from, r.to, content.map((n) => editor.state.schema.nodeFromJSON(n)));
      } else {
        if (rep) tr.replaceWith(r.from, r.to, editor.state.schema.text(rep, marks)); else tr.delete(r.from, r.to);
      }
    }
    tr.setMeta("trackChanges", "ignore");
    editor.view.dispatch(tr);
    toast.success(all ? `Replaced ${ranges.length} occurrence${ranges.length === 1 ? "" : "s"}` : "Replaced");
    setTimeout(() => run({ text: query, regex, caseSensitive, wholeWord, current: Math.min(current, Math.max(0, count - 2)) }), 0);
  };

  const selectCurrent = () => {
    const state = findKey.getState(editor.state);
    const r = state?.ranges[state.current];
    if (!r) return;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, r.from, r.to)).scrollIntoView());
    editor.view.focus();
  };

  const optBtn = (label: string, on: boolean, toggle: () => void, Icon: typeof CaseSensitive) => (
    <Tip label={label}><button onClick={toggle} aria-pressed={on} aria-label={label} className={cn("rounded-md p-1 transition-colors cursor-pointer", on ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}><Icon className="size-4" /></button></Tip>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); } if (e.key === "Escape") { setQuery(""); editor.view.focus(); } }} placeholder="Find in document" className="h-8 pl-7 pr-14 text-xs" aria-label="Find" />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] tabular text-muted-foreground">{query ? (count ? `${current + 1}/${count}` : "0/0") : ""}</span>
      </div>
      <div className="flex items-center gap-0.5">
        {optBtn("Match case", caseSensitive, () => setCase((v) => !v), CaseSensitive)}
        {optBtn("Whole word", wholeWord, () => setWhole((v) => !v), WholeWord)}
        {optBtn("Regular expression", regex, () => setRegex((v) => !v), Regex)}
        <div className="flex-1" />
        <Tip label="Previous" shortcut="⇧↵"><button onClick={() => step(-1)} disabled={!count} aria-label="Previous match" className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-40 cursor-pointer"><ChevronUp className="size-4" /></button></Tip>
        <Tip label="Next" shortcut="↵"><button onClick={() => step(1)} disabled={!count} aria-label="Next match" className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-40 cursor-pointer"><ChevronDown className="size-4" /></button></Tip>
      </div>
      <div className="relative">
        <Replace className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={replace} onChange={(e) => setReplace(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doReplace(e.metaKey || e.ctrlKey); } }} placeholder="Replace with" className="h-8 pl-7 text-xs" aria-label="Replace" />
      </div>
      <div className="flex items-center gap-1">
        <Button size="xs" variant="outline" disabled={!count} onClick={() => doReplace(false)}><Replace className="size-3.5" /> Replace</Button>
        <Button size="xs" variant="outline" disabled={!count} onClick={() => doReplace(true)}><ReplaceAll className="size-3.5" /> All{count ? ` (${count})` : ""}</Button>
        <Button size="xs" variant="ghost" disabled={!count} onClick={selectCurrent} className="ml-auto">Select</Button>
      </div>
      <p className="px-0.5 text-[11px] leading-relaxed text-muted-foreground">Replacements are tracked when Track changes is on. ⌘↵ in the replace box replaces all.{regex && " Regex groups: use $1 in the replacement."}</p>
    </div>
  );
}
