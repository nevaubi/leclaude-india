"use client";
import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronRight, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Chip, type ChipTone } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { SAMPLE_CALENDAR, isValidIsoDate, type CourtCalendar } from "@/lib/india/holidays";
import type { LimitationStep } from "@/lib/india/limitation";
import { safeHttp } from "@/modules/official-ui/shared";
import {
  CALENDAR_CAVEAT, calendarOcrNotes, calendarSourceNotes, choiceForum, COURT_CALENDAR_FORUMS, DECISION_SUPPORT_FOOTER, describeCalendarChoice, fetchedDate, formatIsoDate, hostPath, officialChoice, resolveCalendar, statusText, weeklyOffNote,
  type CalendarChoice, type CalendarSourceRef,
} from "../lib";
import type { CourtCalendarsState } from "./use-court-calendars";

/** Copy plain text to the clipboard with a toast either way. */
export function CopyButton({ text, label = "Copy", disabled }: { text: string | null; label?: string; disabled?: boolean }) {
  const onCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied with authorities");
    } catch {
      toast.error("Could not copy: the browser blocked clipboard access");
    }
  };
  return (
    <Button size="xs" variant="outline" onClick={onCopy} disabled={disabled || !text} className="gap-1.5 font-normal">
      <Copy className="size-3.5" aria-hidden />{label}
    </Button>
  );
}

const STATUS_TONE: Record<string, ChipTone> = { computed: "primary", requires_verification: "warning", no_fixed_period: "info", invalid_input: "destructive", mapped: "primary", split: "warning", unmapped: "destructive" };

export function StatusChip({ status, className }: { status: string; className?: string }) {
  return <Chip tone={STATUS_TONE[status] ?? "muted"} className={className}>{statusText(status)}</Chip>;
}

/** A labelled field; children receive the id. */
export function Field({ id, label, hint, error, children, className }: { id: string; label: React.ReactNode; hint?: React.ReactNode; error?: string | null; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-[12px]">{label}</Label>
      {children}
      {error ? <p id={`${id}-error`} className="text-[11.5px] text-destructive">{error}</p> : hint ? <p id={`${id}-hint`} className="text-[11.5px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A date input that reports a partial or impossible date instead of silently ignoring it. */
export function DateField({ id, label, value, onChange, hint, optional }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: React.ReactNode; optional?: boolean }) {
  const error = value && !isValidIsoDate(value) ? "Enter a full date." : null;
  return (
    <Field id={id} label={<>{label}{optional ? <span className="ml-1 font-normal text-muted-foreground">(optional)</span> : null}</>} hint={hint} error={error}>
      <Input id={id} type="date" size="sm" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined} className="w-full tabular sm:w-[180px] dark:[color-scheme:dark]" />
    </Field>
  );
}

export type { CalendarChoice } from "../lib";

/** The calendar a choice stands for (sample, a loaded official calendar, or none). */
export function calendarFor(c: CalendarChoice, cals: Pick<CourtCalendarsState, "official">): CourtCalendar | undefined {
  return resolveCalendar(c, cals.official);
}

/** Plain-text calendar line for copied results (source, fetched date, weekly offs, notes and the ad-hoc caveat for official calendars). */
export function calendarLabel(c: CalendarChoice, cals: Pick<CourtCalendarsState, "official">): string {
  return describeCalendarChoice(c, cals.official);
}

/** Caveats that make a result computed with this calendar "requires verification" (official dates read by OCR). */
export function calendarCaveats(c: CalendarChoice, cals: Pick<CourtCalendarsState, "official">): string[] {
  const forum = choiceForum(c);
  return forum ? calendarOcrNotes(cals.official[forum]) : [];
}

/** The court data's own notes on a calendar (Saturday practice, partial working days), folded by default. Phrasing content only: it sits inside the field hint. */
function CalendarNotes({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <span>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="rounded text-foreground/75 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        {open ? "Hide calendar notes" : "Calendar notes"}
      </button>
      {open ? <span id={id} className="mt-1 block">{text}</span> : null}
    </span>
  );
}

/** One calendar source: an http(s) link (plain text otherwise), its fetch date in India, and an OCR flag when the API gives one. */
function CalendarSourceLink({ s }: { s: CalendarSourceRef }) {
  const href = safeHttp(s.url);
  const fetched = fetchedDate(s.fetchedAt);
  const ocr = s.ocr === true || [s.note, ...(Array.isArray(s.notes) ? s.notes : [])].some((x) => typeof x === "string" && /\bOCR\b/i.test(x));
  return (
    <>
      {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-foreground/80 underline-offset-2 hover:underline">{hostPath(href)}</a> : <span>{s.url ? "a source whose link is not a web address" : "a source with no link recorded"}</span>}
      {fetched ? <> (fetched {fetched} IST)</> : null}
      {ocr ? <> <span className="whitespace-nowrap rounded-[var(--radius-chip)] border border-warning/40 bg-warning/5 px-1 text-[10.5px] font-medium text-warning-foreground dark:text-warning">Dates from OCR — check the PDF</span></> : null}
    </>
  );
}

/**
 * Court calendar picker: none, the illustrative sample, or a court's official calendar from the official-sources corpus
 * (Supreme Court, Delhi HC, Karnataka HC, NCLT, NCLAT when loaded). An official calendar shows its source and fetched
 * date and always carries the ad-hoc caveat.
 */
export function CalendarSelect({ id, value, onChange, cals, label = "Court calendar (Limitation Act, s.4)", allowNone = true }: { id: string; value: CalendarChoice; onChange: (v: CalendarChoice) => void; cals: CourtCalendarsState; label?: string; allowNone?: boolean }) {
  const forum = choiceForum(value);
  const loaded = forum ? cals.official[forum] : undefined;
  const fState = forum ? cals.forums[forum] : undefined;
  const showOfficial = cals.availability === "available" || cals.availability === "loading";
  let hint: React.ReactNode;
  if (value === "none") hint = "No court calendar selected. The result will say the court-closed adjustment was not checked.";
  else if (value === "sample") hint = SAMPLE_CALENDAR.source;
  else if (loaded?.calendar) {
    const serverNotes = [calendarSourceNotes(loaded.calendar), ...loaded.notes.filter((n) => !/\bOCR\b/i.test(n))].filter(Boolean).join(" ");
    // Per-source OCR is flagged beside its link; response-level OCR notes are shown here.
    const ocrNotes = loaded.notes.filter((n) => /\bOCR\b/i.test(n));
    hint = (
      <span className="flex flex-col gap-1">
        <span>
          Official calendar for <span className="tabular">{loaded.calendar.years.join(", ")}</span>
          {loaded.sources.length ? <> from {loaded.sources.map((s, k) => (
            <React.Fragment key={s.documentId || s.url || k}>{k ? "; " : ""}<CalendarSourceLink s={s} /></React.Fragment>
          ))}</> : null}.
        </span>
        <span>{weeklyOffNote(loaded.calendar)}</span>
        {ocrNotes.map((n, k) => <span key={k} className="text-warning-foreground dark:text-warning">{n}</span>)}
        {serverNotes ? <CalendarNotes text={serverNotes} /> : null}
      </span>
    );
  } else if (fState?.status === "loading") hint = "Loading the official calendar…";
  else hint = "No official calendar for these years is loaded, so court holidays are not checked. Choose another calendar.";
  return (
    <Field id={id} label={label} hint={hint}>
      <Select value={value} onValueChange={(v) => onChange(v as CalendarChoice)}>
        <SelectTrigger id={id} size="sm" className="w-full sm:w-[320px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          {allowNone ? <SelectItem value="none">None: do not check court holidays</SelectItem> : null}
          <SelectItem value="sample">Sample: Sundays and three national holidays</SelectItem>
          {showOfficial ? (
            <SelectGroup>
              <SelectLabel className="text-[11px] text-muted-foreground">Official court calendars</SelectLabel>
              {COURT_CALENDAR_FORUMS.map((f) => {
                const st = cals.forums[f.forum];
                const ok = st?.status === "loaded" && Boolean(st.data.calendar);
                const suffix = !st || st.status === "loading" ? " (loading…)" : st.status === "error" ? " (unavailable)" : ok ? ` (${st.data.calendar!.years.join(", ")})` : " (not loaded)";
                return <SelectItem key={f.forum} value={officialChoice(f.forum)} disabled={!ok && value !== officialChoice(f.forum)}>{f.label}<span className="text-muted-foreground">{suffix}</span></SelectItem>;
              })}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>
      {forum ? (
        <p role="note" className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-2 py-1 text-[11.5px] leading-snug text-foreground/85">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning-foreground dark:text-warning" aria-hidden />{CALENDAR_CAVEAT}
        </p>
      ) : !showOfficial && cals.availability !== "loading" ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {cals.availability === "not_configured" ? "Official court calendars are not set up on this workspace." : cals.availability === "not_available" ? "Official court calendars are not available yet." : cals.availability === "denied" ? "You do not have access to official court calendars." : "Official court calendars could not be loaded."}
          {cals.availability === "error" ? <> <button type="button" className="text-primary hover:underline" onClick={cals.retry}>Retry</button></> : null}
        </p>
      ) : null}
    </Field>
  );
}

/** The headline date of a result. */
export function KeyDate({ label, date, sub, tone }: { label: string; date?: string; sub?: React.ReactNode; tone?: "warning" | "destructive" }) {
  if (!date) return null;
  return (
    <div className="min-w-0 rounded-md border border-primary/15 bg-primary/5 px-3 py-2">
      <div className="text-[11.5px] font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-[20px] font-semibold tracking-[-0.01em] text-primary tabular", tone === "destructive" && "text-destructive")}>{formatIsoDate(date)}</div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground tabular">{date}{sub ? <> · {sub}</> : null}</div>
    </div>
  );
}

export function StepsList({ steps }: { steps: LimitationStep[] }) {
  if (!steps.length) return null;
  return (
    <details className="group mt-4" aria-label="Computation steps">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-[12px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />Show working ({steps.length} {steps.length === 1 ? "step" : "steps"})
      </summary>
      <ol className="mt-2 divide-y rounded-md border bg-surface-quiet">
        {steps.map((s, i) => (
          <li key={i} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2 px-3 py-2 text-[12.5px] leading-snug">
            <span className="text-muted-foreground tabular">{i + 1}.</span>
            <div className="min-w-0">
              <p>{s.text}</p>
              {s.authority ? <p className="mt-0.5 text-[11.5px] text-muted-foreground">{s.authority}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** "Requires verification" items and notes. Uncertain points are shown, never folded away. */
export function Caveats({ uncertain, notes }: { uncertain: string[]; notes: string[] }) {
  if (!uncertain.length && !notes.length) return null;
  return (
    <div className="mt-4 space-y-3">
      {uncertain.length ? (
        <section aria-label="Requires verification" className="rounded-md border border-warning/50 bg-warning/8 px-3 py-2">
          <h4 className="flex items-center gap-1.5 text-[12px] font-medium"><AlertTriangle className="size-3.5 text-warning-foreground dark:text-warning" aria-hidden />Requires verification</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] leading-snug">{uncertain.map((u, i) => <li key={i}>{u}</li>)}</ul>
        </section>
      ) : null}
      {notes.length ? (
        <section aria-label="Notes">
          <h4 className="text-[12px] font-medium text-muted-foreground">Notes</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] leading-snug text-muted-foreground">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

export function ResultCard({ title, status, copyText, children }: { title: React.ReactNode; status?: string; copyText: string | null; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} aria-live="polite" data-result className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <header className="flex flex-wrap items-center gap-2 border-b bg-surface-quiet px-4 py-2">
        <h3 id={id} className="min-w-0 truncate text-[13px] font-medium">{title}</h3>
        {status ? <StatusChip status={status} /> : null}
        <div className="flex-1" />
        <CopyButton text={copyText} />
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function Placeholder({ children }: { children: React.ReactNode }) {
  return <div role="status" className="rounded-lg border border-dashed bg-surface-quiet px-4 py-8 text-center text-[12.5px] text-muted-foreground">{children}</div>;
}

export function ToolHeader({ title, description }: { title: string; description: React.ReactNode }) {
  return (
    <div className="mb-4 border-b pb-3">
      <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{title}</h2>
      <p className="mt-1 max-w-[72ch] text-[12.5px] leading-snug text-muted-foreground">{description}</p>
    </div>
  );
}

export function DecisionFooter() {
  return <p className="mt-6 border-t pt-3 text-[11.5px] text-muted-foreground">{DECISION_SUPPORT_FOOTER}</p>;
}
