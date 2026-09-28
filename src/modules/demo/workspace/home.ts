/**
 * Demo tasks, calendar events and team updates for the three India matters. Due dates and hearings are relative to
 * the load time (court working days) so the home page always shows a realistic mix; historical facts are fixed.
 */
import type { CalendarEvent, Task, TeamUpdate } from "@/lib/types/domain";
import { DEMO_ID_PREFIX, DEMO_MATTERS, DEMO_TEAM } from "../ids";
import { at, businessDay, dayOffset, hoursAgo, type DemoBuildContext } from "./context";

const C = DEMO_MATTERS.commercial;
const W = DEMO_MATTERS.writ;
const B = DEMO_MATTERS.bail;
const J = DEMO_TEAM.junior;
const K = DEMO_TEAM.clerk;

const ed = (m: string, view?: string) => `/ediscovery?matter=${m}${view ? `&view=${view}` : ""}`;

type Who = "owner" | "junior" | "clerk";
type TaskSpec = Omit<Task, "id" | "createdAt" | "updatedAt" | "dueAt" | "assigneeId" | "createdById" | "matterId"> & { key: string; due: number; who: Who; by?: Who; matter: string; age: number };

const TASKS: TaskSpec[] = [
  { key: "written_args", matter: C, title: "Written arguments — Com.O.S. 1187/2023", description: "Structure by issue. Issue 1: Ex.P9 + DW-1's admissions and late qualification (cite both); Ex.P13 and clause 9.3. Issue 3: Ex.P5, Ex.P8, Ex.D8 and clause 11.4. Issues 4–5: clause 12.3 and Ex.D10 (2022 figure includes closed stores). Every exhibit cite by mark.", due: 5, who: "junior", by: "owner", status: "in_progress", priority: "urgent", tags: ["arguments"], source: "manual", age: 96, links: [{ label: "Conflicts", href: ed(C, "conflicts") }] },
  { key: "limitation_note", matter: C, title: "Limitation note — effect of Ex.P14 and the part payment (Ex.P20)", description: "Run the limitation check: Article, start date, s.18 acknowledgement (05.04.2023) and s.19 part payment (12.04.2023). The defendant has not pleaded limitation, but the court examines it (s.3). Show the engine's status as returned.", due: 2, who: "junior", status: "todo", priority: "high", tags: ["limitation"], source: "manual", age: 30 },
  { key: "ex_list", matter: C, title: "Prepare exhibit index Ex.P1–P25 / Ex.D1–D18 with page references for arguments", description: "Use the saved search 'Plaintiff's exhibits Ex.P1 to Ex.P25'. Note Ex.D10 and Ex.D13 were marked subject to objection (mode of proof).", due: 3, who: "clerk", by: "junior", status: "todo", priority: "high", tags: ["exhibits"], source: "manual", age: 20, links: [{ label: "Documents", href: ed(C) }] },
  { key: "kannada_tr", matter: C, title: "Check the translation of Ex.D11 against the Kannada original", description: "The defendant's translation of the Hubballi store manager's letter omits nothing material on a first read; confirm the times (10 a.m. to 1.30 p.m.) and the ₹3.2 lakh figure. The Kannada original is the text of record.", due: -1, who: "junior", status: "in_progress", priority: "medium", tags: ["translation", "Kannada"], source: "manual", age: 50 },
  { key: "first_pass", matter: C, title: "Finish first-pass review of routine project documents", description: "Batch 'First pass — routine project documents'. Flag anything on acceptance, delay or the Ugadi outages.", due: 6, who: "clerk", status: "in_progress", priority: "medium", tags: ["review"], source: "manual", age: 70 },
  { key: "reply_affidavit", matter: W, title: "Reply affidavit to the municipality's counter — W.P. 18234/2026", description: "Answer the 2024 revised FTL map point; rely on the municipality's own survey report (building about 38 m from the FTL) and the absence of any survey with the notice. Annex the Telugu survey report with the translation.", due: 3, who: "owner", by: "clerk", status: "todo", priority: "urgent", tags: ["writ", "reply"], source: "manual", age: 36 },
  { key: "ftl_map", matter: W, title: "Obtain certified copy of the notified FTL map and buffer width", description: "The conflict between the notice and the survey report turns on the buffer width and the map relied on. Apply for certified copies; do not assert the buffer width until the notification is read.", due: 2, who: "clerk", status: "todo", priority: "high", tags: ["writ", "records"], source: "manual", age: 24 },
  { key: "bail_hearing", matter: B, title: "Bail hearing — Crl.P. 7710/2026 (listed, item 37)", description: "Carry: FIR, survey report (Telugu + translation), wound certificate, Sessions Court order, status-quo order in the writ, surety papers. Offence date 12.08.2026: BNS/BNSS.", due: 2, who: "owner", by: "clerk", status: "todo", priority: "urgent", tags: ["bail", "hearing"], source: "manual", age: 12, links: [{ label: "Bail record", href: ed(B) }] },
  { key: "jail_vakalat", matter: B, title: "Collect vakalat signed by the accused (jail visit)", description: "Chanchalguda Central Prison — confirm the interview slot with the jail superintendent's office.", due: -2, who: "clerk", status: "done", priority: "high", tags: ["bail", "vakalat"], source: "manual", age: 140 },
  { key: "cause_list", matter: B, title: "Check tomorrow's cause list for Crl.P. 7710/2026", description: "Confirm court hall and item number the evening before; the cause-list watch workflow posts it to the team.", due: 1, who: "clerk", status: "todo", priority: "medium", tags: ["cause list"], source: "workflow", age: 6 },
];

export function buildDemoTasks(ctx: DemoBuildContext): Task[] {
  const person: Record<Who, string> = { owner: ctx.ownerId, junior: J, clerk: K };
  return TASKS.map((t) => {
    const { key, due, who, by, matter, age, ...rest } = t;
    const createdAt = hoursAgo(ctx.now, age);
    return { ...rest, id: `${DEMO_ID_PREFIX}task_${key}`, matterId: matter, assigneeId: person[who], createdById: by ? person[by] : undefined, dueAt: dayOffset(ctx.now, due), createdAt, updatedAt: rest.status === "todo" ? createdAt : hoursAgo(ctx.now, Math.max(1, Math.floor(age / 3))) };
  });
}

/** Hearings and internal deadlines (court working days relative to the load time). */
export function buildDemoEvents(ctx: DemoBuildContext): CalendarEvent[] {
  const team = [ctx.ownerId, J, K];
  const day = (n: number) => businessDay(ctx.now, n);
  const ev = (e: Omit<CalendarEvent, "id"> & { key: string }): CalendarEvent => { const { key, ...rest } = e; return { ...rest, id: `${DEMO_ID_PREFIX}ev_${key}` }; };
  return [
    ev({ key: "bail_hearing", matterId: B, title: "Crl.P. 7710/2026 — bail hearing (item 37)", startsAt: at(day(3), "10:30"), endsAt: at(day(3), "13:30"), kind: "hearing", location: "High Court for the State of Telangana, Hyderabad", attendeeIds: [ctx.ownerId, K], ruleSource: "BNSS s.483" }),
    ev({ key: "written_args", matterId: C, title: "File written arguments — Com.O.S. 1187/2023", startsAt: at(day(6), "10:00"), kind: "deadline", location: "Commercial Court, Bengaluru", attendeeIds: team, ruleSource: "Order sheet 24.08.2026" }),
    ev({ key: "args", matterId: C, title: "Com.O.S. 1187/2023 — further arguments", startsAt: at(day(9), "11:00"), endsAt: at(day(9), "13:00"), kind: "hearing", location: "Commercial Court, Bengaluru", attendeeIds: [ctx.ownerId, J], ruleSource: "CPC Order XVIII Rule 2" }),
    ev({ key: "reply_due", matterId: W, title: "W.P. 18234/2026 — reply affidavit due", startsAt: at(day(4), "10:00"), kind: "deadline", location: "High Court for the State of Telangana, Hyderabad", attendeeIds: [ctx.ownerId, K] }),
    ev({ key: "writ_hearing", matterId: W, title: "W.P. 18234/2026 — hearing on interim relief", startsAt: at(day(12), "10:30"), kind: "hearing", location: "High Court for the State of Telangana, Hyderabad", attendeeIds: [ctx.ownerId, K], ruleSource: "Constitution of India, Art. 226" }),
    ev({ key: "team_call", title: "Weekly matters call — Bengaluru and Hyderabad teams", startsAt: at(day(1), "18:00"), endsAt: at(day(1), "18:30"), kind: "internal", location: "Video call", attendeeIds: team }),
  ];
}

export function buildDemoUpdates(ctx: DemoBuildContext): TeamUpdate[] {
  const u = (key: string, authorId: string, body: string, hours: number, matterId?: string, kind: TeamUpdate["kind"] = "update"): TeamUpdate => ({ id: `${DEMO_ID_PREFIX}upd_${key}`, authorId, body, matterId, createdAt: hoursAgo(ctx.now, hours), kind });
  return [
    u("dw1_conflict", J, "Nimbus v. Tungabhadra: DW-1 admitted sending Ex.P9 and that the pilot went live on it (20.01.2025), then called it 'not a final acceptance' on 17.02.2025. Both are flagged in the transcript and in Conflicts — cite both in the written arguments.", 20, C),
    u("survey_report", K, "Sarojini Devi writ: the municipality's own survey report (Telugu, 12.08.2026) says the house is about 38 m from the FTL and records only an 'objection' and an 'argument' by the son. Translation filed. Useful for the bail petition too.", 30, W),
    u("bail_listed", K, "Crl.P. 7710/2026 is listed at item 37. Vakalat collected from Chanchalguda.", 5, B, "win"),
    u("kn_letter", J, "Ex.D11 (Hubballi store manager, Kannada) says 10 a.m. to 1.30 p.m.; our incident report and the WhatsApp export (Ex.P16, Kannada) say 10:05–11:20. The defendant's own audit (Ex.D5) ties 8 of 11 interruptions to store network outages.", 52, C),
  ];
}
