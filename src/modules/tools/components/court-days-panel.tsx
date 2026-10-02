"use client";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/form";
import { isValidIsoDate } from "@/lib/india/holidays";
import { addWorkingDays, countCourtDays, courtDaysToText, DECISION_SUPPORT_FOOTER, formatIsoDate, nextCourtDay, statusText, type CalendarChoice } from "../lib";
import { CalendarSelect, calendarFor, calendarLabel, Caveats, DateField, Field, KeyDate, Placeholder, ResultCard, ToolHeader } from "./shared";
import { useCourtCalendars } from "./use-court-calendars";

type Mode = "count" | "next" | "add";

const MODES: { value: Mode; label: string }[] = [
  { value: "count", label: "Count between dates" },
  { value: "next", label: "Next sitting day" },
  { value: "add", label: "Add working days" },
];

function ClosedDays({ days }: { days: { date: string; reason: string }[] }) {
  if (!days.length) return null;
  const shown = days.slice(0, 60);
  return (
    <section aria-label="Days the court does not sit" className="mt-4">
      <h4 className="mb-1.5 text-[12px] font-medium text-muted-foreground">Days the court does not sit ({days.length})</h4>
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

/** Court working days under a court's calendar: count in a range, next sitting day, or N working days after a date. */
export function CourtDaysPanel() {
  const [mode, setMode] = React.useState<Mode>("count");
  const [cal, setCal] = React.useState<CalendarChoice>("sample");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [n, setN] = React.useState("");
  const cals = useCourtCalendars();
  const calendar = calendarFor(cal, cals);
  const label = calendarLabel(cal, cals);

  const count = React.useMemo(() => (mode === "count" && calendar && isValidIsoDate(from) && isValidIsoDate(to) ? countCourtDays(from, to, calendar) : null), [mode, calendar, from, to]);
  const next = React.useMemo(() => (mode === "next" && calendar && isValidIsoDate(from) ? nextCourtDay(from, calendar) : null), [mode, calendar, from]);
  const nNum = /^\d{1,3}$/.test(n.trim()) ? Number(n.trim()) : NaN;
  const added = React.useMemo(() => (mode === "add" && calendar && isValidIsoDate(from) && n.trim() ? addWorkingDays(from, nNum, calendar) : null), [mode, calendar, from, n, nNum]);

  const placeholder = !calendar
    ? "Choose a court calendar. Official calendars appear when the court's holiday list is loaded."
    : mode === "count" ? "Enter both dates to count the days the court sits."
    : mode === "next" ? "Enter a date to find the first day on or after it on which the court sits."
    : "Enter a date and the number of working days to add.";

  const nextText = next ? [`Next sitting day on or after ${formatIsoDate(from)}`, `Status: ${statusText(next.status)}`, `Calendar: ${label}`, next.date ? `Next sitting day: ${formatIsoDate(next.date)} (${next.date})` : "Next sitting day: not determined", ...(next.skipped.length ? ["", "Skipped:", ...next.skipped.map((d) => `- ${d.date}: ${d.reason}`)] : []), ...(next.notes.length ? ["", ...next.notes] : []), "", DECISION_SUPPORT_FOOTER].join("\n") : null;
  const addText = added ? [`${n} court working day(s) after ${formatIsoDate(from)}`, `Status: ${statusText(added.status)}`, `Calendar: ${label}`, added.date ? `Result: ${formatIsoDate(added.date)} (${added.date})` : "Result: not determined", ...(added.notes.length ? ["", ...added.notes] : []), "", DECISION_SUPPORT_FOOTER].join("\n") : null;

  return (
    <div>
      <ToolHeader title="Court days" description="Working days of a court under its notified holiday calendar: how many days it sits between two dates, the next day it sits, or a date a number of working days later. Weekly offs, holidays and vacations come from the selected calendar only." />
      <div className="mb-4"><SegmentedControl ariaLabel="What to compute" options={MODES} value={mode} onChange={setMode} /></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CalendarSelect id="cd-cal" value={cal} onChange={setCal} cals={cals} label="Court calendar" allowNone={false} />
        <div className="hidden lg:block" />
        <DateField id="cd-from" label={mode === "count" ? "From (counted)" : mode === "next" ? "On or after" : "Start date (not counted)"} value={from} onChange={setFrom} />
        {mode === "count" ? <DateField id="cd-to" label="To (counted)" value={to} onChange={setTo} /> : null}
        {mode === "add" ? (
          <Field id="cd-n" label="Working days to add" error={n.trim() && !(nNum >= 1 && nNum <= 500) ? "A whole number from 1 to 500." : null}>
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
                    <div className="text-[11.5px] text-muted-foreground">Working days</div>
                    <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.01em] tabular">{count.open ?? "Not determined"}</div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground tabular">of {count.days} calendar day{count.days === 1 ? "" : "s"}, {formatIsoDate(from)} to {formatIsoDate(to)}</div>
                  </div>
                  {count.open != null ? <div className="text-[12px]"><div className="text-[11.5px] text-muted-foreground">Court does not sit</div><div className="mt-0.5 font-medium tabular">{count.closed.length} day(s)</div></div> : null}
                </div>
                <ClosedDays days={count.closed} />
              </>
            )}
            <Caveats uncertain={count.unknown ? [`The calendar cannot answer for ${count.unknown.date}: ${count.unknown.reason}.`] : []} notes={count.status === "invalid_input" ? [] : count.notes.filter((x) => !x.startsWith("The calendar cannot"))} />
          </ResultCard>
        ) : mode === "next" && next ? (
          <ResultCard title="Next sitting day" status={next.status} copyText={nextText}>
            {next.status === "invalid_input" ? <p className="text-[12.5px] text-destructive">{next.notes.join(" ")}</p> : (
              <>
                {next.date ? <KeyDate label="Court sits on" date={next.date} sub={next.skipped.length ? `${next.skipped.length} day(s) skipped` : "the date itself"} /> : <p className="text-[13px] font-medium">Not determined</p>}
                <ClosedDays days={next.skipped} />
              </>
            )}
            <Caveats uncertain={next.date ? [] : next.notes} notes={next.date ? next.notes : []} />
          </ResultCard>
        ) : mode === "add" && added ? (
          <ResultCard title={`${n} working day(s) later`} status={added.status} copyText={addText}>
            {added.status === "invalid_input" ? <p className="text-[12.5px] text-destructive">{added.notes.join(" ")}</p> : added.date ? <KeyDate label="Date" date={added.date} sub={`${n} working day(s) after ${formatIsoDate(from)}`} /> : <p className="text-[13px] font-medium">Not determined</p>}
            <Caveats uncertain={added.status === "requires_verification" && !added.date ? added.notes : []} notes={added.date ? added.notes : []} />
          </ResultCard>
        ) : <Placeholder>{placeholder}</Placeholder>}
      </div>
    </div>
  );
}
