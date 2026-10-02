"use client";
import * as React from "react";
import { AlertCircle, CheckCircle2, FileText, Loader2, MessageSquareReply, RotateCcw, ShieldAlert, ShieldCheck, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { exportBlockers, STANCE_LABEL, STANCES, writtenStatementMarkdown, type ParaReply, type ReplyStance } from "../../drafting";
import { errorKind, errorMessage, isAbort, UNCONFIGURED_MESSAGE, type ApiErrorKind } from "../api";
import { FilePicker } from "../file-picker";
import { Notice, SurfaceState } from "../notice";
import { parawiseApi, saveToWord, type ParawiseView } from "./drafting-api";
import type { DraftingProps } from "./drafting-tab";

type Load = { status: "idle" } | { status: "loading" } | { status: "ready"; view: ParawiseView } | { status: "error"; message: string; kind: ApiErrorKind };

const STANCE_TONE: Record<ReplyStance, string> = {
  admitted: "text-warning-foreground dark:text-warning",
  denied: "text-foreground",
  not_admitted: "text-foreground",
  matter_of_record: "text-muted-foreground",
  legal_submission: "text-muted-foreground",
  no_reply: "text-muted-foreground",
};

/** Para-wise reply: numbered paragraphs found in code, AI-proposed responses with checked quotes, admissions approved by a person. */
export function ReplyTool({ setId, setName, matterId, aiReady, fileCount, onView }: DraftingProps) {
  const [fileId, setFileId] = React.useState<string | null>(null);
  const [load, setLoad] = React.useState<Load>({ status: "idle" });
  const [reload, setReload] = React.useState(0);
  const [run, setRun] = React.useState<{ running: boolean; done: number; total: number; failed: number } | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const ctrl = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => ctrl.current?.abort(), []);

  React.useEffect(() => {
    if (!fileId) { setLoad({ status: "idle" }); return; }
    const ac = new AbortController();
    setLoad((l) => (l.status === "ready" && l.view.file.id === fileId ? l : { status: "loading" }));
    parawiseApi.get(setId, fileId, ac.signal)
      .then((view) => setLoad({ status: "ready", view }))
      .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorMessage(e), kind: errorKind(e) }); });
    return () => ac.abort();
  }, [setId, fileId, reload]);

  const view = load.status === "ready" ? load.view : null;
  const state = view?.state ?? null;
  const set = (v: ParawiseView) => setLoad({ status: "ready", view: v });
  const fail = (e: unknown) => {
    if (isAbort(e)) return;
    if (errorKind(e) === "conflict") { toast.error("This reply changed elsewhere. Reloaded the latest version."); setReload((n) => n + 1); return; }
    toast.error(errorKind(e) === "unconfigured" ? UNCONFIGURED_MESSAGE : errorMessage(e));
  };

  const start = async (restart = false) => { if (!fileId) return; try { set(await parawiseApi.start(setId, fileId, restart)); setDrafts({}); } catch (e) { fail(e); } };

  const propose = async (ns?: string[]) => {
    if (!fileId || !state) return;
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    let version = state.version;
    const total = ns?.length ?? state.paras.filter((p) => p.status !== "proposed").length;
    const acc = { running: true, done: 0, total, failed: 0 };
    setRun({ ...acc });
    try {
      let lastRemaining = Infinity;
      for (let guard = 0; guard < 40; guard++) {
        const r = await parawiseApi.propose(setId, fileId, version, ac.signal, ns);
        set(r);
        version = r.state!.version;
        acc.failed = r.failed;
        acc.done = ns ? total : total - r.remaining;
        setRun({ ...acc });
        // Stop when done, for a targeted retry, or when a call made no progress (failures are not retried in a loop).
        if (ns || r.remaining === 0 || r.remaining >= lastRemaining) break;
        lastRemaining = r.remaining;
      }
    } catch (e) { fail(e); } finally { setRun((x) => (x ? { ...x, running: false } : x)); ctrl.current = null; }
  };

  const update = async (p: ParaReply, patch: { stance?: string; reply?: string; approve?: boolean }) => {
    if (!fileId || !state) return;
    try { set(await parawiseApi.update(setId, { fileId, version: state.version, n: p.n, ...patch })); } catch (e) { fail(e); }
  };

  const blockers = state ? exportBlockers(state.paras) : null;
  const exportWord = async () => {
    if (!state) return;
    try {
      const md = writtenStatementMarkdown(state, { pleading: /petition/i.test(state.fileName) ? "petition" : "plaint" });
      await saveToWord({ title: `Written statement (para-wise reply) — ${setName}`, markdown: md, matterId, source: "documents.parawise", tags: ["written statement", "para-wise reply"] });
    } catch (e) { toast.error((e as Error).message); }
  };

  if (fileCount === 0) return <SurfaceState icon={MessageSquareReply} title="No files yet">Add the plaint or petition (and the documents that answer it) in the Files tab.</SurfaceState>;
  const counts = state ? { admitted: state.paras.filter((p) => p.stance === "admitted").length, approved: state.paras.filter((p) => p.stance === "admitted" && p.approved).length, proposed: state.paras.filter((p) => p.status === "proposed").length } : null;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1100px] space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold">Para-wise reply</h2>
          <FilePicker setId={setId} value={fileId ? [fileId] : []} onChange={(ids) => setFileId(ids[0] ?? null)} placeholder="Choose the plaint or petition" />
          {state && (
            <div className="ms-auto flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={() => void start(true)} title="Detect paragraphs again (discards replies)"><RotateCcw className="size-3.5" /> Restart</Button>
              <Button size="xs" variant="outline" disabled={!!blockers || !state.paras.length} onClick={() => void exportWord()} title={blockers ? "Approve every admission first" : undefined}><FileText className="size-3.5" /> Written statement to Word</Button>
            </div>
          )}
        </div>

        {load.status === "idle" && <SurfaceState icon={MessageSquareReply} title="Choose the pleading to answer">Its numbered paragraphs are found in code (lines starting “1.”, “2.” …). Each gets a proposed response tied to the other documents in this set; every admission waits for your approval.</SurfaceState>}
        {load.status === "loading" && <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground" aria-busy="true"><Loader2 className="size-4 animate-spin" /> Loading…</div>}
        {load.status === "error" && (load.kind === "denied" ? <SurfaceState icon={ShieldAlert} title="Not found or no access">{load.message}</SurfaceState> : <SurfaceState icon={AlertCircle} title="Could not load" action={<Button size="xs" variant="ghost" onClick={() => setReload((n) => n + 1)}><RotateCcw className="size-3.5" /> Try again</Button>}>{load.message}</SurfaceState>)}

        {view && !state && (
          <SurfaceState icon={MessageSquareReply} title={view.paragraphs ? `${view.paragraphs} numbered paragraph${view.paragraphs === 1 ? "" : "s"} found` : "No numbered paragraphs found"} action={view.paragraphs ? <Button size="sm" onClick={() => void start()}>Start the reply</Button> : undefined}>
            {view.paragraphs ? `in ${view.file.name}.` : `${view.file.name} has no lines starting “1.”, “2.” … Choose the plaint or petition, or check its text in the Files tab.`}
          </SurfaceState>
        )}

        {state && (
          <>
            {view?.stale && <Notice tone="warning" action={<Button size="xs" variant="ghost" onClick={() => void start(true)}>Restart</Button>}>The pleading’s text changed since its paragraphs were detected. Restart to detect them again.</Notice>}
            {aiReady === false && <Notice tone="warning">{UNCONFIGURED_MESSAGE} You can still write the replies by hand.</Notice>}
            <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[12px]">
              <span className="tabular text-muted-foreground">{state.paras.length} paragraphs · {counts!.proposed} proposed · {counts!.admitted} admission{counts!.admitted === 1 ? "" : "s"} ({counts!.approved} approved)</span>
              <div className="ms-auto flex items-center gap-1">
                {run?.running && <Button size="xs" variant="ghost" onClick={() => ctrl.current?.abort()}><X className="size-3.5" /> Cancel</Button>}
                <Button size="xs" disabled={aiReady === false || !!run?.running || counts!.proposed === state.paras.length} onClick={() => void propose()}>{run?.running ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Propose replies</Button>
              </div>
              {run && (run.running || run.failed > 0) && <div className="basis-full"><Progress value={run.total ? (run.done / run.total) * 100 : 100} className="h-1" aria-label="Proposal progress" />{run.failed > 0 && <p className="mt-1 text-destructive">{run.failed} paragraph{run.failed === 1 ? "" : "s"} could not be proposed; retry them individually.</p>}</div>}
            </div>
            {blockers && <Notice tone="warning">Admissions bind the client. Approve each one (paragraph {blockers.unapprovedAdmissions.join(", ")}) before exporting the written statement.</Notice>}
            <ol className="space-y-2">
              {state.paras.map((p) => {
                const draft = drafts[p.n] ?? p.reply;
                return (
                  <li key={p.n} className="rounded-md border">
                    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                      <div className="min-w-0">
                        <div className="mb-1 flex items-center gap-2 text-[11.5px] text-muted-foreground"><span className="font-semibold text-foreground">¶ {p.n}</span>{p.page != null && <button type="button" className="hover:text-foreground hover:underline" onClick={() => onView({ fileId: state.fileId, page: p.page, name: state.fileName })}>p. {p.page}</button>}</div>
                        <p className="line-clamp-6 whitespace-pre-wrap font-serif text-[13px] leading-relaxed" title={p.paraText}>{p.paraText}</p>
                      </div>
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Select value={p.stance} onValueChange={(v) => void update(p, { stance: v })}>
                            <SelectTrigger size="xs" className={cn("w-[170px]", STANCE_TONE[p.stance])} aria-label={`Response to paragraph ${p.n}`}><SelectValue /></SelectTrigger>
                            <SelectContent>{STANCES.map((s) => <SelectItem key={s} value={s}>{STANCE_LABEL[s]}</SelectItem>)}</SelectContent>
                          </Select>
                          {p.status === "failed" && <span className="text-[11.5px] text-destructive" title={p.error ?? undefined}>Proposal failed</span>}
                          {p.status === "pending" && <span className="text-[11.5px] text-muted-foreground">Not proposed yet</span>}
                          {p.edited && <span className="text-[11.5px] text-muted-foreground">Edited</span>}
                          {p.stance === "admitted" && (p.approved
                            ? <span className="ms-auto inline-flex items-center gap-1 text-[11.5px] text-muted-foreground"><ShieldCheck className="size-3.5" /> Approved by {p.approvedBy}<Button size="xs" variant="ghost" onClick={() => void update(p, { approve: false })}>Withdraw</Button></span>
                            : <Button size="xs" variant="outline" className="ms-auto" onClick={() => void update(p, { approve: true })}><CheckCircle2 className="size-3.5" /> Approve admission</Button>)}
                          {(p.status !== "proposed" || p.error) && aiReady !== false && <Button size="xs" variant="ghost" disabled={!!run?.running} onClick={() => void propose([p.n])}><Sparkles className="size-3.5" /> Propose</Button>}
                        </div>
                        <Textarea rows={2} value={draft} placeholder="Reply text after the opening words (optional)" onChange={(e) => setDrafts((d) => ({ ...d, [p.n]: e.target.value }))} onBlur={() => { if (draft !== p.reply) void update(p, { reply: draft }).then(() => setDrafts((d) => { const n = { ...d }; delete n[p.n]; return n; })); }} className="text-[12.5px]" aria-label={`Reply to paragraph ${p.n}`} />
                        {p.proposed && (
                          <div className="space-y-1 rounded-sm bg-surface-quiet px-2 py-1.5 text-[11.5px] leading-snug">
                            <div className="text-muted-foreground"><span className="font-medium text-foreground">Proposed: {STANCE_LABEL[p.proposed.stance]}.</span> {p.proposed.reasoning}</div>
                            {p.proposed.evidence.map((ev, k) => (
                              <div key={k}>
                                <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => onView({ fileId: ev.fileId, page: ev.page, highlight: ev.quote, name: ev.fileName })}>{ev.fileName}{ev.page != null ? ` · p. ${ev.page}` : ""}</button>
                                <span className="italic text-muted-foreground"> “{ev.quote}”</span>
                                {!ev.quoteFound && <span className="ms-1 whitespace-nowrap rounded-sm border border-dashed border-warning/60 px-1 text-[10.5px] font-medium text-warning-foreground dark:text-warning">quote not found in text</span>}
                              </div>
                            ))}
                            {p.proposed.evidence.length === 0 && <div className="text-muted-foreground">No supporting passage cited.</div>}
                            {p.proposed.droppedRefs > 0 && <div className="text-warning-foreground dark:text-warning">{p.proposed.droppedRefs} citation{p.proposed.droppedRefs === 1 ? "" : "s"} to passages that were not supplied were dropped.</div>}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
