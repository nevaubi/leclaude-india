"use client";
import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { Chip } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { isValidIsoDate } from "@/lib/india/holidays";
import { applicableCode, applicableEvidenceCode, CORRESPONDENCE_SOURCE, mapSection, NEW_CODES_IN_FORCE } from "@/lib/india/criminal-code-map";
import { applicableToText, mappingRows, mappingRowsToTsv, parseSectionList, type MappingRow } from "../lib";
import { CopyButton, DateField, Field, Placeholder, ResultCard, StatusChip, ToolHeader } from "./shared";

const EXAMPLE = "IPC 420\n302 IPC\nu/s 498-A IPC\nCrPC 438\nBNS 318\nIEA 65B";

function MappingTable({ rows }: { rows: MappingRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[640px] border-collapse text-left text-[12.5px]">
        <caption className="sr-only">Section correspondence</caption>
        <thead className="bg-muted/50 text-[11.5px] text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-1.5 font-medium">Input</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Status</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Corresponding provision(s)</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Subject and notes</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r, i) => {
            const res = r.result;
            return (
              <tr key={i} className="align-top">
                <td className="px-3 py-2">
                  <div className="font-medium tabular">{r.query ? `${r.query.code} ${res?.query.section ?? r.query.section}` : r.input}</div>
                  {r.query && r.input !== `${r.query.code} ${r.query.section}` ? <div className="mt-0.5 text-[11px] text-muted-foreground">line {r.lineNo}: {r.input}</div> : null}
                </td>
                <td className="px-3 py-2">
                  {res ? (
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip status={res.status} />
                      {res.confidence === "medium" ? <Chip tone="warning" title="A clause-level detail of this row could not be confirmed by the maintainers">medium confidence</Chip> : null}
                    </div>
                  ) : <Chip tone="destructive">unreadable</Chip>}
                </td>
                <td className="px-3 py-2">
                  {!res ? <span className="text-muted-foreground">—</span> : res.status === "unmapped" ? (
                    <span className="text-muted-foreground">Not in the coded table</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {res.candidates.map((c) => (
                        <li key={`${c.code}-${c.section}`} className="tabular"><span className="font-medium">{c.code} {c.section}</span>{c.note ? <span className="text-muted-foreground"> ({c.note})</span> : null}</li>
                      ))}
                      {res.status === "split" ? <li className="text-[11px] text-muted-foreground">Choose on the facts; no single successor.</li> : null}
                    </ul>
                  )}
                </td>
                <td className="px-3 py-2">
                  {res?.subject ? <div>{res.subject}</div> : null}
                  {(res?.notes ?? (r.error ? [r.error] : [])).map((n, j) => <div key={j} className={cn("mt-0.5 text-[11.5px] leading-snug", r.error ? "text-destructive" : "text-muted-foreground")}>{n}</div>)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ApplicableHelper() {
  const [range, setRange] = React.useState(false);
  const [offence, setOffence] = React.useState("");
  const [offenceTo, setOffenceTo] = React.useState("");
  const [proceeding, setProceeding] = React.useState("");

  const offenceArg = range ? (isValidIsoDate(offence) && isValidIsoDate(offenceTo) ? { from: offence, to: offenceTo } : null) : isValidIsoDate(offence) ? offence : null;
  const ready = offenceArg !== null || isValidIsoDate(proceeding);
  const res = ready ? applicableCode(offenceArg, isValidIsoDate(proceeding) ? { proceedingInitiated: proceeding } : {}) : null;
  const ev = isValidIsoDate(proceeding) ? applicableEvidenceCode(proceeding) : undefined;
  const offenceLabel = range ? `${offence} to ${offenceTo}` : offence;
  const show = (v: string) => (v === "requires_review" ? "Requires review" : v);

  return (
    <section aria-labelledby="applicable-h" className="mt-8">
      <h3 id="applicable-h" className="text-[13px] font-medium">Which code applies</h3>
      <p className="mt-0.5 max-w-[72ch] text-[12px] text-muted-foreground">The BNS, BNSS and BSA came into force on {NEW_CODES_IN_FORCE}. The offence date decides the substantive law (Constitution, Art. 20(1)); the date the proceeding was initiated decides procedure (BNSS s.531) and evidence (BSA s.170).</p>
      <div className="mt-3 grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-2">
          <DateField id="app-offence" label={range ? "Offence from" : "Date of offence"} value={offence} onChange={setOffence} />
          <div className="flex items-center gap-2">
            <Checkbox id="app-range" size="sm" checked={range} onCheckedChange={(v) => setRange(v === true)} />
            <Label htmlFor="app-range" className="text-[12px] font-normal">Continuing offence (date range)</Label>
          </div>
        </div>
        {range ? <DateField id="app-offence-to" label="Offence to" value={offenceTo} onChange={setOffenceTo} /> : null}
        <DateField id="app-proceeding" label="Proceeding initiated" optional value={proceeding} onChange={setProceeding} hint="For example, the date the FIR was registered or the complaint was filed." />
      </div>
      <div className="mt-4">
        {!res ? (
          <Placeholder>Enter the date of the offence, the date the proceeding was initiated, or both.</Placeholder>
        ) : (
          <ResultCard title="Governing codes" status={res.substantive === "requires_review" || res.procedure === "requires_review" || (res.procedure === "BNSS" && res.substantive !== "BNS") || ev?.code === "requires_review" ? "requires_verification" : undefined} copyText={applicableToText(offenceArg ? offenceLabel : "", isValidIsoDate(proceeding) ? proceeding : "", res, ev)}>
            <dl className="grid gap-4 sm:grid-cols-3">
              <div><dt className="text-[11.5px] text-muted-foreground">Substantive law</dt><dd className="mt-0.5 text-[17px] font-semibold">{show(res.substantive)}</dd></div>
              <div><dt className="text-[11.5px] text-muted-foreground">Procedure</dt><dd className="mt-0.5 text-[17px] font-semibold">{res.procedure ? show(res.procedure) : <span className="text-[12.5px] font-normal text-muted-foreground">Give the proceeding date</span>}</dd></div>
              <div><dt className="text-[11.5px] text-muted-foreground">Evidence</dt><dd className="mt-0.5 text-[17px] font-semibold">{ev ? show(ev.code) : <span className="text-[12.5px] font-normal text-muted-foreground">Give the proceeding date</span>}</dd></div>
            </dl>
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[12px] leading-snug text-muted-foreground">
              {res.notes.map((n, i) => <li key={i}>{n}</li>)}
              {ev ? <li>{ev.note}</li> : null}
            </ul>
          </ResultCard>
        )}
      </div>
    </section>
  );
}

export function CodePanel() {
  const [text, setText] = React.useState("");
  const parsed = React.useMemo(() => parseSectionList(text), [text]);
  const rows = React.useMemo(() => mappingRows(parsed.lines, (q) => mapSection(q.code, q.section)), [parsed]);
  const counts = React.useMemo(() => {
    const c = { mapped: 0, split: 0, unmapped: 0, unreadable: 0 };
    for (const r of rows) c[r.result ? r.result.status : "unreadable"]++;
    return c;
  }, [rows]);

  return (
    <div>
      <ToolHeader title="Criminal code converter" description="IPC ↔ BNS, CrPC ↔ BNSS and Indian Evidence Act ↔ BSA for commonly litigated provisions. Splits list every candidate; a section outside the coded table is reported as unmapped, never approximated." />
      <Field id="code-input" label="Sections, one per line" hint={<>For example “IPC 420”, “302 IPC”, “u/s 498-A IPC”, “ss. 420, 406 r/w 120B IPC”, “CrPC 438” or “BNS 318(4)”. <button type="button" className="text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none" onClick={() => setText(EXAMPLE)}>Fill an example</button></>}>
        <Textarea id="code-input" value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false} placeholder={"IPC 420\nCrPC 438"} className="max-w-[560px] font-mono text-[12.5px]" aria-describedby="code-input-hint" />
      </Field>
      <div className="mt-5">
        {!rows.length ? (
          <Placeholder>Enter one or more sections with their code to see the corresponding provisions.</Placeholder>
        ) : (
          <section aria-label="Results" aria-live="polite">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span className="tabular">{counts.mapped} mapped</span>·<span className="tabular">{counts.split} split</span>·<span className={cn("tabular", counts.unmapped && "text-destructive")}>{counts.unmapped} unmapped</span>
              {counts.unreadable ? <>·<span className="tabular text-destructive">{counts.unreadable} unreadable</span></> : null}
              {parsed.truncated ? <span className="text-destructive">Only the first 200 lines are converted.</span> : null}
              <div className="flex-1" />
              <CopyButton text={mappingRowsToTsv(rows)} label="Copy table" />
            </div>
            <MappingTable rows={rows} />
            <p className="mt-2 text-[11.5px] text-muted-foreground">Source: {CORRESPONDENCE_SOURCE}. Rows marked medium confidence carry a clause-level detail that could not be confirmed.</p>
          </section>
        )}
      </div>
      <ApplicableHelper />
    </div>
  );
}
