"use client";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Matter, PracticeArea } from "@/lib/types/domain";
import type { TeamMember } from "@/modules/workspace/roles";
import { CLIENT_SIDES, MATTER_STATUSES, PRACTICE_AREAS, sideLabel, statusLabel, type MatterInput, type MatterRecord } from "../types";
import { emptyIndiaDraft, IndiaCaseFields, indiaDraftFrom, indiaDraftToInput, validateIndiaDraft, type IndiaDraft } from "./india-case-fields";

const NONE = "__none__";

/** Editable matter fields (strings for inputs; converted to MatterInput on submit). */
export interface MatterDraft {
  name: string;
  shortName: string;
  number: string;
  caption: string;
  client: string;
  clientSide: Matter["clientSide"];
  practiceArea: PracticeArea | "";
  court: string;
  jurisdiction: string;
  judge: string;
  status: Matter["status"];
  stage: string;
  openedAt: string;
  description: string;
  leadAttorneyId: string;
  teamIds: string[];
  /** Indian case particulars (court, case number, CNR, hearings). */
  india: IndiaDraft;
}

export function emptyDraft(): MatterDraft {
  return { name: "", shortName: "", number: "", caption: "", client: "", clientSide: "plaintiff", practiceArea: "", court: "", jurisdiction: "", judge: "", status: "active", stage: "", openedAt: new Date().toISOString().slice(0, 10), description: "", leadAttorneyId: "", teamIds: [], india: emptyIndiaDraft() };
}

export function draftFrom(m: MatterRecord): MatterDraft {
  return {
    name: m.name,
    shortName: m.shortName ?? "",
    number: m.number ?? "",
    caption: m.caption ?? "",
    client: m.client ?? "",
    clientSide: m.clientSide,
    practiceArea: m.practiceArea,
    court: m.court ?? "",
    jurisdiction: m.jurisdiction ?? "",
    judge: m.judge ?? "",
    status: m.status,
    stage: m.stage ?? "",
    openedAt: m.openedAt ?? "",
    description: m.description ?? "",
    leadAttorneyId: m.leadAttorneyId ?? "",
    teamIds: m.teamIds ?? [],
    india: indiaDraftFrom(m.india),
  };
}

/** Full payload for create; for edit the same payload replaces every editable field ("" clears). */
export function draftToInput(d: MatterDraft): MatterInput {
  return {
    name: d.name.trim(),
    shortName: d.shortName.trim(),
    number: d.number.trim(),
    caption: d.caption.trim(),
    client: d.client.trim(),
    clientSide: d.clientSide,
    practiceArea: d.practiceArea || undefined,
    court: d.court.trim(),
    jurisdiction: d.jurisdiction.trim(),
    judge: d.judge.trim(),
    status: d.status,
    stage: d.stage.trim(),
    openedAt: d.openedAt || undefined,
    description: d.description.trim(),
    leadAttorneyId: d.leadAttorneyId || null,
    teamIds: d.teamIds,
    india: indiaDraftToInput(d.india),
  };
}

export type DraftErrors = Partial<Record<keyof MatterDraft | "form" | `india.${string}`, string>>;

export function validateDraft(d: MatterDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.name.trim()) e.name = "Enter the matter name.";
  if (!d.practiceArea) e.practiceArea = "Choose a practice area.";
  Object.assign(e, validateIndiaDraft(d.india));
  return e;
}

/** The matter fields, shared by the New matter dialog and the inspector's edit form. */
export function MatterFields({ draft, onChange, errors, team, idPrefix, compact, collapseDetails }: { draft: MatterDraft; onChange: (d: MatterDraft) => void; errors: DraftErrors; team: TeamMember[] | null; idPrefix: string; compact?: boolean; collapseDetails?: boolean }) {
  const [detailsOpen, setDetailsOpen] = React.useState(!collapseDetails);
  const showDetails = detailsOpen || !!(errors.openedAt || errors.caption || errors.judge || errors.stage);
  const set = <K extends keyof MatterDraft>(k: K, v: MatterDraft[K]) => onChange({ ...draft, [k]: v });
  const id = (k: string) => `${idPrefix}-${k}`;
  const attorneys = (team ?? []).filter((p) => p.firmRole === "Partner" || p.firmRole === "Associate");
  const grid = compact ? "grid grid-cols-2 gap-x-2.5 gap-y-3" : "grid grid-cols-1 gap-3 sm:grid-cols-2";
  const toggleMember = (pid: string, on: boolean) => set("teamIds", on ? Array.from(new Set([...draft.teamIds, pid])) : draft.teamIds.filter((x) => x !== pid));
  return (
    <div className="space-y-3">
      <Field label="Matter name" required htmlFor={id("name")} error={errors.name}>
        <Input id={id("name")} size="sm" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Doe v. Acme Corp." aria-invalid={!!errors.name} />
      </Field>
      <div className={grid}>
        <Field label="Short name" htmlFor={id("short")} help={compact ? undefined : "Shown in pickers and lists."} error={errors.shortName}>
          <Input id={id("short")} size="sm" value={draft.shortName} onChange={(e) => set("shortName", e.target.value)} placeholder="Derived from the name" />
        </Field>
        <Field label="Matter number" htmlFor={id("number")} error={errors.number}>
          <Input id={id("number")} size="sm" value={draft.number} onChange={(e) => set("number", e.target.value)} className="font-mono" aria-invalid={!!errors.number} />
        </Field>
        <Field label="Client" htmlFor={id("client")} error={errors.client}>
          <Input id={id("client")} size="sm" value={draft.client} onChange={(e) => set("client", e.target.value)} />
        </Field>
        <Field label="Client side" htmlFor={id("side")}>
          <Select value={draft.clientSide} onValueChange={(v) => set("clientSide", v as Matter["clientSide"])}>
            <SelectTrigger id={id("side")} size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>{CLIENT_SIDES.map((s) => <SelectItem key={s} value={s}>{sideLabel(s)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Practice area" required htmlFor={id("area")} error={errors.practiceArea}>
          <Select value={draft.practiceArea || undefined} onValueChange={(v) => set("practiceArea", v as PracticeArea)}>
            <SelectTrigger id={id("area")} size="sm" aria-invalid={!!errors.practiceArea}><SelectValue placeholder="Choose" /></SelectTrigger>
            <SelectContent>{PRACTICE_AREAS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Status" htmlFor={id("status")}>
          <Select value={draft.status} onValueChange={(v) => set("status", v as Matter["status"])}>
            <SelectTrigger id={id("status")} size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>{MATTER_STATUSES.map((s) => <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Court / venue" htmlFor={id("court")}>
          <Input id={id("court")} size="sm" value={draft.court} onChange={(e) => set("court", e.target.value)} placeholder="e.g. D.N.J." />
        </Field>
        <Field label="Jurisdiction" htmlFor={id("jur")}>
          <Input id={id("jur")} size="sm" value={draft.jurisdiction} onChange={(e) => set("jurisdiction", e.target.value)} placeholder="e.g. Federal, 3d Cir." />
        </Field>
      </div>
      <IndiaCaseFields draft={draft.india} onChange={(india) => set("india", india)} errors={errors} idPrefix={idPrefix} grid={grid} />
      <Field label="Lead attorney" htmlFor={id("lead")} error={errors.leadAttorneyId} help={team && !attorneys.length ? "Add partners or associates in Settings → Team to assign a lead." : undefined}>
        <Select value={draft.leadAttorneyId || NONE} onValueChange={(v) => set("leadAttorneyId", v === NONE ? "" : v)} disabled={!team}>
          <SelectTrigger id={id("lead")} size="sm"><SelectValue placeholder={team ? "None" : "Loading team…"} /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}><span className="text-muted-foreground">None</span></SelectItem>
            {attorneys.map((p) => <SelectItem key={p.id} value={p.id} textValue={p.name}>{p.name}{p.title && <span className="ml-1.5 text-[11px] text-muted-foreground">{p.title}</span>}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Team" error={errors.teamIds} help={team && team.length <= 1 ? "Only you so far. Add colleagues in Settings → Team." : undefined}>
        {!team ? (
          <p className="text-[12px] text-muted-foreground">Loading team…</p>
        ) : (
          <div className={cn("max-h-40 overflow-y-auto rounded-md border", !team.length && "border-dashed")} role="group" aria-label="Team members">
            {team.length === 0 && <p className="px-2.5 py-2 text-[12px] text-muted-foreground">No team members yet.</p>}
            {team.map((p) => {
              const on = draft.teamIds.includes(p.id) || draft.leadAttorneyId === p.id;
              return (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 border-b px-2.5 py-1.5 text-[12.5px] last:border-b-0 hover:bg-muted/40">
                  <Checkbox size="sm" checked={on} disabled={draft.leadAttorneyId === p.id} onCheckedChange={(v) => toggleMember(p.id, v === true)} />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{p.title ?? p.firmRole}</span>
                </label>
              );
            })}
          </div>
        )}
      </Field>
      {showDetails ? (
        <>
          <div className={grid}>
            <Field label="Caption" htmlFor={id("caption")}>
              <Input id={id("caption")} size="sm" value={draft.caption} onChange={(e) => set("caption", e.target.value)} placeholder="e.g. No. 2:26-cv-01234" />
            </Field>
            <Field label="Judge" htmlFor={id("judge")}>
              <Input id={id("judge")} size="sm" value={draft.judge} onChange={(e) => set("judge", e.target.value)} />
            </Field>
            <Field label="Stage" htmlFor={id("stage")}>
              <Input id={id("stage")} size="sm" value={draft.stage} onChange={(e) => set("stage", e.target.value)} placeholder="e.g. Pleadings, Discovery" />
            </Field>
            <Field label="Opened" htmlFor={id("opened")} error={errors.openedAt}>
              <Input id={id("opened")} size="sm" type="date" value={draft.openedAt} onChange={(e) => set("openedAt", e.target.value)} className="tabular" />
            </Field>
          </div>
          <Field label="Description" htmlFor={id("desc")}>
            <Textarea id={id("desc")} value={draft.description} onChange={(e) => set("description", e.target.value)} className="min-h-[64px] text-[12.5px]" placeholder="Claims, posture, anything the team should know." />
          </Field>
        </>
      ) : (
        <button type="button" onClick={() => setDetailsOpen(true)} className="text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline cursor-pointer">More details: caption, judge, stage, opened date, description</button>
      )}
    </div>
  );
}
