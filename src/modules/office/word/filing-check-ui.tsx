"use client";
/**
 * Filing check UI for the Word editor: the "Checks" sidebar panel and the pre-export gate dialog (docx / PDF). The
 * check runs on the server (POST /api/office/word/filing-check); this file only shows it. Unresolved, ambiguous,
 * negative-signal and unchecked items are listed as they are; export goes ahead only after the user acknowledges them,
 * and that acknowledgement travels with the export (custom properties + audit record).
 */
import * as React from "react";
import type { Editor } from "@tiptap/core";
import { AlertTriangle, CheckCircle2, CircleDashed, FileCheck2, HelpCircle, Loader2, RefreshCw, ScrollText, ShieldAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { PanelEmpty } from "@/modules/office/shared/office-chrome";
import type { PMNode } from "./doc-model";
import { filingText, type FilingCheckReport, type FilingCitation, type FilingIssue } from "./filing-check";
import { DEFAULT_DECLARATION, DECLARATION_MAX_CHARS } from "./provenance";

// ---- data ---------------------------------------------------------------------------------------------------------

export class FilingCheckError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "FilingCheckError"; }
}

export async function requestFilingCheck(docId: string | undefined, content: PMNode, opts: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<FilingCheckReport> {
  const res = await fetch("/api/office/word/filing-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ docId, content, fresh: opts.fresh }), signal: opts.signal });
  const body = (await res.json().catch(() => ({}))) as { report?: FilingCheckReport; error?: string };
  if (!res.ok || !body.report) throw new FilingCheckError(res.status === 403 || res.status === 404 ? "You do not have access to this document." : body.error ?? `The check failed (${res.status}).`, res.status);
  return body.report;
}

/** Record the gate acknowledgement for exports the server does not write (print / PDF). */
export async function recordAcknowledgement(docId: string | undefined, content: PMNode, ack: { format: string; docHash: string; items: number; issueKeys: string[]; declaration: boolean }): Promise<void> {
  await fetch("/api/office/word/filing-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ docId, content, acknowledge: ack }) }).catch(() => undefined);
}

/** SHA-256 of the checked body text, computed in the browser exactly as the server does (staleness of a shown check). */
export async function bodyHash(doc: PMNode): Promise<string> {
  const bytes = new TextEncoder().encode(filingText(doc));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- presentation -----------------------------------------------------------------------------------------------------

const STATE_META: Record<FilingCitation["state"], { label: string; icon: typeof CheckCircle2; cls: string }> = {
  resolved: { label: "Resolved", icon: CheckCircle2, cls: "text-muted-foreground" },
  ambiguous: { label: "Ambiguous", icon: HelpCircle, cls: "text-warning-foreground dark:text-warning" },
  unresolved: { label: "Unresolved", icon: XCircle, cls: "text-destructive" },
};

function CitationRow({ c, onLocate }: { c: FilingCitation; onLocate?: (blockId: string) => void }) {
  const m = STATE_META[c.state];
  const Icon = m.icon;
  return (
    <li className="px-2.5 py-2">
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", m.cls)} aria-hidden />
        <div className="min-w-0 flex-1">
          <button type="button" disabled={!onLocate || !c.blockIds[0]} onClick={() => c.blockIds[0] && onLocate?.(c.blockIds[0])} className="max-w-full truncate text-left text-[12.5px] font-medium tabular hover:underline disabled:no-underline" title={c.citation}>{c.citation}</button>
          <div className="text-[11.5px] leading-snug text-muted-foreground">
            <span className={m.cls}>{m.label}</span>
            {c.state === "resolved" && c.title ? <> · {c.title}</> : null}
            {c.state === "resolved" && c.resolvedBy === "official_corpus" ? <> · exact match in the official corpus</> : null}
            {c.state === "ambiguous" && c.candidates.length ? <> · could be {c.candidates.join("; ")} (none chosen)</> : null}
            {c.state === "unresolved" && c.reason ? <> · {c.reason}</> : null}
            {c.occurrences > 1 ? <> · cited {c.occurrences}×</> : null}
          </div>
          {c.negative.length > 0 && (
            <div className="mt-1 rounded-sm border border-warning/40 bg-warning/5 px-1.5 py-1 text-[11.5px] leading-snug">
              Negative text cue{c.negative.length === 1 ? "" : "s"}: {c.negative.slice(0, 3).map((n) => `${n.title}${n.cue ? ` (“${n.cue}”)` : ""}`).join("; ")}. A text cue, not a verified treatment.
            </div>
          )}
          {c.state === "resolved" && c.citator === "not_built" && <div className="text-[11px] text-muted-foreground">Citator not built for this judgment yet; no negative-signal check.</div>}
          {c.quotes.map((q, i) => (
            <div key={i} className="mt-1 text-[11.5px] leading-snug">
              <span className={cn("me-1 font-medium", q.state === "found" ? "text-muted-foreground" : q.state === "not_found" ? "text-destructive" : "text-warning-foreground dark:text-warning")}>
                {q.state === "found" ? "Quote matches" : q.state === "not_found" ? "Quote not in judgment" : q.state === "text_incomplete" ? "Quote not checked (partial text)" : "Quote not checked (no text)"}
              </span>
              <span className="italic text-muted-foreground">“{q.quote.length > 140 ? `${q.quote.slice(0, 140)}…` : q.quote}”</span>
            </div>
          ))}
        </div>
      </div>
    </li>
  );
}

export function ReportSummary({ report }: { report: FilingCheckReport }) {
  const c = report.counts;
  return (
    <div className="grid grid-cols-3 gap-1 text-center text-[11px] text-muted-foreground">
      <div className="rounded-sm bg-surface-quiet py-1"><div className="text-[13px] font-medium tabular text-foreground">{c.resolved}</div>resolved</div>
      <div className="rounded-sm bg-surface-quiet py-1"><div className={cn("text-[13px] font-medium tabular", c.ambiguous ? "text-warning-foreground dark:text-warning" : "text-foreground")}>{c.ambiguous}</div>ambiguous</div>
      <div className="rounded-sm bg-surface-quiet py-1"><div className={cn("text-[13px] font-medium tabular", c.unresolved ? "text-destructive" : "text-foreground")}>{c.unresolved}</div>unresolved</div>
    </div>
  );
}

export function ReportBody({ report, onLocate }: { report: FilingCheckReport; onLocate?: (blockId: string) => void }) {
  const order = { unresolved: 0, ambiguous: 1, resolved: 2 } as const;
  const list = [...report.citations].sort((a, b) => order[a.state] - order[b.state] || Number(b.negative.length > 0) - Number(a.negative.length > 0));
  return (
    <div className="space-y-2">
      {report.unavailable.length > 0 && (
        <div role="status" className="rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-[11.5px] leading-snug">
          {report.unavailable.map((u, i) => <div key={i}>{u}</div>)}
        </div>
      )}
      {list.length === 0 ? (
        <p className="px-1 text-[12px] text-muted-foreground">No case citations were found in this document.{report.statutes.length ? ` ${report.statutes.length} statutory reference${report.statutes.length === 1 ? " was" : "s were"} found; statutes are not resolved by this check.` : ""}</p>
      ) : (
        <ul className="divide-y rounded-md border">{list.map((c) => <CitationRow key={c.key} c={c} onLocate={onLocate} />)}</ul>
      )}
      {list.length > 0 && report.statutes.length > 0 && <p className="px-1 text-[11px] text-muted-foreground">{report.statutes.length} statutory reference{report.statutes.length === 1 ? "" : "s"} not resolved by this check.</p>}
    </div>
  );
}

// ---- sidebar panel ------------------------------------------------------------------------------------------------------

type PanelState = { status: "idle" } | { status: "loading" } | { status: "ready"; report: FilingCheckReport; stale: boolean } | { status: "error"; message: string; denied: boolean };

export function ChecksPanel({ editor, docId, onLocate }: { editor: Editor; docId?: string; onLocate: (blockId: string) => void }) {
  const [state, setState] = React.useState<PanelState>({ status: "idle" });
  const ctrl = React.useRef<AbortController | null>(null);
  const run = React.useCallback(async (fresh: boolean) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setState({ status: "loading" });
    try {
      const report = await requestFilingCheck(docId, editor.getJSON() as PMNode, { fresh, signal: ac.signal });
      if (!ac.signal.aborted) setState({ status: "ready", report, stale: false });
    } catch (e) {
      if (!ac.signal.aborted) setState({ status: "error", message: (e as Error).message, denied: e instanceof FilingCheckError && (e.status === 403 || e.status === 404) });
    }
  }, [docId, editor]);
  React.useEffect(() => () => ctrl.current?.abort(), []);
  // Mark a shown check stale once the body text changes.
  const report = state.status === "ready" ? state.report : null;
  React.useEffect(() => {
    if (!report) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Debounced: hashing the body on every keystroke is wasteful for long drafts.
    const check = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void bodyHash(editor.getJSON() as PMNode).then((h) => { if (alive && h !== report.docHash) setState((s) => (s.status === "ready" && !s.stale ? { ...s, stale: true } : s)); }); }, 600);
    };
    editor.on("update", check);
    return () => { alive = false; if (timer) clearTimeout(timer); editor.off("update", check); };
  }, [editor, report]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="text-[11.5px] text-muted-foreground">Citations, citator and quotes</span>
        <Button size="xs" variant="outline" className="ms-auto" onClick={() => void run(state.status === "ready")} disabled={state.status === "loading"}>
          {state.status === "loading" ? <Loader2 className="size-3.5 animate-spin" /> : state.status === "ready" ? <RefreshCw className="size-3.5" /> : <FileCheck2 className="size-3.5" />}
          {state.status === "ready" ? "Re-run" : "Run check"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin">
        {state.status === "idle" && <PanelEmpty icon={FileCheck2} title="Filing check" description="Resolves each case citation (never substitutes), flags negative citator text cues and checks quotations against judgment text where it is available." />}
        {state.status === "loading" && <div className="flex items-center gap-2 px-2 py-6 text-[12.5px] text-muted-foreground" aria-busy="true"><Loader2 className="size-4 animate-spin" /> Checking citations…</div>}
        {state.status === "error" && (
          state.denied
            ? <PanelEmpty icon={ShieldAlert} title="No access" description={state.message} />
            : <PanelEmpty icon={AlertTriangle} title="The check could not run" description={state.message} action={<Button size="xs" variant="ghost" onClick={() => void run(true)}><RefreshCw className="size-3.5" /> Try again</Button>} />
        )}
        {state.status === "ready" && (
          <div className="space-y-2">
            {state.stale && <div role="status" className="rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-[11.5px]">The document changed after this check. Re-run before relying on it.</div>}
            <ReportSummary report={state.report} />
            <ReportBody report={state.report} onLocate={onLocate} />
            <p className="px-1 text-[10.5px] text-muted-foreground">Checked {new Date(state.report.checkedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}. An automated check does not replace reading the authorities.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- export gate --------------------------------------------------------------------------------------------------------

export type GateKind = "docx" | "docx-clean" | "pdf";

export interface GateResult {
  report: FilingCheckReport | null;
  acknowledged: boolean;
  issues: FilingIssue[];
  declaration: string | null;
  appendix: boolean;
}

type GateState = { status: "loading" } | { status: "ready"; report: FilingCheckReport } | { status: "error"; message: string };

const ISSUE_ICON: Record<FilingIssue["kind"], typeof XCircle> = { unresolved: XCircle, ambiguous: HelpCircle, negative: AlertTriangle, quote_not_found: XCircle, quote_unchecked: CircleDashed, check_unavailable: CircleDashed };

/**
 * Pre-export dialog: runs the filing check, lists every unresolved / ambiguous / negative / unchecked item, and offers
 * the AI-use declaration (editable) and the provenance appendix. Export is enabled only after the acknowledgement box is
 * ticked when anything is listed (or when the check could not run).
 */
export function ExportGateDialog({ kind, docId, getContent, onCancel, onConfirm }: { kind: GateKind | null; docId?: string; getContent: () => PMNode; onCancel: () => void; onConfirm: (r: GateResult) => void }) {
  const [state, setState] = React.useState<GateState>({ status: "loading" });
  const [ack, setAck] = React.useState(false);
  const [withDecl, setWithDecl] = React.useState(false);
  const [decl, setDecl] = React.useState(DEFAULT_DECLARATION);
  const [appendix, setAppendix] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (!kind) return;
    const ac = new AbortController();
    setState({ status: "loading" });
    setAck(false);
    requestFilingCheck(docId, getContent(), { signal: ac.signal, fresh: nonce > 0 })
      .then((report) => { if (!ac.signal.aborted) setState({ status: "ready", report }); })
      .catch((e) => { if (!ac.signal.aborted) setState({ status: "error", message: (e as Error).message }); });
    return () => ac.abort();
    // getContent is read once per open; re-running uses the nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, docId, nonce]);

  const report = state.status === "ready" ? state.report : null;
  const issues = report?.issues ?? [];
  const needsAck = state.status === "error" || issues.length > 0;
  const canExport = state.status !== "loading" && (!needsAck || ack);
  const label = kind === "pdf" ? "PDF (print)" : kind === "docx-clean" ? "Word, changes accepted" : "Word with tracked changes";

  return (
    <Dialog open={!!kind} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent size="lg" className="max-h-[88vh] overflow-hidden p-0">
        <div className="flex max-h-[88vh] flex-col">
          <DialogHeader className="border-b px-5 py-3">
            <DialogTitle className="flex items-center gap-2 text-[14px]"><ScrollText className="size-4 text-muted-foreground" /> Filing check before export</DialogTitle>
            <DialogDescription className="text-[12px]">{label}. Citations are resolved without substitution; nothing is changed in your document.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-3 scrollbar-thin">
            {state.status === "loading" && <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted-foreground" aria-busy="true"><Loader2 className="size-4 animate-spin" /> Checking citations, citator signals and quotations…</div>}
            {state.status === "error" && (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px]">
                The filing check could not run: {state.message}
                <div className="mt-1 text-[11.5px] text-muted-foreground">You can retry, or export without a check (the export records that no check ran).</div>
                <Button size="xs" variant="ghost" className="mt-1" onClick={() => setNonce((x) => x + 1)}><RefreshCw className="size-3.5" /> Retry</Button>
              </div>
            )}
            {report && (
              <>
                <ReportSummary report={report} />
                {issues.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-md bg-surface-quiet px-3 py-2 text-[12.5px] text-muted-foreground"><CheckCircle2 className="size-3.5" /> {report.counts.citations ? "Every case citation resolved; no negative signals or quotation problems were found." : "No case citations were found."}</div>
                ) : (
                  <div>
                    <div className="mb-1 text-[12px] font-medium">{issues.length} item{issues.length === 1 ? "" : "s"} to review</div>
                    <ul className="max-h-[34vh] divide-y overflow-y-auto rounded-md border scrollbar-thin">
                      {issues.map((i) => {
                        const Icon = ISSUE_ICON[i.kind];
                        return (
                          <li key={i.key} className="flex items-start gap-2 px-2.5 py-1.5 text-[12px] leading-snug">
                            <Icon className={cn("mt-0.5 size-3.5 shrink-0", i.kind === "unresolved" || i.kind === "quote_not_found" ? "text-destructive" : i.kind === "ambiguous" || i.kind === "negative" ? "text-warning-foreground dark:text-warning" : "text-muted-foreground")} aria-hidden />
                            <div className="min-w-0">{i.citation && <span className="me-1 font-medium tabular">{i.citation}</span>}<span className="text-muted-foreground">{i.message}</span></div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
            <div className="space-y-2 rounded-md border px-3 py-2.5">
              <label className="flex items-start gap-2 text-[12.5px]">
                <Checkbox size="sm" className="mt-0.5" checked={withDecl} onCheckedChange={(v) => setWithDecl(v === true)} />
                <span><span className="font-medium">Append a declaration on use of AI tools</span><span className="block text-[11.5px] text-muted-foreground">Added on a new page at the end, followed by a generated line stating what the automated check found.</span></span>
              </label>
              {withDecl && <Textarea value={decl} maxLength={DECLARATION_MAX_CHARS} onChange={(e) => setDecl(e.target.value)} rows={4} className="text-[12.5px]" aria-label="Declaration text" />}
              {kind !== "pdf" && (
                <label className="flex items-start gap-2 text-[12.5px]">
                  <Checkbox size="sm" className="mt-0.5" checked={appendix} onCheckedChange={(v) => setAppendix(v === true)} />
                  <span><span className="font-medium">Append a provenance appendix</span><span className="block text-[11.5px] text-muted-foreground">Sources the drafting assistant consulted on this document, as recorded. The .docx also carries machine-readable provenance properties.</span></span>
                </label>
              )}
            </div>
            {needsAck && state.status !== "loading" && (
              <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[12.5px]">
                <Checkbox size="sm" className="mt-0.5" checked={ack} onCheckedChange={(v) => setAck(v === true)} aria-label="Acknowledge the listed items" />
                <span>{state.status === "error" ? "I understand no filing check ran for this export." : `I have reviewed the ${issues.length} listed item${issues.length === 1 ? "" : "s"} and want to export anyway.`}<span className="block text-[11.5px] text-muted-foreground">Your acknowledgement is recorded with the export.</span></span>
              </label>
            )}
          </div>
          <DialogFooter className="border-t px-5 py-3">
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
            <Button size="sm" disabled={!canExport} onClick={() => onConfirm({ report, acknowledged: needsAck ? ack : false, issues, declaration: withDecl ? decl : null, appendix: kind !== "pdf" && appendix })}>Export</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
