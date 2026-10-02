"use client";
import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Chip, type ChipTone } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { SAMPLE_CALENDAR, isValidIsoDate, type CourtCalendar } from "@/lib/india/holidays";
import type { LimitationStep } from "@/lib/india/limitation";
import { DECISION_SUPPORT_FOOTER, formatIsoDate, statusText } from "../lib";

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

export type CalendarChoice = "none" | "sample";
export const calendarFor = (c: CalendarChoice): CourtCalendar | undefined => (c === "sample" ? SAMPLE_CALENDAR : undefined);
export const calendarLabel = (c: CalendarChoice) => (c === "sample" ? `Sample calendar "${SAMPLE_CALENDAR.id}" (illustrative; not a court's notified calendar)` : "None selected");

export function CalendarSelect({ id, value, onChange }: { id: string; value: CalendarChoice; onChange: (v: CalendarChoice) => void }) {
  return (
    <Field
      id={id}
      label="Court calendar (Limitation Act, s.4)"
      hint={value === "none" ? "No notified court calendar is loaded. The result will say the court-closed adjustment was not checked." : SAMPLE_CALENDAR.source}
    >
      <Select value={value} onValueChange={(v) => onChange(v as CalendarChoice)}>
        <SelectTrigger id={id} size="sm" className="w-full sm:w-[320px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None: do not check court holidays</SelectItem>
          <SelectItem value="sample">Sample: Sundays and three national holidays</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The headline date of a result. */
export function KeyDate({ label, date, sub, tone }: { label: string; date?: string; sub?: React.ReactNode; tone?: "warning" | "destructive" }) {
  if (!date) return null;
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-[20px] font-semibold tracking-[-0.01em] tabular", tone === "destructive" && "text-destructive")}>{formatIsoDate(date)}</div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground tabular">{date}{sub ? <> · {sub}</> : null}</div>
    </div>
  );
}

export function StepsList({ steps }: { steps: LimitationStep[] }) {
  if (!steps.length) return null;
  return (
    <section aria-label="Computation steps" className="mt-4">
      <h4 className="mb-1.5 text-[12px] font-medium text-muted-foreground">Steps</h4>
      <ol className="divide-y rounded-md border">
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
    </section>
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
    <section aria-labelledby={id} aria-live="polite" data-result className="rounded-lg border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
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
  return <div role="status" className="rounded-lg border border-dashed px-4 py-8 text-center text-[12.5px] text-muted-foreground">{children}</div>;
}

export function ToolHeader({ title, description }: { title: string; description: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      <p className="mt-0.5 max-w-[72ch] text-[12.5px] leading-snug text-muted-foreground">{description}</p>
    </div>
  );
}

export function DecisionFooter() {
  return <p className="mt-6 border-t pt-3 text-[11.5px] text-muted-foreground">{DECISION_SUPPORT_FOOTER}</p>;
}
