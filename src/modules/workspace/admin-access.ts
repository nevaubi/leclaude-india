import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { appDisplayName } from "@/lib/brand";
import { db } from "@/lib/db";
import { activeMemberByEmail, setPassword } from "@/lib/auth/accounts";
import type { Principal } from "@/lib/auth/types";
import { audit } from "@/lib/integrity/audit";
import { getWorkspace } from "@/lib/workspace";
import { EMAIL_RE, FIRM_ROLES, isFirmRole, type FirmRole } from "./roles";
import { ServiceError } from "./errors";
import { createMember, DEFAULT_FIRM_ID, isPlatformAdmin, listTeam, type PersonRecord } from "./service";
import { issueMemberSession, type IssuedSession } from "./signin";

export const FIRMS_COLLECTION = "auth_firms";
export const INVITATIONS_COLLECTION = "auth_invitations";

export type FirmMatterScope = "*" | string[];
export type InvitationStatus = "pending" | "accepted" | "revoked";

export interface FirmRecord {
  id: string;
  name: string;
  description?: string;
  jurisdiction?: string;
  matterIds: FirmMatterScope;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface InvitationRecord {
  id: string;
  tokenHash: string;
  email: string;
  firmId: string;
  firmRole: FirmRole;
  title?: string;
  status: InvitationStatus;
  expiresAt: string;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
  lastSentAt?: string;
  emailDelivery?: "sent" | "not_configured" | "failed";
  emailMessageId?: string;
  acceptedAt?: string;
  acceptedByPersonId?: string;
  revokedAt?: string;
}

export interface FirmView extends FirmRecord {
  userCount: number;
}

export interface InvitationView {
  id: string;
  email: string;
  firmId: string;
  firmName: string;
  firmRole: FirmRole;
  title?: string;
  status: InvitationStatus | "expired";
  expiresAt: string;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
  lastSentAt?: string;
  emailDelivery?: InvitationRecord["emailDelivery"];
  acceptedAt?: string;
  acceptedByPersonId?: string;
}

const MAX = { firm: 160, description: 500, jurisdiction: 120, email: 200, title: 80, name: 80 } as const;

function firms() {
  return db().collection<FirmRecord>(FIRMS_COLLECTION);
}

function invites() {
  return db().collection<InvitationRecord>(INVITATIONS_COLLECTION);
}

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : undefined;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function assertAdmin(actor: Principal | null): asserts actor is Principal {
  if (!actor || !isPlatformAdmin(actor)) throw new ServiceError(403, "Only the platform administrator can manage firms and invitations.", undefined, "forbidden");
}

function validateMatterScope(value: unknown): FirmMatterScope {
  if (value === "*") return "*";
  if (!Array.isArray(value)) throw new ServiceError(422, "Choose all matters or specific matters.", { matterIds: "Choose a matter scope." }, "invalid");
  const ids = Array.from(new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0)));
  const known = new Set(db().matters.all().map((m) => m.id));
  const bad = ids.find((id) => !known.has(id));
  if (bad) throw new ServiceError(422, "One or more selected matters do not exist.", { matterIds: "Refresh and choose valid matters." }, "invalid");
  return ids;
}

function defaultFirm(): FirmRecord {
  const workspace = getWorkspace();
  const now = new Date().toISOString();
  const current = firms().get(DEFAULT_FIRM_ID);
  const next: FirmRecord = current
    ? { ...current, name: workspace.firmName || current.name }
    : {
        id: DEFAULT_FIRM_ID,
        name: workspace.firmName || "Default firm",
        matterIds: "*",
        active: true,
        createdAt: now,
        updatedAt: now,
        createdBy: workspace.owner?.id ?? "bootstrap",
      };
  if (!current) firms().put(next);
  return next;
}

function firmOrThrow(id: string): FirmRecord {
  defaultFirm();
  const firm = firms().get(id);
  if (!firm || !firm.active) throw new ServiceError(404, "Firm not found.", undefined, "not_found");
  return firm;
}

function firmStatus(invite: InvitationRecord): InvitationView["status"] {
  return invite.status === "pending" && invite.expiresAt <= new Date().toISOString() ? "expired" : invite.status;
}

function toInviteView(invite: InvitationRecord): InvitationView {
  const firm = firms().get(invite.firmId);
  return {
    id: invite.id,
    email: invite.email,
    firmId: invite.firmId,
    firmName: firm?.name ?? "Unknown firm",
    firmRole: invite.firmRole,
    title: invite.title,
    status: firmStatus(invite),
    expiresAt: invite.expiresAt,
    invitedBy: invite.invitedBy,
    createdAt: invite.createdAt,
    updatedAt: invite.updatedAt,
    lastSentAt: invite.lastSentAt,
    emailDelivery: invite.emailDelivery,
    acceptedAt: invite.acceptedAt,
    acceptedByPersonId: invite.acceptedByPersonId,
  };
}

function ttlMs(): number {
  const hours = Number(process.env.AUTH_INVITE_TTL_HOURS ?? 168);
  const safe = Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24 * 30) : 168;
  return safe * 60 * 60 * 1000;
}

function buildInviteUrl(token: string, origin: string): string {
  const base = process.env.AUTH_APP_URL?.trim() || origin;
  return new URL(`/invite/${encodeURIComponent(token)}`, base).toString();
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function sendInviteEmail(invite: InvitationRecord, firm: FirmRecord, url: string): Promise<{ sent: boolean; id?: string; error?: string }> {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.AUTH_EMAIL_FROM?.trim();
  if (!key || !from) return { sent: false, error: "Email delivery is not configured." };
  const app = appDisplayName();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": `account-invite-${invite.id}-${invite.tokenHash.slice(0, 12)}`,
    },
    body: JSON.stringify({
      from,
      to: [invite.email],
      subject: `You're invited to ${app} — ${firm.name}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px"><h2 style="margin:0 0 16px">Join ${escapeHtml(firm.name)} on ${escapeHtml(app)}</h2><p style="color:#4b5563;line-height:1.6">An administrator created an account invitation for <strong>${escapeHtml(invite.email)}</strong> with the role <strong>${escapeHtml(invite.firmRole)}</strong>.</p><p style="margin:28px 0"><a href="${escapeHtml(url)}" style="background:#0f172a;color:white;text-decoration:none;padding:11px 18px;border-radius:6px;display:inline-block">Create your account</a></p><p style="color:#6b7280;font-size:13px">You will choose your first name, last name and password. This link expires ${escapeHtml(new Date(invite.expiresAt).toLocaleString("en-US", { timeZone: "UTC" }))} UTC and can only be used once.</p></div>`,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string; error?: { message?: string } };
  if (!response.ok) return { sent: false, error: body.error?.message ?? body.message ?? `Email provider returned ${response.status}` };
  return { sent: true, id: body.id };
}

function newFirmId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "firm";
  return `firm_${slug}_${nanoid(6).toLowerCase()}`;
}

export function adminAccessView(actor: Principal | null) {
  assertAdmin(actor);
  defaultFirm();
  const allUsers = listTeam({ includeInactive: true });
  const firmViews: FirmView[] = firms().all().filter((f) => f.active).map((f) => ({
    ...f,
    userCount: allUsers.filter((u) => (u.firmId ?? DEFAULT_FIRM_ID) === f.id).length,
  })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    firms: firmViews,
    invitations: invites().all().map(toInviteView).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    users: allUsers,
    matters: db().matters.all().map((m) => ({ id: m.id, name: m.name, shortName: m.shortName, status: m.status })),
  };
}

export function createFirm(actor: Principal | null, input: Record<string, unknown>): FirmRecord {
  assertAdmin(actor);
  const name = clean(input.name, MAX.firm);
  if (!name) throw new ServiceError(422, "Enter a firm name.", { name: "Enter a firm name." }, "invalid");
  const now = new Date().toISOString();
  const record: FirmRecord = {
    id: newFirmId(name),
    name,
    description: clean(input.description, MAX.description),
    jurisdiction: clean(input.jurisdiction, MAX.jurisdiction),
    matterIds: validateMatterScope(input.matterIds ?? []),
    active: true,
    createdAt: now,
    updatedAt: now,
    createdBy: actor.id,
  };
  firms().put(record);
  audit("create", { kind: "firm", id: record.id, label: record.name }, { matterIds: record.matterIds }, { id: actor.id, name: actor.name });
  return record;
}

export function updateFirm(actor: Principal | null, input: Record<string, unknown>): FirmRecord {
  assertAdmin(actor);
  const id = clean(input.id, 120);
  if (!id) throw new ServiceError(422, "Firm id is required.", { id: "Firm id is required." }, "invalid");
  const current = firmOrThrow(id);
  const name = input.name === undefined ? current.name : clean(input.name, MAX.firm);
  if (!name) throw new ServiceError(422, "Enter a firm name.", { name: "Enter a firm name." }, "invalid");
  const scope = input.matterIds === undefined ? current.matterIds : validateMatterScope(input.matterIds);
  const next: FirmRecord = {
    ...current,
    name,
    description: input.description === undefined ? current.description : clean(input.description, MAX.description),
    jurisdiction: input.jurisdiction === undefined ? current.jurisdiction : clean(input.jurisdiction, MAX.jurisdiction),
    matterIds: scope,
    updatedAt: new Date().toISOString(),
  };
  firms().put(next);
  const people = db().collection<PersonRecord>("people");
  for (const p of people.all().filter((p) => p.firmId === id)) people.put({ ...p, organization: name, matterScope: scope, updatedAt: next.updatedAt });
  audit("update", { kind: "firm", id, label: name }, { matterIds: scope }, { id: actor.id, name: actor.name });
  return next;
}

function validateInviteInput(input: Record<string, unknown>): { email: string; firm: FirmRecord; firmRole: FirmRole; title?: string } {
  const email = clean(input.email, MAX.email)?.toLowerCase();
  if (!email || !EMAIL_RE.test(email)) throw new ServiceError(422, "Enter a valid email address.", { email: "Enter a valid email address." }, "invalid");
  if (activeMemberByEmail(email)) throw new ServiceError(409, "An active account already uses that email.", { email: "That email already has an account." }, "duplicate_email");
  const existingPerson = db().collection<PersonRecord>("people").all().find((p) => p.email?.toLowerCase() === email);
  if (existingPerson) throw new ServiceError(409, "A deactivated account already uses that email. Reactivate it instead.", { email: "A deactivated account already exists." }, "duplicate_email");
  const existingInvite = invites().all().find((i) => i.email === email && firmStatus(i) === "pending");
  if (existingInvite) throw new ServiceError(409, "A pending invitation already exists for that email.", { email: "Resend or revoke the existing invitation." }, "duplicate_invite");
  const firmId = clean(input.firmId, 120);
  if (!firmId) throw new ServiceError(422, "Choose a firm.", { firmId: "Choose a firm." }, "invalid");
  const firm = firmOrThrow(firmId);
  if (!isFirmRole(input.firmRole)) throw new ServiceError(422, `Choose a role: ${FIRM_ROLES.join(", ")}.`, { firmRole: "Choose a role." }, "invalid");
  return { email, firm, firmRole: input.firmRole, title: clean(input.title, MAX.title) };
}

async function createOrRotateInvite(actor: Principal, base: Omit<InvitationRecord, "tokenHash" | "expiresAt" | "updatedAt" | "lastSentAt" | "emailDelivery" | "emailMessageId">, origin: string) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const record: InvitationRecord = {
    ...base,
    tokenHash: tokenHash(token),
    expiresAt: new Date(now.getTime() + ttlMs()).toISOString(),
    updatedAt: now.toISOString(),
    lastSentAt: now.toISOString(),
  };
  const firm = firmOrThrow(record.firmId);
  const url = buildInviteUrl(token, origin);
  const delivery = await sendInviteEmail(record, firm, url);
  record.emailDelivery = delivery.sent ? "sent" : delivery.error === "Email delivery is not configured." ? "not_configured" : "failed";
  record.emailMessageId = delivery.id;
  invites().put(record);
  audit("create", { kind: "invitation", id: record.id, label: record.email }, { firmId: record.firmId, role: record.firmRole, emailDelivery: record.emailDelivery }, { id: actor.id, name: actor.name });
  return { invitation: toInviteView(record), inviteUrl: url, emailSent: delivery.sent, emailError: delivery.error };
}

export async function createInvitation(actor: Principal | null, input: Record<string, unknown>, origin: string) {
  assertAdmin(actor);
  const v = validateInviteInput(input);
  const now = new Date().toISOString();
  return createOrRotateInvite(actor, {
    id: `inv_${nanoid(14)}`,
    email: v.email,
    firmId: v.firm.id,
    firmRole: v.firmRole,
    title: v.title,
    status: "pending",
    invitedBy: actor.id,
    createdAt: now,
  }, origin);
}

export async function resendInvitation(actor: Principal | null, id: string, origin: string) {
  assertAdmin(actor);
  const current = invites().get(id);
  if (!current) throw new ServiceError(404, "Invitation not found.", undefined, "not_found");
  if (current.status !== "pending") throw new ServiceError(409, "Only pending invitations can be resent.", undefined, "not_pending");
  return createOrRotateInvite(actor, {
    id: current.id,
    email: current.email,
    firmId: current.firmId,
    firmRole: current.firmRole,
    title: current.title,
    status: "pending",
    invitedBy: actor.id,
    createdAt: current.createdAt,
    acceptedAt: current.acceptedAt,
    acceptedByPersonId: current.acceptedByPersonId,
    revokedAt: undefined,
  }, origin);
}

export function revokeInvitation(actor: Principal | null, id: string): InvitationView {
  assertAdmin(actor);
  const current = invites().get(id);
  if (!current) throw new ServiceError(404, "Invitation not found.", undefined, "not_found");
  if (current.status !== "pending") throw new ServiceError(409, "Only pending invitations can be revoked.", undefined, "not_pending");
  const now = new Date().toISOString();
  const next: InvitationRecord = { ...current, status: "revoked", revokedAt: now, updatedAt: now };
  invites().put(next);
  audit("update", { kind: "invitation", id, label: current.email }, { status: "revoked" }, { id: actor.id, name: actor.name });
  return toInviteView(next);
}

export function publicInvitation(token: string): { email: string; firmName: string; firmRole: FirmRole; title?: string; expiresAt: string } {
  if (!token || token.length > 200) throw new ServiceError(404, "This invitation is invalid or has expired.", undefined, "invalid_invite");
  defaultFirm();
  const record = invites().findOne((i) => i.tokenHash === tokenHash(token));
  if (!record || firmStatus(record) !== "pending") throw new ServiceError(404, "This invitation is invalid or has expired.", undefined, "invalid_invite");
  const firm = firmOrThrow(record.firmId);
  return { email: record.email, firmName: firm.name, firmRole: record.firmRole, title: record.title, expiresAt: record.expiresAt };
}

export async function acceptInvitation(token: string, input: Record<string, unknown>): Promise<{ session: IssuedSession; firmName: string }> {
  const view = publicInvitation(token);
  const record = invites().findOne((i) => i.tokenHash === tokenHash(token))!;
  const firstName = clean(input.firstName, MAX.name);
  const lastName = clean(input.lastName, MAX.name);
  if (!firstName) throw new ServiceError(422, "Enter your first name.", { firstName: "Enter your first name." }, "invalid");
  if (!lastName) throw new ServiceError(422, "Enter your last name.", { lastName: "Enter your last name." }, "invalid");
  const firm = firmOrThrow(record.firmId);
  const member = createMember({
    name: `${firstName} ${lastName}`,
    email: record.email,
    role: record.firmRole,
    title: record.title,
  }, {
    firmId: firm.id,
    firmName: firm.name,
    matterScope: firm.matterIds,
  });
  try {
    await setPassword(member.id, input.password as string, "invite");
  } catch (e) {
    // Keep account creation atomic from the user's perspective if password validation/hashing fails.
    db().people.delete(member.id);
    throw e;
  }
  const now = new Date().toISOString();
  invites().put({ ...record, status: "accepted", acceptedAt: now, acceptedByPersonId: member.id, updatedAt: now });
  audit("update", { kind: "invitation", id: record.id, label: record.email }, { status: "accepted", personId: member.id, firmId: firm.id }, { id: member.id, name: member.name });
  return { session: issueMemberSession(member.id), firmName: view.firmName };
}
