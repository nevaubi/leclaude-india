"use client";
import * as React from "react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Chip } from "@/components/ui/misc";
import { isValidIsoDate } from "@/lib/india/holidays";
import { arbitrationSetAsideTimeline, chequeDishonourTimeline, computeLimitation, LIMITATION_RULES, limitationRule, type LimitationRule } from "@/lib/india/limitation";
import { arbitrationToText, chequeToText, condonableText, formatIsoDate, limitationToText, s4Text } from "../lib";
import { CalendarSelect, calendarFor, calendarLabel, Caveats, DateField, Field, KeyDate, Placeholder, ResultCard, StepsList, ToolHeader, type CalendarChoice } from "./shared";
import { useCourtCalendars } from "./use-court-calendars";

const GROUPS: { proceeding: LimitationRule["proceeding"]; label: string }[] = [
  { proceeding: "suit", label: "Suits" },
  { proceeding: "appeal", label: "Appeals" },
  { proceeding: "revision", label: "Revisions" },
  { proceeding: "review", label: "Reviews" },
  { proceeding: "application", label: "Applications" },
  { proceeding: "complaint", label: "Complaints" },
  { proceeding: "petition", label: "Petitions" },
];

const periodText = (r: LimitationRule) => (r.period ? `${r.period.n} ${r.period.n === 1 ? r.period.unit.slice(0, -1) : r.period.unit}` : "no fixed period");

function S4Line({ s4 }: { s4: Parameters<typeof s4Text>[0] }) {
  const warn = s4 === "not_checked" || s4 === "calendar_unknown";
  return <Chip tone={warn ? "warning" : "info"} className="h-auto whitespace-normal py-0.5 leading-snug">{s4Text(s4)}</Chip>;
}

export function LimitationPanel() {
  const [ruleId, setRuleId] = React.useState("art-116a");
  const [from, setFrom] = React.useState("");
  const [applied, setApplied] = React.useState("");
  const [ready, setReady] = React.useState("");
  const [cal, setCal] = React.useState<CalendarChoice>("none");
  const cals = useCourtCalendars();
  const calendar = calendarFor(cal, cals);
  const rule = limitationRule(ruleId)!;

  // Copy dates count only for rules with the s.12(2) exclusion; one date without the other is incomplete, not ignored.
  const copyIncomplete = rule.copyExclusion && !!applied !== !!ready;
  const result = React.useMemo(() => {
    if (!isValidIsoDate(from) || copyIncomplete) return null;
    const certifiedCopy = rule.copyExclusion && applied && ready ? { appliedOn: applied, readyOn: ready } : undefined;
    return computeLimitation({ ruleId, from, calendar, certifiedCopy });
  }, [ruleId, rule.copyExclusion, from, applied, ready, calendar, copyIncomplete]);
  const last = result?.adjustedLastDay ?? result?.lastDay;

  return (
    <div>
      <ToolHeader title="Limitation calculator" description="Last day for filing under a coded article or section, with each step's authority. Days are counted excluding the first day (s.12(1)); certified-copy time is excluded for appeals, revisions and reviews (s.12(2))." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Field id="lim-rule" label="Proceeding" hint={<><span className="text-foreground">{rule.authority}</span> · {periodText(rule)} from {rule.runsFrom}</>} className="lg:col-span-2">
          <Select value={ruleId} onValueChange={setRuleId}>
            <SelectTrigger id="lim-rule" size="sm" className="w-full max-w-[560px]"><SelectValue>{rule.title}</SelectValue></SelectTrigger>
            <SelectContent className="max-h-[360px]">
              {GROUPS.map((g) => {
                const rules = LIMITATION_RULES.filter((r) => r.proceeding === g.proceeding);
                if (!rules.length) return null;
                return (
                  <SelectGroup key={g.proceeding}>
                    <SelectLabel className="text-[11px] text-muted-foreground">{g.label}</SelectLabel>
                    {rules.map((r) => (
                      <SelectItem key={r.id} value={r.id} textValue={r.title}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{r.title}</span>
                          <span className="truncate text-[11px] text-muted-foreground">{r.authority} · {periodText(r)}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
        </Field>
        <DateField id="lim-from" label="Period runs from" value={from} onChange={setFrom} hint={`The period runs from ${rule.runsFrom}.`} />
        <CalendarSelect id="lim-cal" value={cal} onChange={setCal} cals={cals} />
        {rule.copyExclusion ? (
          <>
            <DateField id="lim-applied" label="Certified copy applied for" optional value={applied} onChange={setApplied} />
            <DateField id="lim-ready" label="Certified copy ready for delivery" optional value={ready} onChange={setReady} hint={copyIncomplete ? "Give both dates to exclude the copying time." : undefined} />
          </>
        ) : null}
      </div>

      <div className="mt-5">
        {!result ? (
          <Placeholder>{from && !isValidIsoDate(from) ? "Enter a full start date." : copyIncomplete ? "Give both certified-copy dates, or clear them." : "Enter the date the period runs from to compute the last day."}</Placeholder>
        ) : (
          <ResultCard title={rule.title} status={result.status} copyText={limitationToText(rule, result, calendarLabel(cal, cals))}>
            {result.status === "invalid_input" ? (
              <p className="text-[12.5px] text-destructive">{result.notes.join(" ")}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                  {result.status === "no_fixed_period" ? (
                    <div className="text-[14px] font-medium">No fixed period of limitation</div>
                  ) : (
                    <KeyDate label="Last day for filing" date={last} sub={result.adjustedLastDay && result.adjustedLastDay !== result.lastDay ? <>period ended {formatIsoDate(result.lastDay)}</> : undefined} />
                  )}
                  {result.excludedDays ? <div className="text-[12px]"><div className="text-[11.5px] text-muted-foreground">Copy time excluded</div><div className="mt-0.5 font-medium tabular">{result.excludedDays} day(s)</div></div> : null}
                </div>
                <div className="mt-3 flex flex-col items-start gap-1.5">
                  {result.status !== "no_fixed_period" ? <S4Line s4={result.s4} /> : null}
                  <Chip tone={result.condonable === false ? "muted" : "info"} className="h-auto whitespace-normal py-0.5 leading-snug">{condonableText(result.condonable)}</Chip>
                </div>
                <StepsList steps={result.steps} />
              </>
            )}
            <Caveats uncertain={result.uncertain} notes={result.status === "invalid_input" ? [] : result.notes} />
          </ResultCard>
        )}
      </div>
    </div>
  );
}

export function ChequePanel() {
  const [info, setInfo] = React.useState("");
  const [received, setReceived] = React.useState("");
  const [cal, setCal] = React.useState<CalendarChoice>("none");
  const cals = useCourtCalendars();
  const calendar = calendarFor(cal, cals);
  const result = React.useMemo(() => {
    const okInfo = isValidIsoDate(info), okRec = isValidIsoDate(received);
    if (!okInfo && !okRec) return null;
    return chequeDishonourTimeline({ dishonourInformationOn: okInfo ? info : undefined, noticeReceivedOn: okRec ? received : undefined, calendar });
  }, [info, received, calendar]);
  const last = result?.adjustedComplaintLastDay ?? result?.complaintLastDay;

  return (
    <div>
      <ToolHeader title="Cheque dishonour (s.138 NI Act)" description="Demand notice, payment window and complaint dates under ss.138 and 142 of the Negotiable Instruments Act, 1881. Either date alone gives the dates that follow from it." />
      <div className="grid gap-4 lg:grid-cols-2">
        <DateField id="chq-info" label="Information of dishonour received from the bank" optional value={info} onChange={setInfo} hint="Starts the 30 days for the demand notice." />
        <DateField id="chq-notice" label="Demand notice received by the drawer" optional value={received} onChange={setReceived} hint="Starts the drawer's 15 days to pay." />
        <CalendarSelect id="chq-cal" value={cal} onChange={setCal} cals={cals} />
      </div>
      <div className="mt-5">
        {!result ? (
          <Placeholder>Enter the date the bank&apos;s dishonour memo was received, the date the drawer received the notice, or both.</Placeholder>
        ) : (
          <ResultCard title="Cheque dishonour timeline" status={result.status} copyText={chequeToText(result, calendarLabel(cal, cals))}>
            {result.status === "invalid_input" ? <p className="text-[12.5px] text-destructive">{result.notes.join(" ")}</p> : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <KeyDate label="Demand notice by" date={result.noticeDeadline} sub="s.138(b)" />
                  <KeyDate label="Payment window ends" date={result.paymentWindowEnds} sub="s.138(c)" />
                  <KeyDate label="Earliest complaint" date={result.earliestComplaint} />
                  <KeyDate label="Complaint last day" date={last} sub="s.142(1)(b)" />
                </div>
                {result.complaintLastDay && !calendar ? <div className="mt-3"><S4Line s4="not_checked" /></div> : null}
                {!isValidIsoDate(received) ? <p className="mt-3 text-[12px] text-muted-foreground">Add the date the drawer received the notice for the payment window and complaint dates.</p> : null}
                <StepsList steps={result.steps} />
              </>
            )}
            <Caveats uncertain={result.uncertain} notes={result.status === "invalid_input" ? [] : result.notes} />
          </ResultCard>
        )}
      </div>
    </div>
  );
}

export function ArbitrationPanel() {
  const [received, setReceived] = React.useState("");
  const [cal, setCal] = React.useState<CalendarChoice>("none");
  const cals = useCourtCalendars();
  const calendar = calendarFor(cal, cals);
  const result = React.useMemo(() => (isValidIsoDate(received) ? arbitrationSetAsideTimeline(received, calendar) : null), [received, calendar]);
  const last = result?.adjustedLastDay ?? result?.lastDay;
  return (
    <div>
      <ToolHeader title="Arbitration award set-aside (s.34)" description="Three months from receipt of the award under s.34(3) of the Arbitration and Conciliation Act, 1996, and the outer limit of a further 30 days on sufficient cause, “but not thereafter”. Section 5 of the Limitation Act does not apply." />
      <div className="grid gap-4 lg:grid-cols-2">
        <DateField id="arb-received" label="Arbitral award received" value={received} onChange={setReceived} hint="Or the date a s.33 request was disposed of." />
        <CalendarSelect id="arb-cal" value={cal} onChange={setCal} cals={cals} />
      </div>
      <div className="mt-5">
        {!result ? (
          <Placeholder>{received ? "Enter a full date." : "Enter the date the applicant received the award."}</Placeholder>
        ) : (
          <ResultCard title="Application to set aside an arbitral award" status={result.status} copyText={arbitrationToText(result, calendarLabel(cal, cals))}>
            {result.status === "invalid_input" ? <p className="text-[12.5px] text-destructive">{result.notes.join(" ")}</p> : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <KeyDate label="Three months end" date={last} sub={result.adjustedLastDay && result.adjustedLastDay !== result.lastDay ? <>period ended {formatIsoDate(result.lastDay)}</> : "s.34(3)"} />
                  <KeyDate label="Outer limit (not extendable)" date={result.outerLimit} sub="s.34(3) proviso; delay must be explained" tone="destructive" />
                </div>
                <div className="mt-3"><S4Line s4={result.s4} /></div>
                <StepsList steps={result.steps} />
              </>
            )}
            <Caveats uncertain={result.uncertain} notes={result.status === "invalid_input" ? [] : result.notes} />
          </ResultCard>
        )}
      </div>
    </div>
  );
}
