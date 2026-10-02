"use client";
import * as React from "react";
import { toast } from "sonner";
import { AlertCircle, Check, Download, FileQuestion, Loader2, Play, Plus, RotateCcw, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readSSE } from "@/lib/ai/sse";
import { cn } from "@/lib/utils";
import { REVIEW_LIMITS, type DocReview, type ReportAnswer, type ReportEvent, type ReviewReport as Report } from "../../review-types";
import { classify, docsApi, downloadText, errorKind, errorMessage, UNCONFIGURED_MESSAGE, type ApiErrorKind } from "../api";
import { safeFileName } from "../format";
import { Notice, SurfaceState } from "../notice";
import type { ViewerTarget } from "../text-viewer";
import { CitedAnswer, SourceList } from "./cited-answer";
import { NO_EVIDENCE_TEXT, reportCsv, reviewUrl } from "./review-helpers";

type QState = { question: string; state: "waiting" | "running" | "done" | "failed" | "unanswered"; answer?: ReportAnswer; error?: string };
type Load = { status: "loading" } | { status: "ready"; report: Report | null } | { status: "error"; message: string; kind: ApiErrorKind };
type Run = { running: boolean; items: QState[]; error?: string; stopped?: boolean };
/** The server sends ReportEvent; an unexpected failure arrives as { type: "error", message }. */
type StreamEvent = ReportEvent | { type: "error"; message?: string; code?: string };

/** Questions run across the whole set; answers cite file + page, unresolved markers stay unresolved. */
export function ReviewReportView({ setId, review, aiReady, onView, onReviewChange }: {
  setId: string; review: DocReview; aiReady: boolean | null; onView: (t: ViewerTarget) => void; onReviewChange: (r: DocReview) => void;
}) {
  const [load, setLoad] = React.useState<Load>({ status: "loading" });
  const [reload, setReload] = React.useState(0);
  const [questions, setQuestions] = React.useState<string[]>(review.questions);
  const [saving, setSaving] = React.useState(false);
  const [run, setRun] = React.useState<Run | null>(null);
  const ctrl = React.useRef<AbortController | null>(null);

  React.useEffect(() => { setQuestions(review.questions); }, [review.id, review.questions]);
  React.useEffect(() => () => ctrl.current?.abort(), []);

  React.useEffect(() => {
    const ac = new AbortController();
    setLoad({ status: "loading" });
    docsApi<{ report: Report | null }>(reviewUrl(setId, review.id, "/report"), { signal: ac.signal })
      .then((r) => setLoad({ status: "ready", report: r.report ?? null }))
      .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorMessage(e), kind: errorKind(e) }); });
    return () => ac.abort();
  }, [setId, review.id, reload]);

  const clean = questions.map((q) => q.trim()).filter(Boolean);
  const dirty = clean.join("\n") !== review.questions.join("\n");
  const running = !!run?.running;

  const saveQuestions = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const r = await docsApi<{ review: DocReview }>(reviewUrl(setId, review.id), { method: "PATCH", json: { questions: clean, version: review.version } });
      onReviewChange(r.review);
      return true;
    } catch (e) {
      if (errorKind(e) === "conflict") {
        toast.error("Someone else changed this review since you opened it. It has been reloaded; check the questions and try again.");
        docsApi<{ review: DocReview }>(reviewUrl(setId, review.id)).then((r) => onReviewChange(r.review)).catch(() => {});
      } else toast.error(errorKind(e) === "unconfigured" ? UNCONFIGURED_MESSAGE : errorMessage(e));
      return false;
    }
    finally { setSaving(false); }
  };

  const start = async () => {
    if (running || !clean.length) return;
    if (dirty && !(await saveQuestions())) return;
    const ac = new AbortController();
    ctrl.current = ac;
    const items: QState[] = clean.map((q) => ({ question: q, state: "waiting" }));
    const st: Run = { running: true, items };
    setRun({ ...st, items: [...items] });
    const set = (i: number, p: Partial<QState>) => { if (items[i]) items[i] = { ...items[i], ...p }; else items[i] = { question: p.question ?? "", state: "waiting", ...p }; setRun({ ...st, items: [...items] }); };
    let completed = false;
    try {
      const res = await fetch(reviewUrl(setId, review.id, "/report"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questions: clean }), signal: ac.signal });
      if (!res.ok) throw classify(res.status, (await res.json().catch(() => ({}))) as { error?: string });
      await readSSE<StreamEvent>(res, (ev) => {
        if (ev.type === "question.started") set(ev.index, { question: ev.question, state: "running" });
        else if (ev.type === "question.completed") set(ev.index, { question: ev.answer.question, state: "done", answer: ev.answer });
        else if (ev.type === "question.failed") set(ev.index, { question: ev.question, state: "failed", error: ev.error });
        else if (ev.type === "report.completed") { completed = true; setLoad({ status: "ready", report: ev.report }); }
        else if (ev.type === "report.failed") throw new Error(ev.error);
        else if (ev.type === "error") throw new Error(ev.code === "ai_not_configured" || ev.code === "503" ? UNCONFIGURED_MESSAGE : ev.message || "The report could not be completed.");
      }, ac.signal);
      if (!completed) throw new Error("The report was interrupted before it finished.");
      setRun(null);
    } catch (e) {
      // Questions that never finished are shown as not answered, not left spinning.
      for (const [i, it] of items.entries()) if (it.state === "waiting" || it.state === "running") items[i] = { ...it, state: "unanswered" };
      if (ac.signal.aborted) setRun({ ...st, running: false, stopped: true, items: [...items] });
      else setRun({ ...st, running: false, items: [...items], error: errorKind(e) === "unconfigured" ? UNCONFIGURED_MESSAGE : errorMessage(e) });
    } finally { ctrl.current = null; }
  };

  const report = load.status === "ready" ? load.report : null;
  const shown: QState[] = run ? run.items : storedItems(report);
  const doneCount = run ? run.items.filter((i) => i.state === "done").length : 0;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[880px] space-y-4 px-4 py-3">
        <section className="space-y-2" aria-label="Report questions">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[12.5px] font-medium">Questions</h3>
            <span className="text-[11.5px] text-muted-foreground">Asked across every file in the set. Edit them before running.</span>
            <span className="ms-auto text-[11px] tabular text-muted-foreground">{clean.length} / {REVIEW_LIMITS.maxQuestions}</span>
          </div>
          <ol className="space-y-1.5">
            {questions.map((q, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className="w-5 shrink-0 text-right text-[11px] tabular text-muted-foreground">{i + 1}</span>
                <Input size="xs" value={q} onChange={(e) => setQuestions((l) => l.map((x, j) => (j === i ? e.target.value : x)))} disabled={running} aria-label={`Question ${i + 1}`} maxLength={400} className="min-w-0 flex-1" />
                <Button size="icon-xs" variant="ghost" aria-label={`Remove question ${i + 1}`} disabled={running} onClick={() => setQuestions((l) => l.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="outline" disabled={running || questions.length >= REVIEW_LIMITS.maxQuestions} onClick={() => setQuestions((l) => [...l, ""])}><Plus className="size-3.5" /> Add question</Button>
            {dirty && <Button size="xs" variant="ghost" disabled={saving || running} onClick={() => void saveQuestions()}>{saving && <Loader2 className="size-3.5 animate-spin" />}Save questions</Button>}
            <div className="ms-auto flex items-center gap-1.5">
              {report && !running && <Button size="xs" variant="ghost" onClick={() => downloadText(`${safeFileName(review.name)} - report.csv`, reportCsv(report.answers))}><Download className="size-3.5" /> CSV</Button>}
              {running
                ? <Button size="sm" variant="outline" onClick={() => ctrl.current?.abort()}><Square className="size-3 fill-current" /> Stop</Button>
                : <Button size="sm" onClick={() => void start()} disabled={aiReady === false || !clean.length || saving}><Play className="size-3.5" /> {report ? "Run report again" : "Run report"}</Button>}
            </div>
          </div>
          {aiReady === false && <Notice tone="warning">{UNCONFIGURED_MESSAGE}</Notice>}
        </section>

        {run && (
          <div className="rounded-md border px-3 py-2 text-[12.5px]" aria-live="polite">
            <div className="flex items-center gap-2">
              {run.running ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : run.error ? <AlertCircle className="size-3.5 text-destructive" /> : null}
              <span className="font-medium">{run.running ? "Running report" : run.stopped ? "Report stopped" : "Report did not finish"}</span>
              <span className="text-muted-foreground">{doneCount} of {run.items.length} question{run.items.length === 1 ? "" : "s"}</span>
              {!run.running && <Button size="xs" variant="ghost" className="ms-auto" onClick={() => setRun(null)}>Dismiss</Button>}
            </div>
            {run.error && <p className="mt-1 text-[12px] text-destructive">{run.error}</p>}
            {run.stopped && <p className="mt-1 text-[12px] text-muted-foreground">Answers finished before stopping are shown below; the stored report is unchanged.</p>}
          </div>
        )}

        {load.status === "loading" && !run && <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading the last report…</div>}
        {load.status === "error" && !run && (load.kind === "denied"
          ? <SurfaceState title="Not found or no access">{load.message}</SurfaceState>
          : <SurfaceState icon={AlertCircle} title="The report could not be loaded" action={<Button size="xs" variant="ghost" onClick={() => setReload((n) => n + 1)}><RotateCcw className="size-3.5" /> Try again</Button>}>{load.message}</SurfaceState>)}
        {load.status === "ready" && !report && !run && (
          <SurfaceState icon={FileQuestion} title="No report yet">Run the report to answer these questions across the set. Each answer cites the file and page it rests on; where the files do not answer a question, it says so.</SurfaceState>
        )}
        {report && !run && report.status === "partial" && (
          <Notice tone="warning" action={<Button size="xs" variant="ghost" onClick={() => void start()} disabled={aiReady === false || !clean.length}><RotateCcw className="size-3.5" /> Run again</Button>}>
            Partial report: {report.failed.length} question{report.failed.length === 1 ? "" : "s"} could not be answered and {report.failed.length === 1 ? "is" : "are"} listed below. Run the report again to retry.
          </Notice>
        )}
        {report && !run && (
          <p className="text-[11.5px] text-muted-foreground">
            Generated {new Date(report.generatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} over {report.fileCount.toLocaleString("en-IN")} file{report.fileCount === 1 ? "" : "s"}.
            {report.fileCount !== review.counts.files && ` The set now has ${review.counts.files.toLocaleString("en-IN")} files; run the report again to include changes.`}
          </p>
        )}

        {shown.length > 0 && (
          <ol className="space-y-3">
            {shown.map((q, i) => <AnswerCard key={i} n={i + 1} q={q} onView={onView} />)}
          </ol>
        )}
        <p className="text-[11px] text-muted-foreground">Answers can be wrong. Open each citation to check the page before relying on it.</p>
      </div>
    </div>
  );
}

/** Stored report as cards: answers in order, failed questions put back at their position (never dropped). */
function storedItems(report: Report | null): QState[] {
  if (!report) return [];
  const items: QState[] = report.answers.map((a) => ({ question: a.question, state: "done", answer: a }));
  for (const f of [...(report.failed ?? [])].sort((a, b) => a.index - b.index)) items.splice(Math.min(f.index, items.length), 0, { question: f.question, state: "failed", error: f.error });
  return items;
}

function AnswerCard({ n, q, onView }: { n: number; q: QState; onView: (t: ViewerTarget) => void }) {
  const a = q.answer;
  return (
    <li className="rounded-md border">
      <header className="flex items-start gap-2 border-b px-3 py-2">
        <span className="mt-px w-5 shrink-0 text-[11.5px] tabular text-muted-foreground">{n}</span>
        <h4 className="min-w-0 flex-1 text-[13px] font-medium leading-snug">{q.question}</h4>
        <span className={cn("inline-flex shrink-0 items-center gap-1 text-[11.5px]", q.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {q.state === "running" && <><Loader2 className="size-3 animate-spin" /> Answering</>}
          {q.state === "waiting" && "Waiting"}
          {q.state === "unanswered" && "Not answered"}
          {q.state === "failed" && "Failed"}
          {q.state === "done" && a && !a.noEvidence && <><Check className="size-3" /> {a.citations.length} source{a.citations.length === 1 ? "" : "s"}</>}
        </span>
      </header>
      <div className="space-y-2 px-3 py-2.5">
        {q.state === "failed" && <p className="text-[12.5px] text-destructive">{q.error ?? "This question could not be answered."}</p>}
        {(q.state === "waiting" || q.state === "running") && <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />}
        {q.state === "unanswered" && <p className="text-[12.5px] text-muted-foreground">Not answered: the report stopped before this question. Run the report again to answer it.</p>}
        {a && a.noEvidence && <Notice tone="warning">{NO_EVIDENCE_TEXT}.</Notice>}
        {a && a.answer && <CitedAnswer answer={a} onView={onView} />}
        {a && a.unresolved.length > 0 && (
          <Notice tone="warning">Marker{a.unresolved.length === 1 ? "" : "s"} {a.unresolved.map((m) => `[${m}]`).join(", ")} point{a.unresolved.length === 1 ? "s" : ""} to no passage that was searched and {a.unresolved.length === 1 ? "is" : "are"} shown as unresolved.</Notice>
        )}
        {a && <SourceList citations={a.citations} onView={onView} />}
      </div>
    </li>
  );
}
