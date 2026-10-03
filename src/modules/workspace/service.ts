import "server-only";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import { getWorkspace, saveWorkspace } from "@/lib/workspace";
import { rolesForPerson } from "@/lib/auth/principal";
import type { Principal, Role } from "@/lib/auth/types";
import type { Person } from "@/lib/types/domain";
import { slugify } from "@/lib/utils";
import { ServiceError } from "./errors";
import { EMAIL_RE, FIRM_ROLE_PERSON, FIRM_ROLES, isFirmRole, TEAM_PERSON_ROLES, type FirmRole, type TeamMember, type WorkspaceView } from "./roles";

/**
 * First-run setup, the workspace profile and the firm team (people who work matters: attorneys, paralegals,
 * staff). People are never hard-deleted: other records (matters, coding, audit) reference their ids, so a
 * departing member is deactivated instead.
 */

/** Stored person with the workspace bookkeeping fields this module adds. */
export const DEFAULT_FIRM_ID = "firm_default";

export type PersonRecord = Person & {
  firmRole?: FirmRole;
  firmId?: string;
  /** Explicit matter scope assigned by a platform admin. When absent, legacy role/team rules apply. */
  matterScope?: "*" | string[];
  /** Cross-firm provisioning rights. The workspace owner is always treated as a platform admin. */
  platformAdmin?: boolean;
  active?: boolean;
  deactivatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

const PLATFORM_TO_FIRM: Partial<Record<Role, FirmRole>> = { partner: "Partner", associate: "Associate", paralegal: "Paralegal", litigation_support: "Litigation support", admin: "Admin" };
const FIRM_TO_PLATFORM: Record<FirmRole, Role> = { Partner: "partner", Associate: "associate", Paralegal: "paralegal", "Litigation support": "litigation_support", Admin: "admin" };

const MAX = { name: 120, email: 200, title: 80, firm: 160 } as const;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : undefined;
}

function isTeamPerson(p: Person): boolean {
  return TEAM_PERSON_ROLES.includes(p.role);
}

function isActive(p: PersonRecord): boolean {
  return p.active !== false;
}

export function firmRoleOf(p: PersonRecord): FirmRole | null {
  if (p.firmRole && isFirmRole(p.firmRole)) return p.firmRole;
  const r = rolesForPerson(p)[0];
  return (r && PLATFORM_TO_FIRM[r]) ?? null;
}

/**
 * The title stored on the person. Platform roles are derived from `role` + `title`, so a custom title is kept
 * only when it maps to the same platform role as the chosen firm role ("Managing Partner" for Partner is fine,
 * "Partner" for Associate is not); otherwise the firm role's default title is used.
 */
export function titleForRole(firmRole: FirmRole, custom?: string): string {
  const base = FIRM_ROLE_PERSON[firmRole];
  if (custom && rolesForPerson({ role: base.role, title: custom })[0] === FIRM_TO_PLATFORM[firmRole]) return custom;
  return base.title;
}

export function toMember(p: PersonRecord, ownerId = getWorkspace().owner?.id): TeamMember {
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    title: p.title,
    firmRole: firmRoleOf(p),
    firmId: p.firmId ?? DEFAULT_FIRM_ID,
    firmName: p.organization,
    matterScope: p.matterScope,
    platformAdmin: p.platformAdmin === true || p.id === ownerId,
    active: isActive(p),
    owner: p.id === ownerId,
    deactivatedAt: p.deactivatedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function people() {
  // Same "people" collection as db().people, typed with this module's bookkeeping fields.
  return db().collection<PersonRecord>("people");
}

function newPersonId(name: string): string {
  const base = slugify(name).slice(0, 24).replace(/-+$/g, "") || "member";
  const id = `p_${base.replace(/-/g, "_")}`;
  return people().has(id) ? `${id}_${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x")}` : id;
}

function emailTaken(email: string, exceptId?: string): boolean {
  const e = email.toLowerCase();
  return people().all().some((p) => p.id !== exceptId && isTeamPerson(p) && isActive(p) && p.email?.toLowerCase() === e);
}

interface MemberInput {
  name?: unknown;
  email?: unknown;
  role?: unknown;
  firmRole?: unknown;
  title?: unknown;
}

interface ValidMember {
  name?: string;
  email?: string;
  firmRole?: FirmRole;
  title?: string;
}

function validateMember(input: MemberInput, partial: boolean): ValidMember {
  const fields: Record<string, string> = {};
  const out: ValidMember = {};
  const name = str(input.name, MAX.name);
  if (name) out.name = name;
  else if (!partial || input.name !== undefined) fields.name = "Enter a full name.";
  const email = str(input.email, MAX.email);
  if (email) {
    if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
    else out.email = email.toLowerCase();
  } else if (!partial || input.email !== undefined) fields.email = "Enter an email address.";
  const role = input.firmRole ?? input.role;
  if (role !== undefined || !partial) {
    if (isFirmRole(role)) out.firmRole = role;
    else fields.role = `Choose a role: ${FIRM_ROLES.join(", ")}.`;
  }
  if (input.title !== undefined) out.title = str(input.title, MAX.title);
  if (Object.keys(fields).length) throw new ServiceError(422, Object.values(fields)[0]!, fields, "invalid");
  return out;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export function workspaceView(): WorkspaceView {
  const ws = getWorkspace();
  if (!ws.configured || !ws.owner) return { configured: false, firmName: ws.firmName, owner: null };
  const person = people().get(ws.owner.id);
  const owner: TeamMember = person
    ? toMember(person, ws.owner.id)
    : { id: ws.owner.id, name: ws.owner.name, email: ws.owner.email, firmRole: isFirmRole(ws.owner.role) ? ws.owner.role : null, title: ws.owner.role, active: true, owner: true };
  return { configured: true, firmName: ws.firmName, owner };
}

export interface SetupInput {
  firmName?: unknown;
  name?: unknown;
  email?: unknown;
  role?: unknown;
  title?: unknown;
}

/** First-run setup: creates the owner person and the workspace record. Refuses (409) once configured. */
export function setupWorkspace(input: SetupInput): WorkspaceView {
  if (getWorkspace().configured) throw new ServiceError(409, "This workspace is already set up. The owner can edit the firm profile in Settings.", undefined, "already_configured");
  const firmName = str(input.firmName, MAX.firm);
  let member: ValidMember;
  try {
    member = validateMember(input, false);
  } catch (e) {
    if (e instanceof ServiceError && !firmName) throw new ServiceError(422, "Enter the firm name.", { firmName: "Enter the firm name.", ...e.fields }, "invalid");
    throw e;
  }
  if (!firmName) throw new ServiceError(422, "Enter the firm name.", { firmName: "Enter the firm name." }, "invalid");
  const firmRole = member.firmRole!;
  const now = new Date().toISOString();
  // A person with the same email may already exist (e.g. imported custodians are not team members); reuse a
  // team record with that email instead of creating a duplicate identity.
  const existing = people().all().find((p) => isTeamPerson(p) && p.email?.toLowerCase() === member.email);
  const person: PersonRecord = {
    ...(existing ?? {}),
    id: existing?.id ?? newPersonId(member.name!),
    name: member.name!,
    email: member.email,
    title: titleForRole(firmRole, member.title),
    organization: firmName,
    role: FIRM_ROLE_PERSON[firmRole].role,
    firmRole,
    firmId: existing?.firmId ?? DEFAULT_FIRM_ID,
    matterScope: existing?.matterScope ?? "*",
    platformAdmin: true,
    active: true,
    deactivatedAt: undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  people().put(person);
  saveWorkspace({ firmName, owner: { id: person.id, name: person.name, email: person.email, role: firmRole } });
  audit("create", { kind: "workspace", id: "workspace", label: firmName }, { ownerId: person.id, firmRole }, { id: person.id, name: person.name });
  return workspaceView();
}

/** Owner profile / firm name edit. Only the owner (or a partner/admin) may call this; the route enforces it. */
export function updateWorkspace(input: SetupInput): WorkspaceView {
  const ws = getWorkspace();
  if (!ws.configured || !ws.owner) throw new ServiceError(409, "The workspace is not set up yet.", undefined, "not_configured");
  const fields: Record<string, string> = {};
  let firmName = ws.firmName;
  if (input.firmName !== undefined) {
    const f = str(input.firmName, MAX.firm);
    if (!f) fields.firmName = "Enter the firm name.";
    else firmName = f;
  }
  let member: ValidMember = {};
  try {
    member = validateMember(input, true);
  } catch (e) {
    if (e instanceof ServiceError) Object.assign(fields, e.fields);
    else throw e;
  }
  if (Object.keys(fields).length) throw new ServiceError(422, Object.values(fields)[0]!, fields, "invalid");
  if (member.email && emailTaken(member.email, ws.owner.id)) throw new ServiceError(409, "Another team member already uses that email.", { email: "Another team member already uses that email." }, "duplicate_email");
  const cur = people().get(ws.owner.id);
  const firmRole = member.firmRole ?? (cur ? firmRoleOf(cur) : null) ?? (isFirmRole(ws.owner.role) ? ws.owner.role : "Partner");
  const now = new Date().toISOString();
  const person: PersonRecord = {
    ...(cur ?? { id: ws.owner.id, name: ws.owner.name, role: FIRM_ROLE_PERSON[firmRole].role, createdAt: now }),
    name: member.name ?? cur?.name ?? ws.owner.name,
    email: member.email ?? cur?.email ?? ws.owner.email,
    title: titleForRole(firmRole, member.title ?? (member.firmRole ? undefined : cur?.title)),
    organization: firmName,
    role: FIRM_ROLE_PERSON[firmRole].role,
    firmRole,
    active: true,
    updatedAt: now,
  };
  people().put(person);
  saveWorkspace({ firmName, owner: { id: person.id, name: person.name, email: person.email, role: firmRole } });
  audit("settings.change", { kind: "workspace", id: "workspace", label: firmName }, { changed: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined) });
  return workspaceView();
}

/** True when the principal may manage the workspace profile and the team: the owner, a partner or an admin. */
export function principalFirmId(principal: Principal | null): string | null {
  if (!principal) return null;
  const p = people().get(principal.id);
  return p?.firmId ?? DEFAULT_FIRM_ID;
}

export function isPlatformAdmin(principal: Principal | null): boolean {
  if (!principal) return false;
  const ws = getWorkspace();
  if (ws.owner?.id === principal.id) return true;
  const p = people().get(principal.id);
  return p?.platformAdmin === true && principal.roles.includes("admin");
}

export function canManageWorkspace(principal: Principal | null): boolean {
  if (!principal) return false;
  if (isPlatformAdmin(principal)) return true;
  return principal.roles.some((r) => r === "partner" || r === "admin" || r === "service");
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export function listTeam(opts: { includeInactive?: boolean; q?: string; firmId?: string } = {}): TeamMember[] {
  const ownerId = getWorkspace().owner?.id;
  const q = opts.q?.trim().toLowerCase();
  return people()
    .all()
    .filter((p) => isTeamPerson(p) && (!opts.firmId || (p.firmId ?? DEFAULT_FIRM_ID) === opts.firmId) && (opts.includeInactive || isActive(p)))
    .filter((p) => !q || `${p.name} ${p.email ?? ""} ${p.title ?? ""}`.toLowerCase().includes(q))
    .map((p) => toMember(p, ownerId))
    .sort((a, b) => Number(b.owner) - Number(a.owner) || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

export function getMember(id: string): TeamMember | null {
  const p = people().get(id);
  return p && isTeamPerson(p) ? toMember(p) : null;
}

export interface MemberProvisioning {
  firmId?: string;
  firmName?: string;
  matterScope?: "*" | string[];
  platformAdmin?: boolean;
}

export function createMember(input: MemberInput, provisioning: MemberProvisioning = {}): TeamMember {
  const m = validateMember(input, false);
  if (emailTaken(m.email!)) throw new ServiceError(409, "A team member with that email already exists.", { email: "A team member with that email already exists." }, "duplicate_email");
  const now = new Date().toISOString();
  const person: PersonRecord = {
    id: newPersonId(m.name!),
    name: m.name!,
    email: m.email,
    title: titleForRole(m.firmRole!, m.title),
    organization: provisioning.firmName ?? getWorkspace().firmName,
    role: FIRM_ROLE_PERSON[m.firmRole!].role,
    firmRole: m.firmRole,
    firmId: provisioning.firmId ?? DEFAULT_FIRM_ID,
    matterScope: provisioning.matterScope,
    platformAdmin: provisioning.platformAdmin === true,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  people().put(person);
  audit("create", { kind: "person", id: person.id, label: person.name }, { firmRole: m.firmRole });
  return toMember(person);
}

export function updateMember(id: string, input: MemberInput & { active?: unknown }): TeamMember {
  const cur = people().get(id);
  if (!cur || !isTeamPerson(cur)) throw new ServiceError(404, "Team member not found", undefined, "not_found");
  const ownerId = getWorkspace().owner?.id;
  const m = validateMember(input, true);
  if (m.email && emailTaken(m.email, id)) throw new ServiceError(409, "A team member with that email already exists.", { email: "A team member with that email already exists." }, "duplicate_email");
  let active = isActive(cur);
  if (input.active !== undefined) {
    if (typeof input.active !== "boolean") throw new ServiceError(422, "active must be true or false", { active: "active must be true or false" }, "invalid");
    if (!input.active && id === ownerId) throw new ServiceError(409, "The workspace owner cannot be deactivated.", undefined, "owner");
    active = input.active;
  }
  const firmRole = m.firmRole ?? firmRoleOf(cur) ?? "Associate";
  const titleChanged = m.title !== undefined || m.firmRole !== undefined;
  const now = new Date().toISOString();
  const next: PersonRecord = {
    ...cur,
    name: m.name ?? cur.name,
    email: m.email ?? cur.email,
    title: titleChanged ? titleForRole(firmRole, m.title ?? (m.firmRole ? undefined : cur.title)) : cur.title,
    role: FIRM_ROLE_PERSON[firmRole].role,
    firmRole,
    active,
    deactivatedAt: active ? undefined : cur.deactivatedAt ?? now,
    updatedAt: now,
  };
  people().put(next);
  if (id === ownerId) saveWorkspace({ firmName: getWorkspace().firmName, owner: { id, name: next.name, email: next.email, role: firmRole } });
  audit("update", { kind: "person", id, label: next.name }, { fields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined) });
  return toMember(next, ownerId);
}

/** Deactivate (never delete): references from matters, coding and the audit trail stay resolvable. */
export function deactivateMember(id: string): TeamMember {
  return updateMember(id, { active: false });
}

/** Ids of active team members, for validating matter teams. */
export function activeTeamIds(): Set<string> {
  return new Set(people().all().filter((p) => isTeamPerson(p) && isActive(p)).map((p) => p.id));
}
