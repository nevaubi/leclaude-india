"use client";
import * as React from "react";
import Link from "next/link";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Chip } from "@/components/ui/misc";
import { isValidIsoDate } from "@/lib/india/holidays";
import { LIMITATION_RULES, limitationRule, type LimitationRule } from "@/lib/india/limitation";
import { condonableText, condonationDelay, delayNote, delayToText, formatIsoDate } from "../lib";
import { Caveats, DateField, Field, KeyDate, Placeholder, ResultCard, ToolHeader } from "./shared";

const NONE = "none";
const GROUPS: { proceeding: LimitationRule["proceeding"]; label: string }[] = [
  { proceeding: "appeal", label: "Appeals" }, { proceeding: "revision", label: "Revisions" }, { proceeding: "review", label: "Reviews" },
  { proceeding: "application", label: "Applications" }, { proceeding: "complaint", label: "Complaints" }, { proceeding: "petition", label: "Petitions" }, { proceeding: "suit", label: "Suits" },
];

/** Delay between the last day of limitation and the filing date, with a plain note; no outcome prediction. */
export function CondonationPanel() {
  const [lastDay, setLastDay] = React.useState("");
  const [filedOn, setFiledOn] = React.useState("");
  const [ruleId, setRuleId] = React.useState(NONE);
  const rule = ruleId === NONE ? null : limitationRule(ruleId);
  const result = React.useMemo(() => (isValidIsoDate(lastDay) && isValidIsoDate(filedOn) ? condonationDelay(lastDay, filedOn) : null), [lastDay, filedOn]);
  const condonable = rule ? rule.condonable : undefined;

  return (
    <div>
      <ToolHeader title="Condonation of delay" description={<>Days of delay between the last day of limitation and the date of filing, for an application to condone delay. Work out the last day first with the <Link href="/tools?tool=limitation" className="text-foreground/85 underline-offset-2 hover:underline">limitation calculator</Link>. Whether the delay is condoned is for the court; nothing here predicts it.</>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <DateField id="cod-last" label="Last day of limitation" value={lastDay} onChange={setLastDay} hint="After any s.4 court-closed and s.12 exclusions." />
        <DateField id="cod-filed" label="Date of filing" value={filedOn} onChange={setFiledOn} />
        <Field id="cod-rule" label={<>Proceeding<span className="ml-1 font-normal text-muted-foreground">(optional)</span></>} hint={rule ? <><span className="text-foreground">{rule.authority}</span> · {condonableText(rule.condonable)}</> : "Choose one to see whether s.5 of the Limitation Act can extend time for it."} className="lg:col-span-2">
          <Select value={ruleId} onValueChange={setRuleId}>
            <SelectTrigger id="cod-rule" size="sm" className="w-full max-w-[560px]"><SelectValue>{rule ? rule.title : "Not specified"}</SelectValue></SelectTrigger>
            <SelectContent className="max-h-[360px]">
              <SelectItem value={NONE}>Not specified</SelectItem>
              {GROUPS.map((g) => {
                const rules = LIMITATION_RULES.filter((r) => r.proceeding === g.proceeding);
                if (!rules.length) return null;
                return (
                  <SelectGroup key={g.proceeding}>
                    <SelectLabel className="text-[11px] text-muted-foreground">{g.label}</SelectLabel>
                    {rules.map((r) => <SelectItem key={r.id} value={r.id} textValue={r.title}>{r.title}</SelectItem>)}
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="mt-5">
        {!result ? (
          <Placeholder>{(lastDay && !isValidIsoDate(lastDay)) || (filedOn && !isValidIsoDate(filedOn)) ? "Enter both dates in full." : "Enter the last day of limitation and the date of filing."}</Placeholder>
        ) : (
          <ResultCard title="Delay in filing" copyText={delayToText({ lastDay, filedOn, proceeding: rule?.title, authority: rule?.authority }, result, condonable)}>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <div className="text-[11.5px] text-muted-foreground">Delay</div>
                <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.01em] tabular">{result.status === "delayed" ? `${result.days} day${result.days === 1 ? "" : "s"}` : "None"}</div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">{result.status === "delayed" ? `after ${formatIsoDate(lastDay)}` : "filed within time"}</div>
              </div>
              <KeyDate label="Filed on" date={filedOn} />
            </div>
            {rule ? <div className="mt-3"><Chip tone={rule.condonable === false ? "muted" : "info"} className="h-auto whitespace-normal py-0.5 leading-snug">{condonableText(rule.condonable)}</Chip></div> : null}
            <p className="mt-3 max-w-[72ch] text-[12.5px] leading-snug text-foreground/85">{delayNote(result, condonable)}</p>
            <Caveats uncertain={rule?.uncertain ?? []} notes={[...result.notes, ...(rule?.notes ?? [])]} />
          </ResultCard>
        )}
      </div>
    </div>
  );
}
