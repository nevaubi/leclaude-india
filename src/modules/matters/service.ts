import "server-only";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import { currentPrincipal } from "@/lib/auth/context";
import { hasMatterAccess } from "@/lib/auth/policy";
import type { Matter } from "@/lib/types/domain";
import { slugify } from "@/lib/utils";
import { ServiceError } from "@/modules/workspace/errors";
import type { PersonRecord } from "@/modules/workspace/service";
import { CLIENT_SIDES, MATTER_STATUSES, PRACTICE_AREAS, type MatterInput, type MatterRecord, type MatterRow, type MatterStatusFilter } from "./types";
import { resolveCaseType } from "@/lib/india/procedure";
import { cityById } from "@/lib/india/forums";
import { CAUSE_LIST_STATUSES, caseTitle, caseTypesFor, courtName, formatCaseNumber, resolveCourt, validateCnr, type IndianCaseInfo } from "./india";

/**
 * Matters: the unit every other module scopes to (documents, depositions, research, office documents).
 * A new matter starts empty: no sample content, no invented issue codes. E-discovery issue codes, custodians and
 * saved searches are created by the team when they need them (the review surfaces render their empty states).
 * Matters are archived (a status change), never hard-deleted, so evidence and audit references stay resolvable.
 */

const MAX = { name: 240, shortName: 60, number: 60, caption: 200, client: 160, court: 160, jurisdiction: 120, judge: 120, stage: 80, description: 4000 } as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function matters() {
  // Same "matters" collection as db().matters, typed with this module's bookkeeping fields.
  return db().collection<MatterRecord>("matters");
}

function people() {
  return db().collection<PersonRecord>("people");
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/[ \t]+/g, " ");
  return t ? t.slice(0, max) : undefined;
}

function isTeamPerson(p: PersonRecord | null): p is PersonRecord {
  return !!p && (p.role === "attorney" || p.role === "paralegal" || p.role === "staff");
}

function normNumber(n: string): string {
  return n.trim().toLowerCase().replace(/\s+/g, "");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function deriveShortName(name: string): string {
  const s = name.replace(/^in re:?\s+/i, "").replace(/\s+(products liability|litigation)$/i, "").trim();
  return (s.length > MAX.shortName ? `${s.slice(0, MAX.shortName - 1).trimEnd()}…` : s) || name.slice(0, MAX.shortName);
}

function uniqueSlug(name: string, exceptId?: string): string {
  const base = slugify(name).slice(0, 48).replace(/-+$/g, "") || "matter";
  const taken = new Set(matters().all().filter((m) => m.id !== exceptId).map((m) => m.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${nanoid(6).toLowerCase()}`;
}

function newMatterId(slug: string): string {
  const id = `m_${slug.replace(/-/g, "_").slice(0, 40)}`;
  return matters().has(id) ? `${id}_${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x")}` : id;
}

type Validated = Partial<Omit<MatterRecord, "id" | "slug" | "createdAt" | "updatedAt" | "archivedAt" | "india">> & { leadAttorneyId?: string | undefined; clearLead?: boolean; india?: IndianCaseInfo | null };

/**
 * Validate Indian case particulars. The court must be in the registry (or the focus-city forum list): an unknown court
 * is rejected, never mapped to the nearest one. The bench must belong to the court; the case type must be one the
 * court uses (or a type the user typed that is not blank); the CNR must be well-formed.
 */
function validateIndia(raw: unknown, fields: Record<string, string>): IndianCaseInfo | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) { fields.india = "Case particulars must be an object."; return undefined; }
  const r = raw as Record<string, unknown>;
  const out: IndianCaseInfo = {};
  const cityId = str(r.cityId, 40);
  if (cityId) {
    // Unknown city ids are rejected, never mapped to the nearest city.
    if (!cityById(cityId)) fields["india.cityId"] = `Unknown city "${cityId}". Choose a city from the list.`;
    else out.cityId = cityId;
  }
  const courtId = str(r.courtId, 40);
  if (courtId) {
    const court = resolveCourt(courtId);
    if (!court) fields["india.courtId"] = `Unknown court "${courtId}". Choose a court from the list.`;
    else {
      out.courtId = courtId;
      const benchId = str(r.benchId, 40);
      if (benchId) {
        const benches = court.kind === "court" ? court.court.benches : [];
        if (!benches.some((b) => b.id === benchId)) fields["india.benchId"] = `Bench "${benchId}" does not sit in ${court.kind === "court" ? court.court.name : court.forum.name}.`;
        else out.benchId = benchId;
      }
    }
  }
  const caseType = str(r.caseType, 24);
  if (caseType) {
    const known = caseTypesFor(out.courtId);
    // The court's own list first, then the registry's alias table ("wp" → "W.P."); an unknown label is kept as typed.
    out.caseType = known.find((t) => t.code.toLowerCase() === caseType.toLowerCase())?.code ?? resolveCaseType(caseType)?.abbr ?? caseType;
  }
  const caseNumber = str(r.caseNumber, 12);
  if (caseNumber) {
    if (!/^\d{1,7}$/.test(caseNumber)) fields["india.caseNumber"] = "Case number must be digits (the type and year are separate fields).";
    else out.caseNumber = caseNumber.replace(/^0+(?=\d)/, "");
  }
  if (r.caseYear !== undefined && r.caseYear !== null && r.caseYear !== "") {
    const y = Number(r.caseYear);
    if (!Number.isInteger(y) || y < 1950 || y > new Date().getUTCFullYear() + 1) fields["india.caseYear"] = "Case year must be a four-digit year.";
    else out.caseYear = y;
  }
  const cnr = str(r.cnr, 24);
  if (cnr) {
    const v = validateCnr(cnr, out.courtId);
    if (!v.ok) fields["india.cnr"] = v.error;
    else out.cnr = v.cnr;
  }
  const hall = str(r.courtHall, 40);
  if (hall) out.courtHall = hall;
  for (const k of ["nextHearing", "lastHearing", "offenceDate"] as const) {
    const v = str(r[k], 10);
    if (!v) continue;
    if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) fields[`india.${k}`] = "Dates must be YYYY-MM-DD.";
    else out[k] = v;
  }
  const purpose = str(r.hearingPurpose, 120);
  if (purpose) out.hearingPurpose = purpose;
  if (r.causeList && typeof r.causeList === "object") {
    const cl = r.causeList as Record<string, unknown>;
    const status = CAUSE_LIST_STATUSES.find((x) => x.id === cl.status)?.id;
    if (!status) fields["india.causeList"] = "Unknown cause-list status.";
    else {
      const item = cl.item === undefined || cl.item === null || cl.item === "" ? undefined : Number(cl.item);
      if (item !== undefined && (!Number.isInteger(item) || item < 1 || item > 5000)) fields["india.causeList"] = "Item number must be a whole number.";
      const listDate = str(cl.listDate, 10);
      if (listDate && !DATE_RE.test(listDate)) fields["india.causeList"] = "List date must be YYYY-MM-DD.";
      out.causeList = { status, ...(item !== undefined ? { item } : {}), ...(listDate ? { listDate } : {}), checkedAt: new Date().toISOString(), source: "manual" };
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validate a create (partial=false) or a patch (partial=true). Unknown team ids and a lead who is not an active
 * firm attorney are rejected (never silently dropped or swapped for someone else).
 */
function validate(input: Record<string, unknown>, partial: boolean, current?: MatterRecord): Validated {
  const fields: Record<string, string> = {};
  const out: Validated = {};
  let duplicate: string | undefined;
  const has = (k: string) => input[k] !== undefined;

  if (!partial || has("name")) {
    const name = str(input.name, MAX.name);
    if (!name) fields.name = "Enter the matter name.";
    else out.name = name;
  }
  if (has("shortName")) out.shortName = str(input.shortName, MAX.shortName);
  if (has("number")) {
    const number = str(input.number, MAX.number);
    out.number = number;
    if (number) {
      const n = normNumber(number);
      const clash = matters().findOne((m) => m.id !== current?.id && !!m.number && normNumber(m.number) === n);
      if (clash) duplicate = `Matter number ${number} is already used by ${clash.shortName || clash.name}.`;
    }
  }
  for (const k of ["caption", "client", "court", "jurisdiction", "judge", "stage", "description"] as const) {
    if (has(k)) out[k] = str(input[k], MAX[k]);
  }
  if (!partial || has("clientSide")) {
    const v = input.clientSide ?? "other";
    if (!CLIENT_SIDES.includes(v as Matter["clientSide"])) fields.clientSide = `Client side must be one of ${CLIENT_SIDES.join(", ")}.`;
    else out.clientSide = v as Matter["clientSide"];
  }
  if (!partial || has("practiceArea")) {
    const v = input.practiceArea;
    if (!PRACTICE_AREAS.includes(v as Matter["practiceArea"])) fields.practiceArea = "Choose a practice area.";
    else out.practiceArea = v as Matter["practiceArea"];
  }
  if (!partial || has("status")) {
    const v = input.status ?? "active";
    if (!MATTER_STATUSES.includes(v as Matter["status"])) fields.status = `Status must be one of ${MATTER_STATUSES.join(", ")}.`;
    else out.status = v as Matter["status"];
  }
  if (has("india")) {
    const india = validateIndia(input.india, fields);
    if (india !== undefined) out.india = india;
  }
  if (has("openedAt")) {
    const v = str(input.openedAt, 10);
    if (v && (!DATE_RE.test(v) || Number.isNaN(Date.parse(v)))) fields.openedAt = "Opened date must be YYYY-MM-DD.";
    else if (v) out.openedAt = v;
  }

  const previousTeam = new Set(current?.teamIds ?? []);
  if (has("teamIds")) {
    const raw = input.teamIds;
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) fields.teamIds = "Team must be a list of people.";
    else {
      const ids = Array.from(new Set((raw as string[]).map((x) => x.trim()).filter(Boolean)));
      const unknown = ids.filter((id) => {
        const p = people().get(id);
        // Existing members stay valid even after deactivation; new members must be active firm people.
        return !isTeamPerson(p) || (p.active === false && !previousTeam.has(id));
      });
      if (unknown.length) fields.teamIds = `Unknown or inactive team member${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`;
      else out.teamIds = ids;
    }
  }
  if (has("leadAttorneyId")) {
    const v = input.leadAttorneyId;
    if (v === null || v === "") out.clearLead = true;
    else if (typeof v !== "string") fields.leadAttorneyId = "Lead attorney must be a person id.";
    else {
      const p = people().get(v);
      if (!isTeamPerson(p) || p.role !== "attorney") fields.leadAttorneyId = "The lead must be a firm attorney.";
      else if (p.active === false && current?.leadAttorneyId !== v) fields.leadAttorneyId = `${p.name} is inactive.`;
      else out.leadAttorneyId = v;
    }
  }
  if (Object.keys(fields).length) throw new ServiceError(422, Object.values(fields)[0]!, { ...fields, ...(duplicate ? { number: duplicate } : {}) }, "invalid");
  if (duplicate) throw new ServiceError(409, duplicate, { number: duplicate }, "duplicate_number");
  if (!partial && !out.shortName && out.name) out.shortName = deriveShortName(out.name);
  // Court and caption default from the case particulars when the user did not type them.
  if (out.india) {
    if (!out.court && !current?.court) out.court = courtName(out.india.courtId) ?? undefined;
    if (!out.caption && !current?.caption) out.caption = formatCaseNumber(out.india.caseType, out.india.caseNumber, out.india.caseYear) || undefined;
  }
  return out;
}

function toRow(m: MatterRecord): MatterRow {
  const ppl = people();
  const lead = m.leadAttorneyId ? ppl.get(m.leadAttorneyId) : null;
  return {
    ...m,
    leadAttorneyName: lead?.name,
    team: (m.teamIds ?? []).map((id) => ppl.get(id)).filter((p): p is PersonRecord => !!p).map((p) => ({ id: p.id, name: p.name, title: p.title })),
    archived: !!m.archivedAt,
  };
}

function matchesStatus(m: MatterRecord, status: MatterStatusFilter): boolean {
  switch (status) {
    case "all": return true;
    case "archived": return !!m.archivedAt;
    case "open": return !m.archivedAt;
    default: return !m.archivedAt && m.status === status;
  }
}

/** Matters the current principal may see, filtered and newest-first. An unauthenticated caller sees nothing. */
export function listMatters(opts: { status?: MatterStatusFilter; q?: string } = {}): MatterRow[] {
  const principal = currentPrincipal();
  if (!principal) return [];
  const status = opts.status ?? "open";
  const q = opts.q?.trim().toLowerCase();
  return matters()
    .all()
    .filter((m) => hasMatterAccess(principal, m.id))
    .filter((m) => matchesStatus(m, status))
    .map(toRow)
    .filter((m) => !q || [m.name, m.shortName, m.number, m.client, m.court, m.caption, m.jurisdiction, m.judge, m.leadAttorneyName, m.india?.cnr, caseTitle(m.india)].some((v) => v?.toLowerCase().includes(q)))
    .sort((a, b) => (b.updatedAt ?? b.openedAt ?? "").localeCompare(a.updatedAt ?? a.openedAt ?? "") || a.name.localeCompare(b.name));
}

export function getMatter(id: string): MatterRow | null {
  const m = matters().get(id);
  return m ? toRow(m) : null;
}

export function createMatter(input: MatterInput | Record<string, unknown>): MatterRow {
  const v = validate(input as Record<string, unknown>, false);
  const principal = currentPrincipal();
  const now = new Date().toISOString();
  const slug = uniqueSlug(v.name!);
  const creator = principal ? people().get(principal.id) : null;
  const team = new Set(v.teamIds ?? []);
  if (v.leadAttorneyId) team.add(v.leadAttorneyId);
  // The creator joins the team so "my matters" views (home, intel) include the new matter.
  if (isTeamPerson(creator) && creator.active !== false) team.add(creator.id);
  const record: MatterRecord = {
    id: newMatterId(slug),
    slug,
    name: v.name!,
    shortName: v.shortName ?? deriveShortName(v.name!),
    number: v.number,
    caption: v.caption,
    client: v.client ?? "",
    clientSide: v.clientSide ?? "other",
    practiceArea: v.practiceArea!,
    court: v.court,
    jurisdiction: v.jurisdiction,
    judge: v.judge,
    status: v.status ?? "active",
    stage: v.stage,
    description: v.description,
    openedAt: v.openedAt ?? today(),
    teamIds: Array.from(team),
    leadAttorneyId: v.leadAttorneyId,
    ...(v.india ? { india: v.india } : {}),
    keyDates: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
    createdById: principal?.id,
  };
  matters().put(record);
  audit("create", { kind: "matter", id: record.id, label: record.name, matterId: record.id }, { number: record.number, practiceArea: record.practiceArea, status: record.status });
  return toRow(record);
}

export function updateMatter(id: string, input: MatterInput | Record<string, unknown>): MatterRow {
  const cur = matters().get(id);
  if (!cur) throw new ServiceError(404, "Matter not found", undefined, "not_found");
  const raw = input as Record<string, unknown>;
  const v = validate(raw, true, cur);
  const { clearLead, india, ...patch } = v;
  const next: MatterRecord = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([k]) => raw[k] !== undefined)), updatedAt: new Date().toISOString() };
  if (clearLead) next.leadAttorneyId = undefined;
  if (india === null) next.india = undefined;
  else if (india) next.india = india;
  if (next.leadAttorneyId && !next.teamIds.includes(next.leadAttorneyId)) next.teamIds = [...next.teamIds, next.leadAttorneyId];
  if (!next.shortName) next.shortName = deriveShortName(next.name);
  if (next.name !== cur.name) next.slug = uniqueSlug(next.name, id);
  // PATCH { archived: false } restores an archived matter.
  if (raw.archived === false && cur.archivedAt) next.archivedAt = undefined;
  matters().put(next);
  const changed = Object.keys(raw).filter((k) => raw[k] !== undefined);
  audit("update", { kind: "matter", id, label: next.name, matterId: id }, { fields: changed });
  return toRow(next);
}

/** Archive: status becomes closed and the matter leaves the open list; every record it scopes is kept. */
export function archiveMatter(id: string): MatterRow {
  const cur = matters().get(id);
  if (!cur) throw new ServiceError(404, "Matter not found", undefined, "not_found");
  if (cur.archivedAt) return toRow(cur);
  const now = new Date().toISOString();
  const next: MatterRecord = { ...cur, status: "closed", archivedAt: now, updatedAt: now };
  matters().put(next);
  audit("update", { kind: "matter", id, label: next.name, matterId: id }, { archived: true, previousStatus: cur.status });
  return toRow(next);
}
