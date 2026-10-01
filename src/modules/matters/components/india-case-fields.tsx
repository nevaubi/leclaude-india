"use client";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/form";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { courtById } from "@/lib/india/courts";
import { CITIES } from "@/lib/india/forums";
import { CAUSE_LIST_STATUSES, INDIA_STAGES, caseTypesFor, courtOptions, formatCaseNumber, validateCnr, type CauseListStatus, type IndianCaseInfo } from "../india";

const NONE = "__none__";

/** Editable Indian case particulars (strings for inputs). */
export interface IndiaDraft {
  cityId: string;
  courtId: string;
  benchId: string;
  caseType: string;
  caseNumber: string;
  caseYear: string;
  cnr: string;
  courtHall: string;
  nextHearing: string;
  hearingPurpose: string;
  causeStatus: CauseListStatus | "";
  causeItem: string;
  offenceDate: string;
}

export function emptyIndiaDraft(): IndiaDraft {
  return { cityId: "", courtId: "", benchId: "", caseType: "", caseNumber: "", caseYear: "", cnr: "", courtHall: "", nextHearing: "", hearingPurpose: "", causeStatus: "", causeItem: "", offenceDate: "" };
}

export function indiaDraftFrom(i: IndianCaseInfo | undefined): IndiaDraft {
  if (!i) return emptyIndiaDraft();
  return {
    cityId: i.cityId ?? "", courtId: i.courtId ?? "", benchId: i.benchId ?? "", caseType: i.caseType ?? "", caseNumber: i.caseNumber ?? "", caseYear: i.caseYear ? String(i.caseYear) : "",
    cnr: i.cnr ?? "", courtHall: i.courtHall ?? "", nextHearing: i.nextHearing ?? "", hearingPurpose: i.hearingPurpose ?? "",
    causeStatus: i.causeList?.status ?? "", causeItem: i.causeList?.item ? String(i.causeList.item) : "", offenceDate: i.offenceDate ?? "",
  };
}

/** Payload for the API: null when nothing is filled (clears stored particulars on edit). */
export function indiaDraftToInput(d: IndiaDraft): IndianCaseInfo | null {
  const out: IndianCaseInfo = {};
  if (d.cityId) out.cityId = d.cityId;
  if (d.courtId) out.courtId = d.courtId;
  if (d.benchId) out.benchId = d.benchId;
  if (d.caseType.trim()) out.caseType = d.caseType.trim();
  if (d.caseNumber.trim()) out.caseNumber = d.caseNumber.trim();
  if (d.caseYear.trim()) out.caseYear = Number(d.caseYear.trim());
  if (d.cnr.trim()) out.cnr = d.cnr.trim();
  if (d.courtHall.trim()) out.courtHall = d.courtHall.trim();
  if (d.nextHearing) out.nextHearing = d.nextHearing;
  if (d.hearingPurpose.trim()) out.hearingPurpose = d.hearingPurpose.trim();
  if (d.offenceDate) out.offenceDate = d.offenceDate;
  if (d.causeStatus) out.causeList = { status: d.causeStatus, ...(d.causeItem.trim() ? { item: Number(d.causeItem.trim()) } : {}) };
  return Object.keys(out).length ? out : null;
}

export function validateIndiaDraft(d: IndiaDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (d.caseNumber.trim() && !/^\d{1,7}$/.test(d.caseNumber.trim())) e["india.caseNumber"] = "Digits only; type and year are separate.";
  if (d.caseYear.trim() && !/^(19|20)\d{2}$/.test(d.caseYear.trim())) e["india.caseYear"] = "Four-digit year.";
  if (d.cnr.trim()) { const v = validateCnr(d.cnr, d.courtId); if (!v.ok) e["india.cnr"] = v.error; }
  return e;
}

/**
 * Court, bench, case type/number/year, CNR, court hall, next hearing and cause-list status. Courts come from the
 * registry (focus States first); the case-type list follows the chosen court.
 */
export function IndiaCaseFields({ draft, onChange, errors, idPrefix, grid }: { draft: IndiaDraft; onChange: (d: IndiaDraft) => void; errors: Record<string, string | undefined>; idPrefix: string; grid: string }) {
  const set = <K extends keyof IndiaDraft>(k: K, v: IndiaDraft[K]) => onChange({ ...draft, [k]: v });
  const id = (k: string) => `${idPrefix}-in-${k}`;
  // Choosing a city narrows the court list to that city's forums (plus the Supreme Court); a court already chosen
  // outside the city stays selectable so an existing matter is never silently changed.
  const groups = React.useMemo(() => courtOptions(draft.cityId || null, draft.courtId || null), [draft.cityId, draft.courtId]);
  const court = courtById(draft.courtId);
  const benches = court?.benches ?? [];
  const types = caseTypesFor(draft.courtId);
  const cnrCheck = draft.cnr.trim() ? validateCnr(draft.cnr, draft.courtId) : null;
  const preview = formatCaseNumber(draft.caseType, draft.caseNumber, draft.caseYear);
  return (
    <div className="space-y-3 rounded-md border border-line-quiet p-2.5">
      <Field label="City" htmlFor={id("city")} error={errors["india.cityId"]} help="Filters the court list to forums in the city.">
        <Select value={draft.cityId || NONE} onValueChange={(v) => set("cityId", v === NONE ? "" : v)}>
          <SelectTrigger id={id("city")} size="sm"><SelectValue placeholder="Any city" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}><span className="text-muted-foreground">Any city</span></SelectItem>
            {CITIES.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Court" htmlFor={id("court")} error={errors["india.courtId"]}>
        <Select value={draft.courtId || NONE} onValueChange={(v) => onChange({ ...draft, courtId: v === NONE ? "" : v, benchId: "", caseType: caseTypesFor(v).some((t) => t.code === draft.caseType) ? draft.caseType : "" })}>
          <SelectTrigger id={id("court")} size="sm"><SelectValue placeholder="Choose a court" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}><span className="text-muted-foreground">None</span></SelectItem>
            {groups.map((g) => (
              <SelectGroup key={g.group}>
                <SelectLabel>{g.group}</SelectLabel>
                {g.options.map((o) => <SelectItem key={o.id} value={o.id} textValue={o.label}>{o.label}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className={grid}>
        {benches.length > 1 && (
          <Field label="Bench" htmlFor={id("bench")} error={errors["india.benchId"]}>
            <Select value={draft.benchId || NONE} onValueChange={(v) => set("benchId", v === NONE ? "" : v)}>
              <SelectTrigger id={id("bench")} size="sm"><SelectValue placeholder="Principal bench" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}><span className="text-muted-foreground">Not set</span></SelectItem>
                {benches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name} ({b.city})</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field label="Case type" htmlFor={id("type")} error={errors["india.caseType"]}>
          {types.length ? (
            <Select value={draft.caseType || NONE} onValueChange={(v) => set("caseType", v === NONE ? "" : v)}>
              <SelectTrigger id={id("type")} size="sm"><SelectValue placeholder="Choose" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}><span className="text-muted-foreground">Not set</span></SelectItem>
                {types.map((t) => <SelectItem key={t.code} value={t.code} textValue={t.code}>{t.code} <span className="ml-1 text-[11px] text-muted-foreground">{t.label}</span></SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <Input id={id("type")} size="sm" value={draft.caseType} onChange={(e) => set("caseType", e.target.value)} placeholder="e.g. O.S." />
          )}
        </Field>
        <div className="grid grid-cols-[1fr_72px] gap-1.5">
          <Field label="Number" htmlFor={id("num")} error={errors["india.caseNumber"]}>
            <Input id={id("num")} size="sm" inputMode="numeric" value={draft.caseNumber} onChange={(e) => set("caseNumber", e.target.value)} className="tabular" placeholder="4521" />
          </Field>
          <Field label="Year" htmlFor={id("year")} error={errors["india.caseYear"]}>
            <Input id={id("year")} size="sm" inputMode="numeric" value={draft.caseYear} onChange={(e) => set("caseYear", e.target.value)} className="tabular" placeholder="2024" />
          </Field>
        </div>
        <Field label="CNR" htmlFor={id("cnr")} error={errors["india.cnr"]} help={cnrCheck?.ok && cnrCheck.warning ? cnrCheck.warning : undefined}>
          <Input id={id("cnr")} size="sm" value={draft.cnr} onChange={(e) => set("cnr", e.target.value.toUpperCase())} className="font-mono" placeholder={court?.cnrPrefix ? `${court.cnrPrefix}01…` : "16 characters"} maxLength={20} />
        </Field>
        <Field label="Court hall" htmlFor={id("hall")}>
          <Input id={id("hall")} size="sm" value={draft.courtHall} onChange={(e) => set("courtHall", e.target.value)} placeholder="e.g. Court Hall 12" />
        </Field>
        <Field label="Next hearing" htmlFor={id("next")}>
          <Input id={id("next")} size="sm" type="date" value={draft.nextHearing} onChange={(e) => set("nextHearing", e.target.value)} className="tabular" />
        </Field>
        <Field label="Cause list" htmlFor={id("cl")} error={errors["india.causeList"]}>
          <div className="grid grid-cols-[1fr_64px] gap-1.5">
            <Select value={draft.causeStatus || NONE} onValueChange={(v) => set("causeStatus", v === NONE ? "" : (v as CauseListStatus))}>
              <SelectTrigger id={id("cl")} size="sm"><SelectValue placeholder="Not checked" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}><span className="text-muted-foreground">Not checked</span></SelectItem>
                {CAUSE_LIST_STATUSES.filter((s) => s.id !== "unknown").map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input aria-label="Item number" size="sm" inputMode="numeric" value={draft.causeItem} onChange={(e) => set("causeItem", e.target.value)} className="tabular" placeholder="Item" disabled={draft.causeStatus !== "listed"} />
          </div>
        </Field>
      </div>
      <Field label="Purpose of next hearing" htmlFor={id("purpose")}>
        <Input id={id("purpose")} size="sm" value={draft.hearingPurpose} onChange={(e) => set("hearingPurpose", e.target.value)} placeholder="e.g. Cross-examination of DW-1" list={`${idPrefix}-in-stages`} />
        <datalist id={`${idPrefix}-in-stages`}>{INDIA_STAGES.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      {types.some((t) => t.kind === "criminal" || t.kind === "appeal_criminal") && (
        <Field label="Date of offence" htmlFor={id("offence")} help="Decides IPC or BNS (offences from 1 July 2024 fall under BNS).">
          <Input id={id("offence")} size="sm" type="date" value={draft.offenceDate} onChange={(e) => set("offenceDate", e.target.value)} className="tabular" />
        </Field>
      )}
      {preview && <p className="text-[11.5px] text-muted-foreground">Cause title: <span className="font-medium text-foreground">{preview}</span></p>}
    </div>
  );
}
