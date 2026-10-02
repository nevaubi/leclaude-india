"use client";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/form";
import { isValidIsoDate } from "@/lib/india/holidays";
import { addWorkingDays, addWorkingDaysToText, countCourtDays, courtDaysToText, formatIsoDate, nextCourtDay, nextCourtDayToText, type CalendarChoice } from "../lib";
import { CalendarSelect, calendarCaveats, calendarFor, calendarLabel, Caveats, DateField, Field, KeyDate, Placeholder, ResultCard, ToolHeader } from "./shared";
import { useCourtCalendars } from "./use-court-calendars";

type Mode = "count" | "next" | "add";

const MODES: { value: Mode; label: string }[] = [
  { value: "count", label: "Count between dates" },
  { value: "next", label: "Next working day" },
  { value: "add", label: "Add working days" },
];

function ClosedDays({ days, label = "Closed under the calendar" }: { days: { date: string; reason: string }[]; label?: string }) {
  if (!days.length) return null;
  const shown = days.slice(0, 60);
  return (
    <section aria-label={label} className="mt-4">
      <h4 className="mb-1.5 text-[12px] font-medium text-muted-foreground">{label} ({days.length})</h4>
      <ul className="max-h-[240px] divide-y overflow-auto rounded-md border text-[12.5px] scrollbar-thin">
        {shown.map((d) => (
          <li key={d.date} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2 px-3 py-1.5">
            <span className="tabular">{formatIsoDate(d.date)}</span>
            <span className="min-w-0 text-muted-foreground">{d.reason}</span>
          </li>
        ))}
      </ul>
      {days.length > shown.length ? <p className="mt-1 text-[11.5px] text-muted-foreground">{days.length - shown.length} more not shown; copy the result for the full list.</p> : null}
    </section>
  );
}

/**
 * Court working days under a court's notified calendar: count in a range, the next court working day, or N court working
 * days after a date. Results that rest on what the calendar does not establish (Saturday sittings, OCR-read dates)
 * require verification and say why.
 */
export function CourtDaysPanel() {
  const [mode, setMode] = React.useState<Mode>("count");
  const [cal, setCal] = React.useState<CalendarChoice>("sample");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [n, setN] = React.useState("");
  const cals = useCourtCalendars();
  const calendar = calendarFor(cal, cals);
  const label = calendarLabel(cal, cals);
  const caveatsKey = calendarCaveats(cal, cals).join("\n");
  const opts = React.useMemo(() => ({ caveats: caveatsKey ? caveatsKey.split("\n") : [] }), [caveatsKey]);

  const count = React.useMemo(() => (mode === "count" && calendar && isValidIsoDate(from) && isValidIsoDate(to) ? countCourtDays(from, to, calendar, opts) : null), [mode, calendar, from, to, opts]);
  const next = React.useMemo(() => (mode === "next" && calendar && isValidIsoDate(from) ? nextCourtDay(from, calendar, opts) : null), [mode, calendar, from, opts]);
  const nNum = /^\d{1,3}$/.test(n.trim()) ? Number(n.trim()) : NaN;
  const added = React.useMemo(() => (mode === "add" && calendar && isValidIsoDate(from) && n.trim() ? addWorkingDays(from, nNum, calendar, opts) : null), [mode, calendar, from, n, nNum, opts]);

  const placeholder = !calendar
    ? "Choose a court calendar. Official calendars appear when the court's holiday list is loaded."
    : mode === "count" ? "Enter both dates to count the court working days under the calendar."
    : mode === "next" ? "Enter a date to find the first court working day on or after it under the calendar."
    : "Enter a date and the number of court working days to add.";

  const nextText = next ? nextCourtDayToText(from, next, label) : null;
  const addText = added ? addWorkingDaysToText(from, n.trim(), added, label) : null;

  return (
    <div>
      <ToolHeader title="Court days" description="Court working days under a court's notified holiday calendar: how many fall between two dates, the next one on or after a date, or the date a number of them later. Weekly offs, holidays and vacations come from the selected calendar only; a Saturday the calendar does not mark closed is flagged, because sitting practice on Saturdays is not in the calendar." />
      <div className="mb-4"><SegmentedControl ariaLabel="What to compute" options={MODES} value={mode} onChange={setMode} /></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CalendarSelect id="cd-cal" value={cal} onChange={setCal} cals={cals} label="Court calendar" allowNone={false} />
        <div className="hidden lg:block" />
        <DateField id="cd-from" label={mode === "count" ? "From (counted)" : mode === "next" ? "On or after" : "Start date (not counted)"} value={from} onChange={setFrom} />
        {mode === "count" ? <DateField id="cd-to" label="To (counted)" value={to} onChange={setTo} /> : null}
        {mode === "add" ? (
          <Field id="cd-n" label="Court working days to add" error={n.trim() && !(nNum >= 1 && nNum <= 500) ? "A whole number from 1 to 500." : null}>
            <Input id="cd-n" size="sm" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value)} className="w-full tabular sm:w-[120px]" />
          </Field>
        ) : null}
      </div>
      <div className="mt-5">
        {mode === "count" && count ? (
          <ResultCard title="Court working days" status={count.status} copyText={courtDaysToText({ from, to }, count, label)}>
            {count.status === "invalid_input" ? <p className="text-[12.5px] text-destructive">{count.notes.join(" ")}</p> : (
              <>
                <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                  <div>
                    <div className="text-[11.5px] text-muted-foreground">Court working days</div>
                    <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.01em] tabular">{count.open ?? "Not determined"}</div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground tabular">of {count.days} calendar day{count.days === 1 ? "" : "s"}, {formatIsoDate(from)} to {formatIsoDate(to)}</div>
                  </div>
                  {count.open != null ? <div className="text-[12px]"><div className="text-[11.5px] text-muted-foreground">Closed under the calendar</div><div className="mt-0.5 font-medium tabular">{count.closed.length} day(s)</div></div> : null}
                </div>
                <ClosedDays days={count.closed} />
              </>
            )}
            <Caveats uncertain={count.uncertain} notes={count.status === "invalid_input" ? [] : count.notes} />
          </ResultCard>
        ) : mode === "next" && next ? (
          <ResultCard title="Next court working day" status={next.status} copyText={nextText}>
            {next.status === "invalid_input" ? <p className="text-[12.5px] text-destructive">{next.notes.join(" ")}</p> : (
              <>
                {next.date ? <KeyDate label="Court working day under the notified calendar" date={next.date} sub={next.skipped.length ? `${next.skipped.length} day(s) skipped` : "the date itself"} /> : <p className="text-[13px] font-medium">Not determined</p>}
                <ClosedDays days={next.skipped} label="Skipped: closed under the calendar" />
              </>
            )}
            <Caveats uncertain={next.uncertain} notes={next.status === "invalid_input" ? [] : next.notes} />
          </ResultCard>
        ) : mode === "add" && added ? (
          <ResultCard title={`${n} court working day(s) later`} status={added.status} copyText={addText}>
            {added.status === "invalid_input" ? <p className="text-[12.5px] text-destructive">{added.notes.join(" ")}</p> : added.date ? <KeyDate label="Date" date={added.date} sub={`${n} court working day(s) after ${formatIsoDate(from)}`} /> : <p className="text-[13px] font-medium">Not determined</p>}
            <Caveats uncertain={added.uncertain} notes={added.status === "invalid_input" ? [] : added.notes} />
          </ResultCard>
        ) : <Placeholder>{placeholder}</Placeholder>}
      </div>
    </div>
  );
}
