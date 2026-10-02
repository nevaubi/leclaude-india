"use client";
import * as React from "react";
import { AlertCircle, ClipboardList, Loader2, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEFECT_CATEGORY_LABEL, type DefectCategory, type DefectForum, type DefectNotice } from "../../drafting";
import { errorKind, errorMessage, isAbort, type ApiErrorKind } from "../api";
import { FilePicker } from "../file-picker";
import { Notice, SurfaceState } from "../notice";
import { defectsApi } from "./drafting-api";
import type { DraftingProps } from "./drafting-tab";

type Load = { status: "loading" } | { status: "ready"; notices: DefectNotice[]; ai: boolean } | { status: "error"; message: string; kind: ApiErrorKind };

const FORUMS: { value: DefectForum; label: string }[] = [{ value: "sc", label: "Supreme Court" }, { value: "hc", label: "High Court" }, { value: "nclt", label: "NCLT / NCLAT" }, { value: "other", label: "Other forum" }];
const CATS = Object.keys(DEFECT_CATEGORY_LABEL) as DefectCategory[];

/** Defect cure assistant: a registry's defect notice split into numbered defects, classified into tasks, ticked off. Nothing is filed. */
export function DefectsTool({ setId, aiReady }: DraftingProps) {
  const [load, setLoad] = React.useState<Load>({ status: "loading" });
  const [reload, setReload] = React.useState(0);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [text, setText] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [forum, setForum] = React.useState<DefectForum>("sc");
  const [fileId, setFileId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const ctrl = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => ctrl.current?.abort(), []);

  React.useEffect(() => {
    const ac = new AbortController();
    defectsApi.list(setId, ac.signal)
      .then((r) => { setLoad({ status: "ready", notices: r.notices, ai: r.ai }); setActiveId((id) => id ?? r.notices[0]?.id ?? null); })
      .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorMessage(e), kind: errorKind(e) }); });
    return () => ac.abort();
  }, [setId, reload]);

  const notices = load.status === "ready" ? load.notices : [];
  const active = notices.find((n) => n.id === activeId) ?? null;
  const replace = (n: DefectNotice) => setLoad((l) => (l.status === "ready" ? { ...l, notices: l.notices.some((x) => x.id === n.id) ? l.notices.map((x) => (x.id === n.id ? n : x)) : [n, ...l.notices] } : l));

  const create = async () => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setBusy(true);
    try {
      const { notice } = await defectsApi.create(setId, { title: title.trim() || undefined, forum, ...(text.trim() ? { text } : fileId ? { fileId } : {}) }, ac.signal);
      replace(notice); setActiveId(notice.id); setText(""); setTitle(""); setFileId(null);
    } catch (e) { if (!isAbort(e)) toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const update = async (n: DefectNotice, defectId: string, patch: { done?: boolean; category?: string; task?: string; fix?: string }) => {
    try { replace((await defectsApi.update(setId, { noticeId: n.id, version: n.version, defectId, ...patch })).notice); }
    catch (e) { if (errorKind(e) === "conflict") { toast.error("This checklist changed elsewhere. Reloaded."); setReload((x) => x + 1); } else toast.error(errorMessage(e)); }
  };
  const remove = async (n: DefectNotice) => {
    try { await defectsApi.remove(setId, n.id); setLoad((l) => (l.status === "ready" ? { ...l, notices: l.notices.filter((x) => x.id !== n.id) } : l)); setActiveId(null); } catch (e) { toast.error(errorMessage(e)); }
  };

  if (load.status === "loading") return <div className="space-y-2 p-3" aria-busy="true"><div className="h-24 animate-pulse rounded-md bg-muted" /><div className="h-40 animate-pulse rounded-md bg-muted/60" /></div>;
  if (load.status === "error") {
    return load.kind === "denied" ? <SurfaceState icon={ShieldAlert} title="Not found or no access">{load.message}</SurfaceState>
      : <SurfaceState icon={AlertCircle} title="Could not load defect notices" action={<Button size="xs" variant="ghost" onClick={() => setReload((n) => n + 1)}><RotateCcw className="size-3.5" /> Try again</Button>}>{load.message}</SurfaceState>;
  }
  const done = active ? active.defects.filter((d) => d.done).length : 0;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1100px] space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold">Defect cure</h2>
          <span className="text-[11.5px] text-muted-foreground">Registry objections as a checklist. Nothing is filed or sent from here.</span>
        </div>
        <section className="space-y-2 rounded-md border p-3" aria-label="New defect notice">
          <div className="flex flex-wrap items-center gap-2">
            <Input size="xs" className="min-w-[200px] flex-1" placeholder="Title (e.g. Diary No. 1234/2026 — defects)" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Notice title" />
            <Select value={forum} onValueChange={(v) => setForum(v as DefectForum)}>
              <SelectTrigger size="xs" className="w-[150px]" aria-label="Forum"><SelectValue /></SelectTrigger>
              <SelectContent>{FORUMS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Paste the defect notice, e.g.\n1. Deficit court fee of Rs. 250.\n2. Vakalatnama not signed by the advocate on record.\n3. Annexure P-4 is not legible."} className="text-[12.5px]" aria-label="Defect notice text" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] text-muted-foreground">or read it from a file in this set:</span>
            <FilePicker setId={setId} value={fileId ? [fileId] : []} onChange={(ids) => setFileId(ids[0] ?? null)} placeholder="Choose the notice file" />
            <Button size="xs" className="ms-auto" disabled={busy || (!text.trim() && !fileId)} onClick={() => void create()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardList className="size-3.5" />} Split into defects</Button>
          </div>
          {(load.ai === false || aiReady === false) && <p className="text-[11.5px] text-muted-foreground">AI is not configured: defects are sorted by keyword rules only, without suggested fixes.</p>}
        </section>

        {notices.length === 0 ? (
          <SurfaceState icon={ClipboardList} title="No defect notices yet">Paste a registry’s defect list to turn it into a checklist with a suggested cure for each item.</SurfaceState>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
            <ul className="space-y-0.5" aria-label="Defect notices">
              {notices.map((n) => {
                const d = n.defects.filter((x) => x.done).length;
                return (
                  <li key={n.id}>
                    <button type="button" onClick={() => setActiveId(n.id)} className={cn("w-full rounded-md px-2 py-1.5 text-left", n.id === activeId ? "bg-accent" : "hover:bg-accent/60")}>
                      <div className="truncate text-[12.5px] font-medium">{n.title}</div>
                      <div className="text-[11px] tabular text-muted-foreground">{FORUMS.find((f) => f.value === n.forum)?.label} · {d}/{n.defects.length} done</div>
                    </button>
                  </li>
                );
              })}
            </ul>
            {active ? (
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] font-medium">{active.title}</span>
                  <span className="text-[11.5px] tabular text-muted-foreground">{done} of {active.defects.length} cured</span>
                  <Button size="icon-xs" variant="ghost" className="ms-auto" aria-label="Delete this notice" onClick={() => void remove(active)}><Trash2 className="size-3.5" /></Button>
                </div>
                <Progress value={active.defects.length ? (done / active.defects.length) * 100 : 0} className="h-1" aria-label="Cured" />
                {!active.aiClassified && <Notice>Sorted by keyword rules only (AI classification did not run). Check each category.</Notice>}
                <ol className="divide-y rounded-md border">
                  {active.defects.map((d) => (
                    <li key={d.id} className={cn("grid gap-2 px-3 py-2 sm:grid-cols-[24px_minmax(0,1fr)_196px]", d.done && "bg-surface-quiet")}>
                      <Checkbox size="sm" className="mt-0.5" checked={d.done} onCheckedChange={(v) => void update(active, d.id, { done: v === true })} aria-label={`Defect ${d.n} cured`} />
                      <div className="min-w-0 space-y-0.5">
                        <div className={cn("text-[12.5px] leading-snug", d.done && "text-muted-foreground line-through decoration-muted-foreground/40")}><span className="me-1 font-medium tabular">{d.n}.</span>{d.text}</div>
                        {d.task && <div className="text-[12px]"><span className="font-medium">Task:</span> {d.task}</div>}
                        {d.fix && <div className="text-[11.5px] text-muted-foreground">Suggested cure: {d.fix}</div>}
                        {d.done && d.doneBy && <div className="text-[11px] text-muted-foreground">Marked cured by {d.doneBy}{d.doneAt ? ` · ${new Date(d.doneAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}</div>}
                      </div>
                      <div className="space-y-0.5">
                        <Select value={d.category} onValueChange={(v) => void update(active, d.id, { category: v })}>
                          <SelectTrigger size="xs" aria-label={`Category of defect ${d.n}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{CATS.map((c) => <SelectItem key={c} value={c}>{DEFECT_CATEGORY_LABEL[c]}</SelectItem>)}</SelectContent>
                        </Select>
                        <div className="text-[10.5px] text-muted-foreground">{d.classifiedBy === "ai" ? "Classified by AI" : d.classifiedBy === "user" ? "Set by hand" : "Keyword rule"}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ) : <SurfaceState title="Choose a notice" />}
          </div>
        )}
      </div>
    </div>
  );
}
