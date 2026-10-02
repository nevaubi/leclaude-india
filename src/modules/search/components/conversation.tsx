"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Bookmark, Check, ChevronRight, Copy, FileDown, FileText, ListTree, Loader2, Lock, Pin, RotateCcw, Scale, ShieldCheck, Square } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { PersonAvatar } from "@/components/ui/avatar";
import { NotSourceBackedBanner, TrustStateBadge } from "@/components/ai/trust-badge";
import { AssistantMark } from "@/components/ai/chat";
import { FAILURE_LABEL, STOP_LABEL, TERMINAL_LABEL, type RunMetrics, type RunTerminalState } from "@/lib/ai/events";
import { buildResearchMemo, buildTableOfAuthorities, memoTitle } from "../memo";
import type { CitationCrossCheck, ResearchMessage, ResearchSource } from "../engine/types";
import { AUTHORITY_STATUS_LABEL, type AuthorityStatus, type AuthorityStatusTable } from "../engine/authority-status";
import { annotateAnswer, citationCounts, isMessageVerificationCurrent, messageTrustState } from "../engine/trust";
import type { LaneView, ResearchError, ResearchState } from "./use-research";
import { ActivityStrip } from "./activity-strip";
import { AnswerMarkdown } from "./answer-markdown";
import { NoKeyCard } from "./no-key-card";
import { useResearchActions } from "./research-context";

export interface ConversationProps {
  state: ResearchState;
  sources: ResearchSource[];
  userName: string;
  matter: { id: string; shortName: string; name: string; caption?: string } | null;
  aiConfigured: boolean;
  onSaveSearch: (name: string) => Promise<void>;
  onStop: () => void;
  onRetry: (question: string) => void;
  onNewThread: () => void;
  emptyState: React.ReactNode;
}

export function Conversation({ state, sources, userName, matter, aiConfigured, onSaveSearch, onStop, onRetry, onNewThread, emptyState }: ConversationProps) {
  const endRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [stick, setStick] = React.useState(true);
  const turns = React.useMemo(() => pairTurns(state.messages), [state.messages]);
  React.useEffect(() => { if (stick) endRef.current?.scrollIntoView({ block: "end" }); }, [state.pending?.text, state.pending?.stage, state.messages.length, stick]);

  if (state.denied && !state.pending) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-[760px] px-6 py-10">
          <DeniedCard error={state.denied} onNewThread={onNewThread} />
        </div>
      </div>
    );
  }

  if (!turns.length && !state.pending) return <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{emptyState}</div>;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" onScroll={(e) => { const el = e.currentTarget; setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 120); }}>
      <div className="mx-auto w-full max-w-[760px] px-6 pb-8 pt-6">
        {state.stale && (
          <div role="status" className="mb-4 flex items-start gap-2 rounded-md border border-warning/50 px-3 py-2 font-sans text-xs" data-state="stale">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-warning-foreground dark:text-warning" />
            <div><span className="font-semibold">Thread changed.</span> {state.stale}</div>
          </div>
        )}
        {turns.map((t) => (
          <Turn key={t.assistant.id} threadId={state.threadId} question={t.user.content} message={t.assistant} sources={sources} userName={userName} matter={matter} aiConfigured={aiConfigured} onSaveSearch={onSaveSearch} onRetry={onRetry} />
        ))}
        {state.pending && <PendingTurn pending={state.pending} lanes={state.laneOrder.map((id) => state.lanes[id]).filter(Boolean)} sources={sources} userName={userName} error={state.error} denied={state.denied} aiConfigured={aiConfigured} onStop={onStop} onRetry={onRetry} onNewThread={onNewThread} />}
        <div ref={endRef} className="h-2" />
      </div>
    </div>
  );
}

function pairTurns(messages: ResearchMessage[]) {
  const out: { user: ResearchMessage; assistant: ResearchMessage }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") {
      const prev = messages[i - 1];
      out.push({ user: prev?.role === "user" ? prev : { id: `q_${m.id}`, role: "user", content: "", createdAt: m.createdAt }, assistant: m });
    }
  }
  return out;
}

function QuestionBubble({ text, userName }: { text: string; userName: string }) {
  if (!text) return null;
  return (
    <div className="mb-5 flex justify-end">
      <div className="flex max-w-[85%] items-start gap-2.5">
        <div className="rounded-md bg-accent/70 px-3.5 py-2 text-[13.5px] leading-relaxed text-foreground whitespace-pre-wrap">{text}</div>
        <PersonAvatar name={userName} size="sm" className="mt-1" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Compact metric summary shown under an answer (constitution §36). */
export function MetricsLine({ metrics }: { metrics: RunMetrics }) {
  const parts = [
    metrics.firstEvidenceMs != null ? `evidence ${fmtMs(metrics.firstEvidenceMs)}` : null,
    metrics.firstModelTokenMs != null ? `first token ${fmtMs(metrics.firstModelTokenMs)}` : null,
    metrics.firstSourceBackedMs != null ? `source-backed ${fmtMs(metrics.firstSourceBackedMs)}` : null,
    metrics.finalAnswerMs != null ? `answer ${fmtMs(metrics.finalAnswerMs)}` : null,
    metrics.verifiedAnswerMs != null ? `verified ${fmtMs(metrics.verifiedAnswerMs)}` : null,
    metrics.tokens.total > 0 ? `${fmtTokens(metrics.tokens.total)} tokens` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  const tip = (
    <div className="space-y-0.5 text-[11px] tabular">
      <div>Request → acknowledged: {fmtMs(metrics.acknowledgedMs)}</div>
      <div>→ first evidence: {fmtMs(metrics.firstEvidenceMs)} · first read: {fmtMs(metrics.firstReadMs)}</div>
      <div>→ first model token: {fmtMs(metrics.firstModelTokenMs)} · first source-backed statement: {fmtMs(metrics.firstSourceBackedMs)}</div>
      <div>→ final answer: {fmtMs(metrics.finalAnswerMs)} · verified final answer: {fmtMs(metrics.verifiedAnswerMs)}</div>
      <div>Total {fmtMs(metrics.totalMs)} · tool time {fmtMs(metrics.toolTimeMs)} ({metrics.toolCalls} calls) · model time {fmtMs(metrics.modelTimeMs)} ({metrics.modelCalls} calls){metrics.queueWaitMs ? ` · queue wait ${fmtMs(metrics.queueWaitMs)}` : ""}</div>
      <div>Tokens {metrics.tokens.total.toLocaleString()} ({metrics.tokens.input.toLocaleString()} in / {metrics.tokens.output.toLocaleString()} out; {metrics.tokens.reportedCalls} of {metrics.modelCalls} calls reported usage)</div>
    </div>
  );
  return <Tip label={tip}><span className="cursor-help tabular text-[10.5px] text-muted-foreground" data-metrics>{parts.join(" · ")}</span></Tip>;
}

const OUTCOME_TONE: Record<RunTerminalState, string> = {
  succeeded: "border-border",
  partial: "border-warning/50",
  budget_exhausted: "border-warning/50",
  verification_failed: "border-destructive/40",
  cancelled: "border-border",
  failed: "border-destructive/40",
};

/** Explicit outcome for a persisted turn that did not fully succeed (constitution §14, §34, §35). */
function OutcomeNotice({ message, onRetry, question }: { message: ResearchMessage; onRetry: (q: string) => void; question: string }) {
  const t = message.terminal;
  if (!t || t === "succeeded") return null;
  const failedLanes = (message.lanes ?? []).filter((l) => l.status === "error" || l.status === "timeout" || l.status === "skipped" || (l.status === "done" && l.error));
  const gaps = message.coverage && !message.coverage.complete ? message.coverage.gaps : [];
  const Icon = t === "cancelled" ? Square : t === "failed" || t === "verification_failed" ? AlertCircle : ShieldCheck;
  return (
    <div role="status" data-outcome={t} className={cn("mb-3 rounded-md border px-3 py-2 font-sans text-xs", OUTCOME_TONE[t])}>
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", t === "failed" || t === "verification_failed" ? "text-destructive" : t === "cancelled" ? "text-muted-foreground" : "text-warning-foreground dark:text-warning")} />
        <div className="min-w-0 flex-1 space-y-1">
          <div>
            <span className="font-semibold">{TERMINAL_LABEL[t]}.</span>{" "}
            <span>{message.failureMessage ?? (message.failure ? FAILURE_LABEL[message.failure] : "")}</span>
            {message.stop && <span className="text-muted-foreground"> · stopped: {STOP_LABEL[message.stop]}</span>}
          </div>
          {failedLanes.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {failedLanes.map((l) => <li key={l.id} className="truncate" title={l.error}>{l.name}: {l.status === "timeout" ? "timed out" : l.status === "skipped" ? "skipped" : l.status === "error" ? "failed" : "partial failure"}{l.error ? ` — ${l.error}` : ""}</li>)}
            </ul>
          )}
          {gaps.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground/80">Coverage gaps ({gaps.length}):</span> {gaps.slice(0, 4).join("; ")}{gaps.length > 4 ? "…" : ""}
            </div>
          )}
        </div>
        {(t === "failed" || t === "cancelled") && <Button size="xs" variant="outline" onClick={() => onRetry(question)}><RotateCcw className="size-3" /> Retry</Button>}
      </div>
    </div>
  );
}

/** Citation cross-check results: unresolved citations are always visible, never folded away (constitution §34). */
function CitationsStrip({ checks }: { checks: CitationCrossCheck[] }) {
  const [open, setOpen] = React.useState(false);
  const counts = citationCounts(checks);
  const flagged = checks.filter((c) => (c.state ?? (c.matched ? "resolved" : "unresolved")) !== "resolved");
  const resolved = checks.filter((c) => (c.state ?? (c.matched ? "resolved" : "unresolved")) === "resolved");
  if (!checks.length) return null;
  return (
    <div className="mt-3 rounded-md border bg-muted/30 font-sans text-xs" data-citations>
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5">
        <span className="text-muted-foreground">Citations</span>
        <Badge variant="info" size="sm">{counts.resolved} resolved</Badge>
        {counts.requiresReview > 0 && <Badge variant="warning" size="sm">{counts.requiresReview} need review</Badge>}
        {counts.unresolved > 0 && <Badge variant="destructive" size="sm">{counts.unresolved} unresolved</Badge>}
        <div className="flex-1" />
        {resolved.length > 0 && <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground cursor-pointer"><ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />{open ? "Hide resolved" : "Show resolved"}</button>}
      </div>
      {(flagged.length > 0 || open) && (
        <ul className="divide-y border-t">
          {flagged.map((c) => <CitationRow key={c.citation} c={c} />)}
          {open && resolved.map((c) => <CitationRow key={c.citation} c={c} />)}
        </ul>
      )}
    </div>
  );
}

const AUTHORITY_BADGE: Record<AuthorityStatus, "info" | "muted" | "warning" | "destructive"> = { supported: "info", read: "muted", found: "muted", text_not_available: "warning", unresolved: "destructive" };
const AUTHORITY_ORDER: AuthorityStatus[] = ["unresolved", "text_not_available", "found", "read", "supported"];

/**
 * Authority status (constitution §23, §34): every authority the answer relies on, with what was established for it —
 * found, read, supported by its text, unresolved or text not available. Problems are shown by default.
 */
function AuthorityStatusStrip({ table, message, sources }: { table: AuthorityStatusTable; message: ResearchMessage; sources: ResearchSource[] }) {
  const a = useResearchActions();
  const flagged = table.rows.filter((r) => r.status === "unresolved" || r.status === "text_not_available");
  const [open, setOpen] = React.useState(flagged.length > 0);
  const rows = [...table.rows].sort((x, y) => AUTHORITY_ORDER.indexOf(x.status) - AUTHORITY_ORDER.indexOf(y.status) || (x.sourceN ?? 999) - (y.sourceN ?? 999));
  const byN = (n?: number) => { const id = n == null ? undefined : message.citeMap?.[n]; return id ? sources.find((s) => s.id === id) : undefined; };
  return (
    <div className="mt-3 rounded-md border bg-muted/30 font-sans text-xs" data-authorities>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-1.5 px-2.5 py-1.5 text-left cursor-pointer" aria-expanded={open}>
        <Scale className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Authorities</span>
        {AUTHORITY_ORDER.slice().reverse().filter((k) => table.counts[k] > 0).map((k) => <Badge key={k} variant={AUTHORITY_BADGE[k]} size="sm">{table.counts[k]} {AUTHORITY_STATUS_LABEL[k].toLowerCase()}</Badge>)}
        <div className="flex-1" />
        <span className="text-[10.5px] text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <ul className="divide-y border-t">
          {rows.map((r, i) => {
            const src = byN(r.sourceN);
            return (
              <li key={`${r.authority}-${i}`} className="flex items-start gap-2 px-2.5 py-1.5" data-authority-status={r.status}>
                <Badge variant={AUTHORITY_BADGE[r.status]} size="xs" className="mt-0.5 shrink-0">{AUTHORITY_STATUS_LABEL[r.status]}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-foreground/90" title={r.authority}>
                    {r.sourceN != null && (src ? <button onClick={() => a.openSource(src)} className="mr-1 tabular text-primary hover:underline cursor-pointer">[{r.sourceN}]</button> : <span className="mr-1 tabular text-primary">[{r.sourceN}]</span>)}
                    {r.authority}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{r.note}{r.citedBy != null ? ` · cited by ${r.citedBy}${r.citedBy >= 25 ? "+" : ""} judgment${r.citedBy === 1 ? "" : "s"} in the text corpus` : ""}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The deterministic IPC/BNS, CrPC/BNSS transition note (coded savings provisions), shown with the answer. */
function TransitionStrip({ transition }: { transition: NonNullable<ResearchMessage["transition"]> }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mt-3 rounded-md border bg-muted/30 font-sans text-xs" data-transition>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground cursor-pointer" aria-expanded={open}>
        <Scale className="size-3.5" />
        <span className="flex-1">Transition law · offence: <span className="text-foreground">{transition.substantive === "requires_review" ? "date needed" : transition.substantive}</span> · procedure: <span className="text-foreground">{transition.procedure === "requires_review" ? "date needed" : transition.procedure}</span></span>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-1 border-t px-2.5 py-1.5 text-[11.5px] text-foreground/85">
          {transition.lines.map((l) => <p key={l}>{l}</p>)}
          <p className="text-[10.5px] text-muted-foreground">{transition.source}</p>
        </div>
      )}
    </div>
  );
}

function CitationRow({ c }: { c: CitationCrossCheck }) {
  const state = c.state ?? (c.matched ? "resolved" : c.sourceN != null || c.resolvedRemotely ? "requires_review" : "unresolved");
  const reason = state === "resolved" ? `Read source [${c.sourceN}]` : c.sourceN != null ? `Source [${c.sourceN}] was found but not read` : c.resolvedRemotely ? "Resolves on CourtListener; not read in this run" : "Not among the sources read in this run";
  return (
    <li className="flex items-center gap-2 px-2.5 py-1.5">
      {state === "unresolved" ? <TrustStateBadge state="unresolved" size="xs" /> : state === "requires_review" ? <Badge variant="warning" size="xs">Needs review</Badge> : <Badge variant="info" size="xs">Resolved</Badge>}
      <span className="font-mono text-[11.5px] text-foreground">{c.citation}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={reason}>{reason}</span>
    </li>
  );
}

function StatusLine({ message, sources, live }: { message: ResearchMessage; sources: ResearchSource[]; live?: boolean }) {
  const s = message.stats;
  const v = message.verification;
  const current = isMessageVerificationCurrent(message);
  const trust = message.content ? messageTrustState(message, sources) : "generated";
  const lanes = message.lanes?.length ?? 0;
  const parts = [
    s ? `${s.sources} source${s.sources === 1 ? "" : "s"}` : null,
    s?.read ? `${s.read} read` : null,
    s ? `${s.rounds} round${s.rounds === 1 ? "" : "s"}` : null,
    lanes ? `${lanes} lane${lanes === 1 ? "" : "s"}` : null,
    v && current && (v.supported + v.unsupported + v.contradicted) > 0 ? `${v.supported}/${v.supported + v.unsupported + v.contradicted} claims supported` : null,
    s ? fmtMs(s.durationMs) : null,
  ].filter(Boolean);
  return (
    <div className="mt-3 space-y-1 font-sans text-[11.5px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {live && <Loader2 className="size-3 animate-spin" />}
        {message.mode === "fast" ? (
          <Tip label="Fast mode: one lane, one pass over the providers, at most two sources read. An orientation, not a source-reviewed answer."><Badge variant="warning" size="sm" className="cursor-help" data-mode="fast">Fast · orientation</Badge></Tip>
        ) : message.mode === "deep" ? (
          <Tip label={`Deep research: ${lanes || "several"} parallel lanes, up to 3 rounds, claims checked against the sources read.`}><Badge variant="muted" size="sm" className="cursor-help" data-mode="deep">Deep</Badge></Tip>
        ) : null}
        {message.content && <TrustStateBadge state={trust} detail={v && !current ? "The verdicts on file are for an earlier draft; the shown text was not re-verified." : undefined} />}
        {v && !current && message.content && <TrustStateBadge state="stale" compact />}
        <span className="tabular">{parts.join(" · ")}</span>
      </div>
      {message.metrics && <MetricsLine metrics={message.metrics} />}
    </div>
  );
}

function Turn({ threadId, question, message, sources, userName, matter, aiConfigured, onSaveSearch, onRetry }: { threadId: string | null; question: string; message: ResearchMessage; sources: ResearchSource[]; userName: string; matter: ConversationProps["matter"]; aiConfigured: boolean; onSaveSearch: (name: string) => Promise<void>; onRetry: (q: string) => void }) {
  const a = useResearchActions();
  const router = useRouter();
  const [copied, setCopied] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveName, setSaveName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [wording, setWording] = React.useState(false);
  const cited = React.useMemo(() => sources.filter((s) => s.n != null && message.citeMap && message.citeMap[s.n] === s.id).sort((x, y) => (x.n ?? 0) - (y.n ?? 0)), [sources, message.citeMap]);
  const shown = React.useMemo(() => annotateAnswer(message, sources), [message, sources]);

  // The memo carries the answer with its [VERIFY] markers, source states, verification flags and a table of authorities.
  const markdown = React.useCallback(() => buildResearchMemo({ question, message, sources, matterName: matter?.name, matterCaption: matter?.caption }), [question, message, sources, matter]);

  const copy = () => navigator.clipboard.writeText(shown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); toast.success("Answer copied"); }).catch(() => toast.error("Clipboard unavailable"));
  const saveFile = (name: string, text: string) => {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url; el.download = `${name.replace(/[^\w\- ]+/g, "").slice(0, 60)}.md`; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const download = () => saveFile(memoTitle(question), markdown());
  const downloadToa = () => saveFile(`Authorities — ${question.slice(0, 40)}`, buildTableOfAuthorities(question, message, sources));
  const toWord = async () => {
    if (!threadId) { toast.error("Save the thread first", { description: "The memo is built from the stored answer." }); return; }
    setWording(true);
    try {
      const res = await fetch(`/api/search/threads/${encodeURIComponent(threadId)}/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "word", messageId: message.id }) });
      const j = (await res.json()) as { doc?: { id: string }; error?: string };
      if (res.status === 403) throw new Error(j.error ?? "You do not have access to this thread's matter.");
      if (!res.ok || !j.doc) throw new Error(j.error ?? res.statusText);
      toast.success("Memo sent to Word", { description: "Question presented, short answer, analysis, contrary authority, open issues, sources and table of authorities." });
      router.push(`/office/word/${j.doc.id}`);
    } catch (e) { toast.error("Could not create the Word document", { description: e instanceof Error ? e.message : String(e) }); } finally { setWording(false); }
  };
  const save = async () => { setSaving(true); try { await onSaveSearch(saveName.trim() || question.slice(0, 80)); setSaveOpen(false); setSaveName(""); } finally { setSaving(false); } };

  const onMouseUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    setSelection(text.length > 12 && text.length < 4000 ? text : "");
  };
  const [selection, setSelection] = React.useState("");

  return (
    <section className="mb-10" data-run={message.runId} data-terminal={message.terminal}>
      <QuestionBubble text={question} userName={userName} />
      <div className="flex items-start gap-3">
        <AssistantMark size="md" className="mt-1" />
        <div className="min-w-0 flex-1">
          {message.banner === "no-api-key" && <NoKeyCard className="mb-3" />}
          {message.banner === "not-source-backed" && <NotSourceBackedBanner className="mb-3" />}
          <OutcomeNotice message={message} onRetry={onRetry} question={question} />
          {message.banner === "no-api-key" && !message.content && cited.length === 0 && sources.length > 0 && (
            <div className="rounded-lg border bg-card p-3 font-sans text-xs text-muted-foreground">The lanes found {sources.length} source{sources.length === 1 ? "" : "s"} (see Sources). Add a model provider key to synthesize an answer from them.</div>
          )}
          {message.content && (
            <div className="relative" onMouseUp={onMouseUp}>
              <AnswerMarkdown text={shown} />
              {selection && (
                <div className="sticky bottom-2 mt-2 flex justify-end">
                  <Button size="xs" variant="outline" className="shadow-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => { a.pinPassage(selection); setSelection(""); window.getSelection()?.removeAllRanges(); }}><Pin className="size-3" /> Pin selected passage</Button>
                </div>
              )}
            </div>
          )}
          {message.subQuestions && message.subQuestions.length > 0 && <PlanLine questions={message.subQuestions} />}
          {message.transition && <TransitionStrip transition={message.transition} />}
          {message.authorities && message.authorities.rows.length > 0 && message.authorities.artifactHash === message.artifactHash && <AuthorityStatusStrip table={message.authorities} message={message} sources={sources} />}
          {message.citations && message.citations.length > 0 && <CitationsStrip checks={message.citations} />}
          {message.verification && message.verification.verdicts && message.verification.verdicts.length > 0 && <VerdictSummary message={message} sources={sources} />}
          <StatusLine message={message} sources={sources} />
          {message.content && (
            <div className="mt-2 flex flex-wrap items-center gap-1 font-sans">
              <Tip label="Copy the answer as markdown"><Button variant="ghost" size="xs" onClick={copy}>{copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />} Copy</Button></Tip>
              <Tip label="Download the research memo (.md): answer, source states, verification flags, table of authorities"><Button variant="ghost" size="xs" onClick={download}><FileDown className="size-3" /> Memo</Button></Tip>
              <Tip label="Download the table of authorities (.md) with the pinpoints the answer uses"><Button variant="ghost" size="xs" onClick={downloadToa}><Scale className="size-3" /> Authorities</Button></Tip>
              <Tip label="Send the memo to Word (built on the server from the stored answer)"><Button variant="ghost" size="xs" onClick={toWord} disabled={wording} data-action="send-to-word">{wording ? <Loader2 className="size-3 animate-spin" /> : <FileText className="size-3" />} Send to Word</Button></Tip>
              <Popover open={saveOpen} onOpenChange={setSaveOpen}>
                <PopoverTrigger asChild><Button variant="ghost" size="xs"><Bookmark className="size-3" /> Save</Button></PopoverTrigger>
                <PopoverContent align="start" className="w-72 space-y-2 p-3">
                  <div className="text-xs font-medium">Save this search</div>
                  <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={question.slice(0, 60)} className="h-8 text-xs" autoFocus onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
                  <div className="text-[11px] text-muted-foreground">Keeps the question, scope, jurisdiction and matter so it can be re-run from the rail.</div>
                  <Button size="sm" className="w-full" onClick={save} disabled={saving}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Bookmark className="size-3.5" />} Save</Button>
                </PopoverContent>
              </Popover>
              {!aiConfigured && <span className="ml-auto text-[11px] text-muted-foreground">AI off</span>}
            </div>
          )}
          {message.followUps && message.followUps.length > 0 && (
            <div className="mt-5 font-sans">
              <div className="mb-1.5 text-[11.5px] font-medium text-muted-foreground">Suggested follow-ups</div>
              <div className="flex flex-wrap gap-1.5">
                {message.followUps.map((q) => (
                  <button key={q} onClick={() => a.askFollowUp(q)} className="group inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-left text-[12px] text-foreground/90 transition-colors hover:border-primary/40 hover:bg-accent cursor-pointer">
                    <span className="truncate">{q}</span><ArrowRight className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function PlanLine({ questions }: { questions: string[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mt-3 font-sans text-xs" data-plan>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground cursor-pointer" aria-expanded={open}>
        <ListTree className="size-3.5" /> Research plan · {questions.length} sub-question{questions.length === 1 ? "" : "s"}
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && <ol className="mt-1 list-decimal space-y-0.5 pl-9 text-[12px] text-foreground/85">{questions.map((q) => <li key={q}>{q}</li>)}</ol>}
    </div>
  );
}

/** Per-claim verification (constitution §34): flagged claims are shown by default; each claim opens its source at the quoted paragraph. */
function VerdictSummary({ message, sources }: { message: ResearchMessage; sources: ResearchSource[] }) {
  const a = useResearchActions();
  const list = message.verification?.verdicts ?? [];
  const flagged = list.filter((v) => v.status !== "supported");
  const [open, setOpen] = React.useState(flagged.length > 0);
  const current = isMessageVerificationCurrent(message);
  if (!list.length) return null;
  // Resolve through this answer's own cite map (older turns number their sources differently).
  const byN = (n: number | null) => { const id = n == null ? undefined : message.citeMap?.[n]; return id ? sources.find((s) => s.id === id) : undefined; };
  return (
    <div className="mt-3 rounded-md border bg-muted/30 font-sans text-xs" data-verdicts data-current={current}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground cursor-pointer" aria-expanded={open}>
        <ShieldCheck className={cn("size-3.5", !current ? "text-muted-foreground" : flagged.length ? "text-warning" : "text-success")} />
        <span className="flex-1">{list.length - flagged.length} of {list.length} claims supported by the sources read{flagged.length ? ` · ${flagged.length} flagged` : ""}{!current ? " · checked against an earlier draft" : ""}</span>
        <span className="text-[10.5px]">{open ? "Hide" : "Show"}</span>
      </button>
      {!current && <div className="border-t px-2.5 py-1.5 text-[11px] text-warning-foreground dark:text-warning">These verdicts were computed for an earlier version of the answer. The text shown was revised afterwards and was not re-verified, so they are not current.</div>}
      {open && (
        <ul className="divide-y border-t">
          {[...flagged, ...list.filter((v) => v.status === "supported")].map((v, i) => {
            const src = byN(v.sourceN);
            return (
              <li key={i} className="flex items-start gap-2 px-2.5 py-1.5" data-claim-status={v.status}>
                <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", v.status === "supported" ? "bg-success" : v.status === "contradicted" ? "bg-destructive" : "bg-warning")} />
                <div className="min-w-0 flex-1">
                  <div className="text-foreground/90">{v.claim}{v.sourceN != null && (src ? <button onClick={() => a.openSource(src, { paragraph: v.paragraph, quote: v.quoteVerified !== false ? v.quote : undefined })} className="ml-1 tabular text-primary hover:underline cursor-pointer" title={`Open source [${v.sourceN}]${v.paragraph ? ` at ¶${v.paragraph}` : ""}`}>[{v.sourceN}{v.paragraph ? ` ¶${v.paragraph}` : ""}]</button> : <span className="ml-1 tabular text-primary">[{v.sourceN}]</span>)}</div>
                  {v.quote && <div className="mt-0.5 flex min-w-0 items-center gap-1.5"><span className="truncate font-serif italic text-muted-foreground" title={v.quote}>“{v.quote}”</span>{v.quoteVerified === true && <Badge variant="info" size="xs" className="shrink-0">Quote found in text</Badge>}{v.quoteVerified === false && <Badge variant="destructive" size="xs" className="shrink-0">Quote not in source</Badge>}</div>}
                  {v.note && <div className="mt-0.5 text-[11px] text-muted-foreground">{v.note}</div>}
                </div>
                <span className={cn("shrink-0 text-[10.5px] capitalize", v.status === "supported" ? "text-muted-foreground" : v.status === "contradicted" ? "text-destructive" : "text-warning-foreground dark:text-warning")}>{v.status}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DeniedCard({ error, onNewThread }: { error: ResearchError; onNewThread: () => void }) {
  return (
    <div role="alert" data-state="denied" className="flex items-start gap-3 rounded-md border p-4 font-sans">
      <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"><Lock className="size-4" /></span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-[13px] font-semibold">Permission denied</div>
        <div className="text-xs text-muted-foreground">{error.message || "You do not have access to this matter or thread."}{error.status ? ` (HTTP ${error.status})` : ""}</div>
        <div className="text-[11px] text-muted-foreground">Research runs are authorized against your matter access on the server. Choose a matter you can access, or ask the matter lead to add you.</div>
        <Button size="xs" variant="outline" className="mt-1" onClick={onNewThread}>Start new research</Button>
      </div>
    </div>
  );
}

function FailureCard({ reason, failure, onRetry }: { reason: string; failure?: string; onRetry: () => void }) {
  return (
    <div role="alert" data-state="failed" className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 px-3 py-2 font-sans text-xs">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1"><span className="font-semibold">Run failed.</span> {reason}{failure ? <span className="text-muted-foreground"> ({failure})</span> : null}</div>
      <Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3" /> Retry</Button>
    </div>
  );
}

function PendingTurn({ pending, lanes, sources, userName, error, denied, aiConfigured, onStop, onRetry, onNewThread }: { pending: NonNullable<ResearchState["pending"]>; lanes: LaneView[]; sources: ResearchSource[]; userName: string; error: ResearchError | null; denied: ResearchError | null; aiConfigured: boolean; onStop: () => void; onRetry: (q: string) => void; onNewThread: () => void }) {
  const retry = () => onRetry(pending.question);
  return (
    <section className="mb-10" aria-live="polite" data-pending-stage={pending.stage}>
      <QuestionBubble text={pending.question} userName={userName} />
      <div className="flex items-start gap-3">
        <AssistantMark size="md" className="mt-1" />
        <div className="min-w-0 flex-1">
          {!aiConfigured && pending.stage !== "denied" && <NoKeyCard className="mb-3" compact />}
          {pending.stage === "denied" ? (
            <DeniedCard error={denied ?? { message: "The server refused this research request." }} onNewThread={onNewThread} />
          ) : pending.stage === "error" ? (
            <FailureCard reason={pending.outcome?.reason ?? error?.message ?? "The run failed"} failure={pending.outcome?.failure ? FAILURE_LABEL[pending.outcome.failure] : undefined} onRetry={retry} />
          ) : (
            <ActivityStrip pending={pending} lanes={lanes} sources={sources} onStop={onStop} className="mb-3" />
          )}
          {pending.text ? <AnswerMarkdown text={pending.text} streaming={pending.stage !== "error"} /> : pending.stage === "synthesis" ? <div className="space-y-2"><div className="h-3.5 w-1/3 animate-pulse-soft rounded bg-muted" /><div className="h-3.5 w-full animate-pulse-soft rounded bg-muted" /><div className="h-3.5 w-10/12 animate-pulse-soft rounded bg-muted" /></div> : null}
        </div>
      </div>
    </section>
  );
}
